// Стенд «Dynamics 365»: макет model-driven app «Обслуживание клиентов» с решением CQA.
// Страница играет роль платформы: держит заглушку window.Xrm (веб-ресурсы читают её через parent.Xrm),
// карту сайта, панель команд, историю переходов и область содержимого. В области содержимого открываются:
//   • экраны приложения CQA — веб-ресурс cqa_/quality/index.html (оценки, апелляции, чек-лист, аналитика,
//     полная карточка диалога), карта сайта «Качество (CQA)» и Xrm.Navigation.navigateTo (target: 1);
//   • форма записи «Обращение» с вкладкой «Качество» (веб-ресурс cqa_/quality/embed.html) — Xrm.Navigation.openForm;
//   • представление «Активные обращения».
// Переключатели «Запись» и «Язык пользователя» в верхней панели — инструменты стенда для демо.
// Данные — только реальный API: записи — диалоги набора DEV, реплики — выбранного диалога.

import { countOpenAppeals, exportUrl, fetchConversation, fetchListing, isAbortError } from "../../js/api.js";
import { h } from "../../js/dom.js";
import { createAppPage } from "./appPage.js";
import { createCaseGrid } from "./caseGrid.js";
import { TABS, createForm } from "./form.js";
import {
  APP_RESOURCE, QUALITY_VIEWS, appPage, cardIdOf, createHistory, groupOf, pageFromParams, pageUrl,
  qualityViewOf, recordPage, routeFromData, sitemapIdOf, sitemapPage,
} from "./navigation.js";
import { operatorName, recordFromListItem } from "./record.js";
import { buildShell } from "./shell.js";
import { createSidePanel } from "./sidePanel.js";
import { installXrmStub } from "./xrmStub.js";

const GROUP = "DEV";
const LANGUAGES = Object.freeze([
  { lcid: 1049, label: "Русский · 1049" },
  { lcid: 1087, label: "Қазақша · 1087" },
  { lcid: 1033, label: "English · 1033" },
]);
const USER = Object.freeze({ name: "Контролёр качества", id: "0D7C2F4B-6A1E-4B8F-9C3D-2E5A7B9C1D3F" });
const DEFAULT_TAB = "quality";
const START_VIEW = QUALITY_VIEWS[0].id;
const STAND_TITLE = "стенд Dynamics 365";
const IDLE = Object.freeze({ status: "idle", data: null, error: null });
const LOADING = Object.freeze({ status: "loading", data: null, error: null });
const MESSAGE_SOURCE = "cqa";

let state = Object.freeze({
  lcid: LANGUAGES[0].lcid, page: null,
  records: Object.freeze([]), recordsStatus: "loading", recordsError: "",
  conversation: IDLE, operator: "", reloadToken: 0,
});
let shell = null;
let sidePanel = null;
let pages = null;
let view = null;
let recordsReady = null;
let conversationRequest = null;
let appealRequest = 0;

function boot() {
  const root = document.getElementById("d365-root");
  if (!root) return;
  const params = new URLSearchParams(window.location.search);
  const lcid = Number(params.get("lang"));
  patch({ lcid: LANGUAGES.some((language) => language.lcid === lcid) ? lcid : LANGUAGES[0].lcid });

  installXrmStub(window, {
    getRecord: () => (state.page?.type === "record" ? currentRecord() : null),
    getUser: () => ({ ...USER, lcid: state.lcid }),
    findRecords: () => recordsReady.then(() => state.records),
    openDialog: (options) => sidePanel.open(options),
    openPage: openWebResourcePage,
    openRecord: openRecordForm,
    onRefresh: () => Promise.all([refreshRecords(), refreshAppealCount()]).then(() => undefined),
  });
  shell = buildShell({
    languages: LANGUAGES, lcid: state.lcid,
    hrefFor: (id) => pageUrl(sitemapPage(id, GROUP), state.lcid),
    onSitemap: openSitemapItem,
    onRecordChange: (id) => go(recordPage(id, state.page?.type === "record" ? state.page.tab : DEFAULT_TAB)),
    onLanguageChange: changeLanguage,
  });
  root.replaceChildren(shell.el);
  sidePanel = createSidePanel(root);
  pages = createHistory({
    initial: pageFromParams(params, { fallback: sitemapPage(START_VIEW, GROUP), tabs: TABS.map((tab) => tab.id), defaultTab: DEFAULT_TAB }),
    lcid: () => state.lcid,
    onShow: showPage,
  });
  window.addEventListener("message", onAppMessage);
  recordsReady = loadRecords();
  recordsReady.catch(() => {}); // ошибка уже показана; Web API получит её в своём промисе
  pages.start();
}

