// Иконки панели, которых нет в общем наборе icons.js. Та же сетка 24×24 и обводка currentColor;
// собираются через createElementNS из статичных описаний (никакого разбора строк разметки).

import { svg } from "../dom.js";

const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round" };

const GLYPHS = Object.freeze({
  check: [["path", { d: "M5 12.5l4.2 4.2L19 7" }]],
  external: [["path", { d: "M14 4.5h5.5V10" }], ["path", { d: "M19.5 4.5L11 13" }], ["path", { d: "M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5h4" }]],
  open: [["path", { d: "M5 12h13.5" }], ["path", { d: "M13 6.5l5.5 5.5-5.5 5.5" }]],
  close: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  chevron: [["path", { d: "M6.5 9.5L12 15l5.5-5.5" }]],
  dispute: [["path", { d: "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z" }], ["path", { d: "M12 7.5v4M12 14v.1" }]],
  flag: [["path", { d: "M5.5 20.5v-16" }], ["path", { d: "M5.5 5h11l-2.2 3.6 2.2 3.6h-11" }]],
  warning: [["path", { d: "M10.3 4.3L2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" }], ["path", { d: "M12 9.5v4.2M12 16.8v.1" }]],
});

/** Декоративная иконка (скрыта от скринридеров: смысл всегда продублирован текстом). */
export function glyph(name, { size = 18, className = "" } = {}) {
  const parts = GLYPHS[name] ?? GLYPHS.warning;
  const root = svg("svg", {
    viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", focusable: "false",
    class: className || null, ...STROKE,
  });
  for (const [tag, attrs] of parts) root.append(svg(tag, attrs));
  return root;
}
