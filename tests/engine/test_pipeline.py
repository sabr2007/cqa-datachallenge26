"""Пайплайн оценки на поддельных провайдерах: голосование, проверка цитат, повторы, reuse."""

import asyncio
import copy
import time
from dataclasses import replace

from app.engine import evaluate_conversation
from app.engine.settings import load_engine_settings
from tests.engine.support import (
    CLAUDE,
    DEEPSEEK,
    GLM,
    KIMI,
    FakeProvider,
    load_checklist,
    make_conversation,
    provider_error,
    verdict,
)

GOOD = {
    "c01": verdict(
        "yes", evidence=[(6, "Здравствуйте, я Алексей")], explanation="Приветствие и имя в [6]."
    ),
    "c02": verdict("no", evidence=[(6, "Бот всё написал")], checked_range=[6, 6]),
    "c03": verdict("na", evidence=[(0, "не могу найти вход")], na_reason="Общий вопрос о входе."),
    "c04": verdict("20", evidence=[(8, "Откройте tradernet.global")]),
    "c05": verdict("no", evidence=[(6, "Вы вообще читать умеете?")]),
    "c06": verdict(
        "4", evidence=[(6, "Бот всё написал"), (7, "Не понимаю, на какой сайт перейти")]
    ),
    "c07": verdict("no", evidence=[(10, "До свидания.")], checked_range=[10, 10]),
    "c08": verdict(
        "yes", evidence=[(6, "Вы вообще читать умеете?")], explanation="Оскорбление клиента в [6]."
    ),
}


def settings(timeout: float = 30.0, *, early_stop: bool = False, reserve=()):
    return replace(
        load_engine_settings({}),
        eval_timeout_sec=timeout,
        models=(),
        early_stop=early_stop,
        reserve_models=tuple(reserve),
    )


def run(conversation, checklist, **kwargs):
    kwargs.setdefault("settings", settings())
    return asyncio.run(evaluate_conversation(conversation, checklist, **kwargs))


def script_for(model, answers):
    return {(model, cid): [answer] for cid, answer in answers.items()}


def test_single_model_evaluation_has_contract_fields_and_scores():
    provider = FakeProvider(script_for(GLM, GOOD))

    result = run(
        make_conversation(), load_checklist(), models=[GLM], providers={"cloudflare": provider}
    )

    assert result["status"] == "done"
    assert result["models"] == [GLM]
    assert [c["criterion_id"] for c in result["criteria"]] == [f"c0{i}" for i in range(1, 9)]
    by_id = {c["criterion_id"]: c for c in result["criteria"]}
    assert by_id["c01"]["answer"] == "yes"
    assert by_id["c04"]["answer"] == 20
    assert by_id["c03"]["answer"] == "na"
    assert by_id["c03"]["points"] is None
    assert by_id["c03"]["na_reason"] == "Общий вопрос о входе."
    assert by_id["c01"]["explanation"] == "Приветствие и имя в #7."
    assert by_id["c01"]["evidence"] == [
        {"index": 6, "quote": "Здравствуйте, я Алексей", "verified": True}
    ]
    assert by_id["c02"]["checked_range"] == [6, 6]
    assert by_id["c08"]["points"] is None
    # c03 = N/A → множитель 100/80: 12,5 + 25 + 15·4/10·1,25 = 45
    assert result["total"] == 45.0
    assert result["final_total"] == result["total"]
    assert result["critical_flag"] is True
    assert result["critical_note"] == "Оскорбление клиента в #7."
    assert result["sections"][0] == {
        "id": "start",
        "title": "Начало и понимание запроса",
        "points": 12.5,
        "max_points": 31.25,
        "final_points": 12.5,
        "final_max_points": 31.25,
    }
    assert all(c["definition_hash"] and c["reused"] is False for c in result["criteria"])
    assert result["cost_usd"] > 0
    assert provider.closed is False  # чужой провайдер движок не закрывает


