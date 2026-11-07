// Набор иконок (24×24, обводка currentColor). Собираются через createElementNS
// из статичных описаний — без разбора строк разметки.

import { svg } from "./dom.js";

const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round" };

const ICONS = {
  chat: [["path", { d: "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z" }]],
  phone: [["path", { d: "M6.2 3.8h2.6l1.5 4.1-2 1.4a11.5 11.5 0 0 0 6.4 6.4l1.4-2 4.1 1.5v2.6a2 2 0 0 1-2.2 2A16.4 16.4 0 0 1 4.2 6a2 2 0 0 1 2-2.2z" }]],
  search: [["circle", { cx: 11, cy: 11, r: 6.5 }], ["path", { d: "M16 16l4.5 4.5" }]],
  plus: [["path", { d: "M12 4.5v15M4.5 12h15", "stroke-width": 2 }]],
  arrowLeft: [["path", { d: "M19 12H5M11 6l-6 6 6 6" }]],
  arrowRight: [["path", { d: "M5 12h14M13 6l6 6-6 6" }]],
  refresh: [["path", { d: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3" }], ["path", { d: "M19.5 4.5v4.6h-4.6" }]],
  alert: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.8v5.2M12 16.3v.1" }]],
  inbox: [["path", { d: "M4 13.5l2.2-7A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.5l2.2 7v4A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z" }], ["path", { d: "M4 13.5h4.5l1.2 2h4.6l1.2-2H20" }]],
  play: [["path", { d: "M8 5.5v13l10.5-6.5z", fill: "currentColor", stroke: "none" }]],
  headphones: [["path", { d: "M4.5 15v-3a7.5 7.5 0 0 1 15 0v3" }], ["rect", { x: 3.5, y: 14, width: 4, height: 6, rx: 1.6 }], ["rect", { x: 16.5, y: 14, width: 4, height: 6, rx: 1.6 }]],
  sparkle: [["path", { d: "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" }], ["path", { d: "M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" }]],
  sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" }]],
  moon: [["path", { d: "M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z", fill: "currentColor", stroke: "none" }]],
  list: [["path", { d: "M9 6.5h10.5M9 12h10.5M9 17.5h10.5" }], ["circle", { cx: 5, cy: 6.5, r: 1 }], ["circle", { cx: 5, cy: 12, r: 1 }], ["circle", { cx: 5, cy: 17.5, r: 1 }]],
  clock: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5V12l3 2" }]],
  info: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 11v5.5M12 7.7v.1" }]],
  sort: [["path", { d: "M8.5 9.5L12 6l3.5 3.5M8.5 14.5L12 18l3.5-3.5" }]],
  sortAsc: [["path", { d: "M12 18.5V6M7 11l5-5 5 5" }]],
  sortDesc: [["path", { d: "M12 5.5V18M7 13l5 5 5-5" }]],
  chevronDown: [["path", { d: "M6.5 9.5L12 15l5.5-5.5" }]],
  check: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
  close: [["path", { d: "M6.5 6.5l11 11M17.5 6.5l-11 11" }]],
  download: [["path", { d: "M12 4.5v10.5M7.5 10.5L12 15l4.5-4.5" }], ["path", { d: "M5 19.5h14" }]],
  flag: [["path", { d: "M6 20.5V4.5" }], ["path", { d: "M6 5h10.5l-2 3.5 2 3.5H6" }]],
  shield: [["path", { d: "M12 3.5l7 2.6v5.2c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2V6.1z" }], ["path", { d: "M8.8 12.2l2.2 2.2 4.2-4.4" }]],
  stop: [["rect", { x: 7, y: 7, width: 10, height: 10, rx: 2, fill: "currentColor", stroke: "none" }]],
  target: [["circle", { cx: 12, cy: 12, r: 8 }], ["circle", { cx: 12, cy: 12, r: 3.5 }]],
};

/** Возвращает декоративную SVG-иконку (скрыта от скринридеров). */
export function icon(name, { size = 20, className = "" } = {}) {
  const parts = ICONS[name] ?? ICONS.alert;
  const root = svg("svg", {
    viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", focusable: "false",
    class: className || null, ...STROKE,
  });
  for (const [tag, attrs] of parts) root.append(svg(tag, attrs));
  return root;
}

/** Знак продукта: градиентный круг с «пузырём-галочкой» (собственный, не бренд Freedom). */
export function brandMark(className = "") {
  const gradientId = `cqa-mark-${Math.random().toString(36).slice(2, 8)}`;
  const gradient = svg("linearGradient", { id: gradientId, x1: 0, y1: 0, x2: 1, y2: 1 },
    svg("stop", { offset: 0, "stop-color": "#0091B4" }),
    svg("stop", { offset: 1, "stop-color": "#00B85F" }));
  return svg("svg", { viewBox: "0 0 32 32", class: className || null, "aria-hidden": "true", focusable: "false" },
    svg("defs", {}, gradient),
    svg("circle", { cx: 16, cy: 16, r: 16, fill: `url(#${gradientId})` }),
    svg("path", { d: "M9 10.5A2.5 2.5 0 0 1 11.5 8h9A2.5 2.5 0 0 1 23 10.5v7a2.5 2.5 0 0 1-2.5 2.5H15l-4 3.5V20A2 2 0 0 1 9 18z", fill: "none", stroke: "#fff", "stroke-width": 1.8, "stroke-linejoin": "round" }),
    svg("path", { d: "M12.6 14.2l2.2 2.2 4.4-4.6", fill: "none", stroke: "#fff", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }));
}
