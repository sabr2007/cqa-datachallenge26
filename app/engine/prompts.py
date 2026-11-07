"""Промпты оценки: общие инструкции + транскрипт (общий префикс) + критерий (в конце).

Промпт критерия строится только из полей чек-листа (title, yes/no/na, scale,
guidance, naAllowed, critical) — новый критерий из редактора оценивается без
правки кода. Эталон и id конкретных чатов в промпты не попадают.
"""

from collections.abc import Iterable, Mapping
from typing import Any

from app.engine.scoring import allowed_answers

PROMPT_VERSION = "2026-11-07.6"

DEFAULT_NO = "Действие было нужно, но оператор его пропустил или сделал неверно."

SYSTEM_PROMPT = """\
Ты — эксперт отдела контроля качества брокерской компании Freedom Broker. Ты проверяешь работу \
ОПЕРАТОРА службы поддержки в одном чате по одному критерию чек-листа и отвечаешь строго JSON \
по заданной схеме.

Как читать транскрипт
- Каждая реплика: [i] роль ММ:СС: текст. i — индекс реплики с нуля, время — от начала чата.
- Роли: client — клиент; operator — оператор (оцениваем только его); bot — чат-бот; system — \
системные события. Реплики бота и системные события — контекст: клиент мог всё объяснить боту \
до подключения оператора; системные сообщения показывают передачу чата оператору, \
подтверждение личности, уход клиента, закрытие чата.
- Блок «Факты» извлечён кодом автоматически. Это подсказки, они могут ошибаться — всегда сверяй \
с текстом реплик. Решение принимаешь ты.

Общие правила оценки
- «Да» (yes) — требование критерия выполнено. «Нет» (no) — действие было нужно, но оператор его \
пропустил или сделал неверно. N/A (na) — только если N/A разрешён для критерия И выполнено его \
условие неприменимости; в остальных случаях выбирай «Да»/«Нет» или ступень шкалы.
- Один чек-лист для чатов на русском, казахском и английском. Язык клиента определяй по его \
репликам.
- Базы знаний компании (тарифы, сроки, комиссии, пути в меню) у тебя нет. Не наказывай оператора \
за факты, которые нельзя проверить, и не выдумывай фактов, которых нет в чате. Наказывай за \
внутренние противоречия, явно ошибочные или нелогичные рекомендации, уход от вопроса, неполноту.
- {timing_rule}
- Теги и вложения в оценку не входят.
- Оценивай только указанный критерий. Недостатки, которые относятся к другим критериям чек-листа, \
на этот ответ не влияют, если текст критерия прямо их не требует. Не ищи нарушений сверх описанных \
в критерии и указаниях эксперта: «Нет» или ступень ниже максимальной ставь только за явное \
нарушение требования именно этого критерия.

Поля ответа заполняй строго по порядку
1. applicable, applicability_reason — применим ли критерий к этому чату и почему. Если N/A для \
критерия не разрешён — applicable всегда true.
2. evidence — 1–3 реплики-доказательства: index — индекс реплики из транскрипта; quote — \
дословный фрагмент текста ИМЕННО ЭТОЙ реплики (3–25 слов, без перефразирования и перевода). \
Для «Да» — реплика, где требование выполнено. Для пропущенного действия — реплика, где действие \
ожидалось (например, первая реплика оператора без имени или последняя реплика без итога). \
Для N/A — реплика, показывающая условие неприменимости. Если доказывать нечего (например, \
нарушения нет), оставь список пустым. Не указывай индексы, которых нет в транскрипте.
3. reasoning — краткое рассуждение (2–5 предложений): сопоставь реплики с требованиями критерия \
и указаниями эксперта.
4. verdict — итоговый ответ, строго одно из допустимых значений, перечисленных у критерия.
5. checked_range — для «Нет» за пропущенное действие и для ступени шкалы ниже максимальной: \
[первый, последний] индексы участка диалога, где действие ожидалось; иначе [].
6. na_reason — для N/A: какое условие неприменимости выполнено; иначе пустая строка.
7. explanation — 1–2 предложения для проверяющего: что именно подтверждает ответ, со ссылкой \
на реплику в формате [i] и короткой цитатой в «ёлочках».
Все текстовые поля (applicability_reason, reasoning, na_reason, explanation) пиши только \
по-русски, даже если чат на казахском или английском; цитаты — на языке оригинала."""


