"""Общие данные тестов движка: диалог, чек-лист, поддельный провайдер (без сети)."""

import json
import re
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from app.engine.providers.base import CompletionResult, ModelSpec, ProviderError, Usage
from app.models import Conversation, Message

ROOT = Path(__file__).resolve().parents[2]
CHECKLIST_PATH = ROOT / "config" / "checklists" / "chat-default.json"

GLM = "@cf/zai-org/glm-5.3"
DEEPSEEK = "@cf/deepseek-ai/deepseek-v4-pro-0813"
KIMI = "@cf/moonshotai/kimi-k2.7-code"
CLAUDE = "claude-opus-5-5"

RUDE_CHAT = [
    ("00:00", "client", "Почему опять не могу найти вход? На вашем сайте всё перелопатил."),
    ("00:02", "bot", "Здравствуйте! Я AIM, AI-ассистент Freedom Broker."),
    ("00:08", "bot", "Если вы на информационном сайте, попробуйте открыть торговую платформу."),
    ("00:24", "client", "Дайте человека, пожалуйста, уже надоело."),
    ("00:39", "bot", "Пожалуйста, ожидайте. Оператор скоро подключится к чату."),
    ("00:42", "system", "Эскалация на оператора."),
    ("01:23", "operator", "Здравствуйте, я Алексей. Вы вообще читать умеете? Бот всё написал."),
    ("01:52", "client", "Не понимаю, на какой сайт перейти."),
    ("02:15", "operator", "Откройте tradernet.global, там вход в веб-версию."),
    ("02:54", "client", "Вошёл. Но со мной так говорить не надо."),
    ("03:26", "operator", "До свидания."),
]


def load_checklist() -> dict[str, Any]:
    return json.loads(CHECKLIST_PATH.read_text(encoding="utf-8"))


def make_conversation(
    rows: list[tuple[str, str, str]] | None = None,
    *,
    conversation_id: str = "test-ru-001",
    language: str = "RU",
) -> Conversation:
    messages = []
    for index, (timestamp, speaker, text) in enumerate(RUDE_CHAT if rows is None else rows):
        minutes, seconds = timestamp.split(":")
        messages.append(
            Message(
                index=index,
                timestamp=timestamp,
                offset_sec=float(int(minutes) * 60 + int(seconds)),
                speaker=speaker,  # type: ignore[arg-type]
                text=text,
            )
        )
    return Conversation(
        conversation_id=conversation_id, channel="chat", language=language, messages=tuple(messages)
    )


def verdict(
    value: str,
    *,
    evidence: list[tuple[int, str]] | None = None,
    explanation: str = "Пояснение по [6].",
    checked_range: list[int] | None = None,
    na_reason: str = "",
) -> dict[str, Any]:
    return {
        "applicable": value != "na",
        "applicability_reason": "",
        "evidence": [{"index": i, "quote": q} for i, q in (evidence or [])],
        "reasoning": "рассуждение",
        "verdict": value,
        "checked_range": checked_range or [],
        "na_reason": na_reason,
        "explanation": explanation,
    }


Script = Mapping[tuple[str, str], list[dict[str, Any] | Exception]]


class FakeProvider:
    """Отвечает заранее заданными JSON по (модель, критерий); повторный вызов — следующий ответ."""

    def __init__(
        self,
        script: Script,
        *,
        name: str = "cloudflare",
        default: Callable[[str, str], dict[str, Any]] | None = None,
        delay: float = 0.0,
    ) -> None:
        self.name = name
        self.script = {key: list(value) for key, value in script.items()}
        self.default = default or (lambda model, criterion: verdict("yes"))
        self.delay = delay
        self.calls: list[tuple[str, str, Any]] = []
        self.closed = False

    async def complete(self, spec: ModelSpec, request: Any, *, on_start=None) -> CompletionResult:
        if on_start is not None:
            on_start()
        criterion_id = re.search(r"Критерий (\S+) —", request.suffix).group(1)
        self.calls.append((spec.id, criterion_id, request))
        if self.delay:
            import asyncio

            await asyncio.sleep(self.delay)
        queue = self.script.get((spec.id, criterion_id))
        item = (
            (queue.pop(0) if len(queue) > 1 else queue[0])
            if queue
            else self.default(spec.id, criterion_id)
        )
        if isinstance(item, Exception):
            raise item
        return CompletionResult(
            model=spec.id,
            text=json.dumps(item, ensure_ascii=False),
            data=item,
            usage=Usage(input_tokens=1000, output_tokens=100, cost_usd=0.001),
            latency_ms=3,
        )

    async def aclose(self) -> None:
        self.closed = True


def provider_error(message: str = "сбой", retryable: bool = False) -> ProviderError:
    return ProviderError(message, retryable=retryable)
