"""Точность оценок относительно экспертного эталона (eval/gold.json).

Форма ответа — как /api/metrics/accuracy в docs/CONTRACT.md («Дополнения (v2)»).
Сравниваем исходный ответ системы (answer, не решение по апелляции) по каждому
критерию; total — пары (эталон, ответ системы), где оба есть.
"""

import json
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from app.engine.scoring import NA, AnswerError, normalize_answer, scale_values

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CHECKLIST = PROJECT_ROOT / "config" / "checklists" / "chat-default.json"
DEFAULT_EXPERT_PAIRS = PROJECT_ROOT / "eval" / "expert_pairs.json"
_FROM_FILE: Any = object()  # expert_pairs не передан — читаем eval/expert_pairs.json
SETS = ("holdout", "tuning")
LANGUAGE_ORDER = {"RU": 0, "KZ": 1, "EN": 2}


def compute_accuracy(
    evaluations: Iterable[Mapping[str, Any]],
    gold: Sequence[Mapping[str, Any]],
    split: Mapping[str, Any] | None = None,
    *,
    group_id: str | None = None,
    checklist_version: int | None = None,
    checklist: Mapping[str, Any] | None = None,
    expert_pairs: Sequence[Mapping[str, Any]] | None = _FROM_FILE,
) -> dict[str, Any]:
    """expert_pairs — независимая двойная разметка (eval/expert_pairs.json) для ориентира
    «согласие экспертов между собой»; None — не считать."""
    latest = latest_by_conversation(evaluations)
    criteria_defs = _criteria_definitions(checklist)
    set_of = _set_lookup(split)

    overall = _Counter()
    by_set = {name: _Counter() for name in SETS}
    by_criterion: dict[str, dict[str, Any]] = {}
    by_language: dict[str, _Counter] = defaultdict(_Counter)
    by_model: dict[str, _Counter] = defaultdict(_Counter)
    confusion: dict[str, dict[str, int]] = defaultdict(lambda: {"na_as_no": 0, "no_as_na": 0})
    human = _HumanDecided()
    conversations = []

    for entry in gold:
        conversation_id = entry.get("conversation_id")
        language = entry.get("language")
        subset = set_of.get(conversation_id) or entry.get("set")
        evaluation = latest.get(conversation_id)
        system = _system_answers(evaluation, criteria_defs)
        row = _Counter()
        mismatches = []
        for criterion_id, gold_item in sorted((entry.get("answers") or {}).items()):
            gold_value = _canonical(criteria_defs.get(criterion_id), _gold_value(gold_item))
            if gold_value is None:
                continue
            for model, model_answer in _model_answers(evaluation, criterion_id, criteria_defs):
                by_model[model].add(model_answer == gold_value)
            if criterion_id not in system:
                continue
            answer = system[criterion_id]
            matched = answer == gold_value
            stats = by_criterion.setdefault(
                criterion_id, _criterion_stats(criterion_id, evaluation)
            )
            if stats["title"] is None:
                stats["title"] = _title(evaluation, criterion_id)
            for counter in (overall, row, by_language[language], stats["all"]):
                counter.add(matched)
            if subset in by_set:
                by_set[subset].add(matched)
                stats[subset].add(matched)
            if _is_scale(criteria_defs.get(criterion_id)):
                stats["within_one"].add(
                    _within_one(criteria_defs[criterion_id], answer, gold_value)
                )
            if gold_value == NA and answer == "no":
                confusion[criterion_id]["na_as_no"] += 1
            elif gold_value == "no" and answer == NA:
                confusion[criterion_id]["no_as_na"] += 1
            if not matched:
                mismatches.append(
                    {"criterion_id": criterion_id, "gold": gold_value, "system": answer}
                )
            if isinstance(gold_item, Mapping) and gold_item.get("decided_by"):
                human.add(conversation_id, subset, criterion_id, gold_value, answer)
        conversations.append(
            {
                "conversation_id": conversation_id,
                "language": language,
                "set": subset,
                "evaluation_id": evaluation.get("id") if evaluation else None,
                "checklist_version": evaluation.get("checklist_version") if evaluation else None,
                **row.as_dict(),
                "mismatches": mismatches,
            }
        )

    return {
        "group_id": group_id,
        "checklist_version": checklist_version,
        "gold_count": len(gold),
        "evaluated_count": sum(1 for row in conversations if row["conversation_id"] in latest),
        "overall": overall.as_dict(),
        "by_set": {name: counter.as_dict() for name, counter in by_set.items()},
        "by_criterion": [_criterion_row(stats) for _, stats in sorted(by_criterion.items())],
        "by_language": [
            {"language": language, **counter.as_dict()}
            for language, counter in sorted(
                by_language.items(), key=lambda kv: LANGUAGE_ORDER.get(kv[0], 9)
            )
        ],
        "na_confusion": {
            "na_as_no": sum(item["na_as_no"] for item in confusion.values()),
            "no_as_na": sum(item["no_as_na"] for item in confusion.values()),
            "by_criterion": [
                {"criterion_id": criterion_id, **counts}
                for criterion_id, counts in sorted(confusion.items())
            ],
        },
        "by_model": [
            {"model": model, **counter.as_dict()} for model, counter in sorted(by_model.items())
        ],
        "expert_agreement": expert_agreement(
            _load_pairs() if expert_pairs is _FROM_FILE else expert_pairs, criteria_defs
        ),
        "human_decided": human.as_dict(),
        "conversations": conversations,
    }


