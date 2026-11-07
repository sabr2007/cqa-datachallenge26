// Пакетная оценка набора: выбор диалогов (неоценённые / отфильтрованные / все / по старой версии
// чек-листа), параллельность 2–3, модели, прогресс по факту готовых оценок, остановка и сводка.
// Сам пакет живёт в evalJobs — переход в карточку диалога его не прерывает.

import { h, setChildren } from "../dom.js";
import { icon } from "../icons.js";
import { FORMS, countLabel, formatCost, formatDurationLong, formatInt, formatPoints } from "../format.js";
import { BATCH_CONCURRENCY, batchStats, cancelBatch, clearBatch, getBatch, startBatch, subscribeBatch } from "./evalJobs.js";
import { modelPicker, selectedModels } from "./modelPicker.js";
import { button } from "./ui.js";

const AVG_EVAL_SEC = 60;
const SCOPES = Object.freeze([
  { value: "pending", label: "Неоценённые" },
  { value: "filtered", label: "Отфильтрованные" },
  { value: "all", label: "Все в наборе" },
  { value: "outdated", label: "Оценённые по старой версии чек-листа" },
]);

/**
 * @param {{ groupId: string, onFilter: (patch: object) => void }} options
 * @returns {{ el: HTMLElement, update: (context: { scopes: Record<string, string[]>, latestVersion: number | null }) => void,
 *   isOpen: () => boolean, open: () => void, dispose: () => void }}
 */
