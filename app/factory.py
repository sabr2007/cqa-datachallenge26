"""Сборка FastAPI-приложения."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.engine import Evaluator
from app.auth import SessionGate
from app.config import Settings, load_settings
from app.errors import register_error_handlers
from app.routes import router
from app.services import build_services
from app.store import Store

logger = logging.getLogger("cqa")


def create_app(
    settings: Settings | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    store: Store | None = None,
    evaluator: Evaluator | None = None,
) -> FastAPI:
    """transport, store и evaluator подменяются в тестах (без сети и движка)."""
    resolved = settings if settings is not None else load_settings()
    services = build_services(resolved, transport, store=store, evaluator=evaluator)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await services.aclose()

    app = FastAPI(
        title="CQA API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.services = services
    register_error_handlers(app)
    app.include_router(router)
    if services.auth is not None:
        # Вход для жюри: /api/* (кроме health и входа) — только с действующей сессией.
        app.add_middleware(SessionGate, codec=services.auth.codec)
    _mount_frontend(app, resolved)  # строго после API-роутов
    return app


def _mount_frontend(app: FastAPI, settings: Settings) -> None:
    """Локально раздаёт public/ на `/`, чтобы одна команда поднимала всё приложение.

    На Vercel (VERCEL=1) public/ отдаёт CDN, а монтировать её в FastAPI
    документация Vercel запрещает — там этот шаг пропускается.
    """
    if not settings.serve_static:
        return
    if not settings.public_dir.is_dir():
        logger.info(
            "Папки %s нет — фронтенд не раздаётся, работает только API", settings.public_dir
        )
        return
    app.mount("/", StaticFiles(directory=settings.public_dir, html=True), name="frontend")
