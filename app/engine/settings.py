"""Настройки движка из окружения и файла .env (секреты никогда не логируются).

Переменные окружения процесса важнее .env. Файл .env перечитывается при
изменении (по mtime): ключ, добавленный во время работы сервера, подхватится
без перезапуска.
"""

import os
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = PROJECT_ROOT / ".env"

DEFAULT_EVAL_TIMEOUT_SEC = 90.0
MAX_EVAL_TIMEOUT_SEC = 90.0
DEFAULT_PARALLEL_EVALUATIONS = 2  # одновременных оценок; остальные ждут в очереди
DEFAULT_CLAUDE_EFFORT = "medium"
DEFAULT_RESERVE_MODELS = (
    "@cf/deepseek-ai/deepseek-v4-pro-0813",
    "@cf/moonshotai/kimi-k2.7-code",
    "@cf/qwen/qwen3.8-27b",
)
CLAUDE_EFFORTS = ("low", "medium", "high", "xhigh", "max")

_lock = threading.Lock()
_cache: dict[str, object] = {"mtime": None, "values": {}}


@dataclass(frozen=True, slots=True)
class EngineSettings:
    models: tuple[str, ...]  # из CQA_MODELS; пусто — выбор по доступности
    eval_timeout_sec: float
    parallel_evaluations: int
    early_stop: bool  # не ждать медленную модель, когда большинство уже согласно
    reserve_models: tuple[str, ...]  # замена модели, не ответившей по критерию (по порядку)
    claude_effort: str
    ollama_models: tuple[str, ...]
    ollama_host: str


def env_value(name: str, environ: Mapping[str, str] | None = None) -> str | None:
    """Значение переменной: окружение процесса, затем .env; пустая строка — None."""
    source = os.environ if environ is None else environ
    value = source.get(name)
    if value is None or value.strip() == "":
        value = _dotenv().get(name) if environ is None else None
    if value is None:
        return None
    value = value.strip()
    return value or None


def load_engine_settings(environ: Mapping[str, str] | None = None) -> EngineSettings:
    return EngineSettings(
        models=_csv(env_value("CQA_MODELS", environ)),
        eval_timeout_sec=min(
            _positive_float(env_value("CQA_EVAL_TIMEOUT_SEC", environ), DEFAULT_EVAL_TIMEOUT_SEC),
            MAX_EVAL_TIMEOUT_SEC,
        ),
        parallel_evaluations=int(
            _positive_float(
                env_value("CQA_PARALLEL_EVALUATIONS", environ), DEFAULT_PARALLEL_EVALUATIONS
            )
        ),
        early_stop=(env_value("CQA_EARLY_STOP", environ) or "1").lower()
        not in ("0", "false", "no"),
        reserve_models=_csv(env_value("CQA_RESERVE_MODELS", environ)) or DEFAULT_RESERVE_MODELS,
        claude_effort=_choice(
            env_value("CQA_CLAUDE_EFFORT", environ), CLAUDE_EFFORTS, DEFAULT_CLAUDE_EFFORT
        ),
        ollama_models=_csv(env_value("CQA_OLLAMA_MODELS", environ)),
        ollama_host=env_value("OLLAMA_HOST", environ) or "http://localhost:11434",
    )


def _dotenv() -> dict[str, str]:
    try:
        mtime = ENV_FILE.stat().st_mtime
    except OSError:
        return {}
    with _lock:
        if _cache["mtime"] != mtime:
            _cache["values"] = _parse_dotenv(ENV_FILE)
            _cache["mtime"] = mtime
        return dict(_cache["values"])  # type: ignore[arg-type]


def _parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _csv(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(item.strip() for item in value.split(",") if item.strip())


def _positive_float(value: str | None, default: float) -> float:
    if value is None:
        return default
    try:
        number = float(value)
    except ValueError:
        return default
    return number if number > 0 else default


def _choice(value: str | None, options: tuple[str, ...], default: str) -> str:
    return value if value in options else default
