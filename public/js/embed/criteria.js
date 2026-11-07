// Критерии оценки: ответ, баллы, объяснение, цитаты с номерами реплик, N/A, голоса моделей, апелляция.
// Нативные <details>/<summary>: раскрытие работает с клавиатуры и без скриптов.

import { h } from "../dom.js";
import { criterionNumber, messageNumber } from "../format.js";
import { answerTone, maxStepOf } from "../evaluation.js";
import { glyph } from "./glyphs.js";
import { actionButton, cardHref, externalLink } from "./view.js";

const TONE_CLASS = Object.freeze({ pass: "ok", fail: "bad", partial: "warn", na: "na", none: "na" });

/**
 * Подпись ответа на языке панели. Для критического критерия «Да» — «Есть нарушение».
 * @param {"yes" | "no" | "na" | number | null} answer
 * @param {{ critical: boolean }} criterion
 * @param {number | null} maxStep верхняя ступень шкалы (из чек-листа), если известна
 */
export function answerText(answer, criterion, maxStep, i18n) {
  if (answer === null || answer === undefined) return "—";
  if (typeof answer === "number") {
    return maxStep ? i18n.t("answerScale", { value: i18n.number(answer), max: i18n.number(maxStep) }) : i18n.number(answer);
  }
  if (criterion.critical) return { yes: i18n.t("answerViolation"), no: i18n.t("answerNoViolation"), na: i18n.t("answerNa") }[answer] ?? "—";
  return { yes: i18n.t("answerYes"), no: i18n.t("answerNo"), na: i18n.t("answerNa") }[answer] ?? "—";
}

/**
 * Баллы критерия после апелляций: "12,5 / 18,75", для N/A — "—", без веса — «без баллов».
 * final_* уже с откатом на исходные значения (api.js), а явный null значит «баллов нет» (N/A после решения).
 */
export function pointsText(criterion, i18n) {
  if (!criterion.scored) return i18n.t("notScored");
  const max = criterion.finalMaxPoints;
  const value = criterion.finalPoints;
  if (typeof max !== "number") return "—";
  return `${i18n.number(typeof value === "number" ? value : 0)} / ${i18n.number(max)}`;
}

/**
 * @param {{ evaluation: object, checklist: object | null, i18n: object, links: object, canAppeal: boolean, onAppeal: (criterionId: string) => void }} options
 */
export function criteriaView({ evaluation, checklist, i18n, links, canAppeal, onAppeal }) {
  const steps = new Map((checklist?.criteria ?? []).map((criterion) => [criterion.id, criterion]));
  return h("section", { className: "cqa-embed-crits", attrs: { "aria-labelledby": "cqa-embed-crits-title" } },
    h("h2", { className: "cqa-embed-h2", attrs: { id: "cqa-embed-crits-title" } },
      i18n.t("criteriaTitle"), h("span", { className: "cqa-embed-h2__count cqa-num", text: String(evaluation.criteria.length) })),
    h("div", { className: "cqa-embed-crits__list" }, evaluation.criteria.map((criterion, position) =>
      criterionView({ criterion, position, definition: steps.get(criterion.criterionId) ?? null, i18n, links, canAppeal, onAppeal }))));
}

function criterionView({ criterion, position, definition, i18n, links, canAppeal, onAppeal }) {
  const maxStep = maxStepOf(definition);
  const tone = answerTone(criterion.finalAnswer, { critical: criterion.critical, maxStep });
  const flaggedCritical = criterion.critical && criterion.finalAnswer === "yes";
  const details = h("details", {
    className: `cqa-embed-crit cqa-embed-crit--${TONE_CLASS[tone] ?? "na"}`,
    attrs: { open: flaggedCritical || null, id: `cqa-embed-crit-${criterion.criterionId}` },
  },
  h("summary", { className: "cqa-embed-crit__sum" },
    h("span", { className: "cqa-embed-crit__num cqa-num", text: criterionNumber(criterion.criterionId, position) }),
    h("span", { className: "cqa-embed-crit__head" },
      h("span", { className: "cqa-embed-crit__title", text: criterion.title }),
      tags(criterion, flaggedCritical, i18n),
      criterion.explanation ? h("span", { className: "cqa-embed-crit__preview", text: criterion.explanation }) : null),
    h("span", { className: "cqa-embed-crit__side" },
      h("span", { className: `cqa-embed-ans cqa-embed-ans--${TONE_CLASS[tone] ?? "na"}`, text: answerText(criterion.finalAnswer, criterion, maxStep, i18n) }),
      h("span", { className: "cqa-embed-crit__pts cqa-num", text: pointsText(criterion, i18n) })),
    glyph("chevron", { size: 18, className: "cqa-embed-crit__chev" })),
  h("div", { className: "cqa-embed-crit__body" },
    criterion.explanation ? h("p", { className: "cqa-embed-crit__text", text: criterion.explanation }) : null,
    scaleNote(criterion, definition, i18n),
    criterion.finalAnswer === "na" && criterion.naReason
      ? h("p", { className: "cqa-embed-crit__note", text: i18n.t("naReason", { reason: criterion.naReason }) }) : null,
    evidenceList(criterion, i18n, links),
    criterion.checkedRange
      ? h("p", { className: "cqa-embed-crit__note cqa-num", text: i18n.t("checkedRange", {
        from: messageNumber(criterion.checkedRange[0]), to: messageNumber(criterion.checkedRange[1]) }) })
      : null,
    votesNote(criterion, maxStep, i18n),
    criterion.needsReview ? h("p", { className: "cqa-embed-crit__flag", text: i18n.t("needsReviewNote") }) : null,
    appealNote(criterion, maxStep, i18n),
    canAppeal && !criterion.appeal && criterion.answer !== null
      ? h("div", { className: "cqa-embed-crit__actions" }, actionButton({
        label: i18n.t("disputeCriterion"), variant: "gray", glyphName: "dispute",
        onClick: () => onAppeal(criterion.criterionId),
        attrs: { "data-criterion": criterion.criterionId },
      }))
      : null));
  return details;
}

