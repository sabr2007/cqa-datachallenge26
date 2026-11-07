# Деплой на Vercel

Приложение — один проект Vercel `cqa-datachallenge26`:

- `public/` (интерфейс, стенд Dynamics `d365/`, страница входа `login.html`) раздаёт CDN;
- всё остальное, то есть `/api/*`, обрабатывает одна Python-функция из `app/main.py` (zero-config FastAPI, `[tool.vercel]` в `pyproject.toml`);
- данные хранятся в Postgres (Neon, подключён через Vercel Marketplace). Без `DATABASE_URL` приложение пишет в SQLite, как локально, а на Vercel такие данные пропадают вместе с экземпляром функции.

`vercel.json` задаёт два параметра функции: `maxDuration: 300` (оценка синхронная, до 150 с, плюс загрузка набора на холодном старте) и `excludeFiles`, чтобы в функцию не попали `.data/`, `data/`, `.env*`, тесты и документы, даже при `vercel build` из рабочей копии. `fluid: true` даёт лимит в 300 с на любом тарифе, включая Hobby.

## Переменные окружения

Значения в репозиторий не попадают. Задавайте их в Vercel → Project → Settings → Environment Variables или через `vercel env add <ИМЯ> production`.

| Переменная | Нужна | Откуда | Что делает |
|---|---|---|---|
| `DATABASE_URL` | да | интеграция Neon (уже есть) | Postgres через пулер; с ней хранилище — Postgres |
| `POSTGRES_URL` | — | интеграция Neon | запасной адрес, если нет `DATABASE_URL` |
| `CQA_AUTH_USER` | да | придумать | логин жюри; задан — вход включён |
| `CQA_AUTH_PASSWORD` | да | придумать | пароль жюри (публикуется в README) |
| `CQA_SESSION_SECRET` | да | `openssl rand -hex 32` | ключ подписи cookie-сессии, не короче 32 символов, не публикуется |
| `ANTHROPIC_API_KEY` | да* | `.env` | Claude; без него ансамбль из открытых моделей |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | да* | `.env` | Workers AI (GLM, Qwen, DeepSeek, Kimi) |
| `CQA_DB_SCHEMA` | нет | — | схема Postgres, по умолчанию `public` |
| `CQA_MODELS`, `CQA_RESERVE_MODELS`, `CQA_EARLY_STOP`, `CQA_PARALLEL_EVALUATIONS`, `CQA_EVAL_TIMEOUT_SEC`, `CQA_CLAUDE_EFFORT` | нет | — | настройки движка, см. README → «Запуск» |
| `CQA_API_URL`, `CQA_UPSTREAM_TIMEOUT_SEC`, `CQA_CACHE_TTL_SEC` | нет | — | API кейса: адрес, таймаут, кеш |
| `CQA_LOG_LEVEL` | нет | — | уровень логов, по умолчанию `INFO` |

\* Нужен хотя бы один провайдер, иначе оценка вернёт 503. Ключи движок читает из окружения процесса: на Vercel файла `.env` нет, и он не загружается.

`VERCEL` Vercel выставляет сам. С ней приложение не монтирует `public/` (статику отдаёт CDN) и берёт IP клиента для лимита попыток входа из `X-Forwarded-For`.

`CQA_DB_PATH`, `OLLAMA_HOST` и `CQA_OLLAMA_MODELS` нужны только для локального запуска.

Если интеграция Neon выдала `DATABASE_URL` и для Preview, превью-деплои пишут в ту же базу. Чтобы демо-данные оставались чистыми, задайте для Preview `CQA_DB_SCHEMA=cqa_preview` (схема создаётся сама).

## Шаги

1. **Данные уже в Neon.** В схеме `public` лежат 1 версия чек-листа, 60 оценок чатов DEV и 0 апелляций, перенесённые из `.data/cqa.sqlite`. Если локально появились новые оценки, повторите перенос (идемпотентно: добавляются только новые строки, существующие не перезаписываются):
   ```bash
   vercel env pull .env.local        # если .env.local устарел
   uv run --env-file .env.local python scripts/migrate_sqlite_to_postgres.py --dry-run
   uv run --env-file .env.local python scripts/migrate_sqlite_to_postgres.py
   ```
