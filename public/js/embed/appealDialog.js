// Диалог «Оспорить оценку»: выбор критерия и комментарий → POST /api/evaluations/{id}/appeals.
// Нативный <dialog> с showModal(): фокус внутри, Esc закрывает, фон недоступен — без своих ловушек фокуса.

import { createAppeal, isAbortError } from "../api.js";
import { h } from "../dom.js";
import { criterionNumber } from "../format.js";
import { maxStepOf } from "../evaluation.js";
import { answerText, pointsText } from "./criteria.js";
import { describeError } from "./errors.js";
import { glyph } from "./glyphs.js";

const COMMENT_MIN = 5;
const COMMENT_MAX = 1000;
const IDS = Object.freeze({
  title: "cqa-embed-appeal-title", criterion: "cqa-embed-appeal-criterion", current: "cqa-embed-appeal-current",
  comment: "cqa-embed-appeal-comment", help: "cqa-embed-appeal-help", error: "cqa-embed-appeal-error",
});

/**
 * Критерии, которые можно оспорить: есть ответ системы и ещё нет апелляции.
 * @param {object} evaluation
 */
export function appealableCriteria(evaluation) {
  return evaluation.status === "done"
    ? evaluation.criteria.filter((criterion) => !criterion.appeal && criterion.answer !== null)
    : [];
}

/**
 * @param {{ root: HTMLElement, i18n: object, signal: AbortSignal, onSubmitted: (appeal: object, criterion: object) => void }} options
 */
export function createAppealDialog({ root, i18n, signal, onSubmitted }) {
  const select = h("select", { className: "cqa-embed-field__control", attrs: { id: IDS.criterion, "aria-describedby": IDS.current } });
  const current = h("p", { className: "cqa-embed-field__hint", attrs: { id: IDS.current } });
  const comment = h("textarea", {
    className: "cqa-embed-field__control cqa-embed-field__control--area",
    attrs: { id: IDS.comment, rows: 4, maxlength: COMMENT_MAX, required: true, "aria-describedby": `${IDS.help} ${IDS.error}` },
  });
  const error = h("p", { className: "cqa-embed-field__error", attrs: { id: IDS.error, role: "alert", hidden: true } });
  const submit = h("button", { className: "cqa-btn cqa-btn--sm cqa-btn--dark", attrs: { type: "submit" }, text: i18n.t("appealSubmit") });
  const cancel = h("button", { className: "cqa-btn cqa-btn--sm cqa-btn--gray", attrs: { type: "button" }, text: i18n.t("cancel") });
  const closeX = h("button", { className: "cqa-embed__icon-btn cqa-embed-dialog__close", attrs: { type: "button", "aria-label": i18n.t("close") } }, glyph("close", { size: 18 }));
  const form = h("form", { className: "cqa-embed-dialog__form", attrs: { novalidate: true } },
    h("div", { className: "cqa-embed-dialog__head" },
      h("h2", { className: "cqa-embed-dialog__title", attrs: { id: IDS.title }, text: i18n.t("appealTitle") }), closeX),
    h("p", { className: "cqa-embed-dialog__intro", text: i18n.t("appealIntro") }),
    h("div", { className: "cqa-embed-field" },
      h("label", { className: "cqa-embed-field__label", attrs: { for: IDS.criterion }, text: i18n.t("appealCriterionLabel") }), select, current),
    h("div", { className: "cqa-embed-field" },
      h("label", { className: "cqa-embed-field__label", attrs: { for: IDS.comment }, text: i18n.t("appealCommentLabel") }), comment,
      h("p", { className: "cqa-embed-field__hint", attrs: { id: IDS.help }, text: i18n.t("appealCommentHelp") }), error),
    h("div", { className: "cqa-embed-actions cqa-embed-dialog__actions" }, submit, cancel));
  const dialog = h("dialog", { className: "cqa-embed-dialog", attrs: { "aria-labelledby": IDS.title } }, form);
  root.append(dialog);

  let state = { evaluation: null, checklist: null, sending: null };

  select.addEventListener("change", () => showCurrent());
  comment.addEventListener("input", () => { if (!error.hidden) setError(""); });
  cancel.addEventListener("click", () => close());
  closeX.addEventListener("click", () => close());
  dialog.addEventListener("close", () => { state.sending?.abort(); state = { ...state, sending: null }; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });

  function open({ evaluation, checklist, criterionId = "" }) {
    const options = appealableCriteria(evaluation);
    if (options.length === 0) return false;
    state = { evaluation, checklist, sending: null };
    const preferred = options.find((criterion) => criterion.criterionId === criterionId) ?? options[0];
    select.replaceChildren(...evaluation.criteria.map((criterion, position) => {
      const taken = !options.includes(criterion);
      const label = `${criterionNumber(criterion.criterionId, position)} · ${criterion.title}${taken ? ` (${i18n.t("appealTaken")})` : ""}`;
      return h("option", { attrs: { value: criterion.criterionId, disabled: taken || null }, text: label });
    }));
    select.value = preferred.criterionId;
    comment.value = "";
    setError("");
    setSending(false);
    showCurrent();
    dialog.showModal();
    comment.focus();
    return true;
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  function showCurrent() {
    const criterion = selectedCriterion();
    if (!criterion) {
      current.textContent = "";
      return;
    }
    const definition = state.checklist?.criteria.find((item) => item.id === criterion.criterionId) ?? null;
    current.textContent = i18n.t("appealCurrent", {
      answer: answerText(criterion.finalAnswer, criterion, maxStepOf(definition), i18n),
      points: pointsText(criterion, i18n),
    });
  }

  async function send() {
    if (state.sending) return;
    const criterion = selectedCriterion();
    const text = comment.value.trim();
    if (!criterion || text.length < COMMENT_MIN) {
      setError(i18n.t("appealCommentShort", { min: COMMENT_MIN }));
      comment.focus();
      return;
    }
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal.addEventListener("abort", relay, { once: true });
    state = { ...state, sending: controller };
    setSending(true);
    try {
      const appeal = await createAppeal(state.evaluation.id, { criterionId: criterion.criterionId, comment: text.slice(0, COMMENT_MAX) },
        { signal: controller.signal });
      state = { ...state, sending: null };
      close();
      onSubmitted(appeal, criterion);
    } catch (failure) {
      state = { ...state, sending: null };
      if (isAbortError(failure)) return;
      setSending(false);
      setError(describeError(failure, i18n, { groupId: state.evaluation.groupId, conversationId: state.evaluation.conversationId }).text);
    } finally {
      signal.removeEventListener("abort", relay);
    }
  }

  function selectedCriterion() {
    return state.evaluation?.criteria.find((criterion) => criterion.criterionId === select.value) ?? null;
  }

  function setSending(sending) {
    submit.textContent = i18n.t(sending ? "appealSending" : "appealSubmit");
    if (sending) submit.setAttribute("aria-disabled", "true");
    else submit.removeAttribute("aria-disabled");
    form.setAttribute("aria-busy", sending ? "true" : "false");
  }

  function setError(message) {
    error.textContent = message;
    error.hidden = !message;
    comment.setAttribute("aria-invalid", message ? "true" : "false");
  }

  return {
    open,
    close,
    destroy() {
      state.sending?.abort();
      close();
      dialog.remove();
    },
  };
}
