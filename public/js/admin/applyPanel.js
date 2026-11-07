// «Применить к набору»: переоценка диалогов текущего набора по выбранной версии чек-листа
// (POST /api/evaluations с reuse_previous — неизменённые критерии берутся из прошлой оценки),
// параллельно 2–3 запроса, прогресс, отмена, затем таблица «диалог · итог до → после · какие критерии изменились».
// Сам прогон живёт в applyRuns.js и переживает уход с экрана; панель только показывает его.

import { isAbortError } from "../api.js";
import { h } from "../dom.js";
import { FORMS, plural } from "../format.js";
import { buildHash, paths } from "../router.js";
import { loadingNote, statusPill } from "../components/ui.js";
import { exportUrl, fetchGroupConversations } from "./api.js";
import { getRun, runKey, startRun, subscribe } from "./applyRuns.js";
import { summarizeComparisons } from "./compare.js";
import { answerLabel, answerTone, formatEta, formatScore, versionLabel } from "./labels.js";
import { DEFAULT_CONCURRENCY, countResults } from "./runner.js";
import { actionButton, deltaChip, linkButton, liveRegion, nextId, setChildren } from "./ui.js";

const CONCURRENCY_OPTIONS = Object.freeze([2, 3]);

/**
 * @param {{ groupId: string, checklistId: string, versions: import("./api.js").VersionInfo[], latest: number | null,
 *   initialVersion?: number | null, signal: AbortSignal }} options
 */
