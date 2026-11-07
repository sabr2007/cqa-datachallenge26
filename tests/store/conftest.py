"""Фикстуры контрактных тестов Store: каждый тест идёт на SQLite и на Postgres.

SQLite — всегда (файл во временной папке). Postgres — только если задан
CQA_TEST_DATABASE_URL (в CI его нет): каждый тест получает свою схему
cqa_test_<случайно>, после теста она удаляется; рабочая схема не затрагивается.
"""

import os
import secrets
import sqlite3
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import pytest
from psycopg import sql

from app.store import PostgresStore, SqliteStore, Store
from app.store.postgres_schema import OBJECTS

TEST_DATABASE_URL_ENV = "CQA_TEST_DATABASE_URL"
TEST_SCHEMA_PREFIX = "cqa_test_"
BACKENDS = ("sqlite", "postgres")


@dataclass(frozen=True)
class Backend:
    """Хранилище под тестом: открыть ещё одно подключение к той же базе, выполнить SQL."""

    name: str
    open_store: Callable[..., Store]
    execute: Callable[[str], None]  # {checklist_versions} и т. п. — имена таблиц
    database_error: type[Exception]


def configured_database_url() -> str | None:
    return (os.environ.get(TEST_DATABASE_URL_ENV) or "").strip() or None


def new_test_schema() -> str:
    return f"{TEST_SCHEMA_PREFIX}{secrets.token_hex(6)}"


def drop_schema(url: str, schema: str) -> None:
    if not schema.startswith(TEST_SCHEMA_PREFIX):  # рабочую схему тесты не удаляют никогда
        raise ValueError(f"не тестовая схема: {schema}")
    with psycopg.connect(url, autocommit=True, prepare_threshold=None) as conn:
        conn.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture(params=BACKENDS)
def backend(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[Backend]:
    if request.param == "sqlite":
        yield from _sqlite_backend(tmp_path / "cqa.sqlite")
    else:
        yield from _postgres_backend()


@pytest.fixture
def store(backend: Backend) -> Store:
    return backend.open_store()


def _sqlite_backend(path: Path) -> Iterator[Backend]:
    opened: list[SqliteStore] = []

    def open_store(**kwargs: Any) -> Store:
        opened.append(SqliteStore(str(path), **kwargs))
        return opened[-1]

    def execute(statement: str) -> None:
        conn = sqlite3.connect(path)
        try:
            conn.execute(statement.format(**{name: name for name in OBJECTS}))
            conn.commit()
        finally:
            conn.close()

    yield Backend("sqlite", open_store, execute, sqlite3.DatabaseError)
    for opened_store in opened:
        opened_store.close()


def _postgres_backend() -> Iterator[Backend]:
    url = configured_database_url()
    if url is None:
        pytest.skip(f"{TEST_DATABASE_URL_ENV} не задан — Postgres-вариант пропущен")
    schema = new_test_schema()
    opened: list[PostgresStore] = []

    def open_store(**kwargs: Any) -> Store:
        opened.append(PostgresStore(url, schema=schema, **kwargs))
        return opened[-1]

    def execute(statement: str) -> None:
        names = {name: sql.Identifier(schema, name) for name in OBJECTS}
        with psycopg.connect(url, autocommit=True, prepare_threshold=None) as conn:
            conn.execute(sql.SQL(statement).format(**names))  # type: ignore[arg-type]

    try:
        yield Backend("postgres", open_store, execute, psycopg.Error)
    finally:
        for opened_store in opened:
            opened_store.close()
        drop_schema(url, schema)
