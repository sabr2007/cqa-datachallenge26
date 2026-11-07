#!/usr/bin/env bash
# Выгружает набор диалогов из API кейса и печатает сводку.
#   ./scripts/fetch-dataset.sh            # DEV
#   ./scripts/fetch-dataset.sh <GROUP_ID> # контрольный набор
# Базовый URL можно переопределить через CQA_API_URL (без параметра group_id).
set -euo pipefail

readonly DEFAULT_API_URL='https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=5Sog2MThgCRTlk3HObv70LRmRk6u7IOwzlwMpe804qo'
readonly REQUEST_TIMEOUT_SEC=90

group_id="${1:-DEV}"
if [[ ! "$group_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Некорректный group_id: '$group_id' (допустимы буквы, цифры, _ и -)" >&2
  exit 1
fi

api_url="${CQA_API_URL:-$DEFAULT_API_URL}"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$repo_root/data"
out_file="$out_dir/${group_id}.json"
mkdir -p "$out_dir"

echo "Загружаю group_id=$group_id ..."
curl -fsS --max-time "$REQUEST_TIMEOUT_SEC" "${api_url}&group_id=${group_id}" -o "$out_file"

python3 -I - "$out_file" <<'PY'
import collections
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    payload = json.load(f)

if not payload.get("isSuccess"):
    sys.exit(f"API вернул ошибку: {payload.get('error')!r}")

data = payload["data"]
records = data["records"]
by_lang = collections.Counter(r["language"] for r in records)
by_channel = collections.Counter(r["channel"] for r in records)
by_speaker = collections.Counter(m["speaker"] for r in records for m in r["transcript"])
with_audio = sum(1 for r in records if r.get("audio_url"))

print(f"Сохранено: {path}")
print(f"group_id={data['dataset_group_id']}  записей={data['total_records']} (получено {len(records)})")
print("языки:   ", dict(by_lang))
print("каналы:  ", dict(by_channel))
print("реплики: ", dict(by_speaker))
print("с аудио: ", with_audio)
PY
