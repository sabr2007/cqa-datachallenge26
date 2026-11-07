"""scripts/migrate_sqlite_to_postgres.py: снимок SQLite только на чтение, перенос в Postgres
с сохранением id, дат, ревизий и порядка, идемпотентность, конфликты.

Перенос в Postgres проверяется с CQA_TEST_DATABASE_URL (каждый тест — своя схема cqa_test_*).
"""

import hashlib
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from app.api.checklists import sync_default_checklist
from app.store import PostgresStore, SqliteStore, Store
from scripts.migrate_sqlite_to_postgres import (
    Snapshot,
    TransferError,
    copy_snapshot,
    database_url,
    read_snapshot,
)
from tests.api.helpers import checklist_doc
from tests.store.conftest import (
    TEST_DATABASE_URL_ENV,
    configured_database_url,
    drop_schema,
    new_test_schema,
)
from tests.store.test_contract import appeal, evaluation, file_appeal, resolve


def seed_file(tmp_path: Path) -> Path:
    path = tmp_path / "chat.json"
    path.write_text(json.dumps(checklist_doc(), ensure_ascii=False), "utf-8")
    return path


def build_source(tmp_path: Path) -> Path:
    """SQLite как после работы приложения: сид, песочница, оценки, апелляции, ревизии."""
    path = tmp_path / "source.sqlite"
    store = SqliteStore(str(path))
    try:
        sync_default_checklist(store, seed_file(tmp_path))
        store.add_checklist_version("chat-quality", checklist_doc(), note="тест", sandbox=True)
        transcript = [{"index": 0, "speaker": "operator", "text": "Здравствуйте! Чем помочь?"}]
        for doc in (
            evaluation("ev_1", conversation_id="c1"),
            evaluation("ev_2", conversation_id="c2", created_at="2026-11-07T11:00:00Z"),
            evaluation("ev_3", conversation_id="c1", status="error", criteria=[]),
            evaluation("ev_4", conversation_id="c2", purpose="sandbox", checklist_version=2),
        ):
            store.add_evaluation(doc, transcript=transcript, language="RU", channel="chat")
        file_appeal(store, "ap_1", "ev_1", "c05")
        resolve(store, file_appeal(store, "ap_2", "ev_2", "c05"), "2026-11-07T12:30:00Z")
    finally:
        store.close()
    return path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def store_view(store: Store) -> dict[str, Any]:
    """Всё, что видит API, через интерфейс Store."""
    evaluations = store.list_evaluations(limit=1000)
    return {
        "versions": store.list_checklist_versions(),
        "latest_version": store.get_checklist_version("chat-quality"),
        "evaluations": evaluations,
        "full": [store.get_evaluation(item.evaluation_id) for item in evaluations],
        "latest": store.latest_evaluations(group_id="DEV"),
        "latest_any": store.latest_evaluations(purpose=None),
        "appeals": store.list_appeals(),
        "open": store.list_appeals(status="open", purpose="regular"),
    }


@pytest.fixture
def postgres() -> Iterator[PostgresStore]:
    url = configured_database_url()
    if url is None:
        pytest.skip(f"{TEST_DATABASE_URL_ENV} не задан — перенос в Postgres не проверяется")
    schema = new_test_schema()
    store = PostgresStore(url, schema=schema)
    try:
        yield store
    finally:
        store.close()
        drop_schema(url, schema)


def test_snapshot_reads_everything_without_touching_the_file(tmp_path: Path) -> None:
    source = build_source(tmp_path)
    before = digest(source)

    snapshot = read_snapshot(source)

    assert digest(source) == before  # файл базы не изменился
    assert [(v["version"], v["source"]) for v in snapshot.checklist_versions] == [
        (1, "file"),
        (2, "api"),
    ]
    assert [row["id"] for row in snapshot.evaluations] == ["ev_1", "ev_2", "ev_3", "ev_4"]
    assert [(row["id"], row["status"]) for row in snapshot.appeals] == [
        ("ap_1", "open"),
        ("ap_2", "resolved"),
    ]


