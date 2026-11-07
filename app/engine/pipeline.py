"""Оценка диалога по чек-листу.

Отдельный вызов модели на каждый критерий, критерии и модели — параллельно.
Ответ модели проверяется кодом (допустимый verdict, цитаты из реплик); при
ошибке — один повторный запрос с замечанием. Голоса моделей сводятся в ответ
с confidence/needs_review, баллы считает score_evaluation.
"""

import asyncio
import logging
import time
import weakref
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from app.engine import prompts
from app.engine.evidence import check_evidence
from app.engine.explain import localize_refs
from app.engine.providers import (
    CompletionRequest,
    ModelSpec,
    Provider,
    ProviderError,
    Usage,
    default_models,
    is_available,
    open_providers,
    resolve_spec,
)
from app.engine.reuse import criterion_fingerprint, reusable_criteria, reviewer_decision
from app.engine.scoring import NA, AnswerError, normalize_answer, scale_values, score_evaluation
from app.engine.settings import EngineSettings, load_engine_settings
from app.engine.transcript import extract_facts, format_transcript, render_facts
from app.engine.voting import Decision, Vote, decide
from app.models import Conversation, Message

logger = logging.getLogger("cqa.engine")

MAX_ATTEMPTS = 2  # первый запрос + один повтор с замечанием
PROVIDER_CONCURRENCY = {"anthropic": 16, "cloudflare": 32, "ollama": 2}
MAX_TOKENS = {"anthropic": 16000, "cloudflare": 8000, "ollama": 4096}
TIMEOUT_MARGIN_SEC = 1.0
# Не больше стольких запросов к одной модели сразу: у моделей Workers AI лимит запросов
# в минуту, и залп из десятков запросов к одной модели упирается в 429.
MODEL_CONCURRENCY = 16

_LoopSemaphores = dict[str, asyncio.Semaphore]
_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, _LoopSemaphores]" = (
    weakref.WeakKeyDictionary()
)


# Модель упёрлась в лимит запросов — на это время её голос сразу берём у резервной модели.
THROTTLE_SEC = 60.0
_throttled_until: dict[str, float] = {}


@dataclass(frozen=True, slots=True)
class _Context:
    conversation: Conversation
    system: str
    prefix: str
    union_schema: dict[str, Any]
    providers: Mapping[str, Provider]
    reserve: ModelSpec | None = None  # замена модели, которая не ответила по критерию


async def evaluate_conversation(
    conversation: Conversation,
    checklist: Mapping[str, Any],
    *,
    models: Sequence[str] | None = None,
    reuse: Mapping[str, Any] | None = None,
    providers: Mapping[str, Provider] | None = None,
    settings: EngineSettings | None = None,
) -> dict[str, Any]:
    """Evaluation без полей хранения (id, created_at, appeals) — схема в docs/CONTRACT.md."""
    started = time.monotonic()
    resolved = settings or load_engine_settings()
    criteria = list(checklist.get("criteria") or [])
    rules = checklist.get("rules") or {}
    requested = list(dict.fromkeys(models or default_models(resolved)))
    specs, warnings = _usable_specs(requested, resolved, providers)
    reused = reusable_criteria(checklist, reuse, conversation_id=conversation.conversation_id)
    pending = [c for c in criteria if c["id"] not in reused]

    votes: dict[str, list[Vote]] = {c["id"]: [] for c in pending}
    usage = Usage()
    if pending and not conversation.messages:
        return _error_result(
            conversation, checklist, requested, started, warnings, "В диалоге нет реплик."
        )
    if pending and not specs:
        message = "Нет доступных моделей: " + (", ".join(requested) or "список пуст")
        return _error_result(conversation, checklist, requested, started, warnings, message)
    queued_ms = 0
    if pending:
        # Очередь оценок: при пакетной переоценке лимиты моделей делятся между немногими
        # диалогами, и ожидание в очереди не съедает 90 с таймаута оценки.
        async with _slot("evaluations", resolved.parallel_evaluations):
            queued_ms = int((time.monotonic() - started) * 1000)
            started = time.monotonic()
            votes, usage, timeout_warnings = await _collect_votes(
                conversation, checklist, pending, specs, resolved, providers
            )
        warnings.extend(timeout_warnings)

    results = []
    for criterion in criteria:
        fingerprint = criterion_fingerprint(criterion, rules)
        if criterion["id"] in reused:
            results.append(_reused_result(criterion, reused[criterion["id"]], fingerprint))
        else:
            decision = decide(criterion, votes[criterion["id"]])
            results.append(
                _criterion_result(criterion, decision, votes[criterion["id"]], fingerprint)
            )
    evaluation = _assemble(
        conversation, checklist, results, [s.id for s in specs], usage, started, warnings
    )
    return {**evaluation, "queued_ms": queued_ms}


