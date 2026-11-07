"""Фикстуры API-тестов: приложение с фейковым движком и базой в памяти, без сети."""

from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.factory import create_app
from tests.api.fakes import FakeEvaluator
from tests.support import RecordingUpstream

FIXTURES_DIR = Path(__file__).parent / "fixtures"
CHECKLIST_FIXTURE = FIXTURES_DIR / "checklist.json"

ApiFactory = Callable[..., TestClient]


@pytest.fixture
def engine() -> FakeEvaluator:
    return FakeEvaluator()


@pytest.fixture
def make_api(engine: FakeEvaluator, upstream_payload: dict[str, Any]) -> Iterator[ApiFactory]:
    """Фабрика клиента: фейковый движок, источник из фикстуры, чек-лист из tests/api/fixtures."""
    opened: list[TestClient] = []

    def factory(**overrides: Any) -> TestClient:
        settings = Settings(
            **{"serve_static": False, "checklist_path": CHECKLIST_FIXTURE, **overrides}
        )
        transport = httpx.MockTransport(RecordingUpstream(upstream_payload))
        client = TestClient(create_app(settings, transport=transport, evaluator=engine))
        client.__enter__()
        opened.append(client)
        return client

    yield factory
    for client in opened:
        client.__exit__(None, None, None)


@pytest.fixture
def api(make_api: ApiFactory) -> TestClient:
    return make_api()
