// Результат оценки диалога: итог (и пересчёт после апелляции), грубая ошибка, секции и критерии
// с обоснованием, кликабельными репликами-доказательствами, проверенным участком, причиной N/A,
// флагами «нужна проверка» / голосами моделей и апелляцией по критерию. Данные — только textContent.

import { modelLabel } from "../api.js";
import { h } from "../dom.js";
import { icon } from "../icons.js";
import {
  FORMS, answerLabel, countLabel, criterionNumber, formatCost, formatDateTime, formatElapsedMs, formatInt, formatPoints, messageNumber,
} from "../format.js";
import { answerTone, criticalState, maxStepOf } from "../evaluation.js";
import { appealForm, appealStatus } from "./appealForm.js";
import { statusPill } from "./ui.js";

const REF_PATTERN = /#(\d{1,5})/g;
const REVIEW_HINT = "Модели разошлись во мнениях или цитата не нашлась в реплике — решение за человеком";

export const criterionDomId = (id) => `cqa-crit-${id}`;

/**
 * @param {object} evaluation оценка (api.js)
 * @param {{
 *   checklist: object | null,
 *   canAppeal: boolean,
 *   isCall: boolean,
 *   onEvidence: (index: number) => void,
 *   onRange: (range: readonly [number, number]) => void,
 *   onAppeal: (criterion: object, comment: string) => Promise<object>,
 *   appealHref: (appealId: string) => string,
 * }} ctx
 * @returns {{ el: HTMLElement, reveal: (criterionId: string) => void }}
 */
export function evaluationResult(evaluation, ctx) {
  const docs = new Map((ctx.checklist?.criteria ?? []).map((criterion) => [criterion.id, criterion]));
  const rows = new Map();
  const state = criticalState(evaluation);
  const review = evaluation.criteria.filter((criterion) => criterion.needsReview);
  const groupEls = groupCriteria(evaluation, ctx.checklist).map((group) =>
    sectionGroup(group, (criterion) => {
      const row = criterionRow(criterion, docs.get(criterion.criterionId) ?? null, ctx);
      rows.set(criterion.criterionId, row);
      return row;
    }));

  const el = h("div", { className: "cqa-result" },
    scoreBlock(evaluation),
    criticalBanner(evaluation, state, ctx),
    review.length ? reviewNotice(review, reveal) : null,
    evaluation.status === "error" ? h("p", { className: "cqa-result__error", attrs: { role: "alert" },
      text: `Оценка завершилась с ошибкой: ${evaluation.error || "часть критериев не оценена"}.` }) : null,
    h("div", { className: "cqa-result__groups" }, groupEls),
    metaBlock(evaluation));

  function reveal(criterionId) {
    const row = rows.get(criterionId);
    if (!row) return;
    const details = row.closest("details");
    if (details) details.open = true;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row.classList.remove("is-target");
    void row.offsetWidth; // перезапуск подсветки
    row.classList.add("is-target");
    row.querySelector(".cqa-crit__title")?.focus({ preventScroll: true });
  }

  return { el, reveal };
}

/* ---------- итог, грубая ошибка, «нужна проверка» ---------- */

function scoreBlock(evaluation) {
  const final = evaluation.finalTotal;
  const changed = final !== evaluation.total && evaluation.total !== null;
  if (final === null) {
    return h("div", { className: "cqa-score" },
      h("p", { className: "cqa-score__line" }, h("span", { className: "cqa-score__value cqa-score__value--none", text: "—" }), h("span", { className: "cqa-score__max", text: "/ 100" })),
      h("p", { className: "cqa-score__note", text: "Итог не считается: нет применимых критериев с весом." }));
  }
  const band = final < 60 ? "low" : final >= 80 ? "high" : "mid";
  const label = changed
    ? `Итог ${formatPoints(final)} из 100 после решения по апелляции, исходно ${formatPoints(evaluation.total)}`
    : `Итог ${formatPoints(final)} из 100`;
  return h("div", { className: "cqa-score" },
    h("p", { className: "cqa-score__line", attrs: { "aria-label": label } },
      changed ? h("span", { className: "cqa-score__was", attrs: { "aria-hidden": "true" } },
        h("s", { text: formatPoints(evaluation.total) }), icon("arrowRight", { size: 18 })) : null,
      h("span", { className: `cqa-score__value cqa-score__value--${band}`, attrs: { "aria-hidden": "true" }, text: formatPoints(final) }),
      h("span", { className: "cqa-score__max", attrs: { "aria-hidden": "true" }, text: "/ 100" })),
    changed ? h("p", { className: "cqa-score__note", text: "Итог пересчитан после решения проверяющего по апелляции" }) : null);
}

