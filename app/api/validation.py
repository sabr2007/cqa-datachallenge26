"""Проверка тел запросов и параметров: понятные русские сообщения, коды snake_case.

Внешним данным не доверяем: всё, что пришло в теле, проверяется здесь, на границе,
и дальше уходит уже в проверенном виде.
"""

import math
from collections.abc import Mapping
from typing import Any

from app.api.errors import bad_request
from app.errors import BadRequestError, invalid_id
from app.store import APPEAL_STATUSES, PURPOSES, AppealStatus, Purpose
from app.validation import is_valid_id

MAX_COMMENT_CHARS = 2000
MAX_LIMIT = 1000


def require_object(payload: object) -> Mapping[str, Any]:
    if not isinstance(payload, Mapping):
        raise bad_request("invalid_body", "Тело запроса должно быть JSON-объектом.")
    return payload


def require_path_id(value: str, kind: str) -> str:
    """id из пути или параметра запроса: тот же формат, что у group_id/conversation_id."""
    if not is_valid_id(value):
        raise invalid_id(kind)
    return value


def optional_query_id(value: str | None, kind: str) -> str | None:
    return None if value is None or value == "" else require_path_id(value, kind)


def body_id(payload: Mapping[str, Any], key: str, *, required: bool = True) -> str | None:
    value = payload.get(key)
    if value is None and not required:
        return None
    if not is_valid_id(value):
        raise invalid_id(key)
    return value


def body_text(
    payload: Mapping[str, Any],
    key: str,
    *,
    label: str,
    max_chars: int = MAX_COMMENT_CHARS,
    required: bool = True,
) -> str | None:
    """Строка без крайних пробелов; пустая — ошибка (или None, если поле необязательное)."""
    value = payload.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise _text_error(key, label, max_chars, required)
    text = value.strip()
    if not text:
        if not required:
            return None
        raise _text_error(key, label, max_chars, required)
    if len(text) > max_chars:
        raise bad_request(
            f"invalid_{key}", f"{label}: не длиннее {max_chars} символов (сейчас {len(text)})."
        )
    return text


def body_bool(payload: Mapping[str, Any], key: str, *, default: bool) -> bool:
    value = payload.get(key, default)
    if value is None:
        return default
    if not isinstance(value, bool):
        raise bad_request(f"invalid_{key}", f"Поле {key} должно быть true или false.")
    return value


def body_positive_int(payload: Mapping[str, Any], key: str) -> int | None:
    value = payload.get(key)
    if value is None:
        return None
    if not is_positive_int(value):
        raise bad_request(f"invalid_{key}", f"Поле {key} должно быть целым числом больше нуля.")
    return value


def body_purpose(payload: Mapping[str, Any]) -> Purpose | None:
    value = payload.get("purpose")
    if value is None:
        return None
    if value not in PURPOSES:
        raise bad_request("invalid_purpose", "purpose: допустимы «regular» и «sandbox».")
    return value


def query_purpose(value: str | None) -> Purpose | None:
    if value is None or value == "":
        return None
    if value not in PURPOSES:
        raise bad_request("invalid_purpose", "purpose: допустимы «regular» и «sandbox».")
    return value  # type: ignore[return-value]


def query_appeal_status(value: str | None) -> AppealStatus | None:
    if value is None or value == "":
        return None
    if value not in APPEAL_STATUSES:
        raise bad_request("invalid_status", "status: допустимы «open» и «resolved».")
    return value  # type: ignore[return-value]


def query_version(value: int | None) -> int | None:
    if value is not None and value < 1:
        raise bad_request("invalid_version", "Номер версии должен быть целым числом больше нуля.")
    return value


def query_limit(value: int, *, maximum: int = MAX_LIMIT) -> int:
    if not 1 <= value <= maximum:
        raise bad_request("invalid_limit", f"limit должен быть от 1 до {maximum}.")
    return value


def is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def is_number(value: object) -> bool:
    """Конечное число (bool — не число, хоть и подкласс int)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    return math.isfinite(value)


def _text_error(key: str, label: str, max_chars: int, required: bool) -> BadRequestError:
    hint = "обязательное поле, " if required else ""
    return bad_request(f"invalid_{key}", f"{label}: {hint}непустая строка до {max_chars} символов.")
