// Экран «Чек-лист»: просмотр версий, редактор, история изменений «vA → vB» и переоценка набора.
// Состояние вкладки, версии и сравнения — в URL (#/checklist?g=DEV&tab=history&v=3&cmp=2-3) через replaceHash.

import { isAbortError } from "../api.js";
import { h } from "../dom.js";
import { FORMS, countLabel, formatDecimal, formatInt, plural } from "../format.js";
import { buildHash, paths, replaceHash } from "../router.js";
import { button, loadingNote, stateBlock, summaryCard, summarySkeleton } from "../components/ui.js";
import { getChecklist, listChecklists, saveChecklistVersion } from "./api.js";
import { createApplyPanel } from "./applyPanel.js";
import { diffChecklists } from "./diff.js";
import { clearStoredDraft, createEditSession, readStoredDraft } from "./editSession.js";
import { comparePicker, diffView, versionTimeline } from "./history.js";
import { formatDateTime, versionLabel } from "./labels.js";
import { toDraft, toNumber, toPayload } from "./model.js";
import { actionButton, badge, nextId, setChildren } from "./ui.js";
import { checklistView } from "./viewer.js";

const TABS = Object.freeze([
  { id: "criteria", label: "Критерии" },
  { id: "history", label: "История версий" },
  { id: "apply", label: "Переоценка набора" },
]);
const DEFAULT_CHECKLIST = "chat-quality";

