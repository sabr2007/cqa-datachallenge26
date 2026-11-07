from dataclasses import replace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.store import StorageError
from tests.api.fakes import FakeEvaluator
from tests.api.helpers import CHAT, GROUP, OTHER_CHAT, checklist_doc, evaluate, file_appeal

LIST_URL = f"/api/datasets/{GROUP}/conversations"


def summaries(client: TestClient) -> dict[str, Any]:
    items = client.get(LIST_URL).json()["items"]
    return {item["conversation_id"]: item["evaluation"] for item in items}


def test_listing_has_null_evaluation_before_any_run(api: TestClient) -> None:
    assert summaries(api) == {CHAT: None, OTHER_CHAT: None, "test-call-001": None}


def test_listing_shows_latest_regular_evaluation_summary(
    api: TestClient, engine: FakeEvaluator
) -> None:
    evaluate(api)
    engine.answers[CHAT] = {"c05": "no", "c08": "yes"}
    latest = evaluate(api)
    file_appeal(api, latest["id"], "c04")

    summary = summaries(api)[CHAT]

    assert summary == {
        "evaluation_id": latest["id"],
        "total": 85.0,
        "final_total": 85.0,
        "critical": True,
        "critical_note": "Фейковое обоснование c08",
        "needs_review": False,
        "appeal_status": "open",
        "checklist_version": 1,
        "answers": {
            "c01": "yes",
            "c02": "yes",
            "c03": "yes",
            "c04": 20,
            "c05": "no",
            "c06": 10,
            "c07": "yes",
            "c08": "yes",
        },
    }
    assert summaries(api)[OTHER_CHAT] is None


def test_sandbox_and_failed_runs_do_not_replace_listing_summary(
    api: TestClient, engine: FakeEvaluator
) -> None:
    regular = evaluate(api)
    sandbox_version = api.post(
        "/api/checklists/chat-quality/versions", json={**checklist_doc(), "sandbox": True}
    ).json()["version"]
    evaluate(api, checklist_version=sandbox_version)
    engine.failure = RuntimeError("boom")
    api.post("/api/evaluations", json={"group_id": GROUP, "conversation_id": CHAT})

    assert summaries(api)[CHAT]["evaluation_id"] == regular["id"]


class _BrokenLatest:
    """Хранилище, у которого не читаются последние оценки (остальное — как у настоящего)."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def latest_evaluations(self, **_: Any) -> list[Any]:
        raise StorageError(detail="database is locked")

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def test_listing_survives_storage_failure(
    api: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    evaluate(api)
    services = api.app.state.services
    broken = replace(services, store=_BrokenLatest(services.store))
    monkeypatch.setattr(api.app.state, "services", broken)

    with caplog.at_level("WARNING", logger="cqa.evaluations"):
        response = api.get(LIST_URL)

    assert response.status_code == 200
    assert {item["evaluation"] for item in response.json()["items"]} == {None}
    assert "database is locked" in caplog.text
