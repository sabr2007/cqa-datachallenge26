// История версий чек-листа и сравнение «vA → vB»: что добавлено, изменено и удалено.

import { h } from "../dom.js";
import { plural } from "../format.js";
import { adminIcon } from "./icons.js";
import { formatDateTime, versionLabel } from "./labels.js";
import { badge, nextId } from "./ui.js";

/**
 * Лента версий (новые сверху). Активная версия отмечена; у каждой — «Открыть» и «Сравнить с предыдущей».
 * @param {{ versions: import("./api.js").VersionInfo[], latest: number | null, active: number | null,
 *   onOpen: (version: number) => void, onCompare: (from: number, to: number) => void }} options
 */
export function versionTimeline({ versions, latest, active, onOpen, onCompare }) {
  if (!versions.length) return h("p", { className: "cqa-a-empty-line", text: "Версий пока нет." });
  return h("ol", { className: "cqa-vt" }, versions.map((v, i) => {
    const previous = versions.slice(i + 1).find((other) => other.version < v.version && !other.sandbox);
    const isActive = v.version === active;
    return h("li", { className: "cqa-vt__item", dataset: { active: String(isActive), sandbox: String(v.sandbox) } },
      h("span", { className: "cqa-vt__dot", attrs: { "aria-hidden": "true" } }),
      h("div", { className: "cqa-vt__main" },
        h("p", { className: "cqa-vt__head" },
          h("span", { className: "cqa-vt__version cqa-num", text: versionLabel(v.version) }),
          v.version === latest ? badge("действующая", "new") : null,
          v.sandbox ? badge("песочница", "sandbox", "Черновик из песочницы — не используется для оценки по умолчанию") : null,
          h("span", { className: "cqa-vt__date", text: formatDateTime(v.createdAt) })),
        h("p", { className: "cqa-vt__note", text: v.note || (v.version === 1 ? "Исходный чек-лист кейса" : "Без заметки") }),
        h("div", { className: "cqa-vt__actions" },
          h("button", {
            className: "cqa-vt__btn", attrs: { type: "button", "aria-current": isActive ? "true" : null, disabled: isActive },
            on: { click: () => onOpen(v.version) },
          }, isActive ? "Открыта" : "Открыть"),
          previous ? h("button", {
            className: "cqa-vt__btn", attrs: { type: "button" },
            on: { click: () => onCompare(previous.version, v.version) },
          }, adminIcon("compare", { size: 16 }), `Что изменилось с ${versionLabel(previous.version)}`) : null)));
  }));
}

/**
 * Выбор пары версий для сравнения.
 * @param {{ versions: import("./api.js").VersionInfo[], from: number, to: number, onChange: (from: number, to: number) => void }} options
 */
export function comparePicker({ versions, from, to, onChange }) {
  const fromId = nextId("cqa-cmp-from");
  const toId = nextId("cqa-cmp-to");
  const options = (selected) => versions.map((v) => h("option", { attrs: { value: v.version, selected: v.version === selected }, text: `${versionLabel(v.version)}${v.sandbox ? " · песочница" : ""}${v.note ? ` · ${v.note.slice(0, 40)}` : ""}` }));
  const fromSelect = h("select", { className: "cqa-a-input cqa-a-select", attrs: { id: fromId } }, options(from));
  const toSelect = h("select", { className: "cqa-a-input cqa-a-select", attrs: { id: toId } }, options(to));
  const emit = () => onChange(Number(fromSelect.value), Number(toSelect.value));
  fromSelect.addEventListener("change", emit);
  toSelect.addEventListener("change", emit);
  return h("div", { className: "cqa-cmp" },
    h("div", { className: "cqa-a-field" }, h("label", { className: "cqa-a-field__label", attrs: { for: fromId }, text: "Было" }), fromSelect),
    h("span", { className: "cqa-cmp__arrow", attrs: { "aria-hidden": "true" } }, adminIcon("arrowRight", { size: 20 })),
    h("div", { className: "cqa-a-field" }, h("label", { className: "cqa-a-field__label", attrs: { for: toId }, text: "Стало" }), toSelect));
}

