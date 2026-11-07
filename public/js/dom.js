// Безопасная сборка DOM. Текст попадает в документ только через текстовые узлы
// и textContent — innerHTML с данными в интерфейсе не используется нигде.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Создаёт элемент.
 * props: { className, text, attrs, dataset, on, vars }
 *   attrs   — атрибуты (false/null/undefined пропускаются, true → пустое значение);
 *   on      — обработчики событий { click: fn };
 *   vars    — CSS custom properties через CSSOM (совместимо со строгим CSP).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttributes(el, attrs);
  for (const child of children) el.append(child);
  return el;
}

/** replaceChildren без текстовых «null»: пропускает null/undefined/false и разворачивает массивы. */
export function setChildren(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  return el;
}

export function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function setAttributes(el, attrs = {}) {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    el.setAttribute(name, value === true ? "" : String(value));
  }
}

function applyProps(el, props) {
  const { className, text, attrs, dataset, on, vars } = props;
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  if (attrs) setAttributes(el, attrs);
  if (dataset) for (const [key, value] of Object.entries(dataset)) el.dataset[key] = String(value);
  if (on) for (const [type, handler] of Object.entries(on)) el.addEventListener(type, handler);
  if (vars) for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, String(value));
}

/** Для фокуса после смены маршрута: элемент получает фокус без прокрутки. */
export function focusWithoutScroll(el) {
  if (!el) return;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

export function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
