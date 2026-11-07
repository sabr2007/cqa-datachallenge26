"""Настройки бэкенда. Всё, что зависит от окружения, читается только здесь."""

import os
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = PROJECT_ROOT / "public"
DEFAULT_CHECKLIST_PATH = PROJECT_ROOT / "config" / "checklists" / "chat-default.json"
DEFAULT_GOLD_PATH = PROJECT_ROOT / "eval" / "gold.json"
DEFAULT_SPLIT_PATH = PROJECT_ROOT / "eval" / "split.json"

# Хранилище оценок, апелляций и версий чек-листа. MEMORY_DB — база в памяти процесса:
# значение по умолчанию для Settings() в тестах; приложение (load_settings) пишет в файл.
MEMORY_DB = ":memory:"
DEFAULT_DB_PATH = PROJECT_ROOT / ".data" / "cqa.sqlite"

# Движок укладывается в 90 с на диалог, но при пакетной оценке ждёт своей очереди
# (CQA_PARALLEL_EVALUATIONS); фронтенд рассчитан на 150 с (api.js) — держим то же значение.
DEFAULT_EVALUATION_TIMEOUT_SEC = 150.0

# Базовый URL API кейса без group_id. Спонсор разрешил хранить его в репозитории;
# тот же адрес использует scripts/fetch-dataset.sh (совпадение проверяет тест).
DEFAULT_API_URL = (
    "https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com"
    "/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00"
    "/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0"
    "&sig=5Sog2MThgCRTlk3HObv70LRmRk6u7IOwzlwMpe804qo"
)

DEFAULT_UPSTREAM_TIMEOUT_SEC = 90.0  # API кейса бывает медленным
DEFAULT_CACHE_TTL_SEC = 600.0
DEFAULT_AUDIO_TIMEOUT_SEC = 30.0  # до первого байта записи, включая разбор страницы плеера
DEFAULT_AUDIO_URL_TTL_SEC = 1800.0  # подписанная ссылка на файл живёт около часа

# Куда бэкенду можно ходить за аудио (защита от SSRF через audio_url из данных).
AUDIO_HOST_SUFFIXES = ("powerplatform.com", "dynamics.com")


@dataclass(frozen=True, slots=True)
class Settings:
    api_url: str = DEFAULT_API_URL
    upstream_timeout_sec: float = DEFAULT_UPSTREAM_TIMEOUT_SEC
    cache_ttl_sec: float = DEFAULT_CACHE_TTL_SEC
    audio_timeout_sec: float = DEFAULT_AUDIO_TIMEOUT_SEC
    audio_url_ttl_sec: float = DEFAULT_AUDIO_URL_TTL_SEC
    audio_host_suffixes: tuple[str, ...] = AUDIO_HOST_SUFFIXES
    public_dir: Path = PUBLIC_DIR
    checklist_path: Path = DEFAULT_CHECKLIST_PATH
    serve_static: bool = True
    db_path: str = MEMORY_DB
    gold_path: Path = DEFAULT_GOLD_PATH
    split_path: Path = DEFAULT_SPLIT_PATH
    evaluation_timeout_sec: float = DEFAULT_EVALUATION_TIMEOUT_SEC


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Собирает настройки из окружения; некорректные значения — ошибка при старте."""
    source = os.environ if env is None else env
    return Settings(
        api_url=_api_url(source.get("CQA_API_URL")),
        upstream_timeout_sec=_positive_float(
            source, "CQA_UPSTREAM_TIMEOUT_SEC", DEFAULT_UPSTREAM_TIMEOUT_SEC
        ),
        cache_ttl_sec=_positive_float(source, "CQA_CACHE_TTL_SEC", DEFAULT_CACHE_TTL_SEC),
        # На Vercel public/ раздаёт CDN, монтировать её в приложение там нельзя.
        serve_static=not source.get("VERCEL"),
        db_path=_db_path(source),
    )


def _db_path(env: Mapping[str, str]) -> str:
    """CQA_DB_PATH или `.data/cqa.sqlite`; на Vercel писать можно только во временную папку."""
    raw = (env.get("CQA_DB_PATH") or "").strip()
    if raw:
        return raw
    if env.get("VERCEL"):
        return str(Path(tempfile.gettempdir()) / "cqa.sqlite")
    return str(DEFAULT_DB_PATH)


def _api_url(value: str | None) -> str:
    if not value:
        return DEFAULT_API_URL
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("CQA_API_URL должен быть абсолютным http(s) URL")
    if "group_id" in parse_qs(parts.query):
        raise ValueError("CQA_API_URL задаётся без параметра group_id")
    return value


def _positive_float(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name} должно быть числом, получено {raw!r}") from None
    if value <= 0:
        raise ValueError(f"{name} должно быть больше нуля, получено {raw!r}")
    return value
