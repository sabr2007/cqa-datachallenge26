// «Точность оценки»: совпадение ответов системы с эталоном (eval/gold.json) по критериям, языкам,
// отложенным и настроечным чатам, путаница N/A ↔ «Нет», сравнение моделей, где именно расходимся.

import { h } from "../dom.js";
import { buildHash, paths } from "../router.js";
import { barList, panelSection, statTile } from "./charts.js";
import { LANGUAGE_NAMES, SET_NAMES, answerLabel, formatPercent } from "./labels.js";
import { badge, linkButton } from "./ui.js";

const MISMATCH_LIMIT = 12;
const SMALL_SAMPLE = 10;

/**
 * @param {object} accuracy ответ /api/metrics/accuracy (admin/api.js getAccuracy)
 * @param {{ groupId: string, titles: Map<string, string> }} context
 */
export function accuracyPanel(accuracy, { groupId, titles }) {
  if (accuracy.goldCount === 0) {
    return h("div", { className: "cqa-a-alert", attrs: { role: "status" } },
      h("p", { text: `Для набора ${groupId} нет ручной разметки — точность считается только на размеченном наборе DEV.` }),
      linkButton({ label: "Открыть аналитику DEV", href: buildHash("/insights", { g: "DEV" }), variant: "white sm" }));
  }
  if (accuracy.evaluatedCount === 0 || !accuracy.overall || accuracy.overall.total === 0) {
    return h("div", { className: "cqa-a-alert", attrs: { role: "status" } },
      h("p", { text: `Размеченных диалогов ${accuracy.goldCount}, но ни один ещё не оценён. Оцените набор ${groupId} — здесь появится точность по каждому критерию.` }),
      linkButton({ label: `К диалогам ${groupId}`, href: buildHash(paths.conversations, { g: groupId }), variant: "white sm" }));
  }
  const confusionTotal = accuracy.naConfusion.naAsNo + accuracy.naConfusion.noAsNa;
  const reference = accuracy.expertAgreement?.accuracy != null
    ? { share: accuracy.expertAgreement.accuracy, label: `Согласие двух экспертов между собой — ${formatPercent(accuracy.expertAgreement.accuracy)}: ориентир, выше которого точность модели не ждём` }
    : null;
  const smallSample = accuracy.evaluatedCount < SMALL_SAMPLE;
  return h("div", { className: "cqa-in-panel" },
    smallSample ? h("p", { className: "cqa-a-alert", attrs: { role: "note" },
      text: `Мало данных: оценено ${accuracy.evaluatedCount} из ${accuracy.goldCount} размеченных диалогов — точность ориентировочная. Оцените весь набор ${groupId}, чтобы цифрам можно было доверять.` }) : null,
    h("dl", { className: "cqa-in-tiles" },
      statTile({ label: "Совпадение с эталоном", value: formatPercent(accuracy.overall.accuracy), sub: `${accuracy.overall.matched} из ${accuracy.overall.total} ответов по критериям`, hero: true }),
      statTile({ label: SET_NAMES.holdout, value: formatPercent(accuracy.bySet.holdout?.accuracy), sub: "не использовались при настройке промптов" }),
      statTile({ label: SET_NAMES.tuning, value: formatPercent(accuracy.bySet.tuning?.accuracy), sub: "на них настраивались правила" }),
      statTile({ label: "Путаница N/A ↔ «Нет»", value: String(confusionTotal), sub: `эталон N/A → система «Нет»: ${accuracy.naConfusion.naAsNo}; наоборот: ${accuracy.naConfusion.noAsNa}`, tone: confusionTotal ? "warn" : "good" }),
      statTile({ label: "Покрытие разметки", value: `${accuracy.evaluatedCount} из ${accuracy.goldCount}`, sub: "размеченных диалогов оценено" })),
    panelSection({
      title: "По критериям",
      lead: "Доля ответов системы, совпавших с эталоном. В скобках — отдельно отложенные и настроечные чаты.",
      children: barList({
        caption: "Точность по критериям",
        reference,
        rows: accuracy.byCriterion.map((r) => ({
          key: r.criterionId,
          num: shortId(r.criterionId),
          label: titles.get(r.criterionId) || r.title || r.criterionId,
          share: r.accuracy,
          value: formatPercent(r.accuracy),
          detail: `${r.matched}/${r.total} · отл. ${formatPercent(r.holdout?.accuracy)} · наст. ${formatPercent(r.tuning?.accuracy)}`,
        })),
      }),
    }),
    h("div", { className: "cqa-in-split" },
      panelSection({
        title: "По языкам",
        lead: "Один чек-лист для RU, KZ и EN — проверяем, что точность не проседает на казахском и английском.",
        children: barList({
          caption: "Точность по языкам",
          rows: accuracy.byLanguage.map((r) => ({ key: r.language, label: LANGUAGE_NAMES[r.language] ?? r.language, share: r.accuracy, value: formatPercent(r.accuracy), detail: `${r.matched}/${r.total}` })),
        }),
      }),
      confusionSection(accuracy, titles)),
    accuracy.byModel.length > 1 ? panelSection({
      title: "Модели",
      lead: "Точность голосов каждой модели по отдельности (итоговый ответ — голосование).",
      children: barList({
        caption: "Точность по моделям",
        rows: [...accuracy.byModel].sort((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0))
          .map((r) => ({ key: r.model, label: r.model, share: r.accuracy, value: formatPercent(r.accuracy), detail: `${r.matched}/${r.total}` })),
      }),
    }) : null,
    mismatchSection(accuracy, groupId, titles));
}

