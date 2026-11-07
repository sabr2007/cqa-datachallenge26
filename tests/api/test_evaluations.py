from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.api.conftest import ApiFactory
from tests.api.fakes import FakeEvaluator
from tests.api.helpers import (
    CHAT,
    GROUP,
    OTHER_CHAT,
    assert_error,
    checklist_doc,
    evaluate,
    result,
    section,
)


def test_evaluation_is_saved_with_storage_fields(api: TestClient, engine: FakeEvaluator) -> None:
    engine.answers[CHAT] = {"c02": "na", "c04": 15}

    evaluation = evaluate(api)

    assert evaluation["id"].startswith("ev_")
    assert evaluation["created_at"].endswith("Z")
    assert (evaluation["group_id"], evaluation["conversation_id"]) == (GROUP, CHAT)
    assert (evaluation["checklist_id"], evaluation["checklist_version"]) == ("chat-quality", 1)
    assert evaluation["purpose"] == "regular"
    assert evaluation["status"] == "done" and evaluation["error"] is None
    # Evaluation движка сохраняется целиком, включая служебные поля для reuse.
    assert result(evaluation, "c01")["definition_hash"] == "fake-c01"
    assert evaluation["engine"] == {"prompt_version": "fake"}
    c04 = result(evaluation, "c04")
    assert (c04["final_answer"], c04["final_points"], c04["final_max_points"]) == (
        15,
        c04["points"],
        c04["max_points"],
    )
    assert c04["appeal"] is None
    assert (
        section(evaluation, "start")["final_max_points"]
        == section(evaluation, "start")["max_points"]
    )
    assert evaluation["final_total"] == evaluation["total"]
    assert engine.calls[0]["checklist"]["version"] == 1
    assert api.get(f"/api/evaluations/{evaluation['id']}").json() == evaluation


def test_history_is_newest_first_and_filtered(api: TestClient) -> None:
    first = evaluate(api)
    other = evaluate(api, OTHER_CHAT)
    second = evaluate(api)

    everything = api.get("/api/evaluations").json()["items"]
    chat = api.get(f"/api/evaluations?group_id={GROUP}&conversation_id={CHAT}").json()["items"]

    assert [e["id"] for e in everything] == [second["id"], other["id"], first["id"]]
    assert [e["id"] for e in chat] == [second["id"], first["id"]]


@pytest.mark.parametrize(
    ("body", "status_code", "code"),
    [
        ([], 400, "invalid_body"),
        ({"conversation_id": CHAT}, 400, "invalid_group_id"),
        ({"group_id": GROUP, "conversation_id": "bad id"}, 400, "invalid_conversation_id"),
        ({"group_id": GROUP, "conversation_id": "p9-xx-999"}, 404, "conversation_not_found"),
        (
            {"group_id": GROUP, "conversation_id": CHAT, "checklist_version": 5},
            404,
            "checklist_version_not_found",
        ),
        (
            {"group_id": GROUP, "conversation_id": CHAT, "checklist_version": "1"},
            400,
            "invalid_checklist_version",
        ),
        ({"group_id": GROUP, "conversation_id": CHAT, "models": "fake"}, 400, "invalid_models"),
        (
            {"group_id": GROUP, "conversation_id": CHAT, "models": ["fake-offline"]},
            400,
            "model_unavailable",
        ),
        ({"group_id": GROUP, "conversation_id": CHAT, "purpose": "demo"}, 400, "invalid_purpose"),
        (
            {"group_id": GROUP, "conversation_id": CHAT, "reuse_previous": "yes"},
            400,
            "invalid_reuse_previous",
        ),
    ],
)
def test_invalid_evaluation_requests(
    api: TestClient, engine: FakeEvaluator, body: Any, status_code: int, code: str
) -> None:
    assert_error(api.post("/api/evaluations", json=body), status_code, code)
    assert engine.calls == []
    assert api.get("/api/evaluations").json() == {"items": []}


def test_requested_models_are_passed_to_engine(api: TestClient, engine: FakeEvaluator) -> None:
    evaluation = evaluate(api, models=["fake-judge", "fake-judge", "@cf/some/model"])

    assert engine.calls[0]["models"] == ["fake-judge", "@cf/some/model"]
    assert evaluation["models"] == ["fake-judge", "@cf/some/model"]


def test_empty_models_mean_engine_defaults(api: TestClient, engine: FakeEvaluator) -> None:
    evaluate(api, models=[])

    assert engine.calls[0]["models"] is None


def test_reuse_previous_passes_last_done_evaluation(api: TestClient, engine: FakeEvaluator) -> None:
    first = evaluate(api)
    evaluate(api, OTHER_CHAT)

    evaluate(api, reuse_previous=True)
    evaluate(api)

    assert engine.calls[2]["reuse"]["id"] == first["id"]
    assert engine.calls[3]["reuse"] is None


def test_reuse_without_history_evaluates_from_scratch(
    api: TestClient, engine: FakeEvaluator
) -> None:
    evaluate(api, reuse_previous=True)

    assert engine.calls[0]["reuse"] is None


