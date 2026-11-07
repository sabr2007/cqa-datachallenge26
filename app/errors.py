"""Ошибки API в едином формате {"error": {"code", "message"}} и их обработчики.

`message` уходит клиенту и всегда безопасен; `detail` — только в серверный лог
(предварительно из него вырезаются подписи и query-строки URL).
"""

import logging
import re

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("cqa.errors")

_URL_QUERY_RE = re.compile(r"(https?://[^\s?#\"'<>]+)\?[^\s#\"'<>]*")
_SIGNATURE_RE = re.compile(r"(?i)\b(sig|skoid|sktid|sks)=[^&\s\"'<>]+")


class ApiError(Exception):
    status_code = 500
    code = "internal_error"
    message = "Внутренняя ошибка сервера."

    def __init__(
        self, message: str | None = None, *, code: str | None = None, detail: str | None = None
    ) -> None:
        resolved_message = message or type(self).message
        super().__init__(resolved_message)
        self.message = resolved_message
        self.code = code or type(self).code
        self.detail = detail


class BadRequestError(ApiError):
    status_code = 400
    code = "invalid_request"
    message = "Некорректные параметры запроса."


class NotFoundError(ApiError):
    status_code = 404
    code = "not_found"
    message = "Ресурс не найден."


class UpstreamError(ApiError):
    status_code = 502
    code = "upstream_error"
    message = "Источник данных вернул ошибку. Попробуйте позже."


class UpstreamTimeoutError(ApiError):
    status_code = 504
    code = "upstream_timeout"
    message = "Источник данных не ответил вовремя. Попробуйте ещё раз."


def invalid_id(kind: str) -> BadRequestError:
    return BadRequestError(
        f"Некорректный {kind}: допустимы латинские буквы, цифры, «_» и «-», от 1 до 64 символов.",
        code=f"invalid_{kind}",
    )


def conversation_not_found(group_id: str, conversation_id: str) -> NotFoundError:
    return NotFoundError(
        f"Диалог «{conversation_id}» не найден в наборе «{group_id}».",
        code="conversation_not_found",
    )


def audio_not_found() -> NotFoundError:
    return NotFoundError("У этого диалога нет аудиозаписи.", code="audio_not_found")


def dataset_not_found(group_id: str, *, detail: str | None = None) -> UpstreamError:
    return UpstreamError(
        f"Источник не нашёл набор данных «{group_id}». Проверьте group_id.",
        code="dataset_not_found",
        detail=detail,
    )


def upstream_unavailable(*, detail: str | None = None) -> UpstreamError:
    return UpstreamError(
        "Не удалось связаться с источником данных. Попробуйте позже.",
        code="upstream_unavailable",
        detail=detail,
    )


def upstream_invalid_response(*, detail: str | None = None) -> UpstreamError:
    return UpstreamError(
        "Источник данных вернул некорректный ответ.",
        code="upstream_invalid_response",
        detail=detail,
    )


def upstream_timeout(timeout_sec: float, *, detail: str | None = None) -> UpstreamTimeoutError:
    return UpstreamTimeoutError(
        f"Источник данных не ответил за {timeout_sec:g} с. Попробуйте ещё раз.", detail=detail
    )


def audio_unavailable(*, detail: str | None = None) -> UpstreamError:
    return UpstreamError(
        "Не удалось получить аудиозапись из источника.", code="audio_unavailable", detail=detail
    )


def redact(text: str) -> str:
    """Убирает из текста query-строки URL и подписи, чтобы они не попали в лог."""
    return _SIGNATURE_RE.sub(r"\1=***", _URL_QUERY_RE.sub(r"\1?***", text))


def error_response(
    status_code: int, code: str, message: str, headers: dict[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": code, "message": message}}, status_code=status_code, headers=headers
    )


_HTTP_ERRORS = {
    404: ("not_found", "Ресурс не найден."),
    405: ("method_not_allowed", "Метод не поддерживается."),
}


async def _handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
    log = logger.warning if exc.status_code >= 500 else logger.info
    suffix = f" ({redact(exc.detail)})" if exc.detail else ""
    log("%s %s -> %d %s%s", request.method, request.url.path, exc.status_code, exc.code, suffix)
    return error_response(exc.status_code, exc.code, exc.message)


async def _handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code, message = _HTTP_ERRORS.get(exc.status_code, ("http_error", "Ошибка запроса."))
    return error_response(exc.status_code, code, message, headers=exc.headers)


_BODY_ERROR_MESSAGES = {
    "json_invalid": "Тело запроса — некорректный JSON.",
    "missing": "Нужно тело запроса в формате JSON.",
}


async def _handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    logger.info("%s %s -> 400 invalid_request", request.method, request.url.path)
    return error_response(400, BadRequestError.code, _validation_message(exc))


def _validation_message(exc: RequestValidationError) -> str:
    """Понятнее общего текста, если сломано именно тело запроса."""
    for error in exc.errors():
        location = error.get("loc") or ()
        if location[:1] == ("body",) and error.get("type") in _BODY_ERROR_MESSAGES:
            return _BODY_ERROR_MESSAGES[error["type"]]
    return BadRequestError.message


async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
    # Трейсбек пишет сервер: Starlette пробрасывает исключение дальше после ответа.
    return error_response(500, ApiError.code, ApiError.message)


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _handle_api_error)
    app.add_exception_handler(StarletteHTTPException, _handle_http_exception)
    app.add_exception_handler(RequestValidationError, _handle_validation_error)
    app.add_exception_handler(Exception, _handle_unexpected)
