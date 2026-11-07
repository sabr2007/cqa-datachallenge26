"""Проверка логина и пароля жюри, выдача сессий и учёт попыток входа."""

import hashlib
import hmac
from dataclasses import dataclass, field

from fastapi import Request

from app.auth.limiter import LoginRateLimiter
from app.auth.sessions import COOKIE_NAME, SessionCodec
from app.config import Settings

UNKNOWN_ADDRESS = "unknown"


@dataclass(frozen=True, slots=True)
class Authenticator:
    user: str
    codec: SessionCodec
    limiter: LoginRateLimiter
    trust_proxy_headers: bool
    _user_digest: bytes = field(repr=False)
    _password_digest: bytes = field(repr=False)

    def check_credentials(self, username: str, password: str) -> bool:
        """Сравнение за постоянное время: обе проверки выполняются всегда."""
        user_ok = hmac.compare_digest(_digest(username), self._user_digest)
        password_ok = hmac.compare_digest(_digest(password), self._password_digest)
        return user_ok and password_ok

    def session_user(self, request: Request) -> str | None:
        return self.codec.verify(request.cookies.get(COOKIE_NAME))

    def client_address(self, request: Request) -> str:
        """IP клиента: за прокси Vercel — из его заголовков (их он перезаписывает сам)."""
        if self.trust_proxy_headers:
            forwarded = (
                request.headers.get("x-real-ip")
                or request.headers.get("x-forwarded-for", "").split(",")[0]
            )
            if forwarded.strip():
                return forwarded.strip()
        return request.client.host if request.client else UNKNOWN_ADDRESS


def build_authenticator(settings: Settings) -> Authenticator | None:
    """None — вход выключен (CQA_AUTH_USER не задан)."""
    auth = settings.auth
    if auth is None:
        return None
    return Authenticator(
        user=auth.user,
        codec=SessionCodec(auth),
        limiter=LoginRateLimiter(),
        trust_proxy_headers=settings.trust_proxy_headers,
        _user_digest=_digest(auth.user),
        _password_digest=_digest(auth.password),
    )


def _digest(value: str) -> bytes:
    """Хэш одинаковой длины для любой строки — compare_digest не выдаёт длину пароля."""
    return hashlib.sha256(value.encode("utf-8", "replace")).digest()
