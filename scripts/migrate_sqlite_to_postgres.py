"""Перенос хранилища из SQLite (.data/cqa.sqlite) в Postgres: версии чек-листа, оценки, апелляции.

    uv run --env-file .env.local python scripts/migrate_sqlite_to_postgres.py [--dry-run]
        [--sqlite .data/cqa.sqlite] [--schema public]

Адрес Postgres — из окружения: DATABASE_URL_UNPOOLED (прямое соединение, лучше для разовой
загрузки), иначе DATABASE_URL, POSTGRES_URL_NON_POOLING или POSTGRES_URL. Значение не печатается.

- SQLite открывается только на чтение; данные читаются одним снимком (транзакция чтения),
  поэтому параллельно работающий сервер не мешает и файл не меняется.
- В Postgres всё пишется одной транзакцией: при ошибке не остаётся ничего наполовину.
- Идемпотентно: строки с теми же ключами (версия — checklist_id + version, оценка и
  апелляция — id) не перезаписываются; повторный запуск дописывает только новые.
- Сохраняются id, даты (created_at, decided_at), ревизии, транскрипты, источник и хэш версий
  чек-листа; оценки и апелляции добавляются в порядке SQLite (seq), поэтому «последняя
  оценка» и очередь апелляций те же.
- Версия чек-листа с тем же номером, но другим содержимым — конфликт: перенос отменяется
  целиком (оценки ссылаются на версии по номеру, смешивать их нельзя).
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, LiteralString

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402

from app.config import DEFAULT_DB_PATH, DEFAULT_DB_SCHEMA  # noqa: E402
from app.store.postgres import PostgresStore, scrub_credentials, without_nul  # noqa: E402
from app.store.schema import SCHEMA_VERSION as SQLITE_SCHEMA_VERSION  # noqa: E402

URL_ENV_NAMES = (
    "DATABASE_URL_UNPOOLED",
    "DATABASE_URL",
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_URL",
)

Row = dict[str, Any]


class TransferError(Exception):
    """Перенос невозможен без потери данных; в Postgres ничего не записано."""


@dataclass(frozen=True)
class Snapshot:
    checklist_versions: tuple[Row, ...]
    evaluations: tuple[Row, ...]
    appeals: tuple[Row, ...]


@dataclass
class TableReport:
    copied: int = 0
    present: int = 0  # уже были в Postgres с тем же содержимым
    changed: list[str] = field(default_factory=list)  # уже были, но изменены после переноса

    def line(self, name: str, total: int) -> str:
        note = f", изменены после переноса и оставлены как есть: {len(self.changed)}"
        return f"{name}: в SQLite {total}, перенесено {self.copied}, уже были {self.present}" + (
            note if self.changed else ""
        )


@dataclass
class Report:
    checklist_versions: TableReport = field(default_factory=TableReport)
    evaluations: TableReport = field(default_factory=TableReport)
    appeals: TableReport = field(default_factory=TableReport)


def read_snapshot(path: Path) -> Snapshot:
    """Все строки SQLite одним снимком; файл открывается только на чтение и не создаётся."""
    if not path.is_file():
        raise TransferError(f"Нет файла SQLite: {path}")
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version != SQLITE_SCHEMA_VERSION:
            raise TransferError(
                f"Схема SQLite {version}, скрипт знает {SQLITE_SCHEMA_VERSION}: обновите скрипт"
            )
        conn.execute("BEGIN")  # один снимок для всех таблиц
        snapshot = Snapshot(
            checklist_versions=_rows(
                conn,
                "SELECT checklist_id, version, title, doc, note, sandbox, source, source_hash,"
                " created_at FROM checklist_versions ORDER BY checklist_id, version",
            ),
            evaluations=_rows(
                conn,
                "SELECT id, group_id, conversation_id, checklist_id, checklist_version, purpose,"
                " status, language, channel, created_at, revision, doc, transcript"
                " FROM evaluations ORDER BY seq",
            ),
            appeals=_rows(
                conn,
                "SELECT id, evaluation_id, group_id, conversation_id, criterion_id, status,"
                " created_at, decided_at, doc FROM appeals ORDER BY seq",
            ),
        )
        conn.execute("ROLLBACK")
        return snapshot
    finally:
        conn.close()


def copy_snapshot(snapshot: Snapshot, store: PostgresStore, *, dry_run: bool = False) -> Report:
    """Пишет снимок в Postgres одной транзакцией; dry_run — то же, но с откатом в конце."""
    report = Report()
    with store.connection() as conn, conn.transaction(force_rollback=dry_run):
        conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"cqa:{store.schema}:import",),
        )
        for row in snapshot.checklist_versions:
            _copy_version(conn, store, row, report.checklist_versions)
        for row in snapshot.evaluations:
            _copy_evaluation(conn, store, row, report.evaluations)
        for row in snapshot.appeals:
            _copy_appeal(conn, store, row, report.appeals)
    return report


def _copy_version(
    conn: psycopg.Connection[Row], store: PostgresStore, row: Row, report: TableReport
) -> None:
    inserted = _insert(
        conn,
        store,
        "INSERT INTO {checklist_versions} (checklist_id, version, title, doc, note, sandbox,"
        " source, source_hash, created_at) VALUES (%s, %s, %s, %s::json, %s, %s, %s, %s, %s)"
        " ON CONFLICT (checklist_id, version) DO NOTHING",
        (
            row["checklist_id"],
            row["version"],
            without_nul(row["title"]),
            row["doc"],
            without_nul(row["note"]),
            bool(row["sandbox"]),
            row["source"],
            row["source_hash"],
            row["created_at"],
        ),
    )
    if inserted:
        report.copied += 1
        return
    existing = conn.execute(
        store.compose(
            "SELECT title, doc, note, sandbox, source, source_hash, created_at"
            " FROM {checklist_versions} WHERE checklist_id = %s AND version = %s"
        ),
        (row["checklist_id"], row["version"]),
    ).fetchone()
    expected = {
        "title": without_nul(row["title"]),
        "doc": json.loads(row["doc"]),
        "note": without_nul(row["note"]),
        "sandbox": bool(row["sandbox"]),
        "source": row["source"],
        "source_hash": row["source_hash"],
        "created_at": row["created_at"],
    }
    if existing != expected:
        differs = sorted(key for key in expected if (existing or {}).get(key) != expected[key])
        raise TransferError(
            f"Версия чек-листа {row['checklist_id']} v{row['version']} в Postgres другая "
            f"(отличаются: {', '.join(differs)}). Оценки ссылаются на версии по номеру — "
            "перенос отменён; перенесите в пустую схему (--schema) или разберите вручную."
        )
    report.present += 1


def _copy_evaluation(
    conn: psycopg.Connection[Row], store: PostgresStore, row: Row, report: TableReport
) -> None:
    inserted = _insert(
        conn,
        store,
        "INSERT INTO {evaluations} (id, group_id, conversation_id, checklist_id,"
        " checklist_version, purpose, status, language, channel, created_at, revision, doc,"
        " transcript) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::json, %s::json)"
        " ON CONFLICT (id) DO NOTHING",
        (
            row["id"],
            row["group_id"],
            row["conversation_id"],
            row["checklist_id"],
            row["checklist_version"],
            row["purpose"],
            row["status"],
            without_nul(row["language"]),
            without_nul(row["channel"]),
            row["created_at"],
            row["revision"],
            row["doc"],
            row["transcript"],
        ),
    )
    if inserted:
        report.copied += 1
        return
    existing = conn.execute(
        store.compose("SELECT revision, doc FROM {evaluations} WHERE id = %s"), (row["id"],)
    ).fetchone()
    same = existing == {"revision": row["revision"], "doc": json.loads(row["doc"])}
    _count_existing(report, row["id"], same=same)


def _copy_appeal(
    conn: psycopg.Connection[Row], store: PostgresStore, row: Row, report: TableReport
) -> None:
    inserted = _insert(
        conn,
        store,
        "INSERT INTO {appeals} (id, evaluation_id, group_id, conversation_id, criterion_id,"
        " status, created_at, decided_at, doc) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::json)"
        " ON CONFLICT DO NOTHING",
        (
            row["id"],
            row["evaluation_id"],
            row["group_id"],
            row["conversation_id"],
            row["criterion_id"],
            row["status"],
            row["created_at"],
            row["decided_at"],
            row["doc"],
        ),
    )
    if inserted:
        report.copied += 1
        return
    existing = conn.execute(
        store.compose("SELECT doc FROM {appeals} WHERE id = %s"), (row["id"],)
    ).fetchone()
    if existing is None:  # пропущена из-за другой апелляции по тому же критерию оценки
        raise TransferError(
            f"Апелляция {row['id']}: по критерию {row['criterion_id']} оценки "
            f"{row['evaluation_id']} в Postgres уже есть другая апелляция — перенос отменён."
        )
    _count_existing(report, row["id"], same=existing["doc"] == json.loads(row["doc"]))


def _insert(
    conn: psycopg.Connection[Row],
    store: PostgresStore,
    template: LiteralString,
    params: Sequence[Any],
) -> bool:
    return conn.execute(store.compose(template), params).rowcount == 1


def _count_existing(report: TableReport, row_id: str, *, same: bool) -> None:
    """Строка уже есть: та же — «уже были»; другая — её изменили в Postgres, не трогаем."""
    if same:
        report.present += 1
    else:
        report.changed.append(row_id)


def _rows(conn: sqlite3.Connection, query: str) -> tuple[Row, ...]:
    return tuple(dict(row) for row in conn.execute(query))


def database_url(environ: Mapping[str, str]) -> tuple[str, str]:
    """(имя переменной, адрес) — первый заданный из URL_ENV_NAMES."""
    for name in URL_ENV_NAMES:
        value = (environ.get(name) or "").strip()
        if value:
            return name, value
    raise TransferError(
        "Не задан адрес Postgres: "
        + ", ".join(URL_ENV_NAMES)
        + " (например, uv run --env-file .env.local …)"
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--sqlite", type=Path, default=DEFAULT_DB_PATH, help="файл SQLite")
    parser.add_argument(
        "--schema",
        default=os.environ.get("CQA_DB_SCHEMA") or DEFAULT_DB_SCHEMA,
        help="схема Postgres (по умолчанию CQA_DB_SCHEMA или public)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="всё проверить и посчитать, но откатить запись данных "
        "(пустые таблицы схемы при этом создаются, если их ещё нет)",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    args = parse_args(argv)
    try:
        url_name, url = database_url(os.environ)
        snapshot = read_snapshot(args.sqlite)
        store = PostgresStore(url, schema=args.schema)
        try:
            report = copy_snapshot(snapshot, store, dry_run=args.dry_run)
        finally:
            store.close()
    except (TransferError, ValueError) as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        return 1
    except (psycopg.Error, sqlite3.Error) as exc:
        print(f"Ошибка базы: {scrub_credentials(f'{type(exc).__name__}: {exc}')}", file=sys.stderr)
        return 1
    mode = "проверка без записи (--dry-run)" if args.dry_run else "перенос выполнен"
    print(f"{mode}: {args.sqlite} → Postgres ({url_name}), схема {args.schema}")
    print(report.checklist_versions.line("Версии чек-листа", len(snapshot.checklist_versions)))
    print(report.evaluations.line("Оценки", len(snapshot.evaluations)))
    print(report.appeals.line("Апелляции", len(snapshot.appeals)))
    for table in (report.evaluations, report.appeals):
        for row_id in table.changed:
            print(f"  изменена в Postgres после переноса: {row_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
