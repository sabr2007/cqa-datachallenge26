"""Вход для жюри: закрытый API, cookie-сессия, ограничение попыток, выключенный вход."""

import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth.limiter import LoginRateLimiter
from app.auth.sessions import COOKIE_NAME, SESSION_TTL_SEC, SessionCodec
from app.config import AuthSettings, Settings, load_settings
from app.factory import create_app
from tests.support import RecordingUpstream, load_payload

USER = "jury"
JURY_KEY = "correct horse battery"  # пароль жюри в тестах
SIGNING_KEY = "k" * 40  # CQA_SESSION_SECRET в тестах
AUTH = AuthSettings(USER, JURY_KEY, SIGNING_KEY)
LOGIN = "/api/auth/login"


@contextmanager
def client_for(auth: AuthSettings | None = AUTH, **overrides: Any) -> Iterator[TestClient]:
    """Клиент по https: cookie с флагом Secure браузер (и httpx) шлёт только так."""
    settings = Settings(**{"serve_static": False, "auth": auth, **overrides})
    transport = httpx.MockTransport(RecordingUpstream(load_payload()))
    with TestClient(create_app(settings, transport=transport), base_url="https://testserver") as c:
        yield c


def log_in(client: TestClient, key: str = JURY_KEY, **kwargs: Any) -> httpx.Response:
    return client.post(LOGIN, json={"username": USER, "password": key}, **kwargs)


def assert_error(response: httpx.Response, status_code: int, code: str) -> None:
    assert response.status_code == status_code, response.text
    assert response.json()["error"]["code"] == code
    assert response.json()["error"]["message"]


def session_cookie(token: str) -> dict[str, str]:
    return {"Cookie": f"{COOKIE_NAME}={token}"}


def test_api_is_closed_without_session_but_health_and_login_stay_open() -> None:
    with client_for() as client:
        closed = [
            client.get("/api/checklists"),
            client.post("/api/evaluations", json={}),
            client.get("/api/datasets/DEV/conversations/p1-ru-001/audio"),
            client.get("/api/export?group_id=DEV"),
            client.get("/api/docs"),
            client.get("/api/openapi.json"),
            client.get("/api//checklists"),
        ]
        health = client.get("/api/health")
        me = client.get("/api/auth/me")

    for response in closed:
        assert_error(response, 401, "auth_required")
        assert response.headers["cache-control"] == "no-store"
    assert health.json() == {"ok": True}
    assert me.json() == {"auth_required": True, "authenticated": False, "user": None}


def test_login_sets_secure_session_cookie_and_opens_api() -> None:
    with client_for() as client:
        login = log_in(client)
        checklists = client.get("/api/checklists")
        me = client.get("/api/auth/me")

    assert login.status_code == 200
    assert login.json() == {"auth_required": True, "authenticated": True, "user": USER}
    cookie = login.headers["set-cookie"]
    assert cookie.startswith(f"{COOKIE_NAME}=")
    for flag in ("HttpOnly", "Secure", "SameSite=lax", "Path=/api", f"Max-Age={SESSION_TTL_SEC}"):
        assert flag.lower() in cookie.lower()
    assert checklists.status_code == 200
    assert me.json()["authenticated"] is True


def test_logout_clears_the_session() -> None:
    with client_for() as client:
        log_in(client)
        logout = client.post("/api/auth/logout")
        after = client.get("/api/checklists")

    assert logout.json()["authenticated"] is False
    assert "max-age=0" in logout.headers["set-cookie"].lower()
    assert_error(after, 401, "auth_required")


@pytest.mark.parametrize(
    ("body", "status_code", "code"),
    [
        ({"username": USER, "password": "wrong"}, 401, "invalid_credentials"),
        ({"username": "admin", "password": JURY_KEY}, 401, "invalid_credentials"),
        ({"username": USER}, 400, "credentials_required"),
        ({"username": " ", "password": JURY_KEY}, 400, "credentials_required"),
        ({"username": USER, "password": "x" * 300}, 400, "credentials_required"),
        (["jury"], 400, "invalid_body"),
    ],
)
def test_bad_credentials_are_rejected(body: object, status_code: int, code: str) -> None:
    with client_for() as client:
        response = client.post(LOGIN, json=body)
        after = client.get("/api/checklists")

    assert_error(response, status_code, code)
    assert "set-cookie" not in response.headers
    assert_error(after, 401, "auth_required")


def test_credentials_with_surrounding_spaces_are_accepted() -> None:
    with client_for() as client:
        response = client.post(LOGIN, json={"username": f" {USER} ", "password": f"{JURY_KEY} "})

    assert response.status_code == 200


