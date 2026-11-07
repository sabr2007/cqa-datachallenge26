// Проверка черновика чек-листа перед сохранением. Ошибки блокируют сохранение, предупреждения — нет.
// Те же правила проверяет бэкенд (уникальные id, веса ≥ 0, шкала со ступенями, секции ссылаются на критерии);
// здесь они дублируются, чтобы сообщение появилось сразу у поля, а не после запроса.

import { CRITERION_ID_PATTERN, toNumber, weightSum } from "./model.js";

const DEFAULT_MAX_TOTAL = 100;
const MIN_SCALE_STEPS = 2;

/**
 * @typedef {{ level: "error" | "warning", scope: "doc" | "criterion" | "section", targetId: string, field: string, message: string }} Issue
 * @param {import("./model.js").DraftDoc} doc
 * @returns {{ errors: Issue[], warnings: Issue[], all: Issue[] }}
 */
export function validateDraft(doc) {
  const issues = [...docIssues(doc), ...doc.criteria.flatMap((c, i) => criterionIssues(c, i, doc)), ...sectionIssues(doc)];
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  return { errors, warnings, all: [...errors, ...warnings] };
}

function docIssues(doc) {
  const out = [];
  if (!doc.title.trim()) out.push(error("doc", "", "title", "Укажите название чек-листа."));
  if (doc.criteria.length === 0) {
    out.push(error("doc", "", "criteria", "В чек-листе нет ни одного критерия."));
    return out;
  }
  const scored = doc.criteria.filter((c) => c.scored && !c.critical);
  const sum = weightSum(doc);
  const maxTotal = Number.isFinite(doc.rules?.maxTotal) && doc.rules.maxTotal > 0 ? doc.rules.maxTotal : DEFAULT_MAX_TOTAL;
  if (scored.length === 0 || !(sum > 0)) {
    out.push(error("doc", "", "weights", "Нет критериев с весом больше 0 — итог не сможет посчитаться."));
  } else if (Math.abs(sum - maxTotal) > 1e-9) {
    out.push(warning("doc", "", "weights",
      `Сумма весов ${formatNumber(sum)}, а не ${formatNumber(maxTotal)}. Итог всё равно приводится к ${formatNumber(maxTotal)}: доля критерия = вес / ${formatNumber(sum)}.`));
  }
  return out;
}

function criterionIssues(c, position, doc) {
  const out = [];
  const id = c.id;
  if (!CRITERION_ID_PATTERN.test(id)) out.push(error("criterion", id, "id", "id критерия: латинские буквы, цифры, «_» и «-», до 32 символов."));
  if (doc.criteria.findIndex((other) => other.id === id) !== position) out.push(error("criterion", id, "id", `id «${id}» уже занят другим критерием.`));
  if (!c.title.trim()) out.push(error("criterion", id, "title", "Название критерия не заполнено."));

  if (!c.critical) {
    const weight = toNumber(c.weight);
    if (!Number.isFinite(weight) || weight < 0) out.push(error("criterion", id, "weight", "Вес — число не меньше 0, например 15 или 12,5."));
    else if (c.scored && weight === 0) out.push(warning("criterion", id, "weight", "Вес 0 — критерий не влияет на итог."));
  }

  if (c.answerType === "yes_no" && !c.yes.trim()) out.push(error("criterion", id, "yes", "Опишите, когда ставится «Да» — по этому условию оценивает модель."));
  if (c.naAllowed && !c.na.trim()) out.push(error("criterion", id, "na", "Опишите, когда критерий неприменим, или запретите N/A."));
  if (c.answerType === "scale") out.push(...scaleIssues(c));

  const homes = doc.sections.filter((s) => s.criteria.includes(id)).length;
  if (homes === 0) out.push(error("criterion", id, "section", "Критерий не входит ни в одну секцию."));
  if (homes > 1) out.push(error("criterion", id, "section", "Критерий входит в несколько секций."));
  return out;
}

function scaleIssues(c) {
  const out = [];
  const id = c.id;
  if (c.scale.length < MIN_SCALE_STEPS) {
    out.push(error("criterion", id, "scale", `У шкалы должно быть не меньше ${MIN_SCALE_STEPS} ступеней.`));
    return out;
  }
  const values = c.scale.map((step) => toNumber(step.value));
  c.scale.forEach((step, i) => {
    const value = values[i];
    if (!Number.isFinite(value) || value < 0) out.push(error("criterion", id, `scale.${i}.value`, "Значение ступени — число не меньше 0."));
    else if (values.indexOf(value) !== i) out.push(error("criterion", id, `scale.${i}.value`, `Ступень ${formatNumber(value)} повторяется.`));
    if (!String(step.label ?? "").trim()) out.push(error("criterion", id, `scale.${i}.label`, "Опишите, когда ставится эта ступень."));
  });
  const finite = values.filter(Number.isFinite);
  if (finite.length && !(Math.max(...finite) > 0)) out.push(error("criterion", id, "scale", "Верхняя ступень должна быть больше 0 — она даёт полный вес."));
  return out;
}

function sectionIssues(doc) {
  const out = [];
  const known = new Set(doc.criteria.map((c) => c.id));
  doc.sections.forEach((section, i) => {
    if (!section.title.trim()) out.push(error("section", section.id, "title", "Название секции не заполнено."));
    if (doc.sections.findIndex((s) => s.id === section.id) !== i) out.push(error("section", section.id, "id", `id секции «${section.id}» повторяется.`));
    if (section.criteria.some((id) => !known.has(id))) out.push(error("section", section.id, "criteria", "Секция ссылается на несуществующий критерий."));
    if (section.criteria.length === 0) out.push(warning("section", section.id, "criteria", "Секция пустая — добавьте критерий или удалите её."));
  });
  return out;
}

function error(scope, targetId, field, message) {
  return Object.freeze({ level: "error", scope, targetId, field, message });
}

function warning(scope, targetId, field, message) {
  return Object.freeze({ level: "warning", scope, targetId, field, message });
}

function formatNumber(n) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}
