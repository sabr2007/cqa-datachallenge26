"""Прогон движка по эталонным чатам (eval/gold.json) и таблица точности.

    uv run python scripts/eval_gold.py --models claude-opus-5-5,@cf/zai-org/glm-5.3 --set tuning
    uv run python scripts/eval_gold.py --rescore eval/runs/<run>.json --ensembles "claude-opus-5-5"

Данные — data/DEV.json, если файл есть, иначе API кейса (app.upstream). Результат
сохраняется в eval/runs/<время>-<модели>.json: оценки, точность (compute_accuracy),
точность каждой модели по её голосам и ансамблей из подмножеств моделей.
Эталон используется только для метрик — в промпты он не попадает.
"""

import argparse
import asyncio
import itertools
import json
import re
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import load_settings  # noqa: E402
from app.engine import (  # noqa: E402
    compute_accuracy,
    evaluate_conversation,
    pipeline,  # noqa: E402
)
from app.engine.scoring import AnswerError, normalize_answer  # noqa: E402
from app.engine.settings import load_engine_settings  # noqa: E402
from app.engine.voting import Vote, decide  # noqa: E402
from app.models import Conversation  # noqa: E402
from app.normalize import normalize_records  # noqa: E402

GOLD = ROOT / "eval" / "gold.json"
SPLIT = ROOT / "eval" / "split.json"
CHECKLIST = ROOT / "config" / "checklists" / "chat-default.json"
DEV_FILE = ROOT / "data" / "DEV.json"
RUNS = ROOT / "eval" / "runs"


def main() -> None:
    args = parse_args()
    checklist = json.loads(Path(args.checklist).read_text(encoding="utf-8"))
    if args.criteria and not args.rescore:
        checklist = only_criteria(checklist, {c.strip() for c in args.criteria.split(",")})
    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    split = json.loads(SPLIT.read_text(encoding="utf-8"))
    if args.rescore:
        run = json.loads(Path(args.rescore).read_text(encoding="utf-8"))
        report(run["evaluations"], gold, split, checklist, run["models"], args.ensembles)
        return
    selected = select_gold(gold, split, args)
    models = [m.strip() for m in args.models.split(",") if m.strip()] if args.models else None
    conversations = asyncio.run(load_conversations(args.group))
    pipeline.PROVIDER_CONCURRENCY["cloudflare"] = args.cf_concurrency
    settings = replace(
        load_engine_settings(),
        eval_timeout_sec=args.timeout,
        parallel_evaluations=args.concurrency,
        # Для точности каждой модели нужны все голоса; --early-stop — замер задержки как в продукте.
        early_stop=args.early_stop,
        # Резервная модель подменяла бы голоса — для сравнения моделей нужны «чистые» голоса.
        reserve_models=tuple(m.strip() for m in (args.reserve or "").split(",") if m.strip()),
    )
    evaluations = asyncio.run(
        run_all(selected, conversations, checklist, models, args.concurrency, settings)
    )
    used = sorted(
        {m for ev in evaluations for m in ev.get("models") or []}, key=_model_order(models)
    )
    run = build_run(evaluations, gold, split, checklist, used, args)
    path = save_run(run, used, args.label)
    report(evaluations, gold, split, checklist, used, args.ensembles)
    print(f"\nСохранено: {path.relative_to(ROOT)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--models", help="модели через запятую (по умолчанию — CQA_MODELS/доступные)"
    )
    parser.add_argument("--set", default="tuning", choices=["tuning", "holdout", "all"])
    parser.add_argument("--lang", help="языки через запятую: RU,KZ,EN")
    parser.add_argument("--ids", help="conversation_id через запятую")
    parser.add_argument("--limit", type=int, help="не больше N чатов")
    parser.add_argument("--concurrency", type=int, default=3, help="чатов одновременно")
    parser.add_argument(
        "--timeout",
        type=float,
        default=240.0,
        help="таймаут оценки диалога для замера точности (в продукте — не больше 90 с)",
    )
    parser.add_argument(
        "--cf-concurrency", type=int, default=48, help="запросов к Workers AI одновременно"
    )
    parser.add_argument(
        "--early-stop", action="store_true", help="не ждать третью модель, если две согласны"
    )
    parser.add_argument("--reserve", help="резервные модели (как в продукте); по умолчанию нет")
    parser.add_argument("--group", default="DEV")
    parser.add_argument("--label", default="", help="метка в имени файла прогона")
    parser.add_argument("--checklist", default=str(CHECKLIST))
    parser.add_argument(
        "--criteria", help="только эти критерии (через запятую) — быстрая итерация промпта"
    )
    parser.add_argument("--rescore", help="пересчитать метрики сохранённого прогона")
    parser.add_argument(
        "--ensembles",
        help="ансамбли через ';', модели в ансамбле через '+' (по умолчанию — все подмножества)",
    )
    return parser.parse_args()