def test_majority_vote_sets_confidence_and_review_flags():
    answers = {model: dict(GOOD) for model in (GLM, DEEPSEEK, KIMI)}
    answers[DEEPSEEK]["c05"] = verdict("yes")
    answers[KIMI]["c03"] = verdict("no", evidence=[(6, "Здравствуйте, я Алексей")])
    script = {}
    for model, model_answers in answers.items():
        script.update(script_for(model, model_answers))

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM, DEEPSEEK, KIMI],
        providers={"cloudflare": FakeProvider(script)},
    )

    by_id = {c["criterion_id"]: c for c in result["criteria"]}
    assert by_id["c05"]["answer"] == "no"
    assert by_id["c05"]["confidence"] == 0.67
    assert by_id["c05"]["needs_review"] is False
    assert [v["answer"] for v in by_id["c05"]["votes"]] == ["no", "yes", "no"]
    assert by_id["c03"]["answer"] == "na"
    assert by_id["c03"]["needs_review"] is True  # спор N/A против «Нет»
    assert by_id["c01"]["confidence"] == 1.0
    assert result["needs_review"] is True


def test_unverified_quote_triggers_one_retry_with_feedback():
    script = script_for(GLM, GOOD)
    script[(GLM, "c01")] = [
        verdict("yes", evidence=[(6, "Добрый вечер, меня зовут Олег")]),
        verdict("yes", evidence=[(6, "Здравствуйте, я Алексей")]),
    ]
    provider = FakeProvider(script)

    result = run(
        make_conversation(), load_checklist(), models=[GLM], providers={"cloudflare": provider}
    )

    c01_calls = [call for call in provider.calls if call[1] == "c01"]
    assert len(c01_calls) == 2
    assert "повторная проверка" in c01_calls[1][2].suffix
    c01 = next(c for c in result["criteria"] if c["criterion_id"] == "c01")
    assert c01["evidence"][0]["verified"] is True
    assert c01["votes"][0]["attempts"] == 2
    assert c01["needs_review"] is False


def test_quote_still_unverified_after_retry_needs_review():
    script = script_for(GLM, GOOD)
    script[(GLM, "c05")] = [verdict("no", evidence=[(6, "Совершенно выдуманная фраза оператора")])]

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM],
        providers={"cloudflare": FakeProvider(script)},
    )

    c05 = next(c for c in result["criteria"] if c["criterion_id"] == "c05")
    assert c05["answer"] == "no"
    assert c05["evidence"][0]["verified"] is False
    assert c05["needs_review"] is True
    assert any("цитаты" in reason for reason in c05["review_reasons"])


def test_index_off_by_one_is_corrected_and_verified():
    script = script_for(GLM, GOOD)
    script[(GLM, "c07")] = [verdict("no", evidence=[(9, "До свидания.")])]

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM],
        providers={"cloudflare": FakeProvider(script)},
    )

    c07 = next(c for c in result["criteria"] if c["criterion_id"] == "c07")
    assert c07["evidence"] == [
        {"index": 10, "quote": "До свидания.", "verified": True, "corrected_from": 9}
    ]


def test_invalid_verdict_is_retried_then_accepted():
    script = script_for(GLM, GOOD)
    script[(GLM, "c06")] = [verdict("5"), verdict("7", evidence=[(6, "Бот всё написал")])]
    provider = FakeProvider(script)

    result = run(
        make_conversation(), load_checklist(), models=[GLM], providers={"cloudflare": provider}
    )

    c06 = next(c for c in result["criteria"] if c["criterion_id"] == "c06")
    assert c06["answer"] == 7
    retry = [call for call in provider.calls if call[1] == "c06"][1][2]
    assert "недопустим" in retry.suffix


def test_failed_model_does_not_block_others():
    script = script_for(GLM, GOOD)
    script.update(script_for(DEEPSEEK, GOOD))
    script[(DEEPSEEK, "c04")] = [provider_error("HTTP 400: bad request")]

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM, DEEPSEEK],
        providers={"cloudflare": FakeProvider(script)},
    )

    c04 = next(c for c in result["criteria"] if c["criterion_id"] == "c04")
    assert c04["answer"] == 20
    assert c04["votes"][1]["answer"] is None
    assert "HTTP 400" in c04["votes"][1]["error"]


def test_all_models_failing_gives_error_status():
    provider = FakeProvider({}, default=lambda model, criterion: provider_error("нет связи"))

    result = run(
        make_conversation(), load_checklist(), models=[GLM], providers={"cloudflare": provider}
    )

    assert result["status"] == "error"
    assert result["total"] is None
    assert all(c["answer"] is None and c["needs_review"] for c in result["criteria"])