export function batchPanel({ groupId, onFilter }) {
  const el = h("section", { className: "cqa-batch", attrs: { "aria-labelledby": "cqa-batch-title", hidden: true } });
  const picker = modelPicker({ compact: true });
  const state = { open: false, scope: "pending", concurrency: BATCH_CONCURRENCY[0], scopes: {}, latestVersion: null, ticker: 0 };
  const unsubscribe = subscribeBatch(() => render());

  function render() {
    window.clearInterval(state.ticker);
    const batch = ownBatch();
    el.hidden = !state.open && !batch;
    if (el.hidden) return;
    const focused = el.contains(document.activeElement) ? document.activeElement.className : "";
    el.classList.toggle("cqa-batch--running", batch?.status === "running");
    if (batch?.status === "running") setChildren(el, runningView(batch));
    else if (batch) setChildren(el, summaryView(batch));
    else setChildren(el, setupView());
    if (focused && batch) (el.querySelector(".cqa-batch__stop") ?? el.querySelector("#cqa-batch-title"))?.focus();
  }

  function ownBatch() {
    const batch = getBatch();
    return batch && batch.groupId === groupId ? batch : null;
  }

  /* ---------- настройка ---------- */

  function setupView() {
    const available = SCOPES.filter((scope) => scope.value !== "outdated" || (state.scopes.outdated?.length ?? 0) > 0);
    if (!available.some((scope) => scope.value === state.scope)) state.scope = "pending";
    const ids = state.scopes[state.scope] ?? [];
    const radios = available.map((scope) => {
      const count = state.scopes[scope.value]?.length ?? 0;
      const input = h("input", {
        attrs: { type: "radio", name: "cqa-batch-scope", value: scope.value, checked: scope.value === state.scope, disabled: count === 0 },
        on: { change: () => { state.scope = scope.value; render(); el.querySelector(`input[value="${scope.value}"]`)?.focus(); } },
      });
      return h("label", { className: `cqa-batch__option${count === 0 ? " is-off" : ""}` },
        input, h("span", { text: scope.label }), h("span", { className: "cqa-batch__count cqa-num", text: formatInt(count) }));
    });
    const concurrency = h("div", { className: "cqa-seg cqa-seg--sm", attrs: { role: "group", "aria-labelledby": "cqa-batch-par" } },
      BATCH_CONCURRENCY.map((value) => h("button", {
        className: "cqa-seg__btn cqa-hl",
        attrs: { type: "button", "aria-pressed": String(value === state.concurrency) },
        on: { click: () => { state.concurrency = value; render(); } },
      }, String(value))));
    const minutes = estimateMinutes(ids.length, state.concurrency);
    return [
      head("Пакетная оценка", closeButton()),
      h("div", { className: "cqa-batch__grid" },
        h("fieldset", { className: "cqa-batch__scopes" },
          h("legend", { className: "cqa-batch__label", text: "Какие диалоги оценить" }), radios),
        h("div", { className: "cqa-batch__side" },
          h("div", { className: "cqa-batch__row" },
            h("span", { className: "cqa-batch__label", attrs: { id: "cqa-batch-par" }, text: "Одновременно" }), concurrency),
          picker.el,
          h("p", { className: "cqa-batch__estimate", text: ids.length
            ? `${countLabel(ids.length, FORMS.dialog)} · примерно ${minutes} мин (оценка одного — 30–90 с)`
            : "Под выбранный вариант не подходит ни один диалог." }),
          state.scope === "outdated" && state.latestVersion !== null
            ? h("p", { className: "cqa-batch__estimate", text: `Переоценка по версии ${state.latestVersion}: неизменённые критерии берутся из прошлой оценки.` }) : null,
          button({
            label: ids.length ? `Оценить ${countLabel(ids.length, FORMS.dialog)}` : "Нечего оценивать",
            variant: "dark", iconName: "sparkle",
            attrs: ids.length ? {} : { "aria-disabled": "true" },
            onClick: () => start(ids),
          }))),
    ];
  }

  function start(ids) {
    if (!ids.length) return;
    const outdated = state.scope === "outdated";
    startBatch({
      groupId, ids, concurrency: state.concurrency, models: selectedModels(),
      checklistVersion: outdated && state.latestVersion !== null ? state.latestVersion : undefined,
      reusePrevious: outdated,
    });
    el.querySelector(".cqa-batch__stop")?.focus();
  }

  /* ---------- прогресс ---------- */

  function runningView(batch) {
    const stats = batchStats(batch);
    const elapsed = h("span", { className: "cqa-num", text: "" });
    const tick = () => { elapsed.textContent = clock((Date.now() - batch.startedAt) / 1000); };
    tick();
    state.ticker = window.setInterval(tick, 1000);
    const share = stats.total ? stats.finished / stats.total : 0;
    const eta = etaMinutes(batch, stats);
    return [
      head(`Пакетная оценка · ${formatInt(stats.finished)} из ${formatInt(stats.total)}`,
        h("span", { className: "cqa-batch__elapsed" }, icon("clock", { size: 16 }), elapsed),
        button({ label: "Остановить", variant: "gray sm", iconName: "stop", attrs: { class: "cqa-btn cqa-btn--gray cqa-btn--sm cqa-batch__stop" }, onClick: cancelBatch })),
      h("div", {
        className: "cqa-batch__track",
        attrs: { role: "progressbar", "aria-label": "Готово оценок", "aria-valuemin": 0, "aria-valuemax": stats.total, "aria-valuenow": stats.finished },
      }, h("span", { className: "cqa-batch__fill", vars: { "--cqa-p": share.toFixed(3) } })),
      h("p", { className: "cqa-batch__status", attrs: { "aria-live": "polite" } },
        `Готово ${formatInt(stats.done)}`,
        stats.failed ? h("span", { className: "cqa-batch__bad", text: ` · ${countLabel(stats.failed, FORMS.error)}` }) : null,
        ` · в очереди ${formatInt(stats.queued)}`,
        eta !== null ? ` · осталось ≈ ${eta} мин` : ""),
      stats.runningIds.length ? h("p", { className: "cqa-batch__now" },
        "Сейчас оцениваются: ", stats.runningIds.map((id, i) => [i ? ", " : "", h("span", { className: "cqa-num", text: id })])) : null,
      h("p", { className: "cqa-batch__hint", text: "Можно открывать диалоги — пакет продолжит работу. Остановка не отменяет уже начатые на сервере оценки." }),
    ];
  }

  /* ---------- сводка ---------- */

  function summaryView(batch) {
    const stats = batchStats(batch);
    const seconds = ((batch.finishedAt ?? Date.now()) - batch.startedAt) / 1000;
    const title = batch.status === "cancelled"
      ? `Пакет остановлен: оценено ${formatInt(stats.done)} из ${formatInt(stats.total)}`
      : `Пакет завершён: оценено ${formatInt(stats.done)} из ${formatInt(stats.total)}`;
    const items = [
      metric("Грубые ошибки", formatInt(stats.critical), stats.critical ? linkAction("Показать", () => onFilter({ status: "critical" })) : null, stats.critical ? "bad" : ""),
      metric("Нужна проверка", formatInt(stats.needsReview), stats.needsReview ? linkAction("Показать", () => onFilter({ status: "review" })) : null, stats.needsReview ? "warn" : ""),
      metric("Средний итог", stats.averageTotal === null ? "—" : formatPoints(stats.averageTotal)),
      metric("Стоимость", formatCost(stats.costUsd) || "—"),
      metric("Время", formatDurationLong(seconds) || "—"),
      metric("Ошибки", formatInt(stats.failed), stats.failed ? linkAction("Повторить", () => {
        startBatch({ groupId, ids: [...stats.failedIds], concurrency: batch.concurrency, models: selectedModels() });
      }) : null, stats.failed ? "bad" : ""),
    ];
    return [
      head(title, closeButton(() => clearBatch())),
      h("dl", { className: "cqa-batch__summary" }, items),
      stats.failed ? h("p", { className: "cqa-batch__hint", text: failedText(batch) }) : null,
    ];
  }

  function head(title, ...extra) {
    return h("div", { className: "cqa-batch__head" },
      h("h3", { className: "cqa-batch__title", attrs: { id: "cqa-batch-title", tabindex: "-1" }, text: title }), ...extra);
  }

  function closeButton(onClose) {
    return h("button", {
      className: "cqa-icon-btn cqa-icon-btn--ghost cqa-batch__close",
      attrs: { type: "button", "aria-label": "Закрыть панель пакетной оценки", title: "Закрыть" },
      on: { click: () => { onClose?.(); state.open = false; render(); document.querySelector(".cqa-batch-open")?.focus(); } },
    }, icon("close", { size: 16 }));
  }

  render();
  return {
    el,
    update({ scopes, latestVersion }) {
      state.scopes = scopes;
      state.latestVersion = latestVersion;
      if (!ownBatch() || getBatch()?.status !== "running") render();
    },
    isOpen: () => state.open || Boolean(ownBatch()),
    open() {
      state.open = true;
      render();
      el.querySelector("#cqa-batch-title")?.focus();
    },
    dispose() {
      window.clearInterval(state.ticker);
      unsubscribe();
    },
  };
}