# ---------------------------------------------------------------- вызовы моделей


async def _collect_votes(
    conversation: Conversation,
    checklist: Mapping[str, Any],
    pending: Sequence[Mapping[str, Any]],
    specs: Sequence[ModelSpec],
    settings: EngineSettings,
    overrides: Mapping[str, Provider] | None,
) -> tuple[dict[str, list[Vote]], Usage, list[str]]:
    rules = checklist.get("rules") or {}
    facts = extract_facts(conversation, threshold_sec=rules.get("firstResponseThresholdSec"))
    deadline = time.monotonic() + settings.eval_timeout_sec - TIMEOUT_MARGIN_SEC
    reserve = _reserve_spec(specs, settings, overrides)
    names = {s.provider for s in specs} | ({reserve.provider} if reserve else set())
    async with open_providers(names, settings, overrides=overrides) as live:
        context = _Context(
            conversation=conversation,
            system=prompts.build_system_prompt(rules),
            prefix=prompts.build_prefix(
                format_transcript(conversation), render_facts(facts), channel=conversation.channel
            ),
            union_schema=prompts.response_schema(prompts.union_verdicts(checklist["criteria"])),
            providers=live,
            reserve=reserve,
        )
        tasks: dict[asyncio.Task[tuple[Vote, Usage]], tuple[str, str]] = {}
        for spec in specs:
            # Claude: первый критерий прогревает кеш префикса, остальные стартуют после него.
            gate = asyncio.Event() if spec.prompt_cache and len(pending) > 1 else None
            for position, criterion in enumerate(pending):
                leader = gate is not None and position == 0
                task = asyncio.create_task(_judge(context, spec, criterion, gate, leader))
                tasks[task] = (spec.id, criterion["id"])
        done, still_running, stopped_early = await _wait_for_votes(
            tasks, len(specs), deadline, early_stop=settings.early_stop
        )
        for task in still_running:
            task.cancel()
        await asyncio.gather(*still_running, return_exceptions=True)

    votes: dict[str, list[Vote]] = {c["id"]: [] for c in pending}
    usage = Usage()
    warnings: list[str] = []
    order = {spec.id: position for position, spec in enumerate(specs)}
    for task, (model_id, criterion_id) in tasks.items():
        if task in done and not task.cancelled() and task.exception() is None:
            vote, spent = task.result()
            usage = usage + spent
        elif stopped_early:
            vote = Vote(model=model_id, answer=None, skipped=True)
        else:
            vote = Vote(model=model_id, answer=None, error="модель не ответила за отведённое время")
            warnings.append(f"{criterion_id}: {model_id} не ответила за отведённое время")
        votes[criterion_id].append(vote)
    for criterion_id in votes:
        votes[criterion_id].sort(key=lambda vote: order.get(vote.model, len(order)))
    return votes, usage, warnings


async def _wait_for_votes(
    tasks: Mapping[asyncio.Task[tuple[Vote, Usage]], tuple[str, str]],
    model_count: int,
    deadline: float,
    *,
    early_stop: bool,
) -> tuple[set[asyncio.Task[Any]], set[asyncio.Task[Any]], bool]:
    """Ждёт голоса до дедлайна. При early_stop заканчивает раньше, как только по каждому
    критерию одинаково ответило большинство всех моделей: оставшиеся голоса уже не изменят
    ответ (и медиану шкалы), поэтому медленную модель не ждём."""
    remaining: set[asyncio.Task[Any]] = set(tasks)
    done: set[asyncio.Task[Any]] = set()
    while remaining:
        timeout = deadline - time.monotonic()
        if timeout <= 0:
            break
        finished, remaining = await asyncio.wait(
            remaining, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
        )
        done |= finished
        if early_stop and remaining and _majority_reached(done, tasks, model_count):
            return done, remaining, True
    return done, remaining, False


