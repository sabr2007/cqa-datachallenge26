// Панель «Оценка» в карточке диалога: запуск оценки (с выбором моделей), ожидание с прогрессом
// по времени, результат с обоснованием, история оценок и апелляции по критериям.
// Оценка живёт в реестре evalJobs — уход с карточки её не прерывает.

import { createAppeal, fetchChecklistVersion, fetchEvaluations, isAbortError, rememberEvaluation } from "../api.js";
import { h, prefersReducedMotion, setChildren } from "../dom.js";
import { icon } from "../icons.js";
import { FORMS, countLabel, criterionNumber, formatDateTime, formatInt, formatPoints, plural } from "../format.js";
import { answerTone, appealStatusOf, criticalState, maxStepOf } from "../evaluation.js";
import { getJob, runEvaluation, subscribeJobs } from "../components/evalJobs.js";
import { evaluationResult } from "../components/evalResult.js";
import { notifyAppealsChanged } from "../components/header.js";
import { modelPicker, selectedModels } from "../components/modelPicker.js";
import { button, pill, stateBlock, statusPill } from "../components/ui.js";

const TITLE_ID = "cqa-eval-title";
const DOC_WAIT_MS = 4000;
const PROGRESS_TAU_SEC = 35;
const STAGES = Object.freeze([
  { until: 5, text: "Отправляем диалог моделям" },
  { until: 25, text: "Модели оценивают критерии — каждый отдельным запросом, параллельно" },
  { until: 60, text: "Проверяем цитаты в репликах и сводим голоса моделей" },
  { until: 90, text: "Почти готово: считаем баллы, секции и итог" },
  { until: Infinity, text: "Дольше обычного — ждём ответ сервера (не более 150 с)" },
]);

/**
 * @param {{ groupId: string, conversationId: string, appealHref: (id: string) => string,
 *   onEvidence: (index: number) => void, onRange: (range: readonly [number, number]) => void,
 *   onMarkers: (markers: Map<number, Array<object>>) => void, onRetryChecklist: () => void }} options
 */
