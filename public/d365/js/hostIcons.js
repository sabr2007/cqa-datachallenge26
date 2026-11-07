// Нейтральные иконки макета model-driven app (без логотипов и товарных знаков).
// 20×20, обводка currentColor; собираются через createElementNS из статичных описаний.

import { svg } from "../../js/dom.js";

const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" };

const ICONS = Object.freeze({
  waffle: [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]]
    .map(([x, y]) => ["rect", { x: x - 0.5, y: y - 0.5, width: 3, height: 3, rx: 0.6, fill: "currentColor", stroke: "none" }]),
  menu: [["path", { d: "M3.5 5.5h13M3.5 10h13M3.5 14.5h13" }]],
  home: [["path", { d: "M3.5 9.2L10 3.8l6.5 5.4V16a.9.9 0 0 1-.9.9h-3.7v-4.6H8.1v4.6H4.4a.9.9 0 0 1-.9-.9z" }]],
  recent: [["circle", { cx: 10, cy: 10, r: 6.8 }], ["path", { d: "M10 6.3V10l2.5 1.6" }]],
  pin: [["path", { d: "M12.6 3.4l4 4-2.4 1.1-2.6 2.6.4 3.3-1.2 1.2-2.8-2.8-3.6 3.6M7.6 9.8L5 7.2l1.2-1.2 3.3.4 2.6-2.6z" }]],
  dashboard: [["rect", { x: 3.5, y: 3.5, width: 5.5, height: 6.5, rx: 1 }], ["rect", { x: 11, y: 3.5, width: 5.5, height: 4, rx: 1 }], ["rect", { x: 3.5, y: 12, width: 5.5, height: 4.5, rx: 1 }], ["rect", { x: 11, y: 9.5, width: 5.5, height: 7, rx: 1 }]],
  ticket: [["path", { d: "M3.5 6.2a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1.9a1.9 1.9 0 0 0 0 3.8v1.9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-1.9a1.9 1.9 0 0 0 0-3.8z" }], ["path", { d: "M12 5.4v9.2", "stroke-dasharray": "1.6 1.6" }]],
  queue: [["path", { d: "M3.5 11.5l1.7-5.6a1.2 1.2 0 0 1 1.2-.9h7.2a1.2 1.2 0 0 1 1.2.9l1.7 5.6V15a1.2 1.2 0 0 1-1.2 1.2H4.7A1.2 1.2 0 0 1 3.5 15z" }], ["path", { d: "M3.5 11.5h3.6l1 1.6h3.8l1-1.6h3.6" }]],
  book: [["path", { d: "M4 4.5h4.5A1.5 1.5 0 0 1 10 6v10a1.5 1.5 0 0 0-1.5-1.5H4zM16 4.5h-4.5A1.5 1.5 0 0 0 10 6v10a1.5 1.5 0 0 1 1.5-1.5H16z" }]],
  person: [["circle", { cx: 10, cy: 6.8, r: 3 }], ["path", { d: "M4.5 16.5a5.5 5.5 0 0 1 11 0" }]],
  building: [["rect", { x: 4.5, y: 3.5, width: 8, height: 13, rx: 0.8 }], ["path", { d: "M12.5 8.5h3v8h-3M7 6.5h1M9.5 6.5h1M7 9.5h1M9.5 9.5h1M7 12.5h1M9.5 12.5h1" }]],
  quality: [["path", { d: "M10 3l1.8 4.2 4.5.4-3.4 3 1 4.4L10 12.7 6.1 15l1-4.4-3.4-3 4.5-.4z" }]],
  flag: [["path", { d: "M5 17V3.5M5 4h9.5l-2 3.2 2 3.2H5" }]],
  back: [["path", { d: "M16 10H4.5M9 5l-5 5 5 5" }]],
  save: [["path", { d: "M4 4.8A.8.8 0 0 1 4.8 4h8.6L16 6.6v8.6a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z" }], ["path", { d: "M6.5 4v3.5h6V4M6.5 16v-4.5h7V16" }]],
  saveClose: [["path", { d: "M4 4.8A.8.8 0 0 1 4.8 4h8.6L16 6.6V10M10 16H4.8a.8.8 0 0 1-.8-.8V4.8" }], ["path", { d: "M12.5 13l3.5 3.5M16 13l-3.5 3.5" }]],
  plus: [["path", { d: "M10 4v12M4 10h12" }]],
  refresh: [["path", { d: "M15.8 10a5.8 5.8 0 1 1-1.7-4.1" }], ["path", { d: "M15.8 4v3.7h-3.7" }]],
  check: [["circle", { cx: 10, cy: 10, r: 6.8 }], ["path", { d: "M7 10.2l2.1 2.1L13.2 8" }]],
  assign: [["circle", { cx: 8, cy: 7, r: 2.7 }], ["path", { d: "M3.5 16a4.6 4.6 0 0 1 8.4-2.6M13 12.5h4M15 10.5l2 2-2 2" }]],
  share: [["circle", { cx: 14.5, cy: 5, r: 2 }], ["circle", { cx: 5.5, cy: 10, r: 2 }], ["circle", { cx: 14.5, cy: 15, r: 2 }], ["path", { d: "M7.3 9l5.4-3M7.3 11l5.4 3" }]],
  more: [["circle", { cx: 4.5, cy: 10, r: 1, fill: "currentColor" }], ["circle", { cx: 10, cy: 10, r: 1, fill: "currentColor" }], ["circle", { cx: 15.5, cy: 10, r: 1, fill: "currentColor" }]],
  close: [["path", { d: "M5 5l10 10M15 5L5 15" }]],
  panel: [["rect", { x: 3.5, y: 4, width: 13, height: 12, rx: 1.2 }], ["path", { d: "M11.5 4v12" }]],
});

/** Декоративная иконка макета. */
export function hostIcon(name, { size = 20, className = "" } = {}) {
  const root = svg("svg", {
    viewBox: "0 0 20 20", width: size, height: size, "aria-hidden": "true", focusable: "false",
    class: className || null, ...STROKE,
  });
  for (const [tag, attrs] of ICONS[name] ?? ICONS.more) root.append(svg(tag, attrs));
  return root;
}