def _majority_reached(
    done: set[asyncio.Task[Any]],
    tasks: Mapping[asyncio.Task[tuple[Vote, Usage]], tuple[str, str]],
    model_count: int,
) -> bool:
    counts: dict[str, Counter[Any]] = {
        criterion_id: Counter() for _, criterion_id in tasks.values()
    }
    for task in done:
        if task.cancelled() or task.exception() is not None:
            continue
        vote, _ = task.result()
        if vote.answer is not None:
            counts[tasks[task][1]][vote.answer] += 1
    return all(
        bool(counter) and max(counter.values()) * 2 > model_count for counter in counts.values()
    )


async def _judge(
    context: _Context,
    spec: ModelSpec,
    criterion: Mapping[str, Any],
    gate: asyncio.Event | None,
    leader: bool,
) -> tuple[Vote, Usage]:
    """Голос модели по критерию; если модель не ответила — голос резервной модели."""
    if _throttled_until.get(spec.id, 0.0) > time.monotonic():
        if gate is not None:
            gate.set()
        vote, spent = Vote(model=spec.id, answer=None, error="лимит запросов модели"), Usage()
    else:
        vote, spent = await _ask_model(context, spec, criterion, gate, leader)
    reserve = context.reserve
    if vote.answer is not None or reserve is None or reserve.id == spec.id:
        return vote, spent
    substitute, extra = await _ask_model(context, reserve, criterion, None, False)
    if substitute.answer is None:
        return vote, spent + extra
    meta = {**substitute.meta, "substitute_for": spec.id, "substitute_reason": vote.error}
    return _replace_meta(substitute, meta), spent + extra


async def _ask_model(
    context: _Context,
    spec: ModelSpec,
    criterion: Mapping[str, Any],
    gate: asyncio.Event | None,
    leader: bool,
) -> tuple[Vote, Usage]:
    provider = context.providers[spec.provider]
    schema = (
        context.union_schema
        if spec.prompt_cache
        else prompts.response_schema(prompts.verdict_values(criterion))
    )
    spent = Usage()
    feedback: str | None = None
    last_vote: Vote | None = None
    error = "нет ответа"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        request = CompletionRequest(
            system=context.system,
            prefix=context.prefix,
            suffix=prompts.build_criterion_block(criterion, feedback=feedback),
            schema=schema,
            max_tokens=MAX_TOKENS.get(spec.provider, 4096),
        )
        if gate is not None and not leader:
            await gate.wait()
        try:
            async with (
                _slot(spec.provider, PROVIDER_CONCURRENCY.get(spec.provider, 4)),
                _slot(f"model:{spec.id}", MODEL_CONCURRENCY),
            ):
                result = await provider.complete(
                    spec, request, on_start=gate.set if leader and gate is not None else None
                )
        except ProviderError as exc:
            if gate is not None:
                gate.set()
            if exc.rate_limited:
                _throttled_until[spec.id] = time.monotonic() + THROTTLE_SEC
            error = str(exc)
            logger.warning("Критерий %s, модель %s: %s", criterion["id"], spec.id, exc)
            if exc.retryable and not exc.rate_limited and attempt < MAX_ATTEMPTS:
                continue
            break
        spent = spent + result.usage
        vote, problem = _interpret(spec.id, criterion, result.data, context.conversation.messages)
        vote = _with_meta(vote, attempt=attempt, latency_ms=result.latency_ms, usage=spent)
        if problem is None:
            return vote, spent
        last_vote, feedback, error = vote, problem, problem
    if last_vote is not None and last_vote.answer is not None:
        return last_vote, spent  # ответ есть, но доказательства не подтвердились
    return Vote(model=spec.id, answer=None, error=error, attempts=MAX_ATTEMPTS), spent


