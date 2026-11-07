"""Сценарий через весь API поверх хранилища: на SQLite — всегда, а с Postgres
(CQA_TEST_DATABASE_URL) ответы обоих хранилищ сравниваются побайтово.

Сравниваются тела ответов целиком (с порядком ключей) после замены случайных id
(ev_…, ap_…) и меток времени на стабильные метки.
"""

import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.factory import create_app
from app.store import PostgresStore, SqliteStore, Store
from tests.api.conftest import CHECKLIST_FIXTURE
from tests.api.fakes import FakeEvaluator
from tests.api.helpers import CHAT, GROUP, OTHER_CHAT, checklist_doc
from tests.store.conftest import (
    TEST_DATABASE_URL_ENV,
    configured_database_url,
    drop_schema,
    new_test_schema,
)
from tests.support import RecordingUpstream, load_payload

_ID_RE = re.compile(r"\b(ev|ap)_[0-9a-f]{16}\b")
_TIME_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\b")


def run_scenario(store: Store) -> list[str]:
    """Оценки, апелляции, решение, переоценка, песочница, экспорт, аналитика — тела ответов."""
    settings = Settings(serve_static=False, checklist_path=CHECKLIST_FIXTURE)
    transport = httpx.MockTransport(RecordingUpstream(load_payload()))
    bodies: list[str] = []
    with TestClient(
        create_app(settings, transport=transport, store=store, evaluator=FakeEvaluator())
    ) as client:

        def call(method: str, url: str, **kwargs: Any) -> Any:
            response = client.request(method, url, **kwargs)
            assert response.is_success, f"{method} {url}: {response.status_code} {response.text}"
            bodies.append(response.text)
            return response.json() if "json" in response.headers["content-type"] else None

        evaluate = {"group_id": GROUP, "conversation_id": CHAT}
        call("GET", "/api/checklists")
        first = call("POST", "/api/evaluations", json=evaluate)
        call("POST", "/api/evaluations", json={**evaluate, "conversation_id": OTHER_CHAT})
        call("GET", f"/api/datasets/{GROUP}/conversations")
        changed = call(
            "POST",
            f"/api/evaluations/{first['id']}/appeals",
            json={"criterion_id": "c05", "comment": "Тон был вежливым"},
        )
        call(
            "POST",
            f"/api/evaluations/{first['id']}/appeals",
            json={"criterion_id": "c02", "comment": "Не согласен"},
        )
        call("GET", f"/api/appeals?group_id={GROUP}")
        call(
            "POST",
            f"/api/appeals/{changed['id']}/decision",
            json={"action": "change", "new_answer": "no", "reason": "Грубый тон"},
        )
        call("GET", f"/api/evaluations/{first['id']}")
        call("POST", "/api/evaluations", json={**evaluate, "reuse_previous": True})
        call("GET", f"/api/evaluations?group_id={GROUP}&conversation_id={CHAT}")
        call(
            "POST",
            "/api/checklists/chat-quality/versions",
            json={**checklist_doc(), "note": "песочница", "sandbox": True},
        )
        call("POST", "/api/evaluations", json={**evaluate, "checklist_version": 2})
        call("GET", "/api/checklists")
        call("GET", "/api/appeals?status=open")
        call("GET", "/api/appeals?status=resolved")
        call("GET", f"/api/export?group_id={GROUP}")
        call("GET", f"/api/export?group_id={GROUP}&format=csv")
        call("GET", f"/api/analytics?group_id={GROUP}")
        call("GET", f"/api/metrics/accuracy?group_id={GROUP}")
        call("GET", f"/api/datasets/{GROUP}/conversations")
    return normalized(bodies)


def normalized(bodies: list[str]) -> list[str]:
    """Случайные id → <ev1>, <ap2>… по порядку появления; время → <time>."""
    labels: dict[str, str] = {}

    def label(match: re.Match[str]) -> str:
        return labels.setdefault(match.group(0), f"<{match.group(1)}{len(labels) + 1}>")

    return [_TIME_RE.sub("<time>", _ID_RE.sub(label, body)) for body in bodies]


def test_api_scenario_runs_on_sqlite(tmp_path: Path) -> None:
    bodies = run_scenario(SqliteStore(str(tmp_path / "cqa.sqlite")))

    assert len(bodies) == 21
    history = json.loads(bodies[10])["items"]
    resolved = json.loads(bodies[15])["items"]
    exported = json.loads(bodies[16])["items"]
    # метки сквозные: ev1, ev2 — оценки, ap3, ap4 — апелляции, ev5 — переоценка (первой)
    assert [item["id"] for item in history] == ["<ev5>", "<ev1>"]
    assert [(item["criterion_id"], item["status"]) for item in resolved] == [("c05", "resolved")]
    assert sorted(item["conversation_id"] for item in exported) == sorted([CHAT, OTHER_CHAT])


def test_api_responses_are_identical_on_sqlite_and_postgres(tmp_path: Path) -> None:
    url = configured_database_url()
    if url is None:
        pytest.skip(f"{TEST_DATABASE_URL_ENV} не задан — сравнение с Postgres пропущено")
    schema = new_test_schema()
    try:
        on_postgres = run_scenario(PostgresStore(url, schema=schema))
    finally:
        drop_schema(url, schema)
    on_sqlite = run_scenario(SqliteStore(str(tmp_path / "cqa.sqlite")))

    assert len(on_postgres) == len(on_sqlite)
    for step, (expected, actual) in enumerate(zip(on_sqlite, on_postgres, strict=True)):
        assert actual == expected, f"шаг {step}: ответы различаются"
