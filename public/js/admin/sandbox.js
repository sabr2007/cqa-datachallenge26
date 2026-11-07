// Песочница критерия: черновик сохраняется версией с пометкой «песочница» (не становится действующей),
// размеченные диалоги DEV переоцениваются с purpose: "sandbox" (не попадают в результаты и экспорт),
// затем показывается, как изменилась точность против эталона по каждому критерию.

import { isAbortError } from "../api.js";
import { h } from "../dom.js";
import { buildHash, paths } from "../router.js";
import { evaluateConversation, getAccuracy, saveChecklistVersion } from "./api.js";
import { diffChecklists, summarizeDiff, touchedCriteria } from "./diff.js";
import { adminIcon } from "./icons.js";
import { SET_NAMES, answerLabel, formatPercent, versionLabel } from "./labels.js";
import { criterionLabel, toPayload } from "./model.js";
import { countResults, runQueue } from "./runner.js";
import { actionButton, badge, deltaChip, liveRegion, meter, nextId, setChildren } from "./ui.js";

const GOLD_GROUP = "DEV";
const SANDBOX_CONCURRENCY = 3;

/**
 * @param {{ host: HTMLElement, checklistId: string, draft: import("./model.js").DraftDoc, baseDoc: object,
 *   onPromote: () => void, onVersionsChanged: () => void }} options
 */
