import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.config import DEFAULT_CHECKLIST_PATH
from tests.conftest import ClientFactory
from tests.support import UPSTREAM_HOST, RecordingUpstream

LIST_URL = "/api/datasets/DEV/conversations"


def assert_error(response: Any, status_code: int, code: str) -> None:
    assert response.status_code == status_code
    body = response.json()
    assert body["error"]["code"] == code
    assert body["error"]["message"]
    # Клиенту не уходят адрес источника и подписи.
    assert "sig" not in response.text
    assert "powerplatform" not in response.text


def test_health(make_client: ClientFactory, upstream_payload: dict[str, Any]) -> None:
    client = make_client(RecordingUpstream(upstream_payload))

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_list_returns_items_in_source_order(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    client = make_client(RecordingUpstream(upstream_payload))

    response = client.get(LIST_URL)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert body["group_id"] == "DEV"
    assert body["total"] == 3
    assert body["fetched_at"].endswith("Z")
    assert [item["conversation_id"] for item in body["items"]] == [
        "p1-ru-001",
        "p1-kz-001",
        "test-call-001",
    ]


def test_upstream_url_keeps_signature_encoding_and_appends_group_id(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    upstream = RecordingUpstream(upstream_payload)
    client = make_client(upstream)

    client.get(LIST_URL)

    url = str(upstream.requests[0].url)
    assert upstream.requests[0].url.host == UPSTREAM_HOST
    assert "sp=%2Ftriggers%2Fmanual%2Frun" in url
    assert url.endswith("&group_id=DEV")


def test_list_is_cached_until_refresh(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    upstream = RecordingUpstream(upstream_payload)
    client = make_client(upstream)

    client.get(LIST_URL)
    client.get(LIST_URL)
    client.get("/api/datasets/DEV/conversations/p1-ru-001")
    calls_before_refresh = len(upstream.requests)
    client.get(f"{LIST_URL}?refresh=1")

    assert calls_before_refresh == 1
    assert len(upstream.requests) == 2


def test_chat_detail_matches_contract(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    client = make_client(RecordingUpstream(upstream_payload))

    body = client.get("/api/datasets/DEV/conversations/p1-ru-001").json()

    assert set(body) == {"conversation_id", "channel", "language", "audio", "messages"}
    assert body["channel"] == "chat"
    assert body["audio"] is None
    assert body["messages"][0] == {
        "index": 0,
        "timestamp": "00:00",
        "offset_sec": 0.0,
        "speaker": "client",
        "text": "Где посмотреть мой тариф? В приложении не нахожу.",
    }
    assert body["messages"][-1]["offset_sec"] == 124.0


def test_call_detail_points_audio_to_backend_proxy(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    client = make_client(RecordingUpstream(upstream_payload))

    response = client.get("/api/datasets/DEV/conversations/test-call-001")

    body = response.json()
    assert body["channel"] == "call"
    assert body["audio"] == {"url": "/api/datasets/DEV/conversations/test-call-001/audio"}
    assert body["messages"][1]["offset_sec"] == 0.084
    assert "sig=" not in response.text


@pytest.mark.parametrize(
    ("path", "code"),
    [
        ("/api/datasets/DEV!/conversations", "invalid_group_id"),
        (f"/api/datasets/{'x' * 65}/conversations", "invalid_group_id"),
        ("/api/datasets/DE%20V/conversations", "invalid_group_id"),
        ("/api/datasets/DEV/conversations/p1.ru.001", "invalid_conversation_id"),
        (
            "/api/datasets/DEV/conversations/%D0%B4%D0%B8%D0%B0%D0%BB%D0%BE%D0%B3",
            "invalid_conversation_id",
        ),
        ("/api/datasets/DEV/conversations/bad%0A/audio", "invalid_conversation_id"),
    ],
)
def test_invalid_ids_give_400_without_upstream_call(
    make_client: ClientFactory, upstream_payload: dict[str, Any], path: str, code: str
) -> None:
    upstream = RecordingUpstream(upstream_payload)
    client = make_client(upstream)

    response = client.get(path)

    assert_error(response, 400, code)
    assert upstream.requests == []


def test_unknown_conversation_gives_404(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    client = make_client(RecordingUpstream(upstream_payload))

    response = client.get("/api/datasets/DEV/conversations/p9-xx-999")

    assert_error(response, 404, "conversation_not_found")


def _raise(exc_type: type[Exception]) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exc_type("boom", request=request)

    return handler


@pytest.mark.parametrize(
    ("handler", "status_code", "code"),
    [
        (
            lambda r: httpx.Response(200, json={"error": "сбой", "isSuccess": False, "data": None}),
            502,
            "upstream_error",
        ),
        (
            lambda r: httpx.Response(
                404, json={"error": "не найдено", "isSuccess": False, "data": None}
            ),
            502,
            "dataset_not_found",
        ),
        (lambda r: httpx.Response(500, text="<html>Internal error</html>"), 502, "upstream_error"),
        (lambda r: httpx.Response(200, text="{not json"), 502, "upstream_invalid_response"),
        (lambda r: httpx.Response(200, json=[1, 2, 3]), 502, "upstream_invalid_response"),
        (
            lambda r: httpx.Response(200, json={"isSuccess": True, "data": {"records": "x"}}),
            502,
            "upstream_invalid_response",
        ),
        (_raise(httpx.ReadTimeout), 504, "upstream_timeout"),
        (_raise(httpx.ConnectError), 502, "upstream_unavailable"),
    ],
)
def test_upstream_failures_map_to_contract_errors(
    make_client: ClientFactory, handler: Any, status_code: int, code: str
) -> None:
    client = make_client(handler)

    response = client.get(LIST_URL)

    assert_error(response, status_code, code)


def test_slow_upstream_hits_overall_deadline(make_client: ClientFactory) -> None:
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    client = make_client(slow, upstream_timeout_sec=0.05)

    response = client.get(LIST_URL)

    assert_error(response, 504, "upstream_timeout")
    assert "0.05" in response.json()["error"]["message"]


def test_failed_fetch_is_not_cached(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    responses = iter([httpx.Response(500, text="down"), httpx.Response(200, json=upstream_payload)])
    client = make_client(lambda request: next(responses))

    first = client.get(LIST_URL)
    second = client.get(LIST_URL)

    assert first.status_code == 502
    assert second.status_code == 200


def test_broken_records_are_skipped_and_logged(
    make_client: ClientFactory, upstream_payload: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    records = upstream_payload["data"]["records"]
    payload = {
        **upstream_payload,
        "data": {**upstream_payload["data"], "records": [*records, {"conversation_id": "x"}]},
    }
    client = make_client(RecordingUpstream(payload))

    with caplog.at_level("WARNING", logger="cqa.datasets"):
        body = client.get(LIST_URL).json()

    assert body["total"] == 3
    assert "пропущена запись #3" in caplog.text


def test_default_checklist_is_seeded_from_config_as_version_one(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    client = make_client(RecordingUpstream(upstream_payload))

    response = client.get("/api/checklists/default")

    assert response.status_code == 200
    body = response.json()
    source = json.loads(DEFAULT_CHECKLIST_PATH.read_text(encoding="utf-8"))
    assert body["version"] == 1
    assert {k: v for k, v in body.items() if k != "version"} == {
        k: v for k, v in source.items() if k != "version"
    }


def test_missing_checklist_gives_500_error_shape(
    make_client: ClientFactory, upstream_payload: dict[str, Any], tmp_path: Path
) -> None:
    client = make_client(
        RecordingUpstream(upstream_payload), checklist_path=tmp_path / "missing.json"
    )

    response = client.get("/api/checklists/default")

    assert_error(response, 500, "checklist_unavailable")
    assert str(tmp_path) not in response.text


def test_invalid_query_parameter_gives_400(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    client = make_client(RecordingUpstream(upstream_payload))

    response = client.get(f"{LIST_URL}?refresh=maybe")

    assert_error(response, 400, "invalid_request")


def test_unknown_route_and_wrong_method_use_error_shape(
    make_client: ClientFactory, upstream_payload: dict[str, Any]
) -> None:
    client = make_client(RecordingUpstream(upstream_payload))

    assert_error(client.get("/api/unknown"), 404, "not_found")
    assert_error(client.post("/api/health"), 405, "method_not_allowed")
