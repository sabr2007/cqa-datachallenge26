"""Общие фикстуры: приложение с подменённым транспортом httpx — тесты не ходят в сеть."""

import os
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import MEMORY_DB, Settings
from app.factory import create_app
from tests.support import load_payload

# Тесты не трогают рабочую базу .data/cqa.sqlite: load_settings() (например, при импорте
# app.main) берёт базу в памяти, даже если CQA_DB_PATH задан в окружении разработчика.
os.environ["CQA_DB_PATH"] = MEMORY_DB

Handler = Callable[[httpx.Request], Any]
ClientFactory = Callable[..., TestClient]


@pytest.fixture
def upstream_payload() -> dict[str, Any]:
    return load_payload()


@pytest.fixture
def make_client() -> Iterator[ClientFactory]:
    """Фабрика TestClient: handler заменяет сеть, overrides — поля Settings."""
    opened: list[TestClient] = []

    def factory(handler: Handler, **overrides: Any) -> TestClient:
        settings = Settings(**{"serve_static": False, **overrides})
        client = TestClient(create_app(settings, transport=httpx.MockTransport(handler)))
        client.__enter__()
        opened.append(client)
        return client

    yield factory
    for client in opened:
        client.__exit__(None, None, None)
