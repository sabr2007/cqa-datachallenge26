// Контроллер встраиваемой панели: последняя оценка диалога, запуск оценки, апелляция.
// Инициализация повторяемая: destroy() отменяет запросы и таймеры, новый createPanel начинает с нуля
// (форма Dynamics пересоздаёт веб-ресурс при переходе между вкладками).

import { evaluateConversation, fetchChecklistVersion, fetchEvaluation, fetchEvaluations, isAbortError } from "../api.js";
import { focusWithoutScroll, h } from "../dom.js";
import { appealableCriteria, createAppealDialog } from "./appealDialog.js";
import { criteriaView } from "./criteria.js";
import { describeError } from "./errors.js";
import { glyph } from "./glyphs.js";
import { PENDING_TTL_MS, clearPending, readPending, writePending } from "./pending.js";
import {
  actionButton, buildFooter, buildHeader, cardHref, externalLink, loadingView, progressView, sectionsView, stateView, summaryView,
} from "./view.js";

const CHECKLIST_WAIT_MS = 1500;
const POLL_INTERVAL_MS = 4000;
const ANNOUNCE_DELAY_MS = 60;
const CONTEXT_PROBLEMS = Object.freeze({
  missing: { kind: "info", title: "noContextTitle", text: "noContextText" },
  unsaved: { kind: "info", title: "unsavedTitle", text: "unsavedText" },
  invalid: { kind: "error", title: "invalidIdTitle", text: "invalidIdText" },
});

/**
 * @param {HTMLElement} root #cqa-root
 * @param {{ context: import("./context.js").EmbedContext, i18n: object, appUrl: string }} options
 * @returns {{ destroy: () => void }}
 */
