// Каркас макета model-driven app: верхняя панель (переключатели стенда), карта сайта и панель команд.
// Узнаваемая компоновка без логотипов и товарных знаков. Неактивные пункты — декорация (aria-hidden),
// чтобы клавиатура проходила только по тому, что работает.

import { h } from "../../js/dom.js";
import { hostIcon } from "./hostIcons.js";

const PREVIEW_CHARS = 46;
const CHANNEL_GROUPS = Object.freeze({ chat: "Чаты", call: "Звонки" });

/** @param {string} group */
function sitemap(group) {
  const appLink = (route) => `../index.html#${route}?g=${encodeURIComponent(group)}`;
  return [
    { items: [{ icon: "home", label: "Главная" }, { icon: "recent", label: "Недавние" }, { icon: "pin", label: "Закреплённые" }] },
    { title: "Обслуживание", items: [
      { icon: "dashboard", label: "Панели мониторинга" }, { icon: "ticket", label: "Обращения", current: true },
      { icon: "queue", label: "Очереди" }, { icon: "book", label: "База знаний" }] },
    { title: "Клиенты", items: [{ icon: "person", label: "Контакты" }, { icon: "building", label: "Организации" }] },
    { title: "Качество (CQA)", items: [
      { icon: "quality", label: "Оценки диалогов", href: appLink("/conversations") },
      { icon: "flag", label: "Апелляции", href: appLink("/appeals") }] },
  ];
}

/**
 * @param {{
 *   group: string, languages: ReadonlyArray<{ lcid: number, label: string }>, lcid: number,
 *   commands: ReadonlyArray<{ label: string, icon: string, onClick?: () => void, primary?: boolean }>,
 *   onRecordChange: (id: string) => void, onLanguageChange: (lcid: number) => void,
 * }} options
 */
export function buildShell({ group, languages, lcid, commands, onRecordChange, onLanguageChange }) {
  const recordSelect = h("select", { className: "d365-select", attrs: { id: "d365-record", disabled: true } },
    h("option", { text: "Загружаем записи…" }));
  const langSelect = h("select", { className: "d365-select d365-select--narrow", attrs: { id: "d365-lang" } },
    languages.map((language) => h("option", { attrs: { value: language.lcid }, text: language.label })));
  langSelect.value = String(lcid);
  recordSelect.addEventListener("change", () => onRecordChange(recordSelect.value));
  langSelect.addEventListener("change", () => onLanguageChange(Number(langSelect.value)));

  const navToggle = h("button", {
    className: "d365-icon-btn d365-nav__toggle", attrs: { type: "button", "aria-label": "Свернуть карту сайта", "aria-expanded": "true", "aria-controls": "d365-nav" },
  }, hostIcon("menu"));
  const nav = h("nav", { className: "d365-nav", attrs: { id: "d365-nav", "aria-label": "Карта сайта" } },
    navToggle, sitemap(group).map(navGroup));
  navToggle.addEventListener("click", () => {
    const collapsed = nav.classList.toggle("d365-nav--collapsed");
    navToggle.setAttribute("aria-expanded", String(!collapsed));
    navToggle.setAttribute("aria-label", collapsed ? "Развернуть карту сайта" : "Свернуть карту сайта");
  });

  const formHost = h("div", { className: "d365-form" });
  const el = h("div", { className: "d365-app" },
    h("header", { className: "d365-top" },
      h("span", { className: "d365-top__waffle", attrs: { "aria-hidden": "true" } }, hostIcon("waffle", { size: 18 })),
      h("span", { className: "d365-top__app", text: "Обслуживание клиентов" }),
      h("span", { className: "d365-top__stand", text: "Стенд: макет формы Dynamics 365" }),
      h("div", { className: "d365-top__tools" },
        h("label", { className: "d365-top__field", attrs: { for: "d365-record" } }, h("span", { text: "Запись" }), recordSelect),
        h("label", { className: "d365-top__field", attrs: { for: "d365-lang" } }, h("span", { text: "Язык пользователя" }), langSelect),
        h("span", { className: "d365-top__avatar", attrs: { title: "Контролёр качества (макет)", "aria-hidden": "true" }, text: "КК" }))),
    h("div", { className: "d365-frame" },
      nav,
      h("main", { className: "d365-main", attrs: { id: "d365-main" } },
        h("div", { className: "d365-cmdbar", attrs: { role: "toolbar", "aria-label": "Команды записи" } }, commands.map(commandButton)),
        formHost)));

  return {
    el,
    formHost,
    /** @param {ReadonlyArray<object>} records @param {string} selectedId */
    setRecords(records, selectedId) {
      recordSelect.replaceChildren(...groupRecords(records));
      recordSelect.value = selectedId;
      recordSelect.disabled = false;
    },
    setRecordsError(message) {
      recordSelect.replaceChildren(h("option", { text: message }));
      recordSelect.disabled = true;
    },
    selectRecord(id) {
      recordSelect.value = id;
    },
  };
}

function navGroup({ title, items }) {
  return h("div", { className: "d365-nav__group" },
    title ? h("p", { className: "d365-nav__title", text: title }) : null,
    h("ul", {}, items.map(navItem)));
}

function navItem({ icon, label, current = false, href = "" }) {
  const content = [hostIcon(icon, { className: "d365-nav__icon" }), h("span", { className: "d365-nav__label", text: label })];
  if (href) {
    return h("li", {}, h("a", {
      className: "d365-nav__item d365-nav__item--link",
      attrs: { href, target: "_blank", rel: "noopener noreferrer", title: `${label} — основное приложение CQA (новая вкладка)` },
    }, content));
  }
  return h("li", {}, h("span", {
    className: `d365-nav__item${current ? " d365-nav__item--current" : ""}`,
    attrs: { "aria-current": current ? "page" : null, title: label },
  }, content));
}

function commandButton({ label, icon, onClick, primary = false }) {
  const content = [hostIcon(icon, { size: 18 }), h("span", { text: label })];
  if (!onClick) return h("span", { className: "d365-cmd d365-cmd--inert", attrs: { "aria-hidden": "true" } }, content);
  return h("button", {
    className: `d365-cmd${primary ? " d365-cmd--primary" : ""}`, attrs: { type: "button" }, on: { click: onClick },
  }, content);
}

function groupRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${CHANNEL_GROUPS[record.channel] ?? record.channel} · ${record.language || "—"}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()].map(([label, items]) => h("optgroup", { attrs: { label } },
    items.map((record) => h("option", { attrs: { value: record.conversationId }, text: optionLabel(record) }))));
}

function optionLabel(record) {
  const preview = record.title.length > PREVIEW_CHARS ? `${record.title.slice(0, PREVIEW_CHARS).trimEnd()}…` : record.title;
  return `${record.conversationId} — ${preview}`;
}
