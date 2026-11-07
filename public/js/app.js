// Точка входа CQA UI. Всё монтируется в #cqa-root; без inline-скриптов и eval (строгий CSP).

import { configureApi, fetchHealth } from "./api.js";
import { focusWithoutScroll, h } from "./dom.js";
import { createHeader } from "./components/header.js";
import { DEFAULT_GROUP, buildHash, navigate, parseRoute, paths } from "./router.js";
import { applyTheme, currentTheme, readStoredTheme } from "./theme.js";
import { renderAppeals } from "./views/appeals.js";
import { renderChecklist } from "./views/checklist.js";
import { renderConversation } from "./views/conversation.js";
import { renderConversations } from "./views/conversations.js";
import { renderInsights } from "./views/insights.js";
import { renderNotFound } from "./views/notFound.js";

// Владельцы экранов — docs/CONTRACT.md («Зоны ответственности»).
const VIEWS = Object.freeze({
  conversations: renderConversations,
  conversation: renderConversation,
  checklist: renderChecklist,
  appeals: renderAppeals,
  insights: renderInsights,
  notFound: renderNotFound,
});

function boot() {
  const root = document.getElementById("cqa-root");
  if (!root) return;
  configureApi({ base: root.dataset.apiBase ?? "" });
  applyTheme(root, readStoredTheme());

  const main = h("main", { className: "cqa-main", attrs: { id: "cqa-main", tabindex: "-1" } });
  const app = { root, main, header: null, cleanup: null, routeName: null, listHash: null, listScrollY: 0, rendered: false };
  app.header = createHeader({
    onGroupSubmit: (groupId) => navigate(groupTarget(groupId)),
    onThemeToggle: () => app.header.setTheme(applyTheme(root, currentTheme(root) === "dark" ? "light" : "dark")),
  });
  app.header.setTheme(currentTheme(root));
  const skip = h("button", {
    className: "cqa-skip", attrs: { type: "button" }, text: "Перейти к содержимому",
    on: { click: () => focusWithoutScroll(main.querySelector("h1") ?? main) },
  });
  const footer = createFooter();
  root.replaceChildren(skip, app.header.el, main, footer.el);

  syncHeaderHeight(root, app.header.el);
  window.addEventListener("scroll", () => {
    if (app.routeName === "conversations") app.listScrollY = window.scrollY;
  }, { passive: true });
  window.addEventListener("hashchange", () => renderRoute(app));
  renderRoute(app);
  footer.checkHealth();
}

function renderRoute(app) {
  const route = parseRoute();
  const groupId = resolveGroup(route.query);
  const returningToList = route.name === "conversations" && app.listHash === window.location.hash;
  app.cleanup?.();
  app.cleanup = null;
  app.header.update({ routeName: route.name, groupId });
  if (route.name === "conversations") app.listHash = window.location.hash || buildHash(paths.conversations, { g: groupId });

  const ctx = {
    route,
    groupId,
    listHash: app.listHash ?? buildHash(paths.conversations, { g: groupId }),
    setTitle: (title) => { document.title = `${title} — CQA`; },
    onListHash: (hash) => { app.listHash = hash; },
    restoreScroll: () => window.scrollTo(0, returningToList ? app.listScrollY : 0),
  };
  if (app.rendered && !returningToList) window.scrollTo(0, 0);
  const cleanup = VIEWS[route.name](app.main, ctx);
  app.cleanup = typeof cleanup === "function" ? cleanup : null;
  app.routeName = route.name;
  if (app.rendered && !route.query.has("m")) focusWithoutScroll(app.main.querySelector("h1"));
  app.rendered = true;
}

function resolveGroup(query) {
  const value = (query.get("g") ?? "").trim();
  return value || DEFAULT_GROUP;
}

/** Смена набора: на карточке диалога уходим к списку нового набора, на остальных экранах — остаёмся. */
function groupTarget(groupId) {
  const route = parseRoute();
  if (route.name === "checklist") return buildHash(paths.checklist, { g: groupId });
  if (route.name === "appeals") return buildHash(paths.appeals, { g: groupId, status: route.query.get("status") });
  if (route.name === "insights") return buildHash(paths.insights, { g: groupId });
  if (route.name === "conversations") {
    const params = Object.fromEntries(route.query.entries());
    return buildHash(paths.conversations, { ...params, g: groupId });
  }
  return buildHash(paths.conversations, { g: groupId });
}

/** Высота липкой шапки → токен --cqa-header-h (для липких заголовков таблицы, плеера и якорей). */
function syncHeaderHeight(root, headerEl) {
  if (typeof ResizeObserver !== "function") return;
  const observer = new ResizeObserver(() => {
    const height = Math.round(headerEl.getBoundingClientRect().height);
    if (height > 0) root.style.setProperty("--cqa-header-h", `${height}px`);
  });
  observer.observe(headerEl);
}

function createFooter() {
  const label = h("span", { text: "API: проверяем связь…" });
  const status = h("span", { className: "cqa-health", attrs: { role: "status" }, dataset: { state: "unknown" } },
    h("span", { className: "cqa-health__dot", attrs: { "aria-hidden": "true" } }), label);
  const el = h("footer", { className: "cqa-footer" },
    h("span", { text: "CQA · прототип оценки качества диалогов · Data Challenge’26" }), status);

  return {
    el,
    async checkHealth() {
      let ok = false;
      try {
        ok = await fetchHealth();
      } catch {
        ok = false; // причина видна в экранах, которые не смогли загрузиться; здесь — только индикатор
      }
      status.dataset.state = ok ? "ok" : "down";
      label.textContent = ok ? "API на связи" : "API недоступен — проверьте, что бэкенд запущен";
    },
  };
}

boot();
