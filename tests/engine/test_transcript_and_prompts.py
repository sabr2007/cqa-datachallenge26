"""Предобработка транскрипта, правила-сигналы и сборка промпта из чек-листа."""

from app.engine import prompts, signals
from app.engine.transcript import extract_facts, format_transcript, render_facts
from tests.engine.support import load_checklist, make_conversation

KZ_CHAT = [
    ("00:00", "client", "Менің шотымда неге ақша шығару жабық екенін қарап беріңізші."),
    ("00:42", "system", "Чат операторға жіберілді."),
    (
        "01:21",
        "operator",
        "Сәлеметсіз бе, мен Мұратпын. "
        "Сіздің шотыңызда ақша шығаруға шектеу қойылғанын көріп тұрмын.",
    ),
    ("02:00", "client", "Мен әлі жеке басымды растаған жоқпын ғой."),
    ("06:48", "operator", "Қазір растаудың қажеті жоқ."),
]
EN_CHAT = [
    ("00:00", "client", "I sent money and it hasn't shown up."),
    ("01:16", "system", "Chat transferred to an agent."),
    (
        "05:43",
        "operator",
        "Hello, I'm Sam. Can you transfer the money to my personal card instead?",
    ),
    ("06:00", "system", "Customer identity verified."),
    ("06:10", "system", "Connection to customer lost."),
]


def test_transcript_is_numbered_with_roles_and_times():
    text = format_transcript(make_conversation())

    assert text.splitlines()[0].startswith("[0] client 00:00: Почему опять")
    assert "[6] operator 01:23: Здравствуйте, я Алексей." in text


def test_facts_for_russian_chat():
    facts = extract_facts(make_conversation(), threshold_sec=180)

    assert facts.first_operator_index == 6
    assert facts.greeting == ("RU", "Здравствуйте")
    assert facts.introduction == "я Алексей"
    assert facts.handoff_index == 5 and facts.handoff_source == "system"
    assert facts.first_response_sec == 41.0
    assert facts.client_language == "RU"
    assert [m.label for m in facts.suspicious] == ["возможное оскорбление"]
    rendered = render_facts(facts)
    assert "Первая реакция оператора через 0 мин 41 с — в пределах порога 3 мин 00 с" in rendered


def test_facts_for_kazakh_chat_detect_greeting_intro_and_account_data():
    facts = extract_facts(make_conversation(KZ_CHAT, language="KZ"), threshold_sec=180)

    assert facts.client_language == "KZ"
    assert facts.greeting[0] == "KZ"
    assert facts.introduction.startswith("мен Мұрат")
    assert facts.account_data_indexes == (2,)
    assert len(facts.long_waits) == 1
    assert facts.long_waits[0].warned is False


def test_facts_for_english_chat_detect_late_reply_and_end():
    facts = extract_facts(make_conversation(EN_CHAT, language="EN"), threshold_sec=180)

    assert facts.greeting == ("EN", "Hello")
    assert facts.introduction == "I'm Sam"
    assert facts.first_response_sec == 267.0
    assert facts.identity_confirmed_index == 3
    assert facts.end_event == (4, "client_left")
    assert any(m.label == "перевод денег оператору лично" for m in facts.suspicious)
    assert "дольше порога" in render_facts(facts)


def test_no_greeting_or_name_is_reported():
    assert signals.find_greeting("Open settings then go back and log in again.") is None
    assert signals.find_introduction("Привет, где именно ищете?") is None
    assert signals.find_introduction("Я посмотрел ваш вопрос") is None
    assert signals.detect_language("Сәлем. Қай сайтқа кірдіңіз?") == "KZ"


def test_criterion_block_is_built_from_checklist_fields():
    checklist = load_checklist()
    c04 = next(c for c in checklist["criteria"] if c["id"] == "c04")
    c08 = next(c for c in checklist["criteria"] if c["id"] == "c08")

    block = prompts.build_criterion_block(c04)
    critical = prompts.build_criterion_block(c08)

    assert "Критерий c04 — «Корректная и полная консультация»" in block
    assert "- 15 — Основной вопрос решён" in block
    assert "N/A разрешён" in block
    assert c04["guidance"][:40] in block
    assert '"20", "15", "10", "5", "0", "na"' in block
    assert "нарушение ЕСТЬ" in critical
    assert "N/A для этого критерия не разрешён" in critical


def test_new_criterion_from_editor_needs_no_code():
    criterion = {
        "id": "c09",
        "title": "Предложил подписку на уведомления",
        "answerType": "yes_no",
        "weight": 5,
        "naAllowed": True,
        "yes": "Оператор предложил подписаться на уведомления.",
        "na": "Разговор не о счёте.",
    }

    block = prompts.build_criterion_block(criterion)
    schema = prompts.response_schema(prompts.verdict_values(criterion))

    assert "Предложил подписку на уведомления" in block
    assert schema["properties"]["verdict"]["enum"] == ["yes", "no", "na"]
    assert list(schema["properties"])[:4] == [
        "applicable",
        "applicability_reason",
        "evidence",
        "reasoning",
    ]


def test_union_verdicts_cover_whole_checklist():
    union = prompts.union_verdicts(load_checklist()["criteria"])

    assert union[:3] == ["yes", "no", "na"]
    assert {"20", "15", "10", "5", "0", "7", "4"} <= set(union)


def test_system_prompt_uses_threshold_from_rules():
    assert "3 мин" in prompts.build_system_prompt({"firstResponseThresholdSec": 180})
    assert "2 мин 30 с" in prompts.build_system_prompt({"firstResponseThresholdSec": 150})
