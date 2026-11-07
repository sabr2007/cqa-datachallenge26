"""scripts/eval_gold.py: симуляция ансамблей по голосам и отбор критериев."""

from scripts.eval_gold import only_criteria, simulate
from tests.engine.support import load_checklist


def evaluation_with_votes():
    return {
        "conversation_id": "x",
        "criteria": [
            {
                "criterion_id": "c05",
                "title": "Эмпатия",
                "answer": "no",
                "votes": [
                    {"model": "a", "answer": "no"},
                    {"model": "b", "answer": "yes"},
                    {"model": "c", "answer": "yes"},
                ],
            },
            {
                "criterion_id": "c04",
                "title": "Консультация",
                "answer": 15,
                "votes": [{"model": "a", "answer": 20}, {"model": "b", "answer": 10}],
            },
        ],
    }


def test_simulate_recomputes_answer_for_model_subset():
    checklist = load_checklist()

    only_a = simulate(evaluation_with_votes(), ["a"], checklist)
    b_and_c = simulate(evaluation_with_votes(), ["b", "c"], checklist)

    assert {c["criterion_id"]: c["answer"] for c in only_a["criteria"]} == {"c05": "no", "c04": 20}
    assert {c["criterion_id"]: c["answer"] for c in b_and_c["criteria"]} == {
        "c05": "yes",
        "c04": 10,
    }


def test_only_criteria_keeps_sections_consistent():
    reduced = only_criteria(load_checklist(), {"c05", "c06"})

    assert [c["id"] for c in reduced["criteria"]] == ["c05", "c06"]
    assert reduced["sections"] == [
        {"id": "conduct", "title": "Ведение и завершение диалога", "criteria": ["c05", "c06"]}
    ]
