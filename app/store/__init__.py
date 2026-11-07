"""Хранилище версий чек-листов, оценок и апелляций (интерфейс — app.store.base.Store)."""

import logging

from app.config import Settings
from app.store.base import (
    APPEAL_STATUSES,
    PURPOSES,
    AppealNotOpenError,
    AppealStatus,
    ChecklistVersion,
    DuplicateAppealError,
    Purpose,
    RevisionConflictError,
    StorageError,
    Store,
    StoredEvaluation,
    utc_now,
)
from app.store.postgres import PostgresStore
from app.store.sqlite import SqliteStore

logger = logging.getLogger("cqa.store")


def open_store(settings: Settings) -> Store:
    """Postgres, если задан адрес базы (DATABASE_URL — облако), иначе SQLite-файл (локально).

    Postgres подключается лениво: при старте соединения нет, схема мигрирует при первом
    обращении, поэтому недоступная база не мешает приложению подняться.
    """
    if settings.database_url:
        logger.info("Хранилище: Postgres, схема %s", settings.db_schema)
        return PostgresStore(settings.database_url, schema=settings.db_schema)
    logger.info("Хранилище: SQLite (%s)", settings.db_path)
    return SqliteStore(settings.db_path)


__all__ = [
    "APPEAL_STATUSES",
    "PURPOSES",
    "AppealNotOpenError",
    "AppealStatus",
    "ChecklistVersion",
    "DuplicateAppealError",
    "PostgresStore",
    "Purpose",
    "RevisionConflictError",
    "SqliteStore",
    "StorageError",
    "Store",
    "StoredEvaluation",
    "open_store",
    "utc_now",
]
