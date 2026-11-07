"""Связь API с движком оценки (app.engine) через подменяемый Evaluator.

В работе — EngineEvaluator: app.engine импортируется при первом обращении, поэтому
API поднимается и отвечает, даже если движок ещё дописывается или сломан (такие
вызовы получают 503 engine_unavailable). В тестах вместо него подставляется фейк
из tests/ — заготовленных результатов в рабочем коде нет.
"""

import importlib
from collections.abc import Mapping, Sequence
from types import ModuleType
from typing import Any, Protocol

from app.api.errors import engine_unavailable, scrub
from app.models import Conversation


class InvalidAnswerError(ValueError):
    """Ответ не подходит критерию (тип, ступень шкалы, N/A там, где он запрещён)."""


class Evaluator(Protocol):
    async def evaluate(
        self,
        conversation: Conversation,
        checklist: dict[str, Any],
        *,
        models: list[str] | None,
        reuse: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Evaluation без полей хранения (id, created_at, group_id, purpose)."""
        ...

    def score(self, checklist: dict[str, Any], answers: dict[str, Any]) -> dict[str, Any]:
        """{"criteria": {id: {"points", "max_points"}}, "sections", "total", "critical_flag"}."""
        ...

    def normalize_answer(self, criterion: Mapping[str, Any], value: object) -> Any:
        """Канонический ответ ("yes"/"no"/"na" или ступень шкалы); InvalidAnswerError."""
        ...

    def list_models(self) -> list[dict[str, Any]]:
        """[{"id", "provider", "label", "available", "default", "price"}]."""
        ...

    def compute_accuracy(
        self,
        evaluations: Sequence[Mapping[str, Any]],
        gold: Sequence[Mapping[str, Any]],
        split: Mapping[str, Any] | None,
        *,
        group_id: str | None,
        checklist_version: int | None,
        checklist: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """Отчёт для /api/metrics/accuracy (форма — docs/CONTRACT.md)."""
        ...


class EngineEvaluator:
    """Evaluator поверх app.engine (интерфейс — docs/CONTRACT.md)."""

    async def evaluate(
        self,
        conversation: Conversation,
        checklist: dict[str, Any],
        *,
        models: list[str] | None,
        reuse: dict[str, Any] | None,
    ) -> dict[str, Any]:
        evaluate_conversation = _engine_function("evaluate_conversation")
        return await evaluate_conversation(conversation, checklist, models=models, reuse=reuse)

    def score(self, checklist: dict[str, Any], answers: dict[str, Any]) -> dict[str, Any]:
        return _engine_function("score_evaluation")(checklist, answers)

    def normalize_answer(self, criterion: Mapping[str, Any], value: object) -> Any:
        engine = _engine()
        normalize = _engine_function("normalize_answer")
        answer_error = getattr(engine, "AnswerError", ValueError)
        try:
            return normalize(criterion, value)
        except answer_error as exc:
            raise InvalidAnswerError(str(exc)) from exc

    def list_models(self) -> list[dict[str, Any]]:
        return _engine_function("list_models")()

    def compute_accuracy(
        self,
        evaluations: Sequence[Mapping[str, Any]],
        gold: Sequence[Mapping[str, Any]],
        split: Mapping[str, Any] | None,
        *,
        group_id: str | None,
        checklist_version: int | None,
        checklist: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        return _engine_function("compute_accuracy")(
            evaluations,
            gold,
            split,
            group_id=group_id,
            checklist_version=checklist_version,
            checklist=checklist,
        )


def _engine_function(name: str) -> Any:
    function = getattr(_engine(), name, None)
    if not callable(function):
        raise engine_unavailable(detail=f"в app.engine нет функции {name}")
    return function


def _engine() -> ModuleType:
    try:
        return importlib.import_module("app.engine")
    except Exception as exc:  # движок может быть недописан: API при этом продолжает работать
        raise engine_unavailable(detail=scrub(f"{type(exc).__name__}: {exc}")) from None