/* ---------- страницы ---------- */

function showPage(page, { initial }) {
  conversationRequest?.abort();
  sidePanel.close();
  shell.clearNotice();
  view = null; // прежняя страница уничтожается вместе со своими веб-ресурсами
  patch({ page, conversation: IDLE, operator: "" });
  shell.setCurrent(sitemapIdOf(page));
  shell.selectRecord(page.type === "record" ? page.record : "");
  if (page.type === "app") view = appView(page);
  else if (page.type === "record") view = recordView(page);
  else view = casesView();
  shell.setCommands(commandsFor(page));
  document.title = `${view.title} — ${STAND_TITLE}`;
  if (!initial) view.focus();
  if (page.type !== "app" && state.recordsStatus === "ready") refreshRecords(); // итог мог измениться (апелляция)
  refreshAppealCount();
}

/** Экран приложения CQA — веб-ресурс в области содержимого. */
function appView(page) {
  const quality = qualityViewOf(page.route);
  const cardId = cardIdOf(page.route);
  const group = groupOf(page.route, GROUP);
  const title = quality?.title ?? (cardId ? `Диалог ${cardId}` : "Качество (CQA)");
  const subtitle = cardId ? `Полная карточка оценки · набор ${group}` : `Набор ${group} · веб-ресурс ${APP_RESOURCE}`;
  const result = { title };
  const appPageView = createAppPage({
    route: page.route, title, subtitle,
    onRouteChange: (route) => { if (view === result) rememberRoute(route); },
  });
  shell.setContent(appPageView.el, { fill: true });
  return Object.assign(result, { focus: appPageView.focus, reload: appPageView.reload, currentRoute: appPageView.currentRoute });
}

/** Форма записи «Обращение»: создаётся, когда записи набора загружены и запись найдена. */
function recordView(page) {
  const host = h("div", { className: "d365-form" });
  shell.setContent(host, { fill: false });
  let form = null;
  const result = {
    title: page.record ? `Обращение ${page.record}` : "Новое обращение",
    focus: () => form?.focusTitle(),
    update: () => form?.update(formView()),
    recordsChanged: sync,
  };
  sync();
  return result;

  function sync() {
    if (page.record && state.recordsStatus !== "ready") {
      const failed = state.recordsStatus === "error";
      form = null;
      host.replaceChildren(h("p", {
        className: failed ? "d365-error d365-error--page" : "d365-loading", attrs: { role: failed ? "alert" : "status" },
        text: failed ? `Не удалось загрузить записи набора ${GROUP}: ${state.recordsError}` : `Загружаем записи набора ${GROUP}…`,
      }));
      return;
    }
    if (page.record && !currentRecord()) {
      form = null;
      host.replaceChildren(h("div", { className: "d365-error d365-error--page", attrs: { role: "alert" } },
        h("p", { text: `Запись «Обращение» с диалогом ${page.record} не найдена в наборе ${GROUP}.` }),
        h("button", { className: "d365-btn", attrs: { type: "button" }, text: "К активным обращениям", on: { click: () => go(sitemapPage("cases", GROUP)) } })));
      return;
    }
    if (!form) {
      form = createForm(host, {
        onTabChange: (tab) => updatePage(recordPage(state.page.record, tab)),
        onOpenPanel: openQualityPanel,
        onRetryConversation: () => loadConversation(page.record),
      });
      if (page.record) loadConversation(page.record);
    }
    form.update(formView());
  }
}

function casesView() {
  const grid = createCaseGrid({
    hrefFor: (id) => pageUrl(recordPage(id, DEFAULT_TAB), state.lcid),
    onOpen: (id) => go(recordPage(id, DEFAULT_TAB)),
  });
  shell.setContent(grid.el, { fill: false });
  const sync = () => grid.update({ status: state.recordsStatus, records: state.records, error: state.recordsError });
  sync();
  return { title: "Активные обращения", focus: grid.focus, update: sync, recordsChanged: sync };
}

