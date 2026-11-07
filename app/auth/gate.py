"""ASGI-прослойка: все /api/* без действующей сессии → 401 auth_required.

Открыты только /api/health и сами эндпоинты входа. Статика (HTML/JS/CSS) публична:
данные доступны лишь через API. Путь сравнивается после схлопывания повторных «/»,
а исключения — точные пути, поэтому обойти проверку вариантом адреса нельзя.
"""

import re

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth.sessions import COOKIE_NAME, SessionCodec
from app.errors import error_response

PUBLIC_API_PATHS = frozenset({"/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me"})
AUTH_REQUIRED_CODE = "auth_required"
AUTH_REQUIRED_MESSAGE = "Войдите, чтобы продолжить: данные доступны только после входа."
NO_STORE = {"Cache-Control": "no-store"}

_REPEATED_SLASHES = re.compile(r"/{2,}")


def requires_session(path: str) -> bool:
    normalized = _REPEATED_SLASHES.sub("/", path)
    if normalized in PUBLIC_API_PATHS:
        return False
    return normalized == "/api" or normalized.startswith("/api/")


class SessionGate:
    def __init__(self, app: ASGIApp, *, codec: SessionCodec) -> None:
        self.app = app
        self.codec = codec

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and requires_session(scope["path"]):
            token = HTTPConnection(scope).cookies.get(COOKIE_NAME)
            if self.codec.verify(token) is None:
                response = error_response(
                    401, AUTH_REQUIRED_CODE, AUTH_REQUIRED_MESSAGE, headers=NO_STORE
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
