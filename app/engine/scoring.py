"""Расчёт баллов по чек-листу — чистые функции на десятичной арифметике.

Правила (docs/TASK.md, раздел 4; docs/CONTRACT.md, «Дополнения (v2)»):
- «Да» — полный вес, «Нет» — 0, шкала — доля от верхней ступени;
- N/A и критерии без ответа исключаются, их вес пропорционально
  перераспределяется между применимыми (если `naRedistributesWeight`);
- критерий `scored: false` в итог не входит;
- если применимых критериев с весом нет — итог не считается (None);
- считаем по точным Decimal, наружу отдаём каждое число отдельно,
  округлённое half-up до 2 знаков (50,625 → 50,63).
"""

import re
from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

YES = "yes"
NO = "no"
NA = "na"

Answer = str | int | float

DEFAULT_DECIMALS = 2
DEFAULT_MAX_TOTAL = Decimal(100)
_ROUNDING_MODES = {"half_up": ROUND_HALF_UP, "half_even": ROUND_HALF_EVEN}
_INT_RE = re.compile(r"[+-]?\d+(?:\.\d+)?")


class AnswerError(ValueError):
    """Ответ не подходит критерию (тип, ступень шкалы, N/A там, где он запрещён)."""


def is_scored(criterion: Mapping[str, Any]) -> bool:
    return criterion.get("scored", True) is not False


def scale_values(criterion: Mapping[str, Any]) -> list[Decimal]:
    steps = criterion.get("scale") or []
    return [_decimal(step.get("value"), f"ступень шкалы {criterion.get('id')}") for step in steps]


def allowed_answers(criterion: Mapping[str, Any]) -> list[Answer]:
    """Допустимые ответы критерия: yes/no или ступени шкалы, плюс na, если разрешён."""
    if criterion.get("answerType") == "scale":
        values: list[Answer] = [_plain_number(value) for value in scale_values(criterion)]
    else:
        values = [YES, NO]
    if criterion.get("naAllowed"):
        values.append(NA)
    return values


def normalize_answer(criterion: Mapping[str, Any], value: object) -> Answer | None:
    """Приводит ответ к каноническому виду: "yes"/"no"/"na" или число-ступень.

    None (ответа нет) остаётся None. Неподходящий ответ — AnswerError.
    """
    if value is None:
        return None
    criterion_id = criterion.get("id", "?")
    if isinstance(value, str) and value.strip().lower() in (NA, "n/a"):
        if not criterion.get("naAllowed"):
            raise AnswerError(f"Критерий {criterion_id}: N/A не разрешён")
        return NA
    if criterion.get("answerType") == "scale":
        return _normalize_scale(criterion, value)
    if isinstance(value, str) and value.strip().lower() in (YES, NO):
        return value.strip().lower()
    raise AnswerError(f"Критерий {criterion_id}: ожидается yes/no, получено {value!r}")


def score_evaluation(checklist: Mapping[str, Any], answers: Mapping[str, object]) -> dict[str, Any]:
    """{criterion_id: answer} → баллы критериев, секций и итог.

    Результат: {"criteria": {id: {"points", "max_points"}},
                "sections": [{"id", "title", "points", "max_points"}],
                "total": float | None, "max_total": float | None,
                "critical_flag": bool}
    Для N/A, критериев без ответа и scored=false points/max_points — None.
    """
    rules = checklist.get("rules") or {}
    criteria: Sequence[Mapping[str, Any]] = checklist.get("criteria") or []
    normalized = {c["id"]: normalize_answer(c, answers.get(c["id"])) for c in criteria}
    exact = _exact_points(criteria, normalized, rules)
    quantize = _quantizer(rules)

    criteria_out = {
        cid: {"points": quantize(points), "max_points": quantize(max_points)}
        for cid, (points, max_points) in exact.items()
    }
    sections_out = [
        _section_result(section, exact, quantize) for section in checklist.get("sections") or []
    ]
    applicable = [pair for pair in exact.values() if pair[0] is not None]
    total = sum((points for points, _ in applicable), Decimal(0)) if applicable else None
    max_total = sum((mx for _, mx in applicable), Decimal(0)) if applicable else None
    return {
        "criteria": criteria_out,
        "sections": sections_out,
        "total": quantize(total),
        "max_total": quantize(max_total),
        "critical_flag": critical_flag(checklist, normalized),
    }


