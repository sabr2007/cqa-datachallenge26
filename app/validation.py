"""Проверка идентификаторов из URL: group_id и conversation_id."""

import re

from app.errors import invalid_id

# fullmatch, а не match с `$`: `$` пропускает завершающий перевод строки.
ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}")


def is_valid_id(value: object) -> bool:
    return isinstance(value, str) and ID_PATTERN.fullmatch(value) is not None


def require_group_id(value: str) -> str:
    if not is_valid_id(value):
        raise invalid_id("group_id")
    return value


def require_conversation_id(value: str) -> str:
    if not is_valid_id(value):
        raise invalid_id("conversation_id")
    return value
