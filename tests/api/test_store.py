import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

import pytest

from app.api.checklists import SEED_NOTE_INITIAL, SEED_NOTE_UPDATE, sync_default_checklist
from app.config import MEMORY_DB
from app.store import (
    AppealNotOpenError,
    DuplicateAppealError,
    RevisionConflictError,
    SqliteStore,
)
from tests.api.helpers import checklist_doc


def write_checklist(path: Path, **changes: Any) -> Path:
    path.write_text(json.dumps({**checklist_doc(), **changes}, ensure_ascii=False), "utf-8")
    return path


def evaluation(evaluation_id: str = "ev_1", **changes: Any) -> dict[str, Any]:
    return {
        "id": evaluation_id,
        "group_id": "DEV",
        "conversation_id": "p1-ru-001",
        "created_at": "2026-11-07T10:00:00Z",
        "checklist_id": "chat-quality",
        "checklist_version": 1,
        "purpose": "regular",
        "criteria": [{"criterion_id": "c05", "answer": "yes", "appeal": None}],
        "status": "done",
        **changes,
    }


def appeal(appeal_id: str = "ap_1", **changes: Any) -> dict[str, Any]:
    return {
        "id": appeal_id,
        "evaluation_id": "ev_1",
        "group_id": "DEV",
        "conversation_id": "p1-ru-001",
        "criterion_id": "c05",
        "comment": "Не согласен",
        "created_at": "2026-11-07T10:05:00Z",
        "status": "open",
        "original_answer": "yes",
        "decision": None,
        **changes,
    }


@pytest.fixture
def store() -> SqliteStore:
    return SqliteStore(MEMORY_DB)


def test_seed_creates_first_version_and_skips_unchanged_file(
    store: SqliteStore, tmp_path: Path
) -> None:
    path = write_checklist(tmp_path / "chat.json")

    first = sync_default_checklist(store, path)
    second = sync_default_checklist(store, path)

    assert first is not None and first.version == 1 and first.note == SEED_NOTE_INITIAL
    assert second is None
    assert [v.version for v in store.list_checklist_versions()] == [1]


def test_changed_seed_file_adds_version_with_update_note(
    store: SqliteStore, tmp_path: Path
) -> None:
    path = write_checklist(tmp_path / "chat.json")
    sync_default_checklist(store, path)
    criteria = [
        {**c, "guidance": "Указание"} if c["id"] == "c01" else c
        for c in checklist_doc()["criteria"]
    ]
    write_checklist(path, criteria=criteria, version=1)

    created = sync_default_checklist(store, path)

    assert created is not None
    assert created.version == 2
    assert created.note == SEED_NOTE_UPDATE
    assert store.get_checklist_version("chat-quality").doc["criteria"][0]["guidance"] == "Указание"


def test_seed_file_does_not_override_version_saved_from_ui(
    store: SqliteStore, tmp_path: Path
) -> None:
    path = write_checklist(tmp_path / "chat.json")
    sync_default_checklist(store, path)
    store.add_checklist_version(
        "chat-quality", checklist_doc(), note="из интерфейса", sandbox=False
    )
    write_checklist(path, title="Новое название")

    assert sync_default_checklist(store, path) is None
    assert store.get_checklist_version("chat-quality").note == "из интерфейса"


def test_whitespace_only_change_of_seed_file_is_ignored(store: SqliteStore, tmp_path: Path) -> None:
    path = write_checklist(tmp_path / "chat.json")
    sync_default_checklist(store, path)
    path.write_text(json.dumps(checklist_doc(), ensure_ascii=False, indent=4), "utf-8")

    assert sync_default_checklist(store, path) is None


def test_invalid_seed_file_is_logged_and_skipped(
    store: SqliteStore, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = write_checklist(tmp_path / "chat.json", criteria=[])

    with caplog.at_level("ERROR", logger="cqa.checklists"):
        assert sync_default_checklist(store, path) is None

    assert "не прошёл проверку" in caplog.text
    assert store.list_checklist_versions() == []


def test_checklist_versions_are_immutable_in_database(store: SqliteStore) -> None:
    store.add_checklist_version("chat-quality", checklist_doc(), note=None, sandbox=False)

    with pytest.raises(sqlite3.DatabaseError, match="immutable"):
        store._conn.execute("UPDATE checklist_versions SET note = 'x'")
    with pytest.raises(sqlite3.DatabaseError, match="immutable"):
        store._conn.execute("DELETE FROM checklist_versions")


def test_parallel_version_saves_get_unique_numbers(tmp_path: Path) -> None:
    path = str(tmp_path / "db" / "cqa.sqlite")
    stores = [SqliteStore(path) for _ in range(2)]  # как два процесса с одним файлом
    errors: list[BaseException] = []

    def save(target: SqliteStore) -> None:
        try:
            for _ in range(10):
                target.add_checklist_version(
                    "chat-quality", checklist_doc(), note=None, sandbox=False
                )
        except BaseException as exc:  # собираем для проверки ниже
            errors.append(exc)

    threads = [threading.Thread(target=save, args=(target,)) for target in stores for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    versions = [v.version for v in stores[0].list_checklist_versions()]
    assert versions == list(range(1, 41))


def test_file_database_survives_reopen(tmp_path: Path) -> None:
    path = str(tmp_path / "cqa.sqlite")
    first = SqliteStore(path)
    first.add_evaluation(evaluation(), transcript=[], language="RU", channel="chat")
    first.close()

    reopened = SqliteStore(path)

    stored = reopened.get_evaluation("ev_1")
    assert stored is not None and stored.revision == 1 and stored.language == "RU"


def test_appeal_and_evaluation_change_together_with_revision_check(store: SqliteStore) -> None:
    store.add_evaluation(evaluation(), transcript=[], language="RU", channel="chat")
    updated = evaluation(
        criteria=[{"criterion_id": "c05", "answer": "yes", "appeal": {"id": "ap_1"}}]
    )

    store.add_appeal(appeal(), updated, expected_revision=1)

    with pytest.raises(DuplicateAppealError):
        store.add_appeal(appeal("ap_2"), updated, expected_revision=2)
    with pytest.raises(RevisionConflictError):
        store.resolve_appeal(appeal(status="resolved"), updated, expected_revision=1)
    assert store.get_appeal("ap_1")["status"] == "open"  # откат вместе с оценкой
    store.resolve_appeal(
        appeal(status="resolved", decision={"decided_at": "x"}), updated, expected_revision=2
    )
    with pytest.raises(AppealNotOpenError):
        store.resolve_appeal(appeal(status="resolved"), updated, expected_revision=3)
    assert store.get_evaluation("ev_1").revision == 3


def test_latest_evaluations_take_last_done_per_conversation(store: SqliteStore) -> None:
    store.add_evaluation(evaluation("ev_1"), transcript=[], language="RU", channel="chat")
    store.add_evaluation(evaluation("ev_2"), transcript=[], language="RU", channel="chat")
    store.add_evaluation(
        evaluation("ev_3", status="error"), transcript=[], language="RU", channel="chat"
    )
    store.add_evaluation(
        evaluation("ev_4", purpose="sandbox"), transcript=[], language="RU", channel="chat"
    )
    store.add_evaluation(
        evaluation("ev_5", conversation_id="p1-kz-001"),
        transcript=[],
        language="KZ",
        channel="chat",
    )

    regular = [s.evaluation_id for s in store.latest_evaluations(group_id="DEV")]
    any_purpose = [s.evaluation_id for s in store.latest_evaluations(group_id="DEV", purpose=None)]

    assert regular == ["ev_5", "ev_2"]
    assert any_purpose == ["ev_5", "ev_4"]
