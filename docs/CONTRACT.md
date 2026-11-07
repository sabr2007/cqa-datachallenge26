# Контракт разработки (общий для всех агентов)

Источник правды для параллельной работы. Меняет его только координатор; если нужно изменение — напишите координатору, не правьте сами.
Список фич — [FEATURES.md](FEATURES.md). Правила оценки — [TASK.md](TASK.md) (раздел 4 и 8), [../eval/RUBRIC.md](../eval/RUBRIC.md), [../eval/DECISIONS.md](../eval/DECISIONS.md).

## Общие правила

- Никто не коммитит и не пушит. Никто не деплоит.
- Пишите только в своей зоне (ниже). Чужие файлы — только читать. Нужна правка чужого файла — сообщите координатору.
- Никакого хардкода результатов: система реально оценивает диалог. Эталон (`eval/gold.json`) используется только для метрик точности, никогда — для ответа системы.
- Нумерация реплик: в данных и API `index` с нуля; в интерфейсе показываем `#index+1` (`messageNumber` в `public/js/format.js`).
- Секреты только в `.env` (в git не попадает): `ANTHROPIC_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. Никогда не печатать их в логах и ответах.
- Порты для локальной проверки: движок 8010, бэкенд 8020, фронтенд «Результаты» 8030, фронтенд «Чек-лист» 8040, Dynamics 8050. Запуск: `uv run uvicorn app.main:app --port <порт>`.
- Фронтенд: чистые ES-модули без сборки, всё в `#cqa-root`, стили под `.cqa`, без inline-скриптов и `innerHTML` с данными, запросы только через `public/js/api.js` (`apiRequest`).

## Зоны ответственности

| Агент | Владеет | Не трогает |
|---|---|---|
| **Движок оценки** | `app/engine/**`, `scripts/eval_*.py`, `tests/engine/**`, `eval/runs/**`, `eval/RUBRIC.md`, поле `guidance` в `config/checklists/chat-default.json`, зависимости в `pyproject.toml`/`uv.lock` | `app/routes.py`, `app/store/**`, `public/**` |
| **Бэкенд API** | `app/routes.py`, `app/api/**`, `app/store/**`, `app/views.py`, `tests/api/**` и существующие `tests/test_*.py`, раздел «API» в `README.md` | `app/engine/**`, `public/**`, зависимости (нужна новая — к координатору) |
| **Фронтенд «Результаты и апелляции»** | `public/index.html`, `public/app.css`, `public/js/api.js`, `public/js/app.js`, `public/js/router.js`, `public/js/components/**`, `public/js/views/{conversations,conversationTable,conversation,transcript,evalPanel,appeals,notFound}.js`, `public/js/evaluation.js`, `public/js/format.js`, `public/js/dom.js`, `public/js/theme.js`, `public/js/icons.js` | `public/js/views/{checklist,insights}.js`, `public/js/admin/**`, `public/css/admin.css`, `public/d365/**`, `public/embed*` |
| **Фронтенд «Чек-лист и аналитика»** | `public/js/views/checklist.js`, `public/js/views/insights.js`, `public/js/admin/**`, `public/js/scoring.js`, `public/css/admin.css` | всё остальное в `public/` |
| **Стенд Dynamics 365** | `public/d365/**`, `public/embed.html`, `public/js/embed/**`, `public/css/embed.css` | всё остальное |

Общие модули (`api.js`, `dom.js`, `format.js`, `components/ui.js`) остальные фронтенд-агенты только импортируют.

## Движок оценки — интерфейс для бэкенда

```python
# app/engine/__init__.py
async def evaluate_conversation(
    conversation: app.models.Conversation,
    checklist: dict,                      # документ чек-листа (схема ниже), конкретная версия
    *,
    models: list[str] | None = None,      # None → модели по умолчанию из env CQA_MODELS
    reuse: dict | None = None,            # прошлая Evaluation: критерии, не изменившиеся в чек-листе, не переоцениваются
) -> dict: ...                            # Evaluation без полей хранения (id, created_at, appeals)

def score_evaluation(checklist: dict, answers: dict[str, str | int]) -> dict: ...
    # чистая функция: {criterion_id: answer} → {"criteria": {id: {"points", "max_points"}}, "sections": [...], "total": float|None}
    # Decimal, округление half-up до 2 знаков, N/A перераспределяет вес, критерий scored=false в итог не входит.

def list_models() -> list[dict]: ...      # [{"id","provider","label","available": bool,"price": {...}}]
```

- Отдельный вызов модели на каждый критерий; строгий JSON «применимость → доказательства → вердикт»; правила-сигналы (приветствие/язык/представление для 01, подозрительные фразы для 08); проверка цитат кодом; голосование нескольких моделей → `confidence`, `needs_review`.
- Промпт критерия строится из чек-листа (title, yes/no/na, scale, `guidance`) — новый критерий из редактора оценивается без правки кода.
- Провайдеры: Claude (официальный SDK `anthropic`, модель `claude-opus-5-5`), Cloudflare Workers AI напрямую `POST /accounts/{id}/ai/run/@cf/...` (не через AI Gateway), локальная модель через Ollama (по желанию).
- Таймаут на диалог ≤ 90 с (критерии параллельно).

