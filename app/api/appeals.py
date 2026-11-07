"""Апелляции: подача по критерию, очередь проверяющего и решение с пересчётом итога.

Оценка и апелляция меняются вместе, атомарно; параллельные изменения одной оценки
ловит ревизия (RevisionConflictError) — тогда изменение повторяется на свежих данных.
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from app.api.appeal_view import find_result, fragment, with_appeals
from app.api.checklists import criterion_options, find_criterion
from app.api.engine import Evaluator, InvalidAnswerError
from app.api.errors import (
    appeal_already_resolved,
    appeal_exists,
    appeal_not_found,
    bad_request,
    checklist_version_not_found,
    criterion_not_found,
    evaluation_conflict,
    evaluation_not_appealable,
    evaluation_not_found,
    scoring_failed,
    scrub,
)
from app.api.evaluations import new_id
from app.api.validation import MAX_COMMENT_CHARS, body_id, body_text, require_object
from app.store import (
    AppealNotOpenError,
    AppealStatus,
    ChecklistVersion,
    DuplicateAppealError,
    RevisionConflictError,
    Store,
    StoredEvaluation,
    utc_now,
)

logger = logging.getLogger("cqa.appeals")

MAX_ATTEMPTS = 3  # повторы при параллельном изменении одной оценки
YES = "yes"

Action = Literal["confirm", "change"]
ACTIONS: tuple[Action, ...] = ("confirm", "change")


@dataclass(frozen=True, slots=True)
class DecisionRequest:
    action: Action
    new_answer: object  # проверяется по критерию из версии чек-листа
    reason: str


def create_appeal(store: Store, evaluation_id: str, payload: object) -> dict[str, Any]:
    body = require_object(payload)
    criterion_id = body_id(body, "criterion_id")
    comment = body_text(body, "comment", label="Комментарий", max_chars=MAX_COMMENT_CHARS)
    for _ in range(MAX_ATTEMPTS):
        stored = _evaluation(store, evaluation_id)
        appeal, updated = _new_appeal(stored, criterion_id, comment)
        try:
            store.add_appeal(appeal, updated, expected_revision=stored.revision)
        except RevisionConflictError:
            continue
        except DuplicateAppealError:
            raise appeal_exists(criterion_id) from None
        logger.info("Апелляция %s: %s/%s", appeal["id"], evaluation_id, criterion_id)
        return appeal
    raise evaluation_conflict()


def parse_decision(payload: object) -> DecisionRequest:
    body = require_object(payload)
    action = body.get("action")
    if action not in ACTIONS:
        raise bad_request(
            "invalid_action", "action: «confirm» (подтвердить) или «change» (изменить)."
        )
    reason = body_text(body, "reason", label="Причина решения", max_chars=MAX_COMMENT_CHARS)
    new_answer = body.get("new_answer")
    if action == "change" and new_answer is None:
        raise bad_request("invalid_new_answer", "Для «change» укажите новый ответ (new_answer).")
    return DecisionRequest(action=action, new_answer=new_answer, reason=reason)


def decide_appeal(
    store: Store, evaluator: Evaluator, appeal_id: str, payload: object
) -> dict[str, Any]:
    """Решение по апелляции → {appeal, evaluation} с пересчитанными final_*."""
    decision = parse_decision(payload)
    for _ in range(MAX_ATTEMPTS):
        appeal = store.get_appeal(appeal_id)
        if appeal is None:
            raise appeal_not_found(appeal_id)
        if appeal.get("status") != "open":
            raise appeal_already_resolved()
        stored = _evaluation(store, appeal["evaluation_id"])
        evaluation, decided = _apply_decision(store, evaluator, stored, appeal, decision)
        try:
            store.resolve_appeal(decided, evaluation, expected_revision=stored.revision)
        except RevisionConflictError:
            continue
        except AppealNotOpenError:
            raise appeal_already_resolved() from None
        logger.info("Апелляция %s: решение %s", appeal_id, decision.action)
        appeals = store.list_appeals(evaluation_ids=[evaluation["id"]])
        return {"appeal": decided, "evaluation": with_appeals(evaluation, appeals)}
    raise evaluation_conflict()


def get_appeal(store: Store, appeal_id: str) -> dict[str, Any]:
    appeal = store.get_appeal(appeal_id)
    if appeal is None:
        raise appeal_not_found(appeal_id)
    return _queue_items(store, [appeal])[0]


def appeal_queue(
    store: Store,
    *,
    group_id: str | None,
    status: AppealStatus | None,
    evaluation_id: str | None,
    conversation_id: str | None,
) -> list[dict[str, Any]]:
    appeals = store.list_appeals(
        group_id=group_id,
        status=status,
        evaluation_ids=None if evaluation_id is None else [evaluation_id],
        conversation_id=conversation_id,
    )
    return _queue_items(store, appeals)


def _queue_items(store: Store, appeals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Апелляция + название и тип критерия, исходный и итоговый ответ, варианты, фрагмент."""
    evaluations: dict[str, StoredEvaluation | None] = {}
    versions: dict[tuple[str, int], ChecklistVersion | None] = {}
    items = []
    for appeal in appeals:
        evaluation_id = appeal.get("evaluation_id")
        if evaluation_id not in evaluations:
            evaluations[evaluation_id] = store.get_evaluation(evaluation_id)
        stored = evaluations[evaluation_id]
        definition = None
        if stored is not None:
            key = (stored.doc.get("checklist_id"), stored.doc.get("checklist_version"))
            if key not in versions:
                versions[key] = store.get_checklist_version(*key)
            version = versions[key]
            definition = find_criterion(version.doc, appeal["criterion_id"]) if version else None
        items.append(_queue_item(appeal, stored, definition))
    return items


