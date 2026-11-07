// Модель черновика чек-листа: нормализация, неизменяемые операции редактора и тело запроса на сохранение.
// Чистые функции без DOM — каждая операция возвращает новый документ (схема — docs/CONTRACT.md, «Схема чек-листа»).

export const CRITERION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_SCALE = Object.freeze([
  Object.freeze({ value: 10, label: "Выполнено полностью." }),
  Object.freeze({ value: 5, label: "Выполнено частично." }),
  Object.freeze({ value: 0, label: "Не выполнено." }),
]);
const SERVER_FIELDS = Object.freeze(["version", "created_at", "note", "sandbox", "checklist_id"]);
const TEXT_FIELDS = Object.freeze(["yes", "no", "na", "guidance"]);

/**
 * @typedef {{ value: number | string, label: string }} ScaleStep
 * @typedef {{ id: string, title: string, answerType: "yes_no" | "scale", weight: number | string, naAllowed: boolean,
 *   yes: string, no: string, na: string, guidance: string, scale: ScaleStep[], scored: boolean, critical: boolean }} DraftCriterion
 * @typedef {{ id: string, title: string, criteria: string[] }} DraftSection
 * @typedef {{ id: string, title: string, rules: object, sections: DraftSection[], criteria: DraftCriterion[] }} DraftDoc
 */

/**
 * Черновик из документа версии: все поля критериев заполнены, критерии вне секций собраны в «Без секции».
 * Неизвестные поля документа и критериев сохраняются, чтобы не терять данные при сохранении.
 * @param {object} raw @returns {DraftDoc}
 */
export function toDraft(raw) {
  const source = isObject(raw) ? raw : {};
  const rest = Object.fromEntries(Object.entries(source).filter(([key]) => !SERVER_FIELDS.includes(key)));
  const criteria = (Array.isArray(source.criteria) ? source.criteria : []).filter(isObject).map(toDraftCriterion);
  const known = new Set(criteria.map((c) => c.id));
  const sections = (Array.isArray(source.sections) ? source.sections : []).filter(isObject).map((section, i) => ({
    ...section,
    id: str(section.id) || `s${i + 1}`,
    title: str(section.title),
    criteria: (Array.isArray(section.criteria) ? section.criteria : []).filter((id) => typeof id === "string" && known.has(id)),
  }));
  const placed = new Set(sections.flatMap((s) => s.criteria));
  const orphans = criteria.filter((c) => !placed.has(c.id)).map((c) => c.id);
  return {
    ...rest,
    id: str(source.id),
    title: str(source.title),
    rules: isObject(source.rules) ? source.rules : {},
    sections: orphans.length ? [...sections, { id: uniqueSectionId(sections), title: "Без секции", criteria: orphans }] : sections,
    criteria,
  };
}

function toDraftCriterion(raw) {
  const critical = raw.critical === true;
  return {
    ...raw,
    id: str(raw.id),
    title: str(raw.title),
    answerType: raw.answerType === "scale" ? "scale" : "yes_no",
    weight: typeof raw.weight === "number" && Number.isFinite(raw.weight) ? raw.weight : 0,
    naAllowed: raw.naAllowed === true,
    yes: str(raw.yes),
    no: str(raw.no),
    na: str(raw.na),
    guidance: str(raw.guidance),
    scale: (Array.isArray(raw.scale) ? raw.scale : []).filter(isObject).map((step) => ({ value: step.value, label: str(step.label) })),
    scored: raw.scored !== false && !critical,
    critical,
  };
}

/**
 * Тело POST /api/checklists/{id}/versions: документ без служебных полей + note (+ sandbox для песочницы).
 * Пустые необязательные поля не отправляются, шкала — только у шкальных критериев, ступени по убыванию.
 * @param {DraftDoc} draft @param {{ note?: string, sandbox?: boolean }} [meta]
 */