def _interpret(
    model_id: str,
    criterion: Mapping[str, Any],
    data: Mapping[str, Any] | None,
    messages: Sequence[Message],
) -> tuple[Vote, str | None]:
    """Vote из JSON модели и замечание для повторного запроса (None — всё в порядке)."""
    if not isinstance(data, Mapping):
        return Vote(
            model_id, None, error="ответ не JSON"
        ), "Ответ должен быть JSON-объектом по схеме."
    raw_verdict = data.get("verdict")
    try:
        answer = normalize_answer(criterion, _verdict_value(raw_verdict))
    except AnswerError:
        answer = None
    if answer is None:
        allowed = ", ".join(prompts.verdict_values(criterion))
        problem = f"verdict «{raw_verdict}» недопустим для этого критерия; допустимые: {allowed}."
        return Vote(model_id, None, error=problem), problem
    check = check_evidence(data.get("evidence") or [], messages, verdict=str(answer))
    explanation = localize_refs(
        _text(data.get("explanation")) or _text(data.get("reasoning")), len(messages)
    )
    na_reason = None
    if answer == NA:
        na_reason = localize_refs(
            _text(data.get("na_reason")) or _text(data.get("applicability_reason")) or explanation,
            len(messages),
        )
    vote = Vote(
        model=model_id,
        answer=answer,
        evidence=tuple(item.as_dict() for item in check.items),
        explanation=explanation,
        checked_range=_checked_range(
            criterion, answer, data.get("checked_range"), check.items, len(messages)
        ),
        na_reason=na_reason,
        verified=check.ok,
        meta={"applicable": data.get("applicable")},
    )
    if check.ok:
        return vote, None
    problem = (
        "проверка доказательств не прошла: "
        + "; ".join(check.problems)
        + ". Приводи цитаты дословно из текста указанной реплики."
    )
    return vote, problem


def _replace_meta(vote: Vote, meta: dict[str, Any]) -> Vote:
    return Vote(
        model=vote.model,
        answer=vote.answer,
        evidence=vote.evidence,
        explanation=vote.explanation,
        checked_range=vote.checked_range,
        na_reason=vote.na_reason,
        verified=vote.verified,
        error=vote.error,
        attempts=vote.attempts,
        meta=meta,
    )


def _reserve_spec(
    specs: Sequence[ModelSpec],
    settings: EngineSettings,
    overrides: Mapping[str, Provider] | None,
) -> ModelSpec | None:
    """Первая доступная модель из резерва, которой нет в ансамбле."""
    chosen = {spec.id for spec in specs}
    for model_id in settings.reserve_models:
        spec = resolve_spec(model_id, settings)
        if spec is None or spec.id in chosen:
            continue
        if (overrides and spec.provider in overrides) or is_available(spec, settings):
            return spec
    return None


def _with_meta(vote: Vote, **meta: Any) -> Vote:
    usage = meta.pop("usage")
    merged = {
        **vote.meta,
        **meta,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cost_usd": round(usage.cost_usd, 6),
    }
    return Vote(
        model=vote.model,
        answer=vote.answer,
        evidence=vote.evidence,
        explanation=vote.explanation,
        checked_range=vote.checked_range,
        na_reason=vote.na_reason,
        verified=vote.verified,
        error=vote.error,
        attempts=meta.get("attempt", 1),
        meta=merged,
    )


def _slot(name: str, limit: int) -> asyncio.Semaphore:
    """Общий на процесс (на event loop) семафор: провайдер моделей или очередь оценок."""
    loop = asyncio.get_running_loop()
    per_loop = _semaphores.setdefault(loop, {})
    if name not in per_loop:
        per_loop[name] = asyncio.Semaphore(max(1, limit))
    return per_loop[name]


# ---------------------------------------------------------------- сборка результата


