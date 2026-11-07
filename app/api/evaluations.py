"""Оценка диалога: разбор запроса, вызов движка, сохранение, история и сводка в листинге.

Оценка синхронная: POST ждёт движок (сам движок укладывается в 90 с). Любой сбой
движка сохраняется как Evaluation со status="error" и отдаётся клиенту понятной
ошибкой 502/504 — приложение при этом не падает.
"""

import asyncio
import logging
import secrets
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.api.appeal_view import with_appeals
from app.api.checklists import DEFAULT_ALIAS, DEFAULT_CHECKLIST_ID, get_checklist
from app.api.conversations import find_conversation
from app.api.engine import Evaluator
from app.api.errors import (
    bad_request,
    evaluation_failed,
    evaluation_invalid,
    evaluation_not_found,
    evaluation_timeout,
    scrub,
)
from app.api.validation import (
    body_bool,
    body_id,
    body_positive_int,
    body_purpose,
    require_object,
)
from app.errors import ApiError
from app.models import Conversation
from app.services import Services
from app.store import (
    ChecklistVersion,
    Purpose,
    StorageError,
    Store,
    StoredEvaluation,
    utc_now,
)
from app.views import message_view

logger = logging.getLogger("cqa.evaluations")

MAX_MODELS = 8
MAX_MODEL_ID_CHARS = 200
REUSE_LOOKBACK = 50  # сколько последних оценок диалога просматривать в поиске основы для reuse
ENGINE_FAILURE_MESSAGE = "Движок оценки завершился с ошибкой."


class EngineResultError(ValueError):
    """Движок вернул результат не по контракту."""


@dataclass(frozen=True, slots=True)
class EvaluationRequest:
    group_id: str
    conversation_id: str
    checklist_id: str
    checklist_version: int | None
    models: tuple[str, ...] | None
    reuse_previous: bool
    purpose: Purpose | None  # None — по версии чек-листа


@dataclass(frozen=True, slots=True)
class EvaluationContext:
    """Поля хранения, которые ставит бэкенд, а не движок."""

    evaluation_id: str
    created_at: str
    group_id: str
    conversation_id: str
    checklist_id: str
    checklist_version: int
    purpose: Purpose
    models: tuple[str, ...]

    def head(self) -> dict[str, Any]:
        return {
            "id": self.evaluation_id,
            "group_id": self.group_id,
            "conversation_id": self.conversation_id,
            "created_at": self.created_at,
            "checklist_id": self.checklist_id,
            "checklist_version": self.checklist_version,
            "purpose": self.purpose,
        }


def parse_evaluation_request(payload: object) -> EvaluationRequest:
    body = require_object(payload)
    checklist_id = body_id(body, "checklist_id", required=False) or DEFAULT_CHECKLIST_ID
    return EvaluationRequest(
        group_id=body_id(body, "group_id"),
        conversation_id=body_id(body, "conversation_id"),
        checklist_id=DEFAULT_CHECKLIST_ID if checklist_id == DEFAULT_ALIAS else checklist_id,
        checklist_version=body_positive_int(body, "checklist_version"),
        models=_models(body.get("models")),
        reuse_previous=body_bool(body, "reuse_previous", default=False),
        purpose=body_purpose(body),
    )


async def run_evaluation(services: Services, request: EvaluationRequest) -> dict[str, Any]:
    """Оценивает диалог и сохраняет результат; ошибки движка — 502/504 после сохранения."""
    conversation = await find_conversation(services, request.group_id, request.conversation_id)
    version = await run_in_threadpool(
        get_checklist,
        services.store,
        request.checklist_id,
        request.checklist_version,
        seed_path=services.settings.checklist_path,
    )
    purpose = resolve_purpose(request.purpose, version)
    models = list(request.models) if request.models else None
    if models:
        await run_in_threadpool(check_models_available, services.evaluator, models)
    reuse = (
        await run_in_threadpool(previous_evaluation, services.store, request, version)
        if request.reuse_previous
        else None
    )
    context = EvaluationContext(
        evaluation_id=new_id("ev"),
        created_at=utc_now(),
        group_id=request.group_id,
        conversation_id=conversation.conversation_id,
        checklist_id=version.checklist_id,
        checklist_version=version.version,
        purpose=purpose,
        models=tuple(models or ()),
    )
    evaluation = await _evaluate(services, conversation, version, context, models, reuse)
    await run_in_threadpool(save_evaluation, services.store, evaluation, conversation)
    if evaluation["status"] == "error":
        raise evaluation_failed(_public_error(evaluation.get("error")))
    return evaluation


