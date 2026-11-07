from datetime import UTC, datetime

import pytest

from app.timestamps import TimestampError, compute_offsets, parse_clock, parse_iso


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("00:00", 0),
        ("00:28", 28),
        ("01:05", 65),
        ("14:07", 847),
        ("120:00", 7200),
        (" 02:04 ", 124),
        ("1:02:03", 3723),
    ],
)
def test_parse_clock_converts_mm_ss_to_seconds(raw: str, expected: int) -> None:
    assert parse_clock(raw) == expected


@pytest.mark.parametrize("raw", ["", "1:5", "00:60", "aa:bb", "00-28", "1:60:00", "2026-11-03"])
def test_parse_clock_rejects_other_formats(raw: str) -> None:
    assert parse_clock(raw) is None


def test_parse_iso_accepts_seven_fraction_digits_with_timezone() -> None:
    parsed = parse_iso("2026-11-03T15:49:13.1900670+00:00")

    assert parsed == datetime(2026, 11, 3, 15, 49, 13, 190067, tzinfo=UTC)


def test_parse_iso_treats_naive_timestamp_as_utc() -> None:
    assert parse_iso("2026-11-03T15:49:13") == datetime(2026, 11, 3, 15, 49, 13, tzinfo=UTC)


@pytest.mark.parametrize("raw", ["00:28", "", "yesterday", "2026-13-45T00:00:00"])
def test_parse_iso_returns_none_for_non_iso(raw: str) -> None:
    assert parse_iso(raw) is None


def test_chat_offsets_are_seconds_from_first_message() -> None:
    assert compute_offsets(["00:00", "00:02", "01:15", "02:04"]) == (0.0, 2.0, 75.0, 124.0)


def test_call_offsets_are_iso_differences_from_first_message() -> None:
    timestamps = [
        "2026-11-03T15:49:13.1900670+00:00",
        "2026-11-03T15:49:13.2744711+00:00",
        "2026-11-03T15:49:22.4171535+00:00",
        "2026-11-03T20:51:05.5+05:00",  # другой пояс: 15:51:05.5 UTC
    ]

    assert compute_offsets(timestamps) == (0.0, 0.084, 9.227, 112.31)


def test_offsets_are_empty_for_empty_transcript() -> None:
    assert compute_offsets([]) == ()


def test_unparseable_timestamp_reports_message_index() -> None:
    with pytest.raises(TimestampError, match="реплика 1"):
        compute_offsets(["00:00", "soon", "00:05"])


def test_mixed_timestamp_kinds_are_rejected() -> None:
    with pytest.raises(TimestampError, match="разного вида"):
        compute_offsets(["00:00", "2026-11-03T15:49:13+00:00"])
