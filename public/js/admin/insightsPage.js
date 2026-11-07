// Экран «Аналитика»: точность оценки против эталона и «где ломается сценарий».
// Вкладка — в URL (#/insights?g=DEV&tab=scenario) через replaceHash.

import { isAbortError } from "../api.js";
import { h } from "../dom.js";
import { buildHash, replaceHash } from "../router.js";
import { button, loadingNote, stateBlock } from "../components/ui.js";
import { accuracyPanel } from "./accuracyPanel.js";
import { getAccuracy, getAnalytics, getChecklist } from "./api.js";
import { formatPercent } from "./labels.js";
import { scenarioPanel } from "./scenarioPanel.js";
import { setChildren } from "./ui.js";

const TABS = Object.freeze([
  { id: "accuracy", label: "Точность оценки" },
  { id: "scenario", label: "Где ломается сценарий" },
]);
const GOLD_GROUP = "DEV";

/** @param {HTMLElement} main @param {{ route: { query: URLSearchParams }, groupId: string, setTitle: (t: string) => void }} ctx */
export function renderInsightsPage(main, ctx) {
  const controller = new AbortController();
  const { signal } = controller;
  const { groupId } = ctx;
  let tab = TABS.some((t) => t.id === ctx.route.query.get("tab")) ? ctx.route.query.get("tab") : "accuracy";
  const cache = { accuracy: null, analytics: null, checklist: undefined };
  let note = null;
  ctx.setTitle("Аналитика");

  const heroValue = h("span", { className: "cqa-in-hero__value", text: "—" });
  const heroSub = h("span", { className: "cqa-in-hero__sub", text: "Загружаем точность…" });
  const hero = h("section", { className: "cqa-hero", attrs: { "aria-labelledby": "cqa-page-title" } },
    h("div", { className: "cqa-container cqa-hero__grid" },
      h("div", { className: "cqa-hero__copy" },
        h("p", { className: "cqa-eyebrow" }, h("span", { className: "cqa-eyebrow__dot", attrs: { "aria-hidden": "true" } }), `Аналитика · набор ${groupId}`),
        h("h1", { className: "cqa-display", attrs: { id: "cqa-page-title", tabindex: "-1" }, text: "Аналитика" }),
        h("p", { className: "cqa-lead cqa-grad-text", text: "Насколько точна оценка и где ломается сценарий" }),
        h("p", { className: "cqa-body-l", text: "Точность — сравнение ответов системы с ручной разметкой экспертов по каждому критерию. Сценарий — где операторы чаще всего ошибаются, с цитатами и ссылками на реплики." })),
      h("div", { className: "cqa-hero__aside" },
        h("div", { className: "cqa-summary cqa-in-hero" },
          h("p", { className: "cqa-summary__kicker", text: `Совпадение с эталоном · ${GOLD_GROUP}` }),
          h("p", { className: "cqa-summary__total" }, heroValue),
          heroSub))));
  const tabsEl = h("div", { className: "cqa-a-tabs", attrs: { role: "tablist", "aria-label": "Разделы аналитики" } });
  const panel = h("div", { className: "cqa-a-panel", attrs: { id: "cqa-a-panel", role: "tabpanel", tabindex: "-1" } });
  main.replaceChildren(hero, h("div", { className: "cqa-sheet cqa-a-sheet" }, h("div", { className: "cqa-container" }, tabsEl, panel)));

  renderTabs();
  loadHero();
  show();

  function renderTabs() {
    panel.setAttribute("aria-labelledby", `cqa-a-tab-${tab}`);
    tabsEl.replaceChildren(...TABS.map((t) => h("button", {
      className: "cqa-a-tab",
      attrs: { id: `cqa-a-tab-${t.id}`, type: "button", role: "tab", "aria-selected": String(t.id === tab), "aria-controls": "cqa-a-panel", tabindex: t.id === tab ? "0" : "-1", "data-tab": t.id },
      on: { click: () => select(t.id), keydown: onKey },
    }, t.label)));
  }

  function onKey(event) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const index = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(index + delta + TABS.length) % TABS.length].id;
    select(next);
    tabsEl.querySelector(`[data-tab="${next}"]`)?.focus();
  }

  function select(next) {
    if (next === tab) return;
    tab = next;
    renderTabs();
    show();
  }

  async function loadHero() {
    try {
      const accuracy = await accuracyFor(GOLD_GROUP);
      heroValue.textContent = formatPercent(accuracy.overall?.accuracy ?? null);
      heroSub.textContent = accuracy.overall?.total
        ? `${accuracy.overall.matched} из ${accuracy.overall.total} ответов по критериям · отложенные ${formatPercent(accuracy.bySet.holdout?.accuracy)}`
        : "Размеченные диалоги ещё не оценены";
    } catch (error) {
      if (isAbortError(error)) return;
      heroSub.textContent = "Метрики точности недоступны";
    }
  }

  async function accuracyFor(group) {
    if (group === GOLD_GROUP && cache.accuracy) return cache.accuracy;
    const value = await getAccuracy({ groupId: group }, { signal });
    if (group === GOLD_GROUP) cache.accuracy = value;
    return value;
  }

  async function show() {
    replaceHash(buildHash("/insights", { g: groupId, tab: tab === "accuracy" ? null : tab }));
    note?.stop();
    note = loadingNote(tab === "accuracy" ? "Сравниваем оценки с эталоном…" : "Собираем аналитику набора…");
    setChildren(panel, note.el);
    const current = tab;
    try {
      const checklist = await loadChecklist();
      const titles = new Map((checklist?.criteria ?? []).map((c) => [c.id, c.title]));
      if (current === "accuracy") {
        const accuracy = groupId === GOLD_GROUP ? await accuracyFor(GOLD_GROUP) : await getAccuracy({ groupId }, { signal });
        if (tab !== current) return;
        setChildren(panel, accuracyPanel(accuracy, { groupId, titles }));
      } else {
        cache.analytics = cache.analytics ?? await getAnalytics(groupId, { signal });
        if (tab !== current) return;
        setChildren(panel, scenarioPanel(cache.analytics, { groupId, checklist }));
      }
    } catch (error) {
      if (isAbortError(error) || tab !== current) return;
      setChildren(panel, stateBlock({
        kind: "error",
        title: current === "accuracy" ? "Не удалось посчитать точность" : "Не удалось загрузить аналитику",
        text: error.message, code: error.code,
        actions: [button({ label: "Повторить", iconName: "refresh", onClick: () => { cache.analytics = null; cache.accuracy = null; show(); } })],
      }));
    } finally {
      note?.stop();
    }
  }

  /** Действующий чек-лист — для названий критериев и рекомендаций; без него аналитика всё равно показывается. */
  async function loadChecklist() {
    if (cache.checklist !== undefined) return cache.checklist;
    try {
      cache.checklist = await getChecklist("default", { signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      cache.checklist = null;
    }
    return cache.checklist;
  }

  return () => {
    controller.abort();
    note?.stop();
  };
}
