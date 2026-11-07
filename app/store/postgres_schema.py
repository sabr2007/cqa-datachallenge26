"""Схема Postgres и миграции — та же модель данных, что у SQLite (app/store/schema.py).

Номера применённых миграций лежат в таблице cqa_schema_migrations той же схемы;
миграция N — список команд, которые переводят схему из версии N-1 в N. Новые
изменения — только новой миграцией в конце списка, старые не правятся.

В командах `{checklist_versions}`, `{evaluations}`, `{appeals}`, `{migrations}` и
`{reject_change}` подставляются имена с указанием схемы (psycopg.sql.Identifier).
Даты — строки ISO 8601 UTC, как в контракте и в SQLite; документы — тип json (не jsonb):
текст хранится как есть, поэтому порядок ключей в ответах API не меняется.
"""

from typing import LiteralString

MIGRATIONS_TABLE = "cqa_schema_migrations"

CREATE_MIGRATIONS_TABLE: LiteralString = """
    CREATE TABLE IF NOT EXISTS {migrations} (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
"""

MIGRATION_1: tuple[LiteralString, ...] = (
    """
    CREATE TABLE {checklist_versions} (
        checklist_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        title TEXT NOT NULL,
        doc JSON NOT NULL,
        note TEXT,
        sandbox BOOLEAN NOT NULL DEFAULT FALSE,
        source TEXT NOT NULL CHECK (source IN ('file', 'api')),
        source_hash TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (checklist_id, version)
    )
    """,
    # Версии неизменяемы: правка чек-листа — всегда новая версия.
    """
    CREATE FUNCTION {reject_change}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION 'checklist versions are immutable';
    END
    $$
    """,
    """
    CREATE TRIGGER checklist_versions_immutable BEFORE UPDATE OR DELETE
    ON {checklist_versions} FOR EACH ROW EXECUTE FUNCTION {reject_change}()
    """,
    """
    CREATE TRIGGER checklist_versions_no_truncate BEFORE TRUNCATE
    ON {checklist_versions} FOR EACH STATEMENT EXECUTE FUNCTION {reject_change}()
    """,
    """
    CREATE TABLE {evaluations} (
        seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        checklist_id TEXT NOT NULL,
        checklist_version INTEGER NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('regular', 'sandbox')),
        status TEXT NOT NULL CHECK (status IN ('done', 'error')),
        language TEXT,
        channel TEXT,
        created_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        doc JSON NOT NULL,
        transcript JSON
    )
    """,
    "CREATE INDEX evaluations_by_conversation ON {evaluations} (group_id, conversation_id, seq)",
    "CREATE INDEX evaluations_by_created ON {evaluations} (created_at)",
    """
    CREATE TABLE {appeals} (
        seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        evaluation_id TEXT NOT NULL REFERENCES {evaluations} (id),
        group_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        criterion_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        doc JSON NOT NULL,
        UNIQUE (evaluation_id, criterion_id)
    )
    """,
    "CREATE INDEX appeals_by_group ON {appeals} (group_id, status, seq)",
)

MIGRATIONS: tuple[tuple[LiteralString, ...], ...] = (MIGRATION_1,)
SCHEMA_VERSION = len(MIGRATIONS)

# Объекты схемы, имена которых подставляются в команды выше.
OBJECTS = ("checklist_versions", "evaluations", "appeals")
REJECT_CHANGE_FUNCTION = "cqa_reject_change"