function criticalBanner(evaluation, state, ctx) {
  if (!state.now) {
    return state.before
      ? h("p", { className: "cqa-critical-cleared" }, icon("check", { size: 16 }), "Грубая ошибка снята решением по апелляции")
      : null;
  }
  const criterion = state.criteria.find((c) => c.finalAnswer === "yes") ?? null;
  const note = evaluation.criticalNote || criterion?.explanation || "Отмечено нарушение по критерию «Грубые ошибки».";
  const extra = criterion?.explanation && criterion.explanation !== note ? criterion.explanation : "";
  return h("section", { className: "cqa-critical", attrs: { "aria-labelledby": "cqa-critical-title" } },
    h("h3", { className: "cqa-critical__title", attrs: { id: "cqa-critical-title" } }, icon("alert", { size: 20 }), "Грубая ошибка"),
    h("p", { className: "cqa-critical__text" }, linkify(note, ctx)),
    extra ? h("p", { className: "cqa-critical__extra" }, linkify(extra, ctx)) : null,
    criterion?.evidence.length ? h("div", { className: "cqa-chips" }, criterion.evidence.map((e) => evidenceChip(e, ctx))) : null);
}

function reviewNotice(criteria, reveal) {
  return h("div", { className: "cqa-review-note" },
    statusPill("review", "Нужна проверка", REVIEW_HINT),
    h("p", {},
      `${countLabel(criteria.length, FORMS.criterion)}: `,
      criteria.map((criterion, i) => [i ? ", " : "", h("button", {
        className: "cqa-linkbtn", attrs: { type: "button", title: `Показать критерий «${criterion.title}»` },
        on: { click: () => reveal(criterion.criterionId) },
      }, criterionNumber(criterion.criterionId, i))]),
      " — модели разошлись или цитата не подтвердилась."));
}

/* ---------- секции и критерии ---------- */

function groupCriteria(evaluation, checklist) {
  const sections = new Map(evaluation.sections.map((section) => [section.id, section]));
  const byId = new Map(evaluation.criteria.map((criterion) => [criterion.criterionId, criterion]));
  if (!checklist?.sections.length) {
    return [{ id: "all", title: "Критерии", summary: null, items: evaluation.criteria }];
  }
  const used = new Set();
  const groups = checklist.sections.map((section) => {
    const items = section.criteria.map((c) => byId.get(c.id)).filter(Boolean);
    items.forEach((c) => used.add(c.criterionId));
    const summary = sections.get(section.id) ?? null;
    return { id: section.id, title: summary?.title || section.title, summary, items };
  }).filter((group) => group.items.length);
  const rest = evaluation.criteria.filter((c) => !used.has(c.criterionId));
  return rest.length ? [...groups, { id: "other", title: "Другие критерии", summary: null, items: rest }] : groups;
}

function sectionGroup(group, renderRow) {
  const summary = group.summary;
  const max = summary?.finalMaxPoints ?? summary?.maxPoints ?? null;
  const points = summary?.finalPoints ?? null;
  const share = max ? Math.max(0, Math.min(1, (points ?? 0) / max)) : 0;
  return h("section", { className: "cqa-sec", attrs: { "aria-label": group.title } },
    h("div", { className: "cqa-sec__head" },
      h("h3", { className: "cqa-sec__title", text: group.title }),
      summary ? h("span", { className: "cqa-sec__points cqa-num", text: max === null ? "без баллов" : `${formatPoints(points)} / ${formatPoints(max)}` }) : null),
    max ? h("div", { className: "cqa-sec__bar", attrs: { "aria-hidden": "true" } },
      h("span", { className: "cqa-sec__fill", vars: { "--cqa-p": share.toFixed(3) } })) : null,
    h("ol", { className: "cqa-crits" }, group.items.map(renderRow)));
}