def latest_by_conversation(
    evaluations: Iterable[Mapping[str, Any]],
) -> dict[str, Mapping[str, Any]]:
    """Последняя оценка на диалог: по created_at, без даты — первая встреченная."""
    latest: dict[str, Mapping[str, Any]] = {}
    for evaluation in evaluations:
        conversation_id = evaluation.get("conversation_id")
        if not conversation_id:
            continue
        current = latest.get(conversation_id)
        if current is None or str(evaluation.get("created_at") or "") > str(
            current.get("created_at") or ""
        ):
            latest[conversation_id] = evaluation
    return latest


def expert_agreement(
    pairs: Sequence[Mapping[str, Any]] | None,
    definitions: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Согласие разметчиков между собой по каждому критерию (все пары разметчиков чата)."""
    if not pairs:
        return None
    counter = _Counter()
    for entry in pairs:
        labelers = [item.get("answers") or {} for item in entry.get("labelers") or []]
        for left_pos, left in enumerate(labelers):
            for right in labelers[left_pos + 1 :]:
                for criterion_id in sorted(set(left) & set(right)):
                    definition = (definitions or {}).get(criterion_id)
                    a = _canonical(definition, _gold_value(left[criterion_id]))
                    b = _canonical(definition, _gold_value(right[criterion_id]))
                    if a is not None and b is not None:
                        counter.add(a == b)
    return counter.as_dict() if counter.total else None


def _load_pairs() -> list[dict[str, Any]] | None:
    try:
        data = json.loads(DEFAULT_EXPERT_PAIRS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, list) else None


def load_gold(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else list(data.get("conversations") or [])


class _HumanDecided:
    """Ответы эталона, решённые людьми вопреки предразметке модели (decided_by) —
    самая честная цифра: здесь согласие не может быть «модель против модели»."""

    def __init__(self) -> None:
        self.overall = _Counter()
        self.by_set = {name: _Counter() for name in SETS}
        self.items: list[dict[str, Any]] = []

    def add(self, conversation_id: str, subset: str, criterion_id: str, gold: Any, system: Any):
        matched = gold == system
        self.overall.add(matched)
        if subset in self.by_set:
            self.by_set[subset].add(matched)
        self.items.append(
            {
                "conversation_id": conversation_id,
                "set": subset,
                "criterion_id": criterion_id,
                "gold": gold,
                "system": system,
                "matched": matched,
            }
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            **self.overall.as_dict(),
            "by_set": {name: counter.as_dict() for name, counter in self.by_set.items()},
            "items": self.items,
        }


class _Counter:
    __slots__ = ("matched", "total")

    def __init__(self) -> None:
        self.matched = 0
        self.total = 0

    def add(self, matched: bool) -> None:
        self.total += 1
        self.matched += int(bool(matched))

    def as_dict(self) -> dict[str, Any]:
        accuracy = round(self.matched / self.total, 4) if self.total else None
        return {"matched": self.matched, "total": self.total, "accuracy": accuracy}


def _criterion_stats(criterion_id: str, evaluation: Mapping[str, Any] | None) -> dict[str, Any]:
    return {
        "criterion_id": criterion_id,
        "title": _title(evaluation, criterion_id),
        "all": _Counter(),
        "holdout": _Counter(),
        "tuning": _Counter(),
        "within_one": _Counter(),
    }


def _criterion_row(stats: Mapping[str, Any]) -> dict[str, Any]:
    row = {
        "criterion_id": stats["criterion_id"],
        "title": stats["title"],
        **stats["all"].as_dict(),
        "holdout": stats["holdout"].as_dict(),
        "tuning": stats["tuning"].as_dict(),
    }
    if stats["within_one"].total:
        row["within_one"] = stats["within_one"].as_dict()
    return row


def _system_answers(
    evaluation: Mapping[str, Any] | None, definitions: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    if not evaluation:
        return {}
    answers = {}
    for item in evaluation.get("criteria") or []:
        criterion_id = item.get("criterion_id")
        value = _canonical(definitions.get(criterion_id), item.get("answer"))
        if criterion_id and value is not None:
            answers[criterion_id] = value
    return answers


def _model_answers(
    evaluation: Mapping[str, Any] | None,
    criterion_id: str,
    definitions: Mapping[str, Mapping[str, Any]],
) -> list[tuple[str, Any]]:
    if not evaluation:
        return []
    for item in evaluation.get("criteria") or []:
        if item.get("criterion_id") != criterion_id or item.get("reused"):
            continue
        pairs = []
        for vote in item.get("votes") or []:
            value = _canonical(definitions.get(criterion_id), vote.get("answer"))
            if vote.get("model") and value is not None:
                pairs.append((vote["model"], value))
        return pairs
    return []


def _canonical(definition: Mapping[str, Any] | None, value: object) -> Any:
    if value is None:
        return None
    if definition is not None:
        try:
            return normalize_answer(definition, value)
        except AnswerError:
            return None
    if isinstance(value, str):
        text = value.strip().lower()
        return int(text) if text.isdigit() else text
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _gold_value(item: object) -> object:
    return item.get("value") if isinstance(item, Mapping) else item


def _within_one(definition: Mapping[str, Any], answer: Any, gold_value: Any) -> bool:
    if answer == gold_value:
        return True
    if NA in (answer, gold_value):
        return False
    steps = sorted(scale_values(definition))
    try:
        return abs(steps.index(answer) - steps.index(gold_value)) <= 1
    except ValueError:
        return False


def _is_scale(definition: Mapping[str, Any] | None) -> bool:
    return bool(definition) and definition.get("answerType") == "scale"


def _criteria_definitions(checklist: Mapping[str, Any] | None) -> dict[str, Mapping[str, Any]]:
    source = checklist
    if source is None:
        try:
            source = json.loads(DEFAULT_CHECKLIST.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    return {c["id"]: c for c in source.get("criteria") or [] if "id" in c}


def _set_lookup(split: Mapping[str, Any] | None) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for name in SETS:
        for conversation_id in (split or {}).get(name) or []:
            lookup[conversation_id] = name
    return lookup


def _title(evaluation: Mapping[str, Any] | None, criterion_id: str) -> str | None:
    for item in (evaluation or {}).get("criteria") or []:
        if item.get("criterion_id") == criterion_id:
            return item.get("title")
    return None
