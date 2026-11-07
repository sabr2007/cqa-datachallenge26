"""Проверка цитат кодом и голосование моделей."""

from app.engine.evidence import check_evidence, quote_score
from app.engine.explain import localize_refs
from app.engine.voting import Vote, decide
from tests.engine.support import load_checklist, make_conversation

MESSAGES = make_conversation().messages
CRITERIA = {c["id"]: c for c in load_checklist()["criteria"]}


def test_quote_score_tolerates_case_quotes_and_ellipsis():
    text = "Здравствуйте, я Алексей. Вы вообще читать умеете? Бот всё написал."

    assert quote_score("здравствуйте, я алексей", text) == 1.0
    assert quote_score("«Вы вообще читать умеете?»", text) == 1.0
    assert quote_score("Здравствуйте… Бот всё написал", text) == 1.0
    assert quote_score("Добрый вечер, меня зовут Олег", text) < 0.5


def test_check_evidence_verifies_and_corrects_index():
    check = check_evidence(
        [{"index": 7, "quote": "Откройте tradernet.global"}], MESSAGES, verdict="20"
    )

    assert check.ok
    assert check.items[0].index == 8
    assert check.items[0].corrected_from == 7


def test_check_evidence_reports_missing_quote_and_bad_index():
    check = check_evidence(
        [{"index": 99, "quote": "Такого текста нет в диалоге"}], MESSAGES, verdict="no"
    )

    assert not check.ok
    assert check.items == ()
    assert "не найдена" in check.problems[0]


def test_check_evidence_requires_operator_or_system_for_operator_verdict():
    check = check_evidence(
        [{"index": 0, "quote": "Почему опять не могу найти вход?"}], MESSAGES, verdict="yes"
    )
    na_check = check_evidence(
        [{"index": 0, "quote": "Почему опять не могу найти вход?"}], MESSAGES, verdict="na"
    )

    assert not check.ok
    assert na_check.ok


def test_index_without_quote_uses_message_text():
    check = check_evidence([{"index": 10, "quote": ""}], MESSAGES, verdict="no")

    assert check.ok
    assert check.items[0].quote == "До свидания."


def test_localize_refs_converts_indexes_to_ui_numbers():
    assert (
        localize_refs("в [6] и [9, 10], диапазон [8–10]", 11) == "в #7 и #10, #11, диапазон #9–#11"
    )
    assert localize_refs("вне диапазона [42]", 11) == "вне диапазона [42]"


def votes(*answers, verified=True):
    return [Vote(model=f"m{i}", answer=a, verified=verified) for i, a in enumerate(answers)]


def test_majority_and_confidence():
    decision = decide(CRITERIA["c05"], votes("no", "yes", "no"))

    assert decision.answer == "no"
    assert decision.confidence == 0.67
    assert decision.needs_review is False


def test_tie_goes_to_priority_model_and_needs_review():
    decision = decide(CRITERIA["c05"], votes("yes", "no"))

    assert decision.answer == "yes"
    assert decision.needs_review is True


def test_scale_uses_median_step():
    assert decide(CRITERIA["c04"], votes(20, 15, 10)).answer == 15
    assert decide(CRITERIA["c04"], votes(20, 20, 10)).answer == 20
    assert decide(CRITERIA["c04"], votes("na", "na", 20)).answer == "na"
    assert decide(CRITERIA["c04"], votes(20, 15)).answer == 15  # чётное число — нижняя медиана


def test_na_disagreement_and_critical_disagreement_need_review():
    assert decide(CRITERIA["c03"], votes("na", "na", "no")).needs_review is True
    assert decide(CRITERIA["c08"], votes("no", "no", "yes")).needs_review is True
    assert decide(CRITERIA["c07"], votes("no", "no", "yes")).needs_review is False


def test_unverified_supporters_need_review_and_no_votes_give_none():
    assert decide(CRITERIA["c01"], votes("yes", verified=False)).needs_review is True
    empty = decide(CRITERIA["c01"], [Vote(model="m", answer=None, error="x")])
    assert empty.answer is None and empty.needs_review is True and empty.confidence == 0.0
