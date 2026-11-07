"""Клиент API кейса: загрузка набора диалогов по group_id.

Отвечает за транспорт и конверт ответа `{error, isSuccess, data: {records}}`;
проверка отдельных записей — в app.normalize.
"""

import asyncio
import json

import httpx

from app.errors import (
    UpstreamError,
    dataset_not_found,
    upstream_invalid_response,
    upstream_timeout,
    upstream_unavailable,
)
from app.validation import is_valid_id

MAX_DATASET_BYTES = 50 * 1024 * 1024
CONNECT_TIMEOUT_SEC = 10.0
_ERROR_TEXT_LIMIT = 300


class ResponseTooLargeError(ValueError):
    pass


def build_dataset_url(api_url: str, group_id: str) -> str:
    """Добавляет group_id к базовому URL так же, как scripts/fetch-dataset.sh.

    Остальная query-строка (с подписью) не перекодируется. group_id уже
    проверен регуляркой, экранировать в нём нечего.
    """
    if not is_valid_id(group_id):
        raise ValueError("group_id должен быть проверен до запроса")
    separator = "&" if "?" in api_url else "?"
    return f"{api_url}{separator}group_id={group_id}"


async def read_capped(response: httpx.Response, limit: int) -> bytes:
    """Читает тело ответа целиком, но не больше limit байт."""
    declared = response.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise ResponseTooLargeError(f"тело ответа больше {limit} байт")
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > limit:
            raise ResponseTooLargeError(f"тело ответа больше {limit} байт")
        chunks.append(chunk)
    return b"".join(chunks)


def parse_envelope(status_code: int, body: bytes, group_id: str) -> list[object]:
    """Проверяет конверт ответа и возвращает сырой список записей."""
    payload = _decode_json(body)
    if not 200 <= status_code < 300:
        if status_code == 404 and isinstance(payload, dict) and payload.get("isSuccess") is False:
            raise dataset_not_found(group_id, detail=_error_text(payload))
        raise UpstreamError(detail=f"HTTP {status_code}: {_error_text(payload)}")
    if not isinstance(payload, dict):
        raise upstream_invalid_response(detail="ответ не JSON-объект")
    if payload.get("isSuccess") is not True:
        raise UpstreamError(
            detail=f"isSuccess={payload.get('isSuccess')!r}: {_error_text(payload)}"
        )
    data = payload.get("data")
    records = data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise upstream_invalid_response(detail="нет списка data.records")
    return records


class UpstreamClient:
    def __init__(
        self,
        *,
        api_url: str,
        timeout_sec: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._api_url = api_url
        self._timeout_sec = timeout_sec
        self._client = httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(timeout_sec, connect=min(CONNECT_TIMEOUT_SEC, timeout_sec)),
            headers={"Accept": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch_records(self, group_id: str) -> list[object]:
        status_code, body = await self._download(build_dataset_url(self._api_url, group_id))
        return parse_envelope(status_code, body, group_id)

    async def _download(self, url: str) -> tuple[int, bytes]:
        try:
            async with asyncio.timeout(self._timeout_sec):
                async with self._client.stream("GET", url) as response:
                    return response.status_code, await read_capped(response, MAX_DATASET_BYTES)
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise upstream_timeout(self._timeout_sec, detail=type(exc).__name__) from None
        except httpx.RequestError as exc:
            raise upstream_unavailable(detail=f"{type(exc).__name__}: {exc}") from None
        except ResponseTooLargeError as exc:
            raise upstream_invalid_response(detail=str(exc)) from None


_NOT_JSON = object()


def _decode_json(body: bytes) -> object:
    try:
        return json.loads(body)
    except (ValueError, RecursionError):
        return _NOT_JSON


def _error_text(payload: object) -> str:
    error = payload.get("error") if isinstance(payload, dict) else None
    return error[:_ERROR_TEXT_LIMIT] if isinstance(error, str) else "<нет текста ошибки>"