def critical_flag(checklist: Mapping[str, Any], answers: Mapping[str, object]) -> bool:
    """Грубая ошибка отмечена: у критерия с critical=true ответ «Да» (нарушение есть)."""
    for criterion in checklist.get("criteria") or []:
        if criterion.get("critical") and _is_yes(answers.get(criterion["id"])):
            return True
    return False


def _exact_points(
    criteria: Sequence[Mapping[str, Any]],
    answers: Mapping[str, Answer | None],
    rules: Mapping[str, Any],
) -> dict[str, tuple[Decimal | None, Decimal | None]]:
    scored = [c for c in criteria if is_scored(c)]
    applicable = [c for c in scored if answers.get(c["id"]) not in (None, NA)]
    redistribute = rules.get("naRedistributesWeight", True) is not False
    basis = applicable if redistribute else scored
    weight_sum = sum((_weight(c) for c in basis), Decimal(0))
    max_total = _decimal(rules.get("maxTotal", DEFAULT_MAX_TOTAL), "rules.maxTotal")

    result: dict[str, tuple[Decimal | None, Decimal | None]] = {
        c["id"]: (None, None) for c in criteria
    }
    if weight_sum <= 0:
        return result
    for criterion in applicable:
        max_points = _weight(criterion) * max_total / weight_sum
        fraction = _fraction(criterion, answers[criterion["id"]])
        result[criterion["id"]] = (fraction * max_points, max_points)
    return result


def _section_result(
    section: Mapping[str, Any],
    exact: Mapping[str, tuple[Decimal | None, Decimal | None]],
    quantize,
) -> dict[str, Any]:
    pairs = [exact[cid] for cid in section.get("criteria") or [] if cid in exact]
    applicable = [pair for pair in pairs if pair[0] is not None]
    points = sum((p for p, _ in applicable), Decimal(0)) if applicable else None
    max_points = sum((m for _, m in applicable), Decimal(0)) if applicable else None
    return {
        "id": section.get("id"),
        "title": section.get("title"),
        "points": quantize(points),
        "max_points": quantize(max_points),
    }


def _fraction(criterion: Mapping[str, Any], answer: Answer) -> Decimal:
    if criterion.get("answerType") == "scale":
        top = max(scale_values(criterion), default=Decimal(0))
        if top <= 0:
            raise AnswerError(f"Критерий {criterion.get('id')}: у шкалы нет положительной ступени")
        return _decimal(answer, "ответ шкалы") / top
    return Decimal(1) if answer == YES else Decimal(0)


def _normalize_scale(criterion: Mapping[str, Any], value: object) -> Answer:
    criterion_id = criterion.get("id", "?")
    if isinstance(value, bool):
        raise AnswerError(f"Критерий {criterion_id}: ожидается ступень шкалы, получено {value!r}")
    if isinstance(value, str):
        text = value.strip()
        if not _INT_RE.fullmatch(text):
            raise AnswerError(
                f"Критерий {criterion_id}: ожидается ступень шкалы, получено {value!r}"
            )
        number = Decimal(text)
    elif isinstance(value, int | float | Decimal):
        number = _decimal(value, "ответ шкалы")
    else:
        raise AnswerError(f"Критерий {criterion_id}: ожидается ступень шкалы, получено {value!r}")
    for step in scale_values(criterion):
        if step == number:
            return _plain_number(step)
    raise AnswerError(f"Критерий {criterion_id}: {value!r} — не ступень шкалы")


def _weight(criterion: Mapping[str, Any]) -> Decimal:
    weight = _decimal(criterion.get("weight", 0) or 0, f"вес {criterion.get('id')}")
    return weight if weight > 0 else Decimal(0)


def _quantizer(rules: Mapping[str, Any]):
    rounding = rules.get("rounding") or {}
    decimals = int(rounding.get("decimals", DEFAULT_DECIMALS))
    mode = _ROUNDING_MODES.get(str(rounding.get("mode", "half_up")), ROUND_HALF_UP)
    exponent = Decimal(1).scaleb(-decimals)

    def quantize(value: Decimal | None) -> float | None:
        if value is None:
            return None
        return float(value.quantize(exponent, rounding=mode))

    return quantize


def _decimal(value: object, what: str) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise AnswerError(f"{what}: ожидается число, получено {value!r}")
    try:
        # str(): 0.1 → Decimal("0.1"), а не двоичное приближение float
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise AnswerError(f"{what}: ожидается число, получено {value!r}") from None


def _plain_number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def _is_yes(value: object) -> bool:
    return isinstance(value, str) and value.strip().lower() == YES
