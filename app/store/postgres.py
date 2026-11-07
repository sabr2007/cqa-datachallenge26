"""Хранилище на Postgres (psycopg 3) — для облака: Vercel Functions + Neon.

Семантика та же, что у SqliteStore (её проверяют контрактные тесты tests/store):
- версии чек-листа неизменяемы (триггер); номер «последний + 1» выдаётся под
  транзакционной advisory-блокировкой чек-листа — параллельные экземпляры функции
  не получат один номер;
- изменения оценки — с проверкой ревизии (оптимистичная блокировка), апелляция и
  оценка меняются в одной транзакции;
- документы хранятся целиком (тип json: текст как есть), сортировка текста — побайтовая
  (COLLATE "C"), NULL в сортировке — как в SQLite.

Serverless: маленький пул psycopg_pool без постоянных соединений (min_size=0), каждое
соединение проверяется при выдаче, подготовленные выражения выключены — так работает
пулер Neon (PgBouncer в режиме транзакций, адрес DATABASE_URL). Схема мигрирует лениво,
при первом обращении: недоступная при старте база не роняет приложение, а даёт 503.
Таблицы адресуются с именем схемы (CQA_DB_SCHEMA, по умолчанию public), поэтому тесты
работают в отдельной схеме и не зависят от search_path.
"""

import json
import logging
import re
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import Any, LiteralString

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.config import DEFAULT_DB_SCHEMA, valid_db_schema
from app.store.base import (
    AppealNotOpenError,
    AppealStatus,
    ChecklistSource,
    ChecklistVersion,
    DuplicateAppealError,
    Purpose,
    RevisionConflictError,
    StorageError,
    StoredEvaluation,
    guarded,
    utc_now,
)
from app.store.postgres_schema import (
    CREATE_MIGRATIONS_TABLE,
    MIGRATIONS,
    MIGRATIONS_TABLE,
    OBJECTS,
    REJECT_CHANGE_FUNCTION,
    SCHEMA_VERSION,
)

logger = logging.getLogger("cqa.store")

POOL_MAX_SIZE = 5  # на один экземпляр функции; пулер Neon держит тысячи клиентов
POOL_TIMEOUT_SEC = 10.0  # ожидание соединения — меньше таймаутов чтения во фронтенде (20 с)
CONNECT_TIMEOUT_SEC = 10  # с запасом на пробуждение остановленной базы Neon
POOL_MAX_IDLE_SEC = 60.0
POOL_MAX_LIFETIME_SEC = 600.0

_URL_CREDENTIALS_RE = re.compile(r"(?i)\b(postgres(?:ql)?://[^:/?#@\s]*:)[^@\s]*@")
_PASSWORD_PARAM_RE = re.compile(r"(?i)\b(password\s*=\s*)('[^']*'|\S+)")

Row = dict[str, Any]
Connection = psycopg.Connection[Row]


def scrub_credentials(text: str) -> str:
    """Убирает пароль из адресов postgresql://… и параметров password=… в тексте ошибки."""
    return _PASSWORD_PARAM_RE.sub(r"\1***", _URL_CREDENTIALS_RE.sub(r"\1***@", text))


def _describe(exc: Exception) -> str:
    return scrub_credentials(f"{type(exc).__name__}: {exc}")


