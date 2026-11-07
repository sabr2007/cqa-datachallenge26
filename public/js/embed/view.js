// Построение разметки панели: шапка, подвал с контекстом, состояния и сводка оценки.
// Только сборка DOM из готовых данных — без сети и состояния. Данные вставляются как текст.

import { h } from "../dom.js";
import { appPageData } from "../host.js";
import { brandMark, icon } from "../icons.js";
import { statusPill } from "../components/ui.js";
import { appealStatusOf, criticalState } from "../evaluation.js";
import { glyph } from "./glyphs.js";

const PERCENT_SCALE = 100;
const SOURCE_KEYS = Object.freeze({ xrm: "sourceXrm", data: "sourceData", id: "sourceId", none: "sourceNone" });
const TARGET_INLINE = 1;

/**
 * Ссылка на карточку диалога в основном приложении (маршрут #/c/<id>?g=<g>&m=<index>).
 * @param {string} appUrl @param {string} groupId @param {string} conversationId @param {number | null} [messageIndex]
 */
export function cardHref(appUrl, groupId, conversationId, messageIndex = null) {
  const params = new URLSearchParams({ g: groupId });
  if (Number.isInteger(messageIndex)) params.set("m", String(messageIndex));
  return `${appUrl}#/c/${encodeURIComponent(conversationId)}?${params}`;
}

/**
 * Карточка откроется в области содержимого Dynamics: в решении есть веб-ресурс приложения и Xrm.Navigation.navigateTo.
 * @param {{ appResource?: string, xrm: object | null }} links
 */
export function opensInline({ appResource = "", xrm }) {
  return Boolean(appResource) && typeof xrm?.Navigation?.navigateTo === "function";
}

/**
 * Ссылка на полную карточку в основном приложении.
 * В форме Dynamics с веб-ресурсом приложения — страница в области содержимого (navigateTo, target 1: «Назад» платформы
 * вернёт на форму); без него — новая вкладка, в Dynamics через Xrm.Navigation.openUrl (работает и в мобильном клиенте).
 * Клик с модификатором — всегда новая вкладка (href — адрес приложения). newTabText — пояснение для скринридера,
 * когда ссылка уводит в новую вкладку: дописывается к ariaLabel или после видимого текста.
 * @param {{ href: string, className: string, label?: string, ariaLabel?: string, newTabText?: string,
 *   links: { appResource?: string, xrm: object | null }, children?: Node[] }} options
 */
export function externalLink({ href, className, label = "", ariaLabel = "", newTabText = "", links, children = [] }) {
  const inline = opensInline(links);
  const note = !inline && newTabText ? newTabText : "";
  const link = h("a", {
    className,
    attrs: { href, target: "_blank", rel: "noopener noreferrer", "aria-label": ariaLabel ? (note ? `${ariaLabel} (${note})` : ariaLabel) : null },
  }, label, ...children, note && !ariaLabel ? h("span", { className: "cqa-sr-only", text: ` (${note})` }) : null);
  const { xrm } = links;
  const openUrl = xrm?.Navigation?.openUrl;
  if (!inline && typeof openUrl !== "function") return link;
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const url = new URL(href, window.location.href);
    if (!inline) {
      openUrl.call(xrm.Navigation, url.href);
      return;
    }
    const pageInput = { pageType: "webresource", webresourceName: links.appResource, data: appPageData(url.hash) };
    Promise.resolve()
      .then(() => xrm.Navigation.navigateTo(pageInput, { target: TARGET_INLINE }))
      .catch(() => window.open(url.href, "_blank", "noopener,noreferrer")); // платформа не открыла страницу — новая вкладка
  });
  return link;
}

