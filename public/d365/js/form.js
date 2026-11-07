// Форма «Обращение»: шапка записи, вкладки и их содержимое.
// Как и настоящая форма, макет уничтожает содержимое неактивной вкладки: при каждом переходе
// на «Качество» веб-ресурс создаётся заново — встраиваемая панель обязана это переживать.

import { h } from "../../js/dom.js";
import { channelName, languageName } from "../../js/format.js";
import { evaluationText, qualityTab, summaryTab, timelineTab } from "./tabs.js";

export const TABS = Object.freeze([
  { id: "summary", label: "Сводка" },
  { id: "timeline", label: "Хронология" },
  { id: "quality", label: "Качество" },
]);
const PANEL_ID = "d365-tabpanel";
const TITLE_ID = "d365-rec-title";

/**
 * @param {HTMLElement} host
 * @param {{ onTabChange: (tab: string) => void, onOpenPanel: () => void, onRetryConversation: () => void }} handlers
 */
export function createForm(host, { onTabChange, onOpenPanel, onRetryConversation }) {
  const header = h("section", { className: "d365-rec", attrs: { "aria-labelledby": TITLE_ID } });
  const tabButtons = TABS.map((tab) => h("button", {
    className: "d365-tab",
    attrs: { type: "button", role: "tab", id: `d365-tab-${tab.id}`, "aria-controls": PANEL_ID, "aria-selected": "false", tabindex: "-1" },
    dataset: { tab: tab.id },
    text: tab.label,
    on: { click: () => onTabChange(tab.id), keydown: onTabKeydown },
  }));
  const tablist = h("div", { className: "d365-tabs", attrs: { role: "tablist", "aria-label": "Вкладки формы" } }, tabButtons);
  const panel = h("div", { className: "d365-tabpanel", attrs: { id: PANEL_ID, role: "tabpanel", tabindex: "-1" } });
  host.replaceChildren(header, tablist, panel);

  let renderedKey = "";
  let embedLoads = 0;

  return {
    /**
     * @param {{ record: object | null, tab: string, lcid: number, conversation: { status: string, data: object | null, error: object | null },
     *   operator: string, reloadToken: number }} view
     */
    update(view) {
      renderHeader(view);
      for (const button of tabButtons) {
        const selected = button.dataset.tab === view.tab;
        button.setAttribute("aria-selected", String(selected));
        button.setAttribute("tabindex", selected ? "0" : "-1");
      }
      panel.setAttribute("aria-labelledby", `d365-tab-${view.tab}`);
      const key = panelKey(view);
      if (key === renderedKey) return;
      renderedKey = key;
      panel.replaceChildren(renderPanel(view)); // прежнее содержимое (и iframe) уничтожается
    },
    focusTab(tab) {
      tabButtons.find((button) => button.dataset.tab === tab)?.focus();
    },
    /** Фокус на заголовок записи — после перехода на форму (кнопка, с которой ушли, уже уничтожена). */
    focusTitle() {
      const title = header.querySelector(`#${TITLE_ID}`);
      title?.setAttribute("tabindex", "-1");
      title?.focus({ preventScroll: true });
    },
  };

  function renderPanel(view) {
    if (view.tab === "timeline") return timelineTab({ record: view.record, conversation: view.conversation, onRetry: onRetryConversation });
    if (view.tab === "quality") {
      embedLoads += 1;
      return qualityTab({ record: view.record, lcid: view.lcid, loads: embedLoads, onOpenPanel });
    }
    return summaryTab({ record: view.record, conversation: view.conversation, operator: operatorLabel(view), onOpenTab: onTabChange, onOpenPanel });
  }

  /** Заголовок и подпись обновляются на месте: фокус на заголовке переживает догрузку реплик. */
  function renderHeader(view) {
    const { record } = view;
    if (!header.firstChild) {
      header.append(h("div", { className: "d365-rec__id" },
        h("span", { className: "d365-rec__icon", attrs: { "aria-hidden": "true" }, text: "Об" }),
        h("div", { className: "d365-rec__names" },
          h("h1", { className: "d365-rec__title", attrs: { id: TITLE_ID } }),
          h("p", { className: "d365-rec__sub" }))),
      h("dl", { className: "d365-rec__fields" }));
    }
    header.querySelector(".d365-rec__title").textContent = record
      ? `Обращение · ${record.conversationId} · ${operatorLabel(view)}` : "Новое обращение";
    header.querySelector(".d365-rec__sub").textContent = record ? "Обращение · Основная форма · Сохранено" : "Обращение · Основная форма";
    const fields = record
      ? [["Канал", channelName(record.channel)], ["Язык", languageName(record.language)], ["Реплик", String(record.messageCount)],
        ["Оценка качества", evaluationText(record.evaluation)]]
      : [["Состояние", "Не сохранено"]];
    header.querySelector(".d365-rec__fields").replaceChildren(...fields.map(([label, value]) => h("div", { className: "d365-rec__field" },
      h("dt", { text: label }),
      h("dd", { className: label === "Оценка качества" && record?.evaluation?.critical ? "d365-danger" : "", text: value }))));
  }

  function onTabKeydown(event) {
    const index = TABS.findIndex((tab) => tab.id === event.currentTarget.dataset.tab);
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = TABS[(moves[event.key] + TABS.length) % TABS.length].id;
    onTabChange(next);
    tabButtons.find((button) => button.dataset.tab === next)?.focus();
  }
}

function operatorLabel({ record, conversation, operator }) {
  if (!record) return "";
  if (conversation.status === "loading") return "Оператор …";
  if (operator === "hidden") return "Оператор (имя скрыто)";
  return operator ? `Оператор ${operator}` : `Оператор линии ${record.language || "—"}`;
}

/**
 * Ключ содержимого вкладки: пока он не меняется, вкладка не перерисовывается.
 * «Качество» не зависит от загрузки реплик — iframe пересоздаётся только сменой записи, языка,
 * вкладки или командой «Обновить» (reloadToken).
 */
function panelKey({ record, tab, lcid, conversation, reloadToken }) {
  const recordKey = record ? `${record.conversationId}|${record.evaluation?.evaluationId ?? "-"}` : "new";
  if (tab === "quality") return `quality|${record?.conversationId ?? "new"}|${lcid}|${reloadToken}`;
  return `${tab}|${recordKey}|${conversation.status}|${reloadToken}`;
}
