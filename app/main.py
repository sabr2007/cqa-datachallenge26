"""Точка входа: `uv run uvicorn app.main:app` локально, `app` из этого файла — на Vercel."""

import logging
import os

from app.factory import create_app

logging.basicConfig(
    level=os.environ.get("CQA_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# httpx на INFO печатает полный URL запроса, а в нём подписи (sig=…) — не пускаем в лог.
# Пул psycopg на INFO пишет строку на каждую выдачу соединения — тоже лишнее.
for noisy_logger in ("httpx", "httpcore", "psycopg.pool"):
    logging.getLogger(noisy_logger).setLevel(logging.WARNING)

app = create_app()