def _criterion_result(
    criterion: Mapping[str, Any],
    decision: Decision,
    votes: Sequence[Vote],
    fingerprint: str,
) -> dict[str, Any]:
    vote = decision.representative
    if vote is None:
        errors = "; ".join(sorted({v.error for v in votes if v.error})) or "нет ответа"
        explanation = f"Не удалось получить ответ моделей: {errors}"
        evidence: list[dict[str, Any]] = []
        checked_range = na_reason = None
    else:
        explanation = vote.explanation
        evidence = [dict(item) for item in vote.evidence]
        checked_range = list(vote.checked_range) if vote.checked_range else None
        na_reason = vote.na_reason if decision.answer == NA else None
    return {
        **_criterion_header(criterion),
        "answer": decision.answer,
        "final_answer": decision.answer,
        "explanation": explanation,
        "evidence": evidence,
        "checked_range": checked_range,
        "na_reason": na_reason,
        "confidence": decision.confidence,
        "votes": [_vote_summary(v) for v in votes],
        "needs_review": decision.needs_review,
        "review_reasons": list(decision.reasons),
        "appeal": None,
        "definition_hash": fingerprint,
        "reused": False,
    }


def _critical_reason(result: Mapping[str, Any]) -> str:
    """Почему отмечена грубая ошибка: причина решения проверяющего, если он изменил ответ."""
    appeal = result.get("appeal") or {}
    decision = appeal.get("decision") if isinstance(appeal, Mapping) else None
    if result["final_answer"] != result["answer"] and isinstance(decision, Mapping):
        return str(decision.get("reason") or result["explanation"])
    return result["explanation"]


def _reused_result(
    criterion: Mapping[str, Any], previous: Mapping[str, Any], fingerprint: str
) -> dict[str, Any]:
    answer = normalize_answer(criterion, previous.get("answer"))
    carried = reviewer_decision(criterion, previous)
    final_answer, appeal = carried if carried is not None else (answer, None)
    return {
        **_criterion_header(criterion),
        "answer": answer,
        "final_answer": final_answer,
        "explanation": previous.get("explanation") or "",
        "evidence": list(previous.get("evidence") or []),
        "checked_range": previous.get("checked_range"),
        "na_reason": previous.get("na_reason"),
        "confidence": previous.get("confidence"),
        "votes": list(previous.get("votes") or []),
        # решение проверяющего снимает «нужна проверка» с критерия
        "needs_review": carried is None and bool(previous.get("needs_review")),
        "review_reasons": [] if carried is not None else list(previous.get("review_reasons") or []),
        "appeal": appeal,
        "definition_hash": fingerprint,
        "reused": True,
    }


def _criterion_header(criterion: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "criterion_id": criterion["id"],
        "title": criterion.get("title", ""),
        "answer_type": criterion.get("answerType", "yes_no"),
        "weight": criterion.get("weight", 0),
        "critical": bool(criterion.get("critical")),
        "scored": criterion.get("scored", True) is not False,
    }


def _vote_summary(vote: Vote) -> dict[str, Any]:
    summary: dict[str, Any] = {"model": vote.model, "answer": vote.answer}
    if vote.answer is not None:
        summary["verified"] = vote.verified
        summary["explanation"] = vote.explanation
    if vote.error:
        summary["error"] = vote.error
    if vote.skipped:
        summary["skipped"] = True  # не дождались: большинство моделей уже ответило одинаково
        return summary
    for key in ("latency_ms", "output_tokens", "cost_usd", "substitute_for"):
        if key in vote.meta:
            summary[key] = vote.meta[key]
    summary["attempts"] = vote.attempts
    return summary


