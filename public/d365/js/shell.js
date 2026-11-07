// Каркас макета model-driven app: верхняя панель (переключатели стенда), карта сайта, панель команд,
// уведомления и область содержимого. Узнаваемая компоновка без логотипов и товарных знаков.
// Неактивные пункты — декорация (span без действия), клавиатура проходит только по тому, что работает.

import { h } from "../../js/dom.js";
import { hostIcon } from "./hostIcons.js";
import { CASES_VIEW, QUALITY_VIEWS } from "./navigation.js";

const PREVIEW_CHARS = 46;
const CHANNEL_GROUPS = Object.freeze({ chat: "Чаты", call: "Звонки" });
const NO_RECORD = "";

const SITEMAP = Object.freeze([
  { items: [{ icon: "home", label: "Главная" }, { icon: "recent", label: "Недавние" }, { icon: "pin", label: "Закреплённые" }] },
  { title: "Обслуживание", items: [
    { icon: "dashboard", label: "Панели мониторинга" }, { id: CASES_VIEW, icon: "ticket", label: "Обращения" },
    { icon: "queue", label: "Очереди" }, { icon: "book", label: "База знаний" }] },
  { title: "Клиенты", items: [{ icon: "person", label: "Контакты" }, { icon: "building", label: "Организации" }] },
  { title: "Качество (CQA)", items: QUALITY_VIEWS.map(({ id, icon, label }) => ({ id, icon, label, counter: id === "appeals" })) },
]);

/**
 * @typedef {{ label: string, icon: string, onClick?: () => void, href?: string, download?: boolean,
 *   primary?: boolean, disabled?: boolean, title?: string }} Command
 * @param {{
 *   languages: ReadonlyArray<{ lcid: number, label: string }>, lcid: number,
 *   hrefFor: (sitemapId: string) => string,
 *   onSitemap: (sitemapId: string) => void, onRecordChange: (id: string) => void, onLanguageChange: (lcid: number) => void,
 * }} options
 */
