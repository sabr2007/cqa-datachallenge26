// Шапка: знак продукта, разделы, выбор набора данных (group_id) и переключатель темы.

import { countOpenAppeals, isValidId } from "../api.js";
import { h } from "../dom.js";
import { brandMark, icon } from "../icons.js";
import { DEFAULT_GROUP, buildHash, paths } from "../router.js";

const INPUT_ID = "cqa-group-input";
const ERROR_ID = "cqa-group-error";
const OPTIONS_ID = "cqa-group-options";
const APPEALS_EVENT = "cqa:appeals-changed";

/** Сообщить шапке, что очередь апелляций набора изменилась (подана / решена). */
export function notifyAppealsChanged(groupId) {
  window.dispatchEvent(new CustomEvent(APPEALS_EVENT, { detail: { groupId } }));
}

/**
 * @param {{ onGroupSubmit: (groupId: string) => void, onThemeToggle: () => void }} handlers
 */
export function createHeader({ onGroupSubmit, onThemeToggle }) {
  const brand = h("a", {
    className: "cqa-brand",
    attrs: { href: "#/conversations", "aria-label": "CQA — Conversation Quality Analytics, к списку диалогов" },
  },
  brandMark("cqa-brand__mark"),
  h("span", { className: "cqa-brand__text", attrs: { "aria-hidden": "true" } },
    h("span", { className: "cqa-brand__name", text: "CQA" }),
    h("span", { className: "cqa-brand__caption", text: "Conversation Quality Analytics" })));

  const appealCount = h("span", { className: "cqa-nav__count cqa-num", attrs: { hidden: true } });
  const appealCountSr = h("span", { className: "cqa-sr-only" });
  const links = {
    conversations: navLink("Диалоги"),
    checklist: navLink("Чек-лист"),
    appeals: navLink("Апелляции", appealCount, appealCountSr),
    insights: navLink("Аналитика"),
  };
  appealCount.setAttribute("aria-hidden", "true");
  const nav = h("nav", { className: "cqa-nav", attrs: { "aria-label": "Разделы" } },
    h("ul", {}, Object.values(links).map((link) => h("li", {}, link))));

  const dataset = datasetForm(onGroupSubmit);
  const theme = themeSwitch(onThemeToggle);
  const el = h("header", { className: "cqa-header" },
    h("div", { className: "cqa-header__bar" }, brand, nav, h("div", { className: "cqa-header__tools" }, dataset.el, theme.el)));

  let currentGroup = "";
  let countRequest = 0;

  async function refreshAppealCount(groupId) {
    const request = ++countRequest;
    const count = await countOpenAppeals(groupId);
    if (request !== countRequest) return; // успел смениться набор
    appealCount.hidden = !count;
    appealCount.textContent = count ? String(count) : "";
    appealCountSr.textContent = count ? `, открытых: ${count}` : "";
    links.appeals.title = count ? `Открытых апелляций: ${count}` : "Очередь апелляций";
  }

  window.addEventListener(APPEALS_EVENT, (event) => {
    if (event.detail?.groupId === currentGroup) refreshAppealCount(currentGroup);
  });

  function update({ routeName, groupId }) {
    const listHref = buildHash(paths.conversations, { g: groupId });
    brand.setAttribute("href", listHref);
    links.conversations.setAttribute("href", listHref);
    links.checklist.setAttribute("href", buildHash(paths.checklist, { g: groupId }));
    links.appeals.setAttribute("href", buildHash(paths.appeals, { g: groupId }));
    links.insights.setAttribute("href", buildHash(paths.insights, { g: groupId }));
    setCurrent(links.conversations, routeName === "conversations" ? "page" : routeName === "conversation" ? "true" : null);
    setCurrent(links.checklist, routeName === "checklist" ? "page" : null);
    setCurrent(links.appeals, routeName === "appeals" ? "page" : null);
    setCurrent(links.insights, routeName === "insights" ? "page" : null);
    dataset.setValue(groupId);
    if (groupId !== currentGroup) {
      currentGroup = groupId;
      refreshAppealCount(groupId);
    }
  }

  return { el, update, setTheme: theme.set };
}

function navLink(label, ...extra) {
  return h("a", { className: "cqa-nav__link cqa-hl", attrs: { href: "#" } }, label, ...extra);
}

function setCurrent(link, value) {
  if (value) link.setAttribute("aria-current", value);
  else link.removeAttribute("aria-current");
}

function datasetForm(onSubmit) {
  let current = DEFAULT_GROUP;
  const known = new Set([DEFAULT_GROUP]);
  const input = h("input", {
    className: "cqa-dataset__input",
    attrs: {
      id: INPUT_ID, name: "group", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      maxlength: 64, list: OPTIONS_ID, enterkeyhint: "go", "aria-describedby": ERROR_ID,
    },
  });
  const options = h("datalist", { attrs: { id: OPTIONS_ID } });
  const error = h("p", { className: "cqa-dataset__error", attrs: { id: ERROR_ID, role: "alert", hidden: true } });
  const submit = h("button", { className: "cqa-icon-btn", attrs: { type: "submit", "aria-label": "Открыть набор", title: "Открыть набор" } },
    icon("arrowRight", { size: 18 }));
  const form = h("form", { className: "cqa-dataset", attrs: { novalidate: true, "aria-label": "Набор данных" } },
    h("label", { className: "cqa-dataset__label", attrs: { for: INPUT_ID }, text: "Набор" }),
    h("div", { className: "cqa-dataset__field" }, input, submit), options, error);

  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
  };
  const hideError = () => {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
  };
  const renderOptions = () => options.replaceChildren(...[...known].map((value) => h("option", { attrs: { value } })));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!isValidId(value)) {
      showError("group_id: латинские буквы, цифры, «_» и «-», до 64 символов.");
      return;
    }
    hideError();
    input.blur();
    onSubmit(value);
  });
  input.addEventListener("input", hideError);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    input.value = current;
    hideError();
  });
  renderOptions();

  return {
    el: form,
    setValue(value) {
      current = value;
      if (document.activeElement !== input) input.value = value;
      hideError();
      if (isValidId(value) && !known.has(value)) {
        known.add(value);
        renderOptions();
      }
    },
  };
}

function themeSwitch(onToggle) {
  const button = h("button", {
    className: "cqa-theme",
    attrs: { type: "button", role: "switch", "aria-checked": "false", "aria-label": "Тёмная тема", title: "Тёмная тема" },
    on: { click: onToggle },
  },
  h("span", { className: "cqa-theme__knob", attrs: { "aria-hidden": "true" } }),
  icon("sun", { size: 20, className: "cqa-theme__icon cqa-theme__icon--sun" }),
  icon("moon", { size: 20, className: "cqa-theme__icon cqa-theme__icon--moon" }));
  return {
    el: button,
    set(theme) {
      button.setAttribute("aria-checked", String(theme === "dark"));
    },
  };
}
