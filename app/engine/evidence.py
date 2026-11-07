"""Проверка доказательств кодом: реплика существует, цитата нечётко входит в её текст.

Модели часто ошибаются индексом на ±1 — если цитата дословно находится в другой
реплике, индекс исправляется (verified=true, corrected_from=<исходный индекс>).
"""

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher

from app.models import Message

MATCH_THRESHOLD = 0.85
MIN_BLOCK = 4  # совпадения короче — случайные буквы, не цитата
ACTOR_SPEAKERS = frozenset({"operator", "system"})
QUOTE_FALLBACK_CHARS = 160

_QUOTES = re.compile(r"[«»\"“”„'’`]")
_DASHES = re.compile(r"[‐-―−]")
_SPACES = re.compile(r"\s+")
_ELLIPSIS = re.compile(r"\.\.\.|…")


@dataclass(frozen=True, slots=True)
class CheckedEvidence:
    index: int
    quote: str
    verified: bool
    corrected_from: int | None = None

    def as_dict(self) -> dict[str, object]:
        item: dict[str, object] = {
            "index": self.index,
            "quote": self.quote,
            "verified": self.verified,
        }
        if self.corrected_from is not None:
            item["corrected_from"] = self.corrected_from
        return item


@dataclass(frozen=True, slots=True)
class EvidenceCheck:
    items: tuple[CheckedEvidence, ...]
    problems: tuple[str, ...]  # что не так — текст для повторного запроса к модели

    @property
    def ok(self) -> bool:
        return not self.problems


def normalize(text: str) -> str:
    text = text.lower().replace("ё", "е")
    text = _QUOTES.sub("", text)
    text = _DASHES.sub("-", text)
    text = text.replace(" / ", " ")
    text = _SPACES.sub(" ", text)
    return text.strip(" .,!?:;-")


def quote_score(quote: str, text: str) -> float:
    """Доля символов цитаты, найденных в тексте реплики (1.0 — точное вхождение)."""
    q, t = normalize(quote), normalize(text)
    if not q or not t:
        return 0.0
    if q in t:
        return 1.0
    parts = [p.strip(" .,!?:;-") for p in _ELLIPSIS.split(q)]
    parts = [p for p in parts if p]
    if len(parts) > 1 and all(p in t for p in parts):
        return 1.0
    matcher = SequenceMatcher(None, q, t, autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks() if block.size >= MIN_BLOCK)
    return matched / len(q)


def check_evidence(
    raw_items: Iterable[object],
    messages: Sequence[Message],
    *,
    verdict: str | None,
) -> EvidenceCheck:
    items: list[CheckedEvidence] = []
    problems: list[str] = []
    for raw in raw_items:
        index, quote = _parse_item(raw)
        if quote is None:
            if index is not None and 0 <= index < len(messages):
                # Реплика указана без цитаты: показываем её начало, выдумывать нечего.
                text = messages[index].text.strip()
                items.append(CheckedEvidence(index, text[:QUOTE_FALLBACK_CHARS], verified=True))
            continue
        checked = _locate(index, quote, messages)
        if checked is None:
            where = f"в реплике [{index}]" if index is not None else "в транскрипте"
            problems.append(f"цитата «{quote[:80]}» не найдена {where}")
            if index is not None and 0 <= index < len(messages):
                items.append(CheckedEvidence(index, quote, verified=False))
            continue
        items.append(checked)
    items = _dedupe(items)
    if (
        verdict not in (None, "na")
        and items
        and all(messages[item.index].speaker not in ACTOR_SPEAKERS for item in items)
    ):
        problems.append(
            "доказательство должно включать реплику оператора (или системное событие), "
            "а приведены только реплики клиента/бота"
        )
    return EvidenceCheck(tuple(items), tuple(problems))


def _locate(index: int | None, quote: str, messages: Sequence[Message]) -> CheckedEvidence | None:
    in_range = index is not None and 0 <= index < len(messages)
    if in_range and quote_score(quote, messages[index].text) >= MATCH_THRESHOLD:
        return CheckedEvidence(index, quote, verified=True)
    best_index, best_score = None, 0.0
    for message in messages:
        score = quote_score(quote, message.text)
        nearer = (
            best_index is not None
            and score == best_score
            and index is not None
            and abs(message.index - index) < abs(best_index - index)
        )
        if score > best_score or nearer:
            best_index, best_score = message.index, score
    if best_index is not None and best_score >= MATCH_THRESHOLD:
        return CheckedEvidence(best_index, quote, verified=True, corrected_from=index)
    return None


def _parse_item(raw: object) -> tuple[int | None, str | None]:
    if not isinstance(raw, dict):
        return None, None
    index = raw.get("index")
    quote = raw.get("quote")
    if isinstance(index, bool) or not isinstance(index, int):
        index = int(index) if isinstance(index, str) and index.strip().isdigit() else None
    if not isinstance(quote, str) or not quote.strip():
        return index, None
    return index, quote.strip()


def _dedupe(items: list[CheckedEvidence]) -> list[CheckedEvidence]:
    seen: set[tuple[int, str]] = set()
    unique = []
    for item in items:
        key = (item.index, normalize(item.quote))
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique
