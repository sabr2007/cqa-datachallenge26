// Иконки экранов «Чек-лист» и «Аналитика» (24×24, обводка currentColor), которых нет в общем наборе icons.js.
// Собираются через createElementNS из статичных описаний.

import { svg } from "../dom.js";
import { icon as sharedIcon } from "../icons.js";

const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round" };

const ICONS = {
  up: [["path", { d: "M12 19V5.5M6.5 11 12 5.5l5.5 5.5" }]],
  chevron: [["path", { d: "M6.5 9.5 12 15l5.5-5.5" }]],
  down: [["path", { d: "M12 5v13.5M6.5 13 12 18.5l5.5-5.5" }]],
  trash: [["path", { d: "M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7M10.2 10.8v6M13.8 10.8v6" }]],
  swap: [["path", { d: "M5 8.5h13M14.5 5 18 8.5 14.5 12M19 15.5H6M9.5 12 6 15.5 9.5 19" }]],
  undo: [["path", { d: "M8.5 6 4.5 10l4 4" }], ["path", { d: "M4.5 10h9.5a5 5 0 0 1 0 10h-3" }]],
  check: [["path", { d: "M5 12.5 9.8 17 19 7.5", "stroke-width": 2.1 }]],
  close: [["path", { d: "M6.5 6.5l11 11M17.5 6.5l-11 11" }]],
  stop: [["rect", { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2, fill: "currentColor", stroke: "none" }]],
  flask: [["path", { d: "M9.5 3.8h5M10.3 3.8v5.6L5 18a1.8 1.8 0 0 0 1.6 2.7h10.8A1.8 1.8 0 0 0 19 18l-5.3-8.6V3.8" }], ["path", { d: "M7.6 14.5h8.8" }]],
  history: [["path", { d: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3" }], ["path", { d: "M4.5 4.5v3.9h3.9" }], ["path", { d: "M12 8v4.3l2.8 1.7" }]],
  edit: [["path", { d: "M14.8 5.2l4 4L9 19H5v-4z" }], ["path", { d: "M12.8 7.2l4 4" }]],
  download: [["path", { d: "M12 4.5v11M7 11l5 5 5-5M5 19.5h14" }]],
  compare: [["path", { d: "M8 4.5v15M16 4.5v15" }], ["path", { d: "M4.5 8H8M4.5 12H8M16 16h3.5M16 12h3.5" }]],
  grip: [["circle", { cx: 9, cy: 7, r: 1.2 }], ["circle", { cx: 15, cy: 7, r: 1.2 }], ["circle", { cx: 9, cy: 12, r: 1.2 }], ["circle", { cx: 15, cy: 12, r: 1.2 }], ["circle", { cx: 9, cy: 17, r: 1.2 }], ["circle", { cx: 15, cy: 17, r: 1.2 }]],
  target: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["circle", { cx: 12, cy: 12, r: 4.5 }], ["circle", { cx: 12, cy: 12, r: 0.9, fill: "currentColor" }]],
  quote: [["path", { d: "M5 17.5c0-4.5 1.3-7.6 4.6-9.6M13.4 17.5c0-4.5 1.3-7.6 4.6-9.6" }], ["path", { d: "M5 17.5h4v-4H5zM13.4 17.5h4v-4h-4z" }]],
};

/** Декоративная иконка (скрыта от скринридеров); незнакомое имя ищется в общем наборе. */
export function adminIcon(name, { size = 20, className = "" } = {}) {
  const parts = ICONS[name];
  if (!parts) return sharedIcon(name, { size, className });
  const root = svg("svg", {
    viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", focusable: "false",
    class: className || null, ...STROKE,
  });
  for (const [tag, attrs] of parts) root.append(svg(tag, attrs));
  return root;
}
