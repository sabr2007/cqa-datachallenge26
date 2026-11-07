import re
from typing import Any

import httpx
import pytest

from app.audio import extract_audio_source, is_allowed_host, parse_range
from tests.conftest import ClientFactory
from tests.support import UPSTREAM_HOST, load_payload

AUDIO_URL = "/api/datasets/DEV/conversations/test-call-001/audio"
PAGE_HOST = "audio.example.powerplatform.com"  # совпадает с audio_url в фикстуре
MEDIA_HOST = "org.crm11.dynamics.com"
AUDIO_BYTES = bytes(range(256)) * 40  # 10240 байт «mp3»
_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def player_page(sig: str) -> str:
    link = f"https://{MEDIA_HOST}/api/filedownload/abc?sp=r&amp;sig={sig}&amp;rsct=audio%2Fmpeg"
    return (
        "<!DOCTYPE html><html><body><audio id='a' controls>"
        f'<source src="{link}" type="audio/mpeg"></audio></body></html>'
    )


class FakeAudioSource:
    """API кейса + страница плеера + файловое хранилище с поддержкой Range."""

    def __init__(self, page_html: str | None = None) -> None:
        self.page_html = page_html
        self.page_calls = 0
        self.media_requests: list[httpx.Request] = []
        self.expired_signatures: set[str] = set()
        self.hosts: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.hosts.append(request.url.host)
        if request.url.host == UPSTREAM_HOST:
            return httpx.Response(200, json=load_payload())
        if request.url.host == PAGE_HOST:
            self.page_calls += 1
            html = self.page_html or player_page(f"SIG-{self.page_calls}")
            return httpx.Response(
                200, text=html, headers={"content-type": "text/html; charset=utf-8"}
            )
        if request.url.host == MEDIA_HOST:
            return self._media(request)
        raise AssertionError(f"неожиданный хост {request.url.host}")

    def _media(self, request: httpx.Request) -> httpx.Response:
        self.media_requests.append(request)
        if request.url.params.get("sig") in self.expired_signatures:
            return httpx.Response(
                400, json={"Message": "SAS url has either expired or is invalid."}
            )
        return serve_range(request, AUDIO_BYTES)


def serve_range(request: httpx.Request, data: bytes) -> httpx.Response:
    match = _RANGE_RE.fullmatch(request.headers.get("range", ""))
    if match is None:
        return media_response(200, data, {})
    start, end = match.groups()
    first = int(start) if start else len(data) - int(end)
    last = int(end) if start and end else len(data) - 1
    return media_response(
        206, data[first : last + 1], {"content-range": f"bytes {first}-{last}/{len(data)}"}
    )


def media_response(status_code: int, body: bytes, headers: dict[str, str]) -> httpx.Response:
    # stream=, а не content=: иначе httpx сразу вычитывает тело, как не бывает в сети.
    return httpx.Response(
        status_code,
        stream=httpx.ByteStream(body),
        headers={"content-type": "audio/mpeg", "content-length": str(len(body)), **headers},
    )


@pytest.fixture
def source() -> FakeAudioSource:
    return FakeAudioSource()


def test_range_request_is_streamed_from_player_page_link(
    make_client: ClientFactory, source: FakeAudioSource
) -> None:
    client = make_client(source)

    response = client.get(AUDIO_URL, headers={"Range": "bytes=0-99"})

    assert response.status_code == 206
    assert response.content == AUDIO_BYTES[:100]
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["content-range"] == "bytes 0-99/10240"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["cache-control"] == "private, no-store"
    media_request = source.media_requests[0]
    assert media_request.headers["range"] == "bytes=0-99"
    assert media_request.url.params["sig"] == "SIG-1"  # &amp; со страницы раскодирован
    assert "SIG-1" not in response.text and "sig" not in str(response.headers).lower()


def test_request_without_range_gets_whole_file(
    make_client: ClientFactory, source: FakeAudioSource
) -> None:
    client = make_client(source)

    response = client.get(AUDIO_URL)

    assert response.status_code == 200
    assert response.content == AUDIO_BYTES
    assert response.headers["accept-ranges"] == "bytes"


def test_malformed_range_is_not_forwarded(
    make_client: ClientFactory, source: FakeAudioSource
) -> None:
    client = make_client(source)

    response = client.get(AUDIO_URL, headers={"Range": "bytes=0-1,5-9"})

    assert response.status_code == 200
    assert "range" not in source.media_requests[0].headers


def test_media_link_is_cached_between_requests(
    make_client: ClientFactory, source: FakeAudioSource
) -> None:
    client = make_client(source)

    client.get(AUDIO_URL, headers={"Range": "bytes=0-9"})
    client.get(AUDIO_URL, headers={"Range": "bytes=10-19"})

    assert source.page_calls == 1
    assert len(source.media_requests) == 2