/** Команды страницы — как панель команд model-driven app: «Назад» всегда первой. */
function commandsFor(page) {
  const canGoBack = pages.canGoBack();
  const back = {
    label: "Назад", icon: "back", onClick: goBack, disabled: !canGoBack,
    title: canGoBack ? "Вернуться к предыдущей странице" : "Это первая страница сеанса",
  };
  const create = { label: "Создать", icon: "plus", onClick: () => go(recordPage("", DEFAULT_TAB)) };
  if (page.type === "cases") {
    return [back, create, { label: "Обновить", icon: "refresh", onClick: () => refreshRecords() }];
  }
  if (page.type === "record") {
    return [
      back,
      { label: "Сохранить", icon: "save" },
      { label: "Сохранить и закрыть", icon: "saveClose", onClick: () => (canGoBack ? goBack() : go(sitemapPage("cases", GROUP))) },
      create,
      { label: "Обновить", icon: "refresh", onClick: refreshForm },
      { label: "Оценка качества", icon: "panel", onClick: openQualityPanel, primary: true },
      { label: "Решить обращение", icon: "check" },
      { label: "Назначить", icon: "assign" },
      { label: "Поделиться", icon: "share" },
    ];
  }
  const refresh = { label: "Обновить", icon: "refresh", onClick: () => { view.reload(); refreshAppealCount(); } };
  const cardId = cardIdOf(page.route);
  if (cardId) {
    return [back, { label: "Открыть обращение", icon: "ticket", onClick: () => go(recordPage(cardId, DEFAULT_TAB)) }, refresh];
  }
  if (qualityViewOf(page.route)?.id === "conversations") {
    const group = groupOf(page.route, GROUP);
    return [back, refresh, { label: "Экспорт в Excel", icon: "download", href: exportUrl(group, "csv"), download: true,
      title: `Последние оценки набора ${group} — CSV для Excel` }];
  }
  return [back, refresh];
}

/* ---------- переходы ---------- */

function go(page) {
  rememberAppRoute();
  pages.push(page);
}

/** Пункт карты сайта; уже открытый пункт открывается заново с видом по умолчанию — без лишней записи в истории. */
function openSitemapItem(id) {
  const page = sitemapPage(id, GROUP);
  const reopening = state.page?.type === page.type && sitemapIdOf(state.page) === id && state.page.type !== "record";
  if (reopening) pages.replace(page);
  else go(page);
}

function goBack() {
  rememberAppRoute();
  pages.back();
}

/** Текущая вкладка формы и т. п. — на месте, без новой записи в истории. */
function updatePage(page) {
  patch({ page });
  pages.update(page);
  view?.update?.();
}

/** Экран веб-ресурса с его фильтрами — в текущую запись истории: «Назад» и перезагрузка вернут его как был. */
function rememberAppRoute() {
  if (typeof view?.currentRoute === "function") rememberRoute(view.currentRoute());
}

function rememberRoute(route) {
  if (state.page?.type !== "app" || route === state.page.route) return;
  patch({ page: appPage(route) });
  pages.update(state.page);
}

/** Xrm.Navigation.navigateTo(webresource, target 1): экран приложения CQA в области содержимого. */
function openWebResourcePage({ webresourceName, data }) {
  if (webresourceName !== APP_RESOURCE) {
    return Promise.reject(new Error(`Макет открывает в области содержимого только веб-ресурс ${APP_RESOURCE}.`));
  }
  const route = routeFromData(data);
  return afterCurrentTask(() => go(route ? appPage(route) : sitemapPage(START_VIEW, GROUP)));
}

/** Xrm.Navigation.openForm: форма записи «Обращение» (вкладка — параметр формы cqa_tab). */
async function openRecordForm({ entityId, parameters }) {
  const tab = TABS.some((item) => item.id === parameters.cqa_tab) ? parameters.cqa_tab : DEFAULT_TAB;
  if (!entityId) {
    await afterCurrentTask(() => go(recordPage("", tab)));
    return Object.freeze({ savedEntityReference: Object.freeze([]) });
  }
  await recordsReady;
  const record = state.records.find((item) => item.guid.toLowerCase() === entityId.toLowerCase());
  if (!record) throw new Error(`Запись incident {${entityId}} не найдена.`);
  await afterCurrentTask(() => go(recordPage(record.conversationId, tab)));
  return Object.freeze({
    savedEntityReference: Object.freeze([{ entityType: "incident", id: `{${record.guid}}`, name: record.title }]),
  });
}