def _queue_item(
    appeal: Mapping[str, Any],
    stored: StoredEvaluation | None,
    definition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    result = find_result(stored.doc, appeal["criterion_id"]) if stored else None
    return {
        **appeal,
        "criterion_title": (result or {}).get("title"),
        "answer_type": (result or {}).get("answer_type"),
        "original_answer": appeal.get("original_answer"),
        "final_answer": (result or {}).get("final_answer"),
        "options": criterion_options(definition) if definition else [],
        "fragment": fragment(stored.transcript or (), result) if stored and result else [],
    }


def _evaluation(store: Store, evaluation_id: str) -> StoredEvaluation:
    stored = store.get_evaluation(evaluation_id)
    if stored is None:
        raise evaluation_not_found(evaluation_id)
    return stored


def _new_appeal(
    stored: StoredEvaluation, criterion_id: str, comment: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    evaluation = stored.doc
    if evaluation.get("status") != "done":
        raise evaluation_not_appealable()
    result = find_result(evaluation, criterion_id)
    if result is None:
        raise criterion_not_found(criterion_id)
    if result.get("appeal"):
        raise appeal_exists(criterion_id)
    appeal = {
        "id": new_id("ap"),
        "evaluation_id": evaluation["id"],
        "group_id": evaluation["group_id"],
        "conversation_id": evaluation["conversation_id"],
        "criterion_id": criterion_id,
        "comment": comment,
        "created_at": utc_now(),
        "status": "open",
        "original_answer": result.get("answer"),
        "decision": None,
    }
    updated = _replace_result(
        evaluation, criterion_id, {"appeal": {"id": appeal["id"], "status": "open"}}
    )
    return appeal, updated


def _apply_decision(
    store: Store,
    evaluator: Evaluator,
    stored: StoredEvaluation,
    appeal: Mapping[str, Any],
    decision: DecisionRequest,
) -> tuple[dict[str, Any], dict[str, Any]]:
    evaluation = stored.doc
    criterion_id = appeal["criterion_id"]
    result = find_result(evaluation, criterion_id)
    if result is None:
        raise criterion_not_found(criterion_id)
    # решение проверяющего снимает с критерия «нужна проверка»
    resolved_ref = {
        "appeal": {"id": appeal["id"], "status": "resolved"},
        "needs_review": False,
        "review_reasons": [],
    }
    record = {"action": decision.action, "new_answer": None, "reason": decision.reason}
    if decision.action == "confirm":
        updated = _replace_result(evaluation, criterion_id, resolved_ref)
    else:
        checklist = _version(store, evaluation).doc
        new_answer = _checked_answer(evaluator, checklist, result, decision.new_answer)
        record = {**record, "new_answer": new_answer}
        rescored = _rescored(evaluator, checklist, evaluation, criterion_id, new_answer)
        updated = {
            **_replace_result(rescored, criterion_id, resolved_ref),
            "critical_note": decision.reason
            if result.get("critical")
            else rescored.get("critical_note"),
        }
    updated = {**updated, "needs_review": _any_needs_review(updated)}
    decided = {**appeal, "status": "resolved", "decision": {**record, "decided_at": utc_now()}}
    return updated, decided


def _any_needs_review(evaluation: Mapping[str, Any]) -> bool:
    return any(
        isinstance(item, Mapping) and bool(item.get("needs_review"))
        for item in evaluation.get("criteria") or []
    )


def _checked_answer(
    evaluator: Evaluator,
    checklist: Mapping[str, Any],
    result: Mapping[str, Any],
    raw_answer: object,
) -> object:
    """Новый ответ по типу критерия (normalize_answer движка); AnswerError → 400."""
    definition = find_criterion(checklist, result["criterion_id"])
    if definition is None:
        raise criterion_not_found(result["criterion_id"])
    allowed = ", ".join(str(option["value"]) for option in criterion_options(definition))
    try:
        answer = evaluator.normalize_answer(definition, raw_answer)
    except InvalidAnswerError as exc:
        raise bad_request("invalid_answer", f"{exc}. Допустимые ответы: {allowed}.") from None
    if answer is None:
        raise bad_request("invalid_answer", f"Укажите новый ответ. Допустимые ответы: {allowed}.")
    if answer == result.get("final_answer"):
        raise bad_request(
            "answer_unchanged", "Новый ответ совпадает с текущим — используйте «Подтвердить»."
        )
    return answer


def _rescored(
    evaluator: Evaluator,
    checklist: Mapping[str, Any],
    evaluation: Mapping[str, Any],
    criterion_id: str,
    new_answer: object,
) -> dict[str, Any]:
    """Оценка с новым final_answer: final_* критериев и секций, итог, флаг грубой ошибки.

    Флаг — по final_answer критериев с critical: true («Да» = нарушение есть).
    """
    results = [item for item in evaluation.get("criteria") or [] if isinstance(item, Mapping)]
    answers = {
        item["criterion_id"]: item.get("final_answer")
        for item in results
        if item.get("final_answer") is not None
    }
    try:
        scores = evaluator.score(dict(checklist), {**answers, criterion_id: new_answer})
    except ValueError as exc:
        raise scoring_failed(detail=scrub(f"{type(exc).__name__}: {exc}")) from None
    criterion_scores = scores.get("criteria") or {}
    section_scores = {
        item.get("id"): item for item in scores.get("sections") or [] if isinstance(item, Mapping)
    }
    criteria = [
        {
            **_rescored_result(item, criterion_scores.get(item.get("criterion_id"))),
            **({"final_answer": new_answer} if item.get("criterion_id") == criterion_id else {}),
        }
        for item in results
    ]
    return {
        **evaluation,
        "criteria": criteria,
        "sections": [
            _rescored_section(section, section_scores.get(section.get("id")))
            for section in evaluation.get("sections") or []
        ],
        "final_total": scores.get("total"),
        "critical_flag": any(
            item.get("critical") and item.get("final_answer") == YES for item in criteria
        ),
    }


def _rescored_result(result: Mapping[str, Any], score: Mapping[str, Any] | None) -> dict[str, Any]:
    if score is None:
        return dict(result)
    return {
        **result,
        "final_points": score.get("points"),
        "final_max_points": score.get("max_points"),
    }


def _rescored_section(
    section: Mapping[str, Any], score: Mapping[str, Any] | None
) -> dict[str, Any]:
    if score is None:
        return dict(section)
    return {
        **section,
        "final_points": score.get("points"),
        "final_max_points": score.get("max_points"),
    }


def _replace_result(
    evaluation: Mapping[str, Any], criterion_id: str, changes: Mapping[str, Any]
) -> dict[str, Any]:
    return {
        **evaluation,
        "criteria": [
            {**item, **changes} if item.get("criterion_id") == criterion_id else item
            for item in evaluation.get("criteria") or []
        ],
    }


def _version(store: Store, evaluation: Mapping[str, Any]) -> ChecklistVersion:
    checklist_id = evaluation.get("checklist_id")
    number = evaluation.get("checklist_version")
    version = store.get_checklist_version(checklist_id, number)
    if version is None:
        raise checklist_version_not_found(str(checklist_id), int(number or 0))
    return version