2. **Переменные.** Проверьте, что `DATABASE_URL` есть в Production: `vercel env ls`. Добавьте `CQA_AUTH_USER`, `CQA_AUTH_PASSWORD`, `CQA_SESSION_SECRET` и ключи моделей для Production (и Preview, если нужны превью):
   ```bash
   vercel env add CQA_AUTH_USER production
   vercel env add CQA_AUTH_PASSWORD production
   openssl rand -hex 32 | vercel env add CQA_SESSION_SECRET production
   vercel env add ANTHROPIC_API_KEY production
   vercel env add CLOUDFLARE_ACCOUNT_ID production
   vercel env add CLOUDFLARE_API_TOKEN production
   ```
   Пробелы и перевод строки по краям значений приложение отбрасывает. Если задан только `CQA_AUTH_USER`, без пароля или с коротким секретом, функция не стартует и пишет причину в лог: так вход не окажется выключенным по ошибке.
3. **Регион функции.** Он должен совпадать с регионом базы Neon (Vercel → Storage → база → Settings). По умолчанию у Vercel `iad1`, это пара к Neon `aws-us-east-1`. Если база в другом регионе, выберите ближайший в Settings → Functions → Region, иначе каждый запрос к базе пойдёт через океан.
4. **Деплой** из корня репозитория:
   ```bash
   vercel deploy --prod
   ```
   CLI загружает файлы с учётом `.vercelignore`, Vercel собирает функцию на своей стороне и ставит зависимости из `uv.lock`, включая `psycopg[binary,pool]` под Linux. Если проект подключён к Git, достаточно push в основную ветку.
5. **README.** Опубликуйте логин и пароль жюри и адрес продакшена. Выход — ссылка `/login.html?logout=1`.

## Проверка после деплоя

```bash
curl https://<домен>/api/health           # {"ok":true}
curl -i https://<домен>/api/checklists    # 401 {"error":{"code":"auth_required",…}}
curl https://<домен>/api/auth/me          # {"auth_required":true,"authenticated":false,"user":null}
```

В браузере:

1. `https://<домен>/` открывает `login.html?next=…`. После входа вы возвращаетесь на исходный адрес, в списке DEV оценены 60 чатов.
2. `https://<домен>/d365/`: стенд уводит на вход всё окно, после входа возвращает обратно. Панель во вкладке «Качество» работает.
3. Одна новая оценка из интерфейса укладывается в 150 с и остаётся после перезагрузки страницы (данные в Postgres).
4. В Runtime Logs функции при старте есть строка `Хранилище: Postgres, схема public`.

Preview-деплои по умолчанию закрыты Vercel Authentication. Жюри даёте адрес продакшена.

## Как устроено

- **Хранилище.** `app/store/postgres.py` (`PostgresStore`) реализует тот же интерфейс `Store`, что и SQLite. Документы хранятся как `json`, текст как есть, поэтому ответы API на обеих базах совпадают побайтово (это проверяет `tests/store/test_api_flow.py`). Пул `psycopg_pool` маленький, без постоянных соединений, каждое соединение проверяется при выдаче. Подготовленные выражения выключены для пулера Neon. Миграции идемпотентные, идут при первом обращении под advisory-блокировкой, поэтому недоступная база даёт 503 и не роняет функцию.
- **Вход.** Cookie `cqa_session` подписана HMAC-SHA256, действует 7 дней, флаги `HttpOnly; Secure; SameSite=Lax; Path=/api`. Ключ выводится из `CQA_SESSION_SECRET`, логина и пароля: смена пароля завершает все сессии. Без сессии закрыты все `/api/*`, кроме `/api/health` и `/api/auth/*`. Статика публичная. Лимит: 10 неудачных входов за 5 минут с одного IP, в памяти экземпляра функции.
- **Тесты.** `uv run pytest` гоняет контракт хранилища на SQLite. Postgres-вариант запускается только с `CQA_TEST_DATABASE_URL`, каждый тест в своей временной схеме `cqa_test_*`, которая удаляется после теста:
  ```bash
  uv run --env-file .env.local sh -c 'CQA_TEST_DATABASE_URL="$DATABASE_URL" pytest tests/store'
  ```
  `tests/conftest.py` убирает `DATABASE_URL` из окружения тестов, так что рабочая схема не затрагивается.

## Локально с Postgres и входом

```bash
# CQA_AUTH_* и CQA_SESSION_SECRET — в свой файл, например .env.auth (в git не попадает)
uv run --env-file .env.local --env-file .env.auth uvicorn app.main:app --port 8000
```

Открывайте `http://localhost:8000` в Chrome или Firefox: cookie с флагом `Secure` они принимают на `localhost` и без https. Если браузер cookie не сохранил, страница входа так и пишет и не уходит в цикл переадресаций.
