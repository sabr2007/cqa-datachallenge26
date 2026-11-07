# API CQA

Контракт и полные схемы — [CONTRACT.md](CONTRACT.md).

JSON в UTF-8. Ошибка всегда в одном формате: `{"error": {"code": "<snake_case>", "message": "<текст для пользователя>"}}`. Полные схемы (Evaluation, Appeal, метрики, аналитика) — в [docs/CONTRACT.md](docs/CONTRACT.md).

| Запрос | Ответ |
|---|---|
| `GET /api/health` | `{"ok": true}` |
| `GET /api/datasets/{group_id}/conversations` | список диалогов набора + сводка последней оценки |
| `GET /api/datasets/{group_id}/conversations/{conversation_id}` | диалог целиком |
| `GET /api/datasets/{group_id}/conversations/{conversation_id}/audio` | запись звонка: поток `audio/mpeg`, поддерживает `Range` |
| `GET /api/checklists` | `{"items": [{id, title, latest_version, versions: [{version, created_at, note, sandbox}]}]}` |
| `GET /api/checklists/{id}?version=N` | документ версии; без `version` — последняя обычная; `default` = `chat-quality` |
| `POST /api/checklists/{id}/versions` | документ без `version` + `note`, `sandbox` → новая версия (201) |
| `GET /api/models` | `{"items": [{id, provider, label, available, default, price}]}` — каталог движка |
| `POST /api/evaluations` | `{group_id, conversation_id, checklist_id?, checklist_version?, models?, reuse_previous?, purpose?}` → Evaluation (201, синхронно) |
| `GET /api/evaluations?group_id=&conversation_id=&purpose=&limit=` | история оценок, новые первыми |
| `GET /api/evaluations/{id}` | одна оценка |
| `POST /api/evaluations/{id}/appeals` | `{criterion_id, comment}` → Appeal (201) |
| `GET /api/appeals?group_id=&status=&evaluation_id=&conversation_id=` | очередь: Appeal + `criterion_title`, `answer_type`, `original_answer`, `final_answer`, `options`, `fragment` |
| `GET /api/appeals/{id}` | одна апелляция в том же виде |
| `POST /api/appeals/{id}/decision` | `{action: "confirm" \| "change", new_answer?, reason}` → `{appeal, evaluation}` |
| `GET /api/export?group_id=&format=json\|csv` | последние обычные оценки набора: ответы и баллы по критериям, итог, грубая ошибка |
| `GET /api/metrics/accuracy?group_id=DEV&checklist_id=&checklist_version=&purpose=` | точность последних оценок относительно `eval/gold.json` |
| `GET /api/analytics?group_id=` | доля провалов по критериям, частые цитаты, грубые ошибки, апелляции |

`group_id`, `conversation_id` и остальные id — только `^[A-Za-z0-9_-]{1,64}$`. Список и диалог принимают `?refresh=1`: перечитать набор из API кейса, минуя кеш. Списки отдаются как `{"items": [...]}`.

**Список.** Порядок — как у источника. `channel`: `chat` | `call`; `duration_sec` — от первой до последней реплики (`null` для пустого диалога); `preview` — первая реплика клиента, до 140 символов. `evaluation` — сводка последней успешной обычной оценки диалога или `null`: `{evaluation_id, total, final_total, critical, critical_note, needs_review, appeal_status, checklist_version, answers: {criterion_id: final_answer}}`. Битые записи источника пропускаются и пишутся в лог сервера, остальные отдаются.

```json
{
  "group_id": "DEV", "total": 65, "fetched_at": "2026-11-07T12:25:40Z",
  "items": [{
    "conversation_id": "p1-ru-001", "channel": "chat", "language": "RU",
    "message_count": 12, "counts": {"client": 4, "operator": 2, "bot": 5, "system": 1},
    "duration_sec": 124.0, "preview": "Где посмотреть мой тариф? В приложении не нахожу.",
    "has_audio": false, "evaluation": null
  }]
}
```

**Диалог.** `timestamp` — исходная строка источника; `offset_sec` — секунды от первой реплики (у чатов из `MM:SS`, у звонков — разница ISO-времени), по нему плеер перематывает запись. `audio` — `null`, если записи нет; `audio.url` — путь к аудио-прокси этого же бэкенда.

```json
{
  "conversation_id": "p4-ru-001", "channel": "call", "language": "RU",
  "audio": {"url": "/api/datasets/DEV/conversations/p4-ru-001/audio"},
  "messages": [
    {"index": 0, "timestamp": "2026-11-03T15:49:13.1900670+00:00", "offset_sec": 0.0, "speaker": "system", "text": "Запись и транскрибирование запущены."}
  ]
}
```

**Аудио.** `audio_url` звонка в API кейса ведёт не на файл, а на HTML-страницу плеера; ссылка на сам mp3 (хранилище Dynamics 365, подпись живёт около часа) лежит в её `<source>`. Бэкенд достаёт эту ссылку, кеширует на 30 минут и стримит файл, пробрасывая `Range`: перемотка работает, подписанная ссылка в браузер не попадает. Ходить бэкенд может только на `*.powerplatform.com` и `*.dynamics.com` по https.