/**
 * Сравнение двух версий: сводка и карточки изменений.
 * @param {import("./diff.js").ChecklistDiff} diff @param {{ from: string, to: string }} labels
 */
export function diffView(diff, { from, to }) {
  const headingId = nextId("cqa-diff-title");
  if (diff.isEmpty) {
    return h("section", { className: "cqa-diff", attrs: { "aria-labelledby": headingId } },
      h("h3", { className: "cqa-diff__title", attrs: { id: headingId }, text: `${from} → ${to}` }),
      h("p", { className: "cqa-a-empty-line", text: "Версии совпадают: критерии, веса и правила одинаковые." }));
  }
  const summary = [
    diff.added.length ? badge(`+${diff.added.length} ${plural(diff.added.length, ["новый", "новых", "новых"])}`, "new") : null,
    diff.changed.length ? badge(`${diff.changed.length} ${plural(diff.changed.length, ["изменён", "изменены", "изменены"])}`, "changed") : null,
    diff.removed.length ? badge(`−${diff.removed.length} ${plural(diff.removed.length, ["удалён", "удалены", "удалены"])}`, "removed") : null,
    diff.sections.length ? badge("секции", "changed") : null,
    diff.reordered ? badge("порядок", "muted") : null,
  ];
  return h("section", { className: "cqa-diff", attrs: { "aria-labelledby": headingId } },
    h("div", { className: "cqa-diff__head" },
      h("h3", { className: "cqa-diff__title", attrs: { id: headingId }, text: `${from} → ${to}` }),
      h("div", { className: "cqa-diff__summary" }, summary)),
    diff.title ? fieldChange({ label: "Название чек-листа", before: diff.title.before, after: diff.title.after, long: false }) : null,
    h("ul", { className: "cqa-diff__list" },
      diff.added.map((c) => entry("new", "Добавлен", c, c.details ?? [])),
      diff.changed.map((c) => entry("changed", "Изменён", c, c.changes)),
      diff.removed.map((c) => entry("removed", "Удалён", c, []))),
    diff.sections.length ? h("ul", { className: "cqa-diff__sections" }, diff.sections.map(sectionLine)) : null,
    diff.reordered ? h("p", { className: "cqa-diff__note", text: "Изменён порядок критериев." }) : null,
    diff.rules.length ? h("div", { className: "cqa-diff__rules" }, h("p", { className: "cqa-diff__note", text: "Правила расчёта:" }), diff.rules.map(fieldChange)) : null);
}

function entry(tone, verb, criterion, changes) {
  return h("li", { className: `cqa-diff__item cqa-diff__item--${tone}` },
    h("p", { className: "cqa-diff__item-head" },
      h("span", { className: "cqa-diff__verb", text: verb }),
      h("span", { className: "cqa-diff__num cqa-num", text: criterion.num }),
      h("span", { className: "cqa-diff__name", text: criterion.title }),
      criterion.section ? h("span", { className: "cqa-diff__section", text: criterion.section }) : null),
    changes.length ? h("div", { className: "cqa-diff__changes" }, changes.map(fieldChange)) : null);
}

function fieldChange(change) {
  if (change.added) {
    return h("div", { className: "cqa-diff__change cqa-diff__change--long" },
      h("span", { className: "cqa-diff__field", text: change.label }),
      h("span", { className: "cqa-diff__value", text: change.after }));
  }
  return h("div", { className: `cqa-diff__change${change.long ? " cqa-diff__change--long" : ""}` },
    h("span", { className: "cqa-diff__field", text: change.label }),
    h("del", { className: "cqa-diff__before", text: change.before }),
    h("span", { className: "cqa-diff__to", attrs: { "aria-hidden": "true" }, text: "→" }),
    h("ins", { className: "cqa-diff__after", text: change.after }));
}

function sectionLine(change) {
  const text = change.kind === "added"
    ? `Добавлена секция «${change.after}»`
    : change.kind === "removed"
      ? `Удалена секция «${change.before}»`
      : `Секция «${change.before}» переименована в «${change.after}»`;
  return h("li", { className: "cqa-diff__note", text });
}

