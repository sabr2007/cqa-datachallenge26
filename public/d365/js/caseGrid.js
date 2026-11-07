// Представление «Активные обращения»: системный список записей с колонкой «Оценка качества».
// Итог CQA хранится в записи обращения (в Dynamics его пишет интеграция, в макете — из листинга API),
// поэтому виден прямо в стандартном представлении. Строка открывает форму записи, для клавиатуры —
// ссылка в первой ячейке.

import { h } from "../../js/dom.js";
import { channelName, formatInt, languageName } from "../../js/format.js";
import { evaluationText } from "./tabs.js";

const TITLE_ID = "d365-view-title";
const APPEAL_LABELS = Object.freeze({ open: "Открыта", resolved: "Решена" });
const COLUMNS = Object.freeze([
  { key: "id", label: "Номер обращения" },
  { key: "title", label: "Тема" },
  { key: "channel", label: "Канал" },
  { key: "lang", label: "Язык" },
  { key: "count", label: "Реплик" },
  { key: "score", label: "Оценка качества" },
  { key: "appeal", label: "Апелляция" },
]);

/**
 * @param {{ hrefFor: (conversationId: string) => string, onOpen: (conversationId: string) => void }} options
 * @returns {{ el: HTMLElement, update: (view: { status: string, records: ReadonlyArray<object>, error: string }) => void, focus: () => void }}
 */
export function createCaseGrid({ hrefFor, onOpen }) {
  const heading = h("h1", { className: "d365-view__title", attrs: { id: TITLE_ID, tabindex: "-1" }, text: "Активные обращения" });
  const sub = h("p", { className: "d365-view__sub", attrs: { "aria-live": "polite" } });
  const body = h("tbody");
  const table = h("table", { className: "d365-grid" },
    h("caption", { className: "d365-sr-only", text: "Активные обращения. Строка открывает форму записи." }),
    h("thead", {}, h("tr", {}, COLUMNS.map(({ key, label }) =>
      h("th", { className: `d365-grid__th d365-grid__col-${key}`, attrs: { scope: "col" }, text: label })))),
    body);
  const state = h("div", { className: "d365-grid__state" });
  const el = h("section", { className: "d365-view d365-view--grid", attrs: { "aria-labelledby": TITLE_ID } },
    h("header", { className: "d365-view__head" }, heading, sub),
    h("div", { className: "d365-grid__wrap" }, table, state));

  body.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest("a[data-record]");
    if (link) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // новая вкладка
      event.preventDefault();
      onOpen(link.dataset.record);
      return;
    }
    if (!target || window.getSelection()?.toString()) return; // пользователь выделяет текст
    const row = target.closest("tr[data-record]");
    if (row) onOpen(row.dataset.record);
  });

  return {
    el,
    update({ status, records, error }) {
      if (status !== "ready") {
        body.replaceChildren();
        sub.textContent = "Обращение · представление системы";
        state.replaceChildren(h("p", {
          className: status === "error" ? "d365-error" : "d365-loading",
          attrs: { role: status === "error" ? "alert" : "status" },
          text: status === "error" ? `Записи не загрузились: ${error}` : "Загружаем записи…",
        }));
        return;
      }
      state.replaceChildren();
      const evaluated = records.filter((record) => record.evaluation).length;
      sub.textContent = `Обращение · представление системы · ${formatInt(records.length)} записей, с оценкой качества ${formatInt(evaluated)}`;
      body.replaceChildren(...records.map((record) => row(record, hrefFor(record.conversationId))));
    },
    focus() {
      heading.focus({ preventScroll: true });
    },
  };
}

function row(record, href) {
  const evaluation = record.evaluation;
  return h("tr", { className: "d365-grid__row", dataset: { record: record.conversationId } },
    h("th", { className: "d365-grid__cell", attrs: { scope: "row" } },
      h("a", { className: "d365-grid__link d365-num", attrs: { href }, dataset: { record: record.conversationId }, text: record.conversationId })),
    h("td", { className: "d365-grid__cell d365-grid__title", attrs: { title: record.title }, text: record.title }),
    h("td", { className: "d365-grid__cell", text: channelName(record.channel) }),
    h("td", { className: "d365-grid__cell", text: languageName(record.language) }),
    h("td", { className: "d365-grid__cell d365-num", text: formatInt(record.messageCount) }),
    h("td", { className: `d365-grid__cell d365-num${evaluation?.critical ? " d365-danger" : ""}`, text: evaluationText(evaluation) }),
    h("td", { className: "d365-grid__cell", text: APPEAL_LABELS[evaluation?.appealStatus] ?? "—" }));
}