/** Кнопка панели; disabled — через aria-disabled, чтобы оставалась в порядке фокуса с подсказкой. */
export function actionButton({ label, variant = "dark", glyphName = "", iconName = "", onClick, attrs = {} }) {
  const mark = glyphName ? glyph(glyphName, { size: 18 }) : iconName ? icon(iconName, { size: 18 }) : null;
  return h("button", {
    className: `cqa-btn cqa-btn--sm cqa-btn--${variant}`,
    attrs: { type: "button", ...attrs },
    on: { click: (event) => { if (event.currentTarget.getAttribute("aria-disabled") !== "true") onClick?.(event); } },
  }, mark, label);
}

/** Шапка панели: знак, заголовок, диалог и набор, кнопка обновления. */
export function buildHeader({ i18n, context, onRefresh }) {
  const subtitle = context.status === "ok"
    ? i18n.t("subtitle", { id: context.conversationId, group: context.groupId })
    : "";
  const refresh = h("button", {
    className: "cqa-embed__icon-btn",
    attrs: { type: "button", "aria-label": i18n.t("refresh"), title: i18n.t("refresh"), hidden: context.status !== "ok" },
    on: { click: () => { if (refresh.getAttribute("aria-disabled") !== "true") onRefresh(); } },
  }, icon("refresh", { size: 18 }));
  const el = h("header", { className: "cqa-embed__bar" },
    brandMark("cqa-embed__mark"),
    h("div", { className: "cqa-embed__heading" },
      h("h1", { className: "cqa-embed__title", attrs: { id: "cqa-embed-title" }, text: i18n.t("title") }),
      subtitle ? h("p", { className: "cqa-embed__subtitle cqa-num", text: subtitle }) : null),
    refresh);
  return {
    el,
    setBusy(busy) {
      if (busy) refresh.setAttribute("aria-disabled", "true");
      else refresh.removeAttribute("aria-disabled");
    },
  };
}

/** Подвал: откуда взят контекст — видно на стенде и полезно при внедрении. */
export function buildFooter({ i18n, context }) {
  const parts = [i18n.t(SOURCE_KEYS[context.source] ?? "sourceNone")];
  if (context.source === "xrm" && context.conversationId && context.conversationId !== context.recordId) {
    parts.push(i18n.t("contextField", { field: context.field }));
  } else if (context.source === "xrm" && context.recordId) {
    parts.push(i18n.t("contextRecord"));
  }
  const lang = i18n.t("contextLang", { code: i18n.code });
  parts.push(context.lcid ? `${lang} (LCID ${context.lcid})` : lang);
  return h("footer", { className: "cqa-embed__foot" },
    h("span", { className: "cqa-embed__foot-label", text: `${i18n.t("contextLabel")}:` }),
    h("span", { text: parts.join(" · ") }));
}

/**
 * Блок состояния (пусто, ошибка, нет контекста).
 * @param {{ kind?: "info" | "error", title: string, text?: string, code?: string, actions?: Node[], i18n: object }} options
 */
export function stateView({ kind = "info", title, text = "", code = "", actions = [], i18n }) {
  return h("section", { className: `cqa-embed-state cqa-embed-state--${kind}`, attrs: { role: kind === "error" ? "alert" : null } },
    h("span", { className: "cqa-embed-state__icon" }, icon(kind === "error" ? "alert" : "inbox", { size: 22 })),
    h("div", { className: "cqa-embed-state__copy" },
      h("h2", { className: "cqa-embed-state__title", text: title }),
      text ? h("p", { className: "cqa-embed-state__text", text }) : null,
      code ? h("p", { className: "cqa-embed-state__code", text: i18n.t("errorCode", { code }) }) : null),
    actions.length ? h("div", { className: "cqa-embed-actions" }, actions) : null);
}

