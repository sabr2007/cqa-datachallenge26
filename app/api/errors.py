"""Ошибки эндпоинтов чек-листов, оценок и апелляций.

Формат ответа и обработчики — в app.errors. `message` уходит клиенту, `detail` —
только в серверный лог и перед этим чистится от секретов (scrub).
"""

import os
import re

from app.errors import ApiError, BadRequestError, NotFoundError, redact


class ConflictError(ApiError):
    status_code = 409
    code = "conflict"
    message = "Запрос конфликтует с текущим состоянием данных."


class ServiceUnavailableError(ApiError):
    status_code = 503
    code = "service_unavailable"
    message = "Сервис временно недоступен. Попробуйте позже."


class EvaluationFailedError(ApiError):
    status_code = 502
    code = "evaluation_failed"
    message = "Не удалось оценить диалог: движок оценки вернул ошибку. Попробуйте ещё раз."


class EvaluationTimeoutError(ApiError):
    status_code = 504
    code = "evaluation_timeout"
    message = "Оценка не уложилась во время. Попробуйте ещё раз."


def bad_request(code: str, message: str) -> BadRequestError:
    return BadRequestError(message, code=code)


def checklist_not_found(checklist_id: str) -> NotFoundError:
    return NotFoundError(f"Чек-лист «{checklist_id}» не найден.", code="checklist_not_found")


def checklist_version_not_found(checklist_id: str, version: int) -> NotFoundError:
    return NotFoundError(
        f"У чек-листа «{checklist_id}» нет версии {version}.",
        code="checklist_version_not_found",
    )


def checklist_unavailable(*, detail: str | None = None) -> ApiError:
    return ApiError("Не удалось прочитать чек-лист.", code="checklist_unavailable", detail=detail)


def evaluation_not_found(evaluation_id: str) -> NotFoundError:
    return NotFoundError(f"Оценка «{evaluation_id}» не найдена.", code="evaluation_not_found")


def appeal_not_found(appeal_id: str) -> NotFoundError:
    return NotFoundError(f"Апелляция «{appeal_id}» не найдена.", code="appeal_not_found")


def criterion_not_found(criterion_id: str) -> NotFoundError:
    return NotFoundError(f"В оценке нет критерия «{criterion_id}».", code="criterion_not_found")


def appeal_exists(criterion_id: str) -> ConflictError:
    return ConflictError(
        f"По критерию «{criterion_id}» этой оценки апелляция уже подана.", code="appeal_exists"
    )


def appeal_already_resolved() -> ConflictError:
    return ConflictError("Апелляция уже рассмотрена.", code="appeal_already_resolved")


def evaluation_conflict() -> ConflictError:
    return ConflictError(
        "Оценку одновременно изменили. Обновите страницу и повторите действие.",
        code="evaluation_conflict",
    )


def evaluation_not_appealable() -> ConflictError:
    return ConflictError(
        "Оценка завершилась ошибкой — обжаловать в ней нечего. Запустите оценку заново.",
        code="evaluation_not_appealable",
    )


def engine_unavailable(*, detail: str | None = None) -> ServiceUnavailableError:
    return ServiceUnavailableError(
        "Движок оценки сейчас недоступен. Попробуйте позже.",
        code="engine_unavailable",
        detail=detail,
    )


def evaluation_failed(
    message: str | None = None, *, detail: str | None = None
) -> EvaluationFailedError:
    return EvaluationFailedError(message, detail=detail)


def evaluation_invalid(*, detail: str | None = None) -> EvaluationFailedError:
    return EvaluationFailedError(
        "Движок оценки вернул результат в неожиданном формате. Попробуйте ещё раз.",
        code="evaluation_invalid",
        detail=detail,
    )


def evaluation_timeout(timeout_sec: float) -> EvaluationTimeoutError:
    return EvaluationTimeoutError(f"Оценка не уложилась в {timeout_sec:g} с. Попробуйте ещё раз.")


def scoring_failed(*, detail: str | None = None) -> ApiError:
    return ApiError("Не удалось пересчитать итог оценки.", code="scoring_failed", detail=detail)


def gold_unavailable(*, detail: str | None = None) -> ApiError:
    return ApiError(
        "Не удалось прочитать эталонную разметку (eval/gold.json).",
        code="gold_unavailable",
        detail=detail,
    )


# Секреты из .env (docs/CONTRACT.md) не должны попасть ни в ответ, ни в лог.
_SECRET_ENV_NAMES = ("ANTHROPIC_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")
_MIN_SECRET_LENGTH = 6
_ACCOUNT_PATH_RE = re.compile(r"(/accounts/)[^/\s\"'<>?#]+")
_ANTHROPIC_KEY_RE = re.compile(r"\bsk-ant-[A-Za-z0-9_-]+")
_BEARER_RE = re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]+")
_TEXT_LIMIT = 500


def scrub(text: str, *, limit: int = _TEXT_LIMIT) -> str:
    """Текст ошибки без подписей URL, id аккаунта, ключей и токенов; не длиннее limit."""
    cleaned = redact(text)
    cleaned = _ACCOUNT_PATH_RE.sub(r"\1***", cleaned)
    cleaned = _ANTHROPIC_KEY_RE.sub("sk-ant-***", cleaned)
    cleaned = _BEARER_RE.sub(r"\1***", cleaned)
    for name in _SECRET_ENV_NAMES:
        value = (os.environ.get(name) or "").strip()
        if len(value) >= _MIN_SECRET_LENGTH:
            cleaned = cleaned.replace(value, "***")
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1] + "…"
