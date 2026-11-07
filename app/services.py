"""Сборка сервисов приложения (клиенты источника, кеш, аудио-прокси, хранилище, движок, вход)."""

from dataclasses import dataclass

import httpx
from fastapi import Request

from app.api.checklists import sync_default_checklist
from app.api.engine import EngineEvaluator, Evaluator
from app.audio import AudioProxy
from app.auth.service import Authenticator, build_authenticator
from app.config import Settings
from app.datasets import DatasetStore
from app.store import Store, open_store
from app.upstream import UpstreamClient


@dataclass(frozen=True, slots=True)
class Services:
    settings: Settings
    upstream: UpstreamClient
    datasets: DatasetStore
    audio: AudioProxy
    store: Store
    evaluator: Evaluator
    auth: Authenticator | None = None  # None — вход для жюри выключен

    async def aclose(self) -> None:
        await self.upstream.aclose()
        await self.audio.aclose()
        self.store.close()


def build_services(
    settings: Settings,
    transport: httpx.AsyncBaseTransport | None = None,
    *,
    store: Store | None = None,
    evaluator: Evaluator | None = None,
) -> Services:
    """transport, store и evaluator подменяются в тестах; в работе — None (настоящие).

    При сборке хранилище мигрирует схему и засевает чек-лист из config, если нужно.
    """
    upstream = UpstreamClient(
        api_url=settings.api_url, timeout_sec=settings.upstream_timeout_sec, transport=transport
    )
    audio = AudioProxy(
        timeout_sec=settings.audio_timeout_sec,
        link_ttl_sec=settings.audio_url_ttl_sec,
        host_suffixes=settings.audio_host_suffixes,
        transport=transport,
    )
    datasets = DatasetStore(upstream.fetch_records, ttl_sec=settings.cache_ttl_sec)
    resolved_store = store if store is not None else open_store(settings)
    sync_default_checklist(resolved_store, settings.checklist_path)
    return Services(
        settings=settings,
        upstream=upstream,
        datasets=datasets,
        audio=audio,
        store=resolved_store,
        evaluator=evaluator if evaluator is not None else EngineEvaluator(),
        auth=build_authenticator(settings),
    )


def get_services(request: Request) -> Services:
    return request.app.state.services