/** @param {HTMLElement} main @param {{ route: { query: URLSearchParams }, groupId: string, setTitle: (t: string) => void }} ctx */
export function renderChecklistPage(main, ctx) {
  const controller = new AbortController();
  const { signal } = controller;
  const { groupId, route } = ctx;
  const state = {
    tab: TABS.some((t) => t.id === route.query.get("tab")) ? route.query.get("tab") : "criteria",
    checklists: [],
    info: null,
    version: positiveInt(route.query.get("v")),
    compare: parseCompare(route.query.get("cmp")),
    docs: new Map(),
    session: null,
    banner: null,
    applyPanel: null,
  };
  ctx.setTitle("Чек-лист");

  const hero = buildHero();
  const tabsEl = h("div", { className: "cqa-a-tabs", attrs: { role: "tablist", "aria-label": "Разделы чек-листа" } });
  const panel = h("div", { className: "cqa-a-panel", attrs: { id: "cqa-a-panel", role: "tabpanel", tabindex: "-1" } });
  const sheet = h("div", { className: "cqa-sheet cqa-a-sheet" }, h("div", { className: "cqa-container" }, tabsEl, panel));
  main.replaceChildren(hero.el, sheet);
  let note = null;
  load();

  /* ---------- загрузка ---------- */

  async function load() {
    note?.stop();
    note = loadingNote("Загружаем чек-лист…");
    setChildren(panel, note.el);
    hero.loading();
    try {
      state.checklists = await listChecklists({ signal });
      const wanted = route.query.get("cl");
      state.info = state.checklists.find((c) => c.id === wanted) ?? state.checklists.find((c) => c.id === DEFAULT_CHECKLIST) ?? state.checklists[0] ?? null;
      if (!state.info) throw Object.assign(new Error("На бэкенде нет ни одного чек-листа."), { code: "no_checklists" });
      if (!state.info.versions.some((v) => v.version === state.version)) state.version = state.info.latestVersion ?? state.info.versions[0]?.version ?? null;
      await ensureDoc(state.version);
      render();
    } catch (error) {
      if (isAbortError(error)) return;
      hero.error();
      setChildren(panel, stateBlock({
        kind: "error", title: "Не удалось загрузить чек-лист", text: error.message, code: error.code,
        actions: [button({ label: "Повторить", iconName: "refresh", onClick: load })],
      }));
    } finally {
      note?.stop();
    }
  }

  async function ensureDoc(version) {
    if (!Number.isInteger(version)) throw new Error("У чек-листа нет версий.");
    if (!state.docs.has(version)) state.docs.set(version, await getChecklist(state.info.id, { version, signal }));
    return state.docs.get(version);
  }

  async function refreshInfo() {
    state.checklists = await listChecklists({ signal });
    state.info = state.checklists.find((c) => c.id === state.info.id) ?? state.info;
  }

  /* ---------- отрисовка ---------- */

  function render() {
    syncUrl();
    renderTabs();
    hero.show(state.docs.get(state.version), state);
    if (state.tab === "history") renderHistory();
    else if (state.tab === "apply") renderApply();
    else renderCriteria();
  }

  function renderTabs() {
    panel.setAttribute("aria-labelledby", `cqa-a-tab-${state.tab}`);
    tabsEl.replaceChildren(...TABS.map((tab) => {
      const selected = tab.id === state.tab;
      return h("button", {
        className: "cqa-a-tab",
        attrs: { id: `cqa-a-tab-${tab.id}`, type: "button", role: "tab", "aria-selected": String(selected), "aria-controls": "cqa-a-panel", tabindex: selected ? "0" : "-1", "data-tab": tab.id },
        on: { click: () => selectTab(tab.id), keydown: onTabKey },
      }, tab.label, tab.id === "criteria" && state.session ? h("span", { className: "cqa-a-tab__dot", attrs: { title: "Есть черновик" } }) : null);
    }));
  }

  function onTabKey(event) {
    const index = TABS.findIndex((t) => t.id === state.tab);
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = TABS[(index + delta + TABS.length) % TABS.length].id;
    selectTab(next);
    tabsEl.querySelector(`[data-tab="${next}"]`)?.focus();
  }

  function selectTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    render();
  }

  /* ---------- вкладка «Критерии» ---------- */

  function renderCriteria() {
    if (state.session) {
      setChildren(panel, state.session.el);
      return;
    }
    const doc = state.docs.get(state.version);
    const versionInfo = state.info.versions.find((v) => v.version === state.version);
    const stored = readStoredDraft(state.info.id);
    const previous = previousVersion(state.version);
    const highlight = previous !== null && state.docs.has(previous) ? marksBetween(state.docs.get(previous), doc) : new Map();
    if (previous !== null && !state.docs.has(previous)) ensureDoc(previous).then(() => { if (state.tab === "criteria" && !state.session) renderCriteria(); }).catch(() => {});
    setChildren(panel,
      state.banner ? savedBanner(state.banner) : null,
      stored ? restorePrompt(stored) : null,
      h("div", { className: "cqa-a-viewbar" },
        versionPicker(),
        h("p", { className: "cqa-a-viewbar__meta" },
          state.version === state.info.latestVersion ? badge("действующая", "new") : badge("не действующая", "muted"),
          versionInfo?.sandbox ? badge("песочница", "sandbox") : null,
          h("span", { text: [formatDateTime(versionInfo?.createdAt ?? ""), versionInfo?.note ?? ""].filter(Boolean).join(" · ") })),
        actionButton({ label: "Изменить чек-лист", iconName: "edit", attrs: { "data-key": "start-edit" }, onClick: () => startEdit() })),
      highlight.size ? h("p", { className: "cqa-a-hint", text: `Отмечены критерии, добавленные или изменённые в ${versionLabel(state.version)} относительно ${versionLabel(previous)}.` }) : null,
      checklistView(doc, { highlight }));
  }

  function versionPicker() {
    const id = nextId("cqa-a-version");
    const select = h("select", { className: "cqa-a-input cqa-a-select cqa-a-viewbar__select", attrs: { id } },
      state.info.versions.map((v) => h("option", { attrs: { value: v.version, selected: v.version === state.version }, text: `${versionLabel(v.version)}${v.version === state.info.latestVersion ? " · действующая" : ""}${v.sandbox ? " · песочница" : ""}` })));
    select.addEventListener("change", () => openVersion(Number(select.value), "criteria"));
    return h("div", { className: "cqa-a-viewbar__picker" }, h("label", { className: "cqa-a-field__label", attrs: { for: id }, text: "Версия" }), select);
  }

  async function openVersion(version, tab = state.tab) {
    try {
      await ensureDoc(version);
      state.version = version;
      state.tab = tab;
      state.banner = null;
      render();
    } catch (error) {
      if (!isAbortError(error)) panel.prepend(alert(`Не удалось открыть ${versionLabel(version)}: ${error.message}`));
    }
  }

  function savedBanner(banner) {
    return h("div", { className: "cqa-a-saved", attrs: { role: "status" } },
      h("div", { className: "cqa-a-saved__text" },
        h("p", { className: "cqa-a-saved__title", text: `Сохранена ${versionLabel(banner.version)} — она теперь действующая` }),
        h("p", { className: "cqa-a-saved__note", text: banner.note })),
      h("div", { className: "cqa-a-saved__actions" },
        actionButton({ label: `Переоценить набор ${groupId} по ${versionLabel(banner.version)}`, iconName: "play", attrs: { "data-key": "banner-apply" }, onClick: () => goApply(banner.version) }),
        actionButton({ label: `Что изменилось: ${versionLabel(banner.from)} → ${versionLabel(banner.version)}`, variant: "white", iconName: "compare", onClick: () => {
          state.compare = { from: banner.from, to: banner.version };
          selectTab("history");
        } })));
  }

  function restorePrompt(stored) {
    return h("div", { className: "cqa-a-alert cqa-a-restore", attrs: { role: "status" } },
      h("p", { text: `Есть несохранённый черновик на основе ${versionLabel(stored.baseVersion)}${stored.savedAt ? ` (${formatDateTime(stored.savedAt)})` : ""}.` }),
      h("div", { className: "cqa-a-restore__actions" },
        actionButton({ label: "Продолжить правку", variant: "dark sm", iconName: "edit", onClick: () => startEdit(stored) }),
        actionButton({ label: "Отбросить", variant: "gray sm", onClick: () => { clearStoredDraft(state.info.id); renderCriteria(); } })));
  }

  async function startEdit(stored = null) {
    const baseVersion = stored && state.info.versions.some((v) => v.version === stored.baseVersion) ? stored.baseVersion : state.version;
    let baseDoc;
    let reservedIds = [];
    try {
      baseDoc = await ensureDoc(baseVersion);
      const docs = await Promise.all(state.info.versions.map((v) => ensureDoc(v.version).catch(() => null)));
      reservedIds = [...new Set(docs.filter(Boolean).flatMap((d) => (Array.isArray(d.criteria) ? d.criteria.map((c) => c.id) : [])))];
    } catch (error) {
      if (!isAbortError(error)) panel.prepend(alert(`Не удалось начать правку: ${error.message}`));
      return;
    }
    state.banner = null;
    state.tab = "criteria";
    state.version = baseVersion;
    state.session = createEditSession({
      checklistId: state.info.id,
      baseDoc,
      draft: toDraft(stored?.doc ?? baseDoc),
      reservedIds,
      nextVersion: () => Math.max(0, ...state.info.versions.map((v) => v.version)) + 1,
      latest: state.info.latestVersion,
      groupId,
      dialogHost: main.closest("#cqa-root") ?? main,
      signal,
      onSave: save,
      onExit: exitEdit,
      onDraftChange: (doc) => hero.show(doc, state, true),
      onVersionsChanged: () => refreshInfo().then(() => { renderTabs(); state.session?.refresh(); }).catch(() => {}),
    });
    render();
    hero.show(state.session.getDoc(), state, true);
    state.session.focusFirst();
  }

  async function save(doc, noteText) {
    const baseDoc = state.docs.get(state.version) ?? null;
    const from = Number.isInteger(baseDoc?.version) ? baseDoc.version : state.version;
    const result = await saveChecklistVersion(state.info.id, toPayload(doc, { note: noteText }), { signal });
    await refreshInfo();
    const version = result.version ?? state.info.latestVersion;
    if (result.doc && Number.isInteger(version)) state.docs.set(version, result.doc);
    await ensureDoc(version);
    state.session?.destroy({ discard: true });
    state.session = null;
    state.version = version;
    state.banner = { version, from, note: noteText };
    state.applyPanel?.detach();
    state.applyPanel = null; // список версий изменился — панель соберётся заново
    render();
    panel.querySelector('[data-key="banner-apply"]')?.focus();
  }

  function exitEdit() {
    state.session?.destroy({ discard: true });
    state.session = null;
    render();
    panel.querySelector('[data-key="start-edit"]')?.focus();
  }

  function goApply(version) {
    state.tab = "apply";
    render();
    state.applyPanel?.setVersion(version);
    state.applyPanel?.focusStart();
  }

  /* ---------- вкладка «История версий» ---------- */

  async function renderHistory() {
    const versions = state.info.versions;
    const latest = state.info.latestVersion;
    const defaultTo = state.version ?? latest;
    const compare = state.compare && versions.some((v) => v.version === state.compare.from) && versions.some((v) => v.version === state.compare.to)
      ? state.compare
      : { from: previousVersion(defaultTo) ?? defaultTo, to: defaultTo };
    state.compare = compare;
    syncUrl();
    const diffHost = h("div", { className: "cqa-a-history__diff" }, loadingNote("Сравниваем версии…").el);
    setChildren(panel, h("div", { className: "cqa-a-history" },
      h("div", { className: "cqa-a-history__timeline" },
        h("h2", { className: "cqa-a-subtitle", text: "Версии" }),
        h("p", { className: "cqa-a-hint", text: "Версии неизменяемы: правка создаёт новую. Оценки остаются привязаны к версии, по которой сделаны." }),
        versionTimeline({
          versions, latest, active: state.version,
          onOpen: (v) => openVersion(v, "criteria"),
          onCompare: (from, to) => { state.compare = { from, to }; renderHistory(); },
        })),
      h("div", { className: "cqa-a-history__main" },
        h("h2", { className: "cqa-a-subtitle", text: "Что изменилось" }),
        versions.length > 1
          ? comparePicker({ versions, from: compare.from, to: compare.to, onChange: (from, to) => { state.compare = { from, to }; renderHistory(); } })
          : null,
        diffHost)));
    if (versions.length < 2) {
      diffHost.replaceChildren(h("p", { className: "cqa-a-empty-line", text: "Пока одна версия — сравнивать не с чем. Измените чек-лист, и здесь появится разница." }));
      return;
    }
    try {
      const [before, after] = await Promise.all([ensureDoc(compare.from), ensureDoc(compare.to)]);
      if (state.tab !== "history" || state.compare !== compare) return;
      diffHost.replaceChildren(diffView(diffChecklists(before, after), { from: versionLabel(compare.from), to: versionLabel(compare.to) }));
    } catch (error) {
      if (!isAbortError(error)) diffHost.replaceChildren(alert(`Не удалось загрузить версии: ${error.message}`));
    }
  }

  /* ---------- вкладка «Переоценка набора» ---------- */

  function renderApply() {
    if (!state.applyPanel) {
      state.applyPanel = createApplyPanel({
        groupId,
        checklistId: state.info.id,
        versions: state.info.versions,
        latest: state.info.latestVersion,
        initialVersion: state.info.latestVersion,
        signal,
      });
    }
    setChildren(panel, state.applyPanel.el);
  }

  /* ---------- вспомогательное ---------- */

  function previousVersion(version) {
    const older = state.info.versions.filter((v) => v.version < version && !v.sandbox);
    return older.length ? older[0].version : null;
  }

  function syncUrl() {
    const cmp = state.tab === "history" && state.compare ? `${state.compare.from}-${state.compare.to}` : null;
    replaceHash(buildHash(paths.checklist, {
      g: groupId,
      tab: state.tab === "criteria" ? null : state.tab,
      v: state.version !== state.info?.latestVersion ? state.version : null,
      cmp,
    }));
  }

  return () => {
    state.session?.destroy();
    state.applyPanel?.detach(); // прогон переоценки продолжается — его подхватит панель при возврате
    controller.abort();
    note?.stop();
  };
}

