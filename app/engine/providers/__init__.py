"""Каталог моделей, доступность по ключам окружения и создание провайдеров."""

from collections.abc import AsyncIterator, Iterable, Mapping
from contextlib import asynccontextmanager
from typing import Any

from app.engine.providers.anthropic_claude import OPUS_5_5_PRICE, AnthropicProvider
from app.engine.providers.base import (
    CompletionRequest,
    CompletionResult,
    ModelSpec,
    Provider,
    ProviderError,
    Usage,
)
from app.engine.providers.cloudflare import USD_PER_1K_NEURONS, CloudflareProvider
from app.engine.providers.ollama import MODEL_PREFIX as OLLAMA_PREFIX
from app.engine.providers.ollama import OllamaProvider
from app.engine.settings import EngineSettings, env_value, load_engine_settings

CLAUDE_MODEL = "claude-opus-5-5"
GLM = "@cf/zai-org/glm-5.3"
DEEPSEEK = "@cf/deepseek-ai/deepseek-v4-pro-0813"
KIMI = "@cf/moonshotai/kimi-k2.7-code"
QWEN = "@cf/qwen/qwen3.8-27b"

_CLAUDE_PRICE = {"unit": "tokens", "currency": "USD", **OPUS_5_5_PRICE}
_CF_PRICE = {"unit": "neurons", "currency": "USD", "usd_per_1k_neurons": USD_PER_1K_NEURONS}
_FREE = {"unit": "local", "currency": "USD"}

# reasoning_effort: у GLM по умолчанию max, у Qwen — xhigh; это 20–50 с на критерий.
# «low» укладывает оценку диалога в 90 с; точность сравнивается в eval/runs.
_LOW_EFFORT = {"reasoning_effort": "low"}

# approx_usd_per_evaluation — средняя стоимость оценки одного чата этой моделью (8 критериев),
# замерено на 40 настроечных чатах DEV (eval/runs). Итоговая стоимость — cost_usd оценки.
CATALOG: tuple[ModelSpec, ...] = (
    ModelSpec(
        CLAUDE_MODEL,
        "anthropic",
        "Claude Opus 5.5",
        {**_CLAUDE_PRICE, "approx_usd_per_evaluation": 0.11},
        prompt_cache=True,
    ),
    ModelSpec(
        GLM,
        "cloudflare",
        "GLM-5.3 · Workers AI",
        {**_CF_PRICE, "approx_usd_per_evaluation": 0.021},
        options=_LOW_EFFORT,
    ),
    ModelSpec(
        DEEPSEEK,
        "cloudflare",
        "DeepSeek V4 Pro · Workers AI",
        {**_CF_PRICE, "approx_usd_per_evaluation": 0.042},
        options=_LOW_EFFORT,
    ),
    ModelSpec(
        KIMI,
        "cloudflare",
        "Kimi K2.7 Code · Workers AI",
        {**_CF_PRICE, "approx_usd_per_evaluation": 0.036},
    ),
    ModelSpec(
        QWEN,
        "cloudflare",
        "Qwen3.8 27B · Workers AI",
        {**_CF_PRICE, "approx_usd_per_evaluation": 0.026},
        options=_LOW_EFFORT,
    ),
)


# Набор по умолчанию, если CQA_MODELS не задан (подбирается по точности на эталоне).
# Порядок — приоритет при ничьей. Выбор по eval/runs: Claude+GLM+Qwen — лучшая точность
# на настроечных чатах при задержке в пределах 90 с; без ключа Claude — три открытые модели.
DEFAULT_WITH_CLAUDE = (CLAUDE_MODEL, GLM, QWEN)
DEFAULT_OPEN = (DEEPSEEK, QWEN, GLM)

__all__ = [
    "CATALOG",
    "CompletionRequest",
    "CompletionResult",
    "ModelSpec",
    "Provider",
    "ProviderError",
    "Usage",
    "default_models",
    "is_available",
    "list_models",
    "open_providers",
    "resolve_spec",
]