def test_unknown_or_unavailable_models_give_error():
    result = run(make_conversation(), load_checklist(), models=["no-such-model"])

    assert result["status"] == "error"
    assert "no-such-model" in result["error"]


def test_timeout_marks_unanswered_criteria():
    provider = FakeProvider({}, default=lambda model, criterion: verdict("yes"), delay=2.0)
    started = time.monotonic()

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM],
        providers={"cloudflare": provider},
        settings=settings(timeout=1.5),
    )

    assert time.monotonic() - started < 2.0
    assert all(c["answer"] is None for c in result["criteria"])
    assert result["warnings"]


def test_reuse_reevaluates_only_changed_criteria():
    checklist = load_checklist()
    first = run(
        make_conversation(),
        checklist,
        models=[GLM],
        providers={"cloudflare": FakeProvider(script_for(GLM, GOOD))},
    )
    changed = copy.deepcopy(checklist)
    changed["version"] = 2
    c06 = next(c for c in changed["criteria"] if c["id"] == "c06")
    c06["guidance"] = c06.get("guidance", "") + " Новое уточнение."
    c01 = next(c for c in changed["criteria"] if c["id"] == "c01")
    c01["weight"] = 20  # вес не требует переоценки, только пересчёта баллов
    provider = FakeProvider(script_for(GLM, {**GOOD, "c06": verdict("10")}))

    second = run(
        make_conversation(), changed, models=[GLM], reuse=first, providers={"cloudflare": provider}
    )

    assert {call[1] for call in provider.calls} == {"c06"}
    by_id = {c["criterion_id"]: c for c in second["criteria"]}
    assert by_id["c06"]["answer"] == 10 and by_id["c06"]["reused"] is False
    assert by_id["c01"]["reused"] is True and by_id["c01"]["answer"] == "yes"
    assert (
        by_id["c01"]["max_points"]
        != next(c for c in first["criteria"] if c["criterion_id"] == "c01")["max_points"]
    )
    assert second["checklist_version"] == 2


def test_reuse_keeps_reviewer_decision_for_unchanged_criteria():
    checklist = load_checklist()
    first = run(
        make_conversation(),
        checklist,
        models=[GLM],
        providers={"cloudflare": FakeProvider(script_for(GLM, GOOD))},
    )
    first["id"] = "ev_first"
    decision = {"action": "change", "new_answer": "no", "reason": "Оскорбления не было."}
    appeal = {"id": "ap_1", "status": "resolved", "original_answer": "yes", "decision": decision}
    first["criteria"] = [
        {**c, "final_answer": "no", "appeal": appeal, "needs_review": True}
        if c["criterion_id"] == "c08"
        else c
        for c in first["criteria"]
    ]
    changed = copy.deepcopy(checklist)
    changed["version"] = 2
    c06 = next(c for c in changed["criteria"] if c["id"] == "c06")
    c06["guidance"] = c06.get("guidance", "") + " Новое уточнение."
    provider = FakeProvider(script_for(GLM, GOOD))

    second = run(
        make_conversation(), changed, models=[GLM], reuse=first, providers={"cloudflare": provider}
    )

    c08 = next(c for c in second["criteria"] if c["criterion_id"] == "c08")
    assert c08["answer"] == "yes" and c08["final_answer"] == "no"
    assert c08["appeal"]["decision"] == decision
    assert c08["appeal"]["carried_from"] == "ev_first"
    assert c08["needs_review"] is False
    assert second["critical_flag"] is False  # грубая ошибка снята решением проверяющего
    assert second["total"] == first["total"]


def test_claude_requests_share_prefix_and_schema_and_wait_for_cache_warmup():
    order: list[tuple[str, float]] = []

    class SlowStart(FakeProvider):
        async def complete(self, spec, request, *, on_start=None):
            criterion_id = request.suffix.split("Критерий ")[1].split(" ")[0]
            order.append((criterion_id, time.monotonic()))
            if on_start is not None:
                await asyncio.sleep(0.05)
                order.append(("warm", time.monotonic()))
            return await super().complete(spec, request, on_start=on_start)

    provider = SlowStart(script_for(CLAUDE, GOOD), name="anthropic")

    run(make_conversation(), load_checklist(), models=[CLAUDE], providers={"anthropic": provider})

    warm = next(t for name, t in order if name == "warm")
    others = [t for name, t in order if name not in ("warm", "c01")]
    assert others and all(t >= warm for t in others)
    requests = [call[2] for call in provider.calls]
    assert len({(r.system, r.prefix) for r in requests}) == 1
    assert all(r.schema == requests[0].schema for r in requests)
    assert set(requests[0].schema["properties"]["verdict"]["enum"]) >= {
        "yes",
        "no",
        "na",
        "20",
        "7",
    }


