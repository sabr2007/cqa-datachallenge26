// Содержимое вкладок формы «Обращение»: Сводка, Хронология, Качество.
// Вкладка «Качество» — элемент HTML web resource: iframe с embed.html и стандартными параметрами
// Dynamics (data, id, typename, type, orgname, orglcid, userlcid).

import { h } from "../../js/dom.js";
import { channelName, clockFromTimestamp, formatDuration, formatPoints, isIsoTimestamp, languageName, messageNumber, speakerName } from "../../js/format.js";
import { effectiveTotal } from "../../js/evaluation.js";
import { hostIcon } from "./hostIcons.js";
import { ORG_LCID, ORG_NAME } from "./xrmStub.js";

const WEB_RESOURCE_NAME = "cqa_/quality/embed.html";
const EMBED_PATH = "../embed.html";
const INCIDENT_TYPE_CODE = "112";
const SPEAKER_INITIALS = Object.freeze({ client: "К", operator: "О", bot: "Б", system: "С" });

/** URL веб-ресурса так, как его собирает форма: data + параметры записи и пользователя. */
export function embedSrc(record, lcid) {
  const url = new URL(EMBED_PATH, document.baseURI);
  url.searchParams.set("data", JSON.stringify(record ? { group: record.groupId, conversation: record.conversationId } : { group: "DEV" }));
  if (record) url.searchParams.set("id", `{${record.guid}}`);
  url.searchParams.set("orgname", ORG_NAME);
  url.searchParams.set("orglcid", String(ORG_LCID));
  url.searchParams.set("type", INCIDENT_TYPE_CODE);
  url.searchParams.set("typename", "incident");
  url.searchParams.set("userlcid", String(lcid));
  return url;
}

/** Текст поля «Оценка качества» по сводке из листинга. */
export function evaluationText(evaluation) {
  if (!evaluation) return "Не оценено";
  const total = effectiveTotal(evaluation);
  const score = typeof total === "number" ? `${formatPoints(total)} / 100` : "без итога";
  return evaluation.critical ? `${score} · грубая ошибка` : score;
}

/**
 * @param {{ record: object | null, conversation: { status: string, data: object | null }, operator: string,
 *   onOpenTab: (tab: string) => void, onOpenPanel: () => void }} options
 */
export function summaryTab({ record, conversation, operator, onOpenTab, onOpenPanel }) {
  if (!record) return createModeNote();
  const firstClient = conversation.data?.messages.find((message) => message.speaker === "client")?.text ?? record.title;
  const counts = record.counts ?? {};
  const breakdown = ["client", "operator", "bot", "system"].filter((speaker) => counts[speaker] > 0)
    .map((speaker) => `${speakerName(speaker).toLowerCase()} ${counts[speaker]}`).join(" · ");
  return h("div", { className: "d365-columns" },
    card("Сведения об обращении", fieldGrid([
      ["Номер обращения", record.conversationId],
      ["Тема", record.title],
      ["Канал", channelName(record.channel)],
      ["Язык клиента", languageName(record.language)],
      ["Реплик", breakdown ? `${record.messageCount} (${breakdown})` : String(record.messageCount)],
      ["Длительность", formatDuration(record.durationSec)],
      ["Владелец", operator],
      ["Набор данных", record.groupId],
    ])),
    h("div", { className: "d365-stack" },
      card("Оценка качества", h("div", { className: "d365-quality" },
        h("p", { className: "d365-quality__score", text: evaluationText(record.evaluation) }),
        record.evaluation?.criticalNote && record.evaluation.critical
          ? h("p", { className: "d365-quality__note", text: record.evaluation.criticalNote }) : null,
        h("div", { className: "d365-quality__actions" },
          h("button", { className: "d365-btn", attrs: { type: "button" }, text: "Открыть вкладку «Качество»", on: { click: () => onOpenTab("quality") } }),
          h("button", { className: "d365-btn d365-btn--ghost", attrs: { type: "button" }, on: { click: onOpenPanel } },
            hostIcon("panel", { size: 18 }), "В боковой панели")))),
      card("Описание", h("p", { className: "d365-text", text: firstClient }))));
}