export function createEvalPanel(options) {
  const { groupId, conversationId } = options;
  const card = h("div", { className: "cqa-eval__card" });
  const el = h("aside", { className: "cqa-eval", attrs: { "aria-labelledby": TITLE_ID } }, card);
  const headPill = h("span", { className: "cqa-eval__pill" });
  const head = h("div", { className: "cqa-eval__head" }, h("h2", { className: "cqa-h3", attrs: { id: TITLE_ID }, text: "Оценка" }), headPill);
  const runSlot = h("div", { className: "cqa-eval__run" });
  const bodySlot = h("div", { className: "cqa-eval__body" });
  const footSlot = h("div", { className: "cqa-eval__run cqa-eval__foot" });
  card.replaceChildren(head, runSlot, bodySlot, footSlot);

  const controller = new AbortController();
  const picker = modelPicker({ compact: true });
  const docs = new Map();
  const view = {
    checklist: null, checklistError: null, isCall: false,
    history: { status: "loading", items: [], error: null },
    selectedId: null, runError: null, result: null, ticker: 0,
  };

  const unsubscribe = subscribeJobs(({ type, job }) => {
    if (job.groupId !== groupId || job.conversationId !== conversationId) return;
    if (type === "done") {
      view.history = { ...view.history, status: "ready", items: [job.evaluation, ...view.history.items.filter((e) => e.id !== job.evaluation.id)] };
      view.selectedId = job.evaluation.id;
      view.runError = null;
      renderBody();
    }
    if (type === "error") view.runError = job.error;
    renderRun();
    renderHead();
  });

  renderHead();
  renderRun();
  renderBody();
  loadHistory();

  async function loadHistory() {
    view.history = { status: "loading", items: view.history.items, error: null };
    renderBody();
    try {
      const items = await fetchEvaluations(groupId, conversationId, { signal: controller.signal });
      view.history = { status: "ready", items: mergeHistory(items, view.history.items), error: null };
    } catch (error) {
      if (isAbortError(error)) return;
      view.history = { status: "error", items: view.history.items, error };
    }
    renderHead();
    renderRun();
    renderBody();
  }

  /* ---------- шапка ---------- */

  function renderHead() {
    const job = runningJob();
    const evaluation = latest();
    if (job) return headPill.replaceChildren(statusPill("pending", "Оценивается…"));
    if (!evaluation) return setChildren(headPill, view.history.status === "loading" ? null : pill("Не оценено", { variant: "dashed" }));
    if (criticalState(evaluation).now) return headPill.replaceChildren(statusPill("error", "Грубая ошибка"));
    if (appealStatusOf(evaluation) === "open") return headPill.replaceChildren(statusPill("appeal", "Апелляция"));
    if (evaluation.needsReview) return headPill.replaceChildren(statusPill("review", "Нужна проверка"));
    return headPill.replaceChildren(statusPill("done", "Оценено"));
  }

  /* ---------- запуск и ожидание ---------- */

  /** Без результата кнопка «Оценить» — сверху; с результатом сверху итог, «Оценить заново» — внизу панели. */
  function renderRun() {
    window.clearInterval(view.ticker);
    const job = runningJob();
    if (job) {
      runSlot.replaceChildren(progressBlock(job));
      footSlot.replaceChildren();
      return;
    }
    if (view.history.status === "loading" && !latest()) {
      runSlot.replaceChildren();
      footSlot.replaceChildren();
      return;
    }
    const hasResult = Boolean(latest());
    const controls = h("div", { className: "cqa-run" },
      button({
        label: hasResult ? "Оценить заново" : "Оценить диалог",
        variant: hasResult ? "white block" : "dark block",
        iconName: hasResult ? "refresh" : "sparkle",
        onClick: () => start({}),
      }),
      picker.el,
      h("p", { className: "cqa-run__hint", text: "Занимает 30–90 с: каждый критерий проверяется отдельным запросом к модели." }));
    const failure = view.runError ?? failureAsError(lastFailure());
    setChildren(runSlot, failure ? runErrorBlock(failure) : null, outdatedNotice(), hasResult ? null : controls);
    setChildren(footSlot, hasResult ? controls : null);
  }

  function start({ checklistVersion, reusePrevious = false }) {
    view.runError = null;
    runEvaluation({ groupId, conversationId, models: selectedModels(), checklistVersion, reusePrevious });
    renderRun();
    renderHead();
    const progress = runSlot.querySelector(".cqa-progress");
    progress?.focus({ preventScroll: true });
    progress?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  function progressBlock(job) {
    const elapsed = h("span", { className: "cqa-progress__time cqa-num", attrs: { "aria-hidden": "true" } });
    const fill = h("span", { className: "cqa-progress__fill" });
    const stage = h("p", { className: "cqa-progress__stage", attrs: { "aria-live": "polite" } });
    const block = h("div", { className: "cqa-progress", attrs: { tabindex: "-1", "aria-labelledby": "cqa-progress-title" } },
      h("div", { className: "cqa-progress__head" },
        h("span", { className: "cqa-spinner", attrs: { "aria-hidden": "true" } }),
        h("strong", { attrs: { id: "cqa-progress-title" }, text: "Оцениваем диалог" }),
        elapsed),
      h("div", { className: "cqa-progress__track", attrs: { "aria-hidden": "true" } }, fill),
      stage,
      h("p", { className: "cqa-progress__hint", text: "Обычно 30–90 с. Можно открыть другой диалог — оценка продолжится, итог появится здесь и в списке." }));
    const tick = () => {
      const seconds = Math.max(0, (Date.now() - job.startedAt) / 1000);
      elapsed.textContent = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
      fill.style.setProperty("--cqa-p", Math.min(0.95, 1 - Math.exp(-seconds / PROGRESS_TAU_SEC)).toFixed(3));
      const text = STAGES.find((s) => seconds < s.until).text;
      if (stage.textContent !== text) stage.textContent = text;
    };
    tick();
    view.ticker = window.setInterval(tick, 1000);
    return block;
  }

  function runErrorBlock(error) {
    return h("div", { className: "cqa-run-error", attrs: { role: "alert" } },
      h("p", { className: "cqa-run-error__title" }, icon("alert", { size: 18 }), error.title ?? "Оценка не выполнена"),
      h("p", { className: "cqa-run-error__text", text: error.message }),
      error.code ? h("p", { className: "cqa-run-error__code", text: `Код: ${error.code}` }) : null,
      button({ label: "Повторить", variant: "dark sm", iconName: "refresh", onClick: () => start({}) }));
  }

  function outdatedNotice() {
    const evaluation = latest();
    const current = view.checklist;
    if (!evaluation || !current || current.version === null || evaluation.checklistVersion === null) return null;
    if (current.id && evaluation.checklistId && current.id !== evaluation.checklistId) return null;
    if (current.version <= evaluation.checklistVersion) return null;
    return h("div", { className: "cqa-outdated" },
      h("p", {}, h("strong", { text: `Чек-лист обновлён до версии ${current.version}. ` }),
        `Эта оценка сделана по версии ${evaluation.checklistVersion}. Неизменённые критерии возьмём из неё, изменённые оценим заново.`),
      button({
        label: `Переоценить по версии ${current.version}`, variant: "dark sm", iconName: "refresh",
        onClick: () => start({ checklistVersion: current.version, reusePrevious: true }),
      }));
  }

  /* ---------- результат / чек-лист / состояния ---------- */

  async function renderBody() {
    const evaluation = selected();
    if (!evaluation) {
      view.result = null;
      options.onMarkers(new Map());
      bodySlot.replaceChildren(...emptyBody());
      return;
    }
    const doc = await checklistDoc(evaluation);
    if (selected() !== evaluation) return; // за время загрузки выбрали другую оценку
    const isLatest = evaluation.id === latest()?.id;
    const scrollTop = el.scrollTop;
    view.result = evaluationResult(evaluation, {
      checklist: doc,
      canAppeal: isLatest && evaluation.status === "done",
      isCall: view.isCall,
      onEvidence: options.onEvidence,
      onRange: options.onRange,
      appealHref: options.appealHref,
      onAppeal: (criterion, comment) => appeal(evaluation.id, criterion, comment),
    });
    setChildren(bodySlot,
      isLatest ? null : olderNotice(),
      view.result.el,
      historyBlock());
    el.scrollTop = scrollTop;
    options.onMarkers(markersFor(evaluation, doc));
  }

  function emptyBody() {
    if (view.history.status === "loading") {
      return [h("p", { className: "cqa-eval__note", attrs: { role: "status" }, text: "Загружаем оценки диалога…" }),
        ...Array.from({ length: 4 }, () => h("span", { className: "cqa-skel cqa-skel--line cqa-skel--w90", attrs: { "aria-hidden": "true" } }))];
    }
    const parts = [];
    if (view.history.status === "error") {
      parts.push(stateBlock({
        kind: "error", title: "История оценок не загрузилась", text: view.history.error.message, code: view.history.error.code,
        actions: [button({ label: "Повторить", iconName: "refresh", variant: "dark sm", onClick: loadHistory })],
      }));
    }
    if (view.checklist) parts.push(...pendingChecklist(view.checklist));
    else if (view.checklistError) {
      parts.push(stateBlock({
        kind: "error", title: "Чек-лист не загрузился", text: view.checklistError.message, code: view.checklistError.code,
        actions: [button({ label: "Повторить", iconName: "refresh", variant: "dark sm", onClick: options.onRetryChecklist })],
      }));
    }
    return parts;
  }

  function olderNotice() {
    return h("div", { className: "cqa-older" },
      h("p", { text: "Показана одна из прошлых оценок. Апелляции подаются по последней." }),
      button({ label: "К последней", variant: "gray sm", onClick: () => select(latest()?.id) }));
  }

  function historyBlock() {
    const items = done();
    if (items.length < 2) return null;
    const historySelect = h("select", { className: "cqa-select", attrs: { id: "cqa-history", name: "history" } },
      items.map((evaluation, i) => h("option", {
        attrs: { value: evaluation.id, selected: evaluation.id === selected()?.id },
        text: historyLabel(evaluation, i === 0),
      })));
    historySelect.addEventListener("change", () => selectEvaluation(historySelect.value, { focusHistory: true }));
    return h("div", { className: "cqa-history" },
      h("label", { className: "cqa-form__label", attrs: { for: "cqa-history" }, text: `История оценок · ${formatInt(items.length)}` }),
      historySelect);
  }

  async function selectEvaluation(id, { focusHistory = false } = {}) {
    view.selectedId = id;
    await renderBody();
    if (focusHistory) el.querySelector("#cqa-history")?.focus();
  }

  function select(id) {
    if (!id) return;
    selectEvaluation(id);
    el.querySelector(".cqa-score")?.scrollIntoView({ block: "nearest" });
  }

  async function appeal(evaluationId, criterion, comment) {
    const created = await createAppeal(evaluationId, { criterionId: criterion.criterionId, comment });
    const summary = Object.freeze({
      id: created.id, status: created.status, comment: created.comment || comment, createdAt: created.createdAt,
      originalAnswer: created.originalAnswer ?? criterion.answer, decision: created.decision,
    });
    const items = view.history.items.map((evaluation) => (evaluation.id !== evaluationId ? evaluation : Object.freeze({
      ...evaluation,
      criteria: Object.freeze(evaluation.criteria.map((c) => (c.criterionId === criterion.criterionId ? Object.freeze({ ...c, appeal: summary }) : c))),
    })));
    view.history = { ...view.history, items };
    const updated = items.find((evaluation) => evaluation.id === evaluationId);
    if (updated) rememberEvaluation(updated);
    notifyAppealsChanged(groupId);
    renderHead();
    return summary;
  }

  /* ---------- данные ---------- */

  function runningJob() {
    const job = getJob(groupId, conversationId);
    return job?.state === "running" ? job : null;
  }

  /** Успешные оценки (новые первыми); неудачные попытки бэкенд тоже хранит — их показываем отдельно. */
  function done() {
    return view.history.items.filter((evaluation) => evaluation.status === "done");
  }

  function latest() {
    return done()[0] ?? null;
  }

  /** Самая новая попытка оценки закончилась ошибкой (и она новее последней успешной). */
  function lastFailure() {
    const newest = view.history.items[0];
    return newest && newest.status === "error" ? newest : null;
  }

  function selected() {
    return done().find((evaluation) => evaluation.id === view.selectedId) ?? latest();
  }

  async function checklistDoc(evaluation) {
    const key = `${evaluation.checklistId}@${evaluation.checklistVersion}`;
    if (docs.has(key)) return docs.get(key);
    const timeout = new Promise((resolve) => { window.setTimeout(() => resolve(null), DOC_WAIT_MS); });
    const doc = await Promise.race([
      fetchChecklistVersion(evaluation.checklistId, evaluation.checklistVersion, { signal: controller.signal }).catch(() => null),
      timeout,
    ]);
    if (doc) docs.set(key, doc);
    return doc;
  }

  return {
    el,
    showLoadingChecklist() {
      view.checklistError = null;
    },
    showChecklist(checklist) {
      view.checklist = checklist;
      view.checklistError = null;
      renderRun();
      if (!selected()) renderBody();
    },
    showChecklistError(error) {
      view.checklistError = error;
      if (!selected()) renderBody();
    },
    setCall(isCall) {
      if (view.isCall === isCall) return;
      view.isCall = isCall;
      if (selected()) renderBody();
    },
    reveal(criterionId) {
      view.result?.reveal(criterionId);
    },
    dispose() {
      controller.abort();
      unsubscribe();
      window.clearInterval(view.ticker);
    },
  };
}

/* ---------- вспомогательное ---------- */

/** Сохранённая неудачная попытка → вид ошибки для блока «Оценка не выполнена». */
function failureAsError(evaluation) {
  if (!evaluation) return null;
  const when = formatDateTime(evaluation.createdAt);
  return {
    title: "Последняя попытка оценки не удалась",
    message: [when, evaluation.error || "движок не вернул результат"].filter(Boolean).join(" · "),
    code: "",
  };
}

function mergeHistory(fetched, local) {
  const ids = new Set(fetched.map((evaluation) => evaluation.id));
  return [...local.filter((evaluation) => !ids.has(evaluation.id)), ...fetched]
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

function historyLabel(evaluation, isLatest) {
  const total = evaluation.finalTotal ?? evaluation.total;
  return [
    formatDateTime(evaluation.createdAt) || evaluation.id,
    total === null ? "без итога" : `итог ${formatPoints(total)}`,
    evaluation.checklistVersion !== null ? `чек-лист v${evaluation.checklistVersion}` : "",
    isLatest ? "последняя" : "",
  ].filter(Boolean).join(" · ");
}

/** Отметки в транскрипте: реплики-доказательства невыполненных критериев и грубой ошибки. */
function markersFor(evaluation, doc) {
  const docs = new Map((doc?.criteria ?? []).map((criterion) => [criterion.id, criterion]));
  const markers = new Map();
  for (const criterion of evaluation.criteria) {
    const tone = answerTone(criterion.finalAnswer, { critical: criterion.critical, maxStep: maxStepOf(docs.get(criterion.criterionId)) });
    if (tone !== "fail" && tone !== "partial") continue;
    for (const evidence of criterion.evidence) {
      const list = markers.get(evidence.index) ?? [];
      markers.set(evidence.index, [...list, Object.freeze({
        criterionId: criterion.criterionId,
        number: criterionNumber(criterion.criterionId, 0),
        title: criterion.title,
        tone: criterion.critical ? "critical" : tone,
      })]);
    }
  }
  return markers;
}

/** «Не оценено»: критерии чек-листа с весами (до первой оценки). */
function pendingChecklist(checklist) {
  const version = checklist.version !== null ? `, версия ${checklist.version}` : "";
  return [
    h("p", { className: "cqa-eval__score", attrs: { "aria-label": "Итог ещё не рассчитан, максимум 100 баллов" } },
      h("span", { className: "cqa-eval__total", attrs: { "aria-hidden": "true" }, text: "—" }),
      h("span", { className: "cqa-eval__max", attrs: { "aria-hidden": "true" }, text: "/ 100" })),
    h("p", { className: "cqa-eval__note", text: `«${checklist.title}»${version} · ${countLabel(checklist.criteria.length, FORMS.criterion)}` }),
    ...checklist.sections.map(pendingSection),
  ];
}

function pendingSection(sectionData) {
  const scoredWeight = sectionData.criteria.filter((c) => c.scored).reduce((sum, c) => sum + c.weight, 0);
  const allCritical = sectionData.criteria.length > 0 && sectionData.criteria.every((c) => !c.scored);
  const weightLabel = allCritical ? "без баллов" : `${formatInt(scoredWeight)} ${plural(scoredWeight, FORMS.point)}`;
  return h("section", { className: "cqa-eval__section" },
    h("h3", { className: "cqa-eval__section-title" }, h("span", { text: sectionData.title }), h("span", { text: weightLabel })),
    h("ul", {}, sectionData.criteria.map((criterion, position) => {
      const weight = criterion.scored ? `— / ${formatInt(criterion.weight)}` : "отметка";
      const srStatus = criterion.scored ? `не оценено, вес ${criterion.weight}` : "не оценено, без баллов";
      return h("li", { className: "cqa-eval__crit" },
        h("span", { className: "cqa-eval__crit-num", text: criterionNumber(criterion.id, position) }),
        h("span", { text: criterion.title }),
        h("span", { className: "cqa-eval__crit-status" },
          h("span", { className: "cqa-eval__pending", attrs: { "aria-hidden": "true" } }),
          h("span", { attrs: { "aria-hidden": "true" }, text: weight }),
          h("span", { className: "cqa-sr-only", text: srStatus })));
    })));
}
