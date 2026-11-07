"""Роуты чек-листов, моделей, оценок, апелляций, экспорта, метрик и аналитики.

Контракт — docs/CONTRACT.md и раздел «API» в README. Синхронные роуты FastAPI
выполняет в пуле потоков: хранилище потокобезопасно.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import JSONResponse, Response

from app.api import appeals, checklists, evaluations, export
from app.api.analytics import group_analytics
from app.api.errors import bad_request
from app.api.metrics import accuracy_report
from app.api.validation import (
    optional_query_id,
    query_appeal_status,
    query_limit,
    query_purpose,
    query_version,
    require_path_id,
)
from app.services import Services, get_services
from app.validation import require_group_id

router = APIRouter()

ServicesDep = Annotated[Services, Depends(get_services)]
JsonBody = Annotated[Any, Body()]

DEFAULT_HISTORY_LIMIT = 100
METRICS_DEFAULT_GROUP = "DEV"  # эталонная разметка есть только у DEV
EXPORT_FORMATS = ("json", "csv")


# --- чек-листы ---


@router.get("/checklists")
def list_checklists(services: ServicesDep) -> dict[str, Any]:
    return {"items": checklists.list_checklists(services.store)}


@router.get("/checklists/{checklist_id}")
def get_checklist(
    checklist_id: str, services: ServicesDep, version: int | None = None
) -> dict[str, Any]:
    """Документ версии; без version — последняя обычная. «default» = chat-quality."""
    found = checklists.get_checklist(
        services.store,
        checklists.resolve_checklist_id(checklist_id),
        query_version(version),
        seed_path=services.settings.checklist_path,
    )
    return found.doc


@router.post("/checklists/{checklist_id}/versions", status_code=201)
def create_checklist_version(
    checklist_id: str, payload: JsonBody, services: ServicesDep
) -> dict[str, Any]:
    created = checklists.create_checklist_version(
        services.store, checklists.resolve_checklist_id(checklist_id), payload
    )
    return created.doc


# --- модели ---


@router.get("/models")
def list_models(services: ServicesDep) -> dict[str, Any]:
    return {"items": services.evaluator.list_models()}


# --- оценки ---


@router.post("/evaluations", status_code=201)
async def create_evaluation(payload: JsonBody, services: ServicesDep) -> dict[str, Any]:
    request = evaluations.parse_evaluation_request(payload)
    return await evaluations.run_evaluation(services, request)


@router.get("/evaluations")
def list_evaluations(
    services: ServicesDep,
    group_id: str | None = None,
    conversation_id: str | None = None,
    purpose: str | None = None,
    limit: int = DEFAULT_HISTORY_LIMIT,
) -> dict[str, Any]:
    items = evaluations.read_history(
        services.store,
        group_id=optional_query_id(group_id, "group_id"),
        conversation_id=optional_query_id(conversation_id, "conversation_id"),
        purpose=query_purpose(purpose),
        limit=query_limit(limit),
    )
    return {"items": items}


@router.get("/evaluations/{evaluation_id}")
def get_evaluation(evaluation_id: str, services: ServicesDep) -> dict[str, Any]:
    return evaluations.read_evaluation(
        services.store, require_path_id(evaluation_id, "evaluation_id")
    )


# --- апелляции ---


@router.post("/evaluations/{evaluation_id}/appeals", status_code=201)
def create_appeal(evaluation_id: str, payload: JsonBody, services: ServicesDep) -> dict[str, Any]:
    return appeals.create_appeal(
        services.store, require_path_id(evaluation_id, "evaluation_id"), payload
    )


@router.get("/appeals")
def list_appeals(
    services: ServicesDep,
    group_id: str | None = None,
    status: str | None = None,
    evaluation_id: str | None = None,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    items = appeals.appeal_queue(
        services.store,
        group_id=optional_query_id(group_id, "group_id"),
        status=query_appeal_status(status),
        evaluation_id=optional_query_id(evaluation_id, "evaluation_id"),
        conversation_id=optional_query_id(conversation_id, "conversation_id"),
    )
    return {"items": items}


@router.get("/appeals/{appeal_id}")
def get_appeal(appeal_id: str, services: ServicesDep) -> dict[str, Any]:
    return appeals.get_appeal(services.store, require_path_id(appeal_id, "appeal_id"))


@router.post("/appeals/{appeal_id}/decision")
def decide_appeal(appeal_id: str, payload: JsonBody, services: ServicesDep) -> dict[str, Any]:
    return appeals.decide_appeal(
        services.store, services.evaluator, require_path_id(appeal_id, "appeal_id"), payload
    )


# --- экспорт, метрики, аналитика ---


@router.get("/export")
def export_evaluations(
    services: ServicesDep,
    group_id: str | None = None,
    export_format: Annotated[str, Query(alias="format")] = "json",
) -> Response:
    """Последние обычные оценки набора; format=csv — файл для Excel."""
    if export_format not in EXPORT_FORMATS:
        raise bad_request("invalid_format", "format: «json» или «csv».")
    group = optional_query_id(group_id, "group_id")
    latest = services.store.latest_evaluations(group_id=group)
    disposition = f'attachment; filename="{export.export_filename(group, export_format)}"'
    if export_format == "csv":
        return Response(
            export.export_csv(latest),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": disposition},
        )
    return JSONResponse(
        export.export_json(group, latest), headers={"Content-Disposition": disposition}
    )


@router.get("/metrics/accuracy")
def accuracy(
    services: ServicesDep,
    group_id: str = METRICS_DEFAULT_GROUP,
    checklist_id: str | None = None,
    checklist_version: int | None = None,
    purpose: str | None = None,
) -> dict[str, Any]:
    resolved_checklist = optional_query_id(checklist_id, "checklist_id")
    return accuracy_report(
        services.store,
        services.evaluator,
        services.settings,
        group_id=require_group_id(group_id),
        checklist_id=(
            checklists.resolve_checklist_id(resolved_checklist) if resolved_checklist else None
        ),
        checklist_version=query_version(checklist_version),
        purpose=query_purpose(purpose),
    )


@router.get("/analytics")
def analytics(services: ServicesDep, group_id: str | None = None) -> dict[str, Any]:
    return group_analytics(services.store, optional_query_id(group_id, "group_id"))
