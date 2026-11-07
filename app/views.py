"""Представление нормализованных данных в формате контракта API."""

from collections import Counter
from collections.abc import Mapping
from datetime import UTC
from typing import Any

from app.models import SPEAKERS, Conversation, Dataset, Message

PREVIEW_MAX_CHARS = 140
_ELLIPSIS = "…"


def dataset_listing(
    dataset: Dataset, evaluations: Mapping[str, dict[str, Any]] | None = None
) -> dict[str, Any]:
    """evaluations — {conversation_id: сводка последней оценки}; у неоценённых — null."""
    summaries = evaluations or {}
    items = [
        {**conversation_list_item(c), "evaluation": summaries.get(c.conversation_id)}
        for c in dataset.conversations
    ]
    return {
        "group_id": dataset.group_id,
        "total": len(items),
        "fetched_at": dataset.fetched_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "items": items,
    }


def conversation_list_item(conversation: Conversation) -> dict[str, Any]:
    speakers = Counter(message.speaker for message in conversation.messages)
    return {
        "conversation_id": conversation.conversation_id,
        "channel": conversation.channel,
        "language": conversation.language,
        "message_count": len(conversation.messages),
        "counts": {speaker: speakers[speaker] for speaker in SPEAKERS},
        "duration_sec": duration_sec(conversation.messages),
        "preview": make_preview(conversation.messages),
        "has_audio": conversation.audio_source_url is not None,
    }


def conversation_detail(conversation: Conversation, group_id: str) -> dict[str, Any]:
    audio = (
        {"url": audio_path(group_id, conversation.conversation_id)}
        if conversation.audio_source_url is not None
        else None
    )
    return {
        "conversation_id": conversation.conversation_id,
        "channel": conversation.channel,
        "language": conversation.language,
        "audio": audio,
        "messages": [message_view(message) for message in conversation.messages],
    }


def audio_path(group_id: str, conversation_id: str) -> str:
    """Путь к аудио-прокси бэкенда (id уже провалидированы, экранирование не нужно)."""
    return f"/api/datasets/{group_id}/conversations/{conversation_id}/audio"


def duration_sec(messages: tuple[Message, ...]) -> float | None:
    if not messages:
        return None
    offsets = [message.offset_sec for message in messages]
    return round(max(offsets) - min(offsets), 3)


def make_preview(messages: tuple[Message, ...]) -> str:
    """Первая реплика клиента в одну строку, не длиннее PREVIEW_MAX_CHARS."""
    first = next((m.text for m in messages if m.speaker == "client"), "")
    collapsed = " ".join(first.split())
    if len(collapsed) <= PREVIEW_MAX_CHARS:
        return collapsed
    return collapsed[: PREVIEW_MAX_CHARS - len(_ELLIPSIS)].rstrip() + _ELLIPSIS


def message_view(message: Message) -> dict[str, Any]:
    return {
        "index": message.index,
        "timestamp": message.timestamp,
        "offset_sec": message.offset_sec,
        "speaker": message.speaker,
        "text": message.text,
    }
