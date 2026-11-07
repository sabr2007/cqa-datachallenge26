// Апелляция по критерию: форма с комментарием и блок статуса (открыта / решение проверяющего).

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { answerLabel, formatDateTime } from "../format.js";
import { button, statusPill } from "./ui.js";

const MIN_COMMENT = 10;
const MAX_COMMENT = 2000;
let formSeq = 0;

/**
 * Форма апелляции. onSubmit(comment) должен вернуть Promise; ошибка показывается в форме.
 * @param {{ criterionTitle: string, onSubmit: (comment: string) => Promise<void>, onCancel: () => void }} options
 */
export function appealForm({ criterionTitle, onSubmit, onCancel }) {
  const id = `cqa-appeal-${++formSeq}`;
  const textarea = h("textarea", {
    className: "cqa-textarea",
    attrs: {
      id: `${id}-text`, name: "comment", rows: 4, maxlength: MAX_COMMENT, required: true,
      "aria-describedby": `${id}-hint ${id}-error`,
      placeholder: "Например: оператор представился во второй реплике (#3), это первый его ответ после бота.",
    },
  });
  const error = h("p", { className: "cqa-form__error", attrs: { id: `${id}-error`, role: "alert", hidden: true } });
  const submit = button({ label: "Отправить апелляцию", variant: "dark sm", iconName: "flag", attrs: { type: "submit" } });
  const form = h("form", { className: "cqa-appeal-form", attrs: { novalidate: true, "aria-label": `Апелляция: ${criterionTitle}` } },
    h("label", { className: "cqa-form__label", attrs: { for: `${id}-text` }, text: "С чем вы не согласны?" }),
    textarea,
    h("p", { className: "cqa-form__hint", attrs: { id: `${id}-hint` },
      text: "Комментарий увидит проверяющий вместе с ответом системы и фрагментом диалога." }),
    error,
    h("div", { className: "cqa-form__actions" },
      submit,
      button({ label: "Отмена", variant: "white sm", onClick: onCancel })));

  let busy = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const comment = textarea.value.trim();
    if (comment.length < MIN_COMMENT) {
      showError(`Опишите, с чем вы не согласны: не короче ${MIN_COMMENT} символов.`);
      textarea.focus();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(comment);
    } catch (submitError) {
      showError(submitError?.message || "Не удалось отправить апелляцию. Попробуйте ещё раз.");
      setBusy(false);
    }
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !busy) {
      event.stopPropagation();
      onCancel();
    }
  });
  textarea.addEventListener("input", () => {
    error.hidden = true;
    textarea.removeAttribute("aria-invalid");
  });

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    textarea.setAttribute("aria-invalid", "true");
  }

  function setBusy(value) {
    busy = value;
    submit.setAttribute("aria-disabled", String(value));
    submit.lastChild.textContent = value ? "Отправляем…" : "Отправить апелляцию";
  }

  return { el: form, focus: () => textarea.focus() };
}

/**
 * Статус апелляции у критерия: открыта — комментарий и ссылка в очередь; решена — решение и причина.
 * @param {{ id: string, status: string, comment?: string, createdAt?: string, decision?: object | null }} appeal
 * @param {{ critical: boolean, maxStep: number | null, answer: unknown, href: string }} context
 */
export function appealStatus(appeal, { critical, maxStep, answer, href }) {
  const label = (value) => answerLabel(value, { critical, maxStep });
  const decision = appeal.decision;
  const head = appeal.status === "open"
    ? statusPill("appeal", "Апелляция открыта", "Ждёт решения проверяющего")
    : statusPill("done", decision?.action === "change" ? "Ответ изменён" : decision ? "Оценка подтверждена" : "Апелляция рассмотрена");
  const lines = [];
  if (appeal.comment) lines.push(line("Комментарий", `«${appeal.comment}»`));
  if (decision?.action === "change") lines.push(line("Решение", `${label(appeal.originalAnswer ?? answer)} → ${label(decision.newAnswer)}`));
  if (decision?.reason) lines.push(line("Причина", `«${decision.reason}»`));
  const when = formatDateTime(decision?.decidedAt || appeal.createdAt);
  return h("div", { className: `cqa-appeal cqa-appeal--${appeal.status}` },
    h("div", { className: "cqa-appeal__head" },
      head,
      when ? h("span", { className: "cqa-appeal__when", text: when }) : null,
      h("a", { className: "cqa-appeal__link", attrs: { href } }, appeal.status === "open" ? "В очереди" : "Открыть", icon("arrowRight", { size: 14 }))),
    lines.length ? h("dl", { className: "cqa-appeal__lines" }, lines) : null);
}

function line(term, text) {
  return h("div", { className: "cqa-appeal__line" }, h("dt", { text: term }), h("dd", { text }));
}