async def _evaluate(
    services: Services,
    conversation: Conversation,
    version: ChecklistVersion,
    context: EvaluationContext,
    models: list[str] | None,
    reuse: dict[str, Any] | None,
) -> dict[str, Any]:
    timeout_sec = services.settings.evaluation_timeout_sec
    started = time.monotonic()
    try:
        async with asyncio.timeout(timeout_sec):
            result = await services.evaluator.evaluate(
                conversation, version.doc, models=models, reuse=reuse
            )
        return build_evaluation(result, context)
    except ApiError:
        raise  # движок недоступен (503): оценка не запускалась, сохранять нечего
    except TimeoutError:
        message = f"Оценка не уложилась в {timeout_sec:g} с."
        await _save_failure(services, conversation, context, message, started)
        raise evaluation_timeout(timeout_sec) from None
    except EngineResultError as exc:
        await _save_failure(services, conversation, context, ENGINE_FAILURE_MESSAGE, started)
        raise evaluation_invalid(detail=str(exc)) from None
    except Exception as exc:
        detail = scrub(f"{type(exc).__name__}: {exc}")
        await _save_failure(services, conversation, context, ENGINE_FAILURE_MESSAGE, started)
        raise evaluation_failed(detail=detail) from None


async def _save_failure(
    services: Services,
    conversation: Conversation,
    context: EvaluationContext,
    message: str,
    started: float,
) -> None:
    failed = failed_evaluation(context, message, latency_ms=_elapsed_ms(started))
    try:
        await run_in_threadpool(save_evaluation, services.store, failed, conversation)
    except StorageError as exc:  # не заслоняем исходную ошибку движка
        logger.warning("Неудачная оценка %s не сохранена: %s", context.evaluation_id, exc.detail)


def build_evaluation(result: object, context: EvaluationContext) -> dict[str, Any]:
    """Evaluation движка целиком + поля хранения; final_* = исходным, апелляций нет."""
    if not isinstance(result, Mapping):
        raise EngineResultError("результат движка — не объект")
    criteria = result.get("criteria")
    sections = result.get("sections") or []
    if not isinstance(criteria, list) or not all(
        isinstance(item, Mapping) and isinstance(item.get("criterion_id"), str) for item in criteria
    ):
        raise EngineResultError("criteria: ожидается список объектов с criterion_id")
    if not isinstance(sections, list) or not all(isinstance(item, Mapping) for item in sections):
        raise EngineResultError("sections: ожидается список объектов")
    status = result.get("status", "done")
    if status not in ("done", "error"):
        raise EngineResultError(f"неизвестный status {status!r}")
    head = context.head()
    body = {key: value for key, value in result.items() if key not in head}
    return {
        **head,
        **body,
        "models": list(result.get("models") or context.models),
        "criteria": [_fresh_criterion(item) for item in criteria],
        "sections": [_fresh_section(item) for item in sections],
        "final_total": result.get("total"),
        "status": status,
        "error": _public_error(result.get("error")) if status == "error" else None,
    }


def failed_evaluation(
    context: EvaluationContext, message: str, *, latency_ms: int
) -> dict[str, Any]:
    return {
        **context.head(),
        "models": list(context.models),
        "criteria": [],
        "sections": [],
        "total": None,
        "final_total": None,
        "critical_flag": False,
        "critical_note": None,
        "needs_review": False,
        "cost_usd": None,
        "tokens": None,
        "latency_ms": latency_ms,
        "status": "error",
        "error": message,
    }


def save_evaluation(
    store: Store, evaluation: dict[str, Any], conversation: Conversation
) -> StoredEvaluation:
    return store.add_evaluation(
        evaluation,
        transcript=[message_view(message) for message in conversation.messages],
        language=conversation.language,
        channel=conversation.channel,
    )


def resolve_purpose(requested: Purpose | None, version: ChecklistVersion) -> Purpose:
    """Оценка по версии-песочнице — тоже песочница; явный regular с ней — ошибка."""
    if requested is None:
        return "sandbox" if version.sandbox else "regular"
    if requested == "regular" and version.sandbox:
        raise bad_request(
            "invalid_purpose",
            f"Версия {version.version} чек-листа — песочница: оценивайте с purpose «sandbox» "
            "или сохраните её обычной версией.",
        )
    return requested