def resolve_spec(model_id: str, settings: EngineSettings | None = None) -> ModelSpec | None:
    """Спецификация модели по id: из каталога, любая @cf/… или ollama/…; иначе None."""
    for spec in CATALOG:
        if spec.id == model_id:
            return spec
    if model_id.startswith("@cf/"):
        return ModelSpec(
            model_id, "cloudflare", f"{model_id.removeprefix('@cf/')} · Workers AI", _CF_PRICE
        )
    if model_id.startswith(OLLAMA_PREFIX):
        return ModelSpec(
            model_id, "ollama", f"{model_id.removeprefix(OLLAMA_PREFIX)} · Ollama", _FREE
        )
    return None


def is_available(spec: ModelSpec, settings: EngineSettings | None = None) -> bool:
    resolved = settings or load_engine_settings()
    if spec.provider == "anthropic":
        return env_value("ANTHROPIC_API_KEY") is not None
    if spec.provider == "cloudflare":
        return (
            env_value("CLOUDFLARE_ACCOUNT_ID") is not None
            and env_value("CLOUDFLARE_API_TOKEN") is not None
        )
    if spec.provider == "ollama":
        return spec.id.removeprefix(OLLAMA_PREFIX) in resolved.ollama_models
    return False


def default_models(settings: EngineSettings | None = None) -> list[str]:
    """Модели для evaluate_conversation(models=None): CQA_MODELS или набор по доступности."""
    resolved = settings or load_engine_settings()
    configured = [
        model_id
        for model_id in resolved.models
        if (spec := resolve_spec(model_id, resolved)) is not None and is_available(spec, resolved)
    ]
    if configured:
        return list(dict.fromkeys(configured))
    claude = resolve_spec(CLAUDE_MODEL, resolved)
    preset = DEFAULT_WITH_CLAUDE if claude and is_available(claude, resolved) else DEFAULT_OPEN
    return [
        model_id
        for model_id in preset
        if (spec := resolve_spec(model_id, resolved)) is not None and is_available(spec, resolved)
    ]


def list_models(settings: EngineSettings | None = None) -> list[dict[str, Any]]:
    """[{id, provider, label, available, default, price}] — для /api/models."""
    resolved = settings or load_engine_settings()
    specs = list(CATALOG)
    extra_ids = [*resolved.models, *(OLLAMA_PREFIX + name for name in resolved.ollama_models)]
    for model_id in extra_ids:
        spec = resolve_spec(model_id, resolved)
        if spec is not None and all(existing.id != spec.id for existing in specs):
            specs.append(spec)
    defaults = set(default_models(resolved))
    return [
        {
            "id": spec.id,
            "provider": spec.provider,
            "label": spec.label,
            "available": is_available(spec, resolved),
            "default": spec.id in defaults,
            "price": dict(spec.price),
        }
        for spec in specs
    ]


@asynccontextmanager
async def open_providers(
    names: Iterable[str],
    settings: EngineSettings,
    *,
    overrides: Mapping[str, Provider] | None = None,
) -> AsyncIterator[dict[str, Provider]]:
    """Создаёт провайдеры на время одной оценки и закрывает их клиенты после неё."""
    providers: dict[str, Provider] = {}
    owned: list[Provider] = []
    try:
        for name in dict.fromkeys(names):
            if overrides and name in overrides:
                providers[name] = overrides[name]
                continue
            provider = _create(name, settings)
            providers[name] = provider
            owned.append(provider)
        yield providers
    finally:
        for provider in owned:
            await provider.aclose()


def _create(name: str, settings: EngineSettings) -> Provider:
    if name == "anthropic":
        key = env_value("ANTHROPIC_API_KEY")
        if key is None:
            raise ProviderError("ANTHROPIC_API_KEY не задан")
        return AnthropicProvider(key, effort=settings.claude_effort)
    if name == "cloudflare":
        account, token = env_value("CLOUDFLARE_ACCOUNT_ID"), env_value("CLOUDFLARE_API_TOKEN")
        if account is None or token is None:
            raise ProviderError("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN не заданы")
        return CloudflareProvider(account, token)
    if name == "ollama":
        return OllamaProvider(settings.ollama_host)
    raise ProviderError(f"неизвестный провайдер {name}")
