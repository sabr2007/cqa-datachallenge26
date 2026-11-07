"""Представление апелляций: ссылка в критерии оценки и фрагмент диалога для проверки."""

from collections.abc import Mapping, Sequence
from typing import Any

# Если у критерия нет доказательств, фрагментом служит проверенный участок (checked_range),
# но не длиннее этого числа реплик.
MAX_RANGE_MESSAGES = 12


def appeal_ref(appeal: Mapping[str, Any]) -> dict[str, Any]:
    """criterion.appeal при чтении оценки: id и status по контракту + детали обращения."""
    return {
        "id": appeal.get("id"),
        "status": appeal.get("status"),
        "comment": appeal.get("comment"),
        "created_at": appeal.get("created_at"),
        "original_answer": appeal.get("original_answer"),
        "decision": appeal.get("decision"),
    }


def with_appeals(
    evaluation: Mapping[str, Any], appeals: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    """Копия оценки, где у обжалованных критериев appeal содержит детали обращения."""
    by_criterion = {
        appeal.get("criterion_id"): appeal
        for appeal in appeals
        if appeal.get("evaluation_id") == evaluation.get("id")
    }
    if not by_criterion:
        return dict(evaluation)
    return {
        **evaluation,
        "criteria": [
            _with_appeal(criterion, by_criterion.get(criterion.get("criterion_id")))
            for criterion in evaluation.get("criteria") or []
        ],
    }


def find_result(evaluation: Mapping[str, Any], criterion_id: str) -> Mapping[str, Any] | None:
    """Результат критерия в оценке (элемент criteria) по id."""
    return next(
        (
            criterion
            for criterion in evaluation.get("criteria") or []
            if isinstance(criterion, Mapping) and criterion.get("criterion_id") == criterion_id
        ),
        None,
    )


def fragment(
    transcript: Sequence[Mapping[str, Any]], criterion: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Реплики evidence ± 1 по возрастанию index (без evidence — проверенный участок)."""
    by_index = {
        message["index"]: message
        for message in transcript
        if isinstance(message, Mapping) and _is_index(message.get("index"))
    }
    if not by_index:
        return []
    evidence = [
        item.get("index")
        for item in criterion.get("evidence") or []
        if isinstance(item, Mapping) and _is_index(item.get("index")) and item["index"] in by_index
    ]
    if evidence:
        wanted = {index + shift for index in evidence for shift in (-1, 0, 1)}
    else:
        wanted = _checked_range(criterion.get("checked_range"))
    return [_message(by_index[index]) for index in sorted(wanted) if index in by_index]


def _with_appeal(criterion: Mapping[str, Any], appeal: Mapping[str, Any] | None) -> dict[str, Any]:
    return dict(criterion) if appeal is None else {**criterion, "appeal": appeal_ref(appeal)}


def _checked_range(value: object) -> set[int]:
    if not (
        isinstance(value, Sequence)
        and not isinstance(value, str)
        and len(value) == 2
        and all(_is_index(bound) for bound in value)
    ):
        return set()
    start, end = sorted(value)
    return set(range(start, min(end, start + MAX_RANGE_MESSAGES - 1) + 1))


def _message(message: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "index": message.get("index"),
        "speaker": message.get("speaker"),
        "text": message.get("text"),
        "timestamp": message.get("timestamp"),
        "offset_sec": message.get("offset_sec"),
    }


def _is_index(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0