def test_engine_crash_is_saved_as_error_and_gives_502(
    api: TestClient, engine: FakeEvaluator, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret-value-123")
    engine.failure = RuntimeError(
        "POST https://api.cloudflare.com/client/v4/accounts/abc123/ai/run failed, "
        "key sk-ant-secret-value-123"
    )

    response = api.post("/api/evaluations", json={"group_id": GROUP, "conversation_id": CHAT})

    assert_error(response, 502, "evaluation_failed")
    assert "sk-ant" not in response.text and "abc123" not in response.text
    saved = api.get("/api/evaluations").json()["items"]
    assert [(e["status"], e["conversation_id"]) for e in saved] == [("error", CHAT)]
    assert saved[0]["error"] == "Движок оценки завершился с ошибкой."
    assert "sk-ant" not in str(saved)


def test_engine_timeout_gives_504_and_saves_error(
    make_api: ApiFactory, engine: FakeEvaluator
) -> None:
    client = make_api(evaluation_timeout_sec=0.05)
    engine.delay_sec = 1.0

    response = client.post("/api/evaluations", json={"group_id": GROUP, "conversation_id": CHAT})

    error = assert_error(response, 504, "evaluation_timeout")
    assert "0.05" in error["message"]
    saved = client.get("/api/evaluations").json()["items"]
    assert saved[0]["status"] == "error"
    assert "0.05" in saved[0]["error"]


def test_engine_error_result_is_saved_and_reported(api: TestClient, engine: FakeEvaluator) -> None:
    engine.result = {
        "models": ["fake-judge"],
        "criteria": [],
        "sections": [],
        "total": None,
        "status": "error",
        "error": "Нет доступных моделей: fake-judge",
    }

    response = api.post("/api/evaluations", json={"group_id": GROUP, "conversation_id": CHAT})

    error = assert_error(response, 502, "evaluation_failed")
    assert error["message"] == "Нет доступных моделей: fake-judge"
    saved = api.get("/api/evaluations").json()["items"][0]
    assert (saved["status"], saved["error"]) == ("error", "Нет доступных моделей: fake-judge")


@pytest.mark.parametrize(
    "result_value",
    [["not", "an", "object"], {"criteria": "nope"}, {"criteria": [{"title": "без id"}]}],
)
def test_malformed_engine_result_gives_502(
    api: TestClient, engine: FakeEvaluator, result_value: Any
) -> None:
    engine.result = result_value

    response = api.post("/api/evaluations", json={"group_id": GROUP, "conversation_id": CHAT})

    assert_error(response, 502, "evaluation_invalid")
    assert api.get("/api/evaluations").json()["items"][0]["status"] == "error"


def test_unavailable_engine_gives_503_and_saves_nothing(
    api: TestClient, engine: FakeEvaluator
) -> None:
    engine.unavailable = True

    response = api.post("/api/evaluations", json={"group_id": GROUP, "conversation_id": CHAT})

    assert_error(response, 503, "engine_unavailable")
    assert api.get("/api/evaluations").json() == {"items": []}


def _sandbox_version(api: TestClient) -> int:
    body = {**checklist_doc(), "sandbox": True, "note": "эксперимент"}
    return api.post("/api/checklists/chat-quality/versions", json=body).json()["version"]


def test_purpose_follows_sandbox_checklist_version(api: TestClient) -> None:
    version = _sandbox_version(api)

    implicit = evaluate(api, checklist_version=version)
    explicit = evaluate(api, purpose="sandbox")
    response = api.post(
        "/api/evaluations",
        json={
            "group_id": GROUP,
            "conversation_id": CHAT,
            "checklist_version": version,
            "purpose": "regular",
        },
    )

    assert (implicit["purpose"], implicit["checklist_version"]) == ("sandbox", version)
    assert (explicit["purpose"], explicit["checklist_version"]) == ("sandbox", 1)
    assert_error(response, 400, "invalid_purpose")


def test_models_endpoint_lists_engine_catalog(api: TestClient, engine: FakeEvaluator) -> None:
    body = api.get("/api/models").json()

    assert [m["id"] for m in body["items"]] == ["fake-judge", "fake-offline"]
    assert set(body["items"][0]) == {"id", "provider", "label", "available", "default", "price"}
    engine.unavailable = True
    assert_error(api.get("/api/models"), 503, "engine_unavailable")


@pytest.mark.parametrize(
    ("path", "status_code", "code"),
    [
        ("/api/evaluations/ev_missing", 404, "evaluation_not_found"),
        ("/api/evaluations/bad%20id", 400, "invalid_evaluation_id"),
        ("/api/evaluations?purpose=demo", 400, "invalid_purpose"),
        ("/api/evaluations?limit=0", 400, "invalid_limit"),
        ("/api/evaluations?group_id=DEV!", 400, "invalid_group_id"),
    ],
)
def test_evaluation_read_errors(api: TestClient, path: str, status_code: int, code: str) -> None:
    assert_error(api.get(path), status_code, code)


def test_broken_json_body_gets_clear_message(api: TestClient) -> None:
    broken = api.post(
        "/api/evaluations", content=b"{not json", headers={"Content-Type": "application/json"}
    )
    missing = api.post("/api/evaluations")

    assert assert_error(broken, 400, "invalid_request")["message"] == (
        "Тело запроса — некорректный JSON."
    )
    assert assert_error(missing, 400, "invalid_request")["message"] == (
        "Нужно тело запроса в формате JSON."
    )
