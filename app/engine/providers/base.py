"""Общие типы провайдеров моделей: запрос, ответ, ошибки, ретраи с backoff."""

import asyncio
import json
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529})
DEFAULT_ATTEMPTS = 4
BASE_DELAY_SEC = 1.0
MAX_DELAY_SEC = 10.0
RATE_LIMIT_DELAY_SEC = 4.0
RATE_LIMIT_ATTEMPTS = 2
MAX_RATE_LIMIT_DELAY_SEC = 20.0


@dataclass(frozen=True, slots=True)
class ModelSpec:
    id: str
    provider: str  # "anthropic" | "cloudflare" | "ollama"
    label: str
    price: dict[str, Any] = field(default_factory=dict)
    # Модель поддерживает кеширование общего префикса — схема ответа должна быть
    # одинаковой для всех критериев, иначе кеш не переиспользуется.
    prompt_cache: bool = False
    # Дополнительные параметры тела запроса (например, reasoning_effort у Workers AI).
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class CompletionRequest:
    system: str  # общие инструкции (одинаковы для всех критериев)
    prefix: str  # транскрипт и факты диалога (одинаковы для всех критериев)
    suffix: str  # критерий — в самом конце, после общего префикса
    schema: dict[str, Any]
    schema_name: str = "criterion_verdict"
    max_tokens: int = 4096


@dataclass(frozen=True, slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    neurons: float = 0.0
    cost_usd: float = 0.0

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_read_tokens=self.cache_read_tokens + other.cache_read_tokens,
            cache_write_tokens=self.cache_write_tokens + other.cache_write_tokens,
            neurons=self.neurons + other.neurons,
            cost_usd=self.cost_usd + other.cost_usd,
        )


@dataclass(frozen=True, slots=True)
class CompletionResult:
    model: str
    text: str
    data: dict[str, Any] | None  # разобранный JSON (None — ответ не JSON-объект)
    usage: Usage
    latency_ms: int
    stop_reason: str | None = None


class ProviderError(Exception):
    """Ошибка вызова модели. Сообщение безопасно для логов: без ключей и тел запросов."""

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        retry_after: float | None = None,
        rate_limited: bool = False,
    ):
        super().__init__(message)
        self.retryable = retryable or rate_limited
        self.retry_after = retry_after
        self.rate_limited = rate_limited


class Provider(Protocol):
    name: str

    async def complete(self, spec: ModelSpec, request: CompletionRequest) -> CompletionResult: ...

    async def aclose(self) -> None: ...


def parse_json_object(text: str) -> dict[str, Any] | None:
    """JSON-объект из ответа модели; терпит обёртку ```json и текст вокруг объекта."""
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        candidate = candidate.removeprefix("json").strip()
    try:
        value = json.loads(candidate)
    except ValueError:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            value = json.loads(candidate[start : end + 1])
        except ValueError:
            return None
    return value if isinstance(value, dict) else None


async def with_retries[T](
    call: Callable[[], Awaitable[T]],
    *,
    attempts: int = DEFAULT_ATTEMPTS,
    base_delay: float = BASE_DELAY_SEC,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    """Повторяет вызов при ProviderError(retryable) с экспоненциальной задержкой и jitter."""
    for attempt in range(1, attempts + 1):
        try:
            return await call()
        except ProviderError as exc:
            # При лимите запросов — один повтор: дальше голос возьмёт резервная модель.
            limit = min(attempts, RATE_LIMIT_ATTEMPTS) if exc.rate_limited else attempts
            if not exc.retryable or attempt >= limit:
                raise
            if exc.retry_after:
                delay = exc.retry_after
            elif exc.rate_limited:
                # Лимит запросов в минуту: короткие повторы бесполезны, ждём дольше.
                delay = min(RATE_LIMIT_DELAY_SEC * 2 ** (attempt - 1), MAX_RATE_LIMIT_DELAY_SEC)
            else:
                delay = min(base_delay * 2 ** (attempt - 1), MAX_DELAY_SEC)
            await sleep(delay + random.uniform(0, base_delay / 2))  # noqa: S311 — jitter
    raise AssertionError("unreachable")  # pragma: no cover


def retry_after_seconds(headers: Any) -> float | None:
    value = headers.get("retry-after") if headers is not None else None
    try:
        return min(float(value), MAX_RATE_LIMIT_DELAY_SEC) if value is not None else None
    except (TypeError, ValueError):
        return None