/* ---------- герой ---------- */

function buildHero() {
  const eyebrowText = h("span", { text: "Конфигурация оценки" });
  const title = h("h1", { className: "cqa-display", attrs: { id: "cqa-page-title", tabindex: "-1" }, text: "Чек-лист" });
  const text = h("p", { className: "cqa-body-l", text: "Критерии, веса и условия «Да», «Нет» и N/A. Правка сохраняется новой версией; после сохранения набор можно переоценить в один клик." });
  const aside = h("div", { className: "cqa-hero__aside" }, summarySkeleton());
  const el = h("section", { className: "cqa-hero", attrs: { "aria-labelledby": "cqa-page-title" } },
    h("div", { className: "cqa-container cqa-hero__grid" },
      h("div", { className: "cqa-hero__copy" },
        h("p", { className: "cqa-eyebrow" }, h("span", { className: "cqa-eyebrow__dot", attrs: { "aria-hidden": "true" } }), eyebrowText),
        title,
        h("p", { className: "cqa-lead cqa-grad-text", text: "Критерии, по которым оценивается работа оператора" }),
        text),
      aside));

  return {
    el,
    loading() {
      aside.replaceChildren(summarySkeleton());
    },
    error() {
      aside.replaceChildren();
    },
    show(rawDoc, state, editing = false) {
      if (!rawDoc) return;
      const doc = toDraft(rawDoc);
      title.textContent = doc.title || "Чек-лист";
      eyebrowText.textContent = editing ? `Редактирование · черновик на основе ${versionLabel(state.version)}` : "Конфигурация оценки";
      const version = editing ? "черновик" : `версия ${state.version}`;
      const sections = doc.sections.map((section) => ({
        label: section.title || "Без названия",
        value: section.criteria
          .map((id) => doc.criteria.find((c) => c.id === id))
          .filter((c) => c && c.scored && !c.critical)
          .reduce((sum, c) => sum + (Number.isFinite(toNumber(c.weight)) ? toNumber(c.weight) : 0), 0),
      })).filter((segment) => segment.value > 0);
      aside.replaceChildren(summaryCard({
        kicker: `${countLabel(doc.sections.length, FORMS.section)} · ${version}`,
        value: formatInt(doc.criteria.length),
        unit: plural(doc.criteria.length, FORMS.criterion),
        groups: [{ title: `Вес по секциям, сумма ${formatDecimal(sections.reduce((s, x) => s + x.value, 0))}`, segments: sections }],
      }));
    },
  };
}

function marksBetween(previousDoc, doc) {
  const diff = diffChecklists(previousDoc, doc);
  return new Map([...diff.added.map((c) => [c.id, "new"]), ...diff.changed.map((c) => [c.id, "changed"])]);
}

function alert(message) {
  return h("p", { className: "cqa-a-alert cqa-a-alert--error", attrs: { role: "alert" }, text: message });
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseCompare(value) {
  const match = /^(\d+)-(\d+)$/.exec(value ?? "");
  return match ? { from: Number(match[1]), to: Number(match[2]) } : null;
}
