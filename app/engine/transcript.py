"""Предобработка диалога: нумерованный транскрипт и факты, извлечённые кодом.

Факты (первая реплика оператора, передача чата, время первой реакции, язык
клиента, приветствие/представление, паузы, конец чата, подозрительные фразы)
идут в промпт как подсказки — вердикт выносит модель.
"""

from collections import Counter
from dataclasses import dataclass

from app.engine import signals
from app.models import Conversation, Message

LANGUAGE_NAMES = {"RU": "русский", "KZ": "казахский", "EN": "английский"}
SPEAKER_NAMES = ("client", "operator", "bot", "system")
DEFAULT_THRESHOLD_SEC = 180


@dataclass(frozen=True, slots=True)
class Wait:
    client_index: int
    operator_index: int
    seconds: float
    warned: bool


@dataclass(frozen=True, slots=True)
class DialogueFacts:
    message_count: int
    language: str  # язык диалога по данным источника
    client_language: str | None  # по тексту реплик клиента
    first_operator_index: int | None
    operator_language: str | None
    greeting: tuple[str, str] | None  # (язык, фраза) в первой реплике оператора
    introduction: str | None
    handoff_index: int | None
    handoff_source: str  # "system" | "bot" | "client" | "none"
    first_response_sec: float | None
    threshold_sec: int
    long_waits: tuple[Wait, ...]
    identity_confirmed_index: int | None
    account_data_indexes: tuple[int, ...]  # реплики оператора о данных счёта клиента
    last_operator_index: int | None
    client_wrote_after_last_operator: bool
    end_event: tuple[int, str] | None  # (индекс, "client_left"|"operator_closed")
    suspicious: tuple[signals.Match, ...]


def clock(message: Message, channel: str) -> str:
    """Метка для транскрипта: у чатов исходная MM:SS, у звонков — смещение от начала."""
    if channel == "chat" and ":" in message.timestamp and "T" not in message.timestamp:
        return message.timestamp
    total = int(message.offset_sec)
    return f"{total // 60:02d}:{total % 60:02d}"


def format_transcript(conversation: Conversation) -> str:
    lines = []
    for message in conversation.messages:
        text = " / ".join(part.strip() for part in message.text.splitlines() if part.strip())
        lines.append(
            f"[{message.index}] {message.speaker} {clock(message, conversation.channel)}: {text}"
        )
    return "\n".join(lines)


def extract_facts(conversation: Conversation, *, threshold_sec: int | None = None) -> DialogueFacts:
    messages = conversation.messages
    threshold = int(threshold_sec or DEFAULT_THRESHOLD_SEC)
    operator = [m for m in messages if m.speaker == "operator"]
    first_op = operator[0] if operator else None
    last_op = operator[-1] if operator else None
    handoff_index, handoff_source = _handoff(messages, first_op)
    handoff_offset = messages[handoff_index].offset_sec if handoff_index is not None else None
    identity_index = next(
        (
            m.index
            for m in messages
            if m.speaker == "system" and signals.IDENTITY_CONFIRMED.search(m.text)
        ),
        None,
    )
    return DialogueFacts(
        message_count=len(messages),
        language=conversation.language,
        client_language=_majority_language(m.text for m in messages if m.speaker == "client"),
        first_operator_index=first_op.index if first_op else None,
        operator_language=signals.detect_language(first_op.text) if first_op else None,
        greeting=signals.find_greeting(first_op.text) if first_op else None,
        introduction=signals.find_introduction(first_op.text) if first_op else None,
        handoff_index=handoff_index,
        handoff_source=handoff_source,
        first_response_sec=(
            round(first_op.offset_sec - handoff_offset, 1)
            if first_op is not None and handoff_offset is not None
            else None
        ),
        threshold_sec=threshold,
        long_waits=tuple(_long_waits(messages, threshold)),
        identity_confirmed_index=identity_index,
        account_data_indexes=tuple(
            m.index for m in operator if signals.ACCOUNT_DATA.search(m.text)
        ),
        last_operator_index=last_op.index if last_op else None,
        client_wrote_after_last_operator=bool(
            last_op and any(m.speaker == "client" for m in messages[last_op.index + 1 :])
        ),
        end_event=_end_event(messages),
        suspicious=tuple(
            match for m in operator for match in signals.find_suspicious(m.index, m.text)
        ),
    )


def render_facts(facts: DialogueFacts) -> str:
    """Факты по-русски для промпта (нейтрально, без вердиктов)."""
    lines = [
        f"- Реплик в чате: {facts.message_count} (индексы 0–{facts.message_count - 1}).",
        f"- Язык диалога по данным: {_language(facts.language)}; язык реплик клиента по тексту: "
        f"{_language(facts.client_language)}.",
    ]
    lines.extend(_first_reply_lines(facts))
    lines.extend(_timing_lines(facts))
    if facts.identity_confirmed_index is not None:
        lines.append(
            f"- Системное подтверждение личности клиента: [{facts.identity_confirmed_index}]."
        )
    else:
        lines.append("- Системного подтверждения личности клиента в чате нет.")
    if facts.account_data_indexes:
        refs = ", ".join(f"[{i}]" for i in facts.account_data_indexes)
        lines.append(f"- Оператор упоминает данные счёта клиента в репликах: {refs}.")
    lines.extend(_ending_lines(facts))
    if facts.suspicious:
        found = "; ".join(f"[{m.index}] {m.label}: «{m.phrase}»" for m in facts.suspicious)
        lines.append(f"- Фразы оператора, требующие внимания (проверь по контексту): {found}.")
    else:
        lines.append(
            "- Фраз о переводе денег оператору лично, личных контактах, платных консультациях "
            "и явных оскорблений по словарю не найдено (словарь неполный)."
        )
    return "\n".join(lines)


