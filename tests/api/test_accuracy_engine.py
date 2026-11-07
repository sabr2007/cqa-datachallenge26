"""/api/metrics/accuracy с настоящим compute_accuracy движка (чистая функция, без сети)."""

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.engine import EngineEvaluator
from tests.api.conftest import ApiFactory
from tests.api.fakes import FakeEvaluator
from tests.api.helpers import CHAT, OTHER_CHAT, evaluate

pytest.importorskip("app.engine")

GOLD = [
    {
        "conversation_id": CHAT,
        "language": "RU",
        "set": "tuning",
        "answers": {"c01": {"value": "yes"}, "c04": {"value": 20}, "c05": {"value": "no"}},
    },
    {
        "conversation_id": OTHER_CHAT,
        "language": "KZ",
        "set": "holdout",
        "answers": {"c02": {"value": "na"}},
    },
]


class EngineAccuracy(FakeEvaluator):
    """Оценки — фейковые, точность — настоящим расчётом движка."""

    def compute_accuracy(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return EngineEvaluator().compute_accuracy(*args, **kwargs)


@pytest.fixture
def engine() -> FakeEvaluator:
    return EngineAccuracy()


@pytest.fixture
def client(make_api: ApiFactory, tmp_path: Path) -> TestClient:
    gold_path = tmp_path / "gold.json"
    gold_path.write_text(json.dumps(GOLD, ensure_ascii=False), encoding="utf-8")
    return make_api(gold_path=gold_path, split_path=tmp_path / "absent.json")


def test_report_has_contract_shape_and_counts(client: TestClient, engine: FakeEvaluator) -> None:
    engine.answers[OTHER_CHAT] = {"c02": "no"}
    evaluate(client)
    evaluate(client, OTHER_CHAT)

    report = client.get("/api/metrics/accuracy").json()

    assert {
        "group_id",
        "checklist_version",
        "gold_count",
        "evaluated_count",
        "overall",
        "by_set",
        "by_criterion",
        "by_language",
        "na_confusion",
        "by_model",
        "expert_agreement",
        "conversations",
    } <= set(report)
    assert (report["gold_count"], report["evaluated_count"]) == (2, 2)
    assert report["overall"] == {"matched": 2, "total": 4, "accuracy": 0.5}
    assert report["na_confusion"]["na_as_no"] == 1
    mismatches = {row["conversation_id"]: row["mismatches"] for row in report["conversations"]}
    assert mismatches[CHAT] == [{"criterion_id": "c05", "gold": "no", "system": "yes"}]