export function buildShell({ languages, lcid, hrefFor, onSitemap, onRecordChange, onLanguageChange }) {
  const recordSelect = h("select", { className: "d365-select", attrs: { id: "d365-record", disabled: true } },
    h("option", { text: "Загружаем записи…" }));
  const langSelect = h("select", { className: "d365-select d365-select--narrow", attrs: { id: "d365-lang" } },
    languages.map((language) => h("option", { attrs: { value: language.lcid }, text: language.label })));
  langSelect.value = String(lcid);
  recordSelect.addEventListener("change", () => { if (recordSelect.value) onRecordChange(recordSelect.value); });
  langSelect.addEventListener("change", () => onLanguageChange(Number(langSelect.value)));

  const appealCount = h("span", { className: "d365-nav__badge", attrs: { "aria-hidden": "true", hidden: true } });
  const appealCountSr = h("span", { className: "d365-sr-only" });
  const links = new Map();
  const navToggle = h("button", {
    className: "d365-icon-btn d365-nav__toggle", attrs: { type: "button", "aria-label": "Свернуть карту сайта", "aria-expanded": "true", "aria-controls": "d365-nav" },
  }, hostIcon("menu"));
  const nav = h("nav", { className: "d365-nav", attrs: { id: "d365-nav", "aria-label": "Карта сайта" } },
    navToggle, SITEMAP.map((group) => navGroup(group, { links, hrefFor, onSitemap, counter: [appealCount, appealCountSr] })));
  navToggle.addEventListener("click", () => {
    const collapsed = nav.classList.toggle("d365-nav--collapsed");
    navToggle.setAttribute("aria-expanded", String(!collapsed));
    navToggle.setAttribute("aria-label", collapsed ? "Развернуть карту сайта" : "Свернуть карту сайта");
  });

  const cmdbar = h("div", { className: "d365-cmdbar", attrs: { role: "toolbar", "aria-label": "Команды страницы" } });
  const notices = h("div", { className: "d365-notices" });
  const content = h("div", { className: "d365-content" });
  const main = h("main", { className: "d365-main", attrs: { id: "d365-main" } }, cmdbar, notices, content);
  const el = h("div", { className: "d365-app" },
    h("header", { className: "d365-top" },
      h("span", { className: "d365-top__waffle", attrs: { "aria-hidden": "true" } }, hostIcon("waffle", { size: 18 })),
      h("span", { className: "d365-top__app", text: "Обслуживание клиентов" }),
      h("span", { className: "d365-top__stand", text: "Стенд: макет Dynamics 365 с решением CQA" }),
      h("div", { className: "d365-top__tools" },
        h("label", { className: "d365-top__field", attrs: { for: "d365-record" } }, h("span", { text: "Запись" }), recordSelect),
        h("label", { className: "d365-top__field", attrs: { for: "d365-lang" } }, h("span", { text: "Язык пользователя" }), langSelect),
        h("span", { className: "d365-top__avatar", attrs: { title: "Контролёр качества (макет)", "aria-hidden": "true" }, text: "КК" }))),
    h("div", { className: "d365-frame" }, nav, main));

  let currentId = null;

  return {
    el,
    /**
     * Новая страница в области содержимого. fill — страница веб-ресурса на всю высоту (прокрутка внутри iframe).
     * @param {Node} node @param {{ fill: boolean }} options
     */
    setContent(node, { fill }) {
      main.classList.toggle("d365-main--fill", fill);
      content.replaceChildren(node);
    },
    /** @param {ReadonlyArray<Command>} commands */
    setCommands(commands) {
      cmdbar.replaceChildren(...commands.map(commandButton));
    },
    /** Подсветка пункта карты сайта; null — оставить прежний (страница вне карты сайта). */
    setCurrent(sitemapId) {
      if (sitemapId === null || sitemapId === currentId) return;
      currentId = sitemapId;
      for (const [id, link] of links) {
        const current = id === sitemapId;
        link.classList.toggle("d365-nav__item--current", current);
        if (current) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
    /** @param {number | null} count открытые апелляции; null — неизвестно (счётчик скрыт) */
    setAppealCount(count) {
      const shown = typeof count === "number" && count > 0;
      appealCount.hidden = !shown;
      appealCount.textContent = shown ? String(count) : "";
      appealCountSr.textContent = shown ? `, открытых: ${count}` : "";
      links.get("appeals")?.setAttribute("title", shown ? `Апелляции — открытых: ${count}` : "Апелляции");
    },
    /** Уведомление над страницей — как formContext.ui.setFormNotification / Xrm.App.addGlobalNotification. */
    notify(message, level = "error") {
      const close = h("button", { className: "d365-icon-btn d365-notice__close", attrs: { type: "button", "aria-label": "Скрыть уведомление" }, text: "×" });
      const bar = h("div", { className: `d365-notice d365-notice--${level}`, attrs: { role: level === "error" ? "alert" : "status" } },
        h("span", { text: message }), close);
      close.addEventListener("click", () => bar.remove());
      notices.replaceChildren(bar);
    },
    clearNotice() {
      notices.replaceChildren();
    },
    /** @param {ReadonlyArray<object>} records @param {string} selectedId "" — запись не открыта */
    setRecords(records, selectedId) {
      recordSelect.replaceChildren(h("option", { attrs: { value: NO_RECORD }, text: "— открыть обращение —" }), ...groupRecords(records));
      recordSelect.value = selectedId;
      recordSelect.disabled = false;
    },
    setRecordsError(message) {
      recordSelect.replaceChildren(h("option", { text: message }));
      recordSelect.disabled = true;
    },
    selectRecord(id) {
      if (!recordSelect.disabled) recordSelect.value = id || NO_RECORD;
    },
  };
}

function navGroup({ title, items }, options) {
  return h("div", { className: "d365-nav__group" },
    title ? h("p", { className: "d365-nav__title", text: title }) : null,
    h("ul", {}, items.map((item) => navItem(item, options))));
}

function navItem({ id = "", icon, label, counter = false }, { links, hrefFor, onSitemap, counter: badge }) {
  const content = [hostIcon(icon, { className: "d365-nav__icon" }), h("span", { className: "d365-nav__label", text: label })];
  if (!id) return h("li", {}, h("span", { className: "d365-nav__item", attrs: { title: label } }, content));
  const link = h("a", { className: "d365-nav__item d365-nav__item--link", attrs: { href: hrefFor(id), title: label } },
    content, counter ? badge : null);
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // новая вкладка — как обычная ссылка
    event.preventDefault();
    onSitemap(id);
  });
  links.set(id, link);
  return h("li", {}, link);
}

/** @param {Command} command */
function commandButton({ label, icon, onClick, href, download = false, primary = false, disabled = false, title = "" }) {
  const content = [hostIcon(icon, { size: 18 }), h("span", { text: label })];
  const className = `d365-cmd${primary ? " d365-cmd--primary" : ""}`;
  if (href) return h("a", { className, attrs: { href, download: download || null, title: title || null } }, content);
  if (!onClick) return h("span", { className: "d365-cmd d365-cmd--inert", attrs: { "aria-hidden": "true" } }, content);
  return h("button", {
    className, attrs: { type: "button", "aria-disabled": disabled ? "true" : null, title: title || null },
    on: { click: () => { if (!disabled) onClick(); } },
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
