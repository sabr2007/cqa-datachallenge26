"""Разбор меток времени реплик и расчёт смещения от первой реплики.

У чатов метка — время от начала чата `MM:SS` (на всякий случай понимаем и
`H:MM:SS`), у звонков — ISO 8601 с часовым поясом, например
`2026-11-03T15:49:13.1900670+00:00` (7 знаков дробной части Python 3.12
разбирает, лишний знак отбрасывается).
"""

import re
from collections.abc import Sequence
from datetime import UTC, datetime

_MM_SS = re.compile(r"(\d{1,3}):([0-5]\d)")
_H_MM_SS = re.compile(r"(\d{1,2}):([0-5]\d):([0-5]\d)")

OFFSET_DECIMALS = 3


class TimestampError(ValueError):
    """Метки времени в диалоге нельзя разобрать или они разного вида."""


def parse_clock(value: str) -> int | None:
    """`MM:SS` или `H:MM:SS` -> секунды; None, если строка не такого вида."""
    text = value.strip()
    if match := _MM_SS.fullmatch(text):
        return int(match[1]) * 60 + int(match[2])
    if match := _H_MM_SS.fullmatch(text):
        return int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3])
    return None


def parse_iso(value: str) -> datetime | None:
    """ISO 8601 -> aware datetime (метка без пояса считается UTC); None, если не ISO."""
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def compute_offsets(timestamps: Sequence[str]) -> tuple[float, ...]:
    """Секунды от первой реплики для каждой метки.

    Все метки диалога должны быть одного вида: только часы чата или только ISO.
    """
    if not timestamps:
        return ()
    clock = [parse_clock(ts) for ts in timestamps]
    if all(seconds is not None for seconds in clock):
        return tuple(_round(seconds - clock[0]) for seconds in clock)
    instants = [parse_iso(ts) for ts in timestamps]
    if all(instant is not None for instant in instants):
        return tuple(_round((instant - instants[0]).total_seconds()) for instant in instants)
    raise TimestampError(_describe_failure(timestamps, clock, instants))


def _round(seconds: float) -> float:
    return round(float(seconds), OFFSET_DECIMALS)


def _describe_failure(
    timestamps: Sequence[str],
    clock: Sequence[int | None],
    instants: Sequence[datetime | None],
) -> str:
    for index, (raw, seconds, instant) in enumerate(zip(timestamps, clock, instants, strict=True)):
        if seconds is None and instant is None:
            return f"реплика {index}: нераспознанная метка времени {raw[:40]!r}"
    return "метки времени разного вида (MM:SS вперемешку с ISO 8601)"
