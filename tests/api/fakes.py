"""Фейковый движок оценки для API-тестов: детерминированный, без сети и моделей.

Ответы по умолчанию: «Да/Нет» — yes (у грубой ошибки — no), шкала — верхняя ступень;
тест может задать свои ответы для диалога. Баллы считаются по правилам чек-листа
(вес, перераспределение N/A, half-up до 2 знаков) — этого достаточно, чтобы проверить,
что бэкенд правильно берёт результаты пересчёта.
"""

import asyncio
from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from app.api.engine import InvalidAnswerError
from app.api.errors import engine_unavailable
from app.models import Conversation

YES = "yes"
NO = "no"
NA = "na"
CENT = Decimal("0.01")

FAKE_MODELS = (
    {
        "id": "fake-judge",
        "provider": "fake",
        "label": "Fake judge",
        "available": True,
        "default": True,
        "price": {"unit": "local", "currency": "USD"},
    },
    {
        "id": "fake-offline",
        "provider": "fake",
        "label": "Fake offline",
        "available": False,
        "default": False,
        "price": {"unit": "local", "currency": "USD"},
    },
)


class FakeEvaluator:
    def __init__(self) -> None:
        self.answers: dict[str, dict[str, object]] = {}  # conversation_id → {criterion_id: ответ}
        self.calls: list[dict[str, Any]] = []
        self.accuracy_calls: list[dict[str, Any]] = []
        self.failure: BaseException | None = None
        self.result: object = None  # вернуть как есть вместо оценки
        self.delay_sec = 0.0
        self.unavailable = False

    async def evaluate(
        self,
        conversation: Conversation,
        checklist: dict[str, Any],
        *,
        models: list[str] | None,
        reuse: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if self.unavailable:
            raise engine_unavailable(detail="фейковый движок выключен")
        self.calls.append(
            {
                "conversation_id": conversation.conversation_id,
                "checklist": checklist,
                "models": models,
                "reuse": reuse,
            }
        )
        if self.delay_sec:
            await asyncio.sleep(self.delay_sec)
        if self.failure is not None:
            raise self.failure
        if self.result is not None:
            return self.result  # type: ignore[return-value]
        return self._evaluation(conversation, checklist, models)

    def score(self, checklist: dict[str, Any], answers: dict[str, Any]) -> dict[str, Any]:
        criteria = checklist["criteria"]
        normalized = {c["id"]: self.normalize_answer(c, answers.get(c["id"])) for c in criteria}
        scored = [c for c in criteria if c.get("scored", True) is not False]
        applicable = [c for c in scored if normalized[c["id"]] not in (None, NA)]
        weight_sum = sum((Decimal(str(c["weight"])) for c in applicable), Decimal(0))
        exact: dict[str, tuple[Decimal | None, Decimal | None]] = {
            c["id"]: (None, None) for c in criteria
        }
        if weight_sum > 0:
            for criterion in applicable:
                max_points = Decimal(str(criterion["weight"])) * 100 / weight_sum
                fraction = _fraction(criterion, normalized[criterion["id"]])
                exact = {**exact, criterion["id"]: (fraction * max_points, max_points)}
        sections = [_section(section, exact) for section in checklist.get("sections") or []]
        pairs = [pair for pair in exact.values() if pair[0] is not None]
        return {
            "criteria": {
                cid: {"points": _round(points), "max_points": _round(max_points)}
                for cid, (points, max_points) in exact.items()
            },
            "sections": sections,
            "total": _round(sum((p for p, _ in pairs), Decimal(0))) if pairs else None,
            "max_total": _round(sum((m for _, m in pairs), Decimal(0))) if pairs else None,
            "critical_flag": any(
                c.get("critical") and normalized[c["id"]] == YES for c in criteria
            ),
        }

    def normalize_answer(self, criterion: Mapping[str, Any], value: object) -> Any:
        if value is None:
            return None
        if isinstance(value, str) and value.strip().lower() in (NA, "n/a"):
            if not criterion.get("naAllowed"):
                raise InvalidAnswerError(f"Критерий {criterion['id']}: N/A не разрешён")
            return NA
        if criterion.get("answerType") == "scale":
            steps = [step["value"] for step in criterion.get("scale") or []]
            if isinstance(value, int | float) and not isinstance(value, bool) and value in steps:
                return int(value)
            raise InvalidAnswerError(f"Критерий {criterion['id']}: {value!r} — не ступень шкалы")
        if value in (YES, NO):
            return value
        raise InvalidAnswerError(f"Критерий {criterion['id']}: ожидается yes/no")

    def list_models(self) -> list[dict[str, Any]]:
        if self.unavailable:
            raise engine_unavailable(detail="фейковый движок выключен")
        return [dict(model) for model in FAKE_MODELS]

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
        self.accuracy_calls.append(
            {
                "evaluation_ids": [item["id"] for item in evaluations],
                "gold": list(gold),
                "split": split,
                "group_id": group_id,
                "checklist_version": checklist_version,
                "checklist": checklist,
            }
        )
        return {
            "group_id": group_id,
            "checklist_version": checklist_version,
            "gold_count": len(gold),
            "evaluated_count": len(evaluations),
        }

    def _evaluation(
        self, conversation: Conversation, checklist: dict[str, Any], models: list[str] | None
    ) -> dict[str, Any]:
        scripted = self.answers.get(conversation.conversation_id, {})
        anchor = next(
            (m for m in conversation.messages if m.speaker == "operator"), conversation.messages[0]
        )
        used_models = list(models or ["fake-judge"])
        answers = {
            c["id"]: scripted.get(c["id"], _default_answer(c)) for c in checklist["criteria"]
        }
        scores = self.score(checklist, answers)
        results = [
            {
                "criterion_id": c["id"],
                "title": c["title"],
                "answer_type": c["answerType"],
                "weight": c["weight"],
                "critical": bool(c.get("critical")),
                "scored": c.get("scored", True) is not False,
                "answer": answers[c["id"]],
                "final_answer": answers[c["id"]],
                **scores["criteria"][c["id"]],
                "final_points": scores["criteria"][c["id"]]["points"],
                "explanation": f"Фейковое обоснование {c['id']}",
                "evidence": [{"index": anchor.index, "quote": anchor.text[:30], "verified": True}],
                "checked_range": None,
                "na_reason": None,
                "confidence": 1.0,
                "votes": [{"model": model, "answer": answers[c["id"]]} for model in used_models],
                "needs_review": False,
                "review_reasons": [],
                "appeal": None,
                "definition_hash": f"fake-{c['id']}",
                "reused": False,
            }
            for c in checklist["criteria"]
        ]
        critical = [r for r in results if r["critical"] and r["answer"] == YES]
        return {
            "conversation_id": conversation.conversation_id,
            "checklist_id": checklist.get("id"),
            "checklist_version": checklist.get("version"),
            "models": used_models,
            "criteria": results,
            "sections": [{**s, "final_points": s["points"]} for s in scores["sections"]],
            "total": scores["total"],
            "final_total": scores["total"],
            "max_total": scores["max_total"],
            "critical_flag": scores["critical_flag"],
            "critical_note": "; ".join(r["explanation"] for r in critical) or None,
            "needs_review": False,
            "cost_usd": 0.0123,
            "tokens": {"input": 100, "output": 20},
            "latency_ms": 5,
            "status": "done",
            "error": None,
            "warnings": [],
            "engine": {"prompt_version": "fake"},
        }


def _default_answer(criterion: Mapping[str, Any]) -> object:
    if criterion.get("answerType") == "scale":
        return max(step["value"] for step in criterion["scale"])
    return NO if criterion.get("critical") else YES


def _fraction(criterion: Mapping[str, Any], answer: object) -> Decimal:
    if criterion.get("answerType") == "scale":
        top = max(Decimal(str(step["value"])) for step in criterion["scale"])
        return Decimal(str(answer)) / top
    return Decimal(1) if answer == YES else Decimal(0)


def _section(
    section: Mapping[str, Any], exact: Mapping[str, tuple[Decimal | None, Decimal | None]]
) -> dict[str, Any]:
    pairs = [exact[cid] for cid in section["criteria"] if exact.get(cid, (None,))[0] is not None]
    return {
        "id": section["id"],
        "title": section["title"],
        "points": _round(sum((p for p, _ in pairs), Decimal(0))) if pairs else None,
        "max_points": _round(sum((m for _, m in pairs), Decimal(0))) if pairs else None,
    }


def _round(value: Decimal | None) -> float | None:
    return None if value is None else float(value.quantize(CENT, rounding=ROUND_HALF_UP))