/** Переход после текущей задачи: вызов пришёл из iframe, который этот переход уничтожит. */
function afterCurrentTask(action) {
  return new Promise((resolve) => window.setTimeout(() => {
    action();
    resolve();
  }, 0));
}

/** Сообщения веб-ресурсов приложения (js/host.js): очередь апелляций изменилась. */
function onAppMessage(event) {
  if (event.origin !== window.location.origin || event.data?.source !== MESSAGE_SOURCE) return;
  if (event.data.type === "appeals-changed") refreshAppealCount();
}

/* ---------- записи и форма ---------- */

async function loadRecords() {
  try {
    const listing = await fetchListing(GROUP);
    setRecords(Object.freeze(listing.items.map((item) => recordFromListItem(item, GROUP))));
    return state.records;
  } catch (error) {
    patch({ recordsStatus: "error", recordsError: error.message });
    shell.setRecordsError("Записи не загрузились");
    view?.recordsChanged?.();
    throw error;
  }
}

/** Данные записей перечитаны (Xrm.Page.data.refresh, «Обновить», переход на форму): шапка покажет свежий итог. */
async function refreshRecords() {
  try {
    const listing = await fetchListing(GROUP);
    setRecords(Object.freeze(listing.items.map((item) => recordFromListItem(item, GROUP))));
  } catch (error) {
    shell.notify(`Не удалось перечитать данные записей: ${error.message}`, "warning");
  }
}

function setRecords(records) {
  patch({ records, recordsStatus: "ready", recordsError: "" });
  shell.setRecords(records, state.page?.type === "record" ? state.page.record : "");
  view?.recordsChanged?.();
}

async function refreshAppealCount() {
  const request = ++appealRequest;
  const count = await countOpenAppeals(GROUP);
  if (request === appealRequest) shell.setAppealCount(count);
}

async function loadConversation(recordId) {
  conversationRequest?.abort();
  const controller = new AbortController();
  conversationRequest = controller;
  patchForm({ conversation: LOADING, operator: "" });
  try {
    const data = await fetchConversation(GROUP, recordId, { signal: controller.signal });
    if (isOpenRecord(recordId)) patchForm({ conversation: Object.freeze({ status: "ok", data, error: null }), operator: operatorName(data) });
  } catch (error) {
    if (isAbortError(error) || !isOpenRecord(recordId)) return;
    patchForm({ conversation: Object.freeze({ status: "error", data: null, error }) });
  }
}

/** Команда «Оценка качества»: тот же код, что в решении Dynamics (js/embed/command.js). */
function openQualityPanel() {
  const command = window.CQA?.openQualityPanel;
  if (typeof command !== "function") {
    shell.notify("Команда «Оценка качества» не загружена: нет js/embed/command.js.", "error");
    return;
  }
  // Как успешный колбэк команды в Dynamics: после закрытия панели перечитать данные формы.
  command(window.Xrm.Page, GROUP).then(() => refreshRecords(), (error) => shell.notify(`navigateTo: ${error.message}`, "error"));
}

/** «Обновить» на форме: перечитать данные записи и пересоздать содержимое вкладки (как обновление формы). */
function refreshForm() {
  patchForm({ reloadToken: state.reloadToken + 1 });
  refreshRecords();
  if (state.page.record) loadConversation(state.page.record);
}

function changeLanguage(lcid) {
  sidePanel.close();
  patch({ lcid });
  pages.update(state.page);
  view?.update?.(); // форма: веб-ресурс вкладки «Качество» пересоздаётся с новым userlcid
}

function formView() {
  return {
    record: currentRecord(), tab: state.page.tab, lcid: state.lcid, conversation: state.conversation,
    operator: state.operator, reloadToken: state.reloadToken,
  };
}

function currentRecord() {
  const { page } = state;
  if (page?.type !== "record" || !page.record) return null;
  return state.records.find((record) => record.conversationId === page.record) ?? null;
}

function isOpenRecord(recordId) {
  return state.page?.type === "record" && state.page.record === recordId;
}

function patch(next) {
  state = Object.freeze({ ...state, ...next });
}

function patchForm(next) {
  patch(next);
  if (state.page?.type === "record") view?.update?.();
}

boot();
