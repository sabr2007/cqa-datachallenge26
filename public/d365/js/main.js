// Стенд «Dynamics 365»: макет формы обращения model-driven app со встраиваемой панелью оценки.
// Страница играет роль платформы: держит заглушку window.Xrm (её веб-ресурс читает через parent.Xrm),
// вкладки формы, панель команд с navigateTo и переключатели «запись» и «язык пользователя» для демо.
// Данные — только реальный API: список диалогов набора и реплики выбранного диалога.

import { fetchConversation, fetchListing, isAbortError } from "../../js/api.js";
import { h } from "../../js/dom.js";
import { TABS, createForm } from "./form.js";
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

let state = Object.freeze({
  status: "loading", error: null, records: Object.freeze([]), recordId: "", creating: false,
  tab: DEFAULT_TAB, lcid: LANGUAGES[0].lcid,
  conversation: Object.freeze({ status: "idle", data: null, error: null }), operator: "", reloadToken: 0,
});
let conversationRequest = null;
let shell = null;
let form = null;
let sidePanel = null;

function boot() {
  const root = document.getElementById("d365-root");
  if (!root) return;
  const params = new URLSearchParams(window.location.search);
  const lcid = Number(params.get("lang"));
  setState({
    tab: TABS.some((tab) => tab.id === params.get("tab")) ? params.get("tab") : DEFAULT_TAB,
    lcid: LANGUAGES.some((language) => language.lcid === lcid) ? lcid : LANGUAGES[0].lcid,
    recordId: params.get("record") ?? "",
  }, { render: false });

  installXrmStub(window, {
    getRecord: currentRecord,
    getUser: () => ({ ...USER, lcid: state.lcid }),
    openDialog: (options) => sidePanel.open(options),
    onRefresh: () => refreshListing(),
  });
  shell = buildShell({
    group: GROUP, languages: LANGUAGES, lcid: state.lcid, commands: commandList(),
    onRecordChange: selectRecord, onLanguageChange: (next) => { sidePanel.close(); setState({ lcid: next }); },
  });
  root.replaceChildren(shell.el);
  sidePanel = createSidePanel(root);
  form = createForm(shell.formHost, {
    onTabChange: (tab) => setState({ tab }),
    onOpenPanel: openQualityPanel,
    onRetryConversation: () => loadConversation(state.recordId),
  });
  shell.formHost.prepend(h("p", { className: "d365-loading", attrs: { role: "status" }, text: "Загружаем записи набора DEV…" }));
  loadListing();
}

async function loadListing() {
  try {
    const listing = await fetchListing(GROUP);
    const records = Object.freeze(listing.items.map((item) => recordFromListItem(item, GROUP)));
    const recordId = records.some((record) => record.conversationId === state.recordId) ? state.recordId : defaultRecordId(records);
    shell.formHost.querySelector(".d365-loading")?.remove();
    shell.setRecords(records, recordId);
    setState({ status: "ready", records, recordId });
    loadConversation(recordId);
  } catch (error) {
    shell.setRecordsError("Записи не загрузились");
    shell.formHost.replaceChildren(h("div", { className: "d365-error d365-error--page", attrs: { role: "alert" } },
      h("p", { text: `Не удалось загрузить записи набора ${GROUP}: ${error.message}` }),
      h("button", { className: "d365-btn", attrs: { type: "button" }, text: "Повторить", on: { click: () => window.location.reload() } })));
  }
}

/** Данные формы перечитаны (Xrm.Page.data.refresh или «Обновить»): шапка и сводка покажут свежую оценку. */
async function refreshListing() {
  try {
    const listing = await fetchListing(GROUP);
    const records = Object.freeze(listing.items.map((item) => recordFromListItem(item, GROUP)));
    shell.setRecords(records, state.creating ? records[0]?.conversationId ?? "" : state.recordId);
    setState({ records });
  } catch (error) {
    form.notify(`Не удалось перечитать данные записи: ${error.message}`, "warning");
  }
}

async function loadConversation(recordId) {
  conversationRequest?.abort();
  if (!recordId) return;
  const controller = new AbortController();
  conversationRequest = controller;
  setState({ conversation: Object.freeze({ status: "loading", data: null, error: null }), operator: "" });
  try {
    const data = await fetchConversation(GROUP, recordId, { signal: controller.signal });
    if (state.recordId === recordId) setState({ conversation: Object.freeze({ status: "ok", data, error: null }), operator: operatorName(data) });
  } catch (error) {
    if (isAbortError(error) || state.recordId !== recordId) return;
    setState({ conversation: Object.freeze({ status: "error", data: null, error }) });
  }
}

function selectRecord(recordId) {
  sidePanel.close();
  setState({ recordId, creating: false });
  loadConversation(recordId);
}

function commandList() {
  return [
    { label: "Назад", icon: "back" },
    { label: "Сохранить", icon: "save" },
    { label: "Сохранить и закрыть", icon: "saveClose" },
    { label: "Создать", icon: "plus", onClick: startCreate },
    { label: "Обновить", icon: "refresh", onClick: refreshForm },
    { label: "Оценка качества", icon: "panel", onClick: openQualityPanel, primary: true },
    { label: "Решить обращение", icon: "check" },
    { label: "Назначить", icon: "assign" },
    { label: "Поделиться", icon: "share" },
  ];
}

/** Команда «Оценка качества»: тот же код, что в решении Dynamics (js/embed/command.js). */
function openQualityPanel() {
  const command = window.CQA?.openQualityPanel;
  if (typeof command !== "function") {
    form.notify("Команда «Оценка качества» не загружена: нет js/embed/command.js.", "error");
    return;
  }
  // Как успешный колбэк команды в Dynamics: после закрытия панели перечитать данные формы.
  command(window.Xrm.Page, GROUP).then(() => refreshListing(), (error) => form.notify(`navigateTo: ${error.message}`, "error"));
}

/** «Создать»: форма в режиме создания — у записи ещё нет id, веб-ресурс покажет «сохраните запись». */
function startCreate() {
  sidePanel.close();
  conversationRequest?.abort();
  setState({ creating: true, conversation: Object.freeze({ status: "idle", data: null, error: null }), operator: "" });
}

/** «Обновить»: перечитать данные записи и пересоздать содержимое вкладки (как обновление формы). */
function refreshForm() {
  setState({ reloadToken: state.reloadToken + 1 });
  refreshListing();
  if (!state.creating) loadConversation(state.recordId);
}

function currentRecord() {
  if (state.creating) return null;
  return state.records.find((record) => record.conversationId === state.recordId) ?? null;
}

function defaultRecordId(records) {
  const critical = records.find((record) => record.evaluation?.critical);
  const evaluated = records.find((record) => record.evaluation);
  return (critical ?? evaluated ?? records[0])?.conversationId ?? "";
}

function setState(patch, { render = true } = {}) {
  state = Object.freeze({ ...state, ...patch });
  if (!render || state.status !== "ready") return;
  syncUrl();
  const record = currentRecord();
  document.title = record ? `Обращение ${record.conversationId} — стенд Dynamics 365` : "Новое обращение — стенд Dynamics 365";
  form.update({
    record, tab: state.tab, lcid: state.lcid, conversation: state.conversation,
    operator: state.operator, reloadToken: state.reloadToken,
  });
}

function syncUrl() {
  const params = new URLSearchParams();
  if (!state.creating && state.recordId) params.set("record", state.recordId);
  params.set("tab", state.tab);
  params.set("lang", String(state.lcid));
  const next = `${window.location.pathname}?${params}`;
  if (`${window.location.pathname}${window.location.search}` !== next) history.replaceState(history.state, "", next);
}

boot();