def _assemble(
    conversation: Conversation,
    checklist: Mapping[str, Any],
    results: list[dict[str, Any]],
    model_ids: list[str],
    usage: Usage,
    started: float,
    warnings: list[str],
) -> dict[str, Any]:
    answers = {item["criterion_id"]: item["answer"] for item in results}
    final_answers = {item["criterion_id"]: item["final_answer"] for item in results}
    scores = score_evaluation(checklist, answers)
    # final_* отличаются от ответа моделей, только если перенесено решение проверяющего
    final_scores = (
        scores if final_answers == answers else score_evaluation(checklist, final_answers)
    )
    for item in results:
        points = scores["criteria"][item["criterion_id"]]
        final = final_scores["criteria"][item["criterion_id"]]
        item.update(
            points=points["points"],
            max_points=points["max_points"],
            final_points=final["points"],
            final_max_points=final["max_points"],
        )
    final_sections = {section["id"]: section for section in final_scores["sections"]}
    answered = [item for item in results if item["answer"] is not None]
    critical = [item for item in results if item["critical"] and item["final_answer"] == "yes"]
    status = "done" if answered or not results else "error"
    return {
        "conversation_id": conversation.conversation_id,
        "checklist_id": checklist.get("id"),
        "checklist_version": checklist.get("version"),
        "models": model_ids,
        "criteria": results,
        "sections": [
            {
                **section,
                "final_points": final_sections[section["id"]]["points"],
                "final_max_points": final_sections[section["id"]]["max_points"],
            }
            for section in scores["sections"]
        ],
        "total": scores["total"],
        "final_total": final_scores["total"],
        "max_total": scores["max_total"],
        "critical_flag": final_scores["critical_flag"],
        "critical_note": "; ".join(_critical_reason(item) for item in critical) or None,
        "needs_review": any(item["needs_review"] for item in results),
        "cost_usd": round(usage.cost_usd, 6),
        "tokens": {
            "input": usage.input_tokens,
            "output": usage.output_tokens,
            "cache_read": usage.cache_read_tokens,
            "cache_write": usage.cache_write_tokens,
            "neurons": round(usage.neurons, 1),
        },
        "latency_ms": int((time.monotonic() - started) * 1000),
        "status": status,
        "error": None if status == "done" else "Ни одна модель не дала ответа.",
        "warnings": warnings,
        "engine": {"prompt_version": prompts.PROMPT_VERSION},
    }


def _error_result(
    conversation: Conversation,
    checklist: Mapping[str, Any],
    requested: list[str],
    started: float,
    warnings: list[str],
    message: str,
) -> dict[str, Any]:
    result = _assemble(conversation, checklist, [], requested, Usage(), started, warnings)
    return {**result, "status": "error", "error": message, "queued_ms": 0}


def _usable_specs(
    requested: Sequence[str],
    settings: EngineSettings,
    overrides: Mapping[str, Provider] | None,
) -> tuple[list[ModelSpec], list[str]]:
    specs: list[ModelSpec] = []
    warnings: list[str] = []
    for model_id in requested:
        spec = resolve_spec(model_id, settings)
        if spec is None:
            warnings.append(f"неизвестная модель {model_id}")
        elif (overrides and spec.provider in overrides) or is_available(spec, settings):
            specs.append(spec)
        else:
            warnings.append(f"модель {model_id} недоступна (нет ключа или не настроена)")
    return specs, warnings


# ---------------------------------------------------------------- мелочи разбора


def _verdict_value(raw: object) -> object:
    if isinstance(raw, str):
        text = raw.strip().strip('"').lower()
        return {"да": "yes", "нет": "no", "n/a": "na"}.get(text, text)
    return raw


def _checked_range(
    criterion: Mapping[str, Any],
    answer: object,
    raw: object,
    evidence: Sequence[Any],
    message_count: int,
) -> tuple[int, int] | None:
    if not _is_shortfall(criterion, answer):
        return None
    if (
        isinstance(raw, list)
        and len(raw) == 2
        and all(isinstance(i, int) and not isinstance(i, bool) for i in raw)
        and 0 <= raw[0] <= raw[1] < message_count
    ):
        return raw[0], raw[1]
    indexes = [item.index for item in evidence]
    return (min(indexes), max(indexes)) if indexes else None


def _is_shortfall(criterion: Mapping[str, Any], answer: object) -> bool:
    """«Нет» (или ступень ниже верхней) — действие пропущено, нужен проверенный участок."""
    if answer in (None, NA):
        return False
    if criterion.get("answerType") == "scale":
        steps = scale_values(criterion)
        return bool(steps) and answer != max(steps)
    if criterion.get("critical"):
        return False  # у флага грубой ошибки «Нет» — нарушения нет
    return answer == "no"


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""
