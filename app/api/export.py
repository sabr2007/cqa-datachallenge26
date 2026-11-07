"""Экспорт последних обычных оценок набора: JSON (для машин) и CSV (для Excel).

CSV рассчитан на Excel с русской локалью: разделитель «;», десятичная запятая,
UTF-8 с BOM, строки CRLF. Текст, похожий на формулу, экранируется апострофом.
"""

import csv
import io
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from app.store import StoredEvaluation, utc_now

CSV_DELIMITER = ";"
UTF8_BOM = "\ufeff"  # BOM: Excel узнаёт UTF-8 и не ломает кириллицу
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_CRITERION_FIELDS = ("answer", "points", "final_answer", "final_points")
_HEAD_COLUMNS = (
    "group_id",
    "conversation_id",
    "language",
    "evaluation_id",
    "created_at",
    "checklist_id",
    "checklist_version",
)
_TAIL_COLUMNS = (
    "total",
    "final_total",
    "critical_flag",
    "critical_note",
    "needs_review",
    "models",
    "cost_usd",
)


def export_items(evaluations: Sequence[StoredEvaluation]) -> list[dict[str, Any]]:
    return [_item(stored) for stored in evaluations]


def export_json(group_id: str | None, evaluations: Sequence[StoredEvaluation]) -> dict[str, Any]:
    return {"group_id": group_id, "exported_at": utc_now(), "items": export_items(evaluations)}


def export_csv(evaluations: Sequence[StoredEvaluation]) -> bytes:
    items = export_items(evaluations)
    criterion_ids = list(
        dict.fromkeys(criterion["criterion_id"] for item in items for criterion in item["criteria"])
    )
    header = [
        *_HEAD_COLUMNS,
        *(f"{cid}_{field}" for cid in criterion_ids for field in _CRITERION_FIELDS),
        *_TAIL_COLUMNS,
    ]
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=CSV_DELIMITER, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(_row(item, criterion_ids) for item in items)
    return (UTF8_BOM + buffer.getvalue()).encode("utf-8")


def export_filename(group_id: str | None, extension: str) -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return f"cqa-{group_id or 'all'}-{stamp}.{extension}"


def _item(stored: StoredEvaluation) -> dict[str, Any]:
    doc = stored.doc
    return {
        "group_id": doc.get("group_id"),
        "conversation_id": doc.get("conversation_id"),
        "language": stored.language,
        "channel": stored.channel,
        "evaluation_id": doc.get("id"),
        "created_at": doc.get("created_at"),
        "checklist_id": doc.get("checklist_id"),
        "checklist_version": doc.get("checklist_version"),
        "models": list(doc.get("models") or []),
        "criteria": [
            {
                "criterion_id": criterion.get("criterion_id"),
                "title": criterion.get("title"),
                "answer": criterion.get("answer"),
                "final_answer": criterion.get("final_answer"),
                "points": criterion.get("points"),
                "final_points": criterion.get("final_points"),
                "max_points": criterion.get("max_points"),
                "final_max_points": criterion.get("final_max_points"),
            }
            for criterion in doc.get("criteria") or []
            if isinstance(criterion, dict)
        ],
        "total": doc.get("total"),
        "final_total": doc.get("final_total"),
        "critical_flag": bool(doc.get("critical_flag")),
        "critical_note": doc.get("critical_note"),
        "needs_review": bool(doc.get("needs_review")),
        "cost_usd": doc.get("cost_usd"),
    }


def _row(item: dict[str, Any], criterion_ids: Sequence[str]) -> list[str]:
    by_id = {criterion["criterion_id"]: criterion for criterion in item["criteria"]}
    cells: list[object] = [item[column] for column in _HEAD_COLUMNS]
    for criterion_id in criterion_ids:
        criterion = by_id.get(criterion_id, {})
        cells.extend(criterion.get(field) for field in _CRITERION_FIELDS)
    tail = {**item, "models": ", ".join(item["models"])}
    cells.extend(tail[column] for column in _TAIL_COLUMNS)
    return [_cell(value) for value in cells]


def _cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int | float):
        return format(Decimal(str(value)).normalize(), "f").replace(".", ",")
    text = str(value)
    return "'" + text if text.startswith(_FORMULA_PREFIXES) else text