def only_criteria(checklist: Mapping[str, Any], keep: set[str]) -> dict[str, Any]:
    criteria = [c for c in checklist["criteria"] if c["id"] in keep]
    sections = [
        {**section, "criteria": [cid for cid in section["criteria"] if cid in keep]}
        for section in checklist.get("sections") or []
    ]
    return {**checklist, "criteria": criteria, "sections": [s for s in sections if s["criteria"]]}


def select_gold(
    gold: Sequence[Mapping[str, Any]], split: Mapping[str, Any], args: argparse.Namespace
) -> list[Mapping[str, Any]]:
    ids = {i.strip() for i in args.ids.split(",")} if args.ids else None
    langs = {lang.strip().upper() for lang in args.lang.split(",")} if args.lang else None
    allowed = None if args.set == "all" else set(split.get(args.set) or [])
    selected = [
        entry
        for entry in gold
        if (ids is None or entry["conversation_id"] in ids)
        and (langs is None or entry.get("language") in langs)
        and (allowed is None or ids is not None or entry["conversation_id"] in allowed)
    ]
    return selected[: args.limit] if args.limit else selected


async def load_conversations(group_id: str) -> dict[str, Conversation]:
    if DEV_FILE.exists() and group_id == "DEV":
        payload = json.loads(DEV_FILE.read_text(encoding="utf-8"))
        records = payload["data"]["records"] if isinstance(payload, dict) else payload
    else:
        from app.upstream import UpstreamClient

        settings = load_settings()
        client = UpstreamClient(api_url=settings.api_url, timeout_sec=settings.upstream_timeout_sec)
        try:
            records = await client.fetch_records(group_id)
        finally:
            await client.aclose()
    conversations, _ = normalize_records(records)
    return {c.conversation_id: c for c in conversations}


async def run_all(
    selected: Sequence[Mapping[str, Any]],
    conversations: Mapping[str, Conversation],
    checklist: Mapping[str, Any],
    models: list[str] | None,
    concurrency: int,
    settings: Any,
) -> list[dict[str, Any]]:
    limit = asyncio.Semaphore(max(1, concurrency))
    started = time.monotonic()

    async def one(entry: Mapping[str, Any]) -> dict[str, Any] | None:
        conversation = conversations.get(entry["conversation_id"])
        if conversation is None:
            print(f"  ! {entry['conversation_id']}: нет в данных")
            return None
        async with limit:
            evaluation = await evaluate_conversation(
                conversation, checklist, models=models, settings=settings
            )
        matched, total = _match(evaluation, entry, checklist)
        seconds = evaluation["latency_ms"] / 1000
        print(
            f"  {entry['conversation_id']:<10} {matched}/{total}  {seconds:5.1f} с"
            f"  ${evaluation['cost_usd']:.4f}  {evaluation['status']}"
            + (f"  ⚠ {len(evaluation['warnings'])}" if evaluation.get("warnings") else ""),
            flush=True,
        )
        return {**evaluation, "created_at": datetime.now(UTC).isoformat()}

    results = await asyncio.gather(*(one(entry) for entry in selected))
    print(f"Готово за {time.monotonic() - started:.0f} с")
    return [r for r in results if r is not None]