def test_missing_sqlite_file_is_an_error_and_is_not_created(tmp_path: Path) -> None:
    missing = tmp_path / "absent.sqlite"

    with pytest.raises(TransferError):
        read_snapshot(missing)

    assert not missing.exists()


def test_direct_postgres_address_is_preferred_and_required() -> None:
    env = {"POSTGRES_URL": "postgresql://b", "DATABASE_URL_UNPOOLED": "postgresql://a"}

    assert database_url(env) == ("DATABASE_URL_UNPOOLED", "postgresql://a")
    assert database_url({"DATABASE_URL": "postgresql://c"}) == ("DATABASE_URL", "postgresql://c")
    with pytest.raises(TransferError):
        database_url({"DATABASE_URL": " "})


def test_transfer_preserves_everything_and_is_idempotent(
    tmp_path: Path, postgres: PostgresStore
) -> None:
    source = build_source(tmp_path)
    snapshot = read_snapshot(source)

    dry = copy_snapshot(snapshot, postgres, dry_run=True)
    assert dry.evaluations.copied == 4 and postgres.list_evaluations() == []  # откат
    first = copy_snapshot(snapshot, postgres)
    again = copy_snapshot(read_snapshot(source), postgres)

    assert (first.checklist_versions.copied, first.evaluations.copied, first.appeals.copied) == (
        2,
        4,
        2,
    )
    assert (again.checklist_versions.present, again.evaluations.present, again.appeals.present) == (
        2,
        4,
        2,
    )
    assert again.evaluations.copied == again.appeals.copied == 0
    sqlite = SqliteStore(str(source))
    try:
        assert store_view(postgres) == store_view(sqlite)
    finally:
        sqlite.close()
    # источник и хэш версии сохранены: тот же файл config не создаёт новую версию
    assert sync_default_checklist(postgres, seed_file(tmp_path)) is None


def test_rows_changed_in_postgres_after_transfer_are_kept(
    tmp_path: Path, postgres: PostgresStore
) -> None:
    source = build_source(tmp_path)
    copy_snapshot(read_snapshot(source), postgres)
    file_appeal(postgres, "ap_new", "ev_1", "c06")  # жюри подало апелляцию уже в облаке

    report = copy_snapshot(read_snapshot(source), postgres)

    assert report.evaluations.changed == ["ev_1"]
    stored = postgres.get_evaluation("ev_1")
    assert stored is not None and stored.revision == 3  # не откатилась к версии из SQLite
    assert {item["id"] for item in postgres.list_appeals()} == {"ap_1", "ap_2", "ap_new"}


def test_conflicting_checklist_version_cancels_the_whole_transfer(
    tmp_path: Path, postgres: PostgresStore
) -> None:
    source = build_source(tmp_path)
    postgres.add_checklist_version(
        "chat-quality", {**checklist_doc(), "title": "Другой чек-лист"}, note=None, sandbox=False
    )

    with pytest.raises(TransferError, match="v1"):
        copy_snapshot(read_snapshot(source), postgres)

    assert [v.title for v in postgres.list_checklist_versions()] == ["Другой чек-лист"]
    assert postgres.list_evaluations() == [] and postgres.list_appeals() == []


def test_appeal_on_same_criterion_under_other_id_is_a_conflict(
    tmp_path: Path, postgres: PostgresStore
) -> None:
    source = build_source(tmp_path)
    snapshot = read_snapshot(source)
    copy_snapshot(snapshot, postgres)
    duplicate = {**snapshot.appeals[0], "id": "ap_other", "doc": json.dumps(appeal("ap_other"))}

    with pytest.raises(TransferError, match="ap_other"):
        copy_snapshot(
            Snapshot(snapshot.checklist_versions, snapshot.evaluations, (duplicate,)),
            postgres,
        )
