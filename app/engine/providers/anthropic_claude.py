"""Claude через официальный SDK `anthropic` (Messages API).

- structured outputs: output_config.format с JSON-схемой ответа;
- effort задаётся явно (у Opus 5.5 по умолчанию medium), thinking — adaptive по умолчанию;
- кеширование общего префикса: инструкции (system) и транскрипт идут первыми,
  точка кеша — после транскрипта, критерий — в конце сообщения;
- серверный fallback при отказе по политике (fallbacks="default").
"""

import time
from collections.abc import Callable
from typing import Any

import anthropic

from app.engine.providers.base import (
    CompletionRequest,
    CompletionResult,
    ModelSpec,
    ProviderError,
    Usage,
    parse_json_object,
)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
REQUEST_TIMEOUT_SEC = 80.0
SDK_MAX_RETRIES = 2  # SDK сам повторяет 408/409/429/5xx и сетевые ошибки
# Цены Claude Opus 5.5, USD за 1M токенов (запись кеша с TTL 5 минут = 1,25 × вход).
OPUS_5_5_PRICE = {
    "input_per_mtok": 4.0,
    "output_per_mtok": 20.0,
    "cache_read_per_mtok": 0.2,
    "cache_write_per_mtok": 5.0,
}


class AnthropicProvider:
    name = "anthropic"

    def __init__(
        self,
        api_key: str,
        *,
        effort: str = "medium",
        client: Any | None = None,
        timeout_sec: float = REQUEST_TIMEOUT_SEC,
    ) -> None:
        self._effort = effort
        self._client = client or anthropic.AsyncAnthropic(
            api_key=api_key, max_retries=SDK_MAX_RETRIES, timeout=timeout_sec
        )

    async def aclose(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            await close()

    async def complete(
        self,
        spec: ModelSpec,
        request: CompletionRequest,
        *,
        on_start: Callable[[], None] | None = None,
    ) -> CompletionResult:
        started = time.monotonic()
        try:
            message = await self._stream(spec, request, on_start)
        except anthropic.BadRequestError as exc:
            raise ProviderError(f"{spec.id}: неверный запрос: {_message(exc)}") from None
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError):
            raise ProviderError(f"{spec.id}: ключ API не принят") from None
        except anthropic.RateLimitError:
            raise ProviderError(f"{spec.id}: превышен лимит запросов", rate_limited=True) from None
        except anthropic.APIStatusError as exc:
            raise ProviderError(
                f"{spec.id}: HTTP {exc.status_code}", retryable=exc.status_code >= 500
            ) from None
        except (anthropic.APITimeoutError, anthropic.APIConnectionError) as exc:
            raise ProviderError(f"{spec.id}: сеть: {type(exc).__name__}", retryable=True) from None
        finally:
            if on_start is not None:
                on_start()  # даже при ошибке не держим остальные запросы
        return parse_message(spec, message, latency_ms=int((time.monotonic() - started) * 1000))

    async def _stream(
        self, spec: ModelSpec, request: CompletionRequest, on_start: Callable[[], None] | None
    ) -> Any:
        async with self._client.beta.messages.stream(
            **build_params(spec, request, self._effort)
        ) as stream:
            async for _event in stream:
                if on_start is not None:
                    # Запись кеша доступна, как только ответ начал приходить.
                    on_start()
                    on_start = None
            return await stream.get_final_message()


def build_params(spec: ModelSpec, request: CompletionRequest, effort: str) -> dict[str, Any]:
    return {
        "model": spec.id,
        "max_tokens": request.max_tokens,
        "system": [{"type": "text", "text": request.system}],
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": request.prefix,
                        "cache_control": {"type": "ephemeral"},
                    },
                    {"type": "text", "text": request.suffix},
                ],
            }
        ],
        "output_config": {
            "effort": effort,
            "format": {"type": "json_schema", "schema": request.schema},
        },
        "betas": [FALLBACK_BETA],
        "fallbacks": "default",
    }


def parse_message(spec: ModelSpec, message: Any, *, latency_ms: int) -> CompletionResult:
    stop_reason = getattr(message, "stop_reason", None)
    if stop_reason == "refusal":
        raise ProviderError(f"{spec.id}: модель отказалась отвечать (refusal)")
    text = "".join(
        getattr(block, "text", "") or ""
        for block in getattr(message, "content", None) or []
        if getattr(block, "type", None) == "text"
    )
    if not text.strip():
        raise ProviderError(f"{spec.id}: пустой ответ (stop_reason={stop_reason})", retryable=True)
    return CompletionResult(
        model=spec.id,
        text=text,
        data=parse_json_object(text),
        usage=claude_usage(getattr(message, "usage", None), spec.price or OPUS_5_5_PRICE),
        latency_ms=latency_ms,
        stop_reason=stop_reason,
    )


def claude_usage(raw: Any, price: dict[str, Any]) -> Usage:
    input_tokens = _int(getattr(raw, "input_tokens", 0))
    output_tokens = _int(getattr(raw, "output_tokens", 0))
    cache_read = _int(getattr(raw, "cache_read_input_tokens", 0))
    cache_write = _int(getattr(raw, "cache_creation_input_tokens", 0))
    cost = (
        input_tokens * price.get("input_per_mtok", 0)
        + output_tokens * price.get("output_per_mtok", 0)
        + cache_read * price.get("cache_read_per_mtok", 0)
        + cache_write * price.get("cache_write_per_mtok", 0)
    ) / 1_000_000
    return Usage(
        input_tokens=input_tokens + cache_read + cache_write,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
        cost_usd=cost,
    )


def _int(value: object) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0


def _message(exc: anthropic.APIStatusError) -> str:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:200]
    return type(exc).__name__
