"""Схема SQLite и миграции.

Номер схемы хранится в `PRAGMA user_version`; миграция N — список SQL-команд,
которые переводят базу из версии N-1 в N. Новые изменения — только новой
миграцией в конце списка, старые не правятся.
"""

MIGRATION_1 = (
    """
    CREATE TABLE checklist_versions (
        checklist_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        title TEXT NOT NULL,
        doc TEXT NOT NULL,
        note TEXT,
        sandbox INTEGER NOT NULL DEFAULT 0 CHECK (sandbox IN (0, 1)),
        source TEXT NOT NULL CHECK (source IN ('file', 'api')),
        source_hash TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (checklist_id, version)
    )
    """,
    # Версии неизменяемы: правка чек-листа — всегда новая версия.
    """
    CREATE TRIGGER checklist_versions_immutable_update BEFORE UPDATE ON checklist_versions
    BEGIN
        SELECT RAISE(ABORT, 'checklist versions are immutable');
    END
    """,
    """
    CREATE TRIGGER checklist_versions_immutable_delete BEFORE DELETE ON checklist_versions
    BEGIN
        SELECT RAISE(ABORT, 'checklist versions are immutable');
    END
    """,
    """
    CREATE TABLE evaluations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
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
        doc TEXT NOT NULL,
        transcript TEXT
    )
    """,
    "CREATE INDEX evaluations_by_conversation ON evaluations (group_id, conversation_id, seq)",
    "CREATE INDEX evaluations_by_created ON evaluations (created_at)",
    """
    CREATE TABLE appeals (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        evaluation_id TEXT NOT NULL REFERENCES evaluations (id),
        group_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        criterion_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        doc TEXT NOT NULL,
        UNIQUE (evaluation_id, criterion_id)
    )
    """,
    "CREATE INDEX appeals_by_group ON appeals (group_id, status, seq)",
)

MIGRATIONS: tuple[tuple[str, ...], ...] = (MIGRATION_1,)
SCHEMA_VERSION = len(MIGRATIONS)