## Схема чек-листа

Как в `config/checklists/chat-default.json` (`id`, `version`, `title`, `rules`, `sections[{id,title,criteria[]}]`, `criteria[{id,title,answerType:"yes_no"|"scale",weight,naAllowed,yes,no?,na?,scale?[{value,label}],scored?,critical?,guidance?}]`). Поле `guidance` — дополнительные указания для ИИ-оценщика (правила из DECISIONS). Версии неизменяемы: правка = новая версия.

## Evaluation (JSON)

Полный пример — [contract/evaluation.example.json](contract/evaluation.example.json).

```
{
  "id": "ev_…", "group_id": "DEV", "conversation_id": "p1-ru-001", "created_at": "ISO",
  "checklist_id": "chat-quality", "checklist_version": 1,
  "models": ["claude-opus-5-5", "@cf/zai-org/glm-5.3"],
  "criteria": [{
    "criterion_id": "c04", "title": "…", "answer_type": "yes_no"|"scale", "weight": 20, "critical": false, "scored": true,
    "answer": "yes"|"no"|"na"|20,        // исходный ответ системы
    "final_answer": …,                  // после решения по апелляции (= answer, если её не было)
    "points": 18.18, "max_points": 18.18, "final_points": …,   // с учётом перераспределения N/A; null для N/A и scored=false
    "explanation": "…",                 // по-русски, со ссылкой на реплику
    "evidence": [{"index": 9, "quote": "…", "verified": true}],
    "checked_range": [9, 14] | null,    // для «Нет» за пропущенное действие — где оно ожидалось
    "na_reason": "…" | null,
    "confidence": 0.67, "votes": [{"model": "…", "answer": …}],
    "needs_review": false,
    "appeal": {"id": "ap_…", "status": "open"|"resolved"} | null
  }],
  "sections": [{"id": "start", "title": "…", "points": …, "max_points": …, "final_points": …}],
  "total": 81.25, "final_total": 85.0,   // null, если применимых критериев с весом нет
  "critical_flag": false, "critical_note": null,
  "needs_review": false,
  "cost_usd": 0.042, "tokens": {"input": 0, "output": 0}, "latency_ms": 0,
  "status": "done"|"error", "error": null
}
```

## API (бэкенд)

