// Команда формы обращения «Оценка качества» — JavaScript web resource для панели команд Dynamics 365.
// Открывает встраиваемую панель в боковом диалоге через Xrm.Navigation.navigateTo (pageType "webresource").
// Классический скрипт (не модуль): команды вызывают глобальную функцию CQA.openQualityPanel
// с параметром PrimaryControl (formContext). На стенде d365/ тот же файл вызывает макет формы.
(function (global) {
  "use strict";

  var WEB_RESOURCE = "cqa_/quality/embed.html";
  var CONVERSATION_FIELD = "cqa_conversationid";
  var DEFAULT_GROUP = "DEV";
  var PANEL_WIDTH_PX = 480;
  var TITLES = { 1049: "Оценка качества", 1087: "Сапа бағасы", 1033: "Quality review" };
  var LCID_PRIMARY_LANGUAGE_MASK = 0x3ff;
  var PRIMARY_TO_LCID = { 0x19: 1049, 0x3f: 1087, 0x09: 1033 };

  function readConversationId(formContext) {
    var attribute = formContext && typeof formContext.getAttribute === "function"
      ? formContext.getAttribute(CONVERSATION_FIELD) : null;
    var value = attribute ? attribute.getValue() : null;
    return typeof value === "string" ? value.trim() : "";
  }

  function panelTitle(xrm) {
    var lcid = 0;
    try {
      lcid = Number(xrm.Utility.getGlobalContext().userSettings.languageId) || 0;
    } catch (error) {
      lcid = 0; // контекст пользователя недоступен — заголовок по-русски
    }
    return TITLES[PRIMARY_TO_LCID[lcid & LCID_PRIMARY_LANGUAGE_MASK]] || TITLES[1049];
  }

  /**
   * Открывает панель оценки текущего обращения справа (target 2, position 2).
   * data — пары group=…&conversation=… (только безопасные символы: Dynamics проверяет query string).
   * @param {object} formContext PrimaryControl команды
   * @param {string} [group] набор диалогов
   * @returns {Promise<void>} завершается, когда панель закрыта
   */
  function openQualityPanel(formContext, group) {
    var xrm = global.Xrm;
    if (!xrm || !xrm.Navigation || typeof xrm.Navigation.navigateTo !== "function") {
      return Promise.reject(new Error("Xrm.Navigation.navigateTo недоступен: команда работает только в model-driven app."));
    }
    var conversation = readConversationId(formContext);
    var data = "group=" + encodeURIComponent(group || DEFAULT_GROUP)
      + (conversation ? "&conversation=" + encodeURIComponent(conversation) : "");
    return xrm.Navigation.navigateTo(
      { pageType: "webresource", webresourceName: WEB_RESOURCE, data: data },
      { target: 2, position: 2, width: { value: PANEL_WIDTH_PX, unit: "px" }, title: panelTitle(xrm) }
    );
  }

  var existing = global.CQA && typeof global.CQA === "object" ? global.CQA : {};
  global.CQA = Object.freeze(Object.assign({}, existing, { openQualityPanel: openQualityPanel }));
})(window);
