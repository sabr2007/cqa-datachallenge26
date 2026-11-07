// «Где ломается сценарий»: доля провалов по критериям, частые цитаты провалов со ссылкой на реплику,
// грубые ошибки, доля принятых апелляций и что подтянуть в скрипте (по формулировкам чек-листа).

import { h } from "../dom.js";
import { messageNumber } from "../format.js";
import { buildHash, paths } from "../router.js";
import { answerLegend, panelSection, partsBar, statTile } from "./charts.js";
import { formatPercent } from "./labels.js";
import { toDraft } from "./model.js";
import { badge, meter } from "./ui.js";

const RECOMMENDATIONS = 3;
const QUOTE_GROUPS = 3;
const QUOTES_PER_GROUP = 2;
const ANSWER_KEYS = Object.freeze([
  { key: "yes", label: "Выполнено («Да», верхняя ступень)" },
  { key: "na", label: "N/A — неприменим" },
  { key: "no", label: "Провал («Нет», ступень ниже верхней)" },
]);

/**
 * @param {object} analytics ответ /api/analytics (admin/api.js getAnalytics)
 * @param {{ groupId: string, checklist: object | null }} context
 */
export function scenarioPanel(analytics, { groupId, checklist }) {
  if (analytics.evaluatedCount === 0) {
    return h("div", { className: "cqa-a-alert", attrs: { role: "status" } },
      h("p", { text: `В наборе ${groupId} ещё нет оценённых диалогов — аналитика появится после первой оценки.` }),
      h("a", { className: "cqa-btn cqa-btn--white cqa-btn--sm", attrs: { href: buildHash(paths.conversations, { g: groupId }) }, text: `К диалогам ${groupId}` }));
  }
  const doc = checklist ? toDraft(checklist) : null;
  const criteria = analytics.criteria.map((c) => ({ ...c, def: doc?.criteria.find((d) => d.id === c.criterionId) ?? null }));
  const scored = criteria.filter((c) => !c.def?.critical && c.failRate !== null);
  const ranked = [...scored].sort((a, b) => (b.failRate ?? 0) - (a.failRate ?? 0));
  const worst = ranked[0] ?? null;
  const appealsRate = analytics.appeals.resolved ? analytics.appeals.accepted / analytics.appeals.resolved : null;

  return h("div", { className: "cqa-in-panel" },
    h("dl", { className: "cqa-in-tiles" },
      statTile({ label: "Оценено диалогов", value: String(analytics.evaluatedCount), sub: "последняя оценка каждого диалога", hero: true }),
      statTile({ label: "Чаще всего проваливается", value: worst ? `${formatPercent(worst.failRate)}` : "—", sub: worst ? `${shortId(worst.criterionId)} ${worst.title}` : "", tone: worst && worst.failRate >= 0.4 ? "bad" : worst && worst.failRate >= 0.2 ? "warn" : "good" }),
      statTile({ label: "Грубые ошибки", value: String(analytics.critical.length), sub: analytics.critical.length ? "диалогов с отметкой — разобрать в первую очередь" : "не найдено", tone: analytics.critical.length ? "bad" : "good" }),
      statTile({ label: "Апелляции приняты", value: appealsRate === null ? "—" : formatPercent(appealsRate), sub: `${analytics.appeals.accepted} из ${analytics.appeals.resolved} решённых · всего ${analytics.appeals.total}` })),
    recommendations(ranked.slice(0, RECOMMENDATIONS).filter((c) => (c.failRate ?? 0) > 0)),
    panelSection({
      title: "Доля провалов по критериям",
      lead: "«Нет» для Да/Нет и ступень ниже верхней для шкалы — среди диалогов, где критерий применим. Отсортировано по доле провалов.",
      children: [answerLegend(ANSWER_KEYS), failTable(ranked, criteria.filter((c) => c.def?.critical))],
    }),
    quotesSection(ranked, groupId),
    criticalSection(analytics.critical, groupId),
    appealsSection(criteria));
}

function recommendations(items) {
  if (!items.length) return null;
  return panelSection({
    title: "Что подтянуть в скрипте",
    lead: "Критерии с наибольшей долей провалов и то, что по чек-листу должен сделать оператор.",
    className: "cqa-in-recs",
    children: h("ol", { className: "cqa-in-recs__list" }, items.map((c) => h("li", { className: "cqa-in-rec" },
      h("p", { className: "cqa-in-rec__rate" }, h("span", { className: "cqa-in-rec__value", text: formatPercent(c.failRate) }), h("span", { text: " провалов" })),
      h("p", { className: "cqa-in-rec__title" }, h("span", { className: "cqa-in-bars__num", text: shortId(c.criterionId) }), c.title),
      h("p", { className: "cqa-in-rec__text", text: expectation(c) })))),
  });
}