export function openSandbox({ host, checklistId, draft, baseDoc, onPromote, onVersionsChanged }) {
  const controller = new AbortController();
  const titleId = nextId("cqa-sb-title");
  const diff = diffChecklists(baseDoc, draft);
  const touched = touchedCriteria(diff);
  const live = liveRegion();
  const body = h("div", { className: "cqa-sb__body" });
  let baseline = null;
  let scope = "all";
  let queue = null;
  let running = false;

  const close = () => {
    if (running) {
      body.querySelector('[data-key="sb:stop"]')?.focus();
      return;
    }
    controller.abort();
    dialog.close();
  };
  const dialog = h("dialog", { className: "cqa-sb", attrs: { "aria-labelledby": titleId } },
    h("div", { className: "cqa-sb__head" },
      h("p", { className: "cqa-eyebrow" }, adminIcon("flask", { size: 16 }), "Песочница"),
      h("h2", { className: "cqa-h3", attrs: { id: titleId }, text: "Проверка черновика на размеченных диалогах" }),
      h("button", { className: "cqa-a-icon-btn cqa-sb__close", attrs: { type: "button", "aria-label": "Закрыть песочницу" }, on: { click: close } },
        adminIcon("close", { size: 20 }))),
    body, live.el);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    controller.abort();
    dialog.remove();
  });
  host.append(dialog);
  dialog.showModal();
  loadBaseline();

  async function loadBaseline() {
    setChildren(body, loading("Загружаем текущую точность и список размеченных диалогов…"));
    try {
      baseline = await getAccuracy({ groupId: GOLD_GROUP }, { signal: controller.signal });
      renderIntro();
    } catch (error) {
      if (isAbortError(error)) return;
      renderError(`Не удалось получить метрики точности: ${error.message}`, loadBaseline);
    }
  }

  function pool() {
    const withBaseline = baseline.conversations.filter((c) => c.evaluationId);
    return scope === "all" ? withBaseline : withBaseline.filter((c) => c.set === scope);
  }

  function renderIntro() {
    const withBaseline = baseline.conversations.filter((c) => c.evaluationId);
    const items = pool();
    const name = nextId("cqa-sb-scope");
    const option = (value, label) => {
      const countValue = value === "all" ? withBaseline.length : withBaseline.filter((c) => c.set === value).length;
      const input = h("input", { attrs: { type: "radio", name, value, checked: scope === value, disabled: countValue === 0 } });
      input.addEventListener("change", () => { if (input.checked) { scope = value; renderIntro(); } });
      return h("label", { className: "cqa-ed-radio" }, input, h("span", { className: "cqa-ed-radio__label" }, label, h("span", { className: "cqa-seg__count", text: ` ${countValue}` })));
    };
    const touchedList = [...diff.added, ...diff.changed];
    setChildren(body,
      h("p", { className: "cqa-body-l", text: "Черновик сохранится версией с пометкой «песочница» — она не станет действующей. Размеченные диалоги переоценятся по ней: неизменённые критерии возьмутся из прошлой оценки, модель вызовется только для изменённых. Эти оценки не попадут в результаты, аналитику и экспорт." }),
      h("div", { className: "cqa-sb__touched" },
        h("p", { className: "cqa-a-field__label", text: "Что проверяем" }),
        touchedList.length
          ? h("ul", { className: "cqa-sb__chips" }, touchedList.map((c) => h("li", {}, badge(`${c.num} ${c.title}`, diff.added.includes(c) ? "new" : "changed"))))
          : h("p", { className: "cqa-muted", text: "Критерии не менялись — точность останется прежней." }),
        diff.removed.length ? h("p", { className: "cqa-muted", text: `Удалены: ${diff.removed.map((c) => `${c.num} ${c.title}`).join(", ")}.` }) : null),
      withBaseline.length
        ? h("fieldset", { className: "cqa-ed-fieldset" },
          h("legend", { className: "cqa-a-field__label", text: `Размеченные диалоги ${GOLD_GROUP} с базовой оценкой` }),
          h("div", { className: "cqa-ed-radios" }, option("all", "Все"), option("holdout", SET_NAMES.holdout), option("tuning", SET_NAMES.tuning)))
        : h("p", { className: "cqa-a-alert", text: `Размеченные диалоги ${GOLD_GROUP} ещё не оценены — не с чем сравнивать. Сначала оцените набор ${GOLD_GROUP}, затем вернитесь в песочницу.` }),
      h("div", { className: "cqa-sb__actions" },
        actionButton({
          label: items.length ? `Сохранить черновик и прогнать ${items.length}` : "Нет диалогов для прогона",
          iconName: "play", attrs: { "aria-disabled": String(!items.length), "data-key": "sb:start" },
          onClick: () => { if (items.length) start(items); },
        }),
        actionButton({ label: "Отмена", variant: "gray", onClick: close })));
    body.querySelector('[data-key="sb:start"]')?.focus();
  }

  async function start(items) {
    running = true;
    setChildren(body, loading("Сохраняем черновик версией песочницы…"));
    let version;
    try {
      const note = `Песочница: ${summarizeDiff(diff) || "без изменений критериев"}`;
      const saved = await saveChecklistVersion(checklistId, toPayload(draft, { note, sandbox: true }), { signal: controller.signal });
      version = saved.version;
      if (!Number.isInteger(version)) throw new Error("бэкенд не вернул номер версии");
      onVersionsChanged();
    } catch (error) {
      running = false;
      if (isAbortError(error)) return;
      renderError(`Не удалось сохранить черновик: ${error.message}`, renderIntro);
      return;
    }
    const progress = h("div", { className: "cqa-ap__progress" });
    const update = (results) => {
      const counts = countResults(results);
      const finished = counts.done + counts.error + counts.cancelled;
      setChildren(progress,
        h("div", { className: "cqa-ap__progress-head" },
          h("p", { className: "cqa-ap__progress-count" }, h("strong", { className: "cqa-num", text: String(counts.done) }), ` из ${counts.total} переоценено по ${versionLabel(version)}`,
            counts.error ? h("span", { className: "cqa-ap__progress-err", text: ` · ошибок ${counts.error}` }) : null),
          actionButton({ label: "Остановить", iconName: "stop", variant: "gray sm", attrs: { "data-key": "sb:stop" }, onClick: () => queue?.cancel() })),
        h("div", { className: "cqa-ap__bar", attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(counts.total), "aria-valuenow": String(finished), "aria-label": "Прогресс прогона" }, vars: { "--cqa-share": (counts.total ? finished / counts.total : 0).toFixed(4) } },
          h("span", { className: "cqa-ap__bar-fill" })));
    };
    setChildren(body, h("p", { className: "cqa-body-l", text: `Черновик сохранён как ${versionLabel(version)} (песочница). Прогоняем размеченные диалоги…` }), progress);
    let results = items.map(() => ({ status: "queued" }));
    update(results);
    live.say(`Прогон ${items.length} диалогов начат.`);
    queue = runQueue(items, (item, { signal }) => evaluateConversation({
      groupId: GOLD_GROUP, conversationId: item.conversationId, checklistId, checklistVersion: version, reusePrevious: true, purpose: "sandbox",
    }, { signal }), {
      concurrency: SANDBOX_CONCURRENCY,
      signal: controller.signal,
      onUpdate: ({ index, result }) => {
        results = results.map((r, i) => (i === index ? result : r));
        update(results);
      },
    });
    const { cancelled } = await queue.done;
    running = false;
    if (controller.signal.aborted) return;
    setChildren(body, loading("Считаем точность новой версии…"));
    try {
      const after = await getAccuracy({ groupId: GOLD_GROUP, checklistId, checklistVersion: version }, { signal: controller.signal });
      renderResult(version, after, countResults(results), cancelled);
    } catch (error) {
      if (isAbortError(error)) return;
      renderError(`Прогон завершён, но метрики не загрузились: ${error.message}`, () => start(items));
    }
  }

  function renderResult(version, after, counts, cancelled) {
    const beforeById = new Map(baseline.byCriterion.map((r) => [r.criterionId, r]));
    const afterById = new Map(after.byCriterion.map((r) => [r.criterionId, r]));
    const rows = draft.criteria.map((c) => ({ id: c.id, num: criterionLabel(draft, c.id), title: c.title, before: beforeById.get(c.id) ?? null, after: afterById.get(c.id) ?? null }));
    const mismatches = after.conversations.flatMap((conv) => conv.mismatches.filter((m) => touched.has(m.criterionId)).map((m) => ({ ...m, conversationId: conv.conversationId, language: conv.language })));
    live.say("Прогон завершён, точность посчитана.");
    setChildren(body,
      h("p", { className: "cqa-body-l", text: `${cancelled ? "Прогон остановлен" : "Прогон завершён"}: ${counts.done} из ${counts.total} диалогов переоценены по ${versionLabel(version)}${counts.error ? `, ошибок ${counts.error}` : ""}.` }),
      h("dl", { className: "cqa-ap__kpis" },
        kpi("Точность всего", baseline.overall, after.overall),
        kpi(SET_NAMES.holdout, baseline.bySet.holdout, after.bySet.holdout)),
      h("table", { className: "cqa-sb__table" },
        h("caption", { className: "cqa-sr-only", text: "Точность по критериям: до и после" }),
        h("thead", {}, h("tr", {},
          h("th", { attrs: { scope: "col" }, text: "Критерий" }),
          h("th", { attrs: { scope: "col" }, text: "Сейчас" }),
          h("th", { attrs: { scope: "col" }, text: `С ${versionLabel(version)}` }),
          h("th", { attrs: { scope: "col" }, text: "Разница" }))),
        h("tbody", {}, rows.map((row) => h("tr", { dataset: { touched: String(touched.has(row.id)) } },
          h("th", { attrs: { scope: "row" } }, h("span", { className: "cqa-sb__num cqa-num", text: row.num }), row.title,
            touched.has(row.id) ? badge(diff.added.some((c) => c.id === row.id) ? "новый" : "изменён", diff.added.some((c) => c.id === row.id) ? "new" : "changed") : null),
          h("td", {}, rateCell(row.before)),
          h("td", {}, row.after ? rateCell(row.after) : h("span", { className: "cqa-muted", text: "нет эталона" })),
          h("td", {}, row.before?.accuracy != null && row.after?.accuracy != null ? deltaChip(Math.round((row.after.accuracy - row.before.accuracy) * 100), { suffix: " п. п." }) : null))))),
      mismatches.length ? h("div", { className: "cqa-sb__mismatch" },
        h("p", { className: "cqa-a-field__label", text: "Где изменённые критерии расходятся с эталоном" }),
        h("ul", {}, mismatches.slice(0, 12).map((m) => h("li", {},
          h("a", { attrs: { href: buildHash(paths.conversation(m.conversationId), { g: GOLD_GROUP }) }, text: m.conversationId }),
          ` · ${m.criterionId}: эталон ${answerLabel(m.gold)}, система ${answerLabel(m.system)}`)))) : null,
      h("div", { className: "cqa-sb__actions" },
        actionButton({ label: "Сохранить как действующую версию", iconName: "check", onClick: () => { dialog.close(); onPromote(); } }),
        actionButton({ label: "Вернуться к правке", variant: "gray", onClick: () => dialog.close() })));
  }

  function kpi(label, before, after) {
    const delta = before?.accuracy != null && after?.accuracy != null ? Math.round((after.accuracy - before.accuracy) * 100) : null;
    return h("div", { className: "cqa-ap__kpi" },
      h("dt", { text: label }),
      h("dd", { className: "cqa-num" }, `${formatPercent(before?.accuracy)} → ${formatPercent(after?.accuracy)} `, deltaChip(delta, { suffix: " п. п." })));
  }

  function rateCell(rate) {
    if (!rate || rate.accuracy === null) return h("span", { className: "cqa-muted", text: "—" });
    return h("span", { className: "cqa-sb__rate" },
      meter(rate.accuracy),
      h("span", { className: "cqa-num", text: `${formatPercent(rate.accuracy)} · ${rate.matched}/${rate.total}` }));
  }

  function renderError(message, retry) {
    setChildren(body, h("div", { className: "cqa-a-alert cqa-a-alert--error", attrs: { role: "alert" } },
      h("p", { text: message }),
      h("div", { className: "cqa-sb__actions" },
        actionButton({ label: "Повторить", variant: "gray sm", iconName: "refresh", onClick: retry }),
        actionButton({ label: "Закрыть", variant: "gray sm", onClick: close }))));
  }

  function loading(text) {
    return h("p", { className: "cqa-loading-note", attrs: { role: "status" } }, h("span", { className: "cqa-spinner", attrs: { "aria-hidden": "true" } }), text);
  }
}