/** Скелетон на время загрузки. */
export function loadingView({ i18n }) {
  return h("div", { className: "cqa-embed-loading" },
    h("p", { className: "cqa-loading-note", attrs: { role: "status" } },
      h("span", { className: "cqa-spinner", attrs: { "aria-hidden": "true" } }),
      h("span", { text: i18n.t("loading") })),
    h("div", { className: "cqa-embed-sum cqa-embed-sum--skeleton", attrs: { "aria-hidden": "true" } },
      h("span", { className: "cqa-skel cqa-skel--total" }),
      h("span", { className: "cqa-skel cqa-skel--line cqa-skel--w70" }),
      h("span", { className: "cqa-skel cqa-skel--bar" })),
    h("div", { className: "cqa-embed-skel-rows", attrs: { "aria-hidden": "true" } },
      Array.from({ length: 5 }, () => h("span", { className: "cqa-skel cqa-skel--line cqa-skel--w90" }))));
}

/**
 * Идёт оценка: спиннер, секунды с начала, пояснение. Счётчик обновляется раз в секунду.
 * @param {{ i18n: object, startedAt: number, resumed?: boolean }} options
 * @returns {{ el: HTMLElement, stop: () => void }}
 */
export function progressView({ i18n, startedAt, resumed = false }) {
  const seconds = h("span", { className: "cqa-embed-progress__time cqa-num", attrs: { "aria-hidden": "true" } });
  const tick = () => { seconds.textContent = i18n.t("elapsed", { n: Math.max(0, Math.round((Date.now() - startedAt) / 1000)) }); };
  tick();
  const timer = window.setInterval(tick, 1000);
  const el = h("section", { className: "cqa-embed-progress", attrs: { "aria-busy": "true" } },
    h("div", { className: "cqa-embed-progress__head" },
      h("span", { className: "cqa-spinner", attrs: { "aria-hidden": "true" } }),
      h("h2", { className: "cqa-embed-progress__title", attrs: { role: "status" }, text: i18n.t("evaluating") }),
      seconds),
    resumed ? h("p", { className: "cqa-embed-progress__text", text: i18n.t("evaluatingResumed") }) : null,
    h("p", { className: "cqa-embed-progress__text", text: i18n.t("evaluatingHint") }),
    h("div", { className: "cqa-embed-progress__bar", attrs: { "aria-hidden": "true" } }, h("span")));
  return { el, stop: () => window.clearInterval(timer) };
}

/**
 * Сводка оценки: итог, статусы, грубая ошибка, мета, действия.
 * @param {{ evaluation: object, i18n: object, actions: Node[] }} options
 */
export function summaryView({ evaluation, i18n, actions }) {
  const critical = criticalState(evaluation);
  const score = typeof evaluation.finalTotal === "number" ? evaluation.finalTotal : evaluation.total;
  const changed = typeof evaluation.total === "number" && typeof score === "number" && evaluation.total !== score;
  const scoreEl = typeof score === "number"
    ? h("p", { className: "cqa-embed-sum__score", attrs: { role: "img", "aria-label": i18n.t("scoreAria", { score: i18n.number(score), max: PERCENT_SCALE }) } },
      h("span", { className: "cqa-embed-sum__value cqa-num", text: i18n.number(score) }),
      h("span", { className: "cqa-embed-sum__max cqa-num", text: `/ ${PERCENT_SCALE}` }))
    : h("p", { className: "cqa-embed-sum__none", text: i18n.t("scoreNone") });
  return h("section", { className: "cqa-embed-sum", attrs: { "aria-labelledby": "cqa-embed-sum-label" } },
    h("div", { className: "cqa-embed-sum__top" },
      h("div", { className: "cqa-embed-sum__main" },
        h("h2", { className: "cqa-embed-sum__label", attrs: { id: "cqa-embed-sum-label", tabindex: "-1" }, text: i18n.t("scoreLabel") }),
        scoreEl,
        changed ? h("p", { className: "cqa-embed-sum__initial cqa-num", text: i18n.t("scoreInitial", { value: i18n.number(evaluation.total) }) }) : null),
      h("div", { className: "cqa-embed-sum__pills" }, statusPills(evaluation, critical, i18n))),
    criticalCallout(evaluation, critical, i18n),
    h("p", { className: "cqa-embed-sum__meta" }, metaParts(evaluation, i18n).map((part) => h("span", { text: part }))),
    actions.length ? h("div", { className: "cqa-embed-actions" }, actions) : null);
}

