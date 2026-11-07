"""Расчёт баллов: перераспределение N/A, шкалы, half-up, scored=false, пустой итог."""

import json
from pathlib import Path

import pytest

from app.engine.scoring import (
    AnswerError,
    allowed_answers,
    critical_flag,
    normalize_answer,
    score_evaluation,
)

ROOT = Path(__file__).resolve().parents[2]
CHECKLIST = json.loads((ROOT / "config/checklists/chat-default.json").read_text(encoding="utf-8"))
CASES = json.loads((ROOT / "tests/fixtures/scoring_cases.json").read_text(encoding="utf-8"))


def answers(**overrides):
    base = {
        "c01": "yes",
        "c02": "yes",
        "c03": "yes",
        "c04": 20,
        "c05": "yes",
        "c06": 10,
        "c07": "yes",
        "c08": "no",
    }
    return {**base, **overrides}


def test_all_yes_gives_full_weights_and_100():
    result = score_evaluation(CHECKLIST, answers())

    assert result["total"] == 100.0
    assert result["criteria"]["c03"] == {"points": 20.0, "max_points": 20.0}
    assert result["criteria"]["c08"] == {"points": None, "max_points": None}
    assert [s["points"] for s in result["sections"]] == [25.0, 40.0, 35.0, None]


def test_checklist_example_50_625_rounds_half_up_to_50_63():
    # c04 = N/A → множитель 100/80 = 1,25; 18,75 + 18,75 + 13,125 = 50,625
    result = score_evaluation(
        CHECKLIST,
        answers(c01="no", c03="no", c04="na", c06=7, c07="no"),
    )

    assert result["total"] == 50.63
    assert result["criteria"]["c06"] == {"points": 13.13, "max_points": 18.75}
    assert result["criteria"]["c04"] == {"points": None, "max_points": None}
    conduct = next(s for s in result["sections"] if s["id"] == "conduct")
    assert conduct["points"] == 31.88
    assert conduct["max_points"] == 43.75


def test_na_redistributes_weight_proportionally():
    result = score_evaluation(CHECKLIST, answers(c02="na", c03="na"))

    assert result["criteria"]["c01"]["max_points"] == 15.38  # 10 * 100 / 65
    assert result["criteria"]["c04"]["max_points"] == 30.77
    assert result["total"] == 100.0
    assert result["max_total"] == 100.0


def test_scale_points_are_proportional_to_top_step():
    result = score_evaluation(CHECKLIST, answers(c04=5, c06=4))

    assert result["criteria"]["c04"]["points"] == 5.0
    assert result["criteria"]["c06"]["points"] == 6.0  # 4/10 * 15


def test_unscored_critical_criterion_does_not_change_total_but_sets_flag():
    clean = score_evaluation(CHECKLIST, answers())
    flagged = score_evaluation(CHECKLIST, answers(c08="yes"))

    assert flagged["total"] == clean["total"]
    assert flagged["critical_flag"] is True
    assert clean["critical_flag"] is False


def test_total_is_none_when_no_applicable_weighted_criteria():
    checklist = {
        "rules": CHECKLIST["rules"],
        "sections": [{"id": "s", "title": "S", "criteria": ["c02", "c03"]}],
        "criteria": [c for c in CHECKLIST["criteria"] if c["id"] in ("c02", "c03", "c08")],
    }
    result = score_evaluation(checklist, {"c02": "na", "c03": "na", "c08": "no"})

    assert result["total"] is None
    assert result["max_total"] is None
    assert result["sections"][0]["points"] is None


def test_missing_answer_is_excluded_like_na():
    partial = answers()
    del partial["c03"]
    result = score_evaluation(CHECKLIST, partial)

    assert result["criteria"]["c03"] == {"points": None, "max_points": None}
    assert result["total"] == 100.0


def test_rejects_na_where_not_allowed_and_unknown_scale_step():
    with pytest.raises(AnswerError):
        score_evaluation(CHECKLIST, answers(c01="na"))
    with pytest.raises(AnswerError):
        score_evaluation(CHECKLIST, answers(c06=5))
    with pytest.raises(AnswerError):
        score_evaluation(CHECKLIST, answers(c05=1))


def test_normalize_answer_accepts_strings_and_numbers():
    c04 = next(c for c in CHECKLIST["criteria"] if c["id"] == "c04")
    c02 = next(c for c in CHECKLIST["criteria"] if c["id"] == "c02")

    assert normalize_answer(c04, "15") == 15
    assert normalize_answer(c04, 15.0) == 15
    assert normalize_answer(c04, "N/A") == "na"
    assert normalize_answer(c02, " YES ") == "yes"
    assert normalize_answer(c02, None) is None
    with pytest.raises(AnswerError):
        normalize_answer(c04, True)


def test_allowed_answers_follow_checklist():
    by_id = {c["id"]: c for c in CHECKLIST["criteria"]}

    assert allowed_answers(by_id["c01"]) == ["yes", "no"]
    assert allowed_answers(by_id["c07"]) == ["yes", "no", "na"]
    assert allowed_answers(by_id["c04"]) == [20, 15, 10, 5, 0, "na"]
    assert allowed_answers(by_id["c06"]) == [10, 7, 4, 0]


def test_critical_flag_helper():
    assert critical_flag(CHECKLIST, {"c08": "yes"}) is True
    assert critical_flag(CHECKLIST, {"c08": "no"}) is False


def test_rounding_mode_and_decimals_come_from_rules():
    checklist = {
        **CHECKLIST,
        "rules": {**CHECKLIST["rules"], "rounding": {"decimals": 1, "mode": "half_up"}},
    }
    result = score_evaluation(checklist, answers(c01="no", c03="no", c04="na", c06=7, c07="no"))

    assert result["total"] == 50.6  # 50,625 → 50,6 при одном знаке


def test_fixture_has_required_case_kinds():
    names = " | ".join(case["name"] for case in CASES)
    assert "50,63" in names
    assert any(case["expected"]["total"] is None for case in CASES)
    assert any("na" in case["answers"].values() for case in CASES)
    assert any(c.get("scored") is False for case in CASES for c in case["checklist"]["criteria"])


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_shared_fixture_matches_implementation(case):
    result = score_evaluation(case["checklist"], case["answers"])
    expected = case["expected"]

    assert result["criteria"] == expected["criteria"]
    assert [
        {"id": s["id"], "points": s["points"], "max_points": s["max_points"]}
        for s in result["sections"]
    ] == expected["sections"]
    assert result["total"] == expected["total"]
