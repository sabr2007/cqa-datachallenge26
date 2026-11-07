"""Ссылки на реплики в объяснениях: индексы модели [i] → номера интерфейса #i+1."""

import re

_REF = re.compile(r"\[(\d+(?:\s*(?:,|–|—|-|\.\.)\s*\d+)*)\]")
_NUMBER = re.compile(r"\d+")


def localize_refs(text: str, message_count: int) -> str:
    """«в [9] оператор…» → «в #10 оператор…»; номера вне диапазона не трогаем."""

    def replace(match: re.Match[str]) -> str:
        numbers = [int(n) for n in _NUMBER.findall(match.group(1))]
        if not numbers or any(n >= message_count for n in numbers):
            return match.group(0)
        return _NUMBER.sub(lambda m: f"#{int(m.group(0)) + 1}", match.group(1))

    return _REF.sub(replace, text)
