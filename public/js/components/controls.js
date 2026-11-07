// Контролы фильтров: подпись группы, поиск, сегменты со счётчиками, выпадающий список.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { formatInt } from "../format.js";

/** Группа фильтра с видимой подписью, связанной с контролом через aria-labelledby. */
export function filterGroup(id, label, control, modifier = "", note = null) {
  const labelId = `${id}-label`;
  const target = control.matches("[role='group'], select") ? control : control.querySelector("input, select");
  target?.setAttribute("aria-labelledby", labelId);
  return h("div", { className: `cqa-filter${modifier ? ` cqa-filter--${modifier}` : ""}` },
    h("span", { className: "cqa-filter__label" }, h("span", { attrs: { id: labelId }, text: label }), note),
    control);
}

export function searchField(initial, onInput, placeholder) {
  const input = h("input", {
    className: "cqa-search__input",
    attrs: {
      type: "search", name: "q", placeholder, autocomplete: "off",
      spellcheck: "false", "aria-keyshortcuts": "/", enterkeyhint: "search",
    },
  });
  input.value = initial;
  input.addEventListener("input", () => onInput(input.value));
  const el = h("div", { className: "cqa-search", attrs: { role: "search" } }, icon("search", { size: 20, className: "cqa-search__icon" }), input);
  return { el, focus: () => input.focus(), set: (value) => { input.value = value; } };
}

/**
 * Сегменты (кнопки aria-pressed) со счётчиками и недоступными пунктами.
 * @param {Array<{ value: string, label: string, title?: string }>} options
 */
export function segmented(options, initial, onChange, { disabledHint = "" } = {}) {
  let value = initial;
  let disabled = new Set();
  const buttons = options.map((option) => {
    const count = h("span", { className: "cqa-seg__count" });
    const btn = h("button", {
      className: "cqa-seg__btn cqa-hl",
      attrs: { type: "button", "aria-pressed": String(option.value === value), title: option.title ?? null },
      on: { click: () => select(option.value) },
    }, option.label, count);
    return { btn, count, value: option.value, title: option.title ?? null };
  });
  const el = h("div", { className: "cqa-seg", attrs: { role: "group" } }, buttons.map((b) => b.btn));

  function sync() {
    for (const b of buttons) {
      const off = disabled.has(b.value);
      b.btn.setAttribute("aria-pressed", String(b.value === value && !off));
      if (off) {
        b.btn.setAttribute("aria-disabled", "true");
        if (disabledHint) b.btn.title = disabledHint;
      } else {
        b.btn.removeAttribute("aria-disabled");
        if (b.title) b.btn.title = b.title;
        else b.btn.removeAttribute("title");
      }
    }
  }
  function select(next) {
    if (next === value || disabled.has(next)) return;
    value = next;
    sync();
    onChange(next);
  }
  return {
    el,
    set(next) {
      value = next;
      sync();
    },
    setDisabled(values) {
      disabled = new Set(values);
      if (disabled.has(value)) value = "";
      sync();
    },
    setCounts(counts, total) {
      for (const b of buttons) b.count.textContent = disabled.has(b.value) ? "" : formatInt(b.value ? counts[b.value] ?? 0 : total);
    },
  };
}

/**
 * Выпадающий список фильтра; пустое значение — «любой».
 * @param {{ name: string, placeholder: string, initial: string, onChange: (value: string) => void }} options
 */
export function selectFilter({ name, placeholder, initial, onChange }) {
  const el = h("select", { className: "cqa-select cqa-select--filter", attrs: { name } });
  let value = initial;
  el.addEventListener("change", () => {
    value = el.value;
    onChange(value);
  });
  return {
    el,
    /** @param {Array<{ value: string, label: string, count?: number }>} options */
    setOptions(options, { disabled = false } = {}) {
      el.replaceChildren(
        h("option", { attrs: { value: "" }, text: placeholder }),
        ...options.map((option) => h("option", {
          attrs: { value: option.value },
          text: option.count === undefined ? option.label : `${option.label} · ${formatInt(option.count)}`,
        })));
      el.value = options.some((option) => option.value === value) ? value : "";
      el.disabled = disabled;
    },
    set(next) {
      value = next;
      el.value = next;
    },
  };
}