function criterionRow(criterion, doc, ctx) {
  const maxStep = maxStepOf(doc) ?? inferMaxStep(criterion);
  const tone = answerTone(criterion.finalAnswer, { critical: criterion.critical, maxStep });
  const changed = criterion.finalAnswer !== criterion.answer;
  const label = (value) => answerLabel(value, { critical: criterion.critical, maxStep });
  const step = typeof criterion.finalAnswer === "number" ? doc?.scale.find((s) => s.value === criterion.finalAnswer) : null;
  const titleId = `${criterionDomId(criterion.criterionId)}-title`;

  return h("li", { className: `cqa-crit cqa-crit--${tone}`, attrs: { id: criterionDomId(criterion.criterionId), "aria-labelledby": titleId } },
    h("div", { className: "cqa-crit__head" },
      h("span", { className: "cqa-crit__num", attrs: { "aria-hidden": "true" }, text: criterionNumber(criterion.criterionId, 0) }),
      h("h4", { className: "cqa-crit__title", attrs: { id: titleId, tabindex: "-1" } },
        h("span", { className: "cqa-sr-only", text: `Критерий ${criterionNumber(criterion.criterionId, 0)}: ` }), criterion.title),
      h("span", { className: `cqa-answer cqa-answer--${tone}` },
        changed ? h("s", { className: "cqa-answer__was", text: label(criterion.answer) }) : null,
        changed ? h("span", { className: "cqa-sr-only", text: " изменён на " }) : null,
        label(criterion.finalAnswer))),
    h("div", { className: "cqa-crit__body" },
      pointsLine(criterion, changed),
      step?.label ? h("p", { className: "cqa-crit__step" }, h("strong", { text: `Ступень ${formatInt(step.value)}: ` }), step.label) : null,
      criterion.explanation ? h("p", { className: "cqa-crit__expl" }, linkify(criterion.explanation, ctx)) : null,
      criterion.finalAnswer === "na" && criterion.naReason
        ? h("p", { className: "cqa-crit__na" }, h("strong", { text: "Почему N/A: " }), criterion.naReason) : null,
      evidenceList(criterion, ctx),
      flags(criterion),
      appealSlot(criterion, { ...ctx, maxStep })));
}

function pointsLine(criterion, changed) {
  if (!criterion.scored) return h("p", { className: "cqa-crit__points", text: "Без баллов — отдельная отметка" });
  if (criterion.finalPoints === null) {
    return h("p", { className: "cqa-crit__points", text: criterion.finalAnswer === "na" ? "Не применим — вес перераспределён на остальные критерии" : "Баллы не начислены" });
  }
  const max = criterion.finalMaxPoints ?? criterion.maxPoints;
  const was = changed && criterion.points !== criterion.finalPoints ? `${formatPoints(criterion.points)} → ` : "";
  return h("p", { className: "cqa-crit__points cqa-num", attrs: { title: "Баллы с учётом перераспределения веса N/A" } },
    h("span", { className: "cqa-sr-only", text: "Баллы: " }),
    h("strong", { text: `${was}${formatPoints(criterion.finalPoints)}` }), ` / ${formatPoints(max)}`,
    criterion.weight ? h("span", { className: "cqa-crit__weight", text: ` · вес ${formatInt(criterion.weight)}` }) : null);
}

function evidenceList(criterion, ctx) {
  const chips = criterion.evidence.map((evidence) => evidenceChip(evidence, ctx));
  const range = criterion.checkedRange;
  if (range && criterion.finalAnswer !== "na") {
    const text = range[0] === range[1] ? `#${messageNumber(range[0])}` : `#${messageNumber(range[0])}–#${messageNumber(range[1])}`;
    chips.push(h("button", {
      className: "cqa-evi cqa-evi--range",
      attrs: { type: "button", title: "Где ожидалось пропущенное действие — подсветить участок в транскрипте" },
      on: { click: () => ctx.onRange(range) },
    }, icon("target", { size: 15 }), h("span", { text: `Проверенный участок ${text}` })));
  }
  if (!chips.length) return null;
  return h("div", { className: "cqa-chips", attrs: { role: "group", "aria-label": "Доказательства" } }, chips);
}

function evidenceChip(evidence, ctx) {
  const number = messageNumber(evidence.index);
  const quote = evidence.quote ? `«${evidence.quote}»` : "";
  const unverified = !evidence.verified;
  const hint = unverified
    ? `Цитата не найдена в тексте реплики #${number} — проверьте вручную`
    : `Перейти к реплике #${number}${ctx.isCall ? " и перемотать запись" : ""}`;
  return h("button", {
    className: `cqa-evi${unverified ? " cqa-evi--unverified" : ""}`,
    attrs: { type: "button", title: quote ? `${hint}\n${quote}` : hint, "aria-label": `${hint}${quote ? `: ${quote}` : ""}` },
    on: { click: () => ctx.onEvidence(evidence.index) },
  },
  ctx.isCall ? icon("play", { size: 12, className: "cqa-evi__play" }) : null,
  h("span", { className: "cqa-evi__num", text: `#${number}` }),
  quote ? h("span", { className: "cqa-evi__quote", text: quote }) : null,
  unverified ? h("span", { className: "cqa-evi__warn" }, icon("alert", { size: 14 }), "не подтверждена") : null);
}

