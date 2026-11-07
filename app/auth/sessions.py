"""Сессия входа — подписанная HMAC-SHA256 cookie с истечением, без хранилища на сервере.

Значение: base64url(JSON {"u": логин, "exp": unix-время}) + "." + base64url(подпись).
Ключ подписи выводится из CQA_SESSION_SECRET, логина и пароля: смена любого из них
отзывает все выданные сессии (например, если пароль утёк дальше жюри).
"""

import base64
import binascii
import hashlib
import hmac
import json
import time
from collections.abc import Callable

from app.config import AuthSettings

COOKIE_NAME = "cqa_session"
COOKIE_PATH = "/api"  # cookie нужна только API; статика публичная
SESSION_TTL_SEC = 7 * 24 * 3600  # жюри смотрит проект несколько дней
MAX_TOKEN_CHARS = 512
_KEY_CONTEXT = b"cqa-session-v1"


class SessionCodec:
    def __init__(
        self,
        auth: AuthSettings,
        *,
        ttl_sec: int = SESSION_TTL_SEC,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._user = auth.user
        material = b"\x00".join((_KEY_CONTEXT, _utf8(auth.user), _utf8(auth.password)))
        self._key = hmac.new(_utf8(auth.session_secret), material, hashlib.sha256).digest()
        self._ttl_sec = ttl_sec
        self._clock = clock

    @property
    def ttl_sec(self) -> int:
        return self._ttl_sec

    def issue(self) -> str:
        payload = {"u": self._user, "exp": int(self._clock()) + self._ttl_sec}
        body = _b64encode(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode())
        return f"{body}.{self._sign(body)}"

    def verify(self, token: str | None) -> str | None:
        """Логин из действующей сессии или None: нет, подделана, истекла или логин сменился."""
        if not token or len(token) > MAX_TOKEN_CHARS:
            return None
        body, _, signature = token.partition(".")
        if not hmac.compare_digest(_utf8(signature), _utf8(self._sign(body))):
            return None
        try:  # подпись верна — тело выдано нами, но разбираем всё равно осторожно
            payload = json.loads(_b64decode(body))
        except (binascii.Error, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        user, expires = payload.get("u"), payload.get("exp")
        if user != self._user or not isinstance(expires, int) or isinstance(expires, bool):
            return None
        return user if expires > self._clock() else None

    def _sign(self, body: str) -> str:
        return _b64encode(hmac.new(self._key, _utf8(body), hashlib.sha256).digest())


def _utf8(text: str) -> bytes:
    return text.encode("utf-8", "replace")


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
