// Таблица диалогов: плотные строки с разделителями 1 px (ритм FAQ референса).
// Строка кликабельна целиком; для клавиатуры и скринридеров — обычная ссылка в первой ячейке.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { FORMS, SPEAKERS, channelName, formatDuration, formatInt, formatPoints, languageName, plural, speakerName } from "../format.js";
import { effectiveTotal } from "../evaluation.js";
import { isHosted, openRoute } from "../host.js";
import { buildHash, paths } from "../router.js";
import { statusPill } from "../components/ui.js";

const COLUMNS = Object.freeze([
  { key: "id", label: "Диалог", sortable: true },
  { key: "messages", label: "Реплики", sortable: true },
  { key: "duration", label: "Длительность", sortable: true },
  { key: "preview", label: "Первая реплика клиента" },
  { key: "score", label: "Итог", sortable: true, className: "status" },
]);

/**
 * @param {ReadonlyArray<object>} items
 * @param {{ groupId: string, sort: string, dir: "asc" | "desc", onSort: (key: string) => void,
 *   jobState?: (id: string) => "running" | "queued" | "error" | "done" | "cancelled" | null }} options
 */
export function conversationTable(items, { groupId, sort, dir, onSort, jobState = () => null, latestVersion = null }) {
  return h("table", { className: "cqa-table", attrs: { role: "table" } },
    h("caption", { className: "cqa-sr-only", text: `Диалоги набора. Строка открывает ${isHosted() ? "обращение этого диалога" : "карточку диалога"}.` }),
    h("thead", { attrs: { role: "rowgroup" } },
      h("tr", { attrs: { role: "row" } }, COLUMNS.map((column) => headerCell(column, { sort, dir, onSort })))),
    h("tbody", { attrs: { role: "rowgroup" }, on: { click: onRowClick } },
      items.map((item) => row(item, groupId, jobState(item.id), latestVersion))));
}

function headerCell(column, { sort, dir, onSort }) {
  const active = column.sortable && sort === column.key;
  const ariaSort = active ? (dir === "asc" ? "ascending" : "descending") : column.sortable ? "none" : null;
  const content = column.sortable
    ? h("button", { className: "cqa-sort cqa-hl", attrs: { type: "button" }, on: { click: () => onSort(column.key) } },
      column.label, icon(active ? (dir === "asc" ? "sortAsc" : "sortDesc") : "sort", { size: 16, className: "cqa-sort__icon" }))
    : column.label;
  return h("th", { className: `cqa-th cqa-col-${column.className ?? column.key}`, attrs: { scope: "col", role: "columnheader", "aria-sort": ariaSort } }, content);
}

function row(item, groupId, state, latestVersion) {
  const href = buildHash(paths.conversation(item.id), { g: groupId });
  const isCall = item.channel === "call";
  return h("tr", { className: "cqa-row", attrs: { role: "row", "data-href": href } },
    h("th", { className: "cqa-td cqa-col-id", attrs: { scope: "row", role: "rowheader" } },
      h("a", { className: "cqa-row__link", attrs: { href }, text: item.id }),
      h("span", { className: "cqa-row__meta" },
        icon(isCall ? "phone" : "chat", { size: 15 }),
        h("span", { text: channelName(item.channel) }),
        h("span", { attrs: { "aria-hidden": "true" }, text: "·" }),
        h("abbr", { attrs: { title: languageName(item.language) }, text: item.language || "—" }))),
    h("td", { className: "cqa-td cqa-col-messages", attrs: { role: "cell" } }, messagesCell(item)),
    h("td", { className: "cqa-td cqa-col-duration cqa-num", attrs: { role: "cell" } }, durationCell(item)),
    h("td", { className: "cqa-td cqa-col-preview", attrs: { role: "cell" } },
      item.preview
        ? h("p", { className: "cqa-row__preview", text: item.preview })
        : h("p", { className: "cqa-row__preview cqa-row__preview--empty", text: "Клиент не писал" }),
      criticalNote(item.evaluation)),
    h("td", { className: "cqa-td cqa-col-status", attrs: { role: "cell" } }, statusCell(item.evaluation, state), versionNote(item.evaluation, latestVersion)));
}

/** Оценка сделана по прежней версии чек-листа — подсказка переоценить. */
function versionNote(evaluation, latestVersion) {
  const version = evaluation?.checklistVersion;
  if (typeof version !== "number" || typeof latestVersion !== "number" || version >= latestVersion) return null;
  return h("span", { className: "cqa-row__version", attrs: { title: `Чек-лист обновлён до версии ${latestVersion} — переоцените диалог` },
    text: `по чек-листу v${version}` });
}

