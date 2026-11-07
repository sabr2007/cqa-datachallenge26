// Карточка апелляции в очереди: спорная оценка (ответ, баллы, обоснование системы), комментарий,
// фрагмент диалога и решение проверяющего — «Подтвердить» или «Изменить» с обязательной причиной.

import { decideAppeal } from "../api.js";
import { h, setChildren } from "../dom.js";
import { icon } from "../icons.js";
import { answerLabel, criterionNumber, formatDateTime, formatPoints, messageNumber, speakerName } from "../format.js";
import { answerTone, maxStepOf } from "../evaluation.js";
import { buildHash, paths } from "../router.js";
import { button, statusPill } from "./ui.js";

const MIN_REASON = 5;
const MAX_REASON = 2000;

/**
 * @param {object} appeal апелляция (api.js)
 * @param {{ groupId: string, reviewer: boolean, details: { evaluation: object | null, checklist: object | null } | null,
 *   onDecided: (result: { appeal: object, evaluation: object, previousTotal: number | null }) => void }} ctx
 * @returns {{ el: HTMLElement, setReviewer: (value: boolean) => void, setDetails: (details: object) => void, flash: () => void }}
 */
export function appealCard(initialAppeal, ctx) {
  let appeal = initialAppeal;
  let details = ctx.details;
  let reviewer = ctx.reviewer;
  let outcome = null; // { previousTotal, evaluation } после решения на этом экране
  const titleId = `cqa-ap-${appeal.id}-title`;
  const claim = h("div", { className: "cqa-ac__claim" });
  const fragment = h("div", { className: "cqa-ac__fragment" });
  const decision = h("div", { className: "cqa-ac__decision" });
  const statusSlot = h("span", { className: "cqa-ac__status" });
  const el = h("article", { className: "cqa-ac", attrs: { id: `cqa-ap-${appeal.id}`, "aria-labelledby": titleId, tabindex: "-1" } },
    h("header", { className: "cqa-ac__head" },
      h("div", { className: "cqa-ac__heading" },
        h("p", { className: "cqa-ac__kicker" },
          "Диалог ",
          h("a", { className: "cqa-ac__conv cqa-num", attrs: { href: conversationHref(appeal) }, text: appeal.conversationId }),
          appeal.createdAt ? ` · подана ${formatDateTime(appeal.createdAt)}` : ""),
        h("h3", { className: "cqa-ac__title", attrs: { id: titleId } },
          h("span", { className: "cqa-ac__num", text: criterionNumber(appeal.criterionId, 0) }),
          appeal.criterionTitle || criterionDoc()?.title || appeal.criterionId)),
      statusSlot),
    h("div", { className: "cqa-ac__grid" }, claim, fragment),
    decision);

  render();

  function criterion() {
    return details?.evaluation?.criteria.find((c) => c.criterionId === appeal.criterionId) ?? null;
  }

  function criterionDoc() {
    return details?.checklist?.criteria.find((c) => c.id === appeal.criterionId) ?? null;
  }

  function labelOf(value) {
    const option = appeal.options.find((o) => o.value === value);
    if (option?.label) return option.label;
    const crit = criterion();
    return answerLabel(value, { critical: crit?.critical ?? criterionDoc()?.critical ?? false, maxStep: maxStepOf(criterionDoc()) });
  }

  function render() {
    renderStatus();
    renderClaim();
    renderFragment();
    renderDecision();
  }

  function renderStatus() {
    const d = appeal.decision;
    statusSlot.replaceChildren(appeal.status === "open"
      ? statusPill("appeal", "Ждёт решения")
      : statusPill("done", d?.action === "change" ? "Ответ изменён" : "Оценка подтверждена"));
  }

  function renderClaim() {
    const crit = criterion();
    const tone = answerTone(appeal.originalAnswer, { critical: crit?.critical ?? false, maxStep: maxStepOf(criterionDoc()) });
    const points = crit && crit.scored && crit.points !== null ? `${formatPoints(crit.points)} / ${formatPoints(crit.maxPoints)}` : "";
    setChildren(claim,
      h("dl", { className: "cqa-ac__facts" },
        fact("Ответ системы", h("span", { className: "cqa-ac__answer" },
          h("span", { className: `cqa-answer cqa-answer--${tone}`, text: labelOf(appeal.originalAnswer) }),
          points ? h("span", { className: "cqa-ac__points cqa-num", text: points }) : null)),
        crit?.explanation ? fact("Обоснование системы", h("span", {}, withRefs(crit.explanation, appeal))) : null,
        crit?.naReason && appeal.originalAnswer === "na" ? fact("Почему N/A", crit.naReason) : null,
        fact("Комментарий апелляции", h("span", { className: "cqa-ac__comment", text: appeal.comment ? `«${appeal.comment}»` : "—" }))),
      details === null ? h("p", { className: "cqa-ac__loading", attrs: { role: "status" }, text: "Загружаем оценку…" }) : null);
  }

  function renderFragment() {
    const evidence = new Set((criterion()?.evidence ?? []).map((e) => e.index));
    const messages = appeal.fragment;
    setChildren(fragment,
      h("p", { className: "cqa-ac__label", text: "Фрагмент диалога" }),
      messages.length
        ? h("ol", { className: "cqa-frag", attrs: { "aria-label": "Реплики вокруг доказательства" } },
          messages.map((message) => fragmentMessage(message, appeal, evidence.has(message.index))))
        : h("p", { className: "cqa-ac__empty", text: "Фрагмент не приложен: у ответа нет реплик-доказательств." }),
      h("a", { className: "cqa-ac__open", attrs: { href: conversationHref(appeal) } }, "Открыть диалог и оценку целиком", icon("arrowRight", { size: 16 })));
  }

  function renderDecision() {
    if (appeal.status === "resolved") {
      decision.replaceChildren(decisionSummary());
      return;
    }
    if (!reviewer) {
      decision.replaceChildren(h("p", { className: "cqa-ac__locked" }, icon("shield", { size: 18 }),
        "Решение принимает проверяющий — включите «Я — проверяющий» в начале страницы."));
      return;
    }
    decision.replaceChildren(h("div", { className: "cqa-ac__actions" },
      button({ label: "Подтвердить оценку", variant: "dark sm", iconName: "check", onClick: () => openForm("confirm") }),
      button({ label: "Изменить ответ", variant: "white sm", iconName: "refresh", onClick: () => openForm("change") })));
  }

  function decisionSummary() {
    const d = appeal.decision;
    const before = outcome?.previousTotal ?? details?.evaluation?.total ?? null;
    const after = outcome?.evaluation?.finalTotal ?? details?.evaluation?.finalTotal ?? null;
    return h("div", { className: "cqa-ac__result", attrs: { role: outcome ? "status" : null } },
      h("p", { className: "cqa-ac__verdict" },
        icon(d?.action === "change" ? "refresh" : "check", { size: 18 }),
        d?.action === "change"
          ? h("span", {}, "Ответ изменён: ", h("s", { text: labelOf(appeal.originalAnswer) }), " → ", h("strong", { text: labelOf(d.newAnswer) }))
          : h("span", { text: `Оценка подтверждена: ${labelOf(appeal.originalAnswer)}` }),
        d?.decidedAt ? h("span", { className: "cqa-ac__when", text: formatDateTime(d.decidedAt) }) : null),
      d?.reason ? h("p", { className: "cqa-ac__reason" }, h("span", { text: "Причина: " }), `«${d.reason}»`) : null,
      totalLine(before, after, Boolean(outcome)));
  }

  /** Сразу после решения — «было → стало»; в истории — исходный итог и текущий (учитывает все решения). */
  function totalLine(before, after, justDecided) {
    if (before === null && after === null) return null;
    const changed = before !== null && after !== null && before !== after;
    if (!justDecided && changed) {
      return h("p", { className: "cqa-ac__total" },
        h("span", { text: "Итог диалога: исходно " }), h("span", { className: "cqa-num", text: formatPoints(before) }),
        h("span", { text: " · сейчас " }), h("strong", { className: "cqa-num", text: formatPoints(after) }));
    }
    return h("p", { className: "cqa-ac__total" },
      h("span", { text: "Итог диалога: " }),
      changed
        ? h("span", { className: "cqa-num" }, h("s", { text: formatPoints(before) }), " → ", h("strong", { text: formatPoints(after) }))
        : h("strong", { className: "cqa-num", text: formatPoints(after ?? before) }),
      justDecided && !changed ? h("span", { className: "cqa-ac__same", text: " (не изменился)" }) : null);
  }

  function openForm(action) {
    const form = decisionForm(action);
    decision.replaceChildren(form.el);
    form.focus();
  }

  function decisionForm(action) {
    const id = `cqa-dec-${appeal.id}`;
    const options = changeOptions();
    const radios = action === "change" ? h("fieldset", { className: "cqa-dec__options" },
      h("legend", { className: "cqa-form__label", text: "Новый ответ" }),
      options.map((option, i) => h("label", { className: "cqa-dec__option" },
        h("input", { attrs: { type: "radio", name: `${id}-answer`, value: String(option.value), checked: i === 0 && options.length === 1 } }),
        h("span", { text: option.label })))) : null;
    const textarea = h("textarea", {
      className: "cqa-textarea",
      attrs: { id: `${id}-reason`, rows: 3, maxlength: MAX_REASON, required: true, "aria-describedby": `${id}-hint ${id}-error`,
        placeholder: action === "change" ? "Почему ответ системы неверен: что видно в репликах" : "Почему оценка системы верна" },
    });
    const error = h("p", { className: "cqa-form__error", attrs: { id: `${id}-error`, role: "alert", hidden: true } });
    const submit = button({ label: "Сохранить решение", variant: "dark sm", iconName: "check", attrs: { type: "submit" } });
    const form = h("form", { className: "cqa-dec", attrs: { novalidate: true, "aria-label": action === "change" ? "Изменить ответ" : "Подтвердить оценку" } },
      h("p", { className: "cqa-dec__title", text: action === "change" ? `Изменить ответ «${labelOf(appeal.originalAnswer)}»` : `Подтвердить ответ «${labelOf(appeal.originalAnswer)}»` }),
      radios,
      h("label", { className: "cqa-form__label", attrs: { for: `${id}-reason` }, text: "Причина решения" }),
      textarea,
      h("p", { className: "cqa-form__hint", attrs: { id: `${id}-hint` }, text: "Обязательно. Причину увидят в карточке диалога рядом с исходной оценкой." }),
      error,
      h("div", { className: "cqa-form__actions" }, submit, button({ label: "Отмена", variant: "gray sm", onClick: () => { renderDecision(); } })));

    let busy = false;
    const fail = (message, focusEl) => {
      error.textContent = message;
      error.hidden = false;
      focusEl?.focus();
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const reason = textarea.value.trim();
      const picked = form.querySelector(`input[name="${id}-answer"]:checked`);
      if (action === "change" && !picked) return fail("Выберите новый ответ.", form.querySelector(`input[name="${id}-answer"]`));
      if (reason.length < MIN_REASON) return fail(`Укажите причину решения: не короче ${MIN_REASON} символов.`, textarea);
      busy = true;
      submit.setAttribute("aria-disabled", "true");
      submit.lastChild.textContent = "Сохраняем…";
      const newAnswer = picked ? options.find((o) => String(o.value) === picked.value)?.value : undefined;
      const previousTotal = details?.evaluation?.finalTotal ?? null;
      try {
        const result = await decideAppeal(appeal.id, { action, newAnswer, reason });
        appeal = mergeAppeal(appeal, result.appeal);
        outcome = { previousTotal, evaluation: result.evaluation };
        details = { ...(details ?? { checklist: null }), evaluation: result.evaluation };
        render();
        decision.querySelector(".cqa-ac__result")?.setAttribute("tabindex", "-1");
        decision.querySelector(".cqa-ac__result")?.focus();
        ctx.onDecided({ appeal, evaluation: result.evaluation, previousTotal });
      } catch (decideError) {
        busy = false;
        submit.removeAttribute("aria-disabled");
        submit.lastChild.textContent = "Сохранить решение";
        fail(decideError?.message || "Не удалось сохранить решение. Попробуйте ещё раз.");
      }
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        renderDecision();
        decision.querySelector("button")?.focus();
      }
    });
    textarea.addEventListener("input", () => { error.hidden = true; });
    return { el: form, focus: () => (form.querySelector("input[type=radio]") ?? textarea).focus() };
  }

  /** Допустимые ответы для «Изменить»: из бэкенда, иначе из версии чек-листа; без исходного ответа. */
  function changeOptions() {
    const original = appeal.originalAnswer;
    if (appeal.options.length) return appeal.options.filter((o) => o.value !== original);
    const doc = criterionDoc();
    const values = doc?.answerType === "scale"
      ? doc.scale.map((step) => step.value)
      : ["yes", "no"];
    const withNa = doc ? (doc.naAllowed ? [...values, "na"] : values) : [...values, "na"];
    return withNa.filter((value) => value !== original).map((value) => ({ value, label: labelOf(value) }));
  }

  return {
    el,
    setReviewer(value) {
      reviewer = value;
      if (appeal.status === "open") renderDecision();
    },
    setDetails(next) {
      details = next;
      renderClaim();
      renderFragment();
      if (appeal.status === "resolved") renderDecision();
    },
    flash() {
      el.classList.remove("is-target");
      void el.offsetWidth;
      el.classList.add("is-target");
    },
  };

  function fact(term, value) {
    return h("div", { className: "cqa-ac__fact" }, h("dt", { text: term }), h("dd", {}, value));
  }
}