export function toPayload(draft, { note = "", sandbox = false } = {}) {
  const criteria = draft.criteria.map((c) => {
    const { scale, scored, critical, weight, ...rest } = c;
    // Тексты не обрезаются: у неизменённого критерия должен остаться тот же отпечаток определения
    // (движок по нему решает, можно ли взять ответ из прошлой оценки, — app/engine/reuse.py).
    const out = { ...rest, title: c.title, weight: critical ? 0 : toNumber(weight) };
    for (const field of TEXT_FIELDS) {
      const value = str(c[field]);
      if (value.trim() && (field !== "na" || c.naAllowed)) out[field] = value;
      else delete out[field];
    }
    if (c.answerType === "scale") {
      out.scale = scale.map((step) => ({ value: toNumber(step.value), label: str(step.label) })).sort((a, b) => b.value - a.value);
    }
    if (critical) Object.assign(out, { critical: true, scored: false });
    else if (scored === false) out.scored = false;
    return out;
  });
  const sections = draft.sections.map((s) => ({ ...s, criteria: [...s.criteria] }));
  return {
    ...draft,
    sections,
    criteria,
    note: note.trim(),
    ...(sandbox ? { sandbox: true } : {}),
  };
}

/* ---------- критерии ---------- */

/** @returns {DraftCriterion | undefined} */
export function findCriterion(doc, id) {
  return doc.criteria.find((c) => c.id === id);
}

export function sectionOf(doc, criterionId) {
  return doc.sections.find((s) => s.criteria.includes(criterionId));
}

/** Номер критерия для людей: «04» из «c04», иначе — позиция в документе. */
export function criterionLabel(doc, id) {
  const match = /(\d+)$/.exec(id);
  if (match) return match[1].padStart(2, "0");
  return String(doc.criteria.findIndex((c) => c.id === id) + 1).padStart(2, "0");
}