Ошибки — как сейчас: `{"error":{"code","message"}}`.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/datasets/{g}/conversations` | как сейчас + у элемента `evaluation`: `{evaluation_id, total, final_total, critical, critical_note, needs_review, appeal_status, checklist_version}` или `null` |
| GET | `/api/checklists` | `[{id, title, latest_version, versions:[{version, created_at, note}]}]` |
| GET | `/api/checklists/{id}?version=N` | документ версии (по умолчанию последняя); `/api/checklists/default` = последняя версия `chat-quality` |
| POST | `/api/checklists/{id}/versions` | тело: документ без `version` + `note` → новая версия (валидация: уникальные id, веса ≥ 0, шкала со ступенями, секции ссылаются на существующие критерии) |
| GET | `/api/models` | список моделей и доступность (из движка) |
| POST | `/api/evaluations` | `{group_id, conversation_id, checklist_id?, checklist_version?, models?, reuse_previous?: bool}` → Evaluation (синхронно, сохраняется) |
| GET | `/api/evaluations?group_id=&conversation_id=` | история оценок (новые первыми) |
| GET | `/api/evaluations/{id}` | одна оценка |
| POST | `/api/evaluations/{id}/appeals` | `{criterion_id, comment}` → Appeal |
| GET | `/api/appeals?group_id=&status=open\|resolved` | очередь: Appeal + фрагмент (реплики evidence ± 1) + исходный ответ |
| POST | `/api/appeals/{id}/decision` | `{action: "confirm"\|"change", new_answer?, reason}` → `{appeal, evaluation}` с пересчитанным `final_*` |
| GET | `/api/export?group_id=&format=json\|csv` | последние оценки набора: conversation_id, ответ и баллы по каждому критерию, итог, флаг 08 |
| GET | `/api/metrics/accuracy?group_id=DEV` | сравнение последних оценок с `eval/gold.json`: точность по критериям, по языкам, путаница N/A↔Нет, отдельно holdout/tuning |
| GET | `/api/analytics?group_id=` | доля «Нет» по критериям, частые цитаты провалов, грубые ошибки, доля принятых апелляций по критериям |

Appeal: `{id, evaluation_id, group_id, conversation_id, criterion_id, comment, created_at, status, original_answer, decision: {action, new_answer, reason, decided_at} | null}`.

### Дополнения (v2)

**Округление.** Баллы критериев, секций и итог считаются по точным (неокруглённым) значениям Decimal; округляется только то, что отдаётся наружу — каждое число отдельно, half-up до 2 знаков. Поэтому сумма округлённых баллов критериев может отличаться от итога на копейки — это нормально.

**Песочница.** `POST /api/evaluations` принимает `purpose: "regular" | "sandbox"` (по умолчанию `regular`), поле сохраняется в Evaluation. Оценки `sandbox` не попадают в `evaluation` листинга, экспорт, аналитику и «последние» оценки метрик без явного фильтра.

**Версии-песочницы чек-листа.** `POST /api/checklists/{id}/versions` принимает `"sandbox": true` (метаданные версии, как `note`). Такая версия не становится `latest_version` и `/api/checklists/default`; в `GET /api/checklists` приходит в `versions[]` с `"sandbox": true`; по `?version=N` доступна как обычно. Без флага — обычная версия.

**Списки.** Все эндпоинты, отдающие список, возвращают `{"items": [...]}` (`/api/checklists`, `/api/evaluations`, `/api/appeals`, `/api/models`).

**Листинг.** `evaluation` у элемента списка дополнительно содержит `answers: {criterion_id: final_answer}`.

**`/api/models`** — элемент `{id, provider, label, available, default, price}`; `default: true` у моделей, которые сервер берёт при пустом `models`.

**`/api/appeals?group_id=&status=`** — `status` необязателен (без него — все апелляции набора). Элемент: Appeal + `criterion_title`, `answer_type`, `original_answer`, `final_answer`, `fragment: [{index, speaker, text, timestamp, offset_sec}]` (реплики evidence ± 1, по возрастанию index).

**Грубая ошибка после апелляции.** `critical_flag` и `critical_note` пересчитываются по `final_answer` критериев с `critical: true` («Да» = нарушение есть); при изменении решением `critical_note` берётся из причины решения.

**Дополнения бэкенда (приняты).**
- У критериев и секций Evaluation есть `final_max_points` (апелляция N/A↔ответ меняет перераспределение весов); если движок не поставил — равно `max_points`.
- `criterion.appeal` при чтении оценки содержит ещё `comment`, `created_at`, `original_answer`, `decision`.
- Элемент `/api/appeals` содержит `options: [{value, label}]` — допустимые ответы для «Изменить»; фильтры `evaluation_id`, `conversation_id` необязательные; есть `GET /api/appeals/{id}`.
- POST-создание возвращает 201, решение по апелляции — 200. Одна апелляция на критерий в одной оценке: повторная — 409 `appeal_exists`.
- Если `purpose` не указан, а версия чек-листа — песочница, оценка получает `purpose: "sandbox"`; явный `regular` с версией-песочницей — 400.
- CSV: разделитель «;», десятичная запятая, UTF-8 BOM (для Excel); для машинной обработки — JSON.

**`tests/fixtures/scoring_cases.json`** (создаёт движок): `[{"name", "checklist": {...}, "answers": {id: answer}, "expected": {"criteria": {id: {"points", "max_points"}}, "sections": [{"id", "points", "max_points"}], "total"}}]`.

**`GET /api/metrics/accuracy?group_id=&checklist_id=&checklist_version=&purpose=`** — без версии: последние regular-оценки; с версией: последние оценки этой версии (любого purpose).
```
{ "group_id", "checklist_version": N|null, "gold_count", "evaluated_count",
  "overall": {"matched","total","accuracy"},
  "by_set": {"holdout": {...}, "tuning": {...}},
  "by_criterion": [{"criterion_id","title","matched","total","accuracy","holdout":{...},"tuning":{...}}],
  "by_language": [{"language","matched","total","accuracy"}],
  "na_confusion": {"na_as_no","no_as_na","by_criterion":[{"criterion_id","na_as_no","no_as_na"}]},
  "by_model": [{"model","matched","total","accuracy"}],
  "expert_agreement": {"matched","total","accuracy"} | null,
  "conversations": [{"conversation_id","language","set","evaluation_id"|null,"checklist_version","matched","total","mismatches":[{"criterion_id","gold","system"}]}] }
```
`accuracy` — доля 0..1; `total` — пары (эталон, ответ системы), где оба есть. `na_as_no` — эталон N/A, система «Нет»; `no_as_na` — наоборот. `by_model` — по голосам отдельных моделей.

**`GET /api/analytics?group_id=`** (только regular-оценки, последняя на диалог)
```
{ "group_id", "evaluated_count",
  "criteria": [{"criterion_id","title","answer_type","applicable",
                "answers": {"yes":..,"no":..,"na":..} | {"20":..,"15":..,"na":..},
                "fail_count","fail_rate",               // yes_no: «Нет» (для critical — «Да»); шкала: ниже верхней ступени
                "top_quotes": [{"conversation_id","index","quote","explanation","count"}],   // до 5
                "appeals": {"total","accepted","rate"}}],                                      // accepted = решение change
  "critical": [{"conversation_id","evaluation_id","note","index","quote"}],
  "appeals": {"total","resolved","accepted"} }
```

Хранилище — SQLite в `.data/cqa.sqlite` (в git не попадает) за интерфейсом `Store`, чтобы позже подменить на Postgres для Vercel.
