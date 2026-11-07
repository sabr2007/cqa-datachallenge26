"""Кеш наборов диалогов в памяти процесса (TTL) с одним запросом к источнику на группу.

Это только кеш загрузки: данные каждый раз приходят из API кейса, заранее
подготовленных результатов нет. На Vercel кеш живёт в рамках экземпляра функции.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from app.models import Dataset
from app.normalize import normalize_records

logger = logging.getLogger("cqa.datasets")

FetchRecords = Callable[[str], Awaitable[Sequence[object]]]

MAX_CACHED_GROUPS = 16


@dataclass(frozen=True, slots=True)
class _Entry:
    dataset: Dataset
    loaded_at: float  # time.monotonic()


class DatasetStore:
    def __init__(
        self,
        fetch_records: FetchRecords,
        *,
        ttl_sec: float,
        max_entries: int = MAX_CACHED_GROUPS,
        clock: Callable[[], float] = time.monotonic,
        utcnow: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._fetch_records = fetch_records
        self._ttl_sec = ttl_sec
        self._max_entries = max_entries
        self._clock = clock
        self._utcnow = utcnow
        self._entries: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get(self, group_id: str, *, refresh: bool = False) -> Dataset:
        """Набор из кеша, если он свежий; иначе (или при refresh) — из источника.

        Параллельные запросы одной группы ждут одну загрузку, а не идут в источник
        каждый сам по себе.
        """
        requested_at = self._clock()
        if not refresh and (entry := self._fresh_entry(group_id)):
            return entry.dataset
        async with self._lock_for(group_id):
            entry = self._entries.get(group_id)
            if entry and self._is_usable(entry, refresh=refresh, requested_at=requested_at):
                return entry.dataset
            dataset = await self._load(group_id)
            self._remember(group_id, _Entry(dataset=dataset, loaded_at=self._clock()))
            return dataset

    def _fresh_entry(self, group_id: str) -> _Entry | None:
        entry = self._entries.get(group_id)
        return entry if entry and self._clock() - entry.loaded_at < self._ttl_sec else None

    def _is_usable(self, entry: _Entry, *, refresh: bool, requested_at: float) -> bool:
        if refresh:
            # Пока ждали блокировку, другой запрос уже обновил набор.
            return entry.loaded_at >= requested_at
        return self._clock() - entry.loaded_at < self._ttl_sec

    def _lock_for(self, group_id: str) -> asyncio.Lock:
        lock = self._locks.get(group_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks = {**self._locks, group_id: lock}
        return lock

    async def _load(self, group_id: str) -> Dataset:
        started = self._clock()
        raw_records = await self._fetch_records(group_id)
        conversations, skipped = normalize_records(raw_records)
        for record in skipped:
            logger.warning(
                "Набор %s: пропущена запись #%d (%s): %s",
                group_id,
                record.position,
                record.conversation_id or "без id",
                record.reason,
            )
        logger.info(
            "Набор %s загружен: %d диалогов, пропущено %d, %.1f с",
            group_id,
            len(conversations),
            len(skipped),
            self._clock() - started,
        )
        return Dataset(
            group_id=group_id,
            conversations=conversations,
            fetched_at=self._utcnow(),
            skipped=skipped,
        )

    def _remember(self, group_id: str, entry: _Entry) -> None:
        entries = {**self._entries, group_id: entry}
        if len(entries) > self._max_entries:
            oldest = min(entries, key=lambda key: entries[key].loaded_at)
            entries = {key: value for key, value in entries.items() if key != oldest}
        self._entries = entries
