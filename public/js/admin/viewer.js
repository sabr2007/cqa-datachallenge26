// Просмотр версии чек-листа: секции и критерии в стиле FAQ-аккордеона, условия, ступени шкалы, указания для ИИ.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { FORMS, countLabel, formatDecimal, formatInt, plural, speakerName } from "../format.js";
import { pill } from "../components/ui.js";
import { criterionLabel, toDraft, toNumber } from "./model.js";

/**
 * @param {object} rawDoc документ версии
 * @param {{ highlight?: Map<string, "new" | "changed"> }} [options] отметки «новый/изменён» относительно прошлой версии
 */
export function checklistView(rawDoc, { highlight = new Map() } = {}) {
  const doc = toDraft(rawDoc);
  return h("div", { className: "cqa-cl" },
    doc.sections.map((section, i) => sectionBlock(doc, section, i, highlight)),
    rulesCard(doc.rules));
}

function sectionBlock(doc, section, position, highlight) {
  const headingId = `cqa-a-view-section-${position}`;
  const criteria = section.criteria.map((id) => doc.criteria.find((c) => c.id === id)).filter(Boolean);
  const numbers = criteria.map((c) => criterionLabel(doc, c.id));
  const range = numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : numbers[0] ?? "";
  const scored = criteria.filter((c) => c.scored && !c.critical);
  const weight = scored.reduce((sum, c) => sum + (toNumber(c.weight) || 0), 0);
  const meta = [range, scored.length ? `${formatDecimal(weight)} ${plural(weight, FORMS.point)}` : "без баллов"].filter(Boolean).join(" · ");
  return h("section", { className: "cqa-cl-section", attrs: { "aria-labelledby": headingId } },
    h("div", { className: "cqa-cl-section__head" },
      h("h2", { className: "cqa-h2", attrs: { id: headingId }, text: section.title || "Без названия" }),
      h("p", { className: "cqa-cl-section__meta", text: meta })),
    criteria.length
      ? h("div", { className: "cqa-faq" }, criteria.map((c) => criterionItem(doc, c, highlight.get(c.id))))
      : h("p", { className: "cqa-a-empty-line", text: "В секции пока нет критериев." }));
}

function criterionItem(doc, criterion, mark) {
  return h("details", { className: "cqa-faq__item", dataset: { criterion: criterion.id } },
    h("summary", { className: "cqa-faq__summary cqa-hl" },
      h("span", { className: "cqa-faq__num", text: criterionLabel(doc, criterion.id) }),
      h("span", { className: "cqa-faq__title", text: criterion.title || "Без названия" }),
      icon("plus", { size: 24, className: "cqa-faq__plus" }),
      h("span", { className: "cqa-faq__chips" }, criterionChips(criterion, mark))),
    h("div", { className: "cqa-faq__body" },
      conditions(criterion),
      criterion.answerType === "scale" ? scaleList(criterion) : null,
      criterion.guidance.trim() ? guidanceBlock(criterion.guidance) : null));
}

/** Чипы критерия: тип, вес, N/A, грубая ошибка и отметка изменений. */
export function criterionChips(criterion, mark = null) {
  const values = criterion.scale.map((step) => toNumber(step.value)).filter(Number.isFinite);
  const typeLabel = criterion.answerType === "scale" && values.length
    ? `Шкала ${formatDecimal(Math.min(...values))}–${formatDecimal(Math.max(...values))}`
    : "Да / Нет";
  const weight = toNumber(criterion.weight);
  return [
    mark === "new" ? pill("Новый", { variant: "sm a-new" }) : null,
    mark === "changed" ? pill("Изменён", { variant: "sm a-changed" }) : null,
    pill(typeLabel, { variant: "gray sm" }),
    pill(criterion.critical ? "Без баллов" : `Вес ${Number.isFinite(weight) ? formatDecimal(weight) : "?"}`, { variant: "gray sm" }),
    pill(criterion.naAllowed ? "N/A допустим" : "Без N/A", { variant: criterion.naAllowed ? "gray sm" : "dashed sm" }),
    criterion.critical ? pill("Грубая ошибка", { variant: "gray sm", iconName: "alert" }) : null,
  ];
}