def build_run(
    evaluations: list[dict[str, Any]],
    gold: Sequence[Mapping[str, Any]],
    split: Mapping[str, Any],
    checklist: Mapping[str, Any],
    models: list[str],
    args: argparse.Namespace,
) -> dict[str, Any]:
    latencies = sorted(ev["latency_ms"] for ev in evaluations)
    costs = [ev["cost_usd"] for ev in evaluations]
    return {
        "created_at": datetime.now(UTC).isoformat(),
        "models": models,
        "set": args.set,
        "filters": {"lang": args.lang, "ids": args.ids, "limit": args.limit},
        "checklist": {"id": checklist.get("id"), "version": checklist.get("version")},
        "engine": (evaluations[0].get("engine") if evaluations else None),
        "summary": {
            "conversations": len(evaluations),
            "cost_usd_total": round(sum(costs), 4),
            "cost_usd_mean": round(sum(costs) / len(costs), 4) if costs else None,
            "latency_ms_median": latencies[len(latencies) // 2] if latencies else None,
            "latency_ms_max": latencies[-1] if latencies else None,
            "errors": sum(1 for ev in evaluations if ev["status"] != "done"),
            "warnings": sum(len(ev.get("warnings") or []) for ev in evaluations),
        },
        "accuracy": compute_accuracy(evaluations, gold, split, checklist=checklist),
        "per_model": model_tables(evaluations, gold, split, checklist, models),
        "evaluations": evaluations,
    }


def save_run(run: Mapping[str, Any], models: list[str], label: str) -> Path:
    RUNS.mkdir(parents=True, exist_ok=True)
    short = "+".join(_short(m) for m in models) or "none"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    name = f"{stamp}-{short}{('-' + label) if label else ''}.json"
    path = RUNS / re.sub(r"[^\w.+-]", "_", name)
    path.write_text(json.dumps(run, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------- метрики по моделям


def model_tables(
    evaluations: Sequence[Mapping[str, Any]],
    gold: Sequence[Mapping[str, Any]],
    split: Mapping[str, Any],
    checklist: Mapping[str, Any],
    models: Sequence[str],
) -> dict[str, Any]:
    """Точность каждой модели (по её голосам) и ансамблей — тот же compute_accuracy."""
    tables = {}
    for subset in _subsets(models, None):
        simulated = [simulate(ev, subset, checklist) for ev in evaluations]
        report_ = compute_accuracy(simulated, gold, split, checklist=checklist, expert_pairs=None)
        tables["+".join(subset)] = {
            "overall": report_["overall"],
            "by_set": report_["by_set"],
            "by_language": report_["by_language"],
            "by_criterion": {
                row["criterion_id"]: {
                    k: row[k] for k in ("matched", "total", "accuracy", "holdout", "tuning")
                }
                for row in report_["by_criterion"]
            },
            "na_confusion": {k: report_["na_confusion"][k] for k in ("na_as_no", "no_as_na")},
            "human_decided": {
                k: report_["human_decided"][k] for k in ("matched", "total", "accuracy", "by_set")
            },
        }
    return tables


def simulate(
    evaluation: Mapping[str, Any], subset: Sequence[str], checklist: Mapping[str, Any]
) -> dict[str, Any]:
    """Оценка, какой она была бы, если бы голосовали только модели subset."""
    definitions = {c["id"]: c for c in checklist["criteria"]}
    criteria = []
    for item in evaluation.get("criteria") or []:
        definition = definitions.get(item["criterion_id"])
        if definition is None:
            continue
        by_model = {vote["model"]: vote for vote in item.get("votes") or []}
        votes = []
        for model in subset:
            vote = by_model.get(model)
            if vote is None:
                continue
            votes.append(
                Vote(
                    model=model,
                    answer=_answer(definition, vote.get("answer")),
                    verified=vote.get("verified", True),
                )
            )
        decision = decide(definition, votes)
        criteria.append(
            {
                "criterion_id": item["criterion_id"],
                "title": item.get("title"),
                "answer": decision.answer,
                "votes": [],
            }
        )
    return {**evaluation, "criteria": criteria}


def report(
    evaluations: Sequence[Mapping[str, Any]],
    gold: Sequence[Mapping[str, Any]],
    split: Mapping[str, Any],
    checklist: Mapping[str, Any],
    models: Sequence[str],
    ensembles: str | None,
) -> None:
    subsets = _subsets(models, ensembles)
    columns = []
    for subset in subsets:
        simulated = [simulate(ev, subset, checklist) for ev in evaluations]
        columns.append(
            (
                "+".join(_short(m) for m in subset),
                compute_accuracy(simulated, gold, split, checklist=checklist, expert_pairs=None),
            )
        )
    real = compute_accuracy(evaluations, gold, split, checklist=checklist, expert_pairs=None)
    _print_table(columns, real)
    costs = [ev["cost_usd"] for ev in evaluations]
    latencies = sorted(ev["latency_ms"] for ev in evaluations)
    if costs:
        mean = sum(costs) / len(costs)
        median = latencies[len(latencies) // 2] / 1000
        print(
            f"\nЧатов: {len(evaluations)}; стоимость: всего ${sum(costs):.3f}, "
            f"в среднем ${mean:.4f}"
            f"; задержка: медиана {median:.1f} с, максимум {latencies[-1] / 1000:.1f} с"
        )
    mismatches = [row for row in real["conversations"] if row["mismatches"]]
    if mismatches:
        print("\nРасхождения итогового ответа с эталоном:")
        for row in mismatches:
            items = ", ".join(
                f"{m['criterion_id']}: {m['system']}≠{m['gold']}" for m in row["mismatches"]
            )
            print(f"  {row['conversation_id']:<10} [{row['set']}] {items}")


def _print_table(columns: list[tuple[str, Mapping[str, Any]]], real: Mapping[str, Any]) -> None:
    criteria = [row["criterion_id"] for row in real["by_criterion"]]
    header = ["критерий"] + [name for name, _ in columns] + ["итог системы"]
    widths = [max(9, len(h)) for h in header]
    print("\n" + "  ".join(h.ljust(w) for h, w in zip(header, widths, strict=True)))
    reports = [r for _, r in columns] + [real]
    for criterion_id in criteria:
        cells = [criterion_id]
        for rep in reports:
            row = next((r for r in rep["by_criterion"] if r["criterion_id"] == criterion_id), None)
            cells.append(_cell(row))
        print("  ".join(c.ljust(w) for c, w in zip(cells, widths, strict=True)))
    for label, key in (("ВСЕГО", None), ("tuning", "tuning"), ("holdout", "holdout")):
        cells = [label]
        for rep in reports:
            cells.append(_cell(rep["overall"] if key is None else rep["by_set"][key]))
        print("  ".join(c.ljust(w) for c, w in zip(cells, widths, strict=True)))
    cells = ["решили люди"] + [_cell(rep["human_decided"]) for rep in reports]
    print("  ".join(c.ljust(w) for c, w in zip(cells, widths, strict=True)))
    for language_row in real["by_language"]:
        cells = [language_row["language"]]
        for rep in reports:
            row = next(
                (r for r in rep["by_language"] if r["language"] == language_row["language"]), None
            )
            cells.append(_cell(row))
        print("  ".join(c.ljust(w) for c, w in zip(cells, widths, strict=True)))
    na = real["na_confusion"]
    print(
        f"N/A↔Нет у итога системы: эталон N/A → «Нет» {na['na_as_no']}, "
        f"эталон «Нет» → N/A {na['no_as_na']}"
    )


def _cell(row: Mapping[str, Any] | None) -> str:
    if not row or not row.get("total"):
        return "—"
    return f"{row['accuracy'] * 100:5.1f}% {row['matched']}/{row['total']}"


def _subsets(models: Sequence[str], ensembles: str | None) -> list[list[str]]:
    if ensembles:
        return [
            [m.strip() for m in group.split("+") if m.strip()]
            for group in ensembles.split(";")
            if group.strip()
        ]
    result = [[m] for m in models]
    for size in range(2, len(models) + 1):
        result.extend(
            list(combo)
            for combo in itertools.combinations(models, size)
            if size in (2, 3) or size == len(models)
        )
    return result


def _answer(definition: Mapping[str, Any], value: object) -> object:
    try:
        return normalize_answer(definition, value)
    except AnswerError:
        return None


def _match(
    evaluation: Mapping[str, Any], entry: Mapping[str, Any], checklist: Mapping[str, Any]
) -> tuple[int, int]:
    definitions = {c["id"]: c for c in checklist["criteria"]}
    system = {item["criterion_id"]: item["answer"] for item in evaluation.get("criteria") or []}
    matched = total = 0
    for criterion_id, gold_item in (entry.get("answers") or {}).items():
        if (
            criterion_id not in system
            or system[criterion_id] is None
            or criterion_id not in definitions
        ):
            continue
        total += 1
        matched += int(
            _answer(definitions[criterion_id], gold_item.get("value")) == system[criterion_id]
        )
    return matched, total


def _short(model: str) -> str:
    return model.split("/")[-1].replace("claude-opus-5-5", "claude")


def _model_order(models: list[str] | None):
    order = {m: i for i, m in enumerate(models or [])}
    return lambda m: (order.get(m, len(order)), m)


if __name__ == "__main__":
    main()
