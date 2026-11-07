"""Вспомогательные данные и заглушки для тестов (без сети)."""

import json
from pathlib import Path
from typing import Any

import httpx

FIXTURES_DIR = Path(__file__).parent / "fixtures"
UPSTREAM_HOST = "ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com"


def load_payload() -> dict[str, Any]:
    """Конверт API кейса: два синтетических чата из DEV и выдуманный звонок."""
    return json.loads((FIXTURES_DIR / "upstream_dev_sample.json").read_text(encoding="utf-8"))


class RecordingUpstream:
    """Отдаёт заданный ответ API кейса и запоминает запросы."""

    def __init__(self, payload: Any, status_code: int = 200) -> None:
        self.payload = payload
        self.status_code = status_code
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status_code, json=self.payload)
