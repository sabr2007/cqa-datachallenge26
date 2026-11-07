"""Контракт Store: одинаковое поведение на SQLite и Postgres (фикстуры — tests/store/conftest).

Каждый тест выполняется для обеих реализаций; Postgres — только с CQA_TEST_DATABASE_URL.
"""

import json
import threading
from pathlib import Path
from typing import Any

import pytest

from app.api.checklists import SEED_NOTE_INITIAL, SEED_NOTE_UPDATE, sync_default_checklist
from app.store import (
    AppealNotOpenError,
    DuplicateAppealError,
    RevisionConflictError,
    StorageError,
    Store,
)
from tests.api.helpers import checklist_doc
from tests.store.conftest import Backend

CREATED = "2026-11-07T10:00:00Z"


def write_checklist(path: Path, **changes: Any) -> Path:
    path.write_text(json.dumps({**checklist_doc(), **changes}, ensure_ascii=False), "utf-8")
    return path


def evaluation(evaluation_id: str = "ev_1", **changes: Any) -> dict[str, Any]:
    return {
        "id": evaluation_id,
        "group_id": "DEV",
        "conversation_id": "p1-ru-001",
        "created_at": CREATED,
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


def add_evaluations(store: Store, *docs: dict[str, Any]) -> None:
    for doc in docs:
        store.add_evaluation(doc, transcript=[], language="RU", channel="chat")


def file_appeal(store: Store, appeal_id: str, evaluation_id: str, criterion_id: str) -> dict:
    stored = store.get_evaluation(evaluation_id)
    assert stored is not None
    doc = appeal(
        appeal_id,
        evaluation_id=evaluation_id,
        criterion_id=criterion_id,
        group_id=stored.doc["group_id"],
        conversation_id=stored.doc["conversation_id"],
    )
    store.add_appeal(doc, stored.doc, expected_revision=stored.revision)
    return doc


def resolve(store: Store, filed: dict[str, Any], decided_at: str) -> None:
    stored = store.get_evaluation(filed["evaluation_id"])
    assert stored is not None
    decided = {**filed, "status": "resolved", "decision": {"decided_at": decided_at}}
    store.resolve_appeal(decided, stored.doc, expected_revision=stored.revision)


def ids(items: list[Any]) -> list[str]:
    return [item["id"] if isinstance(item, dict) else item.evaluation_id for item in items]


# --- версии чек-листа и сид из config ---


def test_seed_creates_first_version_and_skips_unchanged_file(store: Store, tmp_path: Path) -> None:
    path = write_checklist(tmp_path / "chat.json")

    first = sync_default_checklist(store, path)
    second = sync_default_checklist(store, path)

    assert first is not None and first.version == 1 and first.note == SEED_NOTE_INITIAL
    assert first.source == "file"
    assert second is None
    assert [v.version for v in store.list_checklist_versions()] == [1]


def test_changed_seed_file_adds_version_with_update_note(store: Store, tmp_path: Path) -> None:
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
    latest = store.get_checklist_version("chat-quality")
    assert latest is not None and latest.doc["criteria"][0]["guidance"] == "Указание"


def test_seed_file_does_not_override_version_saved_from_ui(store: Store, tmp_path: Path) -> None:
    path = write_checklist(tmp_path / "chat.json")
    sync_default_checklist(store, path)
    store.add_checklist_version(
        "chat-quality", checklist_doc(), note="из интерфейса", sandbox=False
    )
    write_checklist(path, title="Новое название")

    assert sync_default_checklist(store, path) is None
    latest = store.get_checklist_version("chat-quality")
    assert latest is not None and latest.note == "из интерфейса"


def test_whitespace_only_change_of_seed_file_is_ignored(store: Store, tmp_path: Path) -> None:
    path = write_checklist(tmp_path / "chat.json")
    sync_default_checklist(store, path)
    path.write_text(json.dumps(checklist_doc(), ensure_ascii=False, indent=4), "utf-8")

    assert sync_default_checklist(store, path) is None


def test_invalid_seed_file_is_logged_and_skipped(
    store: Store, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = write_checklist(tmp_path / "chat.json", criteria=[])

    with caplog.at_level("ERROR", logger="cqa.checklists"):
        assert sync_default_checklist(store, path) is None

    assert "не прошёл проверку" in caplog.text
    assert store.list_checklist_versions() == []


def test_versions_are_numbered_per_checklist_and_sandbox_never_becomes_latest(
    backend: Backend,
) -> None:
    store = backend.open_store(clock=lambda: CREATED)
    doc = {**checklist_doc(), "version": 7}

    first = store.add_checklist_version("chat-quality", doc, note="первая", sandbox=False)
    sandbox = store.add_checklist_version("chat-quality", doc, note=None, sandbox=True)
    other = store.add_checklist_version(
        "Zeta", {**doc, "title": "Другой"}, note=None, sandbox=False
    )

    assert (first.version, sandbox.version, other.version) == (1, 2, 1)
    assert (first.doc["id"], first.doc["version"], first.created_at) == ("chat-quality", 1, CREATED)
    assert other.title == "Другой"
    assert store.get_checklist_version("chat-quality") == first  # песочница не последняя
    assert store.get_checklist_version("chat-quality", 2) == sandbox
    assert store.get_checklist_version("chat-quality", 3) is None
    assert store.get_checklist_version("missing") is None
    listed = [(v.checklist_id, v.version, v.sandbox) for v in store.list_checklist_versions()]
    # id сортируются побайтово, как в SQLite: прописные раньше строчных
    assert listed == [("Zeta", 1, False), ("chat-quality", 1, False), ("chat-quality", 2, True)]


def test_checklist_versions_are_immutable_in_database(backend: Backend, store: Store) -> None:
    store.add_checklist_version("chat-quality", checklist_doc(), note=None, sandbox=False)

    with pytest.raises(backend.database_error, match="immutable"):
        backend.execute("UPDATE {checklist_versions} SET note = 'x'")
    with pytest.raises(backend.database_error, match="immutable"):
        backend.execute("DELETE FROM {checklist_versions}")

    assert [v.note for v in store.list_checklist_versions()] == [None]


def test_parallel_version_saves_get_unique_numbers(backend: Backend) -> None:
    stores = [backend.open_store() for _ in range(2)]  # как два процесса с одной базой
    per_thread = 10 if backend.name == "sqlite" else 3  # Postgres в тестах — по сети
    errors: list[BaseException] = []

    def save(target: Store) -> None:
        try:
            for _ in range(per_thread):
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
    assert versions == list(range(1, 4 * per_thread + 1))


# --- оценки ---


def test_data_survives_reopen(backend: Backend) -> None:
    first = backend.open_store()
    transcript = [{"index": 0, "speaker": "client", "text": "Сәлеметсіз бе!"}]
    first.add_evaluation(evaluation(), transcript=transcript, language="KZ", channel="chat")
    first.close()

    stored = backend.open_store().get_evaluation("ev_1")

    assert stored is not None
    assert (stored.revision, stored.language, stored.channel) == (1, "KZ", "chat")
    assert stored.transcript == tuple(transcript)


def test_documents_round_trip_exactly(store: Store) -> None:
    doc = evaluation(
        criteria=[
            {"criterion_id": "c05", "answer": "yes", "points": 12.5, "appeal": None},
            {"criterion_id": "c04", "answer": 15, "points": 0.0, "evidence": []},
        ],
        total=87.25,
        big=2**53 + 1,
        flags={"z": True, "a": None},
        text='Ответ «да» — ✓, қазақша: әғқңөұүһі, "кавычки", \\ слэш\nстрока\t\x01\x00',
    )
    transcript = [{"index": 3, "text": "Тест 🙂", "ts": "00:05"}]

    returned = store.add_evaluation(doc, transcript=transcript, language="RU", channel="chat")
    stored = store.get_evaluation("ev_1")

    assert stored is not None
    assert returned.doc == stored.doc == doc
    # тот же порядок ключей и те же числа — ответы API не меняются от базы
    assert json.dumps(stored.doc, ensure_ascii=False) == json.dumps(doc, ensure_ascii=False)
    assert stored.transcript == tuple(transcript)
    assert store.get_evaluation("missing") is None


def test_list_evaluations_filters_order_and_limit(store: Store) -> None:
    add_evaluations(
        store,
        evaluation("ev_1", conversation_id="c1"),
        evaluation("ev_2", conversation_id="c2", purpose="sandbox"),
        evaluation("ev_3", conversation_id="c1", group_id="PROD"),
        evaluation("ev_4", conversation_id="c1", status="error"),
    )

    everything = store.list_evaluations()

    assert ids(everything) == ["ev_4", "ev_3", "ev_2", "ev_1"]  # новые первыми
    assert all(s.transcript is None and s.revision == 1 for s in everything)
    assert ids(store.list_evaluations(group_id="DEV")) == ["ev_4", "ev_2", "ev_1"]
    assert ids(store.list_evaluations(conversation_id="c1")) == ["ev_4", "ev_3", "ev_1"]
    assert ids(store.list_evaluations(purpose="sandbox")) == ["ev_2"]
    assert ids(store.list_evaluations(group_id="DEV", conversation_id="c1", purpose="regular")) == [
        "ev_4",
        "ev_1",
    ]
    assert ids(store.list_evaluations(limit=2)) == ["ev_4", "ev_3"]


def test_latest_evaluations_take_last_done_per_conversation(store: Store) -> None:
    add_evaluations(
        store,
        evaluation("ev_1"),
        evaluation("ev_2"),
        evaluation("ev_3", status="error"),
        evaluation("ev_4", purpose="sandbox"),
        evaluation("ev_5", conversation_id="p1-kz-001"),
    )

    regular = ids(store.latest_evaluations(group_id="DEV"))
    any_purpose = ids(store.latest_evaluations(group_id="DEV", purpose=None))

    assert regular == ["ev_5", "ev_2"]
    assert any_purpose == ["ev_5", "ev_4"]


def test_latest_evaluations_filter_by_checklist_and_sort_bytewise(store: Store) -> None:
    add_evaluations(
        store,
        evaluation("ev_1", conversation_id="b-002", checklist_version=1),
        evaluation("ev_2", conversation_id="B-001", checklist_version=2),
        evaluation("ev_3", conversation_id="b-002", checklist_version=2),
        evaluation("ev_4", conversation_id="a-003", checklist_version=2, status="error"),
        evaluation("ev_5", conversation_id="a-003", group_id="PROD"),
    )

    assert ids(store.latest_evaluations()) == ["ev_2", "ev_3", "ev_5"]  # DEV, затем PROD
    assert ids(store.latest_evaluations(group_id="DEV")) == ["ev_2", "ev_3"]
    assert ids(store.latest_evaluations(group_id="DEV", checklist_version=1)) == ["ev_1"]
    assert ids(store.latest_evaluations(checklist_id="other")) == []
    assert ids(store.latest_evaluations(group_id="TEST")) == []


# --- апелляции ---


def test_appeal_and_evaluation_change_together_with_revision_check(store: Store) -> None:
    store.add_evaluation(evaluation(), transcript=[], language="RU", channel="chat")
    updated = evaluation(
        criteria=[{"criterion_id": "c05", "answer": "yes", "appeal": {"id": "ap_1"}}]
    )

    store.add_appeal(appeal(), updated, expected_revision=1)

    with pytest.raises(DuplicateAppealError):
        store.add_appeal(appeal("ap_2"), updated, expected_revision=2)
    with pytest.raises(RevisionConflictError):
        store.resolve_appeal(appeal(status="resolved"), updated, expected_revision=1)
    stored_appeal = store.get_appeal("ap_1")
    assert stored_appeal is not None and stored_appeal["status"] == "open"  # откат с оценкой
    store.resolve_appeal(
        appeal(status="resolved", decision={"decided_at": "x"}), updated, expected_revision=2
    )
    with pytest.raises(AppealNotOpenError):
        store.resolve_appeal(appeal(status="resolved"), updated, expected_revision=3)
    stored = store.get_evaluation("ev_1")
    assert stored is not None and stored.revision == 3 and stored.doc == updated


def test_appeal_queue_order_and_filters(store: Store) -> None:
    add_evaluations(
        store,
        evaluation("ev_1", conversation_id="c1"),
        evaluation("ev_2", conversation_id="c2"),
        evaluation("ev_3", conversation_id="c3", purpose="sandbox"),
        evaluation("ev_4", conversation_id="c1", group_id="PROD"),
    )
    filed = {
        appeal_id: file_appeal(store, appeal_id, evaluation_id, criterion_id)
        for appeal_id, evaluation_id, criterion_id in (
            ("ap_1", "ev_1", "c05"),
            ("ap_2", "ev_2", "c05"),
            ("ap_3", "ev_1", "c06"),
            ("ap_4", "ev_2", "c06"),
            ("ap_5", "ev_3", "c05"),
            ("ap_6", "ev_4", "c05"),
            ("ap_7", "ev_4", "c06"),
        )
    }
    resolve(store, filed["ap_3"], "2026-11-07T12:00:00Z")
    resolve(store, filed["ap_4"], "2026-11-07T13:00:00Z")
    resolve(store, filed["ap_7"], "2026-11-07T13:00:00Z")

    # Очередь: открытые — старые первыми, затем рассмотренные — свежие решения первыми.
    assert ids(store.list_appeals()) == ["ap_1", "ap_2", "ap_5", "ap_6", "ap_7", "ap_4", "ap_3"]
    assert ids(store.list_appeals(status="open")) == ["ap_1", "ap_2", "ap_5", "ap_6"]
    assert ids(store.list_appeals(status="resolved")) == ["ap_7", "ap_4", "ap_3"]
    assert ids(store.list_appeals(group_id="PROD")) == ["ap_6", "ap_7"]
    assert ids(store.list_appeals(evaluation_ids=["ev_1"])) == ["ap_1", "ap_3"]
    assert ids(store.list_appeals(evaluation_ids=["ev_2", "ev_4"])) == [
        "ap_2",
        "ap_6",
        "ap_7",
        "ap_4",
    ]
    assert ids(store.list_appeals(evaluation_ids=[])) == []
    assert ids(store.list_appeals(conversation_id="c1")) == ["ap_1", "ap_6", "ap_7", "ap_3"]
    assert ids(store.list_appeals(purpose="sandbox")) == ["ap_5"]
    assert ids(store.list_appeals(purpose="regular")) == [
        "ap_1",
        "ap_2",
        "ap_6",
        "ap_7",
        "ap_4",
        "ap_3",
    ]
    assert ids(store.list_appeals(group_id="DEV", status="open", purpose="regular")) == [
        "ap_1",
        "ap_2",
    ]
    decided = store.get_appeal("ap_4")
    assert decided is not None and decided["decision"] == {"decided_at": "2026-11-07T13:00:00Z"}
    assert store.get_appeal("missing") is None


def test_missing_rows_and_duplicates(store: Store) -> None:
    add_evaluations(store, evaluation())

    with pytest.raises(RevisionConflictError):  # оценки нет — менять нечего
        store.add_appeal(appeal(evaluation_id="ev_x"), evaluation("ev_x"), expected_revision=1)
    with pytest.raises(AppealNotOpenError):
        store.resolve_appeal(appeal("ap_x", status="resolved"), evaluation(), expected_revision=1)
    with pytest.raises(StorageError):  # повтор id — ошибка базы, а не тихая перезапись
        add_evaluations(store, evaluation())

    assert ids(store.list_evaluations()) == ["ev_1"]
    assert store.list_appeals() == []
