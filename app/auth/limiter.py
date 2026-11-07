"""Простое ограничение частоты неудачных входов по IP — в памяти процесса.

На Vercel у каждого экземпляра функции свой счётчик: это защита от перебора «в лоб»,
а не точный лимит. Удачный вход сбрасывает счётчик адреса.
"""

import math
import threading
import time
from collections import deque
from collections.abc import Callable

MAX_FAILURES = 10
WINDOW_SEC = 300.0
MAX_TRACKED_ADDRESSES = 10_000  # память ограничена и при переборе с многих адресов


class LoginRateLimiter:
    def __init__(
        self,
        *,
        max_failures: int = MAX_FAILURES,
        window_sec: float = WINDOW_SEC,
        max_tracked: int = MAX_TRACKED_ADDRESSES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_failures = max_failures
        self._window_sec = window_sec
        self._max_tracked = max_tracked
        self._clock = clock
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def retry_after(self, address: str) -> int:
        """Через сколько секунд адресу снова можно пробовать; 0 — можно сейчас."""
        with self._lock:
            now = self._clock()
            failures = self._recent(address, now)
            if len(failures) < self._max_failures:
                return 0
            return max(1, math.ceil(failures[0] + self._window_sec - now))

    def record_failure(self, address: str) -> None:
        with self._lock:
            now = self._clock()
            failures = self._recent(address, now)
            failures.append(now)
            self._failures.pop(address, None)
            self._failures[address] = failures  # недавние — в конец, старые вытесняются первыми
            while len(self._failures) > self._max_tracked:
                del self._failures[next(iter(self._failures))]

    def reset(self, address: str) -> None:
        with self._lock:
            self._failures.pop(address, None)

    def _recent(self, address: str, now: float) -> deque[float]:
        """Неудачи адреса за окно; устаревшие отбрасываются, пустой адрес не хранится."""
        failures = self._failures.get(address)
        if failures is None:
            return deque()
        while failures and failures[0] <= now - self._window_sec:
            failures.popleft()
        if not failures:
            del self._failures[address]
        return failures
