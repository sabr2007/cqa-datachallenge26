import re
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import DEFAULT_API_URL, PROJECT_ROOT, Settings, load_settings
from app.factory import create_app
from tests.support import RecordingUpstream, load_payload


def make_app_client(public_dir: Path, *, serve_static: bool) -> TestClient:
    settings = Settings(public_dir=public_dir, serve_static=serve_static)
    transport = httpx.MockTransport(RecordingUpstream(load_payload()))
    return TestClient(create_app(settings, transport=transport))


def test_frontend_is_served_locally_after_api_routes(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html><title>CQA</title>", encoding="utf-8")
    (tmp_path / "api").mkdir()
    (tmp_path / "api" / "health").write_text("файл не должен перекрыть API", encoding="utf-8")

    with make_app_client(tmp_path, serve_static=True) as client:
        index = client.get("/")
        health = client.get("/api/health")
        missing = client.get("/missing.js")

    assert index.status_code == 200
    assert "<title>CQA</title>" in index.text
    assert health.json() == {"ok": True}
    assert missing.status_code == 404


def test_frontend_is_not_mounted_when_static_serving_is_off(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html>", encoding="utf-8")

    with make_app_client(tmp_path, serve_static=False) as client:
        response = client.get("/")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_missing_public_dir_does_not_break_api(tmp_path: Path) -> None:
    with make_app_client(tmp_path / "absent", serve_static=True) as client:
        assert client.get("/api/health").json() == {"ok": True}


def test_static_serving_is_disabled_on_vercel() -> None:
    assert load_settings({"VERCEL": "1"}).serve_static is False
    assert load_settings({}).serve_static is True


def test_default_api_url_matches_fetch_script() -> None:
    script = (PROJECT_ROOT / "scripts" / "fetch-dataset.sh").read_text(encoding="utf-8")

    match = re.search(r"^readonly DEFAULT_API_URL='([^']+)'$", script, re.MULTILINE)

    assert match is not None
    assert match.group(1) == DEFAULT_API_URL


def test_env_overrides_are_applied() -> None:
    settings = load_settings(
        {
            "CQA_API_URL": "https://example.test/run?sig=abc",
            "CQA_UPSTREAM_TIMEOUT_SEC": "60",
            "CQA_CACHE_TTL_SEC": "5",
        }
    )

    assert settings.api_url == "https://example.test/run?sig=abc"
    assert settings.upstream_timeout_sec == 60.0
    assert settings.cache_ttl_sec == 5.0


@pytest.mark.parametrize(
    "env",
    [
        {"CQA_API_URL": "ftp://example.test/run"},
        {"CQA_API_URL": "https://example.test/run?group_id=DEV"},
        {"CQA_UPSTREAM_TIMEOUT_SEC": "abc"},
        {"CQA_UPSTREAM_TIMEOUT_SEC": "0"},
        {"CQA_CACHE_TTL_SEC": "-1"},
    ],
)
def test_invalid_env_fails_fast(env: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        load_settings(env)


def test_entrypoint_exposes_app_and_keeps_signed_urls_out_of_logs() -> None:
    import logging

    from fastapi import FastAPI

    from app.main import app

    assert isinstance(app, FastAPI)
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
