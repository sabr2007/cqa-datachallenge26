"""Неизменяемые модели нормализованных данных."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

Channel = Literal["chat", "call"]
Speaker = Literal["client", "operator", "bot", "system"]

SPEAKERS: tuple[Speaker, ...] = ("client", "operator", "bot", "system")


@dataclass(frozen=True, slots=True)
class Message:
    index: int
    timestamp: str  # исходная строка из источника, без изменений
    offset_sec: float  # секунды от первой реплики
    speaker: Speaker
    text: str


@dataclass(frozen=True, slots=True)
class Conversation:
    conversation_id: str
    channel: Channel
    language: str
    messages: tuple[Message, ...]
    # Подписанная ссылка источника: не отдаётся клиенту и не печатается в repr/логах.
    audio_source_url: str | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class SkippedRecord:
    position: int
    conversation_id: str | None
    reason: str


@dataclass(frozen=True, slots=True)
class Dataset:
    group_id: str
    conversations: tuple[Conversation, ...]
    fetched_at: datetime
    skipped: tuple[SkippedRecord, ...] = ()

    def find(self, conversation_id: str) -> Conversation | None:
        return next((c for c in self.conversations if c.conversation_id == conversation_id), None)
