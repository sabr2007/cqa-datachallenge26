"""Интерфейс хранилища (Store) и его типы — без привязки к конкретной базе.

Реализации две, с одной семантикой (её проверяют контрактные тесты tests/store):
SQLite (app.store.sqlite) — локально и в тестах, Postgres (app.store.postgres) —
в облаке (Vercel + Neon). Какая работает, решает app.store.open_store по настройкам.
"""

import functools
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from app.errors import ApiError

Purpose = Literal["regular", "sandbox"]
AppealStatus = Literal["open", "resolved"]
ChecklistSource = Literal["file", "api"]

PURPOSES: tuple[Purpose, ...] = ("regular", "sandbox")
APPEAL_STATUSES: tuple[AppealStatus, ...] = ("open", "resolved")


def utc_now() -> str:
    """Время в формате контракта: ISO 8601, UTC, до секунды (так хранятся все даты)."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class StorageError(ApiError):
    """База недоступна или вернула ошибку; подробности — только в серверный лог."""

    status_code = 503
    code = "storage_unavailable"
    message = "Хранилище оценок временно недоступно. Попробуйте ещё раз."


def _describe(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"


def guarded[**P, R](
    action: str,
    errors: tuple[type[Exception], ...],
    describe: Callable[[Exception], str] = _describe,
) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Ошибки драйвера базы (errors) → StorageError (503); подробности — только в лог."""

    def decorate(method: Callable[P, R]) -> Callable[P, R]:
        @functools.wraps(method)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            try:
                return method(*args, **kwargs)
            except errors as exc:
                raise StorageError(detail=f"{action}: {describe(exc)}") from exc

        return wrapper

    return decorate


class RevisionConflictError(Exception):
    """Оценку изменили параллельно: перечитайте её и повторите изменение."""


class DuplicateAppealError(Exception):
    """По этому критерию этой оценки апелляция уже есть."""


class AppealNotOpenError(Exception):
    """Апелляция уже рассмотрена (или её нет)."""


@dataclass(frozen=True, slots=True)
class ChecklistVersion:
    checklist_id: str
    version: int
    title: str
    doc: dict[str, Any]  # документ чек-листа с полями id и version; не изменять
    note: str | None
    sandbox: bool
    source: ChecklistSource
    created_at: str


@dataclass(frozen=True, slots=True)
class StoredEvaluation:
    doc: dict[str, Any]  # Evaluation в формате контракта; не изменять
    revision: int  # растёт при каждом изменении (апелляции) — для оптимистичной блокировки
    language: str | None = None
    channel: str | None = None
    transcript: tuple[dict[str, Any], ...] | None = field(default=None, repr=False)

    @property
    def evaluation_id(self) -> str:
        return self.doc["id"]


class Store(Protocol):
    def close(self) -> None: ...

    # --- версии чек-листов (неизменяемые) ---

    def list_checklist_versions(self) -> list[ChecklistVersion]:
        """Все версии всех чек-листов: по checklist_id, затем по возрастанию version."""
        ...

    def get_checklist_version(
        self, checklist_id: str, version: int | None = None
    ) -> ChecklistVersion | None:
        """Конкретная версия; без version — последняя обычная (не песочница)."""
        ...

    def add_checklist_version(
        self, checklist_id: str, doc: dict[str, Any], *, note: str | None, sandbox: bool
    ) -> ChecklistVersion:
        """Новая версия с номером «последний + 1» (номер ставится и в doc["version"])."""
        ...

    def sync_checklist_file(
        self, checklist_id: str, doc: dict[str, Any], *, note: str, source_hash: str
    ) -> ChecklistVersion | None:
        """Версия из файла конфигурации: если версий нет или последняя обычная версия
        тоже из файла, но с другим хэшем. Версии из интерфейса файл не перекрывает.
        Возвращает созданную версию или None, если создавать нечего.
        """
        ...

    # --- оценки ---

    def add_evaluation(
        self,
        evaluation: dict[str, Any],
        *,
        transcript: Sequence[dict[str, Any]],
        language: str | None,
        channel: str | None,
    ) -> StoredEvaluation: ...

    def get_evaluation(self, evaluation_id: str) -> StoredEvaluation | None:
        """Оценка вместе со снимком транскрипта, на котором она сделана."""
        ...

    def list_evaluations(
        self,
        *,
        group_id: str | None = None,
        conversation_id: str | None = None,
        purpose: Purpose | None = None,
        limit: int = 100,
    ) -> list[StoredEvaluation]:
        """История оценок, новые первыми (без транскриптов)."""
        ...

    def latest_evaluations(
        self,
        *,
        group_id: str | None = None,
        purpose: Purpose | None = "regular",
        checklist_id: str | None = None,
        checklist_version: int | None = None,
    ) -> list[StoredEvaluation]:
        """Последняя успешная (status=done) оценка каждого диалога под фильтрами,
        по возрастанию conversation_id (без транскриптов)."""
        ...

    # --- апелляции ---

    def add_appeal(
        self, appeal: dict[str, Any], evaluation: dict[str, Any], *, expected_revision: int
    ) -> None:
        """Сохраняет апелляцию и обновлённую оценку атомарно.
        DuplicateAppealError — апелляция по критерию уже есть; RevisionConflictError — оценку
        изменили.
        """
        ...

    def resolve_appeal(
        self, appeal: dict[str, Any], evaluation: dict[str, Any], *, expected_revision: int
    ) -> None:
        """Сохраняет решение и пересчитанную оценку атомарно.
        AppealNotOpenError — апелляция уже рассмотрена; RevisionConflictError — оценку изменили.
        """
        ...

    def get_appeal(self, appeal_id: str) -> dict[str, Any] | None: ...

    def list_appeals(
        self,
        *,
        group_id: str | None = None,
        status: AppealStatus | None = None,
        evaluation_ids: Sequence[str] | None = None,
        conversation_id: str | None = None,
        purpose: Purpose | None = None,
    ) -> list[dict[str, Any]]:
        """Сначала открытые (старые первыми — это очередь), затем рассмотренные
        (последние решения первыми). purpose — назначение оценки, к которой подана."""
        ...