def check_models_available(evaluator: Evaluator, models: Sequence[str]) -> None:
    """Модели из каталога без ключа — понятная 400 до запуска оценки."""
    catalog = {
        item["id"]: item
        for item in evaluator.list_models()
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    unavailable = [
        model for model in models if model in catalog and not catalog[model].get("available")
    ]
    if unavailable:
        raise bad_request(
            "model_unavailable",
            "Модель недоступна (не настроен ключ доступа): " + ", ".join(unavailable) + ".",
        )


def previous_evaluation(
    store: Store, request: EvaluationRequest, version: ChecklistVersion
) -> dict[str, Any] | None:
    """Основа для reuse: последняя успешная оценка диалога по тому же чек-листу.

    Какие критерии не изменились, решает движок (по definition_hash критериев).
    """
    history = store.list_evaluations(
        group_id=request.group_id, conversation_id=request.conversation_id, limit=REUSE_LOOKBACK
    )
    return next(
        (
            stored.doc
            for stored in history
            if stored.doc.get("status") == "done"
            and stored.doc.get("checklist_id") == version.checklist_id
        ),
        None,
    )


def read_evaluation(store: Store, evaluation_id: str) -> dict[str, Any]:
    stored = store.get_evaluation(evaluation_id)
    if stored is None:
        raise evaluation_not_found(evaluation_id)
    return with_appeals(stored.doc, store.list_appeals(evaluation_ids=[evaluation_id]))


def read_history(
    store: Store,
    *,
    group_id: str | None,
    conversation_id: str | None,
    purpose: Purpose | None,
    limit: int,
) -> list[dict[str, Any]]:
    history = store.list_evaluations(
        group_id=group_id, conversation_id=conversation_id, purpose=purpose, limit=limit
    )
    if not history:
        return []
    appeals = store.list_appeals(evaluation_ids=[stored.evaluation_id for stored in history])
    return [with_appeals(stored.doc, appeals) for stored in history]


def listing_summaries(store: Store, group_id: str) -> dict[str, dict[str, Any]]:
    """{conversation_id: сводка последней обычной оценки} для листинга набора.

    Хранилище недоступно — листинг всё равно отдаётся, просто без оценок.
    """
    try:
        latest = store.latest_evaluations(group_id=group_id, purpose="regular")
    except StorageError as exc:
        logger.warning("Листинг %s без оценок: %s", group_id, exc.detail)
        return {}
    return {stored.doc["conversation_id"]: evaluation_summary(stored.doc) for stored in latest}


def evaluation_summary(evaluation: Mapping[str, Any]) -> dict[str, Any]:
    criteria = [item for item in evaluation.get("criteria") or [] if isinstance(item, Mapping)]
    return {
        "evaluation_id": evaluation.get("id"),
        "total": evaluation.get("total"),
        "final_total": evaluation.get("final_total"),
        "critical": bool(evaluation.get("critical_flag")),
        "critical_note": evaluation.get("critical_note"),
        "needs_review": bool(evaluation.get("needs_review")),
        "appeal_status": appeal_status(criteria),
        "checklist_version": evaluation.get("checklist_version"),
        "answers": {
            item["criterion_id"]: item.get("final_answer")
            for item in criteria
            if isinstance(item.get("criterion_id"), str)
        },
    }


def appeal_status(criteria: Sequence[Mapping[str, Any]]) -> str | None:
    statuses = {
        item["appeal"].get("status") for item in criteria if isinstance(item.get("appeal"), Mapping)
    }
    if "open" in statuses:
        return "open"
    return "resolved" if "resolved" in statuses else None


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def _fresh_criterion(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **item,
        "final_answer": item.get("answer"),
        "final_points": item.get("points"),
        "final_max_points": item.get("max_points"),
        "appeal": None,
    }


def _fresh_section(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **item,
        "final_points": item.get("points"),
        "final_max_points": item.get("max_points"),
    }


def _models(value: object) -> tuple[str, ...] | None:
    if value is None:
        return None
    if (
        not isinstance(value, list)
        or len(value) > MAX_MODELS
        or not all(
            isinstance(item, str) and item.strip() and len(item) <= MAX_MODEL_ID_CHARS
            for item in value
        )
    ):
        raise bad_request(
            "invalid_models", f"models: список id моделей (не больше {MAX_MODELS}) или null."
        )
    unique = tuple(dict.fromkeys(item.strip() for item in value))
    return unique or None


def _public_error(value: object) -> str:
    """Текст ошибки движка для клиента: без секретов, не длиннее 500 символов."""
    return scrub(value) if isinstance(value, str) and value.strip() else ENGINE_FAILURE_MESSAGE


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
