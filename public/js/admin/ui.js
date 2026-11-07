// Мелкие компоненты экранов «Чек-лист» и «Аналитика»: кнопки с иконками, поля формы, бейджи, дельты.
// Текст попадает в DOM только через textContent (h из dom.js).

import { appendChildren, h } from "../dom.js";
import { adminIcon } from "./icons.js";
import { formatDelta } from "./labels.js";

let uid = 0;

/** Заменяет содержимое элемента; null, undefined и false пропускаются, массивы разворачиваются. */
export function setChildren(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
  return el;
}

/** Уникальный id для связки label/aria-describedby. */
export function nextId(prefix = "cqa-a") {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Кнопка в стиле cqa-btn с иконкой из admin/icons.js.
 * @param {{ label: string, variant?: string, iconName?: string, onClick?: (e: Event) => void, attrs?: object, className?: string }} options
 */
export function actionButton({ label, variant = "dark", iconName = "", onClick, attrs = {}, className = "" }) {
  const classes = ["cqa-btn", ...variant.split(" ").filter(Boolean).map((v) => `cqa-btn--${v}`), className].filter(Boolean).join(" ");
  return h("button", { className: classes, attrs: { type: "button", ...attrs }, on: onClick ? { click: onClick } : {} },
    iconName ? adminIcon(iconName, { size: 18 }) : null, label);
}

/** Круглая кнопка-иконка с подписью для скринридера и подсказкой. */
export function iconButton({ label, iconName, onClick, disabled = false, className = "", attrs = {} }) {
  return h("button", {
    className: `cqa-a-icon-btn ${className}`.trim(),
    attrs: { type: "button", "aria-label": label, title: label, disabled, ...attrs },
    on: onClick ? { click: onClick } : {},
  }, adminIcon(iconName, { size: 18 }));
}

/** Ссылка-кнопка (для переходов по hash и выгрузки). */
export function linkButton({ label, href, variant = "gray sm", iconName = "", attrs = {} }) {
  const classes = ["cqa-btn", ...variant.split(" ").filter(Boolean).map((v) => `cqa-btn--${v}`)].join(" ");
  return h("a", { className: classes, attrs: { href, ...attrs } }, iconName ? adminIcon(iconName, { size: 18 }) : null, label);
}

/**
 * Поле формы с видимой подписью, подсказкой и местом под ошибку.
 * @param {{ label: string, control: HTMLElement, hint?: string, className?: string }} options
 * @returns {{ el: HTMLElement, setError: (message: string, level?: "error" | "warning") => void }}
 */
export function field({ label, control, hint = "", className = "" }) {
  const id = control.id || nextId("cqa-f");
  control.id = id;
  const hintEl = hint ? h("p", { className: "cqa-a-field__hint", attrs: { id: `${id}-hint` }, text: hint }) : null;
  const errorEl = h("p", { className: "cqa-a-field__error", attrs: { id: `${id}-error`, hidden: true } });
  const describedBy = () => [hintEl ? `${id}-hint` : "", errorEl.hidden ? "" : `${id}-error`].filter(Boolean).join(" ");
  const sync = () => {
    const value = describedBy();
    if (value) control.setAttribute("aria-describedby", value);
    else control.removeAttribute("aria-describedby");
  };
  sync();
  const el = h("div", { className: `cqa-a-field ${className}`.trim() },
    h("label", { className: "cqa-a-field__label", attrs: { for: id }, text: label }), control, hintEl, errorEl);
  return {
    el,
    setError(message, level = "error") {
      errorEl.textContent = message;
      errorEl.hidden = !message;
      errorEl.dataset.level = level;
      if (message && level === "error") control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
      sync();
    },
  };
}

/** Метка-бейдж: tone = new | changed | removed | error | warning | sandbox | muted. */
export function badge(text, tone = "muted", title = "") {
  return h("span", { className: `cqa-a-badge cqa-a-badge--${tone}`, attrs: { title: title || null } }, text);
}

/** Пилюля разницы: зелёная при росте, красная при падении (или наоборот, если invert). */
export function deltaChip(delta, { invert = false, suffix = "" } = {}) {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return null;
  const rounded = Math.round(delta * 100) / 100;
  const good = invert ? rounded < 0 : rounded > 0;
  const tone = rounded === 0 ? "flat" : good ? "up" : "down";
  return h("span", { className: `cqa-a-delta cqa-a-delta--${tone}` }, `${formatDelta(rounded)}${suffix}`);
}

/** Горизонтальная полоса-метр 0..1 (данные — часть дизайна, без библиотек). */
export function meter(share, { tone = "", label = "" } = {}) {
  const value = typeof share === "number" && Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  return h("span", {
    className: `cqa-a-meter ${tone ? `cqa-a-meter--${tone}` : ""}`.trim(),
    attrs: { role: label ? "img" : null, "aria-label": label || null, "aria-hidden": label ? null : "true" },
    vars: { "--cqa-share": value.toFixed(4) },
  }, h("span", { className: "cqa-a-meter__fill" }));
}

/** Живой регион для коротких объявлений скринридеру (сохранено, ошибка, прогресс). */
export function liveRegion() {
  const el = h("p", { className: "cqa-sr-only", attrs: { role: "status", "aria-live": "polite" } });
  return { el, say: (text) => { el.textContent = ""; window.setTimeout(() => { el.textContent = text; }, 30); } };
}