/** Что ожидается от оператора — из формулировок чек-листа (условие «Да» или верхняя ступень шкалы). */
function expectation(c) {
  if (!c.def) return "Откройте чек-лист, чтобы увидеть условие критерия.";
  if (c.def.answerType === "scale") {
    const top = [...c.def.scale].sort((a, b) => Number(b.value) - Number(a.value))[0];
    return top ? `Нужно: ${top.label}` : "Нужно: верхняя ступень шкалы.";
  }
  return c.def.yes ? `Нужно: ${c.def.yes}` : "Нужно: выполнить условие «Да».";
}

function failTable(ranked, critical) {
  const rows = [...ranked, ...critical];
  return h("table", { className: "cqa-in-table cqa-in-fails" },
    h("caption", { className: "cqa-sr-only", text: "Распределение ответов и доля провалов по критериям" }),
    h("thead", {}, h("tr", {},
      h("th", { attrs: { scope: "col" }, text: "Критерий" }),
      h("th", { attrs: { scope: "col" }, text: "Ответы" }),
      h("th", { attrs: { scope: "col" }, text: "Провалы" }))),
    h("tbody", {}, rows.map((c) => {
      const parts = answerParts(c);
      const isCritical = c.def?.critical === true;
      return h("tr", {},
        h("th", { attrs: { scope: "row" } }, h("span", { className: "cqa-in-bars__num", text: shortId(c.criterionId) }), c.title,
          isCritical ? badge("грубая ошибка", "error") : null),
        h("td", { className: "cqa-in-fails__bar" }, partsBar(parts, { label: c.title }), h("span", { className: "cqa-in-fails__counts", text: countsText(c) })),
        h("td", { className: "cqa-num" },
          h("strong", { className: "cqa-in-fails__rate", text: isCritical ? String(c.failCount) : formatPercent(c.failRate) }),
          h("span", { className: "cqa-in-fails__of", text: isCritical ? ` из ${c.applicable}` : ` · ${c.failCount} из ${c.applicable}` })));
    })));
}

/** Части полосы: выполнено / N/A / провал. Для грубых ошибок «Да» — это провал. */
function answerParts(c) {
  const answers = c.answers;
  const na = answers.na ?? 0;
  if (c.def?.critical) return [{ key: "yes", label: "Нет нарушений", count: answers.no ?? 0 }, { key: "na", label: "N/A", count: na }, { key: "no", label: "Грубая ошибка", count: answers.yes ?? 0 }];
  if (c.answerType === "scale") {
    const steps = Object.keys(answers).filter((k) => k !== "na").map(Number).filter(Number.isFinite);
    const top = c.def ? Math.max(...c.def.scale.map((s) => Number(s.value)).filter(Number.isFinite)) : Math.max(...steps, 0);
    const full = steps.filter((v) => v >= top).reduce((s, v) => s + (answers[String(v)] ?? 0), 0);
    const below = steps.filter((v) => v < top).reduce((s, v) => s + (answers[String(v)] ?? 0), 0);
    return [{ key: "yes", label: `Верхняя ступень (${top})`, count: full }, { key: "na", label: "N/A", count: na }, { key: "no", label: "Ниже верхней", count: below }];
  }
  return [{ key: "yes", label: "Да", count: answers.yes ?? 0 }, { key: "na", label: "N/A", count: na }, { key: "no", label: "Нет", count: answers.no ?? 0 }];
}

function countsText(c) {
  if (c.answerType === "scale" && !c.def?.critical) {
    return Object.entries(c.answers).filter(([k, v]) => k !== "na" && v > 0).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, v]) => `${k}: ${v}`)
      .concat(c.answers.na ? [`N/A: ${c.answers.na}`] : []).join(" · ");
  }
  const label = { yes: "Да", no: "Нет", na: "N/A" };
  return ["yes", "no", "na"].filter((k) => c.answers[k]).map((k) => `${label[k]}: ${c.answers[k]}`).join(" · ");
}

