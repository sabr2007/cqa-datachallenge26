"""Прокси аудиозаписей звонков.

`audio_url` из API кейса ведёт не на файл, а на HTML-страницу плеера (text/html)
с `<audio><source src="https://…dynamics.com/api/filedownload/…?<SAS>" type="audio/mpeg">`.
Подпись в ссылке на файл живёт около часа; файл отдаётся с Range (206), HEAD — 405.
Поэтому бэкенд сам достаёт ссылку со страницы, кеширует её и стримит файл
браузеру, пробрасывая Range: работает перемотка, а подписанная ссылка не уходит клиенту.
"""

import asyncio
import re
import time
from collections.abc import AsyncIterator, Callable
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import httpx

from app.errors import audio_unavailable, upstream_timeout
from app.upstream import ResponseTooLargeError, read_capped

MAX_PAGE_BYTES = 512 * 1024
MAX_REDIRECTS = 3
CONNECT_TIMEOUT_SEC = 10.0
_RANGE_RE = re.compile(r"bytes=(\d+-\d*|-\d+)")
_MEDIA_TYPES = ("audio/", "video/", "application/octet-stream")
_PASSTHROUGH_HEADERS = (
    "content-type",
    "content-length",
    "content-range",
    "content-encoding",
    "last-modified",
    "etag",
)


def parse_range(value: str | None) -> str | None:
    """Пропускаем только одиночный диапазон `bytes=a-b`; иначе отдаём файл целиком."""
    if value is None:
        return None
    candidate = value.strip()
    return candidate if _RANGE_RE.fullmatch(candidate) else None


def is_allowed_host(url: str, suffixes: tuple[str, ...]) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and any(
        host == suffix or host.endswith("." + suffix) for suffix in suffixes
    )


def extract_audio_source(html: str) -> str | None:
    """src первого `<audio src>` или `<source src>` внутри `<audio>`."""
    parser = _AudioSourceParser()
    parser.feed(html)
    parser.close()
    return parser.src


class _AudioSourceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.src: str | None = None
        self._inside_audio = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.src is not None:
            return
        src = dict(attrs).get("src") or None
        if tag == "audio":
            self._inside_audio = True
            self.src = src
        elif tag == "source" and self._inside_audio:
            self.src = src

    def handle_endtag(self, tag: str) -> None:
        if tag == "audio":
            self._inside_audio = False


def media_headers(response: httpx.Response) -> dict[str, str]:
    passthrough = {
        name: response.headers[name] for name in _PASSTHROUGH_HEADERS if name in response.headers
    }
    return {**passthrough, "accept-ranges": "bytes", "cache-control": "private, no-store"}


async def iterate_and_close(response: httpx.Response) -> AsyncIterator[bytes]:
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        await response.aclose()


def _is_media(response: httpx.Response) -> bool:
    content_type = response.headers.get("content-type", "").lower()
    return response.status_code in (200, 206) and content_type.startswith(_MEDIA_TYPES)


class AudioProxy:
    def __init__(
        self,
        *,
        timeout_sec: float,
        link_ttl_sec: float,
        host_suffixes: tuple[str, ...],
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._timeout_sec = timeout_sec
        self._link_ttl_sec = link_ttl_sec
        self._host_suffixes = host_suffixes
        self._clock = clock
        self._links: dict[str, tuple[str, float]] = {}  # страница плеера -> (ссылка, годна до)
        self._client = httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(timeout_sec, connect=min(CONNECT_TIMEOUT_SEC, timeout_sec)),
            follow_redirects=True,
            max_redirects=MAX_REDIRECTS,
            event_hooks={"request": [self._guard_host]},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def open(self, source_url: str, range_header: str | None) -> httpx.Response:
        """Открывает поток файла записи (200/206). Тело читает и закрывает вызывающий код."""
        try:
            async with asyncio.timeout(self._timeout_sec):
                return await self._open(source_url, range_header)
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise upstream_timeout(
                self._timeout_sec, detail=f"аудио: {type(exc).__name__}"
            ) from None
        except httpx.RequestError as exc:
            raise audio_unavailable(detail=f"{type(exc).__name__}: {exc}") from None

    async def _open(self, source_url: str, range_header: str | None) -> httpx.Response:
        link, from_cache = await self._media_link(source_url, force=False)
        response = await self._fetch_media(link, range_header)
        if not _is_media(response) and from_cache:
            # Скорее всего истекла подпись: берём свежую ссылку со страницы плеера.
            await response.aclose()
            link, _ = await self._media_link(source_url, force=True)
            response = await self._fetch_media(link, range_header)
        if _is_media(response):
            return response
        await response.aclose()
        content_type = response.headers.get("content-type", "")
        raise audio_unavailable(
            detail=f"файл записи: HTTP {response.status_code}, content-type {content_type!r}"
        )

    async def _media_link(self, source_url: str, *, force: bool) -> tuple[str, bool]:
        now = self._clock()
        cached = self._links.get(source_url)
        if cached and not force and cached[1] > now:
            return cached[0], True
        link = await self._resolve(source_url)
        alive = {key: value for key, value in self._links.items() if value[1] > now}
        self._links = {**alive, source_url: (link, now + self._link_ttl_sec)}
        return link, False

    async def _resolve(self, source_url: str) -> str:
        """Достаёт ссылку на файл со страницы плеера (или берёт саму ссылку, если это аудио)."""
        headers = {"Accept": "text/html, audio/*;q=0.9, */*;q=0.5"}
        async with self._client.stream("GET", source_url, headers=headers) as response:
            content_type = response.headers.get("content-type", "").lower()
            page_url = str(response.url)
            if response.status_code != 200:
                raise audio_unavailable(detail=f"страница записи: HTTP {response.status_code}")
            if content_type.startswith(_MEDIA_TYPES):
                return page_url
            if "html" not in content_type:
                raise audio_unavailable(detail=f"страница записи: content-type {content_type!r}")
            try:
                body = await read_capped(response, MAX_PAGE_BYTES)
            except ResponseTooLargeError as exc:
                raise audio_unavailable(detail=f"страница записи: {exc}") from None
            page = body.decode(response.encoding or "utf-8", errors="replace")
        src = extract_audio_source(page)
        if not src:
            raise audio_unavailable(detail="на странице записи нет <audio>/<source>")
        link = urljoin(page_url, src)
        if not is_allowed_host(link, self._host_suffixes):
            host = urlsplit(link).hostname
            raise audio_unavailable(detail=f"ссылка на запись ведёт на хост {host!r} вне списка")
        return link

    async def _fetch_media(self, link: str, range_header: str | None) -> httpx.Response:
        headers = {"Accept-Encoding": "identity"}
        if range_header:
            headers = {**headers, "Range": range_header}
        request = self._client.build_request("GET", link, headers=headers)
        return await self._client.send(request, stream=True)

    async def _guard_host(self, request: httpx.Request) -> None:
        # Срабатывает на каждый запрос, включая шаги редиректа.
        if not is_allowed_host(str(request.url), self._host_suffixes):
            raise audio_unavailable(detail=f"запрос к хосту {request.url.host!r} вне списка")
