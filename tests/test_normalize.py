import copy
from datetime import UTC, datetime
from typing import Any

import pytest

from app.models import Dataset, Message
from app.normalize import normalize_record, normalize_records
from app.views import (
    PREVIEW_MAX_CHARS,
    conversation_detail,
    conversation_list_item,
    dataset_listing,
    make_preview,
)
from tests.support import load_payload


def records() -> list[dict[str, Any]]:
    return load_payload()["data"]["records"]


def by_id(conversation_id: str) -> dict[str, Any]:
    return next(r for r in records() if r["conversation_id"] == conversation_id)


def test_chat_record_is_normalized_with_raw_timestamps_kept() -> None:
    conversation = normalize_record(by_id("p1-ru-001"))

    assert conversation.channel == "chat"
    assert conversation.language == "RU"
    assert conversation.audio_source_url is None
    assert conversation.messages[0] == Message(
        index=0,
        timestamp="00:00",
        offset_sec=0.0,
        speaker="client",
        text="Где посмотреть мой тариф? В приложении не нахожу.",
    )
    assert conversation.messages[-1].timestamp == "02:04"
    assert conversation.messages[-1].offset_sec == 124.0


def test_call_record_keeps_audio_source_but_hides_it_from_repr() -> None:
    conversation = normalize_record(by_id("test-call-001"))

    assert conversation.channel == "call"
    assert conversation.audio_source_url is not None
    assert "sig" not in repr(conversation)


def test_normalization_does_not_mutate_input() -> None:
    raw = records()
    snapshot = copy.deepcopy(raw)

    normalize_records(raw)

    assert raw == snapshot


def test_language_channel_and_speaker_are_normalized_case_insensitively() -> None:
    raw = {
        **by_id("p1-kz-001"),
        "language": " kz ",
        "channel": "Agent Chat",
        "transcript": [{"timestamp": "00:00", "speaker": " Client", "text": "Сәлем"}],
    }

    conversation = normalize_record(raw)

    assert (conversation.language, conversation.channel) == ("KZ", "chat")
    assert conversation.messages[0].speaker == "client"


def _break(field: str, value: Any) -> dict[str, Any]:
    return {**by_id("p1-ru-001"), "conversation_id": "broken-1", field: value}


def _break_message(**changes: Any) -> dict[str, Any]:
    record = by_id("p1-ru-001")
    transcript = [{**record["transcript"][0], **changes}, *record["transcript"][1:]]
    return {**record, "conversation_id": "broken-1", "transcript": transcript}


@pytest.mark.parametrize(
    "broken",
    [
        "not a record",
        _break("conversation_id", None),
        _break("conversation_id", "bad id/1"),
        _break("channel", "fax"),
        _break("language", "DE"),
        _break("transcript", None),
        _break("transcript", ["not a message"]),
        _break_message(speaker="manager"),
        _break_message(text=None),
        _break_message(timestamp=17),
        _break_message(timestamp="soon"),
        _break_message(timestamp="2026-11-03T15:49:13+00:00"),  # ISO среди MM:SS
    ],
)
def test_broken_record_is_skipped_and_others_are_kept(broken: object) -> None:
    raw = [*records(), broken]

    conversations, skipped = normalize_records(raw)

    assert [c.conversation_id for c in conversations] == ["p1-ru-001", "p1-kz-001", "test-call-001"]
    assert len(skipped) == 1
    assert skipped[0].position == 3
    assert skipped[0].reason


def test_duplicate_conversation_id_keeps_first_record() -> None:
    raw = [*records(), {**by_id("p1-ru-001"), "language": "EN"}]

    conversations, skipped = normalize_records(raw)

    assert len(conversations) == 3
    assert conversations[0].language == "RU"
    assert skipped[0].conversation_id == "p1-ru-001"


@pytest.mark.parametrize(
    "audio_url", ["", "http://insecure.example.com/a", "javascript:alert(1)", 42]
)
def test_unusable_audio_url_is_dropped_without_dropping_record(audio_url: object) -> None:
    conversation = normalize_record({**by_id("test-call-001"), "audio_url": audio_url})

    assert conversation.audio_source_url is None


def test_list_item_matches_contract_for_chat() -> None:
    item = conversation_list_item(normalize_record(by_id("p1-ru-001")))

    assert item == {
        "conversation_id": "p1-ru-001",
        "channel": "chat",
        "language": "RU",
        "message_count": 12,
        "counts": {"client": 4, "operator": 2, "bot": 5, "system": 1},
        "duration_sec": 124.0,
        "preview": "Где посмотреть мой тариф? В приложении не нахожу.",
        "has_audio": False,
    }


def test_list_item_for_call_has_audio_and_fractional_duration() -> None:
    item = conversation_list_item(normalize_record(by_id("test-call-001")))

    assert item["channel"] == "call"
    assert item["has_audio"] is True
    assert item["duration_sec"] == 112.31
    assert item["preview"] == "Здравствуйте, это тестовый звонок про комиссию за перевод."


def test_list_item_for_empty_transcript_has_null_duration_and_empty_preview() -> None:
    item = conversation_list_item(normalize_record({**by_id("p1-ru-001"), "transcript": []}))

    assert item["duration_sec"] is None
    assert item["preview"] == ""
    assert item["counts"] == {"client": 0, "operator": 0, "bot": 0, "system": 0}


def test_long_preview_is_truncated_with_ellipsis() -> None:
    long_text = "слово " * 60
    messages = (
        Message(index=0, timestamp="00:00", offset_sec=0.0, speaker="client", text=long_text),
    )

    preview = make_preview(messages)

    assert len(preview) <= PREVIEW_MAX_CHARS
    assert preview.endswith("…")


def test_detail_contains_messages_and_audio_proxy_path() -> None:
    detail = conversation_detail(normalize_record(by_id("test-call-001")), "DEV")

    assert detail["audio"] == {"url": "/api/datasets/DEV/conversations/test-call-001/audio"}
    assert [m["index"] for m in detail["messages"]] == [0, 1, 2, 3, 4]
    assert [m["offset_sec"] for m in detail["messages"]] == [0.0, 0.084, 9.227, 16.81, 112.31]
    assert detail["messages"][0]["timestamp"] == "2026-11-03T15:49:13.1900670+00:00"
    assert "sig=" not in str(detail)


def test_dataset_listing_formats_fetched_at_as_utc_iso() -> None:
    conversations, _ = normalize_records(records())
    fetched_at = datetime(2026, 11, 7, 12, 0, 5, tzinfo=UTC)

    listing = dataset_listing(Dataset("DEV", conversations, fetched_at))

    assert listing["fetched_at"] == "2026-11-07T12:00:05Z"
    assert listing["total"] == 3
