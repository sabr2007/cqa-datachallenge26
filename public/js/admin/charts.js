// Графики без библиотек: строки-полосы, сегментированная полоса долей, плитки-показатели.
// Данные — часть дизайна: тонкие полосы одного тона, подписи текстовыми токенами, значения всегда видны текстом
// (подсказка title только дополняет), у полосы есть доступное имя.

import { h } from "../dom.js";
import { formatPercent } from "./labels.js";
import { nextId } from "./ui.js";

/**
 * Плитка-показатель: подпись, значение, пояснение.
 * @param {{ label: string, value: string, sub?: string, tone?: "" | "good" | "warn" | "bad", hero?: boolean }} options
 */
export function statTile({ label, value, sub = "", tone = "", hero = false }) {
  return h("div", { className: `cqa-in-tile${hero ? " cqa-in-tile--hero" : ""}`, dataset: { tone: tone || "none" } },
    h("dt", { className: "cqa-in-tile__label", text: label }),
    h("dd", { className: "cqa-in-tile__value", text: value }),
    sub ? h("dd", { className: "cqa-in-tile__sub", text: sub }) : null);
}

/**
 * Ряд ранжированных полос (одна серия — без легенды): метка, полоса доли, значение и детали.
 * reference — вертикальная метка-ориентир (например, согласие экспертов).
 * @param {{ rows: Array<{ key: string, num?: string, label: string, share: number | null, value: string, detail?: string | Node,
 *   href?: string, emphasis?: boolean }>, reference?: { share: number, label: string } | null, caption: string }} options
 */
export function barList({ rows, reference = null, caption }) {
  const id = nextId("cqa-in-bars");
  return h("figure", { className: "cqa-in-bars", attrs: { "aria-labelledby": id } },
    h("figcaption", { className: "cqa-sr-only", attrs: { id }, text: caption }),
    reference ? h("p", { className: "cqa-in-bars__ref-note" },
      h("span", { className: "cqa-in-bars__ref-key", attrs: { "aria-hidden": "true" } }), reference.label) : null,
    h("ol", { className: "cqa-in-bars__list" }, rows.map((row) => {
      const labelEl = row.href
        ? h("a", { className: "cqa-in-bars__label", attrs: { href: row.href } }, row.num ? h("span", { className: "cqa-in-bars__num", text: row.num }) : null, row.label)
        : h("span", { className: "cqa-in-bars__label" }, row.num ? h("span", { className: "cqa-in-bars__num", text: row.num }) : null, row.label);
      const share = typeof row.share === "number" && Number.isFinite(row.share) ? Math.max(0, Math.min(1, row.share)) : null;
      return h("li", { className: `cqa-in-bars__row${row.emphasis ? " is-emphasis" : ""}`, dataset: { key: row.key } },
        labelEl,
        h("span", {
          className: "cqa-in-bars__track",
          attrs: { role: "img", "aria-label": `${row.label}: ${row.value}`, title: `${row.label}: ${row.value}` },
          vars: { "--cqa-share": share === null ? "0" : share.toFixed(4), ...(reference ? { "--cqa-ref": reference.share.toFixed(4) } : {}) },
        },
        share === null ? null : h("span", { className: "cqa-in-bars__fill" }),
        reference ? h("span", { className: "cqa-in-bars__ref", attrs: { "aria-hidden": "true" } }) : null),
        h("span", { className: "cqa-in-bars__value", text: share === null ? "—" : row.value }),
        row.detail ? h("span", { className: "cqa-in-bars__detail" }, row.detail) : null);
    })));
}

/**
 * Сегментированная полоса «одно целое — части» (тонкая, без подписей внутри): Да / N/A / Нет.
 * Доли и числа доступны в aria-label и подсказке, легенда — отдельно (answerLegend).
 * @param {Array<{ key: string, label: string, count: number }>} parts
 */
export function partsBar(parts, { label = "" } = {}) {
  const total = parts.reduce((sum, p) => sum + p.count, 0);
  const describe = parts.filter((p) => p.count > 0).map((p) => `${p.label}: ${p.count} (${formatPercent(total ? p.count / total : 0)})`).join(", ");
  return h("span", { className: "cqa-in-parts", attrs: { role: "img", "aria-label": `${label}${label ? ": " : ""}${describe || "нет данных"}` } },
    total ? parts.filter((p) => p.count > 0).map((p) => h("span", {
      className: `cqa-in-parts__seg cqa-in-ans--${p.key}`,
      attrs: { title: `${p.label}: ${p.count} (${formatPercent(p.count / total)})` },
      vars: { "--cqa-w": p.count },
    })) : h("span", { className: "cqa-in-parts__empty" }));
}

/** Легенда ответов (одна на график): цветной маркер + подпись текстовым токеном. */
export function answerLegend(items) {
  return h("ul", { className: "cqa-in-legend", attrs: { "aria-label": "Обозначения" } },
    items.map(({ key, label }) => h("li", { className: "cqa-in-legend__item" },
      h("span", { className: `cqa-in-legend__key cqa-in-ans--${key}`, attrs: { "aria-hidden": "true" } }), label)));
}

/** Секция панели: заголовок, пояснение, содержимое. */
export function panelSection({ title, lead = "", children, className = "" }) {
  const id = nextId("cqa-in-sec");
  return h("section", { className: `cqa-in-section ${className}`.trim(), attrs: { "aria-labelledby": id } },
    h("div", { className: "cqa-in-section__head" },
      h("h2", { className: "cqa-in-section__title", attrs: { id }, text: title }),
      lead ? h("p", { className: "cqa-in-section__lead", text: lead }) : null),
    children);
}
