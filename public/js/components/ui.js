// Общие компоненты интерфейса. Данные вставляются только как текст.

import { h } from "../dom.js";
import { icon } from "../icons.js";

const SLOW_NOTE_AFTER_SEC = 8;

/** Белая пилюля-статистика героя: число + подпись (форма пилюль «До 25%» с референса, без градиента). */
export function statChip({ value, label, dotClass = "", labelFirst = false }) {
  const valueEl = h("span", { className: "cqa-stat__value", text: value });
  const labelEl = h("span", { className: "cqa-stat__label", text: label });
  return h("li", { className: `cqa-stat ${dotClass}`.trim() },
    dotClass ? h("span", { className: "cqa-stat__dot", attrs: { "aria-hidden": "true" } }) : null,
    labelFirst ? [labelEl, valueEl] : [valueEl, labelEl]);
}

export function statSkeletons(count = 4) {
  return Array.from({ length: count }, () =>
    h("li", { className: "cqa-skel cqa-skel--stat", attrs: { "aria-hidden": "true" } }));
}

/** @param {string} text @param {{ variant?: string, iconName?: string, title?: string }} [options] */
export function pill(text, { variant = "", iconName = "", title = "" } = {}) {
  const classes = ["cqa-pill", ...variant.split(" ").filter(Boolean).map((v) => `cqa-pill--${v}`)].join(" ");
  return h("span", { className: classes, attrs: { title: title || null } },
    iconName ? icon(iconName, { size: 16, className: "cqa-pill__icon" }) : null,
    text);
}

/**
 * Кнопка или ссылка-кнопка.
 * @param {{ label: string, variant?: string, iconName?: string, onClick?: Function, href?: string, attrs?: object }} options
 */
export function button({ label, variant = "dark", iconName = "", onClick, href, attrs = {} }) {
  const classes = ["cqa-btn", ...variant.split(" ").filter(Boolean).map((v) => `cqa-btn--${v}`)].join(" ");
  const content = [iconName ? icon(iconName, { size: 18 }) : null, label];
  if (href) return h("a", { className: classes, attrs: { href, ...attrs } }, ...content);
  return h("button", { className: classes, attrs: { type: "button", ...attrs }, on: onClick ? { click: onClick } : {} }, ...content);
}

/**
 * Блок состояния: ошибка, пусто, информация.
 * @param {{ kind?: "error" | "empty" | "info", title: string, text?: string, code?: string, actions?: HTMLElement[] }} options
 */
export function stateBlock({ kind = "info", title, text = "", code = "", actions = [] }) {
  const iconName = kind === "error" ? "alert" : kind === "empty" ? "inbox" : "list";
  return h("div", { className: `cqa-state cqa-state--${kind}`, attrs: { role: kind === "error" ? "alert" : "status" } },
    h("span", { className: "cqa-state__icon" }, icon(iconName, { size: 24 })),
    h("h2", { className: "cqa-state__title", text: title }),
    text ? h("p", { className: "cqa-state__text", text }) : null,
    code ? h("p", { className: "cqa-state__code", text: `Код: ${code}` }) : null,
    actions.length ? h("div", { className: "cqa-state__actions" }, actions) : null);
}

/** Строки-скелетоны таблицы на время загрузки. */
export function skeletonRows(count) {
  return h("div", { className: "cqa-skel-rows", attrs: { "aria-hidden": "true" } },
    Array.from({ length: count }, () => h("div", { className: "cqa-skel-row" },
      h("span", { className: "cqa-skel cqa-skel--id" }),
      h("span", { className: "cqa-skel cqa-skel--pill" }),
      h("span", { className: "cqa-skel cqa-skel--line cqa-skel--w90" }),
      h("span", { className: "cqa-skel cqa-skel--pill" }))));
}

/**
 * Статус оценки — единый вид для всех экранов.
 * @param {"pending" | "done" | "review" | "appeal" | "error"} kind
 */
export function statusPill(kind, label, title = "") {
  return h("span", { className: `cqa-status cqa-status--${kind}`, attrs: { title: title || null } },
    h("span", { className: "cqa-status__dot", attrs: { "aria-hidden": "true" } }), label);
}

/**
 * Строка «идёт загрузка» со счётчиком секунд: API кейса бывает медленным.
 * @returns {{ el: HTMLElement, stop: () => void }}
 */
export function loadingNote(label) {
  const seconds = h("span", { className: "cqa-num", text: "0 с" });
  const slow = h("span", { text: "API кейса отвечает медленно — это нормально, обычно до минуты.", attrs: { hidden: true } });
  const el = h("p", { className: "cqa-loading-note", attrs: { role: "status" } },
    h("span", { className: "cqa-spinner", attrs: { "aria-hidden": "true" } }),
    h("span", { text: label }), seconds, slow);
  const started = Date.now();
  const timer = window.setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    seconds.textContent = `${elapsed} с`;
    if (elapsed >= SLOW_NOTE_AFTER_SEC) slow.hidden = false;
  }, 1000);
  return { el, stop: () => window.clearInterval(timer) };
}

/**
 * Карточка-сводка героя: главное число и распределения (сложенные полосы с легендой).
 * @param {{ kicker: string, value: string, unit: string, groups: Array<{ title: string, segments: Array<{ label: string, value: number }> }> }} options
 */
export function summaryCard({ kicker, value, unit, groups, layout = "column" }) {
  return h("div", { className: `cqa-summary cqa-summary--${layout}` },
    h("div", { className: "cqa-summary__head" },
      h("p", { className: "cqa-summary__kicker", text: kicker }),
      h("p", { className: "cqa-summary__total" },
        h("span", { className: "cqa-summary__value cqa-num", text: value }),
        h("span", { className: "cqa-summary__unit", text: unit }))),
    groups.map(distribution));
}

export function summarySkeleton(layout = "column") {
  return h("div", { className: `cqa-summary cqa-summary--${layout}`, attrs: { "aria-hidden": "true" } },
    h("span", { className: "cqa-skel cqa-skel--line cqa-skel--w70" }),
    h("span", { className: "cqa-skel cqa-skel--total" }),
    h("span", { className: "cqa-skel cqa-skel--bar" }),
    h("span", { className: "cqa-skel cqa-skel--bar" }));
}

/** Сложенная полоса долей + легенда с числами и процентами (категориальная палитра cat-1…5). */
export function distribution({ title, segments }) {
  const total = segments.reduce((sum, seg) => sum + seg.value, 0);
  const share = (value) => (total > 0 ? Math.round((value / total) * 100) : 0);
  const description = segments.map((seg) => `${seg.label}: ${seg.value} (${share(seg.value)}%)`).join(", ");
  return h("div", { className: "cqa-dist" },
    h("p", { className: "cqa-dist__title", text: title }),
    h("div", { className: "cqa-dist__bar", attrs: { role: "img", "aria-label": `${title}: ${description}` } },
      segments.filter((seg) => seg.value > 0).map((seg, i) =>
        h("span", { className: `cqa-dist__seg cqa-cat-${(i % 5) + 1}`, vars: { "--cqa-w": seg.value } }))),
    h("ul", { className: "cqa-dist__legend", attrs: { "aria-hidden": "true" } },
      segments.filter((seg) => seg.value > 0).map((seg, i) =>
        h("li", { className: `cqa-dist__item cqa-cat-${(i % 5) + 1}` },
          h("span", { className: "cqa-dist__dot" }),
          h("span", { text: seg.label }),
          h("strong", { className: "cqa-num", text: seg.value }),
          h("span", { className: "cqa-dist__pct cqa-num", text: `${share(seg.value)}%` })))));
}
