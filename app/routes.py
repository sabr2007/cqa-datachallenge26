"""HTTP-роуты API (контракт — в README, раздел «API», и docs/CONTRACT.md)."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from app.api.conversations import find_conversation
from app.api.evaluations import listing_summaries
from app.api.routes import router as api_router
from app.audio import iterate_and_close, media_headers, parse_range
from app.auth.routes import router as auth_router
from app.errors import audio_not_found
from app.services import Services, get_services
from app.validation import require_group_id
from app.views import conversation_detail, dataset_listing

router = APIRouter(prefix="/api")

ServicesDep = Annotated[Services, Depends(get_services)]


@router.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@router.get("/datasets/{group_id}/conversations")
async def list_conversations(
    group_id: str, services: ServicesDep, refresh: bool = False
) -> dict[str, Any]:
    valid_group_id = require_group_id(group_id)
    dataset = await services.datasets.get(valid_group_id, refresh=refresh)
    summaries = await run_in_threadpool(listing_summaries, services.store, valid_group_id)
    return dataset_listing(dataset, summaries)


@router.get("/datasets/{group_id}/conversations/{conversation_id}")
async def get_conversation(
    group_id: str, conversation_id: str, services: ServicesDep, refresh: bool = False
) -> dict[str, Any]:
    conversation = await find_conversation(services, group_id, conversation_id, refresh=refresh)
    return conversation_detail(conversation, group_id)


@router.get("/datasets/{group_id}/conversations/{conversation_id}/audio")
async def get_conversation_audio(
    group_id: str, conversation_id: str, request: Request, services: ServicesDep
) -> StreamingResponse:
    conversation = await find_conversation(services, group_id, conversation_id)
    if conversation.audio_source_url is None:
        raise audio_not_found()
    upstream = await services.audio.open(
        conversation.audio_source_url, parse_range(request.headers.get("range"))
    )
    return StreamingResponse(
        iterate_and_close(upstream),
        status_code=upstream.status_code,
        headers=media_headers(upstream),
    )


router.include_router(api_router)
router.include_router(auth_router)