function flags(criterion) {
  const items = [];
  if (criterion.needsReview) items.push(statusPill("review", "Нужна проверка", REVIEW_HINT));
  const votes = criterion.votes;
  if (votes.length > 1) {
    const agree = votes.filter((vote) => vote.answer === criterion.answer).length;
    items.push(h("details", { className: "cqa-votes" },
      h("summary", { className: "cqa-votes__summary", attrs: { title: "Как ответила каждая модель" } },
        `Согласие моделей: ${agree} из ${votes.length}`, icon("chevronDown", { size: 14 })),
      h("ul", { className: "cqa-votes__list" }, votes.map((vote) => h("li", {},
        h("span", { text: modelLabel(vote.model) }),
        h("strong", { text: answerLabel(vote.answer, { critical: criterion.critical }) }))))));
  } else if (typeof criterion.confidence === "number" && criterion.confidence < 1) {
    items.push(h("span", { className: "cqa-crit__conf", text: `Уверенность ${Math.round(criterion.confidence * 100)} %` }));
  }
  return items.length ? h("div", { className: "cqa-crit__flags" }, items) : null;
}

function appealSlot(initial, ctx) {
  let criterion = initial;
  const slot = h("div", { className: "cqa-crit__appeal" });
  const open = h("button", {
    className: "cqa-linkbtn cqa-linkbtn--appeal",
    attrs: { type: "button", "aria-label": `Оспорить оценку по критерию «${criterion.title}»` },
    on: { click: showForm },
  }, icon("flag", { size: 15 }), "Оспорить");

  function render() {
    if (criterion.appeal) {
      slot.replaceChildren(appealStatus(criterion.appeal, {
        critical: criterion.critical, maxStep: ctx.maxStep, answer: criterion.answer, href: ctx.appealHref(criterion.appeal.id),
      }));
    } else {
      slot.replaceChildren(...(ctx.canAppeal && criterion.finalAnswer !== null ? [open] : []));
    }
  }

  function showForm() {
    const form = appealForm({
      criterionTitle: criterion.title,
      onCancel: () => {
        render();
        open.focus();
      },
      onSubmit: async (comment) => {
        const appeal = await ctx.onAppeal(criterion, comment);
        criterion = Object.freeze({ ...criterion, appeal });
        render();
        slot.querySelector(".cqa-appeal__link")?.focus();
      },
    });
    slot.replaceChildren(form.el);
    form.focus();
  }

  render();
  return slot;
}

/* ---------- мета и вспомогательное ---------- */

function metaBlock(evaluation) {
  const items = [
    ["Модели", evaluation.models.map(modelLabel).join(", ") || "—"],
    ["Стоимость", formatCost(evaluation.costUsd) || "—",
      evaluation.tokens.input || evaluation.tokens.output
        ? `Токены: ${formatInt(evaluation.tokens.input)} на входе, ${formatInt(evaluation.tokens.output)} на выходе` : ""],
    ["Время", formatElapsedMs(evaluation.latencyMs) || "—"],
    ["Чек-лист", evaluation.checklistVersion !== null ? `версия ${evaluation.checklistVersion}` : "—"],
    ["Оценено", formatDateTime(evaluation.createdAt) || "—"],
  ];
  return h("dl", { className: "cqa-meta" }, items.map(([term, value, title]) =>
    h("div", { className: "cqa-meta__item", attrs: { title: title || null } }, h("dt", { text: term }), h("dd", { text: value }))));
}

/** «#10» в тексте обоснования → кнопка перехода к реплике (index = номер − 1); знаки после ссылки не отрываются. */
function linkify(text, ctx) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(REF_PATTERN)) {
    const number = Number(match[1]);
    if (match.index > last) parts.push(text.slice(last, match.index));
    const end = match.index + match[0].length;
    const tail = /^[.,;:!?)»”]+/.exec(text.slice(end))?.[0] ?? "";
    const ref = number >= 1 ? h("button", {
      className: "cqa-ref", attrs: { type: "button", title: `Перейти к реплике #${number}` },
      on: { click: () => ctx.onEvidence(number - 1) },
    }, match[0]) : match[0];
    parts.push(tail ? h("span", { className: "cqa-nowrap" }, ref, tail) : ref);
    last = end + tail.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Верхняя ступень шкалы без чек-листа: из баллов (ступень / верх = баллы / максимум). */
function inferMaxStep(criterion) {
  const answer = criterion.finalAnswer;
  const points = criterion.finalPoints;
  const max = criterion.finalMaxPoints ?? criterion.maxPoints;
  if (criterion.answerType !== "scale" || typeof answer !== "number" || !points || !max) return null;
  return Math.round((answer * max) / points);
}