def _guarded[**P, R](action: str) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Ошибки psycopg (в том числе «нет соединения» от пула) → StorageError (503)."""
    return guarded(action, (psycopg.Error,), _describe)


class PostgresStore:
    def __init__(
        self,
        url: str,
        *,
        schema: str = DEFAULT_DB_SCHEMA,
        clock: Callable[[], str] = utc_now,
        max_size: int = POOL_MAX_SIZE,
        timeout_sec: float = POOL_TIMEOUT_SEC,
        connect_timeout_sec: int = CONNECT_TIMEOUT_SEC,
    ) -> None:
        try:
            conninfo_to_dict(url)
        except psycopg.Error:
            # Сообщение libpq может содержать саму строку подключения с паролем.
            raise ValueError("Некорректная строка подключения к Postgres") from None
        self._schema = valid_db_schema(schema)
        self._clock = clock
        self._names: dict[str, sql.Composable] = {
            **{name: sql.Identifier(self._schema, name) for name in OBJECTS},
            "migrations": sql.Identifier(self._schema, MIGRATIONS_TABLE),
            "reject_change": sql.Identifier(self._schema, REJECT_CHANGE_FUNCTION),
        }
        self._ready = False
        self._ready_lock = threading.Lock()
        self._pool: ConnectionPool[Connection] = ConnectionPool(
            url,
            min_size=0,
            max_size=max_size,
            kwargs={
                "autocommit": True,
                "prepare_threshold": None,  # пулер в режиме транзакций
                "row_factory": dict_row,
                "connect_timeout": connect_timeout_sec,
                "application_name": "cqa",
            },
            check=ConnectionPool.check_connection,
            timeout=timeout_sec,
            max_idle=POOL_MAX_IDLE_SEC,
            max_lifetime=POOL_MAX_LIFETIME_SEC,
            num_workers=1,
            name="cqa-store",
            open=True,
        )

    @property
    def schema(self) -> str:
        return self._schema

    def close(self) -> None:
        self._pool.close()

    def table(self, name: str) -> sql.Composable:
        """Имя таблицы со схемой — для служебных скриптов (перенос данных)."""
        return self._names[name]

    def ensure_schema(self) -> None:
        """Применяет недостающие миграции (идемпотентно, один раз на процесс).

        Схема уже актуальна — один запрос; иначе миграции под транзакционной
        блокировкой, чтобы параллельно стартующие экземпляры не применили их дважды.
        """
        if self._ready:
            return
        with self._ready_lock:
            if self._ready:
                return
            with self._pool.connection() as conn:
                if self._applied_version(conn) != SCHEMA_VERSION:
                    self._migrate(conn)
            self._ready = True

    @contextmanager
    def connection(self) -> Iterator[Connection]:
        """Соединение из пула (autocommit) после миграции схемы."""
        self.ensure_schema()
        with self._pool.connection() as conn:
            yield conn

    def compose(self, template: LiteralString, **parts: sql.Composable) -> sql.Composed:
        """Команда с подставленными именами таблиц схемы ({evaluations} и т. п.)."""
        return sql.SQL(template).format(**self._names, **parts)

    # --- служебное ---

    def _fetch(self, template: LiteralString, params: Sequence[Any] = ()) -> list[Row]:
        with self.connection() as conn:
            return conn.execute(self.compose(template), params).fetchall()

    def _applied_version(self, conn: Connection) -> int | None:
        """Номер схемы в базе; None — схемы или таблицы миграций ещё нет."""
        try:
            row = conn.execute(
                self.compose("SELECT MAX(version) AS version FROM {migrations}")
            ).fetchone()
        except (psycopg.errors.UndefinedTable, psycopg.errors.InvalidSchemaName):
            return None
        return None if row is None or row["version"] is None else int(row["version"])

    def _migrate(self, conn: Connection) -> None:
        with conn.transaction():
            _advisory_lock(conn, f"cqa:{self._schema}:migrate")
            exists = conn.execute(
                "SELECT 1 FROM pg_namespace WHERE nspname = %s", (self._schema,)
            ).fetchone()
            if exists is None:
                conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self._schema)))
            conn.execute(self.compose(CREATE_MIGRATIONS_TABLE))
            applied = self._applied_version(conn) or 0
            if applied > SCHEMA_VERSION:
                raise StorageError(
                    detail=f"схема {self._schema} создана более новой версией приложения "
                    f"(схема {applied}, код знает {SCHEMA_VERSION})"
                )
            for number in range(applied + 1, SCHEMA_VERSION + 1):
                # Команды миграции без параметров — одним запросом (меньше обменов с базой).
                script = sql.SQL(";\n").join(
                    self.compose(statement) for statement in MIGRATIONS[number - 1]
                )
                conn.execute(script)
                conn.execute(
                    self.compose("INSERT INTO {migrations} (version) VALUES (%s)"), (number,)
                )
                logger.info("Postgres, схема %s: применена миграция %d", self._schema, number)

    def _where(
        self, conditions: Sequence[tuple[LiteralString, object]]
    ) -> tuple[sql.Composable, list[object]]:
        """WHERE из условий, значение которых задано (None — фильтра нет)."""
        active = [(clause, value) for clause, value in conditions if value is not None]
        if not active:
            return sql.SQL(""), []
        clauses = sql.SQL(" AND ").join(self.compose(clause) for clause, _ in active)
        return sql.SQL(" WHERE ") + clauses, [value for _, value in active]

    # --- версии чек-листов ---

    @_guarded("чтение версий чек-листов")
    def list_checklist_versions(self) -> list[ChecklistVersion]:
        rows = self._fetch(
            "SELECT checklist_id, version, title, doc, note, sandbox, source, created_at"
            ' FROM {checklist_versions} ORDER BY checklist_id COLLATE "C", version'
        )
        return [_checklist_version(row) for row in rows]

    @_guarded("чтение версии чек-листа")
    def get_checklist_version(
        self, checklist_id: str, version: int | None = None
    ) -> ChecklistVersion | None:
        if version is None:
            rows = self._fetch(
                "SELECT checklist_id, version, title, doc, note, sandbox, source, created_at"
                " FROM {checklist_versions} WHERE checklist_id = %s AND NOT sandbox"
                " ORDER BY version DESC LIMIT 1",
                (checklist_id,),
            )
        else:
            rows = self._fetch(
                "SELECT checklist_id, version, title, doc, note, sandbox, source, created_at"
                " FROM {checklist_versions} WHERE checklist_id = %s AND version = %s",
                (checklist_id, version),
            )
        return _checklist_version(rows[0]) if rows else None

    @_guarded("сохранение версии чек-листа")
    def add_checklist_version(
        self, checklist_id: str, doc: dict[str, Any], *, note: str | None, sandbox: bool
    ) -> ChecklistVersion:
        with self.connection() as conn, conn.transaction():
            self._lock_checklist(conn, checklist_id)
            return self._insert_version(
                conn, checklist_id, doc, note=note, sandbox=sandbox, source="api", source_hash=None
            )

    @_guarded("синхронизация чек-листа из файла")
    def sync_checklist_file(
        self, checklist_id: str, doc: dict[str, Any], *, note: str, source_hash: str
    ) -> ChecklistVersion | None:
        with self.connection() as conn, conn.transaction():
            self._lock_checklist(conn, checklist_id)
            latest = conn.execute(
                self.compose(
                    "SELECT source, source_hash FROM {checklist_versions}"
                    " WHERE checklist_id = %s AND NOT sandbox ORDER BY version DESC LIMIT 1"
                ),
                (checklist_id,),
            ).fetchone()
            if latest is not None and (
                latest["source"] != "file" or latest["source_hash"] == source_hash
            ):
                return None
            return self._insert_version(
                conn,
                checklist_id,
                doc,
                note=note,
                sandbox=False,
                source="file",
                source_hash=source_hash,
            )

    def _lock_checklist(self, conn: Connection, checklist_id: str) -> None:
        """Номер версии выдаётся по одному: до конца транзакции чек-лист занят."""
        _advisory_lock(conn, f"cqa:{self._schema}:checklist:{checklist_id}")

    def _insert_version(
        self,
        conn: Connection,
        checklist_id: str,
        doc: dict[str, Any],
        *,
        note: str | None,
        sandbox: bool,
        source: ChecklistSource,
        source_hash: str | None,
    ) -> ChecklistVersion:
        last = conn.execute(
            self.compose(
                "SELECT COALESCE(MAX(version), 0) AS last FROM {checklist_versions}"
                " WHERE checklist_id = %s"
            ),
            (checklist_id,),
        ).fetchone()
        number = int(last["last"] if last else 0) + 1
        body = {key: value for key, value in doc.items() if key not in ("id", "version")}
        stored = {"id": checklist_id, "version": number, **body}
        title = without_nul(str(doc.get("title") or checklist_id))
        stored_note = without_nul(note)
        created_at = self._clock()
        conn.execute(
            self.compose(
                "INSERT INTO {checklist_versions}"
                " (checklist_id, version, title, doc, note, sandbox, source, source_hash,"
                " created_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
            ),
            (
                checklist_id,
                number,
                title,
                to_json(stored),
                stored_note,
                sandbox,
                source,
                source_hash,
                created_at,
            ),
        )
        return ChecklistVersion(
            checklist_id=checklist_id,
            version=number,
            title=title,
            doc=stored,
            note=stored_note,
            sandbox=sandbox,
            source=source,
            created_at=created_at,
        )

    # --- оценки ---

    @_guarded("сохранение оценки")
    def add_evaluation(
        self,
        evaluation: dict[str, Any],
        *,
        transcript: Sequence[dict[str, Any]],
        language: str | None,
        channel: str | None,
    ) -> StoredEvaluation:
        stored_language, stored_channel = without_nul(language), without_nul(channel)
        with self.connection() as conn:
            conn.execute(
                self.compose(
                    "INSERT INTO {evaluations} (id, group_id, conversation_id, checklist_id,"
                    " checklist_version, purpose, status, language, channel, created_at,"
                    " revision, doc, transcript)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 1, %s, %s)"
                ),
                (
                    evaluation["id"],
                    evaluation["group_id"],
                    evaluation["conversation_id"],
                    evaluation["checklist_id"],
                    evaluation["checklist_version"],
                    evaluation["purpose"],
                    evaluation["status"],
                    stored_language,
                    stored_channel,
                    evaluation["created_at"],
                    to_json(evaluation),
                    to_json(list(transcript)),
                ),
            )
        return StoredEvaluation(
            doc=evaluation,
            revision=1,
            language=stored_language,
            channel=stored_channel,
            transcript=tuple(transcript),
        )

    @_guarded("чтение оценки")
    def get_evaluation(self, evaluation_id: str) -> StoredEvaluation | None:
        rows = self._fetch(
            "SELECT doc, revision, language, channel, transcript FROM {evaluations} WHERE id = %s",
            (evaluation_id,),
        )
        if not rows:
            return None
        row = rows[0]
        return StoredEvaluation(
            doc=row["doc"],
            revision=row["revision"],
            language=row["language"],
            channel=row["channel"],
            transcript=tuple(row["transcript"] or ()),
        )

    @_guarded("чтение истории оценок")
    def list_evaluations(
        self,
        *,
        group_id: str | None = None,
        conversation_id: str | None = None,
        purpose: Purpose | None = None,
        limit: int = 100,
    ) -> list[StoredEvaluation]:
        where, params = self._where(
            [
                ("group_id = %s", group_id),
                ("conversation_id = %s", conversation_id),
                ("purpose = %s", purpose),
            ]
        )
        with self.connection() as conn:
            rows = conn.execute(
                self.compose(
                    "SELECT doc, revision, language, channel FROM {evaluations}{where}"
                    " ORDER BY seq DESC LIMIT %s",
                    where=where,
                ),
                [*params, limit],
            ).fetchall()
        return [_stored_evaluation(row) for row in rows]

    @_guarded("чтение последних оценок")
    def latest_evaluations(
        self,
        *,
        group_id: str | None = None,
        purpose: Purpose | None = "regular",
        checklist_id: str | None = None,
        checklist_version: int | None = None,
    ) -> list[StoredEvaluation]:
        where, params = self._where(
            [
                ("status = %s", "done"),
                ("group_id = %s", group_id),
                ("purpose = %s", purpose),
                ("checklist_id = %s", checklist_id),
                ("checklist_version = %s", checklist_version),
            ]
        )
        with self.connection() as conn:
            rows = conn.execute(
                self.compose(
                    "SELECT doc, revision, language, channel FROM ("
                    " SELECT doc, revision, language, channel, group_id, conversation_id,"
                    " ROW_NUMBER() OVER (PARTITION BY group_id, conversation_id ORDER BY seq DESC)"
                    " AS position FROM {evaluations}{where}"
                    ") AS ranked WHERE position = 1"
                    ' ORDER BY group_id COLLATE "C", conversation_id COLLATE "C"',
                    where=where,
                ),
                params,
            ).fetchall()
        return [_stored_evaluation(row) for row in rows]

    # --- апелляции ---

    @_guarded("сохранение апелляции")
    def add_appeal(
        self, appeal: dict[str, Any], evaluation: dict[str, Any], *, expected_revision: int
    ) -> None:
        with self.connection() as conn, conn.transaction():
            exists = conn.execute(
                self.compose(
                    "SELECT 1 FROM {appeals} WHERE evaluation_id = %s AND criterion_id = %s"
                ),
                (appeal["evaluation_id"], appeal["criterion_id"]),
            ).fetchone()
            if exists:
                raise DuplicateAppealError(appeal["criterion_id"])
            self._update_evaluation(conn, evaluation, expected_revision)
            try:
                conn.execute(
                    self.compose(
                        "INSERT INTO {appeals} (id, evaluation_id, group_id, conversation_id,"
                        " criterion_id, status, created_at, decided_at, doc)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, %s)"
                    ),
                    (
                        appeal["id"],
                        appeal["evaluation_id"],
                        appeal["group_id"],
                        appeal["conversation_id"],
                        appeal["criterion_id"],
                        appeal["status"],
                        appeal["created_at"],
                        to_json(appeal),
                    ),
                )
            except psycopg.errors.UniqueViolation as exc:
                raise DuplicateAppealError(appeal["criterion_id"]) from exc

    @_guarded("сохранение решения по апелляции")
    def resolve_appeal(
        self, appeal: dict[str, Any], evaluation: dict[str, Any], *, expected_revision: int
    ) -> None:
        decided_at = (appeal.get("decision") or {}).get("decided_at")
        with self.connection() as conn, conn.transaction():
            cursor = conn.execute(
                self.compose(
                    "UPDATE {appeals} SET status = 'resolved', decided_at = %s, doc = %s"
                    " WHERE id = %s AND status = 'open'"
                ),
                (
                    None if decided_at is None else str(decided_at),
                    to_json(appeal),
                    appeal["id"],
                ),
            )
            if cursor.rowcount != 1:
                raise AppealNotOpenError(appeal["id"])
            self._update_evaluation(conn, evaluation, expected_revision)

    @_guarded("чтение апелляции")
    def get_appeal(self, appeal_id: str) -> dict[str, Any] | None:
        rows = self._fetch("SELECT doc FROM {appeals} WHERE id = %s", (appeal_id,))
        return rows[0]["doc"] if rows else None

    @_guarded("чтение апелляций")
    def list_appeals(
        self,
        *,
        group_id: str | None = None,
        status: AppealStatus | None = None,
        evaluation_ids: Sequence[str] | None = None,
        conversation_id: str | None = None,
        purpose: Purpose | None = None,
    ) -> list[dict[str, Any]]:
        where, params = self._where(
            [
                ("group_id = %s", group_id),
                ("status = %s", status),
                ("conversation_id = %s", conversation_id),
                (
                    "evaluation_id = ANY(%s)",
                    None if evaluation_ids is None else list(evaluation_ids),
                ),
                ("evaluation_id IN (SELECT id FROM {evaluations} WHERE purpose = %s)", purpose),
            ]
        )
        with self.connection() as conn:
            rows = conn.execute(
                self.compose(
                    "SELECT doc FROM {appeals}{where}"
                    " ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,"
                    " CASE WHEN status = 'open' THEN seq END ASC NULLS FIRST,"
                    ' decided_at COLLATE "C" DESC NULLS LAST, seq DESC',
                    where=where,
                ),
                params,
            ).fetchall()
        return [row["doc"] for row in rows]

    def _update_evaluation(
        self, conn: Connection, evaluation: dict[str, Any], expected_revision: int
    ) -> None:
        cursor = conn.execute(
            self.compose(
                "UPDATE {evaluations} SET doc = %s, revision = revision + 1"
                " WHERE id = %s AND revision = %s"
            ),
            (to_json(evaluation), evaluation["id"], expected_revision),
        )
        if cursor.rowcount != 1:
            raise RevisionConflictError(evaluation["id"])


def to_json(value: object) -> Json:
    """Документ для колонки json: компактно и без \\u-экранирования, как в SQLite."""
    return Json(value, dumps=_dumps)


def _dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def without_nul(value: str | None) -> str | None:
    """Строка для колонки text: Postgres не хранит символ NUL (в json он экранирован)."""
    return None if value is None else value.replace("\x00", "")


def _advisory_lock(conn: Connection, key: str) -> None:
    """Блокировка до конца текущей транзакции (работает и через пулер в режиме транзакций)."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (key,))


def _checklist_version(row: Row) -> ChecklistVersion:
    return ChecklistVersion(
        checklist_id=row["checklist_id"],
        version=row["version"],
        title=row["title"],
        doc=row["doc"],
        note=row["note"],
        sandbox=bool(row["sandbox"]),
        source=row["source"],
        created_at=row["created_at"],
    )


def _stored_evaluation(row: Row) -> StoredEvaluation:
    return StoredEvaluation(
        doc=row["doc"],
        revision=row["revision"],
        language=row["language"],
        channel=row["channel"],
    )