function tags(criterion, flaggedCritical, i18n) {
  const list = [];
  if (flaggedCritical) list.push(h("span", { className: "cqa-embed-tag cqa-embed-tag--bad", text: i18n.t("tagCritical") }));
  if (criterion.needsReview) list.push(h("span", { className: "cqa-embed-tag cqa-embed-tag--warn", text: i18n.t("tagReview") }));
  if (criterion.appeal) list.push(h("span", { className: "cqa-embed-tag cqa-embed-tag--appeal", text: i18n.t("tagAppeal") }));
  return list.length ? h("span", { className: "cqa-embed-crit__tags" }, list) : null;
}

function scaleNote(criterion, definition, i18n) {
  if (typeof criterion.finalAnswer !== "number" || !definition) return null;
  const step = definition.scale.find((item) => item.value === criterion.finalAnswer);
  return step?.label ? h("p", { className: "cqa-embed-crit__note", text: i18n.t("scaleStep", { label: step.label }) }) : null;
}

function evidenceList(criterion, i18n, links) {
  if (criterion.evidence.length === 0) return null;
  return h("div", { className: "cqa-embed-quotes" },
    h("h3", { className: "cqa-embed-quotes__title", text: i18n.t("evidenceTitle") }),
    h("ul", { className: "cqa-embed-quotes__list" }, criterion.evidence.map((item) => {
      const number = messageNumber(item.index);
      return h("li", { className: `cqa-embed-quote${item.verified ? "" : " cqa-embed-quote--unverified"}` },
        externalLink({
          href: cardHref(links.appUrl, links.groupId, links.conversationId, item.index),
          className: "cqa-embed-quote__num cqa-num",
          label: `#${number}`,
          ariaLabel: `${i18n.t("messageLink", { n: number })} (${i18n.t("newTab")})`,
          xrm: links.xrm,
        }),
        h("q", { className: "cqa-embed-quote__text", text: item.quote }),
        h("span", { className: "cqa-embed-quote__mark", attrs: { title: i18n.t(item.verified ? "quoteVerified" : "quoteUnverified") } },
          glyph(item.verified ? "check" : "warning", { size: 16 }),
          h("span", { className: "cqa-sr-only", text: i18n.t(item.verified ? "quoteVerified" : "quoteUnverified") })));
    })));
}

function votesNote(criterion, maxStep, i18n) {
  if (criterion.votes.length < 2 && typeof criterion.confidence !== "number") return null;
  const votes = criterion.votes.map((vote) => `${shortModel(vote.model)}: ${answerText(vote.answer, criterion, maxStep, i18n)}`);
  const confidence = typeof criterion.confidence === "number" ? i18n.t("confidence", { pct: i18n.percent(criterion.confidence) }) : "";
  return h("p", { className: "cqa-embed-crit__votes" }, [confidence, votes.join(" · ")].filter(Boolean).join(" — "));
}

function appealNote(criterion, maxStep, i18n) {
  const appeal = criterion.appeal;
  if (!appeal) return null;
  const lines = [];
  if (appeal.status === "open") {
    lines.push(h("strong", { text: i18n.t("appealOpen") }));
  } else if (appeal.decision?.action === "change") {
    const from = answerText(appeal.originalAnswer ?? criterion.answer, criterion, maxStep, i18n);
    const to = answerText(appeal.decision.newAnswer ?? criterion.finalAnswer, criterion, maxStep, i18n);
    lines.push(h("strong", { text: i18n.t("appealChanged", { from, to }) }));
  } else {
    lines.push(h("strong", { text: i18n.t("appealConfirmed") }));
  }
  if (appeal.decision?.reason) lines.push(h("span", { text: i18n.t("appealReason", { reason: appeal.decision.reason }) }));
  if (appeal.comment) lines.push(h("span", { text: i18n.t("appealComment", { comment: appeal.comment }) }));
  return h("div", { className: `cqa-embed-appeal cqa-embed-appeal--${appeal.status}` }, glyph("flag", { size: 18 }), h("p", {}, lines));
}

/** "@cf/zai-org/glm-5.3" → "glm-5.3": в узкой панели хватает имени модели без провайдера. */
function shortModel(model) {
  return String(model).split("/").pop() || String(model);
}