/** Ответ решения может не содержать фрагмент, варианты и название критерия — берём их из очереди. */
export function mergeAppeal(previous, next) {
  return Object.freeze({
    ...previous,
    ...next,
    criterionTitle: next.criterionTitle || previous.criterionTitle,
    answerType: next.answerType || previous.answerType,
    fragment: next.fragment.length ? next.fragment : previous.fragment,
    options: next.options.length ? next.options : previous.options,
  });
}

function conversationHref(appeal, index) {
  return buildHash(paths.conversation(appeal.conversationId), { g: appeal.groupId, m: index });
}

function fragmentMessage(message, appeal, isEvidence) {
  const number = messageNumber(message.index);
  return h("li", { className: `cqa-frag__msg cqa-frag__msg--${message.speaker}${isEvidence ? " is-evidence" : ""}` },
    h("div", { className: "cqa-frag__meta" },
      h("span", { className: "cqa-frag__role", text: speakerName(message.speaker) }),
      h("a", { className: "cqa-frag__num", attrs: { href: conversationHref(appeal, message.index), title: "Открыть реплику в диалоге" }, text: `#${number}` }),
      isEvidence ? h("span", { className: "cqa-frag__tag", text: "доказательство" }) : null),
    h("p", { className: "cqa-frag__text", text: message.text }));
}

/** «#10» в обосновании → ссылка на реплику в карточке диалога. */
function withRefs(text, appeal) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/#(\d{1,5})/g)) {
    const number = Number(match[1]);
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(number >= 1 ? h("a", { className: "cqa-ref", attrs: { href: conversationHref(appeal, number - 1) }, text: match[0] }) : match[0]);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
