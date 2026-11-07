"""Хранилище на SQLite (stdlib sqlite3).

Одно соединение на процесс под RLock: синхронные роуты FastAPI выполняются в пуле
потоков, а одно соединение SQLite нельзя использовать из нескольких потоков сразу.
Несколько процессов (серверы на разных портах) могут делить один файл: WAL,
busy_timeout и BEGIN IMMEDIATE для записей; номер версии чек-листа выдаётся внутри
транзакции, изменения оценки — с проверкой ревизии (оптимистичная блокировка).
"""

import json
import logging
import sqlite3
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from app.config import MEMORY_DB
from app.store.base import (
    AppealNotOpenError,
    AppealStatus,
    ChecklistSource,
    ChecklistVersion,
    DuplicateAppealError,
    Purpose,
    RevisionConflictError,
    StoredEvaluation,
    guarded,
    utc_now,
)
from app.store.schema import MIGRATIONS, SCHEMA_VERSION

logger = logging.getLogger("cqa.store")

BUSY_TIMEOUT_SEC = 10.0


def _guarded[**P, R](action: str) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Ошибки sqlite3 → StorageError (503); подробности уходят только в лог."""
    return guarded(action, (sqlite3.Error,))


class SqliteStore:
    def __init__(self, path: str, *, clock: Callable[[], str] = utc_now) -> None:
        self._path = path
        self._clock = clock
        self._lock = threading.RLock()
        try:
            self._conn = _connect(path)
            self._migrate()
        except sqlite3.Error as exc:
            raise RuntimeError(f"Не удалось открыть базу {path}: {exc}") from exc

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- служебное ---

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except BaseException:
                if self._conn.in_transaction:
                    self._conn.execute("ROLLBACK")
                raise

    def _query(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def _migrate(self) -> None:
        with self._transaction() as conn:
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            if current > SCHEMA_VERSION:
                raise RuntimeError(
                    f"База {self._path} создана более новой версией приложения "
                    f"(схема {current}, код знает {SCHEMA_VERSION})"
                )
            for number in range(current + 1, SCHEMA_VERSION + 1):
                for statement in MIGRATIONS[number - 1]:
                    conn.execute(statement)
                conn.execute(f"PRAGMA user_version = {int(number)}")
                logger.info("База %s: применена миграция %d", self._path, number)

    # --- версии чек-листов ---

    @_guarded("чтение версий чек-листов")
    def list_checklist_versions(self) -> list[ChecklistVersion]:
        rows = self._query(
            "SELECT checklist_id, version, title, doc, note, sandbox, source, created_at"
            " FROM checklist_versions ORDER BY checklist_id, version"
        )
        return [_checklist_version(row) for row in rows]

    @_guarded("чтение версии чек-листа")
    def get_checklist_version(
        self, checklist_id: str, version: int | None = None
    ) -> ChecklistVersion | None:
        if version is None:
            rows = self._query(
                "SELECT checklist_id, version, title, doc, note, sandbox, source, created_at"
                " FROM checklist_versions WHERE checklist_id = ? AND sandbox = 0"
                " ORDER BY version DESC LIMIT 1",
                (checklist_id,),
            )
        else:
            rows = self._query(
                "SELECT checklist_id, version, title, doc, note, sandbox, source, created_at"
                " FROM checklist_versions WHERE checklist_id = ? AND version = ?",
                (checklist_id, version),
            )
        return _checklist_version(rows[0]) if rows else None

    @_guarded("сохранение версии чек-листа")
    def add_checklist_version(
        self, checklist_id: str, doc: dict[str, Any], *, note: str | None, sandbox: bool
    ) -> ChecklistVersion:
        with self._transaction() as conn:
            return self._insert_version(
                conn, checklist_id, doc, note=note, sandbox=sandbox, source="api", source_hash=None
            )

    @_guarded("синхронизация чек-листа из файла")
    def sync_checklist_file(
        self, checklist_id: str, doc: dict[str, Any], *, note: str, source_hash: str
    ) -> ChecklistVersion | None:
        with self._transaction() as conn:
            latest = conn.execute(
                "SELECT source, source_hash FROM checklist_versions"
                " WHERE checklist_id = ? AND sandbox = 0 ORDER BY version DESC LIMIT 1",
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

    def _insert_version(
        self,
        conn: sqlite3.Connection,
        checklist_id: str,
        doc: dict[str, Any],
        *,
        note: str | None,
        sandbox: bool,
        source: ChecklistSource,
        source_hash: str | None,
    ) -> ChecklistVersion:
        last = conn.execute(
            "SELECT COALESCE(MAX(version), 0) FROM checklist_versions WHERE checklist_id = ?",
            (checklist_id,),
        ).fetchone()[0]
        number = int(last) + 1
        body = {key: value for key, value in doc.items() if key not in ("id", "version")}
        stored = {"id": checklist_id, "version": number, **body}
        title = str(doc.get("title") or checklist_id)
        created_at = self._clock()
        conn.execute(
            "INSERT INTO checklist_versions"
            " (checklist_id, version, title, doc, note, sandbox, source, source_hash, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                checklist_id,
                number,
                title,
                _dumps(stored),
                note,
                int(sandbox),
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
            note=note,
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
        with self._lock:
            self._conn.execute(
                "INSERT INTO evaluations (id, group_id, conversation_id, checklist_id,"
                " checklist_version, purpose, status, language, channel, created_at, revision,"
                " doc, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                (
                    evaluation["id"],
                    evaluation["group_id"],
                    evaluation["conversation_id"],
                    evaluation["checklist_id"],
                    evaluation["checklist_version"],
                    evaluation["purpose"],
                    evaluation["status"],
                    language,
                    channel,
                    evaluation["created_at"],
                    _dumps(evaluation),
                    _dumps(list(transcript)),
                ),
            )
        return StoredEvaluation(
            doc=evaluation,
            revision=1,
            language=language,
            channel=channel,
            transcript=tuple(transcript),
        )

    @_guarded("чтение оценки")
    def get_evaluation(self, evaluation_id: str) -> StoredEvaluation | None:
        rows = self._query(
            "SELECT doc, revision, language, channel, transcript FROM evaluations WHERE id = ?",
            (evaluation_id,),
        )
        if not rows:
            return None
        row = rows[0]
        transcript = json.loads(row["transcript"]) if row["transcript"] else []
        return StoredEvaluation(
            doc=json.loads(row["doc"]),
            revision=row["revision"],
            language=row["language"],
            channel=row["channel"],
            transcript=tuple(transcript),
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
        rows = self._query(
            "SELECT doc, revision, language, channel FROM evaluations"
            " WHERE (:group_id IS NULL OR group_id = :group_id)"
            " AND (:conversation_id IS NULL OR conversation_id = :conversation_id)"
            " AND (:purpose IS NULL OR purpose = :purpose)"
            " ORDER BY seq DESC LIMIT :limit",
            {
                "group_id": group_id,
                "conversation_id": conversation_id,
                "purpose": purpose,
                "limit": limit,
            },
        )
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
        rows = self._query(
            "SELECT doc, revision, language, channel FROM ("
            " SELECT doc, revision, language, channel, group_id, conversation_id,"
            " ROW_NUMBER() OVER (PARTITION BY group_id, conversation_id ORDER BY seq DESC)"
            " AS position FROM evaluations"
            " WHERE status = 'done'"
            " AND (:group_id IS NULL OR group_id = :group_id)"
            " AND (:purpose IS NULL OR purpose = :purpose)"
            " AND (:checklist_id IS NULL OR checklist_id = :checklist_id)"
            " AND (:checklist_version IS NULL OR checklist_version = :checklist_version)"
            ") WHERE position = 1 ORDER BY group_id, conversation_id",
            {
                "group_id": group_id,
                "purpose": purpose,
                "checklist_id": checklist_id,
                "checklist_version": checklist_version,
            },
        )
        return [_stored_evaluation(row) for row in rows]

    # --- апелляции ---

    @_guarded("сохранение апелляции")
    def add_appeal(
        self, appeal: dict[str, Any], evaluation: dict[str, Any], *, expected_revision: int
    ) -> None:
        with self._transaction() as conn:
            exists = conn.execute(
                "SELECT 1 FROM appeals WHERE evaluation_id = ? AND criterion_id = ?",
                (appeal["evaluation_id"], appeal["criterion_id"]),
            ).fetchone()
            if exists:
                raise DuplicateAppealError(appeal["criterion_id"])
            _update_evaluation(conn, evaluation, expected_revision)
            try:
                conn.execute(
                    "INSERT INTO appeals (id, evaluation_id, group_id, conversation_id,"
                    " criterion_id, status, created_at, decided_at, doc)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                    (
                        appeal["id"],
                        appeal["evaluation_id"],
                        appeal["group_id"],
                        appeal["conversation_id"],
                        appeal["criterion_id"],
                        appeal["status"],
                        appeal["created_at"],
                        _dumps(appeal),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateAppealError(appeal["criterion_id"]) from exc

    @_guarded("сохранение решения по апелляции")
    def resolve_appeal(
        self, appeal: dict[str, Any], evaluation: dict[str, Any], *, expected_revision: int
    ) -> None:
        decision = appeal.get("decision") or {}
        with self._transaction() as conn:
            cursor = conn.execute(
                "UPDATE appeals SET status = 'resolved', decided_at = ?, doc = ?"
                " WHERE id = ? AND status = 'open'",
                (decision.get("decided_at"), _dumps(appeal), appeal["id"]),
            )
            if cursor.rowcount != 1:
                raise AppealNotOpenError(appeal["id"])
            _update_evaluation(conn, evaluation, expected_revision)

    @_guarded("чтение апелляции")
    def get_appeal(self, appeal_id: str) -> dict[str, Any] | None:
        rows = self._query("SELECT doc FROM appeals WHERE id = ?", (appeal_id,))
        return json.loads(rows[0]["doc"]) if rows else None

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
        rows = self._query(
            "SELECT doc FROM appeals"
            " WHERE (:group_id IS NULL OR group_id = :group_id)"
            " AND (:status IS NULL OR status = :status)"
            " AND (:conversation_id IS NULL OR conversation_id = :conversation_id)"
            " AND (:evaluation_ids IS NULL"
            "      OR evaluation_id IN (SELECT value FROM json_each(:evaluation_ids)))"
            " AND (:purpose IS NULL"
            "      OR evaluation_id IN (SELECT id FROM evaluations WHERE purpose = :purpose))"
            " ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,"
            " CASE WHEN status = 'open' THEN seq END ASC, decided_at DESC, seq DESC",
            {
                "group_id": group_id,
                "status": status,
                "conversation_id": conversation_id,
                "evaluation_ids": None if evaluation_ids is None else _dumps(list(evaluation_ids)),
                "purpose": purpose,
            },
        )
        return [json.loads(row["doc"]) for row in rows]


def _connect(path: str) -> sqlite3.Connection:
    if path != MEMORY_DB:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        path, timeout=BUSY_TIMEOUT_SEC, isolation_level=None, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if path != MEMORY_DB:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def _update_evaluation(
    conn: sqlite3.Connection, evaluation: dict[str, Any], expected_revision: int
) -> None:
    cursor = conn.execute(
        "UPDATE evaluations SET doc = ?, revision = revision + 1 WHERE id = ? AND revision = ?",
        (_dumps(evaluation), evaluation["id"], expected_revision),
    )
    if cursor.rowcount != 1:
        raise RevisionConflictError(evaluation["id"])


def _checklist_version(row: sqlite3.Row) -> ChecklistVersion:
    return ChecklistVersion(
        checklist_id=row["checklist_id"],
        version=row["version"],
        title=row["title"],
        doc=json.loads(row["doc"]),
        note=row["note"],
        sandbox=bool(row["sandbox"]),
        source=row["source"],
        created_at=row["created_at"],
    )


def _stored_evaluation(row: sqlite3.Row) -> StoredEvaluation:
    return StoredEvaluation(
        doc=json.loads(row["doc"]),
        revision=row["revision"],
        language=row["language"],
        channel=row["channel"],
    )


def _dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