function confusionSection(accuracy, titles) {
  const rows = accuracy.naConfusion.byCriterion.filter((r) => r.naAsNo + r.noAsNa > 0);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.naAsNo, r.noAsNa)));
  const cell = (value) => h("td", { className: "cqa-num" },
    h("span", { className: "cqa-in-count", vars: { "--cqa-share": (value / max).toFixed(4) } }, h("span", { className: "cqa-in-count__bar", attrs: { "aria-hidden": "true" } }), String(value)));
  return panelSection({
    title: "N/A ↔ «Нет»",
    lead: "Самая дорогая ошибка: критерий неприменим, а система поставила «Нет», или наоборот.",
    children: rows.length
      ? h("table", { className: "cqa-in-table" },
        h("caption", { className: "cqa-sr-only", text: "Путаница N/A и «Нет» по критериям" }),
        h("thead", {}, h("tr", {},
          h("th", { attrs: { scope: "col" }, text: "Критерий" }),
          h("th", { attrs: { scope: "col" }, text: "N/A → «Нет»" }),
          h("th", { attrs: { scope: "col" }, text: "«Нет» → N/A" }))),
        h("tbody", {}, rows.map((r) => h("tr", {},
          h("th", { attrs: { scope: "row" } }, h("span", { className: "cqa-in-bars__num", text: shortId(r.criterionId) }), titles.get(r.criterionId) || r.criterionId),
          cell(r.naAsNo), cell(r.noAsNa)))))
      : h("p", { className: "cqa-in-good", text: "Путаницы N/A и «Нет» нет." }),
  });
}

function mismatchSection(accuracy, groupId, titles) {
  const withMismatch = accuracy.conversations.filter((c) => c.mismatches.length > 0)
    .sort((a, b) => b.mismatches.length - a.mismatches.length || a.conversationId.localeCompare(b.conversationId));
  if (!withMismatch.length) return null;
  const list = h("ul", { className: "cqa-in-mismatch" });
  const renderItems = (limit) => list.replaceChildren(...withMismatch.slice(0, limit).map((c) => h("li", { className: "cqa-in-mismatch__item" },
    h("p", { className: "cqa-in-mismatch__head" },
      h("a", { className: "cqa-in-link", attrs: { href: buildHash(paths.conversation(c.conversationId), { g: groupId }) }, text: c.conversationId }),
      badge(c.set === "holdout" ? "отложенный" : "настроечный", c.set === "holdout" ? "changed" : "muted"),
      h("span", { className: "cqa-muted", text: `${c.language} · совпало ${c.matched} из ${c.total}` })),
    h("ul", { className: "cqa-in-mismatch__chips" }, c.mismatches.map((m) => h("li", { className: "cqa-in-chip", attrs: { title: titles.get(m.criterionId) || m.criterionId } },
      h("span", { className: "cqa-in-chip__num", text: shortId(m.criterionId) }),
      `эталон ${answerLabel(m.gold)} · система ${answerLabel(m.system)}`))))));
  renderItems(MISMATCH_LIMIT);
  const more = withMismatch.length > MISMATCH_LIMIT
    ? h("button", {
      className: "cqa-btn cqa-btn--gray cqa-btn--sm", attrs: { type: "button" },
      on: { click: (event) => { renderItems(withMismatch.length); event.currentTarget.remove(); } },
    }, `Показать все ${withMismatch.length}`)
    : null;
  return panelSection({
    title: "Где расходимся с эталоном",
    lead: "Диалоги с несовпадениями — откройте, чтобы сравнить обоснование системы с решением эксперта.",
    children: [list, more],
  });
}

function shortId(id) {
  const match = /(\d+)$/.exec(id);
  return match ? match[1].padStart(2, "0") : id;
}
