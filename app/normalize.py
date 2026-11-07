"""Проверка и нормализация записей из API кейса.

Внешним данным не доверяем: каждая запись проверяется отдельно, битая запись
пропускается с причиной (её логирует вызывающий код), остальные остаются.
Входные объекты не изменяются — результат собирается из новых объектов.
"""

import logging
from collections.abc import Mapping, Sequence
from urllib.parse import urlsplit

from app.models import SPEAKERS, Channel, Conversation, Message, SkippedRecord, Speaker
from app.timestamps import TimestampError, compute_offsets
from app.validation import is_valid_id

logger = logging.getLogger("cqa.normalize")

CHANNELS: Mapping[str, Channel] = {
    "agent chat": "chat",
    "voice call": "call",
    "chat": "chat",
    "call": "call",
}
LANGUAGES = frozenset({"RU", "KZ", "EN"})
_SPEAKER_BY_NAME: Mapping[str, Speaker] = {speaker: speaker for speaker in SPEAKERS}


class RecordError(ValueError):
    """Запись не прошла проверку и будет пропущена."""


def normalize_records(
    raw_records: Sequence[object],
) -> tuple[tuple[Conversation, ...], tuple[SkippedRecord, ...]]:
    """Нормализует записи в исходном порядке; битые и повторные — в список пропущенных."""
    conversations: list[Conversation] = []
    skipped: list[SkippedRecord] = []
    seen_ids: set[str] = set()
    for position, raw in enumerate(raw_records):
        try:
            conversation = normalize_record(raw)
        except RecordError as exc:
            skipped.append(SkippedRecord(position, _raw_id(raw), str(exc)))
            continue
        if conversation.conversation_id in seen_ids:
            skipped.append(
                SkippedRecord(position, conversation.conversation_id, "повторный conversation_id")
            )
            continue
        seen_ids.add(conversation.conversation_id)
        conversations.append(conversation)
    return tuple(conversations), tuple(skipped)


def normalize_record(raw: object) -> Conversation:
    if not isinstance(raw, Mapping):
        raise RecordError("запись не является объектом")
    conversation_id = _conversation_id(raw.get("conversation_id"))
    transcript = raw.get("transcript")
    if not isinstance(transcript, list):
        raise RecordError("transcript не является списком")
    return Conversation(
        conversation_id=conversation_id,
        channel=_channel(raw.get("channel")),
        language=_language(raw.get("language")),
        messages=_messages(transcript),
        audio_source_url=_audio_url(raw.get("audio_url"), conversation_id),
    )


def _conversation_id(value: object) -> str:
    if not is_valid_id(value):
        raise RecordError("conversation_id отсутствует или содержит недопустимые символы")
    return str(value)


def _channel(value: object) -> Channel:
    channel = CHANNELS.get(value.strip().lower()) if isinstance(value, str) else None
    if channel is None:
        raise RecordError(f"неизвестный channel {_short(value)}")
    return channel


def _language(value: object) -> str:
    language = value.strip().upper() if isinstance(value, str) else None
    if language not in LANGUAGES:
        raise RecordError(f"неизвестный language {_short(value)}")
    return language


def _messages(transcript: Sequence[object]) -> tuple[Message, ...]:
    parts = [_message_parts(index, raw) for index, raw in enumerate(transcript)]
    try:
        offsets = compute_offsets([timestamp for timestamp, _, _ in parts])
    except TimestampError as exc:
        raise RecordError(str(exc)) from None
    return tuple(
        Message(index=index, timestamp=timestamp, offset_sec=offset, speaker=speaker, text=text)
        for index, ((timestamp, speaker, text), offset) in enumerate(
            zip(parts, offsets, strict=True)
        )
    )


def _message_parts(index: int, raw: object) -> tuple[str, Speaker, str]:
    if not isinstance(raw, Mapping):
        raise RecordError(f"реплика {index} не является объектом")
    timestamp, speaker, text = raw.get("timestamp"), raw.get("speaker"), raw.get("text")
    if not isinstance(timestamp, str):
        raise RecordError(f"реплика {index}: timestamp не строка")
    if not isinstance(text, str):
        raise RecordError(f"реплика {index}: text не строка")
    known = _SPEAKER_BY_NAME.get(speaker.strip().lower()) if isinstance(speaker, str) else None
    if known is None:
        raise RecordError(f"реплика {index}: неизвестный speaker {_short(speaker)}")
    return timestamp, known, text


def _audio_url(value: object, conversation_id: str) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        parts = urlsplit(value.strip())
        if parts.scheme == "https" and parts.hostname:
            return value.strip()
    logger.warning("Диалог %s: audio_url не https-ссылка, аудио пропущено", conversation_id)
    return None


def _raw_id(raw: object) -> str | None:
    value = raw.get("conversation_id") if isinstance(raw, Mapping) else None
    return value[:64] if isinstance(value, str) else None


def _short(value: object) -> str:
    return repr(value)[:40]
