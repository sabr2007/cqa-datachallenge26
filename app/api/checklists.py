"""Версии чек-листов: проверка документа, сид из config, выдача и создание версий.

Схема документа — docs/CONTRACT.md («Схема чек-листа»). Версии неизменяемы:
правка — новая версия. Версия-песочница (sandbox) не становится последней.
"""

import hashlib
import itertools
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.api.errors import (
    bad_request,
    checklist_not_found,
    checklist_unavailable,
    checklist_version_not_found,
)
from app.api.validation import (
    body_bool,
    body_text,
    is_number,
    require_object,
    require_path_id,
)
from app.errors import BadRequestError
from app.store import ChecklistVersion, StorageError, Store
from app.validation import is_valid_id

logger = logging.getLogger("cqa.checklists")

DEFAULT_CHECKLIST_ID = "chat-quality"
DEFAULT_ALIAS = "default"
SEED_NOTE_INITIAL = "Исходная версия из config/checklists/chat-default.json"
SEED_NOTE_UPDATE = "обновлено из config (guidance)"

ANSWER_TYPES = ("yes_no", "scale")
ROUNDING_MODES = ("half_up", "half_even")
MAX_CRITERIA = 100
MAX_SECTIONS = 30
MIN_SCALE_STEPS = 2
MAX_SCALE_STEPS = 11
MAX_DECIMALS = 6
MAX_TITLE_CHARS = 200
MAX_TEXT_CHARS = 4000
MAX_GUIDANCE_CHARS = 8000
MAX_NOTE_CHARS = 500
MAX_DOC_BYTES = 256 * 1024
MAX_REPORTED_PROBLEMS = 5
_SHORT_CHARS = 64

# Поля тела запроса, которые описывают версию, а не документ.
_VERSION_META_FIELDS = ("note", "sandbox", "version")


@dataclass(frozen=True, slots=True)
class ChecklistDraft:
    doc: dict[str, Any]
    note: str | None
    sandbox: bool


def resolve_checklist_id(raw: str) -> str:
    """id из адреса; «default» — синоним основного чек-листа chat-quality."""
    checklist_id = require_path_id(raw, "checklist_id")
    return DEFAULT_CHECKLIST_ID if checklist_id == DEFAULT_ALIAS else checklist_id


def list_checklists(store: Store) -> list[dict[str, Any]]:
    versions = store.list_checklist_versions()
    return [
        _checklist_summary(checklist_id, list(group))
        for checklist_id, group in itertools.groupby(versions, key=lambda v: v.checklist_id)
    ]


def get_checklist(
    store: Store, checklist_id: str, version: int | None, *, seed_path: Path
) -> ChecklistVersion:
    found = store.get_checklist_version(checklist_id, version)
    if found is None and version is None and checklist_id == DEFAULT_CHECKLIST_ID:
        # Сид при старте мог не пройти (файл был битым) — пробуем ещё раз.
        sync_default_checklist(store, seed_path)
        found = store.get_checklist_version(checklist_id, None)
        if found is None:
            raise checklist_unavailable(detail=f"нет версий {checklist_id}, сид не удался")
    if found is None:
        if version is None:
            raise checklist_not_found(checklist_id)
        raise checklist_version_not_found(checklist_id, version)
    return found


def create_checklist_version(store: Store, checklist_id: str, payload: object) -> ChecklistVersion:
    draft = parse_checklist_payload(payload, checklist_id)
    created = store.add_checklist_version(
        checklist_id, draft.doc, note=draft.note, sandbox=draft.sandbox
    )
    logger.info(
        "Чек-лист %s: сохранена версия %d%s",
        checklist_id,
        created.version,
        " (песочница)" if created.sandbox else "",
    )
    return created


def parse_checklist_payload(payload: object, checklist_id: str) -> ChecklistDraft:
    """Тело POST …/versions: документ без version + note и sandbox."""
    body = require_object(payload)
    note = body_text(
        body, "note", label="Комментарий к версии", max_chars=MAX_NOTE_CHARS, required=False
    )
    sandbox = body_bool(body, "sandbox", default=False)
    doc = {key: value for key, value in body.items() if key not in _VERSION_META_FIELDS}
    problems = checklist_problems(doc, checklist_id)
    if problems:
        raise invalid_checklist(problems)
    return ChecklistDraft(doc={**doc, "id": checklist_id}, note=note, sandbox=sandbox)


def sync_default_checklist(store: Store, path: Path) -> ChecklistVersion | None:
    """Версия из config-файла: если версий ещё нет или файл изменился с прошлого сида.

    Версии, сохранённые через интерфейс, файл не перекрывает (это решает Store).
    """
    raw = _read_seed(path)
    if raw is None:
        return None
    checklist_id = raw["id"] if is_valid_id(raw.get("id")) else DEFAULT_CHECKLIST_ID
    doc = {key: value for key, value in raw.items() if key != "version"}
    problems = checklist_problems(doc, checklist_id)
    if problems:
        logger.error("Чек-лист %s не прошёл проверку: %s", path.name, "; ".join(problems))
        return None
    try:
        note = SEED_NOTE_UPDATE if store.get_checklist_version(checklist_id) else SEED_NOTE_INITIAL
        created = store.sync_checklist_file(
            checklist_id, {**doc, "id": checklist_id}, note=note, source_hash=content_hash(doc)
        )
    except StorageError as exc:
        logger.error("Чек-лист %s не сохранён: %s", path.name, exc.detail)
        return None
    if created is not None:
        logger.info(
            "Чек-лист %s: версия %d из %s (%s)", checklist_id, created.version, path.name, note
        )
    return created


