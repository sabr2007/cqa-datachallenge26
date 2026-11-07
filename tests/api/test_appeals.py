from dataclasses import replace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.store import RevisionConflictError
from tests.api.fakes import FakeEvaluator
from tests.api.helpers import (
    CHAT,
    GROUP,
    OTHER_CHAT,
    assert_error,
    decide,
    evaluate,
    file_appeal,
    result,
    section,
)


def test_appeal_is_created_and_shown_in_evaluation(api: TestClient) -> None:
    evaluation = evaluate(api)

    appeal = file_appeal(api, evaluation["id"], "c05", "  Оператор был вежлив  ")

    assert appeal == {
        "id": appeal["id"],
        "evaluation_id": evaluation["id"],
        "group_id": GROUP,
        "conversation_id": CHAT,
        "criterion_id": "c05",
        "comment": "Оператор был вежлив",
        "created_at": appeal["created_at"],
        "status": "open",
        "original_answer": "yes",
        "decision": None,
    }
    assert appeal["id"].startswith("ap_")
    stored = api.get(f"/api/evaluations/{evaluation['id']}").json()
    assert result(stored, "c05")["appeal"] == {
        "id": appeal["id"],
        "status": "open",
        "comment": "Оператор был вежлив",
        "created_at": appeal["created_at"],
        "original_answer": "yes",
        "decision": None,
    }
    assert result(stored, "c04")["appeal"] is None


def test_second_appeal_on_same_criterion_is_rejected(api: TestClient) -> None:
    evaluation = evaluate(api)
    file_appeal(api, evaluation["id"], "c05")

    response = api.post(
        f"/api/evaluations/{evaluation['id']}/appeals",
        json={"criterion_id": "c05", "comment": "Ещё раз"},
    )

    assert_error(response, 409, "appeal_exists")


@pytest.mark.parametrize(
    ("body", "status_code", "code"),
    [
        ({"criterion_id": "c99", "comment": "x"}, 404, "criterion_not_found"),
        ({"criterion_id": "c05", "comment": "   "}, 400, "invalid_comment"),
        ({"criterion_id": "c05", "comment": "x" * 2001}, 400, "invalid_comment"),
        ({"criterion_id": "c05"}, 400, "invalid_comment"),
        ({"criterion_id": "c 05", "comment": "x"}, 400, "invalid_criterion_id"),
        ("текст", 400, "invalid_body"),
    ],
)
def test_invalid_appeals_are_rejected(
    api: TestClient, body: Any, status_code: int, code: str
) -> None:
    evaluation = evaluate(api)

    response = api.post(f"/api/evaluations/{evaluation['id']}/appeals", json=body)

    assert_error(response, status_code, code)


def test_appeal_on_missing_or_failed_evaluation(api: TestClient, engine: FakeEvaluator) -> None:
    engine.failure = RuntimeError("boom")
    api.post("/api/evaluations", json={"group_id": GROUP, "conversation_id": CHAT})
    failed = api.get("/api/evaluations").json()["items"][0]
    body = {"criterion_id": "c05", "comment": "x"}

    assert_error(
        api.post("/api/evaluations/ev_missing/appeals", json=body), 404, "evaluation_not_found"
    )
    assert_error(
        api.post(f"/api/evaluations/{failed['id']}/appeals", json=body),
        409,
        "evaluation_not_appealable",
    )


def test_queue_shows_fragment_options_and_answers(api: TestClient) -> None:
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c04")

    items = api.get(f"/api/appeals?group_id={GROUP}&status=open").json()["items"]

    assert len(items) == 1
    item = items[0]
    assert {key: item[key] for key in appeal} == appeal
    assert (item["criterion_title"], item["answer_type"]) == (
        "Корректная и полная консультация",
        "scale",
    )
    assert (item["original_answer"], item["final_answer"]) == (20, 20)
    assert [option["value"] for option in item["options"]] == [20, 15, 10, 5, 0, "na"]
    # evidence фейка — первая реплика оператора (index 9): фрагмент 8, 9, 10.
    assert [m["index"] for m in item["fragment"]] == [8, 9, 10]
    assert set(item["fragment"][0]) == {"index", "speaker", "text", "timestamp", "offset_sec"}
    assert item["fragment"][1]["speaker"] == "operator"
    assert api.get(f"/api/appeals/{appeal['id']}").json() == item