def test_expired_link_is_refreshed_once(
    make_client: ClientFactory, source: FakeAudioSource
) -> None:
    client = make_client(source)
    client.get(AUDIO_URL, headers={"Range": "bytes=0-9"})
    source.expired_signatures.add("SIG-1")

    response = client.get(AUDIO_URL, headers={"Range": "bytes=10-19"})

    assert response.status_code == 206
    assert response.content == AUDIO_BYTES[10:20]
    assert source.page_calls == 2
    assert source.media_requests[-1].url.params["sig"] == "SIG-2"


def test_chat_without_audio_gives_404(make_client: ClientFactory, source: FakeAudioSource) -> None:
    client = make_client(source)

    response = client.get("/api/datasets/DEV/conversations/p1-ru-001/audio")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "audio_not_found"


@pytest.mark.parametrize(
    "page_html",
    [
        "<html><body>Запись удалена</body></html>",
        "<audio controls></audio><source src='https://org.crm11.dynamics.com/x.mp3'>",
        '<audio><source src="https://evil.example.com/a.mp3"></audio>',
        '<audio src="http://org.crm11.dynamics.com/plain-http.mp3"></audio>',
    ],
)
def test_unusable_player_page_gives_502(make_client: ClientFactory, page_html: str) -> None:
    source = FakeAudioSource(page_html=page_html)
    client = make_client(source)

    response = client.get(AUDIO_URL)

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "audio_unavailable"
    assert "evil.example.com" not in source.hosts
    assert "sig" not in response.text


def test_redirect_to_foreign_host_is_blocked(make_client: ClientFactory) -> None:
    hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        if request.url.host == UPSTREAM_HOST:
            return httpx.Response(200, json=load_payload())
        return httpx.Response(302, headers={"location": "https://169.254.169.254/latest/meta-data"})

    client = make_client(handler)

    response = client.get(AUDIO_URL)

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "audio_unavailable"
    assert "169.254.169.254" not in hosts


def test_direct_audio_link_is_streamed_as_is(make_client: ClientFactory) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == UPSTREAM_HOST:
            return httpx.Response(200, json=load_payload())
        return serve_range(request, AUDIO_BYTES)

    client = make_client(handler)

    response = client.get(AUDIO_URL, headers={"Range": "bytes=-16"})

    assert response.status_code == 206
    assert response.content == AUDIO_BYTES[-16:]


def test_media_timeout_gives_504(make_client: ClientFactory, source: FakeAudioSource) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == MEDIA_HOST:
            raise httpx.ReadTimeout("timed out", request=request)
        return source(request)

    client = make_client(handler)

    response = client.get(AUDIO_URL)

    assert response.status_code == 504
    assert response.json()["error"]["code"] == "upstream_timeout"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("bytes=0-", "bytes=0-"),
        ("bytes=0-99", "bytes=0-99"),
        ("bytes=-500", "bytes=-500"),
        (" bytes=1-2 ", "bytes=1-2"),
        ("bytes=0-1,5-6", None),
        ("items=0-1", None),
        ("bytes=", None),
        (None, None),
    ],
)
def test_parse_range(raw: str | None, expected: str | None) -> None:
    assert parse_range(raw) == expected


def test_extract_audio_source_prefers_audio_element() -> None:
    html = "<source src='outside.mp3'><audio controls><source src='a.mp3?x=1&amp;y=2'></audio>"

    assert extract_audio_source(html) == "a.mp3?x=1&y=2"
    assert extract_audio_source("<audio src='direct.mp3'></audio>") == "direct.mp3"
    assert extract_audio_source("<p>нет плеера</p>") is None


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://org.crm11.dynamics.com/api/filedownload/x", True),
        ("https://x.environment.api.powerplatform.com/a", True),
        ("https://dynamics.com.evil.example/a", False),
        ("https://evildynamics.com/a", False),
        ("http://org.crm11.dynamics.com/a", False),
        ("https://169.254.169.254/latest", False),
    ],
)
def test_is_allowed_host(url: str, allowed: bool) -> None:
    assert is_allowed_host(url, ("powerplatform.com", "dynamics.com")) is allowed


def test_audio_response_has_no_signature_in_any_header(
    make_client: ClientFactory, source: FakeAudioSource
) -> None:
    client = make_client(source)

    response = client.get(AUDIO_URL, headers={"Range": "bytes=0-0"})

    headers: dict[str, Any] = dict(response.headers)
    assert all("sig=" not in value for value in headers.values())
