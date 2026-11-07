// Очередь апелляций набора: открытые / решённые / все. Роль проверяющего включается явно
// переключателем «Я — проверяющий» (авторизации в прототипе нет); решение пересчитывает итог диалога.
// Адрес: #/appeals?g=DEV&status=open|resolved|all&id=ap_… (id — подсветить конкретную апелляцию).

import { fetchAppeals, fetchChecklistVersion, fetchEvaluation, isAbortError } from "../api.js";
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { FORMS, countLabel, formatInt, formatPoints } from "../format.js";
import { buildHash, paths, replaceHash } from "../router.js";
import { appealCard, mergeAppeal } from "../components/appealCard.js";
import { segmented } from "../components/controls.js";
import { notifyAppealsChanged } from "../components/header.js";
import { button, loadingNote, stateBlock } from "../components/ui.js";

const ROLE_KEY = "cqa-reviewer";
const DETAIL_CONCURRENCY = 4;
const TABS = Object.freeze([
  { value: "open", label: "Открытые" },
  { value: "resolved", label: "Решённые" },
  { value: "all", label: "Все" },
]);

/** @param {HTMLElement} main @param {object} ctx */
export function renderAppeals(main, ctx) {
  const { groupId } = ctx;
  const controller = new AbortController();
  const query = ctx.route.query;
  const view = {
    status: TABS.some((t) => t.value === query.get("status")) ? query.get("status") : "open",
    targetId: query.get("id") ?? "",
    reviewer: readRole(),
    appeals: [],
    cards: new Map(),
    details: new Map(), // evaluationId → { evaluation, checklist }
    note: null,
  };
  ctx.setTitle("Апелляции");

  const role = roleSwitch(view.reviewer, (value) => {
    view.reviewer = value;
    storeRole(value);
    for (const card of view.cards.values()) card.setReviewer(value);
  });
  const tabs = segmented(TABS, view.status, (status) => {
    view.status = status;
    view.targetId = "";
    replaceHash(buildHash(paths.appeals, { g: groupId, status }));
    renderList();
  });
  const announcer = h("p", { className: "cqa-sr-only", attrs: { role: "status" } });
  const info = h("p", { className: "cqa-meta-row__info", attrs: { "aria-live": "polite" } });
  const list = h("div", { className: "cqa-ac-list" });

  main.replaceChildren(
    h("section", { className: "cqa-hero cqa-hero--compact", attrs: { "aria-labelledby": "cqa-page-title" } },
      h("div", { className: "cqa-container cqa-hero__grid" },
        h("div", { className: "cqa-hero__copy" },
          h("p", { className: "cqa-eyebrow" }, h("span", { className: "cqa-eyebrow__dot", attrs: { "aria-hidden": "true" } }), `Набор ${groupId}`),
          h("h1", { className: "cqa-display", attrs: { id: "cqa-page-title", tabindex: "-1" }, text: "Апелляции" }),
          h("p", { className: "cqa-lead cqa-grad-text", text: "Спорные оценки по критериям: проверяющий подтверждает или меняет ответ с причиной, итог диалога пересчитывается" })),
        h("div", { className: "cqa-hero__aside" }, role.el))),
    h("div", { className: "cqa-sheet" },
      h("div", { className: "cqa-container" },
        h("div", { className: "cqa-toolbar cqa-toolbar--appeals" },
          h("div", { className: "cqa-filter" },
            h("span", { className: "cqa-filter__label" }, h("span", { attrs: { id: "cqa-ap-tabs" }, text: "Очередь" })), tabs.el),
          h("div", { className: "cqa-toolbar__end" },
            button({ label: "Обновить", variant: "gray sm", iconName: "refresh", onClick: () => load() }))),
        h("div", { className: "cqa-meta-row" }, info),
        list,
        announcer)));
  tabs.el.setAttribute("aria-labelledby", "cqa-ap-tabs");

  load();

  async function load() {
    view.note?.stop();
    view.note = loadingNote("Загружаем очередь апелляций…");
    info.replaceChildren(view.note.el);
    list.replaceChildren();
    try {
      view.appeals = await fetchAppeals(groupId, { signal: controller.signal });
      renderList();
      loadDetails();
    } catch (error) {
      if (isAbortError(error)) return;
      info.replaceChildren();
      list.replaceChildren(stateBlock({
        kind: "error", title: "Очередь апелляций не загрузилась", text: error.message, code: error.code,
        actions: [button({ label: "Повторить", iconName: "refresh", onClick: load })],
      }));
    } finally {
      view.note?.stop();
    }
  }

  /** Счётчики вкладок и строка-сводка; карточки при этом не перерисовываются. */
  function updateCounts(visibleCount = null) {
    const counts = {
      open: view.appeals.filter((a) => a.status === "open").length,
      resolved: view.appeals.filter((a) => a.status === "resolved").length,
    };
    tabs.setCounts({ ...counts, all: view.appeals.length }, view.appeals.length);
    const shown = visibleCount ?? view.cards.size;
    info.replaceChildren(view.appeals.length
      ? `На экране ${countLabel(shown, FORMS.appeal)} · открытых ${formatInt(counts.open)}, решённых ${formatInt(counts.resolved)}`
      : "");
  }

  function renderList() {
    const visible = sortAppeals(view.appeals.filter((a) => view.status === "all" || a.status === view.status), view.status);
    updateCounts(visible.length);
    if (visible.length === 0) {
      view.cards = new Map();
      list.replaceChildren(emptyState(view.status, view.appeals.length, groupId));
      return;
    }
    view.cards = new Map(visible.map((appeal) => [appeal.id, appealCard(appeal, {
      groupId,
      reviewer: view.reviewer,
      details: view.details.get(appeal.evaluationId) ?? null,
      onDecided: onDecided,
    })]));
    list.replaceChildren(...[...view.cards.values()].map((card) => card.el));
    focusTarget();
  }

  function focusTarget() {
    const card = view.cards.get(view.targetId);
    if (!card) return;
    window.requestAnimationFrame(() => {
      card.el.scrollIntoView({ block: "center", behavior: "smooth" });
      card.el.focus({ preventScroll: true });
      card.flash();
    });
  }

  /** Подробности оценки (обоснование, баллы, итог) и версия чек-листа — параллельно, не больше 4 запросов. */
  async function loadDetails() {
    const ids = [...new Set(view.appeals.map((a) => a.evaluationId))].filter((id) => id && !view.details.has(id));
    const queue = [...ids];
    const worker = async () => {
      while (queue.length && !controller.signal.aborted) {
        const evaluationId = queue.shift();
        try {
          const evaluation = await fetchEvaluation(evaluationId, { signal: controller.signal });
          const checklist = await fetchChecklistVersion(evaluation.checklistId, evaluation.checklistVersion, { signal: controller.signal }).catch(() => null);
          applyDetails(evaluationId, { evaluation, checklist });
        } catch (error) {
          if (isAbortError(error)) return;
          applyDetails(evaluationId, { evaluation: null, checklist: null });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, worker));
  }

  function applyDetails(evaluationId, details) {
    view.details.set(evaluationId, details);
    for (const appeal of view.appeals) {
      if (appeal.evaluationId === evaluationId) view.cards.get(appeal.id)?.setDetails(details);
    }
  }

  function onDecided({ appeal, evaluation, previousTotal }) {
    view.appeals = view.appeals.map((a) => (a.id === appeal.id ? mergeAppeal(a, appeal) : a));
    view.details.set(evaluation.id, { ...(view.details.get(evaluation.id) ?? { checklist: null }), evaluation });
    for (const other of view.appeals) {
      if (other.evaluationId === evaluation.id && other.id !== appeal.id) view.cards.get(other.id)?.setDetails(view.details.get(evaluation.id));
    }
    updateCounts();
    const before = previousTotal === null ? "—" : formatPoints(previousTotal);
    const after = evaluation.finalTotal === null ? "—" : formatPoints(evaluation.finalTotal);
    announcer.textContent = `Решение сохранено. Итог диалога ${appeal.conversationId}: было ${before}, стало ${after}.`;
    notifyAppealsChanged(groupId);
  }

  return () => {
    controller.abort();
    view.note?.stop();
  };
}

function sortAppeals(appeals, status) {
  const time = (value) => Date.parse(value || 0) || 0;
  if (status === "open") return [...appeals].sort((a, b) => time(a.createdAt) - time(b.createdAt)); // очередь: старые первыми
  return [...appeals].sort((a, b) => time(b.decision?.decidedAt || b.createdAt) - time(a.decision?.decidedAt || a.createdAt));
}

function emptyState(status, total, groupId) {
  const toList = button({ label: "К списку диалогов", href: buildHash(paths.conversations, { g: groupId }) });
  if (total === 0) {
    return stateBlock({
      kind: "empty", title: "Апелляций пока нет",
      text: "Апелляцию подают в карточке диалога: у критерия кнопка «Оспорить» и комментарий. Здесь она появится в очереди проверяющего.",
      actions: [toList],
    });
  }
  return stateBlock({
    kind: "empty",
    title: status === "open" ? "Открытых апелляций нет" : "Решённых апелляций нет",
    text: status === "open" ? "Все апелляции рассмотрены — решения во вкладке «Решённые»." : "Решения появятся здесь после рассмотрения открытых апелляций.",
    actions: [toList],
  });
}

/* ---------- роль ---------- */

function roleSwitch(initial, onChange) {
  let value = initial;
  const knob = h("span", { className: "cqa-switch__knob", attrs: { "aria-hidden": "true" } });
  const control = h("button", {
    className: "cqa-switch",
    attrs: { type: "button", role: "switch", "aria-checked": String(value), "aria-labelledby": "cqa-role-title", "aria-describedby": "cqa-role-text" },
    on: { click: () => set(!value) },
  }, knob);
  const status = h("p", { className: "cqa-role__state" });
  const el = h("div", { className: "cqa-role" },
    control,
    h("div", { className: "cqa-role__copy" },
      h("p", { className: "cqa-role__title", attrs: { id: "cqa-role-title" } }, icon("shield", { size: 18 }), "Я — проверяющий"),
      h("p", { className: "cqa-role__text", attrs: { id: "cqa-role-text" },
        text: "Включите, чтобы подтверждать или менять оценки. Подать апелляцию можно в карточке диалога — кнопка «Оспорить» у критерия." }),
      status));
  sync();

  function set(next) {
    value = next;
    sync();
    onChange(value);
  }
  function sync() {
    control.setAttribute("aria-checked", String(value));
    el.classList.toggle("is-on", value);
    status.textContent = value ? "Режим проверяющего включён" : "Сейчас: просмотр без права решения";
  }
  return { el };
}

function readRole() {
  try {
    return window.localStorage.getItem(ROLE_KEY) === "1";
  } catch {
    return false;
  }
}

function storeRole(value) {
  try {
    window.localStorage.setItem(ROLE_KEY, value ? "1" : "0");
  } catch {
    // хранилище недоступно — роль просто не запомнится
  }
}