function conditions(criterion) {
  const isScale = criterion.answerType === "scale";
  return h("dl", { className: "cqa-cond" },
    isScale ? null : condition("yes", "Да", criterion.yes || "Условие не задано."),
    criterion.no ? condition("no", "Нет", criterion.no) : null,
    criterion.naAllowed
      ? condition("na", "N/A", criterion.na || "Критерий неприменим по условию.")
      : condition("na", "N/A", "Недопустим — критерий оценивается всегда.", true),
    criterion.critical ? condition("info", "Итог", "Баллов не даёт: грубая ошибка показывается отдельной отметкой.", true) : null);
}

function condition(kind, tag, text, muted = false) {
  return h("div", { className: `cqa-cond__row cqa-cond__row--${kind}` },
    h("dt", { className: "cqa-cond__tag", text: tag }),
    h("dd", { className: `cqa-cond__text${muted ? " cqa-cond__text--muted" : ""}`, text }));
}

function scaleList(criterion) {
  const steps = criterion.scale
    .map((step) => ({ value: toNumber(step.value), label: step.label }))
    .filter((step) => Number.isFinite(step.value))
    .sort((a, b) => b.value - a.value);
  const max = Math.max(...steps.map((step) => step.value), 0);
  const weight = toNumber(criterion.weight) || 0;
  return h("div", { className: "cqa-scale" },
    h("p", { className: "cqa-scale__title", text: "Ступени шкалы" }),
    h("ol", { className: "cqa-scale" }, steps.map((step) => {
      const points = max > 0 ? (step.value / max) * weight : 0;
      return h("li", { className: "cqa-scale__row" },
        h("span", { className: "cqa-scale__value", text: formatDecimal(step.value) }),
        h("span", { className: "cqa-scale__label", text: step.label }),
        h("span", { className: "cqa-scale__points", text: `= ${formatDecimal(points)} из ${formatDecimal(weight)}` }));
    })));
}

function guidanceBlock(text) {
  return h("div", { className: "cqa-a-guidance" },
    h("p", { className: "cqa-a-guidance__title", text: "Указания для ИИ-оценщика" }),
    h("p", { className: "cqa-a-guidance__text", text }));
}

function rulesCard(rules) {
  const items = describeRules(rules);
  if (!items.length) return null;
  return h("section", { className: "cqa-rules", attrs: { "aria-labelledby": "cqa-a-rules-title" } },
    h("h2", { className: "cqa-h3", attrs: { id: "cqa-a-rules-title" }, text: "Как считается итог" }),
    h("dl", { className: "cqa-rules__list" }, items.map(([key, value]) =>
      h("div", { className: "cqa-rules__item" }, h("dt", { className: "cqa-rules__key", text: key }), h("dd", { className: "cqa-rules__value", text: value })))));
}

function describeRules(rules = {}) {
  const out = [["Баллы", "«Да» — полный вес, «Нет» — 0, шкала — пропорционально весу"]];
  if (Number.isFinite(rules.maxTotal)) out.push(["Максимум", `${formatInt(rules.maxTotal)} ${plural(rules.maxTotal, FORMS.point)}`]);
  if (rules.naRedistributesWeight === true) out.push(["N/A", "Вес перераспределяется между применимыми критериями"]);
  if (rules.rounding && Number.isFinite(rules.rounding.decimals)) {
    const mode = rules.rounding.mode === "half_up" ? ", половина вверх" : "";
    out.push(["Округление", `До ${rules.rounding.decimals} знаков${mode}`]);
  }
  if (Number.isFinite(rules.firstResponseThresholdSec)) {
    const sec = rules.firstResponseThresholdSec;
    out.push(["Порог первой реакции", sec % 60 === 0 ? `${sec / 60} мин` : countLabel(sec, FORMS.second)]);
  }
  if (Array.isArray(rules.contextSpeakers) && rules.contextSpeakers.length) {
    out.push(["Только контекст", rules.contextSpeakers.map((s) => speakerName(s).toLowerCase()).join(", ")]);
  }
  if (rules.ignoreTagsAndAttachments === true) out.push(["Теги и вложения", "Не учитываются"]);
  return out;
}
