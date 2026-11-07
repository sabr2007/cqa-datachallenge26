// Сравнение двух версий чек-листа: что добавлено, изменено и удалено (по критериям, секциям и правилам).
// Чистые функции; на входе — документы версий или черновики (приводятся к черновику через toDraft).

import { criterionLabel, toDraft, toNumber } from "./model.js";

export const FIELD_LABELS = Object.freeze({
  title: "Название",
  answerType: "Тип ответа",
  weight: "Вес",
  naAllowed: "N/A",
  yes: "Условие «Да»",
  no: "Условие «Нет»",
  na: "Условие N/A",
  scale: "Ступени шкалы",
  guidance: "Указания для ИИ-оценщика",
  critical: "Грубая ошибка",
  section: "Секция",
});

/** Короткие подписи полей для заметки к версии (в середине предложения). */
const SHORT_LABELS = Object.freeze({
  title: "название",
  answerType: "тип ответа",
  weight: "вес",
  naAllowed: "N/A",
  yes: "условие «Да»",
  no: "условие «Нет»",
  na: "условие N/A",
  scale: "шкала",
  guidance: "указания для ИИ",
  critical: "грубая ошибка",
  section: "секция",
});

const TEXT_FIELDS = Object.freeze(["title", "yes", "no", "na", "guidance"]);
const LONG_FIELDS = new Set(["yes", "no", "na", "guidance", "scale"]);

/**
 * @typedef {{ field: string, label: string, before: string, after: string, long: boolean }} FieldChange
 * @typedef {{ id: string, num: string, title: string, section: string }} CriterionRef
 * @typedef {{ added: CriterionRef[], removed: CriterionRef[], changed: Array<CriterionRef & { changes: FieldChange[] }>,
 *   sections: Array<{ kind: "added" | "removed" | "renamed", id: string, before: string, after: string }>,
 *   title: { before: string, after: string } | null, reordered: boolean, rules: FieldChange[], isEmpty: boolean }} ChecklistDiff
 * @param {object} beforeRaw @param {object} afterRaw
 * @returns {ChecklistDiff}
 */
export function diffChecklists(beforeRaw, afterRaw) {
  const before = toDraft(beforeRaw);
  const after = toDraft(afterRaw);
  const beforeById = new Map(before.criteria.map((c) => [c.id, c]));
  const afterById = new Map(after.criteria.map((c) => [c.id, c]));
  const ref = (doc, c) => ({ id: c.id, num: criterionLabel(doc, c.id), title: c.title.trim() || "Без названия", section: sectionTitle(doc, c.id) });

  const added = after.criteria.filter((c) => !beforeById.has(c.id)).map((c) => ({ ...ref(after, c), details: addedDetails(c) }));
  const removed = before.criteria.filter((c) => !afterById.has(c.id)).map((c) => ref(before, c));
  const changed = after.criteria
    .filter((c) => beforeById.has(c.id))
    .map((c) => ({ ...ref(after, c), changes: criterionChanges(beforeById.get(c.id), c, before, after) }))
    .filter((entry) => entry.changes.length > 0);

  const common = (doc, other) => doc.criteria.map((c) => c.id).filter((id) => other.has(id));
  const reordered = common(before, afterById).join("|") !== common(after, beforeById).join("|");
  const title = before.title.trim() !== after.title.trim() ? { before: before.title.trim(), after: after.title.trim() } : null;
  const sections = sectionChanges(before, after);
  const rules = ruleChanges(before.rules, after.rules);
  const isEmpty = !added.length && !removed.length && !changed.length && !sections.length && !title && !reordered && !rules.length;
  return { added, removed, changed, sections, title, reordered, rules, isEmpty };
}

