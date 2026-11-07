"""Локальная модель через Ollama (POST /api/chat, ответ по JSON-схеме). Бесплатно, офлайн."""

import time
from collections.abc import Callable
from typing import Any

import httpx

from app.engine.providers.base import (
    RETRYABLE_STATUS,
    CompletionRequest,
    CompletionResult,
    ModelSpec,
    ProviderError,
    Usage,
    parse_json_object,
    with_retries,
)

MODEL_PREFIX = "ollama/"
REQUEST_TIMEOUT_SEC = 85.0


class OllamaProvider:
    name = "ollama"

    def __init__(
        self,
        host: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_sec: float = REQUEST_TIMEOUT_SEC,
    ) -> None:
        self._url = host.rstrip("/") + "/api/chat"
        self._client = httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(timeout_sec))

    async def aclose(self) -> None:
        await self._client.aclose()

    async def complete(
        self,
        spec: ModelSpec,
        request: CompletionRequest,
        *,
        on_start: Callable[[], None] | None = None,
    ) -> CompletionResult:
        if on_start is not None:
            on_start()
        body = {
            "model": spec.id.removeprefix(MODEL_PREFIX),
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": f"{request.prefix}\n\n{request.suffix}"},
            ],
            "format": request.schema,
            "stream": False,
            "options": {"temperature": 0, "num_predict": request.max_tokens},
        }
        started = time.monotonic()
        payload = await with_retries(lambda: self._post(spec.id, body))
        message = payload.get("message") or {}
        text = message.get("content") if isinstance(message.get("content"), str) else ""
        if not text.strip():
            raise ProviderError(f"{spec.id}: пустой ответ", retryable=True)
        return CompletionResult(
            model=spec.id,
            text=text,
            data=parse_json_object(text),
            usage=Usage(
                input_tokens=int(payload.get("prompt_eval_count") or 0),
                output_tokens=int(payload.get("eval_count") or 0),
            ),
            latency_ms=int((time.monotonic() - started) * 1000),
            stop_reason=payload.get("done_reason"),
        )

    async def _post(self, model: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            response = await self._client.post(self._url, json=body)
        except httpx.TimeoutException:
            raise ProviderError(f"{model}: таймаут запроса", retryable=False) from None
        except httpx.RequestError as exc:
            raise ProviderError(f"{model}: Ollama недоступна: {type(exc).__name__}") from None
        if response.status_code >= 400:
            raise ProviderError(
                f"{model}: HTTP {response.status_code}",
                retryable=response.status_code in RETRYABLE_STATUS,
            )
        try:
            payload = response.json()
        except ValueError:
            raise ProviderError(f"{model}: ответ не JSON") from None
        if not isinstance(payload, dict):
            raise ProviderError(f"{model}: ответ не JSON-объект")
        return payload