def test_empty_dialog_is_an_error_without_model_calls():
    provider = FakeProvider(script_for(GLM, GOOD))

    result = run(
        make_conversation([]), load_checklist(), models=[GLM], providers={"cloudflare": provider}
    )

    assert result["status"] == "error"
    assert "нет реплик" in result["error"]
    assert provider.calls == []


class ModelDelays(FakeProvider):
    """Голоса моделей приходят с задержкой: медленная модель отвечает последней."""

    def __init__(self, script, delays):
        super().__init__(script)
        self.delays = delays

    async def complete(self, spec, request, *, on_start=None):
        await asyncio.sleep(self.delays.get(spec.id, 0))
        return await super().complete(spec, request, on_start=on_start)


def test_early_stop_skips_slow_model_when_majority_agrees():
    script = {}
    for model in (GLM, DEEPSEEK, KIMI):
        script.update(script_for(model, GOOD))
    provider = ModelDelays(script, {KIMI: 3.0})
    started = time.monotonic()

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM, DEEPSEEK, KIMI],
        providers={"cloudflare": provider},
        settings=settings(early_stop=True),
    )

    assert time.monotonic() - started < 2.0
    c05 = next(c for c in result["criteria"] if c["criterion_id"] == "c05")
    assert c05["answer"] == "no" and c05["confidence"] == 1.0
    assert c05["votes"][2] == {"model": KIMI, "answer": None, "skipped": True}
    assert result["warnings"] == []


def test_early_stop_waits_for_third_model_on_disagreement():
    script = {}
    for model in (GLM, DEEPSEEK, KIMI):
        script.update(script_for(model, GOOD))
    script[(DEEPSEEK, "c05")] = [verdict("yes")]
    provider = ModelDelays(script, {KIMI: 0.3})

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM, DEEPSEEK, KIMI],
        providers={"cloudflare": provider},
        settings=settings(early_stop=True),
    )

    c05 = next(c for c in result["criteria"] if c["criterion_id"] == "c05")
    assert [v["answer"] for v in c05["votes"]] == ["no", "yes", "no"]
    assert c05["confidence"] == 0.67


def test_reserve_model_replaces_failed_vote():
    script = script_for(GLM, GOOD)
    script[(GLM, "c04")] = [provider_error("HTTP 500", retryable=False)]
    script.update(script_for(KIMI, GOOD))
    provider = FakeProvider(script)

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM],
        providers={"cloudflare": provider},
        settings=settings(reserve=[KIMI]),
    )

    c04 = next(c for c in result["criteria"] if c["criterion_id"] == "c04")
    assert c04["answer"] == 20
    assert c04["votes"][0]["model"] == KIMI
    assert c04["votes"][0]["substitute_for"] == GLM
    assert {call[0] for call in provider.calls if call[1] == "c01"} == {GLM}  # резерв только по c04


def test_rate_limited_model_is_skipped_for_a_while(monkeypatch):
    from app.engine import pipeline

    monkeypatch.setattr(pipeline, "_throttled_until", {})
    script = {(GLM, cid): [provider_error_limited()] for cid in GOOD}
    script.update(script_for(KIMI, GOOD))
    provider = FakeProvider(script)

    result = run(
        make_conversation(),
        load_checklist(),
        models=[GLM],
        providers={"cloudflare": provider},
        settings=settings(reserve=[KIMI]),
    )

    assert all(c["answer"] is not None for c in result["criteria"])
    assert pipeline._throttled_until[GLM] > time.monotonic()
    glm_calls = [call for call in provider.calls if call[0] == GLM]
    assert len(glm_calls) < 8  # после первого 429 модель пропускается


def provider_error_limited():
    from app.engine.providers.base import ProviderError

    return ProviderError("HTTP 429: rate limiting", rate_limited=True)
