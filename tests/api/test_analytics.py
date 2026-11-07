from typing import Any

from fastapi.testclient import TestClient

from tests.api.fakes import FakeEvaluator
from tests.api.helpers import (
    CHAT,
    GROUP,
    OTHER_CHAT,
    assert_error,
    decide,
    evaluate,
    file_appeal,
)


def criterion(report: dict[str, Any], criterion_id: str) -> dict[str, Any]:
    return next(item for item in report["criteria"] if item["criterion_id"] == criterion_id)


def test_empty_group_has_zero_counts(api: TestClient) -> None:
    report = api.get(f"/api/analytics?group_id={GROUP}").json()

    assert report == {
        "group_id": GROUP,
        "evaluated_count": 0,
        "criteria": [],
        "critical": [],
        "appeals": {"total": 0, "resolved": 0, "accepted": 0},
    }


def test_fail_rates_quotes_and_critical_list(api: TestClient, engine: FakeEvaluator) -> None:
    engine.answers[CHAT] = {"c05": "no", "c04": 10, "c02": "na", "c08": "yes"}
    engine.answers[OTHER_CHAT] = {"c05": "no"}
    first = evaluate(api)
    evaluate(api, OTHER_CHAT)
    evaluate(api, OTHER_CHAT, purpose="sandbox")  # песочница в аналитику не попадает

    report = api.get(f"/api/analytics?group_id={GROUP}").json()

    assert report["evaluated_count"] == 2
    assert [item["criterion_id"] for item in report["criteria"]] == [
        "c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08",
    ]  # fmt: skip
    c05 = criterion(report, "c05")
    assert (c05["applicable"], c05["fail_count"], c05["fail_rate"]) == (2, 2, 1.0)
    assert c05["answers"] == {"yes": 0, "no": 2}
    assert c05["answer_type"] == "yes_no"
    quotes = c05["top_quotes"]
    assert len(quotes) == 2  # у KZ и RU чатов разные реплики оператора
    assert quotes[0]["count"] == 1 and quotes[0]["explanation"] == "Фейковое обоснование c05"
    assert {quote["conversation_id"] for quote in quotes} == {CHAT, OTHER_CHAT}
    assert {quote["index"] for quote in quotes} == {9}
    c04 = criterion(report, "c04")
    assert c04["answers"] == {"20": 1, "15": 0, "10": 1, "5": 0, "0": 0, "na": 0}
    assert (c04["fail_count"], c04["fail_rate"]) == (1, 0.5)
    c02 = criterion(report, "c02")
    assert (c02["applicable"], c02["answers"]["na"], c02["fail_rate"]) == (1, 1, 0.0)
    c08 = criterion(report, "c08")
    assert (c08["fail_count"], c08["fail_rate"]) == (1, 0.5)  # для грубой ошибки провал — «Да»
    assert report["critical"] == [
        {
            "conversation_id": CHAT,
            "evaluation_id": first["id"],
            "note": "Фейковое обоснование c08",
            "index": 9,
            "quote": first["criteria"][7]["evidence"][0]["quote"],
        }
    ]


def test_appeal_acceptance_by_criterion_uses_final_answers(api: TestClient) -> None:
    first = evaluate(api)
    other = evaluate(api, OTHER_CHAT)
    changed = file_appeal(api, first["id"], "c05")
    confirmed = file_appeal(api, other["id"], "c05")
    file_appeal(api, other["id"], "c01")
    decide(api, changed["id"], action="change", new_answer="no", reason="Грубость")
    decide(api, confirmed["id"], action="confirm", reason="Всё верно")

    report = api.get(f"/api/analytics?group_id={GROUP}").json()

    assert criterion(report, "c05")["appeals"] == {
        "total": 2,
        "resolved": 2,
        "accepted": 1,
        "rate": 0.5,
    }
    assert criterion(report, "c01")["appeals"] == {
        "total": 1,
        "resolved": 0,
        "accepted": 0,
        "rate": None,
    }
    assert report["appeals"] == {"total": 3, "resolved": 2, "accepted": 1}
    assert criterion(report, "c05")["fail_count"] == 1  # решение по апелляции учтено


def test_appeal_history_survives_reevaluation_and_ignores_sandbox(api: TestClient) -> None:
    first = evaluate(api)
    appeal = file_appeal(api, first["id"], "c05")
    decide(api, appeal["id"], action="change", new_answer="no", reason="Грубость")
    sandbox = evaluate(api, OTHER_CHAT, purpose="sandbox")
    file_appeal(api, sandbox["id"], "c01")

    evaluate(api)  # переоценка: апелляция осталась у прошлой оценки
    report = api.get(f"/api/analytics?group_id={GROUP}").json()

    assert report["appeals"] == {"total": 1, "resolved": 1, "accepted": 1}
    assert criterion(report, "c05")["appeals"]["accepted"] == 1
    assert criterion(report, "c05")["fail_count"] == 0  # ответы — по последней оценке


def test_analytics_validates_group(api: TestClient) -> None:
    assert_error(api.get("/api/analytics?group_id=DEV!"), 400, "invalid_group_id")