def build_system_prompt(rules: Mapping[str, Any]) -> str:
    threshold = int(rules.get("firstResponseThresholdSec") or 180)
    minutes, seconds = divmod(threshold, 60)
    label = f"{minutes} мин" + (f" {seconds} с" if seconds else "")
    timing_rule = (
        f"Порог первой реакции оператора — {label}. Считай его от момента, когда чат перешёл "
        "к оператору (системное событие о передаче или сообщение бота о подключении оператора), "
        "а не от начала чата; если передачи не видно — от первого сообщения клиента. Долгая пауза "
        "оператора без предупреждения — сбой ведения диалога."
    )
    return SYSTEM_PROMPT.format(timing_rule=timing_rule)


def build_prefix(transcript: str, facts: str, *, channel: str) -> str:
    kind = "звонок (расшифровка)" if channel == "call" else "чат"
    return (
        f"Канал: {kind}.\n\n<transcript>\n{transcript}\n</transcript>\n\n<facts>\n{facts}\n</facts>"
    )


def verdict_values(criterion: Mapping[str, Any]) -> list[str]:
    """Допустимые verdict критерия строками: "yes"/"no"/"na" или ступени шкалы."""
    return [_as_text(value) for value in allowed_answers(criterion)]


def union_verdicts(criteria: Iterable[Mapping[str, Any]]) -> list[str]:
    """Общий список verdict для всего чек-листа — одна схема на все критерии (кеш Claude)."""
    seen: dict[str, None] = {}
    for criterion in criteria:
        for value in verdict_values(criterion):
            seen.setdefault(value, None)
    return list(seen)


def build_criterion_block(criterion: Mapping[str, Any], *, feedback: str | None = None) -> str:
    lines = [f"Критерий {criterion['id']} — «{criterion.get('title', '').strip()}»."]
    if criterion.get("critical"):
        lines.append(
            "Это флаг грубой ошибки: «Да» (yes) означает, что нарушение ЕСТЬ; «Нет» (no) — "
            "что нарушения нет."
        )
    lines.append(f"Тип ответа: {_answer_type(criterion)}.")
    if criterion.get("answerType") != "scale" or criterion.get("yes"):
        if criterion.get("yes"):
            lines.append(f"«Да»: {criterion['yes'].strip()}")
        if criterion.get("answerType") != "scale":
            lines.append(f"«Нет»: {(criterion.get('no') or DEFAULT_NO).strip()}")
    if criterion.get("answerType") == "scale":
        lines.append("Ступени шкалы (выбери ровно одну):")
        for step in criterion.get("scale") or []:
            lines.append(f"- {_as_text(step.get('value'))} — {str(step.get('label', '')).strip()}")
    if criterion.get("naAllowed"):
        condition = (criterion.get("na") or "критерий неприменим к этому чату").strip()
        lines.append(f"N/A разрешён, условие: {condition}")
    else:
        lines.append("N/A для этого критерия не разрешён.")
    guidance = (criterion.get("guidance") or "").strip()
    if guidance:
        lines.append(f"Указания эксперта:\n{guidance}")
    values = ", ".join(f'"{value}"' for value in verdict_values(criterion))
    lines.append(f"Допустимые значения verdict: {values}.")
    if feedback:
        lines.append(f"\nВНИМАНИЕ, повторная проверка: {feedback}")
    lines.append("Верни JSON.")
    return "<criterion>\n" + "\n".join(lines) + "\n</criterion>"


def response_schema(verdicts: list[str]) -> dict[str, Any]:
    evidence_item = {
        "type": "object",
        "properties": {"index": {"type": "integer"}, "quote": {"type": "string"}},
        "required": ["index", "quote"],
        "additionalProperties": False,
    }
    properties = {
        "applicable": {"type": "boolean"},
        "applicability_reason": {"type": "string"},
        "evidence": {"type": "array", "items": evidence_item},
        "reasoning": {"type": "string"},
        "verdict": {"type": "string", "enum": verdicts},
        "checked_range": {"type": "array", "items": {"type": "integer"}},
        "na_reason": {"type": "string"},
        "explanation": {"type": "string"},
    }
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _answer_type(criterion: Mapping[str, Any]) -> str:
    na = " или N/A" if criterion.get("naAllowed") else ""
    if criterion.get("answerType") == "scale":
        steps = "/".join(_as_text(step.get("value")) for step in criterion.get("scale") or [])
        return f"шкала {steps}{na}"
    return f"Да/Нет{na}"


def _as_text(value: object) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)