/** @param {DraftDoc} doc @param {string} id @param {Partial<DraftCriterion>} patch */
export function updateCriterion(doc, id, patch) {
  return { ...doc, criteria: doc.criteria.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

/** Смена типа ответа; у новой шкалы появляются три ступени-заготовки, старая шкала сохраняется в черновике. */
export function setAnswerType(doc, id, answerType) {
  const criterion = findCriterion(doc, id);
  if (!criterion) return doc;
  const scale = answerType === "scale" && criterion.scale.length === 0 ? DEFAULT_SCALE.map((s) => ({ ...s })) : criterion.scale;
  return updateCriterion(doc, id, { answerType: answerType === "scale" ? "scale" : "yes_no", scale });
}

/** «Грубая ошибка»: отдельная отметка без баллов (scored=false, вес 0). */
export function setCritical(doc, id, critical) {
  return updateCriterion(doc, id, critical ? { critical: true, scored: false, weight: 0 } : { critical: false, scored: true });
}

/** Следующий свободный id вида c09 — с учётом занятых в этой и прошлых версиях, чтобы id не переиспользовались. */
export function nextCriterionId(doc, reservedIds = []) {
  const taken = new Set([...doc.criteria.map((c) => c.id), ...reservedIds]);
  const numbers = [...taken].map((id) => /^c(\d+)$/.exec(id)).filter(Boolean).map((m) => Number(m[1]));
  let next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  while (taken.has(`c${String(next).padStart(2, "0")}`)) next += 1;
  return `c${String(next).padStart(2, "0")}`;
}

/**
 * Новый пустой критерий в конец секции (или сразу после afterId).
 * @returns {{ doc: DraftDoc, id: string }}
 */
export function addCriterion(doc, sectionId, { reservedIds = [], afterId = null, template = {} } = {}) {
  const id = nextCriterionId(doc, reservedIds);
  const criterion = toDraftCriterion({ answerType: "yes_no", weight: 0, naAllowed: false, ...template, id, title: str(template.title) });
  const targetId = doc.sections.some((s) => s.id === sectionId) ? sectionId : doc.sections.at(-1)?.id;
  const sections = targetId
    ? doc.sections.map((s) => (s.id === targetId ? { ...s, criteria: insertAfter(s.criteria, id, afterId) } : s))
    : [{ id: uniqueSectionId(doc.sections), title: "Критерии", criteria: [id] }];
  const position = afterId ? doc.criteria.findIndex((c) => c.id === afterId) + 1 : doc.criteria.length;
  const criteria = [...doc.criteria.slice(0, position), criterion, ...doc.criteria.slice(position)];
  return { doc: { ...doc, sections, criteria }, id };
}

/**
 * Замена критерия: новый id на том же месте и в той же секции, вес, тип, N/A и шкала — от заменённого,
 * формулировки — пустые. Новый id гарантирует, что движок оценит критерий заново.
 * @returns {{ doc: DraftDoc, id: string }}
 */
export function replaceCriterion(doc, oldId, { reservedIds = [] } = {}) {
  const old = findCriterion(doc, oldId);
  const section = sectionOf(doc, oldId);
  if (!old || !section) return { doc, id: oldId };
  const template = { answerType: old.answerType, weight: old.weight, naAllowed: old.naAllowed, scale: old.scale.map((s) => ({ ...s })), critical: old.critical, scored: old.scored };
  const added = addCriterion(doc, section.id, { reservedIds: [...reservedIds, oldId], afterId: oldId, template });
  return { doc: removeCriterion(added.doc, oldId), id: added.id };
}

export function removeCriterion(doc, id) {
  return {
    ...doc,
    criteria: doc.criteria.filter((c) => c.id !== id),
    sections: doc.sections.map((s) => (s.criteria.includes(id) ? { ...s, criteria: s.criteria.filter((x) => x !== id) } : s)),
  };
}

/**
 * Сдвиг на одну позицию; на границе секции критерий переходит в соседнюю секцию.
 * Порядок critera[] в документе следует порядку секций.
 * @param {-1 | 1} direction
 */
export function moveCriterion(doc, id, direction) {
  const index = doc.sections.findIndex((s) => s.criteria.includes(id));
  if (index === -1) return doc;
  const section = doc.sections[index];
  const position = section.criteria.indexOf(id);
  const target = position + direction;
  let sections;
  if (target >= 0 && target < section.criteria.length) {
    sections = doc.sections.map((s, i) => (i === index ? { ...s, criteria: swap(s.criteria, position, target) } : s));
  } else {
    const neighbour = index + direction;
    if (neighbour < 0 || neighbour >= doc.sections.length) return doc;
    sections = doc.sections.map((s, i) => {
      if (i === index) return { ...s, criteria: s.criteria.filter((x) => x !== id) };
      if (i === neighbour) return { ...s, criteria: direction < 0 ? [...s.criteria, id] : [id, ...s.criteria] };
      return s;
    });
  }
  return withCriteriaInSectionOrder({ ...doc, sections });
}

/** Перенос критерия в другую секцию (в конец). */
export function moveCriterionToSection(doc, id, sectionId) {
  if (!doc.sections.some((s) => s.id === sectionId) || sectionOf(doc, id)?.id === sectionId) return doc;
  const sections = doc.sections.map((s) => {
    if (s.id === sectionId) return { ...s, criteria: [...s.criteria.filter((x) => x !== id), id] };
    return s.criteria.includes(id) ? { ...s, criteria: s.criteria.filter((x) => x !== id) } : s;
  });
  return withCriteriaInSectionOrder({ ...doc, sections });
}

/** Может ли критерий сдвинуться: { up, down } с учётом перехода между секциями. */
export function canMove(doc, id) {
  const index = doc.sections.findIndex((s) => s.criteria.includes(id));
  if (index === -1) return { up: false, down: false };
  const position = doc.sections[index].criteria.indexOf(id);
  const last = doc.sections[index].criteria.length - 1;
  return { up: position > 0 || index > 0, down: position < last || index < doc.sections.length - 1 };
}

/* ---------- ступени шкалы ---------- */

export function updateScaleStep(doc, id, stepIndex, patch) {
  const criterion = findCriterion(doc, id);
  if (!criterion) return doc;
  return updateCriterion(doc, id, { scale: criterion.scale.map((step, i) => (i === stepIndex ? { ...step, ...patch } : step)) });
}

export function addScaleStep(doc, id) {
  const criterion = findCriterion(doc, id);
  if (!criterion) return doc;
  return updateCriterion(doc, id, { scale: [...criterion.scale, { value: freeStepValue(criterion.scale), label: "" }] });
}

/** Значение новой ступени: середина самого большого промежутка между ступенями (10, 5, 0 → 7), иначе 0 или «выше верхней». */
function freeStepValue(scale) {
  const values = [...new Set(scale.map((s) => toNumber(s.value)).filter(Number.isFinite))].sort((a, b) => b - a);
  if (!values.length) return 10;
  if (values.at(-1) > 0) return 0;
  let best = null;
  for (let i = 0; i < values.length - 1; i += 1) {
    const middle = Math.floor((values[i] + values[i + 1]) / 2);
    if (values[i] - values[i + 1] > 1 && !values.includes(middle) && (!best || values[i] - values[i + 1] > best.gap)) best = { gap: values[i] - values[i + 1], middle };
  }
  return best ? best.middle : values[0] + 1;
}

export function removeScaleStep(doc, id, stepIndex) {
  const criterion = findCriterion(doc, id);
  if (!criterion) return doc;
  return updateCriterion(doc, id, { scale: criterion.scale.filter((_, i) => i !== stepIndex) });
}

/* ---------- секции ---------- */

/** @returns {{ doc: DraftDoc, id: string }} */
export function addSection(doc, title = "Новая секция") {
  const id = uniqueSectionId(doc.sections);
  return { doc: { ...doc, sections: [...doc.sections, { id, title, criteria: [] }] }, id };
}

export function renameSection(doc, sectionId, title) {
  return { ...doc, sections: doc.sections.map((s) => (s.id === sectionId ? { ...s, title } : s)) };
}

/** Удаляется только пустая секция — критерии сначала переносят, чтобы ничего не потерять случайно. */
export function removeSection(doc, sectionId) {
  const section = doc.sections.find((s) => s.id === sectionId);
  if (!section || section.criteria.length > 0) return doc;
  return { ...doc, sections: doc.sections.filter((s) => s.id !== sectionId) };
}

/** @param {-1 | 1} direction */
export function moveSection(doc, sectionId, direction) {
  const index = doc.sections.findIndex((s) => s.id === sectionId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= doc.sections.length) return doc;
  return withCriteriaInSectionOrder({ ...doc, sections: swap(doc.sections, index, target) });
}

/* ---------- вспомогательное ---------- */

/** Сумма весов критериев, входящих в итог. */
export function weightSum(doc) {
  return doc.criteria.filter((c) => c.scored && !c.critical).reduce((sum, c) => sum + (Number.isFinite(toNumber(c.weight)) ? toNumber(c.weight) : 0), 0);
}

/** Число из поля формы: "12,5" → 12.5; пустое или нечисло → NaN. */
export function toNumber(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim().replace(",", ".");
  if (text === "" || !/^-?\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Number(text);
}

function withCriteriaInSectionOrder(doc) {
  const order = doc.sections.flatMap((s) => s.criteria);
  const rank = new Map(order.map((id, i) => [id, i]));
  const criteria = [...doc.criteria].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  return { ...doc, criteria };
}

function insertAfter(list, id, afterId) {
  const position = afterId ? list.indexOf(afterId) : -1;
  if (position === -1) return [...list, id];
  return [...list.slice(0, position + 1), id, ...list.slice(position + 1)];
}

function swap(list, i, j) {
  const copy = [...list];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}

function uniqueSectionId(sections) {
  const taken = new Set(sections.map((s) => s.id));
  let n = sections.length + 1;
  while (taken.has(`s${n}`)) n += 1;
  return `s${n}`;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value) {
  return typeof value === "string" ? value : "";
}
