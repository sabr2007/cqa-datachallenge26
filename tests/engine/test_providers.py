"""Провайдеры моделей без сети: тело запроса, разбор ответа, ретраи, стоимость, каталог."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from app.engine import providers as registry
from app.engine.providers.anthropic_claude import AnthropicProvider, build_params, claude_usage
from app.engine.providers.base import (
    CompletionRequest,
    ModelSpec,
    ProviderError,
    parse_json_object,
    with_retries,
)
from app.engine.providers.cloudflare import CloudflareProvider
from app.engine.settings import load_engine_settings

REQUEST = CompletionRequest(
    system="инструкции", prefix="транскрипт", suffix="критерий", schema={"type": "object"}
)
GLM = ModelSpec("@cf/zai-org/glm-5.3", "cloudflare", "GLM", options={"reasoning_effort": "low"})


def cf_payload(content: str = '{"verdict": "yes"}') -> dict:
    return {
        "success": True,
        "result": {
            "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "neurons": 1000.0},
        },
    }


def run_cf(handler) -> tuple[object, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request, len(seen))

    async def go():
        provider = CloudflareProvider(
            "acc123", "secret-token", transport=httpx.MockTransport(recording)
        )
        try:
            return await provider.complete(GLM, REQUEST)
        finally:
            await provider.aclose()

    return asyncio.run(go()), seen


def test_cloudflare_request_shape_and_cost(monkeypatch):
    monkeypatch.setattr("app.engine.providers.base.asyncio.sleep", _no_sleep)
    result, seen = run_cf(lambda request, n: httpx.Response(200, json=cf_payload()))

    request = seen[0]
    body = json.loads(request.content)
    assert (
        str(request.url)
        == "https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/zai-org/glm-5.3"
    )
    assert request.headers["authorization"] == "Bearer secret-token"
    assert body["messages"][0] == {"role": "system", "content": "инструкции"}
    assert body["messages"][1]["content"] == "транскрипт\n\nкритерий"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["reasoning_effort"] == "low"
    assert result.data == {"verdict": "yes"}
    assert result.usage.neurons == 1000.0
    assert result.usage.cost_usd == pytest.approx(0.011)


def test_cloudflare_retries_on_429_then_succeeds(monkeypatch):
    monkeypatch.setattr("app.engine.providers.base.asyncio.sleep", _no_sleep)

    def handler(request, n):
        if n == 1:
            return httpx.Response(429, json={"success": False, "errors": [{"message": "rate"}]})
        return httpx.Response(200, json=cf_payload())

    result, seen = run_cf(handler)

    assert len(seen) == 2
    assert result.data == {"verdict": "yes"}


def test_cloudflare_client_error_is_not_retried_and_hides_token(monkeypatch):
    monkeypatch.setattr("app.engine.providers.base.asyncio.sleep", _no_sleep)

    with pytest.raises(ProviderError) as error:
        run_cf(lambda request, n: httpx.Response(400, json={"errors": [{"message": "bad schema"}]}))

    assert "bad schema" in str(error.value)
    assert "secret-token" not in str(error.value)
    assert error.value.retryable is False


def test_cloudflare_empty_content_is_retryable_error(monkeypatch):
    monkeypatch.setattr("app.engine.providers.base.asyncio.sleep", _no_sleep)

    with pytest.raises(ProviderError) as error:
        run_cf(lambda request, n: httpx.Response(200, json=cf_payload("")))

    assert error.value.retryable is True


def test_parse_json_object_tolerates_fences_and_noise():
    assert parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_object('Ответ: {"a": 2} конец') == {"a": 2}
    assert parse_json_object("[1, 2]") is None
    assert parse_json_object("не json") is None


def test_with_retries_stops_on_non_retryable():
    calls = []

    async def call():
        calls.append(1)
        raise ProviderError("нет", retryable=False)

    with pytest.raises(ProviderError):
        asyncio.run(with_retries(call, sleep=_no_sleep))
    assert len(calls) == 1


class FakeStream:
    def __init__(self, message):
        self.message = message
        self.events = ["message_start", "content_block_delta"]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        async def gen():
            for event in self.events:
                yield event

        return gen()

    async def get_final_message(self):
        return self.message


class FakeAnthropicClient:
    def __init__(self, message):
        self.params = None
        message_api = SimpleNamespace(stream=self._stream)
        self.beta = SimpleNamespace(messages=message_api)
        self._message = message

    def _stream(self, **params):
        self.params = params
        return FakeStream(self._message)


def claude_message(text='{"verdict": "no"}', stop_reason="end_turn"):
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[
            SimpleNamespace(type="thinking", thinking=""),
            SimpleNamespace(type="text", text=text),
        ],
        usage=SimpleNamespace(
            input_tokens=200,
            output_tokens=300,
            cache_read_input_tokens=3000,
            cache_creation_input_tokens=0,
        ),
    )


def test_claude_request_uses_structured_output_effort_cache_and_fallback():
    client = FakeAnthropicClient(claude_message())
    provider = AnthropicProvider("key", effort="medium", client=client)
    spec = registry.resolve_spec("claude-opus-5-5")
    started = []

    result = asyncio.run(provider.complete(spec, REQUEST, on_start=lambda: started.append(True)))

    params = client.params
    assert params["model"] == "claude-opus-5-5"
    assert params["output_config"] == {
        "effort": "medium",
        "format": {"type": "json_schema", "schema": {"type": "object"}},
    }
    content = params["messages"][0]["content"]
    assert content[0] == {
        "type": "text",
        "text": "транскрипт",
        "cache_control": {"type": "ephemeral"},
    }
    assert content[1] == {"type": "text", "text": "критерий"}
    assert params["fallbacks"] == "default"
    assert "thinking" not in params  # у Opus 5.5 adaptive по умолчанию, отключить нельзя
    assert result.data == {"verdict": "no"}
    assert started  # кеш прогрет — остальные запросы могут стартовать
    # 200·4 + 300·20 + 3000·0,2 = 7400 мкдолл.
    assert result.usage.cost_usd == pytest.approx(0.0074)
    assert result.usage.cache_read_tokens == 3000


def test_claude_refusal_is_an_error():
    provider = AnthropicProvider(
        "key", client=FakeAnthropicClient(claude_message(stop_reason="refusal"))
    )

    with pytest.raises(ProviderError, match="refusal"):
        asyncio.run(provider.complete(registry.resolve_spec("claude-opus-5-5"), REQUEST))


def test_build_params_and_usage_helpers():
    spec = registry.resolve_spec("claude-opus-5-5")
    params = build_params(spec, REQUEST, "high")
    usage = claude_usage(SimpleNamespace(input_tokens=1_000_000, output_tokens=0), spec.price)

    assert params["output_config"]["effort"] == "high"
    assert params["system"][0]["text"] == "инструкции"
    assert usage.cost_usd == pytest.approx(4.0)


def test_list_models_reports_availability_and_defaults(monkeypatch):
    env = {"CLOUDFLARE_ACCOUNT_ID": "a", "CLOUDFLARE_API_TOKEN": "t"}
    monkeypatch.setattr(registry, "env_value", lambda name: env.get(name))
    settings = load_engine_settings({})

    models = {m["id"]: m for m in registry.list_models(settings)}

    assert models["claude-opus-5-5"]["available"] is False
    assert models["@cf/zai-org/glm-5.3"]["available"] is True
    assert set(models["@cf/zai-org/glm-5.3"]) == {
        "id",
        "provider",
        "label",
        "available",
        "default",
        "price",
    }
    defaults = [m for m in models.values() if m["default"]]
    assert defaults and all(m["provider"] == "cloudflare" for m in defaults)
    assert registry.default_models(settings) == [m for m in registry.DEFAULT_OPEN]


def test_default_models_with_claude_key_and_env_override(monkeypatch):
    env = {"ANTHROPIC_API_KEY": "k", "CLOUDFLARE_ACCOUNT_ID": "a", "CLOUDFLARE_API_TOKEN": "t"}
    monkeypatch.setattr(registry, "env_value", lambda name: env.get(name))

    assert registry.default_models(load_engine_settings({}))[0] == "claude-opus-5-5"
    override = load_engine_settings({"CQA_MODELS": "@cf/qwen/qwen3.8-27b, unknown"})
    assert registry.default_models(override) == ["@cf/qwen/qwen3.8-27b"]


def test_engine_settings_cap_timeout_at_90_seconds():
    assert load_engine_settings({"CQA_EVAL_TIMEOUT_SEC": "300"}).eval_timeout_sec == 90.0
    assert load_engine_settings({"CQA_EVAL_TIMEOUT_SEC": "45"}).eval_timeout_sec == 45.0
    assert load_engine_settings({"CQA_CLAUDE_EFFORT": "turbo"}).claude_effort == "medium"


async def _no_sleep(_seconds: float) -> None:
    return None


def test_rate_limit_retries_once_after_longer_pause():
    delays: list[float] = []
    calls = []

    async def fake_sleep(seconds: float) -> None:
        delays.append(seconds)

    async def flaky():
        calls.append(1)
        if len(calls) < 2:
            raise ProviderError("429", rate_limited=True)
        return "ok"

    async def always_limited():
        calls.append(1)
        raise ProviderError("429", rate_limited=True)

    assert asyncio.run(with_retries(flaky, sleep=fake_sleep)) == "ok"
    assert len(delays) == 1 and delays[0] >= 4.0
    calls.clear()
    with pytest.raises(ProviderError):
        asyncio.run(with_retries(always_limited, sleep=fake_sleep))
    assert len(calls) == 2  # дальше голос возьмёт резервная модель


def test_early_stop_is_on_by_default_and_can_be_disabled():
    assert load_engine_settings({}).early_stop is True
    assert load_engine_settings({"CQA_EARLY_STOP": "0"}).early_stop is False