/** Итог (с пересчётом после апелляции «было → стало»), статусы и ход оценки; без оценки — «Не оценено». */
function statusCell(evaluation, state) {
  const progress = progressPill(state);
  if (!evaluation) {
    return progress ?? statusPill("pending", "Не оценено", "Оценка ещё не запускалась — откройте диалог или запустите пакетную оценку");
  }
  const total = effectiveTotal(evaluation);
  const changed = typeof evaluation.total === "number" && typeof evaluation.finalTotal === "number" && evaluation.total !== evaluation.finalTotal;
  const score = total !== null
    ? h("span", { className: "cqa-row__score", attrs: { title: changed ? `Исходно ${formatPoints(evaluation.total)}, после апелляции ${formatPoints(total)}` : null } },
      changed ? h("s", { className: "cqa-row__was", text: formatPoints(evaluation.total) }) : null,
      changed ? h("span", { className: "cqa-sr-only", text: " изменён на " }) : null,
      formatPoints(total), h("span", { className: "cqa-row__score-max", text: " / 100" }))
    : statusPill("done", "Оценено", "Итог не считается: нет применимых критериев с весом");
  const badges = [
    progress,
    evaluation.needsReview ? statusPill("review", "Нужна проверка", "Модели разошлись или цитата не подтвердилась") : null,
    evaluation.appealStatus === "open" ? statusPill("appeal", "Апелляция", "Ждёт решения проверяющего") : null,
    evaluation.appealStatus === "resolved" ? statusPill("done", "Апелляция решена") : null,
  ].filter(Boolean);
  return [score, badges.length ? h("span", { className: "cqa-row__badges" }, badges) : null];
}

function progressPill(state) {
  if (state === "running") {
    return h("span", { className: "cqa-status cqa-status--running" },
      h("span", { className: "cqa-spinner cqa-spinner--xs", attrs: { "aria-hidden": "true" } }), "Оценивается…");
  }
  if (state === "queued") return statusPill("pending", "В очереди");
  if (state === "error") return statusPill("error", "Ошибка оценки", "Оценка не выполнена — повторите из сводки пакета или в карточке");
  return null;
}

/** Бейдж грубой ошибки с коротким объяснением прямо в списке (критерий 08). */
function criticalNote(evaluation) {
  if (!evaluation?.critical) return null;
  return h("p", { className: "cqa-row__critical" },
    statusPill("error", "Грубая ошибка"),
    evaluation.criticalNote ? h("span", { className: "cqa-row__critical-text", attrs: { title: evaluation.criticalNote }, text: evaluation.criticalNote }) : null);
}

function messagesCell(item) {
  const parts = SPEAKERS.map((speaker) => `${speakerName(speaker)} ${item.counts[speaker] ?? 0}`);
  return [
    h("span", { className: "cqa-row__count cqa-num", text: formatInt(item.messageCount) }),
    h("span", { className: "cqa-row__unit", text: ` ${plural(item.messageCount, FORMS.message)}` }),
    h("span", { className: "cqa-minibar", attrs: { title: parts.join(" · "), "aria-hidden": "true" } },
      SPEAKERS.filter((speaker) => (item.counts[speaker] ?? 0) > 0).map((speaker) =>
        h("span", { className: `cqa-minibar__seg cqa-role-${speaker}`, vars: { "--cqa-w": item.counts[speaker] } }))),
    h("span", { className: "cqa-sr-only", text: `: ${parts.join(", ")}` }),
  ];
}

function durationCell(item) {
  const value = item.durationSec === null ? "—" : formatDuration(item.durationSec);
  const withAudio = item.channel === "call" && item.hasAudio;
  return h("span", {
    className: `cqa-row__time${withAudio ? " cqa-row__time--audio" : ""}`,
    attrs: { title: withAudio ? "Длительность, есть запись звонка" : "Длительность по меткам времени" },
  },
  icon(withAudio ? "headphones" : "clock", { size: 15 }), value,
  withAudio ? h("span", { className: "cqa-sr-only", text: ", есть запись" }) : null);
}

function onRowClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest("a, button, input, abbr")) return;
  if (window.getSelection()?.toString()) return; // пользователь выделяет текст
  const tr = target.closest("tr[data-href]");
  if (tr) openRoute(tr.getAttribute("data-href")); // в Dynamics — форма обращения (host.js)
}