def test_forged_expired_and_revoked_sessions_are_rejected() -> None:
    valid = SessionCodec(AUTH).issue()
    forged = valid[:-2] + ("AA" if not valid.endswith("AA") else "BB")
    expired = SessionCodec(AUTH, clock=lambda: time.time() - SESSION_TTL_SEC - 5).issue()
    other_secret = SessionCodec(AuthSettings(USER, JURY_KEY, "z" * 40)).issue()
    old_password = SessionCodec(AuthSettings(USER, "old password", SIGNING_KEY)).issue()

    with client_for() as client:
        accepted = client.get("/api/checklists", headers=session_cookie(valid))
        rejected = [
            client.get("/api/checklists", headers=session_cookie(token))
            for token in (forged, expired, other_secret, old_password, "garbage", "a.b", "")
        ]

    assert accepted.status_code == 200
    for response in rejected:
        assert_error(response, 401, "auth_required")


def test_login_attempts_are_limited_per_address() -> None:
    attacker = {"X-Forwarded-For": "203.0.113.5"}
    neighbour = {"X-Forwarded-For": "203.0.113.6, 10.0.0.1"}
    with client_for(trust_proxy_headers=True) as client:
        failures = [log_in(client, "wrong", headers=attacker) for _ in range(10)]
        blocked = log_in(client, headers=attacker)  # даже верный пароль — после лимита
        other = log_in(client, headers=neighbour)

    assert all(response.status_code == 401 for response in failures)
    assert_error(blocked, 429, "too_many_attempts")
    assert 0 < int(blocked.headers["retry-after"]) <= 300
    assert "мин" in blocked.json()["error"]["message"]
    assert other.status_code == 200


def test_forwarded_address_is_ignored_outside_vercel() -> None:
    with client_for() as client:  # trust_proxy_headers=False: X-Forwarded-For подделывается
        for number in range(10):
            log_in(client, "wrong", headers={"X-Forwarded-For": f"198.51.100.{number}"})
        blocked = log_in(client, headers={"X-Forwarded-For": "198.51.100.99"})

    assert_error(blocked, 429, "too_many_attempts")


def test_rate_limiter_window_reset_and_memory_bound() -> None:
    now = [1000.0]
    limiter = LoginRateLimiter(max_failures=3, window_sec=60, max_tracked=2, clock=lambda: now[0])

    for _ in range(3):
        limiter.record_failure("a")
    blocked_for = limiter.retry_after("a")
    now[0] += 61
    after_window = limiter.retry_after("a")
    for _ in range(3):
        limiter.record_failure("a")
    limiter.reset("a")
    after_reset = limiter.retry_after("a")
    for address in ("b", "c", "d"):
        limiter.record_failure(address)

    assert blocked_for == 60
    assert after_window == 0
    assert after_reset == 0
    assert set(limiter._failures) == {"c", "d"}  # самые старые адреса вытеснены


def test_login_is_disabled_without_auth_settings() -> None:
    with client_for(auth=None) as client:
        checklists = client.get("/api/checklists")
        me = client.get("/api/auth/me")
        login = log_in(client)

    assert checklists.status_code == 200
    assert me.json() == {"auth_required": False, "authenticated": False, "user": None}
    assert_error(login, 400, "auth_disabled")


def test_static_files_stay_public_with_auth(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html><title>CQA</title>", encoding="utf-8")
    (tmp_path / "login.html").write_text("<!doctype html><title>Вход</title>", encoding="utf-8")

    with client_for(serve_static=True, public_dir=tmp_path) as client:
        index = client.get("/")
        login_page = client.get("/login.html")
        api = client.get("/api/checklists")

    assert (index.status_code, login_page.status_code) == (200, 200)
    assert_error(api, 401, "auth_required")


def test_auth_settings_come_from_env_and_secrets_stay_out_of_repr() -> None:
    env = {
        "CQA_AUTH_USER": f" {USER} ",
        "CQA_AUTH_PASSWORD": f"{JURY_KEY}\n",
        "CQA_SESSION_SECRET": SIGNING_KEY,
        "VERCEL": "1",
    }

    settings = load_settings(env)

    assert settings.auth == AUTH  # пробелы и перевод строки по краям отброшены
    assert settings.trust_proxy_headers is True
    assert load_settings({}).auth is None
    assert load_settings({}).trust_proxy_headers is False
    assert JURY_KEY not in repr(settings) and SIGNING_KEY not in repr(settings)


@pytest.mark.parametrize(
    "env",
    [
        {"CQA_AUTH_USER": USER, "CQA_SESSION_SECRET": SIGNING_KEY},
        {"CQA_AUTH_USER": USER, "CQA_AUTH_PASSWORD": JURY_KEY},
        {"CQA_AUTH_USER": USER, "CQA_AUTH_PASSWORD": JURY_KEY, "CQA_SESSION_SECRET": "short"},
    ],
)
def test_incomplete_auth_settings_fail_fast(env: dict[str, str]) -> None:
    with pytest.raises(ValueError) as caught:
        load_settings(env)

    assert JURY_KEY not in str(caught.value)
