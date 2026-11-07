"""Голосование моделей по критерию: большинство (для шкалы — медиана ступени).

confidence — доля голосов, совпавших с итоговым ответом. needs_review — если
нет уверенного большинства, спор «N/A против ответа», расхождение по флагу
грубой ошибки или у итогового ответа нет подтверждённых доказательств.
"""

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.engine.scoring import NA

MIN_CONFIDENCE = 0.6  # 2 из 3 проходит, 1 из 2 — нет


@dataclass(frozen=True, slots=True)
class Vote:
    model: str
    answer: str | int | float | None  # None — модель не дала валидного ответа
    evidence: tuple[dict[str, Any], ...] = ()
    explanation: str = ""
    checked_range: tuple[int, int] | None = None
    na_reason: str | None = None
    verified: bool = True  # доказательства прошли проверку кодом
    error: str | None = None
    attempts: int = 1
    meta: dict[str, Any] = field(default_factory=dict)
    skipped: bool = False  # голос не понадобился: большинство уже ответило одинаково


@dataclass(frozen=True, slots=True)
class Decision:
    answer: str | int | float | None
    confidence: float
    needs_review: bool
    representative: Vote | None  # чьё объяснение и доказательства показываем
    reasons: tuple[str, ...]


def decide(criterion: Mapping[str, Any], votes: Sequence[Vote]) -> Decision:
    valid = [vote for vote in votes if vote.answer is not None]
    if not valid:
        return Decision(None, 0.0, True, None, ("нет ни одного валидного ответа модели",))
    scale = criterion.get("answerType") == "scale"
    answer = _scale_answer(valid) if scale else _majority(valid)
    supporters = [vote for vote in valid if vote.answer == answer]
    confidence = round(len(supporters) / len(valid), 2)
    reasons = _review_reasons(criterion, valid, supporters, confidence)
    representative = next((v for v in supporters if v.verified), supporters[0])
    return Decision(answer, confidence, bool(reasons), representative, tuple(reasons))


def _majority(votes: Sequence[Vote]) -> str | int | float | None:
    counts = Counter(vote.answer for vote in votes)
    top = max(counts.values())
    leaders = {answer for answer, count in counts.items() if count == top}
    # Ничья: побеждает ответ модели с наибольшим приоритетом (порядок списка моделей).
    return next(vote.answer for vote in votes if vote.answer in leaders)


def _scale_answer(votes: Sequence[Vote]) -> str | int | float | None:
    na_votes = [vote for vote in votes if vote.answer == NA]
    numeric = sorted(vote.answer for vote in votes if vote.answer != NA)  # type: ignore[type-var]
    if len(na_votes) > len(numeric):
        return NA
    if not numeric:
        return NA
    if len(na_votes) == len(numeric):
        return votes[0].answer  # ничья N/A против ступеней — решает приоритетная модель
    return numeric[(len(numeric) - 1) // 2]  # медиана; при чётном числе — нижняя


def _review_reasons(
    criterion: Mapping[str, Any],
    valid: Sequence[Vote],
    supporters: Sequence[Vote],
    confidence: float,
) -> list[str]:
    reasons = []
    answers = {vote.answer for vote in valid}
    if confidence < MIN_CONFIDENCE:
        reasons.append(f"модели разошлись: {_summary(valid)}")
    elif NA in answers and len(answers) > 1:
        reasons.append(f"спор N/A против ответа: {_summary(valid)}")
    elif criterion.get("critical") and len(answers) > 1:
        reasons.append(f"расхождение по грубой ошибке: {_summary(valid)}")
    if not any(vote.verified for vote in supporters):
        reasons.append("цитаты-доказательства не подтвердились в тексте реплик")
    return reasons


def _summary(votes: Sequence[Vote]) -> str:
    return ", ".join(f"{vote.model.split('/')[-1]}={vote.answer}" for vote in votes)