def test_queue_filters_by_status_group_and_conversation(api: TestClient) -> None:
    first = evaluate(api)
    other = evaluate(api, OTHER_CHAT)
    open_appeal = file_appeal(api, first["id"], "c05")
    closed = file_appeal(api, other["id"], "c01")
    decide(api, closed["id"], action="confirm", reason="Всё верно")

    def ids(query: str) -> list[str]:
        return [item["id"] for item in api.get(f"/api/appeals{query}").json()["items"]]

    assert ids("") == [open_appeal["id"], closed["id"]]  # открытые первыми
    assert ids("?status=open") == [open_appeal["id"]]
    assert ids("?status=resolved") == [closed["id"]]
    assert ids("?group_id=OTHER") == []
    assert ids(f"?conversation_id={OTHER_CHAT}") == [closed["id"]]
    assert ids(f"?evaluation_id={first['id']}") == [open_appeal["id"]]
    assert_error(api.get("/api/appeals?status=closed"), 400, "invalid_status")
    assert_error(api.get("/api/appeals/ap_missing"), 404, "appeal_not_found")


def test_confirm_keeps_scores_and_resolves_appeal(api: TestClient) -> None:
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c05")

    response = decide(api, appeal["id"], action="confirm", reason=" Оценка верна ")

    assert response.status_code == 200
    body = response.json()
    assert body["appeal"]["status"] == "resolved"
    decision = body["appeal"]["decision"]
    assert (decision["action"], decision["new_answer"], decision["reason"]) == (
        "confirm",
        None,
        "Оценка верна",
    )
    assert decision["decided_at"].endswith("Z")
    updated = body["evaluation"]
    assert updated["final_total"] == evaluation["final_total"]
    assert result(updated, "c05")["final_answer"] == "yes"
    assert result(updated, "c05")["appeal"]["status"] == "resolved"
    assert result(updated, "c05")["appeal"]["decision"] == decision
    again = decide(api, appeal["id"], action="confirm", reason="ещё раз")
    assert_error(again, 409, "appeal_already_resolved")


def test_change_recalculates_final_scores_but_keeps_original(api: TestClient) -> None:
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c05")

    body = decide(api, appeal["id"], action="change", new_answer="no", reason="Грубый тон").json()

    updated = body["evaluation"]
    c05 = result(updated, "c05")
    assert (c05["answer"], c05["final_answer"]) == ("yes", "no")
    assert (c05["points"], c05["final_points"]) == (15.0, 0.0)
    assert (evaluation["total"], updated["total"], updated["final_total"]) == (100.0, 100.0, 85.0)
    assert section(updated, "conduct")["final_points"] == 20.0
    assert section(updated, "conduct")["points"] == 35.0
    assert body["appeal"]["decision"]["new_answer"] == "no"
    assert updated["critical_flag"] is False
    assert api.get(f"/api/evaluations/{evaluation['id']}").json() == updated


def test_change_to_na_redistributes_weights(api: TestClient) -> None:
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c02")

    updated = decide(api, appeal["id"], action="change", new_answer="NA", reason="Данных хватало")

    body = updated.json()["evaluation"]
    c02, c01 = result(body, "c02"), result(body, "c01")
    assert c02["final_answer"] == "na"
    assert (c02["final_points"], c02["final_max_points"]) == (None, None)
    assert (c01["max_points"], c01["final_max_points"]) == (10.0, 11.76)  # 10 × 100 / 85
    assert body["final_total"] == 100.0


def test_critical_change_updates_flag_and_note_from_reason(
    api: TestClient, engine: FakeEvaluator
) -> None:
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c08")

    body = decide(
        api, appeal["id"], action="change", new_answer="yes", reason="Оператор оскорбил клиента"
    ).json()

    updated = body["evaluation"]
    assert (evaluation["critical_flag"], updated["critical_flag"]) == (False, True)
    assert updated["critical_note"] == "Оператор оскорбил клиента"
    listing = api.get(f"/api/datasets/{GROUP}/conversations").json()["items"]
    summary = next(item for item in listing if item["conversation_id"] == CHAT)["evaluation"]
    assert summary["critical"] is True
    assert summary["critical_note"] == "Оператор оскорбил клиента"
    assert summary["appeal_status"] == "resolved"
    assert summary["answers"]["c08"] == "yes"


def test_critical_flag_is_cleared_when_violation_is_overturned(
    api: TestClient, engine: FakeEvaluator
) -> None:
    engine.answers[CHAT] = {"c08": "yes"}
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c08")

    body = decide(
        api, appeal["id"], action="change", new_answer="no", reason="Это цитата клиента"
    ).json()

    assert (evaluation["critical_flag"], body["evaluation"]["critical_flag"]) == (True, False)
    assert body["evaluation"]["critical_note"] == "Это цитата клиента"


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"action": "change", "new_answer": "na", "reason": "x"}, "invalid_answer"),
        ({"action": "change", "new_answer": 3, "reason": "x"}, "invalid_answer"),
        ({"action": "change", "new_answer": "yes", "reason": "x"}, "answer_unchanged"),
        ({"action": "change", "reason": "x"}, "invalid_new_answer"),
        ({"action": "reject", "reason": "x"}, "invalid_action"),
        ({"action": "confirm", "reason": ""}, "invalid_reason"),
        ({"action": "confirm"}, "invalid_reason"),
    ],
)
def test_invalid_decisions_are_rejected(api: TestClient, body: dict[str, Any], code: str) -> None:
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c05")

    error = assert_error(decide(api, appeal["id"], **body), 400, code)

    if code == "invalid_answer":
        assert "Допустимые ответы: yes, no." in error["message"]
    assert api.get(f"/api/appeals/{appeal['id']}").json()["status"] == "open"


def test_decision_for_missing_appeal(api: TestClient) -> None:
    response = decide(api, "ap_missing", action="confirm", reason="x")

    assert_error(response, 404, "appeal_not_found")


def test_scale_answer_change_accepts_steps_only(api: TestClient) -> None:
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c06")

    wrong = decide(api, appeal["id"], action="change", new_answer=5, reason="x")
    right = decide(api, appeal["id"], action="change", new_answer=7, reason="Один сбой")

    assert_error(wrong, 400, "invalid_answer")
    updated = right.json()["evaluation"]
    assert result(updated, "c06")["final_answer"] == 7
    assert result(updated, "c06")["final_points"] == 10.5  # 7/10 × 15
    assert updated["final_total"] == 95.5


class _ConflictOnce:
    """Хранилище, где первая запись апелляции натыкается на параллельное изменение оценки."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.conflicts = 0

    def _conflict_once(self, method: str, *args: Any, **kwargs: Any) -> None:
        if self.conflicts == 0:
            self.conflicts += 1
            raise RevisionConflictError("ev")
        getattr(self._inner, method)(*args, **kwargs)

    def add_appeal(self, *args: Any, **kwargs: Any) -> None:
        self._conflict_once("add_appeal", *args, **kwargs)

    def resolve_appeal(self, *args: Any, **kwargs: Any) -> None:
        self._conflict_once("resolve_appeal", *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


@pytest.mark.parametrize("step", ["create", "decide"])
def test_parallel_change_of_evaluation_is_retried(
    api: TestClient, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c05") if step == "decide" else None
    services = api.app.state.services
    flaky = _ConflictOnce(services.store)
    monkeypatch.setattr(api.app.state, "services", replace(services, store=flaky))

    if step == "create":
        file_appeal(api, evaluation["id"], "c01")
    else:
        assert decide(api, appeal["id"], action="confirm", reason="ok").status_code == 200

    assert flaky.conflicts == 1