function quotesSection(ranked, groupId) {
  const withQuotes = ranked.filter((c) => c.topQuotes.length > 0);
  if (!withQuotes.length) return null;
  const host = h("div", { className: "cqa-in-quotes" });
  const render = (groups, perGroup) => host.replaceChildren(...withQuotes.slice(0, groups).map((c) => quoteGroup(c, perGroup, groupId)));
  render(QUOTE_GROUPS, QUOTES_PER_GROUP);
  const hidden = withQuotes.length > QUOTE_GROUPS || withQuotes.some((c) => c.topQuotes.length > QUOTES_PER_GROUP);
  const more = hidden
    ? h("button", {
      className: "cqa-btn cqa-btn--gray cqa-btn--sm cqa-in-more", attrs: { type: "button" },
      on: { click: (event) => { render(withQuotes.length, Infinity); event.currentTarget.remove(); } },
    }, "Показать все цитаты")
    : null;
  return panelSection({
    title: "Частые цитаты провалов",
    lead: "Реплики-доказательства из обоснований провалов — ссылка открывает диалог на нужной реплике.",
    children: [host, more],
  });
}

function quoteGroup(c, limit, groupId) {
  return h("section", { className: "cqa-in-quotes__group", attrs: { "aria-label": `${shortId(c.criterionId)} ${c.title}` } },
    h("p", { className: "cqa-in-quotes__title" }, h("span", { className: "cqa-in-bars__num", text: shortId(c.criterionId) }), c.title,
      h("span", { className: "cqa-muted", text: ` · провалов ${formatPercent(c.failRate)}` })),
    h("ul", { className: "cqa-in-quotes__list" }, c.topQuotes.slice(0, limit).map((q) => h("li", { className: "cqa-in-quote" },
      h("blockquote", { className: "cqa-in-quote__text", text: q.quote || "—" }),
      q.explanation ? h("p", { className: "cqa-in-quote__why", text: q.explanation }) : null,
      h("p", { className: "cqa-in-quote__meta" },
        h("a", {
          className: "cqa-in-link",
          attrs: { href: buildHash(paths.conversation(q.conversationId), { g: groupId, m: q.index }) },
          text: q.index === null ? q.conversationId : `${q.conversationId} · реплика #${messageNumber(q.index)}`,
        }),
        q.count > 1 ? badge(`×${q.count}`, "muted", `Встречается в ${q.count} диалогах`) : null)))));
}

function criticalSection(items, groupId) {
  return panelSection({
    title: "Грубые ошибки",
    lead: "Оскорбление клиента, услуга в обход компании, раскрытие конфиденциальных данных — отдельной отметкой, без баллов.",
    children: items.length
      ? h("ul", { className: "cqa-in-critical" }, items.map((c) => h("li", { className: "cqa-in-critical__item" },
        h("p", { className: "cqa-in-critical__head" },
          h("a", { className: "cqa-in-link", attrs: { href: buildHash(paths.conversation(c.conversationId), { g: groupId, m: c.index }) }, text: c.conversationId }),
          c.index !== null ? h("span", { className: "cqa-muted", text: `реплика #${messageNumber(c.index)}` }) : null),
        c.note ? h("p", { className: "cqa-in-critical__note", text: c.note }) : null,
        c.quote ? h("blockquote", { className: "cqa-in-quote__text", text: c.quote }) : null)))
      : h("p", { className: "cqa-in-good", text: "Грубых ошибок в оценённых диалогах нет." }),
  });
}

function appealsSection(criteria) {
  const rows = criteria.filter((c) => c.appeals.total > 0).sort((a, b) => b.appeals.total - a.appeals.total);
  return panelSection({
    title: "Апелляции по критериям",
    lead: "Доля решённых апелляций, по которым проверяющий изменил оценку (по всем оценкам набора). Высокая доля — сигнал уточнить формулировку критерия.",
    children: rows.length
      ? h("table", { className: "cqa-in-table" },
        h("caption", { className: "cqa-sr-only", text: "Принятые апелляции по критериям" }),
        h("thead", {}, h("tr", {},
          h("th", { attrs: { scope: "col" }, text: "Критерий" }),
          h("th", { attrs: { scope: "col" }, text: "Приняты" }),
          h("th", { attrs: { scope: "col" }, text: "Решено" }))),
        h("tbody", {}, rows.map((c) => {
          const rate = c.appeals.rate;
          return h("tr", {},
            h("th", { attrs: { scope: "row" } }, h("span", { className: "cqa-in-bars__num", text: shortId(c.criterionId) }), c.title),
            h("td", { className: "cqa-in-appeal" }, meter(rate, { tone: rate >= 0.5 ? "warn" : "", label: `${c.title}: принято ${formatPercent(rate)}` }), h("span", { className: "cqa-num", text: formatPercent(rate) })),
            h("td", { className: "cqa-num", text: `${c.appeals.accepted} из ${c.appeals.resolved} решённых · всего ${c.appeals.total}` }));
        })))
      : h("p", { className: "cqa-muted", text: "Апелляций пока не было." }),
  });
}

function shortId(id) {
  const match = /(\d+)$/.exec(id);
  return match ? match[1].padStart(2, "0") : id;
}
