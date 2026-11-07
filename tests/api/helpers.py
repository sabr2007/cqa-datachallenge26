"""Короткие действия через API для тестов."""

import json
from typing import Any

from fastapi.testclient import TestClient

from tests.api.conftest import CHECKLIST_FIXTURE

GROUP = "DEV"
CHAT = "p1-ru-001"  # оператор отвечает в реплике #9 (index 9) из 12
OTHER_CHAT = "p1-kz-001"


def checklist_doc() -> dict[str, Any]:
    return json.loads(CHECKLIST_FIXTURE.read_text(encoding="utf-8"))


def evaluate(client: TestClient, conversation_id: str = CHAT, **extra: Any) -> dict[str, Any]:
    response = client.post(
        "/api/evaluations",
        json={"group_id": GROUP, "conversation_id": conversation_id, **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()


def file_appeal(
    client: TestClient, evaluation_id: str, criterion_id: str = "c05", comment: str = "Не согласен"
) -> dict[str, Any]:
    response = client.post(
        f"/api/evaluations/{evaluation_id}/appeals",
        json={"criterion_id": criterion_id, "comment": comment},
    )
    assert response.status_code == 201, response.text
    return response.json()


def decide(client: TestClient, appeal_id: str, **body: Any) -> Any:
    return client.post(f"/api/appeals/{appeal_id}/decision", json=body)


def result(evaluation: dict[str, Any], criterion_id: str) -> dict[str, Any]:
    return next(c for c in evaluation["criteria"] if c["criterion_id"] == criterion_id)


def section(evaluation: dict[str, Any], section_id: str) -> dict[str, Any]:
    return next(s for s in evaluation["sections"] if s["id"] == section_id)


def assert_error(response: Any, status_code: int, code: str) -> dict[str, Any]:
    assert response.status_code == status_code, response.text
    body = response.json()
    assert body["error"]["code"] == code
    assert body["error"]["message"]
    return body["error"]
