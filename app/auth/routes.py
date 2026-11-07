"""Вход для жюри: POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me.

Ответ всех трёх — состояние входа {"auth_required", "authenticated", "user"}; когда вход
выключен (CQA_AUTH_USER не задан), auth_required = false и страница входа сразу
возвращает на исходный адрес.
"""

import logging
import math
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import JSONResponse

from app.api.errors import bad_request
from app.api.validation import require_object
from app.auth.gate import NO_STORE
from app.auth.sessions import COOKIE_NAME, COOKIE_PATH
from app.errors import ApiError, error_response
from app.services import Services, get_services

logger = logging.getLogger("cqa.auth")

router = APIRouter(prefix="/auth")

ServicesDep = Annotated[Services, Depends(get_services)]
JsonBody = Annotated[Any, Body()]

MAX_CREDENTIAL_CHARS = 256
SECONDS_PER_MINUTE = 60


class InvalidCredentialsError(ApiError):
    status_code = 401
    code = "invalid_credentials"
    message = "Неверный логин или пароль."


@router.get("/me")
def me(request: Request, services: ServicesDep) -> JSONResponse:
    auth = services.auth
    return _state(auth_required=auth is not None, user=auth.session_user(request) if auth else None)


@router.post("/login")
def login(request: Request, payload: JsonBody, services: ServicesDep) -> JSONResponse:
    auth = services.auth
    if auth is None:
        raise bad_request("auth_disabled", "Вход не нужен: на этом сервере он выключен.")
    username, password = _credentials(payload)
    address = auth.client_address(request)
    wait_sec = auth.limiter.retry_after(address)
    if wait_sec:
        logger.warning("Вход: слишком много неудачных попыток с %s", address)
        return error_response(
            429,
            "too_many_attempts",
            f"Слишком много неудачных попыток входа. Повторите через {_wait_text(wait_sec)}.",
            headers={**NO_STORE, "Retry-After": str(wait_sec)},
        )
    if not auth.check_credentials(username, password):
        auth.limiter.record_failure(address)
        raise InvalidCredentialsError()
    auth.limiter.reset(address)
    response = _state(auth_required=True, user=auth.user)
    response.set_cookie(
        COOKIE_NAME,
        auth.codec.issue(),
        max_age=auth.codec.ttl_sec,
        path=COOKIE_PATH,
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return response


@router.post("/logout")
def logout(services: ServicesDep) -> JSONResponse:
    response = _state(auth_required=services.auth is not None, user=None)
    response.delete_cookie(
        COOKIE_NAME, path=COOKIE_PATH, secure=True, httponly=True, samesite="lax"
    )
    return response


def _state(*, auth_required: bool, user: str | None) -> JSONResponse:
    return JSONResponse(
        {"auth_required": auth_required, "authenticated": user is not None, "user": user},
        headers=NO_STORE,
    )


def _credentials(payload: object) -> tuple[str, str]:
    body = require_object(payload)
    username, password = body.get("username"), body.get("password")
    if not _filled(username) or not _filled(password):
        raise bad_request(
            "credentials_required",
            f"Введите логин и пароль (каждый — до {MAX_CREDENTIAL_CHARS} символов).",
        )
    return username.strip(), password.strip()


def _filled(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value.strip()) <= MAX_CREDENTIAL_CHARS


def _wait_text(seconds: int) -> str:
    if seconds < SECONDS_PER_MINUTE:
        return f"{seconds} с"
    return f"{math.ceil(seconds / SECONDS_PER_MINUTE)} мин"