/** Баллы по секциям: полоса заполнения через transform (только compositor-friendly свойства). */
export function sectionsView({ evaluation, i18n }) {
  // final_* уже с откатом на исходные (api.js); null — в секции после апелляций нет баллов
  const rows = evaluation.sections
    .map((section) => ({ ...section, max: section.finalMaxPoints, value: section.finalPoints }))
    .filter((section) => typeof section.max === "number" && section.max > 0);
  if (rows.length === 0) return null;
  return h("section", { className: "cqa-embed-secs", attrs: { "aria-labelledby": "cqa-embed-secs-title" } },
    h("h2", { className: "cqa-embed-h2", attrs: { id: "cqa-embed-secs-title" }, text: i18n.t("sectionsTitle") }),
    h("ul", { className: "cqa-embed-secs__list" }, rows.map((section) => {
      const value = typeof section.value === "number" ? section.value : 0;
      const ratio = Math.min(1, Math.max(0, value / section.max));
      return h("li", { className: "cqa-embed-sec" },
        h("span", { className: "cqa-embed-sec__title", text: section.title }),
        h("span", { className: "cqa-embed-sec__pts cqa-num", attrs: { "aria-hidden": "true" }, text: `${i18n.number(value)} / ${i18n.number(section.max)}` }),
        h("span", { className: "cqa-sr-only", text: i18n.t("pointsAria", { points: i18n.number(value), max: i18n.number(section.max) }) }),
        h("span", { className: "cqa-embed-sec__bar", attrs: { "aria-hidden": "true" } },
          h("span", { className: `cqa-embed-sec__fill${ratio < 1 ? " cqa-embed-sec__fill--part" : ""}`, vars: { "--cqa-p": ratio.toFixed(4) } })));
    })));
}

function statusPills(evaluation, critical, i18n) {
  const pills = [];
  if (critical.now) pills.push(statusPill("error", i18n.t("statusCritical")));
  if (evaluation.needsReview) pills.push(statusPill("review", i18n.t("statusReview")));
  const appeal = appealStatusOf(evaluation);
  if (appeal) pills.push(statusPill("appeal", i18n.t(appeal === "open" ? "statusAppealOpen" : "statusAppealResolved")));
  if (pills.length === 0) pills.push(statusPill("done", i18n.t("statusDone")));
  return pills;
}

function criticalCallout(evaluation, critical, i18n) {
  if (critical.now) {
    const note = evaluation.criticalNote
      || critical.criteria.find((criterion) => criterion.finalAnswer === "yes")?.explanation || "";
    return h("div", { className: "cqa-embed-callout cqa-embed-callout--danger" },
      glyph("warning", { size: 20 }),
      h("p", {},
        h("strong", { text: i18n.t("statusCritical") }),
        note ? h("span", { text: ` — ${note}` }) : null));
  }
  if (critical.before) {
    return h("div", { className: "cqa-embed-callout cqa-embed-callout--info" },
      glyph("check", { size: 20 }), h("p", { text: i18n.t("criticalLifted") }));
  }
  return null;
}

function metaParts(evaluation, i18n) {
  const parts = [i18n.date(evaluation.createdAt)];
  if (evaluation.checklistVersion !== null) parts.push(i18n.t("metaChecklist", { version: evaluation.checklistVersion }));
  if (evaluation.models.length) parts.push(i18n.count(evaluation.models.length, "model"));
  const cost = i18n.cost(evaluation.costUsd);
  if (cost) parts.push(i18n.t("metaCost", { cost }));
  if (typeof evaluation.latencyMs === "number" && evaluation.latencyMs > 0) {
    parts.push(i18n.t("metaLatency", { seconds: i18n.number(Math.round(evaluation.latencyMs / 1000)) }));
  }
  return parts.filter(Boolean);
}
