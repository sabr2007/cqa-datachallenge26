"""Выбор хранилища по настройкам и поведение Postgres без базы — без сети, выполняется всегда."""

from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, load_settings
from app.factory import create_app
from app.store import PostgresStore, SqliteStore, StorageError, open_store
from app.store.postgres import scrub_credentials
from tests.api.conftest import CHECKLIST_FIXTURE
from tests.api.fakes import FakeEvaluator
from tests.support import RecordingUpstream

CANARY = "s3cret-Pa55"  # метка-«пароль»: не должна попасть в ошибки и логи
UNREACHABLE = f"postgresql://cqa:{CANARY}@127.0.0.1:9/cqa?sslmode=disable"  # порт discard


def unreachable_store() -> PostgresStore:
    return PostgresStore(UNREACHABLE, timeout_sec=0.5, connect_timeout_sec=1)


def test_database_url_comes_from_env_and_takes_precedence_over_sqlite() -> None:
    pooled = f"postgresql://cqa:{CANARY}@ep-1-pooler.neon.tech/db?sslmode=require"
    fallback = f"postgres://cqa:{CANARY}@ep-2.neon.tech/db"

    settings = load_settings({"DATABASE_URL": pooled, "POSTGRES_URL": fallback})

    assert settings.database_url == pooled
    assert load_settings({"POSTGRES_URL": fallback}).database_url == fallback
    assert load_settings({"DATABASE_URL": " "}).database_url is None
    assert load_settings({}).db_schema == "public"
    assert load_settings({"CQA_DB_SCHEMA": "cqa_demo"}).db_schema == "cqa_demo"
    assert CANARY not in repr(settings)


@pytest.mark.parametrize(
    "env",
    [
        {"DATABASE_URL": f"mysql://cqa:{CANARY}@db.example.com/cqa"},
        {"POSTGRES_URL": f"cqa:{CANARY}@db.example.com/cqa"},
        {"CQA_DB_SCHEMA": "Public"},
        {"CQA_DB_SCHEMA": "pg_catalog"},
        {"CQA_DB_SCHEMA": "cqa-test"},
    ],
)
def test_invalid_database_settings_fail_fast_without_echo(env: dict[str, str]) -> None:
    with pytest.raises(ValueError) as caught:
        load_settings(env)

    assert CANARY not in str(caught.value)


def test_open_store_uses_sqlite_by_default_and_postgres_with_database_url() -> None:
    sqlite = open_store(Settings())
    postgres = open_store(Settings(database_url=UNREACHABLE, db_schema="cqa_demo"))
    try:
        assert isinstance(sqlite, SqliteStore)
        assert isinstance(postgres, PostgresStore)  # соединения при создании ещё нет
        assert postgres.schema == "cqa_demo"
    finally:
        sqlite.close()
        postgres.close()


def test_unreachable_postgres_gives_storage_error_without_password(
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = unreachable_store()
    try:
        with caplog.at_level("DEBUG"), pytest.raises(StorageError) as caught:
            store.list_checklist_versions()
    finally:
        store.close()

    assert caught.value.status_code == 503
    assert caught.value.detail and "чтение версий чек-листов" in caught.value.detail
    assert CANARY not in caught.value.detail
    assert CANARY not in caplog.text


def test_app_starts_and_answers_while_postgres_is_down(upstream_payload: dict[str, Any]) -> None:
    transport = httpx.MockTransport(RecordingUpstream(upstream_payload))
    settings = Settings(serve_static=False, checklist_path=CHECKLIST_FIXTURE)
    app = create_app(
        settings, transport=transport, store=unreachable_store(), evaluator=FakeEvaluator()
    )

    with TestClient(app) as client:
        health = client.get("/api/health")
        listing = client.get("/api/datasets/DEV/conversations")
        checklists = client.get("/api/checklists")

    assert health.json() == {"ok": True}
    assert listing.status_code == 200  # список диалогов есть, просто без оценок
    assert all(item["evaluation"] is None for item in listing.json()["items"])
    assert checklists.status_code == 503
    assert checklists.json()["error"]["code"] == "storage_unavailable"
    assert CANARY not in checklists.text


def test_invalid_connection_string_fails_fast_without_echoing_it() -> None:
    with pytest.raises(ValueError) as caught:
        PostgresStore(f"postgresql://cqa:{CANARY}@host/db?no_such_option=1")

    assert CANARY not in str(caught.value)
    assert caught.value.__cause__ is None and caught.value.__suppress_context__


def test_scrub_credentials_hides_passwords_in_urls_and_key_value_strings() -> None:
    text = (
        f"failed: postgresql://cqa:{CANARY}@ep-x.neon.tech/db?sslmode=require; "
        f"dsn host=h password='{CANARY} x' user=u; postgres://u:{CANARY}@h password={CANARY}"
    )

    cleaned = scrub_credentials(text)

    assert CANARY not in cleaned
    assert "postgresql://cqa:***@ep-x.neon.tech/db" in cleaned
    assert "password=***" in cleaned
