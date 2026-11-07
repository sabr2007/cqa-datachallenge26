"""Аналитика набора по последней обычной оценке каждого диалога (форма — docs/CONTRACT.md).

Считается по final_answer (с учётом решений по апелляциям). Провал критерия:
«Да/Нет» — «Нет» (у грубой ошибки critical — «Да»); шкала — ниже верхней ступени.
"""

import re
from collections.abc import Mapping, Sequence
from typing import Any

from app.store import Store

YES = "yes"
NO = "no"
NA = "na"
TOP_QUOTES = 5
RATE_DIGITS = 4
_QUOTE_NOISE_RE = re.compile(r"[\s\"'«»“”„.,!?;:…—–-]+")

Definitions = Mapping[tuple[str, int], Mapping[str, Mapping[str, Any]]]


def group_analytics(store: Store, group_id: str | None) -> dict[str, Any]:
    """Ответы — по последним обычным оценкам набора; апелляции — все по обычным оценкам
    набора (история споров не теряется после переоценки)."""
    evaluations = [stored.doc for stored in store.latest_evaluations(group_id=group_id)]
    appeals = store.list_appeals(group_id=group_id, purpose="regular")
    definitions: dict[tuple[str, int], dict[str, Mapping[str, Any]]] = {}
    for key in {(item.get("checklist_id"), item.get("checklist_version")) for item in evaluations}:
        version = store.get_checklist_version(*key)
        if version is not None:
            definitions[key] = {
                criterion["id"]: criterion
                for criterion in version.doc.get("criteria") or []
                if isinstance(criterion, Mapping) and "id" in criterion
            }
    return analytics_report(group_id, evaluations, appeals, definitions)


def analytics_report(
    group_id: str | None,
    evaluations: Sequence[Mapping[str, Any]],
    appeals: Sequence[Mapping[str, Any]],
    definitions: Definitions,
) -> dict[str, Any]:
    """evaluations — последние обычные оценки; appeals — апелляции по обычным оценкам;
    definitions — {(checklist_id, version): {criterion_id: определение критерия}}."""
    stats: dict[str, _CriterionStats] = {}
    critical: list[dict[str, Any]] = []
    for evaluation in evaluations:
        version_key = (evaluation.get("checklist_id"), evaluation.get("checklist_version"))
        criteria_defs = definitions.get(version_key, {})
        for result in evaluation.get("criteria") or []:
            criterion_id = result.get("criterion_id")
            if not isinstance(criterion_id, str):
                continue
            if criterion_id not in stats:
                stats[criterion_id] = _CriterionStats(result, criteria_defs.get(criterion_id))
            stats[criterion_id].add(evaluation, result)
            if result.get("critical") and result.get("final_answer") == YES:
                critical.append(_critical_entry(evaluation, result))
    appeal_stats = _appeal_stats(appeals)
    return {
        "group_id": group_id,
        "evaluated_count": len(evaluations),
        "criteria": [
            item.as_dict(appeal_stats.get(criterion_id)) for criterion_id, item in stats.items()
        ],
        "critical": critical,
        "appeals": {
            "total": len(appeals),
            "resolved": sum(1 for appeal in appeals if appeal.get("status") == "resolved"),
            "accepted": sum(1 for appeal in appeals if _accepted(appeal)),
        },
    }