/** Короткое описание для заметки к версии: «Добавлен 09 «…»; изменены 01 (вес); удалён 05 «…»». */
export function summarizeDiff(diff) {
  const parts = [];
  if (diff.added.length) parts.push(`${diff.added.length > 1 ? "добавлены" : "добавлен"} ${diff.added.map((c) => `${c.num} «${shorten(c.title)}»`).join(", ")}`);
  if (diff.changed.length) {
    const list = diff.changed.map((c) => `${c.num} (${c.changes.map((ch) => SHORT_LABELS[ch.field] ?? ch.label.toLowerCase()).join(", ")})`).join(", ");
    parts.push(`${diff.changed.length > 1 ? "изменены" : "изменён"} ${list}`);
  }
  if (diff.removed.length) parts.push(`${diff.removed.length > 1 ? "удалены" : "удалён"} ${diff.removed.map((c) => `${c.num} «${shorten(c.title)}»`).join(", ")}`);
  if (diff.sections.length) parts.push("изменены секции");
  if (diff.reordered && !parts.length) parts.push("изменён порядок критериев");
  if (diff.title) parts.push("изменено название");
  const text = parts.join("; ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/** id критериев, которые нужно оценить заново: добавленные и изменённые. */
export function touchedCriteria(diff) {
  return new Set([...diff.added.map((c) => c.id), ...diff.changed.map((c) => c.id)]);
}

/* ---------- поля критерия ---------- */

/** Ключевые поля нового критерия для сравнения версий: тип, вес, N/A, условия. */
function addedDetails(c) {
  const out = [
    change("answerType", "—", answerTypeName(c.answerType)),
    change("weight", "—", c.critical ? "без баллов (грубая ошибка)" : numberText(c.weight)),
    change("naAllowed", "—", c.naAllowed ? "допустим" : "недопустим"),
  ];
  if (c.answerType === "scale") out.push(change("scale", "—", scaleText(c.scale)));
  for (const field of ["yes", "no", "na", "guidance"]) {
    if (field === "na" && !c.naAllowed) continue;
    const value = String(c[field] ?? "").trim();
    if (value) out.push(change(field, "—", value));
  }
  return out.map((item) => ({ ...item, added: true }));
}

function criterionChanges(b, a, beforeDoc, afterDoc) {
  const out = [];
  for (const field of TEXT_FIELDS) {
    if (field === "na" && !b.naAllowed && !a.naAllowed) continue;
    const before = String(b[field] ?? "").trim();
    const after = String(a[field] ?? "").trim();
    if (before !== after) out.push(change(field, before || "—", after || "—"));
  }
  if (b.answerType !== a.answerType) out.push(change("answerType", answerTypeName(b.answerType), answerTypeName(a.answerType)));
  if (!(b.critical && a.critical) && !sameNumber(b.weight, a.weight)) out.push(change("weight", numberText(b.weight), numberText(a.weight)));
  if (b.naAllowed !== a.naAllowed) out.push(change("naAllowed", b.naAllowed ? "допустим" : "недопустим", a.naAllowed ? "допустим" : "недопустим"));
  if (b.critical !== a.critical) out.push(change("critical", b.critical ? "да, без баллов" : "нет", a.critical ? "да, без баллов" : "нет"));
  if (a.answerType === "scale" || b.answerType === "scale") {
    const before = b.answerType === "scale" ? scaleText(b.scale) : "—";
    const after = a.answerType === "scale" ? scaleText(a.scale) : "—";
    if (before !== after) out.push(change("scale", before, after));
  }
  const sectionBefore = sectionTitle(beforeDoc, b.id);
  const sectionAfter = sectionTitle(afterDoc, a.id);
  if (sectionBefore !== sectionAfter) out.push(change("section", sectionBefore || "—", sectionAfter || "—"));
  return out;
}

function change(field, before, after) {
  return Object.freeze({ field, label: FIELD_LABELS[field] ?? field, before, after, long: LONG_FIELDS.has(field) });
}

function sectionChanges(before, after) {
  const beforeById = new Map(before.sections.map((s) => [s.id, s]));
  const afterById = new Map(after.sections.map((s) => [s.id, s]));
  return [
    ...after.sections.filter((s) => !beforeById.has(s.id)).map((s) => ({ kind: "added", id: s.id, before: "", after: s.title.trim() })),
    ...before.sections.filter((s) => !afterById.has(s.id)).map((s) => ({ kind: "removed", id: s.id, before: s.title.trim(), after: "" })),
    ...after.sections.filter((s) => beforeById.has(s.id) && beforeById.get(s.id).title.trim() !== s.title.trim())
      .map((s) => ({ kind: "renamed", id: s.id, before: beforeById.get(s.id).title.trim(), after: s.title.trim() })),
  ];
}

function ruleChanges(before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return keys
    .filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
    .map((key) => change(key, ruleText(before?.[key]), ruleText(after?.[key])));
}

function ruleText(value) {
  if (value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function sectionTitle(doc, criterionId) {
  return doc.sections.find((s) => s.criteria.includes(criterionId))?.title.trim() ?? "";
}

function scaleText(scale) {
  return [...scale]
    .map((step) => ({ value: toNumber(step.value), label: String(step.label ?? "").trim() }))
    .sort((x, y) => y.value - x.value)
    .map((step) => `${numberText(step.value)} — ${step.label || "без описания"}`)
    .join("\n");
}

function answerTypeName(type) {
  return type === "scale" ? "Шкала" : "Да / Нет";
}

function sameNumber(x, y) {
  const a = toNumber(x);
  const b = toNumber(y);
  return (Number.isNaN(a) && Number.isNaN(b)) || a === b;
}

function numberText(value) {
  const n = toNumber(value);
  return Number.isFinite(n) ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n) : String(value ?? "—");
}

function shorten(text, max = 40) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