function metric(term, value, action = null, tone = "") {
  return h("div", { className: `cqa-batch__metric${tone ? ` cqa-batch__metric--${tone}` : ""}` },
    h("dt", { text: term }), h("dd", {}, h("span", { className: "cqa-num", text: value }), action));
}

function linkAction(label, onClick) {
  return h("button", { className: "cqa-linkbtn", attrs: { type: "button" }, on: { click: onClick } }, label);
}

function failedText(batch) {
  const failed = [...batch.results.entries()].filter(([, r]) => r.state === "error");
  const sample = failed.slice(0, 3).map(([id, r]) => `${id}: ${r.error?.message ?? "ошибка"}`).join("; ");
  return `Не оценены: ${sample}${failed.length > 3 ? " …" : ""}`;
}

function estimateMinutes(count, concurrency) {
  return Math.max(1, Math.ceil((count * AVG_EVAL_SEC) / concurrency / 60));
}

function etaMinutes(batch, stats) {
  const finished = [...batch.results.values()].filter((r) => r.state === "done" && r.evaluation?.latencyMs);
  if (stats.finished === 0) return estimateMinutes(stats.total, batch.concurrency);
  const perItem = finished.length
    ? finished.reduce((sum, r) => sum + r.evaluation.latencyMs, 0) / finished.length / 1000
    : (Date.now() - batch.startedAt) / 1000 / Math.max(1, stats.finished) * batch.concurrency;
  const remaining = stats.queued + stats.running;
  return Math.max(1, Math.ceil((remaining * perItem) / batch.concurrency / 60));
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
