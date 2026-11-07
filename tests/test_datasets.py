import asyncio
from collections.abc import Sequence

from app.datasets import DatasetStore
from tests.support import load_payload


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class CountingFetch:
    def __init__(self, delay_sec: float = 0.0) -> None:
        self.calls = 0
        self.delay_sec = delay_sec

    async def __call__(self, group_id: str) -> Sequence[object]:
        self.calls += 1
        await asyncio.sleep(self.delay_sec)
        return load_payload()["data"]["records"]


def test_cached_dataset_is_reused_within_ttl_and_refetched_after() -> None:
    clock = FakeClock()
    fetch = CountingFetch()
    store = DatasetStore(fetch, ttl_sec=600, clock=clock)

    async def scenario() -> list[int]:
        calls = []
        await store.get("DEV")
        clock.now = 599
        await store.get("DEV")
        calls.append(fetch.calls)
        clock.now = 601
        await store.get("DEV")
        calls.append(fetch.calls)
        return calls

    assert asyncio.run(scenario()) == [1, 2]


def test_concurrent_requests_share_one_upstream_call() -> None:
    fetch = CountingFetch(delay_sec=0.05)
    store = DatasetStore(fetch, ttl_sec=600)

    async def scenario() -> bool:
        first, second, third = await asyncio.gather(
            store.get("DEV"), store.get("DEV"), store.get("DEV")
        )
        return first is second is third

    assert asyncio.run(scenario()) is True
    assert fetch.calls == 1


def test_concurrent_refreshes_reuse_the_fresh_result() -> None:
    fetch = CountingFetch(delay_sec=0.05)
    store = DatasetStore(fetch, ttl_sec=600)

    async def scenario() -> None:
        await store.get("DEV")
        await asyncio.gather(store.get("DEV", refresh=True), store.get("DEV", refresh=True))

    asyncio.run(scenario())

    assert fetch.calls == 2


def test_groups_are_cached_separately_and_bounded() -> None:
    fetch = CountingFetch()
    store = DatasetStore(fetch, ttl_sec=600, max_entries=2)

    async def scenario() -> None:
        for group_id in ("DEV", "CTRL", "OTHER", "DEV"):
            await store.get(group_id)

    asyncio.run(scenario())

    assert fetch.calls == 4  # DEV вытеснен самым старым, пришлось загрузить снова
