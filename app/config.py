"""Настройки бэкенда. Всё, что зависит от окружения, читается только здесь."""

import logging
import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

logger = logging.getLogger("cqa.config")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = PROJECT_ROOT / "public"
DEFAULT_CHECKLIST_PATH = PROJECT_ROOT / "config" / "checklists" / "chat-default.json"
DEFAULT_GOLD_PATH = PROJECT_ROOT / "eval" / "gold.json"
DEFAULT_SPLIT_PATH = PROJECT_ROOT / "eval" / "split.json"

# Хранилище оценок, апелляций и версий чек-листа. MEMORY_DB — база в памяти процесса:
# значение по умолчанию для Settings() в тестах; приложение (load_settings) пишет в файл.
MEMORY_DB = ":memory:"
DEFAULT_DB_PATH = PROJECT_ROOT / ".data" / "cqa.sqlite"

# Postgres (облако): адрес — DATABASE_URL, иначе POSTGRES_URL (оба задаёт интеграция Neon
# в Vercel; это адреса через пулер). Без адреса — SQLite, как локально.
DATABASE_URL_ENV = ("DATABASE_URL", "POSTGRES_URL")
DATABASE_URL_SCHEMES = ("postgres", "postgresql")
DEFAULT_DB_SCHEMA = "public"
_DB_SCHEMA_RE = re.compile(r"[a-z_][a-z0-9_]{0,62}")

# Вход для жюри: включается, когда задан CQA_AUTH_USER.
MIN_SESSION_SECRET_CHARS = 32

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
class AuthSettings:
    """Логин и пароль жюри и секрет подписи сессий (секреты не попадают в repr и логи)."""

    user: str
    password: str = field(repr=False)
    session_secret: str = field(repr=False)


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
    database_url: str | None = field(default=None, repr=False)  # задан — хранилище Postgres
    db_schema: str = DEFAULT_DB_SCHEMA
    gold_path: Path = DEFAULT_GOLD_PATH
    split_path: Path = DEFAULT_SPLIT_PATH
    evaluation_timeout_sec: float = DEFAULT_EVALUATION_TIMEOUT_SEC
    auth: AuthSettings | None = None  # None — вход выключен (локальная разработка)
    trust_proxy_headers: bool = False  # IP клиента из X-Forwarded-For (только за прокси Vercel)


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Собирает настройки из окружения; некорректные значения — ошибка при старте."""
    source = os.environ if env is None else env
    on_vercel = bool(source.get("VERCEL"))
    database_url = _database_url(source)
    if on_vercel and database_url is None:
        logger.warning(
            "DATABASE_URL не задан: оценки пишутся во временную SQLite экземпляра функции "
            "и пропадут при его остановке. Подключите Postgres (docs/DEPLOY.md)."
        )
    return Settings(
        api_url=_api_url(source.get("CQA_API_URL")),
        upstream_timeout_sec=_positive_float(
            source, "CQA_UPSTREAM_TIMEOUT_SEC", DEFAULT_UPSTREAM_TIMEOUT_SEC
        ),
        cache_ttl_sec=_positive_float(source, "CQA_CACHE_TTL_SEC", DEFAULT_CACHE_TTL_SEC),
        # На Vercel public/ раздаёт CDN, монтировать её в приложение там нельзя.
        serve_static=not on_vercel,
        db_path=_db_path(source),
        database_url=database_url,
        db_schema=valid_db_schema((source.get("CQA_DB_SCHEMA") or "").strip() or DEFAULT_DB_SCHEMA),
        auth=_auth(source),
        # Vercel перезаписывает X-Forwarded-For сам, подделать его клиент не может.
        trust_proxy_headers=on_vercel,
    )


def valid_db_schema(name: str) -> str:
    """Имя схемы Postgres: строчная латиница, цифры и «_», до 63 символов, не pg_*."""
    if not _DB_SCHEMA_RE.fullmatch(name) or name.startswith("pg_"):
        raise ValueError(
            f"Имя схемы Postgres «{name}» не подходит: строчные латинские буквы, цифры и «_», "
            "до 63 символов, не с цифры и не pg_"
        )
    return name


def _db_path(env: Mapping[str, str]) -> str:
    """CQA_DB_PATH или `.data/cqa.sqlite`; на Vercel писать можно только во временную папку."""
    raw = (env.get("CQA_DB_PATH") or "").strip()
    if raw:
        return raw
    if env.get("VERCEL"):
        return str(Path(tempfile.gettempdir()) / "cqa.sqlite")
    return str(DEFAULT_DB_PATH)


def _database_url(env: Mapping[str, str]) -> str | None:
    """Адрес Postgres из DATABASE_URL или POSTGRES_URL; значение в ошибках не выводится."""
    for name in DATABASE_URL_ENV:
        raw = (env.get(name) or "").strip()
        if not raw:
            continue
        if urlsplit(raw).scheme not in DATABASE_URL_SCHEMES:
            raise ValueError(f"{name} должен быть адресом вида postgresql://… (значение скрыто)")
        return raw
    return None


def _auth(env: Mapping[str, str]) -> AuthSettings | None:
    """Вход включён, если задан CQA_AUTH_USER; тогда пароль и секрет сессий обязательны."""
    user = (env.get("CQA_AUTH_USER") or "").strip()
    if not user:
        return None
    password = (env.get("CQA_AUTH_PASSWORD") or "").strip()
    secret = (env.get("CQA_SESSION_SECRET") or "").strip()
    if not password:
        raise ValueError("CQA_AUTH_PASSWORD обязателен, когда задан CQA_AUTH_USER")
    if len(secret) < MIN_SESSION_SECRET_CHARS:
        raise ValueError(
            f"CQA_SESSION_SECRET: нужна случайная строка не короче {MIN_SESSION_SECRET_CHARS} "
            "символов (например, `openssl rand -hex 32`)"
        )
    return AuthSettings(user=user, password=password, session_secret=secret)


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
