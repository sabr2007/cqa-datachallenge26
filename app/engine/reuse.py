"""Переиспользование ответов прошлой оценки для критериев, чьё определение не менялось.

Отпечаток определения — хеш полей, влияющих на промпт критерия (формулировки,
тип ответа, N/A, шкала, указания эксперта, флаг грубой ошибки) и общих правил
чек-листа, которые попадают в промпт. Вес и scored в отпечаток не входят:
их изменение меняет только баллы, их пересчитывает score_evaluation.
"""

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from app.engine.scoring import AnswerError, normalize_answer

DEFINITION_FIELDS = (
    "title",
    "answerType",
    "naAllowed",
    "yes",
    "no",
    "na",
    "scale",
    "guidance",
    "critical",
)
RULE_FIELDS = ("firstResponseThresholdSec", "ignoreTagsAndAttachments", "contextSpeakers")


def criterion_fingerprint(criterion: Mapping[str, Any], rules: Mapping[str, Any]) -> str:
    payload = {
        "criterion": {name: criterion.get(name) for name in DEFINITION_FIELDS},
        "rules": {name: rules.get(name) for name in RULE_FIELDS},
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def reusable_criteria(
    checklist: Mapping[str, Any],
    previous: Mapping[str, Any] | None,
    *,
    conversation_id: str,
) -> dict[str, dict[str, Any]]:
    """{criterion_id: результат прошлой оценки} для критериев без изменений."""
    if not previous or previous.get("status") == "error":
        return {}
    if previous.get("conversation_id") not in (None, conversation_id):
        return {}
    rules = checklist.get("rules") or {}
    old = {
        item.get("criterion_id"): item
        for item in previous.get("criteria") or []
        if isinstance(item, Mapping)
    }
    reusable: dict[str, dict[str, Any]] = {}
    for criterion in checklist.get("criteria") or []:
        item = old.get(criterion["id"])
        if item is None or item.get("answer") is None:
            continue
        if item.get("definition_hash") != criterion_fingerprint(criterion, rules):
            continue
        try:
            normalize_answer(criterion, item.get("answer"))
        except AnswerError:
            continue
        reusable[criterion["id"]] = {**item, "source_evaluation_id": previous.get("id")}
    return reusable


def reviewer_decision(
    criterion: Mapping[str, Any], previous: Mapping[str, Any]
) -> tuple[Any, dict[str, Any]] | None:
    """(ответ проверяющего, ссылка на апелляцию) для критерия, по которому апелляция решена.

    При переоценке по новой версии чек-листа решение проверяющего по неизменному критерию
    переносится в новую оценку вместе со ссылкой на исходную апелляцию (carried_from —
    оценка, где её решили): без этого переоценка тихо вернула бы ответ модели.
    """
    appeal = previous.get("appeal")
    if not isinstance(appeal, Mapping) or appeal.get("status") != "resolved":
        return None
    try:
        final_answer = normalize_answer(criterion, previous.get("final_answer"))
    except AnswerError:
        return None
    if final_answer is None:
        return None
    origin = appeal.get("carried_from") or previous.get("source_evaluation_id")
    return final_answer, {**appeal, "carried_from": origin}
