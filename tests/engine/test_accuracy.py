"""Точность относительно эталона: форма отчёта /api/metrics/accuracy и подсчёты."""

from app.engine import compute_accuracy
from tests.engine.support import load_checklist

GOLD = [
    {
        "conversation_id": "ru-1",
        "language": "RU",
        "set": "tuning",
        "answers": {
            "c01": {"value": "yes"},
            "c03": {"value": "na"},
            "c04": {"value": 20},
            "c07": {"value": "no"},
        },
    },
    {
        "conversation_id": "kz-1",
        "language": "KZ",
        "set": "holdout",
        "answers": {"c01": {"value": "no"}, "c04": {"value": 10}},
    },
    {
        "conversation_id": "en-1",
        "language": "EN",
        "set": "tuning",
        "answers": {"c01": {"value": "yes"}},
    },
]
SPLIT = {"holdout": ["kz-1"], "tuning": ["ru-1", "en-1"]}


def evaluation(
    conversation_id, answers, *, created_at="2026-11-07T10:00:00", votes=None, eid="ev1"
):
    return {
        "id": eid,
        "conversation_id": conversation_id,
        "created_at": created_at,
        "checklist_version": 1,
        "criteria": [
            {
                "criterion_id": cid,
                "title": f"Критерий {cid}",
                "answer": value,
                "votes": (votes or {}).get(cid, []),
            }
            for cid, value in answers.items()
        ],
    }


def test_accuracy_report_shape_and_counts():
    evaluations = [
        evaluation(
            "ru-1",
            {"c01": "yes", "c03": "no", "c04": 15, "c07": "na"},
            votes={"c01": [{"model": "m1", "answer": "yes"}, {"model": "m2", "answer": "no"}]},
        ),
        evaluation("kz-1", {"c01": "no", "c04": 10}, eid="ev2"),
    ]

    report = compute_accuracy(
        evaluations, GOLD, SPLIT, group_id="DEV", checklist=load_checklist(), expert_pairs=None
    )

    assert set(report) >= {
        "group_id",
        "checklist_version",
        "gold_count",
        "evaluated_count",
        "overall",
        "by_set",
        "by_criterion",
        "by_language",
        "na_confusion",
        "by_model",
        "expert_agreement",
        "conversations",
    }
    assert report["gold_count"] == 3 and report["evaluated_count"] == 2
    assert report["overall"] == {"matched": 3, "total": 6, "accuracy": 0.5}
    assert report["by_set"]["holdout"] == {"matched": 2, "total": 2, "accuracy": 1.0}
    assert report["by_set"]["tuning"] == {"matched": 1, "total": 4, "accuracy": 0.25}
    c04 = next(row for row in report["by_criterion"] if row["criterion_id"] == "c04")
    assert c04["title"] == "Критерий c04"
    assert c04["within_one"] == {"matched": 2, "total": 2, "accuracy": 1.0}  # 15 рядом с 20
    assert report["na_confusion"]["na_as_no"] == 1
    assert report["na_confusion"]["no_as_na"] == 1
    assert {row["language"] for row in report["by_language"]} == {"RU", "KZ"}
    assert report["by_model"] == [
        {"model": "m1", "matched": 1, "total": 1, "accuracy": 1.0},
        {"model": "m2", "matched": 0, "total": 1, "accuracy": 0.0},
    ]
    ru = next(row for row in report["conversations"] if row["conversation_id"] == "ru-1")
    assert ru["evaluation_id"] == "ev1" and ru["matched"] == 1 and ru["total"] == 4
    assert {m["criterion_id"] for m in ru["mismatches"]} == {"c03", "c04", "c07"}
    en = next(row for row in report["conversations"] if row["conversation_id"] == "en-1")
    assert en["evaluation_id"] is None and en["total"] == 0


def test_latest_evaluation_wins_and_answers_are_normalized():
    evaluations = [
        evaluation("en-1", {"c01": "no"}, created_at="2026-11-07T09:00:00", eid="old"),
        evaluation("en-1", {"c01": "YES"}, created_at="2026-11-07T11:00:00", eid="new"),
    ]

    report = compute_accuracy(
        evaluations, GOLD, SPLIT, checklist=load_checklist(), expert_pairs=None
    )

    en = next(row for row in report["conversations"] if row["conversation_id"] == "en-1")
    assert en["evaluation_id"] == "new" and en["matched"] == 1


def test_expert_agreement_from_double_labels():
    pairs = [
        {
            "conversation_id": "x",
            "labelers": [
                {"labeler": "A", "answers": {"c01": "yes", "c04": 20}},
                {"labeler": "B", "answers": {"c01": "yes", "c04": 15}},
            ],
        }
    ]

    report = compute_accuracy([], GOLD, SPLIT, checklist=load_checklist(), expert_pairs=pairs)

    assert report["expert_agreement"] == {"matched": 1, "total": 2, "accuracy": 0.5}
    assert compute_accuracy([], GOLD, SPLIT, expert_pairs=None)["expert_agreement"] is None


def test_human_decided_block_counts_only_team_answers():
    gold = [
        {
            "conversation_id": "ru-1",
            "language": "RU",
            "set": "tuning",
            "answers": {
                "c04": {"value": 15, "decided_by": "team"},
                "c06": {"value": 7, "decided_by": "team"},
                "c01": {"value": "yes"},
            },
        }
    ]
    evaluations = [evaluation("ru-1", {"c04": 15, "c06": 4, "c01": "yes"})]

    report = compute_accuracy(evaluations, gold, {"tuning": ["ru-1"]}, expert_pairs=None)

    human = report["human_decided"]
    assert (human["matched"], human["total"]) == (1, 2)
    assert human["by_set"]["tuning"]["accuracy"] == 0.5
    assert {item["criterion_id"]: item["matched"] for item in human["items"]} == {
        "c04": True,
        "c06": False,
    }