export function createPanel(root, { context, i18n, appUrl }) {
  const { groupId, conversationId, xrm } = context;
  const t = i18n.t;
  const lifetime = new AbortController();
  const links = Object.freeze({ appUrl, groupId, conversationId, xrm });
  let op = null;
  let progress = null;
  let pollTimer = 0;
  let current = null;

  const header = buildHeader({ i18n, context, onRefresh: () => load() });
  const main = h("main", { className: "cqa-embed__main", attrs: { id: "cqa-embed-main", "aria-labelledby": "cqa-embed-title" } });
  const live = h("p", { className: "cqa-sr-only", attrs: { role: "status", "aria-live": "polite" } });
  root.replaceChildren(header.el, main, buildFooter({ i18n, context }), live);
  const dialog = createAppealDialog({ root, i18n, signal: lifetime.signal, onSubmitted: onAppealSubmitted });

  if (context.status === "ok") start();
  else showContextProblem();

  return { destroy };

  function start() {
    const pending = readPending(groupId, conversationId);
    if (pending) waitForPending(pending);
    else load();
  }

  async function load() {
    const signal = beginOp();
    show(loadingView({ i18n }));
    try {
      const [latest] = await fetchEvaluations(groupId, conversationId, { signal });
      if (latest) await showEvaluation(latest, { signal });
      else showEmpty();
    } catch (error) {
      if (!isAbortError(error)) showError("errorLoadTitle", error, () => load());
    }
  }

  async function evaluate() {
    const pending = Object.freeze({ startedAt: Date.now(), previousId: current?.evaluation.id ?? "" });
    writePending(groupId, conversationId, pending);
    const signal = beginOp();
    showProgress(pending.startedAt, false);
    try {
      const evaluation = await evaluateConversation({ groupId, conversationId }, { signal });
      clearPending(groupId, conversationId);
      refreshHostForm(xrm);
      await showEvaluation(evaluation, { signal, notice: t("evaluatedNotice"), focus: true });
    } catch (error) {
      // Отмена = iframe уничтожен формой: отметку оставляем, новый iframe дождётся результата сервера.
      if (isAbortError(error)) return;
      clearPending(groupId, conversationId);
      showError("errorEvaluateTitle", error, () => evaluate(), true);
    } finally {
      stopProgress();
    }
  }

  /** Оценку запустил прошлый экземпляр панели: опрашиваем историю, пока не появится новая. */
  function waitForPending(pending) {
    const signal = beginOp();
    showProgress(pending.startedAt, true);
    const poll = async () => {
      if (signal.aborted) return;
      try {
        const [latest] = await fetchEvaluations(groupId, conversationId, { signal });
        if (latest && latest.id !== pending.previousId) {
          clearPending(groupId, conversationId);
          stopProgress();
          refreshHostForm(xrm);
          await showEvaluation(latest, { signal, notice: t("evaluatedNotice") });
          return;
        }
      } catch (error) {
        if (isAbortError(error)) return;
        // Сбой одного опроса не прерывает ожидание; по истечении срока load() покажет ошибку, если она стойкая.
      }
      if (Date.now() - pending.startedAt >= PENDING_TTL_MS) {
        clearPending(groupId, conversationId);
        stopProgress();
        load();
        return;
      }
      pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
  }

  async function showEvaluation(evaluation, { signal, notice = "", focus = false }) {
    const checklist = await withinTime(fetchChecklistVersion(evaluation.checklistId, evaluation.checklistVersion, { signal }), CHECKLIST_WAIT_MS);
    if (signal.aborted) return;
    current = Object.freeze({ evaluation, checklist });
    if (evaluation.status === "error") {
      // Фокус переносим только после действия пользователя: при загрузке формы панель его не забирает.
      showError("evaluationFailedTitle", { message: evaluation.error, code: "" }, () => evaluate(), focus);
      return;
    }
    const canAppeal = appealableCriteria(evaluation).length > 0;
    const noticeEl = notice
      ? h("p", { className: "cqa-embed-notice", attrs: { tabindex: "-1" } }, glyph("check", { size: 18 }), h("span", { text: notice }))
      : null;
    const dispute = actionButton({
      label: t("dispute"), glyphName: "dispute", onClick: () => openAppeal(""),
      attrs: canAppeal ? {} : { "aria-disabled": "true", title: t("appealNothing") },
    });
    show(noticeEl, summaryView({ evaluation, i18n, actions: [dispute, openCardLink()] }), sectionsView({ evaluation, i18n }),
      criteriaView({ evaluation, checklist, i18n, links, canAppeal, onAppeal: openAppeal }));
    if (notice) announce(notice);
    if (focus && noticeEl) focusWithoutScroll(noticeEl);
  }

  function showEmpty() {
    current = null;
    show(stateView({
      title: t("emptyTitle"), text: t("emptyText"), i18n,
      actions: [actionButton({ label: t("evaluate"), iconName: "sparkle", onClick: () => evaluate() }), openCardLink()],
    }));
  }

  function showProgress(startedAt, resumed) {
    stopProgress();
    progress = progressView({ i18n, startedAt, resumed });
    header.setBusy(true);
    show(progress.el);
  }

  function stopProgress() {
    progress?.stop();
    progress = null;
    window.clearTimeout(pollTimer);
    header.setBusy(false);
  }

  function showError(titleKey, error, retry, focus = false) {
    const { text, code } = describeError(error, i18n, { groupId, conversationId });
    const block = stateView({
      kind: "error", title: t(titleKey), text, code, i18n,
      actions: [actionButton({ label: t(titleKey === "errorLoadTitle" ? "retry" : "evaluateAgain"), iconName: "refresh", onClick: retry })],
    });
    show(block);
    if (focus) focusWithoutScroll(block.querySelector("h2"));
  }

  function showContextProblem() {
    const problem = CONTEXT_PROBLEMS[context.status] ?? CONTEXT_PROBLEMS.missing;
    show(stateView({ kind: problem.kind, title: t(problem.title), text: t(problem.text, { value: context.invalidValue }), i18n }));
  }

  function openAppeal(criterionId) {
    if (!current || !dialog.open({ evaluation: current.evaluation, checklist: current.checklist, criterionId })) {
      announce(t("appealNothing"));
    }
  }

  /** Апелляция создана: перечитываем оценку (у критерия появится appeal), при сбое — отмечаем локально. */
  async function onAppealSubmitted(appeal, criterion) {
    const notice = t("appealSent", { criterion: criterion.title });
    refreshHostForm(xrm);
    const signal = beginOp();
    const shown = current.evaluation;
    let evaluation;
    try {
      evaluation = await fetchEvaluation(shown.id, { signal });
    } catch (error) {
      if (isAbortError(error)) return;
      evaluation = withLocalAppeal(shown, criterion.criterionId, appeal);
    }
    try {
      await showEvaluation(evaluation, { signal, notice, focus: true });
    } catch (error) {
      if (!isAbortError(error)) showError("errorLoadTitle", error, () => load());
    }
  }

  function openCardLink() {
    return externalLink({
      href: cardHref(appUrl, groupId, conversationId), className: "cqa-btn cqa-btn--sm cqa-btn--white",
      label: t("openCard"), srText: t("newTab"), xrm,
      children: [glyph("external", { size: 16 })],
    });
  }

  function show(...nodes) {
    main.replaceChildren(...nodes.filter(Boolean));
  }

  function announce(text) {
    live.textContent = "";
    window.setTimeout(() => { live.textContent = text; }, ANNOUNCE_DELAY_MS);
  }

  /** Новая операция отменяет предыдущую (повторная загрузка, оценка, ожидание). */
  function beginOp() {
    op?.abort();
    op = new AbortController();
    return op.signal;
  }

  function destroy() {
    lifetime.abort();
    op?.abort();
    stopProgress();
    dialog.destroy();
  }
}

/**
 * Данные записи изменились (итог оценки в шапке формы): просим форму перечитать их без сохранения —
 * formContext.data.refresh(false). Веб-ресурс при этом не пересоздаётся.
 */
function refreshHostForm(xrm) {
  try {
    const pending = xrm?.Page?.data?.refresh?.(false);
    pending?.catch?.(() => {}); // форма не обновилась — панель показывает свежие данные и без неё
  } catch {
    // вне формы (диалог из списка, карта сайта) data.refresh нет — обновлять нечего
  }
}

/** Новая оценка с апелляцией у критерия — без изменения исходного объекта. */
function withLocalAppeal(evaluation, criterionId, appeal) {
  const localAppeal = Object.freeze({
    id: appeal.id, status: appeal.status, comment: appeal.comment, createdAt: appeal.createdAt,
    originalAnswer: appeal.originalAnswer, decision: appeal.decision,
  });
  const criteria = evaluation.criteria.map((criterion) =>
    (criterion.criterionId === criterionId ? Object.freeze({ ...criterion, appeal: localAppeal }) : criterion));
  return Object.freeze({ ...evaluation, criteria: Object.freeze(criteria) });
}

/** Ждём необязательное дополнение (ступени шкалы) не дольше ms; отмена операции пробрасывается. */
function withinTime(promise, ms) {
  let timer = 0;
  const timeout = new Promise((resolve) => { timer = window.setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}