export function createApplyPanel({ groupId, checklistId, versions, latest, initialVersion = null, signal }) {
  const key = runKey(groupId, checklistId);
  const regular = versions.filter((v) => !v.sandbox);
  let version = getRun(key)?.version ?? initialVersion ?? latest ?? regular[0]?.version ?? null;
  let listing = null;
  let listingError = "";
  let listingNote = null;
  let scope = "evaluated";
  let skipCurrent = true;
  let concurrency = DEFAULT_CONCURRENCY;
  const live = liveRegion();
  const headingId = nextId("cqa-ap-title");
  const setup = h("div", { className: "cqa-ap__setup" });
  const progress = h("div", { className: "cqa-ap__progress", attrs: { hidden: true } });
  const summary = h("div", { className: "cqa-ap__summary", attrs: { hidden: true } });
  const table = h("div", { className: "cqa-ap__table-wrap" });
  const el = h("section", { className: "cqa-ap", attrs: { "aria-labelledby": headingId } },
    h("div", { className: "cqa-ap__head" },
      h("h2", { className: "cqa-h3", attrs: { id: headingId }, text: `Переоценка набора ${groupId}` }),
      h("p", { className: "cqa-body-l", text: "Диалоги набора оцениваются заново по выбранной версии чек-листа. Неизменённые критерии берутся из прошлой оценки, модель вызывается только для новых и изменённых — поэтому быстро и дёшево." })),
    setup, progress, summary, table, live.el);

  const unsubscribe = subscribe(key, onRunUpdate);
  loadListing();
  const existing = getRun(key);
  if (existing) {
    renderProgress(existing);
    renderTable(existing);
    if (existing.finished) renderSummary(existing);
  }

  async function loadListing() {
    listing = null;
    listingError = "";
    listingNote?.stop();
    listingNote = loadingNote(`Загружаем диалоги набора ${groupId}…`);
    renderSetup();
    try {
      listing = await fetchGroupConversations(groupId, { signal });
    } catch (error) {
      if (isAbortError(error)) return;
      listingError = error.message;
    } finally {
      listingNote?.stop();
    }
    renderSetup();
  }

  function candidates() {
    if (!listing) return [];
    const pool = scope === "all" ? listing.items : listing.items.filter((item) => item.evaluation);
    return skipCurrent ? pool.filter((item) => item.evaluation?.checklistVersion !== version) : pool;
  }

  function running() {
    const run = getRun(key);
    return Boolean(run && !run.finished);
  }

  /* ---------- настройка ---------- */

  function renderSetup() {
    if (listingError) {
      setChildren(setup, h("div", { className: "cqa-a-alert cqa-a-alert--error", attrs: { role: "alert" } },
        h("p", { text: `Не удалось загрузить диалоги набора ${groupId}: ${listingError}` }),
        actionButton({ label: "Повторить", variant: "gray sm", iconName: "refresh", onClick: loadListing })));
      return;
    }
    if (!listing) {
      setChildren(setup, listingNote?.el);
      return;
    }
    const busy = running();
    const evaluated = listing.items.filter((item) => item.evaluation).length;
    const items = candidates();
    const versionId = nextId("cqa-ap-version");
    const versionSelect = h("select", { className: "cqa-a-input cqa-a-select", attrs: { id: versionId, disabled: busy } },
      regular.map((v) => h("option", { attrs: { value: v.version, selected: v.version === version }, text: `${versionLabel(v.version)}${v.version === latest ? " · действующая" : ""}${v.note ? ` · ${v.note.slice(0, 48)}` : ""}` })));
    versionSelect.addEventListener("change", () => { version = Number(versionSelect.value); renderSetup(); });

    const scopeName = nextId("cqa-ap-scope");
    const scopeOption = (value, label, countValue) => {
      const input = h("input", { attrs: { type: "radio", name: scopeName, value, checked: scope === value, disabled: busy } });
      input.addEventListener("change", () => { if (input.checked) { scope = value; renderSetup(); } });
      return h("label", { className: "cqa-ed-radio" }, input, h("span", { className: "cqa-ed-radio__label" }, label, h("span", { className: "cqa-seg__count", text: ` ${countValue}` })));
    };
    const skip = h("input", { attrs: { type: "checkbox", checked: skipCurrent, disabled: busy } });
    skip.addEventListener("change", () => { skipCurrent = skip.checked; renderSetup(); });
    const concurrencyId = nextId("cqa-ap-conc");
    const concurrencySelect = h("select", { className: "cqa-a-input cqa-a-select cqa-ap__conc", attrs: { id: concurrencyId, disabled: busy } },
      CONCURRENCY_OPTIONS.map((n) => h("option", { attrs: { value: n, selected: n === concurrency }, text: `${n} одновременно` })));
    concurrencySelect.addEventListener("change", () => { concurrency = Number(concurrencySelect.value); });

    const blocked = !items.length || busy || version === null;
    const start = actionButton({
      label: busy ? "Идёт переоценка…" : items.length ? `Переоценить ${items.length} ${plural(items.length, FORMS.dialog)} по ${versionLabel(version)}` : "Нечего переоценивать",
      iconName: "play", variant: "dark", attrs: { "aria-disabled": String(blocked), "data-key": "ap:start" },
      onClick: () => { if (!blocked) begin(items); },
    });
    setChildren(setup,
      h("div", { className: "cqa-ap__grid" },
        h("div", { className: "cqa-a-field" }, h("label", { className: "cqa-a-field__label", attrs: { for: versionId }, text: "Версия чек-листа" }), versionSelect),
        h("fieldset", { className: "cqa-ed-fieldset" },
          h("legend", { className: "cqa-a-field__label", text: "Какие диалоги" }),
          h("div", { className: "cqa-ed-radios" },
            scopeOption("evaluated", "Уже оценённые", evaluated),
            scopeOption("all", "Все диалоги набора", listing.items.length))),
        h("div", { className: "cqa-a-field" }, h("label", { className: "cqa-a-field__label", attrs: { for: concurrencyId }, text: "Параллельно" }), concurrencySelect)),
      h("label", { className: "cqa-check cqa-ap__skip" }, skip, h("span", { text: `Пропустить диалоги, уже оценённые по ${versionLabel(version)}` })),
      evaluated === 0 && scope === "evaluated"
        ? h("p", { className: "cqa-a-alert", text: `В наборе ${groupId} ещё нет оценённых диалогов. Выберите «Все диалоги набора», чтобы оценить их впервые.` })
        : null,
      h("div", { className: "cqa-ap__actions" }, start));
  }

  /* ---------- прогон ---------- */

  function begin(items) {
    const run = startRun({ groupId, checklistId, version, items, concurrency });
    summary.hidden = true;
    renderSetup();
    renderProgress(run);
    renderTable(run);
    live.say(`Запущена переоценка ${items.length} ${plural(items.length, FORMS.dialog)}.`);
  }

  function onRunUpdate(run, { index }) {
    renderProgress(run);
    if (index !== null) updateRow(run, index);
    if (run.finished) {
      renderSetup();
      renderSummary(run);
      const counts = countResults(run.results);
      live.say(run.cancelled ? `Остановлено: переоценено ${counts.done} из ${counts.total}.` : `Готово: переоценено ${counts.done} из ${counts.total}${counts.error ? `, ошибок ${counts.error}` : ""}.`);
      fetchGroupConversations(groupId, { signal }).then((fresh) => { listing = fresh; renderSetup(); }).catch(() => {});
    }
  }

  function renderProgress(run) {
    const counts = countResults(run.results);
    const finished = counts.done + counts.error + counts.cancelled;
    const share = counts.total ? finished / counts.total : 0;
    const avg = run.durations.length ? run.durations.reduce((s, d) => s + d, 0) / run.durations.length : null;
    const remaining = counts.queued + counts.running;
    const eta = avg && remaining ? formatEta((avg * remaining) / Math.max(1, run.concurrency) / 1000) : "";
    progress.hidden = false;
    setChildren(progress,
      h("div", { className: "cqa-ap__progress-head" },
        h("p", { className: "cqa-ap__progress-count" },
          h("strong", { className: "cqa-num", text: `${counts.done}` }), ` из ${counts.total} переоценено по ${versionLabel(run.version)}`,
          counts.error ? h("span", { className: "cqa-ap__progress-err", text: ` · ошибок ${counts.error}` }) : null,
          counts.cancelled ? h("span", { text: ` · отменено ${counts.cancelled}` }) : null,
          !run.finished && eta ? h("span", { className: "cqa-ap__progress-eta", text: ` · осталось ≈ ${eta}` }) : null),
        run.finished
          ? null
          : actionButton({ label: "Остановить", iconName: "stop", variant: "gray sm", attrs: { "data-key": "ap:stop" }, onClick: () => getRun(key)?.cancel() })),
      h("div", {
        className: `cqa-ap__bar${run.finished ? " is-finished" : ""}`,
        attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(counts.total), "aria-valuenow": String(finished), "aria-label": "Прогресс переоценки" },
        vars: { "--cqa-share": share.toFixed(4) },
      }, h("span", { className: "cqa-ap__bar-fill" })),
      run.finished ? null : h("p", { className: "cqa-a-hint", text: "Можно открыть диалог из таблицы — переоценка продолжится, прогресс сохранится на этой вкладке." }));
  }

  function renderSummary(run) {
    const comparisons = run.results.filter((r) => r.status === "done").map((r) => r.value.comparison);
    const stats = summarizeComparisons(comparisons);
    const counts = countResults(run.results);
    const failed = run.items.filter((_, i) => run.results[i].status === "error" || run.results[i].status === "cancelled");
    summary.hidden = false;
    setChildren(summary,
      h("dl", { className: "cqa-ap__kpis" },
        kpi("Переоценено", `${counts.done} из ${counts.total}`),
        kpi("Итог изменился", `${stats.changedTotals}`),
        kpi("Средний итог", `${formatScore(stats.meanBefore)} → ${formatScore(stats.meanAfter)}`),
        kpi("Грубые ошибки", `${stats.criticalBefore} → ${stats.criticalAfter}`)),
      h("div", { className: "cqa-ap__actions" },
        linkButton({ label: "Скачать CSV", href: exportUrl(groupId, "csv"), iconName: "download", attrs: { download: `cqa-${groupId}.csv` } }),
        linkButton({ label: "JSON", href: exportUrl(groupId, "json"), iconName: "download", attrs: { download: `cqa-${groupId}.json` } }),
        linkButton({ label: "К списку диалогов", href: buildHash(paths.conversations, { g: groupId }), iconName: "list" }),
        failed.length ? actionButton({ label: `Повторить ${failed.length}`, variant: "gray sm", iconName: "refresh", onClick: () => { version = run.version; begin(failed); } }) : null));
  }

  function kpi(label, value) {
    return h("div", { className: "cqa-ap__kpi" }, h("dt", { text: label }), h("dd", { className: "cqa-num", text: value }));
  }

  /* ---------- таблица ---------- */

  function renderTable(run) {
    setChildren(table, h("table", { className: "cqa-ap__table" },
      h("caption", { className: "cqa-sr-only", text: "Результаты переоценки" }),
      h("thead", {}, h("tr", {},
        h("th", { attrs: { scope: "col" }, text: "Диалог" }),
        h("th", { attrs: { scope: "col" }, text: "Итог до → после" }),
        h("th", { attrs: { scope: "col" }, text: "Изменились критерии" }),
        h("th", { attrs: { scope: "col" }, text: "Статус" }))),
      h("tbody", {}, run.items.map((item, i) => rowFor(item, run.results[i], i)))));
  }

  function updateRow(run, index) {
    const row = table.querySelector(`tr[data-index="${index}"]`);
    if (row) row.replaceWith(rowFor(run.items[index], run.results[index], index));
    else renderTable(run);
  }

  function rowFor(item, result, index) {
    const comparison = result.status === "done" ? result.value.comparison : null;
    return h("tr", { className: "cqa-ap__row", dataset: { index: String(index), status: result.status } },
      h("td", {},
        h("a", { className: "cqa-ap__id", attrs: { href: buildHash(paths.conversation(item.id), { g: groupId }) }, text: item.id }),
        h("span", { className: "cqa-ap__lang", text: item.language })),
      h("td", { className: "cqa-num" }, comparison ? totalsCell(comparison) : h("span", { className: "cqa-muted", text: formatScore(item.evaluation?.finalTotal ?? null) })),
      h("td", {}, comparison ? changesCell(comparison) : null),
      h("td", {}, statusCell(result)));
  }

  function totalsCell(c) {
    if (c.before === null) return h("span", {}, h("span", { className: "cqa-ap__after", text: formatScore(c.after) }), h("span", { className: "cqa-ap__first", text: " впервые" }));
    return h("span", { className: "cqa-ap__totals" },
      h("span", { className: "cqa-ap__before", text: formatScore(c.before) }),
      h("span", { attrs: { "aria-hidden": "true" }, text: " → " }),
      h("span", { className: "cqa-ap__after", text: formatScore(c.after) }),
      deltaChip(c.delta));
  }

  function changesCell(c) {
    if (c.before === null && c.criticalBefore === null) return h("span", { className: "cqa-muted", text: "первая оценка" });
    if (!c.changes.length) return h("span", { className: "cqa-muted", text: "ответы те же" });
    return h("ul", { className: "cqa-ap__changes" }, c.changes.map((ch) => h("li", {
      className: `cqa-ap__change cqa-ap__change--${ch.kind}`,
      attrs: { title: ch.title },
    },
    h("span", { className: "cqa-ap__change-num", text: shortId(ch.criterionId) }),
    ch.kind === "added" ? h("span", { text: "новый: " }) : null,
    ch.kind === "removed" ? h("span", { text: "удалён" }) : null,
    ch.kind === "changed" ? h("span", { className: `cqa-ap__ans cqa-ap__ans--${answerTone(ch.before, { critical: ch.critical })}`, text: answerLabel(ch.before) }) : null,
    ch.kind === "changed" ? h("span", { attrs: { "aria-hidden": "true" }, text: "→" }) : null,
    ch.kind !== "removed" ? h("span", { className: `cqa-ap__ans cqa-ap__ans--${answerTone(ch.after, { critical: ch.critical })}`, text: answerLabel(ch.after) }) : null)));
  }

  function statusCell(result) {
    if (result.status === "queued") return statusPill("pending", "В очереди");
    if (result.status === "running") return h("span", { className: "cqa-ap__running" }, h("span", { className: "cqa-spinner", attrs: { "aria-hidden": "true" } }), "Оценивается");
    if (result.status === "done") return statusPill(result.value.next.needsReview ? "review" : "done", result.value.next.needsReview ? "Нужна проверка" : "Готово");
    if (result.status === "cancelled") return statusPill("pending", "Отменено");
    const message = result.error?.message ?? "Ошибка";
    return h("span", { className: "cqa-ap__error" }, statusPill("error", "Ошибка", message), h("span", { className: "cqa-ap__error-text", text: message }));
  }

  return {
    el,
    /** Выбрать версию (например, только что сохранённую) — без запуска. */
    setVersion(next) {
      if (running()) return;
      version = next;
      renderSetup();
    },
    focusStart: () => setup.querySelector('[data-key="ap:start"]')?.focus(),
    /** Уход с экрана: панель отписывается, прогон продолжается. */
    detach() {
      unsubscribe();
      listingNote?.stop();
    },
  };
}

function shortId(id) {
  const match = /(\d+)$/.exec(id);
  return match ? match[1].padStart(2, "0") : id;
}