**Хранилище.** SQLite в `.data/cqa.sqlite` (путь — `CQA_DB_PATH`, в git не попадает) за интерфейсом `Store` (`app/store`); схема мигрирует при старте. Версии чек-листа неизменяемы — правка всегда новая версия. При первом старте версия 1 берётся из `config/checklists/chat-default.json`. Если файл потом изменился, а последняя обычная версия тоже из файла, при старте добавляется новая версия с пометкой «обновлено из config (guidance)». Версии, сохранённые через интерфейс, файл не перекрывает.

**Чек-листы.** Новая версия проверяется: id критериев и секций уникальны, вес ≥ 0, у «Да/Нет» есть условие `yes`, у шкалы 2–11 ступеней с разными значениями, секции ссылаются на существующие критерии (каждый критерий — не больше чем в одной секции), грубая ошибка (`critical`) бывает только у «Да/Нет». Ошибка — 400 `invalid_checklist` со списком проблем. Версия с `"sandbox": true` не становится последней и `default`, но открывается по `?version=N`.

**Оценка.** `POST /api/evaluations` ждёт движок до 150 с (сам движок укладывается в 90 с, плюс ожидание в очереди), поэтому таймаут запроса у клиента должен быть не меньше. Evaluation движка сохраняется целиком; бэкенд добавляет `id`, `created_at`, `group_id`, `purpose`, ставит `final_*` равными исходным и добавляет `final_max_points`. Без `checklist_version` берётся последняя обычная версия, без `models` (или с `[]`) — модели движка по умолчанию. `reuse_previous: true` передаёт движку последнюю успешную оценку диалога по этому чек-листу, и критерии, которые не менялись, не переоцениваются. `purpose: "sandbox"` (по умолчанию `regular`, для версии-песочницы — `sandbox`) не попадает в сводку листинга, экспорт, аналитику и метрики по умолчанию. Сбой движка сохраняется как Evaluation со `status: "error"` и отдаётся ошибкой 502 или 504.

**Апелляции.** На критерий в одной оценке — одна апелляция; комментарий и причина решения — до 2000 символов. При решении `change` бэкенд проверяет `new_answer` по типу критерия (`yes`/`no`, ступень шкалы, `na` — если разрешён) и через `score_evaluation` движка пересчитывает `final_*` критериев и секций и `final_total`. Исходные `answer`, `points`, `total` не меняются. `critical_flag` пересчитывается по `final_answer` критериев с `critical: true`; если решение меняет такой критерий, `critical_note` берётся из причины решения. В оценке `criterion.appeal` содержит `id`, `status`, `comment`, `created_at`, `original_answer`, `decision`. `fragment` в очереди — реплики evidence ± 1 по возрастанию `index` из снимка транскрипта, по которому делалась оценка.

**Экспорт.** JSON: `{group_id, exported_at, items: [{conversation_id, language, evaluation_id, checklist_version, criteria: [{criterion_id, title, answer, final_answer, points, final_points, max_points, final_max_points}], total, final_total, critical_flag, critical_note, needs_review, models, cost_usd}]}`. CSV рассчитан на Excel: разделитель «;», десятичная запятая, UTF-8 с BOM; на каждый критерий — столбцы `<id>_answer`, `<id>_points`, `<id>_final_answer`, `<id>_final_points`.

**Метрики и аналитика.** Точность считает `compute_accuracy` движка. Без версии берутся последние обычные оценки, с `checklist_version` — последние оценки этой версии с любым `purpose`; явный `purpose` фильтрует. Аналитика строится по `final_answer` последних обычных оценок. Провал — «Нет» (у грубой ошибки — «Да»), у шкалы — ответ ниже верхней ступени. Доля принятых апелляций — `accepted / resolved` по всем апелляциям к обычным оценкам набора.

**Ошибки.**

| Статус | `code` | Когда |
|---|---|---|
| 400 | `invalid_group_id`, `invalid_conversation_id`, `invalid_request`, `invalid_body`, `invalid_checklist`, `invalid_answer`, `answer_unchanged`, `invalid_purpose`, `model_unavailable`, `invalid_<поле>` | некорректный id, параметр или тело запроса |
| 404 | `conversation_not_found`, `audio_not_found`, `checklist_not_found`, `checklist_version_not_found`, `evaluation_not_found`, `appeal_not_found`, `criterion_not_found`, `not_found` | нет такого объекта или пути |
| 409 | `appeal_exists`, `appeal_already_resolved`, `evaluation_not_appealable`, `evaluation_conflict` | апелляция уже подана или рассмотрена; оценка завершилась ошибкой; оценку изменили параллельно |
| 500 | `checklist_unavailable`, `gold_unavailable`, `scoring_failed` | не читается чек-лист или эталон; не удался пересчёт |
| 502 | `upstream_error`, `upstream_unavailable`, `upstream_invalid_response`, `dataset_not_found`, `audio_unavailable`, `evaluation_failed`, `evaluation_invalid` | API кейса вернул ошибку или недоступен; движок упал или вернул результат не в том формате |
| 503 | `engine_unavailable`, `storage_unavailable` | движок оценки не загружается; база недоступна |
| 504 | `upstream_timeout`, `evaluation_timeout` | API кейса или оценка не уложились во время |
