"""Вход для жюри: подписанная cookie-сессия поверх логина и пароля из окружения.

Включается переменной CQA_AUTH_USER (вместе с CQA_AUTH_PASSWORD и CQA_SESSION_SECRET);
без неё приложение работает без входа, как локально. Роуты — app.auth.routes
(импортируются в app.routes отдельно, чтобы не было цикла с app.services).
"""

from app.auth.gate import SessionGate, requires_session
from app.auth.service import Authenticator, build_authenticator
from app.auth.sessions import COOKIE_NAME, COOKIE_PATH, SessionCodec

__all__ = [
    "COOKIE_NAME",
    "COOKIE_PATH",
    "Authenticator",
    "SessionCodec",
    "SessionGate",
    "build_authenticator",
    "requires_session",
]
