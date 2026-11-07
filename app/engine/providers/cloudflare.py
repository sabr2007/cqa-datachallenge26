"""Cloudflare Workers AI — прямой REST: POST /accounts/{id}/ai/run/{model}.

Через AI Gateway эти модели закрыты, поэтому только прямой путь. Тело — в стиле
chat completions со строгой JSON-схемой ответа; стоимость — по нейронам.
"""

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
    retry_after_seconds,
    with_retries,
)

API_BASE = "https://api.cloudflare.com/client/v4"
USD_PER_1K_NEURONS = 0.011
REQUEST_TIMEOUT_SEC = 75.0
CONNECT_TIMEOUT_SEC = 10.0
_ERROR_TEXT_LIMIT = 200


class CloudflareProvider:
    name = "cloudflare"

    def __init__(
        self,
        account_id: str,
        api_token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_sec: float = REQUEST_TIMEOUT_SEC,
        temperature: float | None = 0.0,
    ) -> None:
        self._url_prefix = f"{API_BASE}/accounts/{account_id}/ai/run/"
        self._temperature = temperature
        self._client = httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(timeout_sec, connect=min(CONNECT_TIMEOUT_SEC, timeout_sec)),
            headers={"Authorization": f"Bearer {api_token}", "Accept": "application/json"},
        )

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
            on_start()  # кеша префикса нет — остальные запросы не ждут
        body = {**build_body(request, temperature=self._temperature), **spec.options}
        started = time.monotonic()
        payload = await with_retries(lambda: self._post(spec.id, body))
        return parse_response(spec, payload, latency_ms=int((time.monotonic() - started) * 1000))

    async def _post(self, model: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            response = await self._client.post(self._url_prefix + model, json=body)
        except httpx.TimeoutException:
            raise ProviderError(f"{model}: таймаут запроса", retryable=True) from None
        except httpx.RequestError as exc:
            raise ProviderError(f"{model}: сеть: {type(exc).__name__}", retryable=True) from None
        if response.status_code >= 400:
            raise ProviderError(
                f"{model}: HTTP {response.status_code}: {_error_text(response)}",
                retryable=response.status_code in RETRYABLE_STATUS,
                retry_after=retry_after_seconds(response.headers),
                rate_limited=response.status_code == 429,
            )
        try:
            payload = response.json()
        except ValueError:
            raise ProviderError(f"{model}: ответ не JSON", retryable=True) from None
        if not isinstance(payload, dict) or payload.get("success") is False:
            raise ProviderError(f"{model}: ошибка API: {_error_text(response)}")
        return payload


def build_body(request: CompletionRequest, *, temperature: float | None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": request.system},
            {"role": "user", "content": f"{request.prefix}\n\n{request.suffix}"},
        ],
        "max_tokens": request.max_tokens,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": request.schema_name, "schema": request.schema, "strict": True},
        },
    }
    if temperature is not None:
        body["temperature"] = temperature
    return body


def parse_response(
    spec: ModelSpec, payload: dict[str, Any], *, latency_ms: int
) -> CompletionResult:
    result = payload.get("result")
    if not isinstance(result, dict):
        raise ProviderError(f"{spec.id}: в ответе нет result")
    choices = result.get("choices") or []
    choice = choices[0] if choices and isinstance(choices[0], dict) else {}
    message = choice.get("message") or {}
    content = message.get("content")
    text = content if isinstance(content, str) else ""
    finish = choice.get("finish_reason")
    if not text.strip():
        raise ProviderError(f"{spec.id}: пустой ответ (finish_reason={finish})", retryable=True)
    return CompletionResult(
        model=spec.id,
        text=text,
        data=parse_json_object(text),
        usage=_usage(result.get("usage") or {}),
        latency_ms=latency_ms,
        stop_reason=finish if isinstance(finish, str) else None,
    )


def _usage(raw: dict[str, Any]) -> Usage:
    neurons = _number(raw.get("neurons"))
    details = raw.get("prompt_tokens_details") or {}
    return Usage(
        input_tokens=int(_number(raw.get("prompt_tokens"))),
        output_tokens=int(_number(raw.get("completion_tokens"))),
        cache_read_tokens=int(_number(details.get("cached_tokens"))),
        neurons=neurons,
        cost_usd=neurons / 1000 * USD_PER_1K_NEURONS,
    )


def _number(value: object) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _error_text(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text[:_ERROR_TEXT_LIMIT]
    errors = payload.get("errors") if isinstance(payload, dict) else None
    if isinstance(errors, list) and errors:
        first = errors[0]
        if isinstance(first, dict):
            return str(first.get("message", first))[:_ERROR_TEXT_LIMIT]
    return str(payload)[:_ERROR_TEXT_LIMIT]
