"""Точность оценок относительно эталона eval/gold.json (расчёт — compute_accuracy движка).

Здесь только выбор оценок и чтение файлов разметки: без версии чек-листа берутся
последние обычные (regular) оценки, с версией — последние оценки этой версии любого
назначения; явный purpose фильтрует в обоих случаях.
"""

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from app.api.checklists import DEFAULT_CHECKLIST_ID
from app.api.engine import Evaluator
from app.api.errors import gold_unavailable
from app.config import Settings
from app.store import Purpose, Store


def accuracy_report(
    store: Store,
    evaluator: Evaluator,
    settings: Settings,
    *,
    group_id: str,
    checklist_id: str | None,
    checklist_version: int | None,
    purpose: Purpose | None,
) -> dict[str, Any]:
    resolved_checklist = checklist_id or DEFAULT_CHECKLIST_ID
    evaluations = store.latest_evaluations(
        group_id=group_id,
        purpose=_effective_purpose(purpose, checklist_version),
        checklist_id=resolved_checklist,
        checklist_version=checklist_version,
    )
    version = store.get_checklist_version(resolved_checklist, checklist_version)
    return evaluator.compute_accuracy(
        [stored.doc for stored in evaluations],
        load_gold(settings.gold_path),
        load_split(settings.split_path),
        group_id=group_id,
        checklist_version=checklist_version,
        checklist=version.doc if version else None,
    )


def _effective_purpose(purpose: Purpose | None, checklist_version: int | None) -> Purpose | None:
    if purpose is not None:
        return purpose
    return None if checklist_version is not None else "regular"


def load_gold(path: Path) -> list[dict[str, Any]]:
    """Эталон: список разметок диалогов (или {"conversations": [...]})."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise gold_unavailable(detail=f"{path.name}: {type(exc).__name__}") from None
    items = data.get("conversations") if isinstance(data, Mapping) else data
    if not isinstance(items, list):
        raise gold_unavailable(detail=f"{path.name}: ожидается список разметок")
    return [item for item in items if isinstance(item, dict)]


def load_split(path: Path) -> dict[str, Any] | None:
    """Разбиение на holdout/tuning; нет файла — набор берётся из поля set эталона."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