def content_hash(doc: Mapping[str, Any]) -> str:
    """Хэш нормализованного документа без version: меняется только при правке содержимого."""
    body = {key: value for key, value in doc.items() if key != "version"}
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def criterion_options(criterion: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Допустимые ответы критерия с подписями: для «Изменить» в апелляции."""
    if criterion.get("answerType") == "scale":
        steps = sorted(
            (step for step in criterion.get("scale") or [] if isinstance(step, Mapping)),
            key=lambda step: step.get("value", 0),
            reverse=True,
        )
        options = [
            {"value": _plain_number(step.get("value")), "label": str(step.get("label") or "")}
            for step in steps
        ]
    else:
        options = [{"value": "yes", "label": "Да"}, {"value": "no", "label": "Нет"}]
    if criterion.get("naAllowed"):
        options = [*options, {"value": "na", "label": "N/A"}]
    return options


def find_criterion(doc: Mapping[str, Any], criterion_id: str) -> Mapping[str, Any] | None:
    return next(
        (
            criterion
            for criterion in doc.get("criteria") or []
            if isinstance(criterion, Mapping) and criterion.get("id") == criterion_id
        ),
        None,
    )


def invalid_checklist(problems: list[str]) -> BadRequestError:
    shown = "; ".join(problems[:MAX_REPORTED_PROBLEMS])
    hidden = len(problems) - MAX_REPORTED_PROBLEMS
    more = f" (и ещё {hidden})" if hidden > 0 else ""
    return bad_request("invalid_checklist", f"Чек-лист не сохранён: {shown}{more}.")


def checklist_problems(doc: Mapping[str, Any], checklist_id: str) -> list[str]:
    """Все найденные проблемы документа (пустой список — документ корректен)."""
    problems: list[str] = []
    if "id" in doc and doc["id"] != checklist_id:
        problems.append(
            f"id в теле («{_short(doc['id'])}») не совпадает с чек-листом в адресе "
            f"(«{checklist_id}»)"
        )
    _check_title(doc.get("title"), "название чек-листа (title)", problems)
    _check_rules(doc.get("rules"), problems)
    criterion_ids = _check_criteria(doc.get("criteria"), problems)
    _check_sections(doc.get("sections"), criterion_ids, problems)
    size = len(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
    if size > MAX_DOC_BYTES:
        problems.append(f"документ больше {MAX_DOC_BYTES // 1024} КБ")
    return problems


def _checklist_summary(checklist_id: str, versions: list[ChecklistVersion]) -> dict[str, Any]:
    regular = [version for version in versions if not version.sandbox]
    latest = regular[-1] if regular else None
    return {
        "id": checklist_id,
        "title": (latest or versions[-1]).title,
        "latest_version": latest.version if latest else None,
        "versions": [
            {
                "version": version.version,
                "created_at": version.created_at,
                "note": version.note,
                "sandbox": version.sandbox,
            }
            for version in versions
        ],
    }


def _read_seed(path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("Чек-лист %s не прочитан: %s", path.name, type(exc).__name__)
        return None
    if not isinstance(raw, dict):
        logger.warning("Чек-лист %s: ожидается JSON-объект", path.name)
        return None
    return raw


def _check_title(value: object, label: str, problems: list[str]) -> None:
    if not isinstance(value, str) or not value.strip():
        problems.append(f"{label}: нужна непустая строка")
    elif len(value) > MAX_TITLE_CHARS:
        problems.append(f"{label}: не длиннее {MAX_TITLE_CHARS} символов")


def _check_rules(rules: object, problems: list[str]) -> None:
    if rules is None:
        return
    if not isinstance(rules, Mapping):
        problems.append("rules: ожидается объект")
        return
    rounding = rules.get("rounding")
    if rounding is not None:
        if not isinstance(rounding, Mapping):
            problems.append("rules.rounding: ожидается объект {decimals, mode}")
        else:
            decimals = rounding.get("decimals", 2)
            if (
                not isinstance(decimals, int)
                or isinstance(decimals, bool)
                or not 0 <= decimals <= MAX_DECIMALS
            ):
                problems.append(f"rules.rounding.decimals: целое число от 0 до {MAX_DECIMALS}")
            if rounding.get("mode", "half_up") not in ROUNDING_MODES:
                problems.append("rules.rounding.mode: «half_up» или «half_even»")
    redistribute = rules.get("naRedistributesWeight")
    if redistribute is not None and not isinstance(redistribute, bool):
        problems.append("rules.naRedistributesWeight: true или false")
    max_total = rules.get("maxTotal")
    if max_total is not None and (not is_number(max_total) or max_total <= 0):
        problems.append("rules.maxTotal: число больше 0")


def _check_criteria(criteria: object, problems: list[str]) -> set[str]:
    if not isinstance(criteria, list) or not criteria:
        problems.append("нужен хотя бы один критерий (criteria)")
        return set()
    if len(criteria) > MAX_CRITERIA:
        problems.append(f"критериев не больше {MAX_CRITERIA}")
        return set()
    ids: set[str] = set()
    for position, raw in enumerate(criteria, start=1):
        criterion_id = _check_criterion(position, raw, problems)
        if criterion_id is None:
            continue
        if criterion_id in ids:
            problems.append(f"id критерия «{criterion_id}» повторяется")
        ids.add(criterion_id)
    return ids


def _check_criterion(position: int, raw: object, problems: list[str]) -> str | None:
    if not isinstance(raw, Mapping):
        problems.append(f"критерий №{position}: ожидается объект")
        return None
    criterion_id = raw.get("id")
    if not is_valid_id(criterion_id):
        problems.append(
            f"критерий №{position}: id — латинские буквы, цифры, «_» и «-», до 64 символов"
        )
        return None
    label = f"критерий {criterion_id}"
    _check_title(raw.get("title"), f"{label}: название", problems)
    answer_type = raw.get("answerType")
    if answer_type not in ANSWER_TYPES:
        problems.append(f"{label}: answerType — «yes_no» или «scale»")
    weight = raw.get("weight")
    if not is_number(weight) or weight < 0:
        problems.append(f"{label}: вес — число не меньше 0")
    for flag in ("naAllowed", "scored", "critical"):
        if flag in raw and not isinstance(raw[flag], bool):
            problems.append(f"{label}: {flag} — true или false")
    for field, limit in (
        ("yes", MAX_TEXT_CHARS),
        ("no", MAX_TEXT_CHARS),
        ("na", MAX_TEXT_CHARS),
        ("guidance", MAX_GUIDANCE_CHARS),
    ):
        value = raw.get(field)
        if value is not None and (not isinstance(value, str) or len(value) > limit):
            problems.append(f"{label}: {field} — строка до {limit} символов")
    if answer_type == "yes_no" and not (isinstance(raw.get("yes"), str) and raw["yes"].strip()):
        problems.append(f"{label}: опишите условие «Да» (поле yes)")
    if answer_type == "scale":
        _check_scale(raw.get("scale"), label, problems)
    if raw.get("critical") is True and answer_type == "scale":
        problems.append(f"{label}: грубой ошибкой (critical) может быть только критерий «Да/Нет»")
    return criterion_id


def _check_scale(scale: object, label: str, problems: list[str]) -> None:
    if not isinstance(scale, list) or not MIN_SCALE_STEPS <= len(scale) <= MAX_SCALE_STEPS:
        problems.append(
            f"{label}: шкала — от {MIN_SCALE_STEPS} до {MAX_SCALE_STEPS} ступеней "
            "[{value, label}]"
        )
        return
    values: list[float] = []
    for step in scale:
        if not isinstance(step, Mapping) or not is_number(step.get("value")) or step["value"] < 0:
            problems.append(f"{label}: у каждой ступени шкалы value — число не меньше 0")
            return
        if not isinstance(step.get("label"), str) or not step["label"].strip():
            problems.append(f"{label}: у каждой ступени шкалы нужна подпись (label)")
            return
        values.append(step["value"])
    if len(set(values)) != len(values):
        problems.append(f"{label}: значения ступеней шкалы повторяются")
    if max(values) <= 0:
        problems.append(f"{label}: нужна ступень больше 0")


def _check_sections(sections: object, criterion_ids: set[str], problems: list[str]) -> None:
    if sections is None:
        return
    if not isinstance(sections, list) or len(sections) > MAX_SECTIONS:
        problems.append(f"sections: список до {MAX_SECTIONS} секций")
        return
    section_ids: set[str] = set()
    placed: dict[str, str] = {}
    for position, section in enumerate(sections, start=1):
        if not isinstance(section, Mapping) or not is_valid_id(section.get("id")):
            problems.append(f"секция №{position}: нужен объект с id (латиница, цифры, «_», «-»)")
            continue
        section_id = section["id"]
        if section_id in section_ids:
            problems.append(f"id секции «{section_id}» повторяется")
            continue
        section_ids.add(section_id)
        _check_title(section.get("title"), f"секция {section_id}: название", problems)
        refs = section.get("criteria")
        if not isinstance(refs, list):
            problems.append(f"секция {section_id}: criteria — список id критериев")
            continue
        for ref in refs:
            if not isinstance(ref, str) or ref not in criterion_ids:
                problems.append(
                    f"секция {section_id} ссылается на несуществующий критерий «{_short(ref)}»"
                )
            elif ref in placed:
                problems.append(f"критерий {ref} входит в две секции: {placed[ref]} и {section_id}")
            else:
                placed[ref] = section_id


def _plain_number(value: object) -> object:
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _short(value: object) -> str:
    text = value if isinstance(value, str) else repr(value)
    return text if len(text) <= _SHORT_CHARS else text[: _SHORT_CHARS - 1] + "…"