def _first_reply_lines(facts: DialogueFacts) -> list[str]:
    if facts.first_operator_index is None:
        return ["- Оператор в чате не писал."]
    greeting = (
        f"есть приветствие «{facts.greeting[1]}» ({_language(facts.greeting[0])})"
        if facts.greeting
        else "приветствие по словарю не найдено"
    )
    intro = (
        f"представление «{facts.introduction}»"
        if facts.introduction
        else "представление (имя) по словарю не найдено"
    )
    return [
        f"- Первая реплика оператора: [{facts.first_operator_index}], язык по тексту — "
        f"{_language(facts.operator_language)}; {greeting}; {intro}."
    ]


def _timing_lines(facts: DialogueFacts) -> list[str]:
    lines = []
    source = {
        "system": "системное сообщение о передаче",
        "bot": "сообщение бота об ожидании оператора",
        "client": "первое сообщение клиента (передачи не видно)",
    }.get(facts.handoff_source)
    if facts.handoff_index is not None and facts.first_response_sec is not None:
        verdict = "в пределах" if facts.first_response_sec <= facts.threshold_sec else "дольше"
        lines.append(
            f"- Чат перешёл к оператору: [{facts.handoff_index}] ({source}). Первая реакция "
            f"оператора через {_duration(facts.first_response_sec)} — {verdict} порога "
            f"{_duration(facts.threshold_sec)}."
        )
    for wait in facts.long_waits:
        warned = "оператор заранее предупредил об ожидании" if wait.warned else "без предупреждения"
        lines.append(
            f"- Пауза: клиент [{wait.client_index}] → оператор [{wait.operator_index}] — "
            f"{_duration(wait.seconds)} ({warned})."
        )
    if not facts.long_waits:
        lines.append(
            f"- Пауз оператора дольше {_duration(facts.threshold_sec)} после сообщений клиента нет."
        )
    return lines


def _ending_lines(facts: DialogueFacts) -> list[str]:
    lines = []
    if facts.last_operator_index is not None:
        after = (
            "после неё клиент ещё писал"
            if facts.client_wrote_after_last_operator
            else "после неё клиент не писал"
        )
        lines.append(f"- Последняя реплика оператора: [{facts.last_operator_index}]; {after}.")
    if facts.end_event is not None:
        index, kind = facts.end_event
        text = "клиент ушёл / связь прервалась" if kind == "client_left" else "оператор закрыл чат"
        lines.append(f"- Системное событие конца чата: [{index}] — {text}.")
    return lines


def _handoff(messages: tuple[Message, ...], first_op: Message | None) -> tuple[int | None, str]:
    limit = first_op.index if first_op else len(messages)
    before = messages[:limit]
    for message in reversed(before):
        if message.speaker == "system" and signals.HANDOFF.search(message.text):
            return message.index, "system"
    for message in reversed(before):
        if message.speaker == "bot" and signals.BOT_WAIT_FOR_OPERATOR.search(message.text):
            return message.index, "bot"
    first_client = next((m for m in messages if m.speaker == "client"), None)
    if first_client is not None:
        return first_client.index, "client"
    return None, "none"


def _long_waits(messages: tuple[Message, ...], threshold: int) -> list[Wait]:
    waits: list[Wait] = []
    pending_client: Message | None = None
    last_operator: Message | None = None
    seen_operator = False
    for message in messages:
        if message.speaker == "client" and seen_operator and pending_client is None:
            pending_client = message
        elif message.speaker == "operator":
            if pending_client is not None:
                seconds = message.offset_sec - pending_client.offset_sec
                if seconds > threshold:
                    warned = bool(last_operator and signals.WAIT_WARNING.search(last_operator.text))
                    waits.append(
                        Wait(pending_client.index, message.index, round(seconds, 1), warned)
                    )
            pending_client = None
            last_operator = message
            seen_operator = True
    return waits


def _end_event(messages: tuple[Message, ...]) -> tuple[int, str] | None:
    for message in reversed(messages):
        if message.speaker != "system":
            continue
        if signals.CLIENT_LEFT.search(message.text):
            return message.index, "client_left"
        if signals.OPERATOR_CLOSED.search(message.text):
            return message.index, "operator_closed"
    return None


def _majority_language(texts) -> str | None:
    counts = Counter(lang for text in texts if (lang := signals.detect_language(text)))
    if not counts:
        return None
    if counts.get("KZ"):
        return "KZ"  # в казахских чатах клиент может отвечать короткими «Иә»/«Ок»
    return counts.most_common(1)[0][0]


def _language(code: str | None) -> str:
    if code is None:
        return "не определён"
    return f"{LANGUAGE_NAMES.get(code, code)} ({code})"


def _duration(seconds: float) -> str:
    total = int(round(seconds))
    return f"{total // 60} мин {total % 60:02d} с"