class _CriterionStats:
    def __init__(self, result: Mapping[str, Any], definition: Mapping[str, Any] | None) -> None:
        self.criterion_id = result["criterion_id"]
        self.title = result.get("title") or (definition or {}).get("title")
        self.answer_type = result.get("answer_type") or (definition or {}).get("answerType")
        self.critical = bool(result.get("critical"))
        self.top_step = _top_step(definition)
        self.answers: dict[str, int] = dict.fromkeys(_answer_keys(definition), 0)
        self.applicable = 0
        self.fail_count = 0
        self.quotes: dict[str, dict[str, Any]] = {}

    def add(self, evaluation: Mapping[str, Any], result: Mapping[str, Any]) -> None:
        answer = result.get("final_answer")
        if answer is None:
            return
        key = _answer_key(answer)
        self.answers = {**self.answers, key: self.answers.get(key, 0) + 1}
        if answer == NA:
            return
        self.applicable += 1
        if self._failed(result, answer):
            self.fail_count += 1
            self._collect_quotes(evaluation, result)

    def as_dict(self, appeals: Mapping[str, int] | None) -> dict[str, Any]:
        counts = appeals or {"total": 0, "resolved": 0, "accepted": 0}
        top = sorted(self.quotes.values(), key=lambda quote: -quote["count"])[:TOP_QUOTES]
        return {
            "criterion_id": self.criterion_id,
            "title": self.title,
            "answer_type": self.answer_type,
            "applicable": self.applicable,
            "answers": self.answers,
            "fail_count": self.fail_count,
            "fail_rate": _rate(self.fail_count, self.applicable),
            "top_quotes": top,
            "appeals": {
                "total": counts["total"],
                "resolved": counts["resolved"],
                "accepted": counts["accepted"],
                "rate": _rate(counts["accepted"], counts["resolved"]),
            },
        }

    def _failed(self, result: Mapping[str, Any], answer: object) -> bool:
        if self.answer_type == "scale":
            if self.top_step is not None and _is_number(answer):
                return answer < self.top_step
            points, max_points = result.get("final_points"), result.get("final_max_points")
            return _is_number(points) and _is_number(max_points) and points < max_points
        return answer == (YES if self.critical else NO)

    def _collect_quotes(self, evaluation: Mapping[str, Any], result: Mapping[str, Any]) -> None:
        for evidence in result.get("evidence") or []:
            if not isinstance(evidence, Mapping) or evidence.get("verified") is False:
                continue
            quote = evidence.get("quote")
            if not isinstance(quote, str) or not quote.strip():
                continue
            key = _QUOTE_NOISE_RE.sub(" ", quote).strip().casefold()
            if key in self.quotes:
                previous = self.quotes[key]
                self.quotes = {**self.quotes, key: {**previous, "count": previous["count"] + 1}}
                continue
            self.quotes = {
                **self.quotes,
                key: {
                    "conversation_id": evaluation.get("conversation_id"),
                    "index": evidence.get("index"),
                    "quote": quote.strip(),
                    "explanation": result.get("explanation"),
                    "count": 1,
                },
            }


def _critical_entry(evaluation: Mapping[str, Any], result: Mapping[str, Any]) -> dict[str, Any]:
    evidence = next(
        (item for item in result.get("evidence") or [] if isinstance(item, Mapping)), {}
    )
    return {
        "conversation_id": evaluation.get("conversation_id"),
        "evaluation_id": evaluation.get("id"),
        "note": evaluation.get("critical_note") or result.get("explanation"),
        "index": evidence.get("index"),
        "quote": evidence.get("quote"),
    }


def _appeal_stats(appeals: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, int]]:
    stats: dict[str, dict[str, int]] = {}
    for appeal in appeals:
        criterion_id = appeal.get("criterion_id")
        current = stats.get(criterion_id, {"total": 0, "resolved": 0, "accepted": 0})
        stats = {
            **stats,
            criterion_id: {
                "total": current["total"] + 1,
                "resolved": current["resolved"] + int(appeal.get("status") == "resolved"),
                "accepted": current["accepted"] + int(_accepted(appeal)),
            },
        }
    return stats


def _accepted(appeal: Mapping[str, Any]) -> bool:
    decision = appeal.get("decision")
    return isinstance(decision, Mapping) and decision.get("action") == "change"


def _answer_keys(definition: Mapping[str, Any] | None) -> list[str]:
    """Все возможные ответы критерия (для нулевых счётчиков): yes/no или ступени, затем na."""
    if not definition:
        return []
    if definition.get("answerType") == "scale":
        values = sorted(
            (step.get("value") for step in definition.get("scale") or [] if _is_step(step)),
            reverse=True,
        )
        keys = [_answer_key(value) for value in values]
    else:
        keys = [YES, NO]
    return [*keys, NA] if definition.get("naAllowed") else keys


def _top_step(definition: Mapping[str, Any] | None) -> float | None:
    if not definition or definition.get("answerType") != "scale":
        return None
    values = [step["value"] for step in definition.get("scale") or [] if _is_step(step)]
    return max(values) if values else None


def _answer_key(answer: object) -> str:
    if isinstance(answer, float) and answer.is_integer():
        return str(int(answer))
    return str(answer)


def _rate(part: int, whole: int) -> float | None:
    return round(part / whole, RATE_DIGITS) if whole else None


def _is_step(step: object) -> bool:
    return isinstance(step, Mapping) and _is_number(step.get("value"))


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)
