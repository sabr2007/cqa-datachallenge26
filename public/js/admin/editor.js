// Редактор черновика чек-листа: секции, карточки критериев, сумма весов, отмена структурных действий.
// Ввод текста обновляет черновик без перерисовки (фокус не теряется); структурные действия
// (добавить, удалить, переставить, сменить тип) перерисовывают список и возвращают фокус на нужный контрол.

import { h } from "../dom.js";
import { formatDecimal } from "../format.js";
import { diffChecklists } from "./diff.js";
import { criterionCard, refreshCardHead, setCardIssues } from "./editorCard.js";
import { adminIcon } from "./icons.js";
import { addCriterion, addSection, criterionLabel, findCriterion, moveSection, removeSection, renameSection, toNumber, weightSum } from "./model.js";
import { field, iconButton } from "./ui.js";

const UNDO_LIMIT = 50;
const DEFAULT_MAX_TOTAL = 100;

/**
 * @param {{ doc: import("./model.js").DraftDoc, baseDoc: object, reservedIds?: string[],
 *   onChange: (doc: import("./model.js").DraftDoc, meta: { structural: boolean }) => void }} options
 */
export function createEditor({ doc, baseDoc, reservedIds = [], onChange }) {
  let current = doc;
  let undoStack = [];
  let marks = new Map();
  let fields = new Map();
  let issues = [];
  let showAll = false;
  const expanded = new Set();
  const touched = new Set();
  const replacedFrom = new Map();
  const root = h("div", { className: "cqa-ed" });

  /** @type {import("./editorCard.js").EditorApi} */
  const api = {
    doc: () => current,
    isExpanded: (id) => expanded.has(id),
    toggle: (id) => {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render(`${id}:toggle`);
    },
    edit: (next) => commit(next, { structural: false }),
    restructure: (next, focusKey, expandId) => {
      if (expandId) expanded.add(expandId);
      commit(next, { structural: true, focusKey });
    },
    register: (key, handle) => fields.set(key, handle),
    touch: (key) => {
      touched.add(key);
      applyIssues();
    },
    reservedIds,
    mark: (id) => marks.get(id) ?? null,
    replacedFrom,
  };

  recomputeMarks();
  render();

  function commit(next, { structural, focusKey = null }) {
    if (next === current) return;
    if (structural) undoStack = [...undoStack, current].slice(-UNDO_LIMIT);
    current = next;
    recomputeMarks();
    if (structural) render(focusKey);
    else refresh();
    onChange(current, { structural });
  }

  function recomputeMarks() {
    const diff = diffChecklists(baseDoc, current);
    marks = new Map([...diff.added.map((c) => [c.id, "new"]), ...diff.changed.map((c) => [c.id, "changed"])]);
  }

  /* ---------- отрисовка ---------- */

  function render(focusKey = null) {
    fields = new Map();
    root.replaceChildren(topBar(), ...current.sections.map(sectionBlock), addSectionButton());
    applyIssues();
    if (focusKey) restoreFocus(focusKey);
  }

  /** Обновление без перерисовки: заголовки карточек, мета секций, сумма весов. */
  function refresh() {
    for (const card of root.querySelectorAll(".cqa-ed-crit")) {
      const criterion = findCriterion(current, card.dataset.criterion);
      if (criterion) refreshCardHead(card, criterion, api);
    }
    for (const meta of root.querySelectorAll("[data-section-meta]")) {
      const section = current.sections.find((s) => s.id === meta.dataset.sectionMeta);
      if (section) meta.textContent = sectionMeta(section);
    }
    const total = root.querySelector(".cqa-ed-total");
    if (total) total.replaceWith(weightTotal());
  }

  function topBar() {
    const title = h("input", { className: "cqa-a-input cqa-ed-doc-title", attrs: { type: "text", value: current.title, "data-key": "doc:title", maxlength: 160, autocomplete: "off" } });
    title.addEventListener("input", () => commit({ ...current, title: title.value }, { structural: false }));
    title.addEventListener("change", () => api.touch("doc::title"));
    const handle = field({ label: "Название чек-листа", control: title, className: "cqa-ed-top__title" });
    fields.set("doc::title", handle);
    const allOpen = current.criteria.length > 0 && current.criteria.every((c) => expanded.has(c.id));
    const toggleAll = h("button", {
      className: "cqa-btn cqa-btn--gray cqa-btn--sm",
      attrs: { type: "button", "data-key": "doc:toggle-all", "aria-pressed": String(allOpen) },
      on: { click: () => {
        if (allOpen) expanded.clear();
        else current.criteria.forEach((c) => expanded.add(c.id));
        render("doc:toggle-all");
      } },
    }, allOpen ? "Свернуть все" : "Развернуть все");
    return h("div", { className: "cqa-ed-top" }, handle.el, weightTotal(), toggleAll);
  }

  /** Сумма весов: число, полоса из весов критериев с меткой «100» и пояснение, если сумма не 100. */
  function weightTotal() {
    const maxTotal = Number.isFinite(current.rules?.maxTotal) && current.rules.maxTotal > 0 ? current.rules.maxTotal : DEFAULT_MAX_TOTAL;
    const sum = weightSum(current);
    const scale = Math.max(sum, maxTotal);
    const state = !(sum > 0) ? "error" : Math.abs(sum - maxTotal) > 1e-9 ? "warn" : "ok";
    const scored = current.criteria.filter((c) => c.scored && !c.critical && toNumber(c.weight) > 0);
    const note = state === "ok"
      ? "Веса читаются как баллы из 100."
      : state === "error"
        ? "Нет критериев с весом — итог не посчитается."
        : `Не ${formatDecimal(maxTotal)}: итог всё равно приводится к ${formatDecimal(maxTotal)}, доля критерия = вес / ${formatDecimal(sum)}.`;
    return h("div", { className: "cqa-ed-total", dataset: { state } },
      h("p", { className: "cqa-ed-total__head" },
        h("span", { className: "cqa-ed-total__label", text: "Сумма весов" }),
        h("span", { className: "cqa-ed-total__value cqa-num", text: formatDecimal(sum) }),
        h("span", { className: "cqa-ed-total__max", text: `из ${formatDecimal(maxTotal)}` })),
      h("div", { className: "cqa-ed-total__bar", attrs: { role: "img", "aria-label": `Веса критериев: ${scored.map((c) => `${criterionLabel(current, c.id)} — ${formatDecimal(toNumber(c.weight))}`).join(", ")}` } },
        scored.map((c, i) => h("span", {
          className: `cqa-ed-total__seg cqa-cat-${(sectionIndex(c.id) % 5) + 1}`,
          attrs: { title: `${criterionLabel(current, c.id)} ${c.title} — ${formatDecimal(toNumber(c.weight))}` },
          vars: { "--cqa-w": (toNumber(c.weight) / scale).toFixed(5), "--cqa-i": i },
        })),
        h("span", { className: "cqa-ed-total__mark", vars: { "--cqa-at": (maxTotal / scale).toFixed(5) } })),
      h("p", { className: "cqa-ed-total__note", attrs: { role: state === "ok" ? null : "status" }, text: note }));
  }

  function sectionIndex(criterionId) {
    return Math.max(0, current.sections.findIndex((s) => s.criteria.includes(criterionId)));
  }

  function sectionBlock(section, index) {
    const title = h("input", {
      className: "cqa-a-input cqa-ed-section__title",
      attrs: { type: "text", value: section.title, "data-key": `${section.id}:title`, maxlength: 120, autocomplete: "off" },
    });
    title.addEventListener("input", () => commit(renameSection(current, section.id, title.value), { structural: false }));
    title.addEventListener("change", () => api.touch(`section:${section.id}:title`));
    const handle = field({ label: `Секция ${index + 1}`, control: title, className: "cqa-ed-section__field" });
    fields.set(`section:${section.id}:title`, handle);
    const empty = h("p", { className: "cqa-ed-section__empty", text: "Секция пустая. Добавьте критерий или перенесите сюда существующий через поле «Секция» в его карточке." });
    const criteria = section.criteria.map((id) => findCriterion(current, id)).filter(Boolean);
    const isLast = index === current.sections.length - 1;
    return h("section", { className: "cqa-ed-section", dataset: { section: section.id }, attrs: { "aria-label": `Секция ${index + 1}: ${section.title}` } },
      h("div", { className: "cqa-ed-section__head" },
        handle.el,
        h("p", { className: "cqa-ed-section__meta", dataset: { sectionMeta: section.id }, text: sectionMeta(section) }),
        h("div", { className: "cqa-ed-section__tools" },
          iconButton({ label: "Переместить секцию выше", iconName: "up", disabled: index === 0, attrs: { "data-key": `${section.id}:up` },
            onClick: () => api.restructure(moveSection(current, section.id, -1), `${section.id}:up`) }),
          iconButton({ label: "Переместить секцию ниже", iconName: "down", disabled: isLast, attrs: { "data-key": `${section.id}:down` },
            onClick: () => api.restructure(moveSection(current, section.id, 1), `${section.id}:down`) }),
          iconButton({
            label: criteria.length ? "Удалить можно только пустую секцию — сначала перенесите критерии" : "Удалить секцию",
            iconName: "trash", disabled: criteria.length > 0, className: "cqa-a-icon-btn--danger", attrs: { "data-key": `${section.id}:remove` },
            onClick: () => api.restructure(removeSection(current, section.id), "add-section"),
          }))),
      criteria.length ? h("ol", { className: "cqa-ed-list" }, criteria.map((c) => criterionCard(c, api))) : empty,
      h("button", {
        className: "cqa-ed-add",
        attrs: { type: "button", "data-key": `${section.id}:add` },
        on: { click: () => {
          const result = addCriterion(current, section.id, { reservedIds });
          api.restructure(result.doc, `${result.id}:title`, result.id);
        } },
      }, adminIcon("plus", { size: 20 }), `Добавить критерий в «${section.title.trim() || `секцию ${index + 1}`}»`));
  }

  function sectionMeta(section) {
    const criteria = section.criteria.map((id) => findCriterion(current, id)).filter(Boolean);
    const scored = criteria.filter((c) => c.scored && !c.critical);
    const weight = scored.reduce((sum, c) => sum + (Number.isFinite(toNumber(c.weight)) ? toNumber(c.weight) : 0), 0);
    const count = `${criteria.length} ${criteria.length === 1 ? "критерий" : criteria.length > 1 && criteria.length < 5 ? "критерия" : "критериев"}`;
    return scored.length ? `${count} · вес ${formatDecimal(weight)}` : `${count} · без баллов`;
  }

  function addSectionButton() {
    return h("button", {
      className: "cqa-ed-add cqa-ed-add--section",
      attrs: { type: "button", "data-key": "add-section" },
      on: { click: () => {
        const result = addSection(current);
        api.restructure(result.doc, `${result.id}:title`);
      } },
    }, adminIcon("plus", { size: 20 }), "Добавить секцию");
  }

  /* ---------- ошибки и фокус ---------- */

  function applyIssues() {
    for (const handle of fields.values()) handle.setError("");
    const perCard = new Map();
    for (const issue of issues) {
      const key = `${issue.scope}:${issue.targetId}:${issue.field}`;
      if (issue.scope === "criterion") {
        const entry = perCard.get(issue.targetId) ?? { errors: 0, warnings: 0 };
        perCard.set(issue.targetId, issue.level === "error" ? { ...entry, errors: entry.errors + 1 } : { ...entry, warnings: entry.warnings + 1 });
      }
      const visible = issue.level === "warning" || showAll || touched.has(key);
      if (visible) fields.get(key)?.setError(issue.message, issue.level);
    }
    for (const card of root.querySelectorAll(".cqa-ed-crit")) {
      const entry = perCard.get(card.dataset.criterion) ?? { errors: 0, warnings: 0 };
      setCardIssues(card, entry.errors, entry.warnings);
    }
  }

  function restoreFocus(key) {
    const target = root.querySelector(`[data-key="${cssEscape(key)}"]`);
    const [criterionId] = key.split(":");
    const fallback = root.querySelector(`[data-key="${cssEscape(`${criterionId}:toggle`)}"]`) ?? root.querySelector('[data-key="add-section"]');
    const element = target && !target.disabled ? target : fallback;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
  }

  return {
    el: root,
    getDoc: () => current,
    canUndo: () => undoStack.length > 0,
    undo() {
      if (!undoStack.length) return;
      current = undoStack.at(-1);
      undoStack = undoStack.slice(0, -1);
      recomputeMarks();
      render();
      onChange(current, { structural: true });
    },
    /** @param {import("./validate.js").Issue[]} next */
    setIssues(next) {
      issues = next;
      applyIssues();
    },
    /** После попытки сохранить показываем все ошибки, а не только у тронутых полей. */
    revealAll() {
      showAll = true;
      applyIssues();
    },
    /** Раскрывает карточку и ставит фокус на поле с ошибкой. */
    focusIssue(issue) {
      if (issue.scope === "criterion") expanded.add(issue.targetId);
      render();
      const key = issue.scope === "doc" ? `doc:${issue.field === "title" ? "title" : "toggle-all"}` : `${issue.targetId}:${issue.field === "id" ? "toggle" : issue.field}`;
      restoreFocus(issue.scope === "criterion" && issue.field === "scale" ? `${issue.targetId}:scale.add` : key);
    },
  };
}

function cssEscape(value) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