/** @param {{ record: object | null, conversation: { status: string, data: object | null, error: object | null }, onRetry: () => void }} options */
export function timelineTab({ record, conversation, onRetry }) {
  if (!record) return createModeNote();
  let body;
  if (conversation.status === "loading") {
    body = h("div", { className: "d365-skeleton", attrs: { role: "status" } },
      h("span", { className: "d365-sr-only", text: "Загружаем реплики…" }),
      Array.from({ length: 6 }, () => h("span", { className: "d365-skeleton__line", attrs: { "aria-hidden": "true" } })));
  } else if (conversation.status === "error") {
    body = h("div", { className: "d365-error", attrs: { role: "alert" } },
      h("p", { text: `Реплики не загрузились: ${conversation.error?.message ?? "ошибка"}` }),
      h("button", { className: "d365-btn", attrs: { type: "button" }, text: "Повторить", on: { click: onRetry } }));
  } else {
    body = h("ol", { className: "d365-tl" }, conversation.data.messages.map(timelineItem));
  }
  const count = conversation.data ? `${conversation.data.messages.length}` : "";
  return card(count ? `Хронология · ${count}` : "Хронология", body, { wide: true });
}

/**
 * @param {{ record: object | null, lcid: number, loads: number, onOpenPanel: () => void }} options
 */
export function qualityTab({ record, lcid, loads, onOpenPanel }) {
  const src = embedSrc(record, lcid);
  const relative = `${EMBED_PATH}${src.search}`;
  const csp = h("dd", { className: "d365-code", text: "загружается…" });
  const frame = h("iframe", {
    className: "d365-wr__frame",
    attrs: { src: src.href, title: "Оценка качества диалога (веб-ресурс)", loading: "eager" },
  });
  frame.addEventListener("load", () => { csp.textContent = readEmbedCsp(frame); });
  return h("div", { className: "d365-columns d365-columns--quality" },
    h("section", { className: "d365-card d365-wr", attrs: { "aria-labelledby": "d365-wr-title" } },
      h("h2", { className: "d365-card__title", attrs: { id: "d365-wr-title" }, text: "Оценка качества диалога" }),
      frame),
    card("Как встроено (стенд)", h("div", { className: "d365-embed-info" },
      h("dl", { className: "d365-dl" },
        dlRow("Веб-ресурс", WEB_RESOURCE_NAME, true),
        dlRow("Элемент формы", relative, true),
        dlRow("Контекст", record
          ? `parent.Xrm → поле cqa_conversationid = ${record.conversationId}; запись {${record.guid}}`
          : "parent.Xrm → запись не сохранена (режим создания)"),
        dlRow("Язык", `userSettings.languageId = ${lcid}`, true),
        dlRow("Загрузок элемента", `${loads} — форма пересоздаёт веб-ресурс при каждом переходе на вкладку`),
        h("div", { className: "d365-dl__row" }, h("dt", { text: "CSP веб-ресурса" }), csp)),
      h("button", { className: "d365-btn", attrs: { type: "button" }, on: { click: onOpenPanel } },
        hostIcon("panel", { size: 18 }), "Открыть в боковой панели (navigateTo)"))));
}

function readEmbedCsp(frame) {
  try {
    return frame.contentDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "не найден";
  } catch {
    return "недоступен: веб-ресурс с другого origin"; // на стенде origin общий, в Dynamics — тоже
  }
}

function timelineItem(message) {
  const time = isIsoTimestamp(message.timestamp) ? clockFromTimestamp(message.timestamp) : message.timestamp;
  return h("li", { className: `d365-tl__item d365-tl__item--${message.speaker}` },
    h("span", { className: "d365-tl__avatar", attrs: { "aria-hidden": "true" }, text: SPEAKER_INITIALS[message.speaker] ?? "?" }),
    h("div", { className: "d365-tl__body" },
      h("p", { className: "d365-tl__meta" },
        h("strong", { text: speakerName(message.speaker) }),
        h("span", { className: "d365-num", text: `#${messageNumber(message.index)}` }),
        time ? h("span", { className: "d365-num", text: time }) : null),
      h("p", { className: "d365-tl__text", text: message.text })));
}

function createModeNote() {
  return card("Новое обращение", h("p", { className: "d365-text",
    text: "Запись ещё не сохранена: у неё нет id, а у веб-ресурса — диалога для оценки. Выберите запись в верхней панели." }));
}

function card(title, body, { wide = false } = {}) {
  const id = `d365-card-${Math.random().toString(36).slice(2, 8)}`;
  return h("section", { className: `d365-card${wide ? " d365-card--wide" : ""}`, attrs: { "aria-labelledby": id } },
    h("h2", { className: "d365-card__title", attrs: { id }, text: title }), body);
}

function fieldGrid(rows) {
  return h("dl", { className: "d365-fields" }, rows.map(([label, value]) => h("div", { className: "d365-field" },
    h("dt", { className: "d365-field__label", text: label }),
    h("dd", { className: "d365-field__value", text: value || "—" }))));
}

function dlRow(term, value, code = false) {
  return h("div", { className: "d365-dl__row" }, h("dt", { text: term }), h("dd", { className: code ? "d365-code" : "", text: value }));
}
