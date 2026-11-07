import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.api.conftest import ApiFactory
from tests.api.fakes import FakeEvaluator
from tests.api.helpers import CHAT, OTHER_CHAT, assert_error, checklist_doc, evaluate

GOLD = [
    {
        "conversation_id": CHAT,
        "language": "RU",
        "set": "tuning",
        "answers": {"c01": {"value": "yes"}, "c05": {"value": "no"}},
    }
]
SPLIT = {"holdout": [OTHER_CHAT], "tuning": [CHAT]}


@pytest.fixture
def metrics_api(make_api: ApiFactory, tmp_path: Path) -> TestClient:
    gold_path = tmp_path / "gold.json"
    split_path = tmp_path / "split.json"
    gold_path.write_text(json.dumps(GOLD, ensure_ascii=False), encoding="utf-8")
    split_path.write_text(json.dumps(SPLIT), encoding="utf-8")
    return make_api(gold_path=gold_path, split_path=split_path)


def test_accuracy_uses_latest_regular_evaluations_by_default(
    metrics_api: TestClient, engine: FakeEvaluator
) -> None:
    evaluate(metrics_api)
    latest = evaluate(metrics_api)
    other = evaluate(metrics_api, OTHER_CHAT)
    evaluate(metrics_api, purpose="sandbox")

    response = metrics_api.get("/api/metrics/accuracy")

    assert response.status_code == 200
    assert response.json()["group_id"] == "DEV"
    call = engine.accuracy_calls[0]
    assert call["evaluation_ids"] == [other["id"], latest["id"]]  # по conversation_id
    assert call["gold"] == GOLD
    assert call["split"] == SPLIT
    assert (call["group_id"], call["checklist_version"]) == ("DEV", None)
    assert call["checklist"]["version"] == 1


def test_accuracy_for_checklist_version_takes_any_purpose(
    metrics_api: TestClient, engine: FakeEvaluator
) -> None:
    body = {**checklist_doc(), "sandbox": True}
    version = metrics_api.post("/api/checklists/chat-quality/versions", json=body).json()["version"]
    evaluate(metrics_api)
    sandbox = evaluate(metrics_api, checklist_version=version)

    metrics_api.get(f"/api/metrics/accuracy?checklist_version={version}")
    metrics_api.get("/api/metrics/accuracy?purpose=sandbox")

    by_version, by_purpose = engine.accuracy_calls
    assert by_version["evaluation_ids"] == [sandbox["id"]]
    assert by_version["checklist_version"] == version
    assert by_version["checklist"]["version"] == version
    assert by_purpose["evaluation_ids"] == [sandbox["id"]]


@pytest.mark.parametrize(
    ("query", "code"),
    [
        ("?group_id=DEV!", "invalid_group_id"),
        ("?purpose=demo", "invalid_purpose"),
        ("?checklist_version=0", "invalid_version"),
        ("?checklist_id=bad!", "invalid_checklist_id"),
    ],
)
def test_accuracy_rejects_bad_parameters(metrics_api: TestClient, query: str, code: str) -> None:
    assert_error(metrics_api.get(f"/api/metrics/accuracy{query}"), 400, code)


def test_missing_gold_gives_clear_error(make_api: ApiFactory, tmp_path: Path) -> None:
    client = make_api(gold_path=tmp_path / "absent.json")

    error = assert_error(client.get("/api/metrics/accuracy"), 500, "gold_unavailable")

    assert str(tmp_path) not in error["message"]


def test_missing_split_is_optional(make_api: ApiFactory, tmp_path: Path, engine: Any) -> None:
    gold_path = tmp_path / "gold.json"
    gold_path.write_text(json.dumps(GOLD), encoding="utf-8")
    client = make_api(gold_path=gold_path, split_path=tmp_path / "absent.json")

    assert client.get("/api/metrics/accuracy").status_code == 200
    assert engine.accuracy_calls[0]["split"] is None
