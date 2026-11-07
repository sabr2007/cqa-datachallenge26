// Заглушка Client API (window.Xrm) на странице-макете. Веб-ресурсы читают её через parent.Xrm —
// ровно так же, как в настоящем model-driven app. Реализована только используемая поверхность:
//   Xrm.Page.data.entity.getId / getEntityName, Xrm.Page.getAttribute(...).getValue, Xrm.Page.data.refresh,
//   Xrm.Utility.getGlobalContext().userSettings.languageId / getClientUrl,
//   Xrm.Navigation.navigateTo({ pageType: "webresource" }, { target: 1 | 2 }), openForm, openUrl,
//   Xrm.WebApi.retrieveMultipleRecords("incident", "?$select=…&$filter=колонка eq '…'&$top=N").

/** Имена веб-ресурсов решения → файлы стенда (в Dynamics их отдаёт /WebResources/<имя>). */
export const WEB_RESOURCES = Object.freeze({
  "cqa_/quality/embed.html": "../embed.html",
  "cqa_/quality/index.html": "../index.html",
});
export const ORG_NAME = "freedomdemo";
export const ORG_LCID = 1049;
const ENTITY_NAME = "incident";
const FORM_TYPE = Object.freeze({ create: 1, update: 2 });
const TARGET = Object.freeze({ page: 1, dialog: 2 });
/** Колонки записи «Обращение» макета (то, что читают веб-ресурсы и фильтр Web API). */
const COLUMNS = Object.freeze({
  cqa_conversationid: (record) => record.conversationId,
  title: (record) => record.title,
  cqa_group: (record) => record.groupId,
  cqa_channel: (record) => record.channel,
  cqa_language: (record) => record.language,
});
const FILTER_CONDITION = /^\s*([a-z_]+)\s+eq\s+'((?:[^']|'')*)'\s*$/i;

/**
 * @param {Window} win
 * @param {{
 *   getRecord: () => (object | null),
 *   getUser: () => { lcid: number, name: string, id: string },
 *   findRecords: () => Promise<ReadonlyArray<object>>,
 *   openDialog: (options: { url: string, title: string, width: unknown, position: number }) => Promise<void>,
 *   openPage: (options: { webresourceName: string, data: string }) => Promise<void>,
 *   openRecord: (options: { entityId: string, parameters: Record<string, unknown> }) => Promise<object>,
 *   onRefresh: () => Promise<void>,
 * }} host
 */
export function installXrmStub(win, { getRecord, getUser, findRecords, openDialog, openPage, openRecord, onRefresh }) {
  const Page = Object.freeze({
    data: Object.freeze({
      entity: Object.freeze({
        getId: () => (getRecord() ? `{${getRecord().guid}}` : ""),
        getEntityName: () => ENTITY_NAME,
        getPrimaryAttributeValue: () => getRecord()?.title ?? "",
      }),
      /** formContext.data.refresh(save): перечитывает данные записи, веб-ресурсы не пересоздаёт. */
      refresh: () => onRefresh(),
    }),
    getAttribute: (name) => (Object.hasOwn(COLUMNS, name) ? attribute(name, () => {
      const record = getRecord();
      return record ? COLUMNS[name](record) : null;
    }) : null),
    ui: Object.freeze({ getFormType: () => (getRecord() ? FORM_TYPE.update : FORM_TYPE.create) }),
  });

  const Utility = Object.freeze({
    getGlobalContext: () => {
      const user = getUser();
      return Object.freeze({
        userSettings: Object.freeze({ languageId: user.lcid, userName: user.name, userId: `{${user.id}}` }),
        organizationSettings: Object.freeze({ uniqueName: ORG_NAME, languageId: ORG_LCID }),
        getClientUrl: () => win.location.origin,
        getVersion: () => "9.2 (макет стенда)",
      });
    },
  });

  const Navigation = Object.freeze({
    /** target 1 — страница в области содержимого (по умолчанию), target 2 — диалог (position 2 — справа). */
    navigateTo(pageInput, navigationOptions = {}) {
      if (pageInput?.pageType !== "webresource") {
        return Promise.reject(new Error("Макет поддерживает только pageType: \"webresource\"."));
      }
      const path = WEB_RESOURCES[pageInput.webresourceName];
      if (!path) return Promise.reject(new Error(`Веб-ресурс «${pageInput.webresourceName}» не найден в решении.`));
      const data = typeof pageInput.data === "string" ? pageInput.data : "";
      const target = navigationOptions.target ?? TARGET.page;
      if (target === TARGET.page) return openPage({ webresourceName: pageInput.webresourceName, data });
      if (target !== TARGET.dialog) return Promise.reject(new Error("target: 1 (страница) или 2 (диалог)."));
      const url = new URL(path, win.document.baseURI);
      if (data !== "") url.searchParams.set("data", data);
      return openDialog({
        url: url.href,
        title: String(navigationOptions.title ?? ""),
        width: navigationOptions.width,
        position: navigationOptions.position === 2 ? 2 : 1,
      });
    },
    /** Форма записи в области содержимого; formParameters — параметры формы (у нас cqa_tab — вкладка). */
    openForm(entityFormOptions = {}, formParameters = {}) {
      if (entityFormOptions?.entityName !== ENTITY_NAME) {
        return Promise.reject(new Error(`Макет открывает только формы таблицы «${ENTITY_NAME}».`));
      }
      return openRecord({ entityId: stripBraces(entityFormOptions.entityId), parameters: { ...formParameters } });
    },
    openUrl(url) {
      win.open(String(url), "_blank", "noopener,noreferrer");
    },
  });

  const WebApi = Object.freeze({
    /** Записи «Обращение» по фильтру колонка eq 'значение' (через and); ответ — { entities: [...] }. */
    retrieveMultipleRecords(entityLogicalName, options = "") {
      if (entityLogicalName !== ENTITY_NAME) {
        return Promise.reject(new Error(`Макет читает через Web API только таблицу «${ENTITY_NAME}».`));
      }
      let query;
      try {
        query = parseQueryOptions(options);
      } catch (error) {
        return Promise.reject(error);
      }
      return findRecords().then((records) => Object.freeze({
        entities: records
          .filter((record) => query.filters.every(([column, value]) => String(COLUMNS[column]?.(record) ?? "") === value))
          .slice(0, query.top)
          .map(entityOf),
      }));
    },
  });

  win.Xrm = Object.freeze({ Page, Utility, Navigation, WebApi });
  return win.Xrm;
}

/** "{5B2A…}" → "5B2A…": Xrm отдаёт GUID в фигурных скобках, Web API — без них и в нижнем регистре. */
export function stripBraces(value) {
  return typeof value === "string" ? value.trim().replace(/^\{(.*)\}$/, "$1") : "";
}

function attribute(name, read) {
  return Object.freeze({
    getName: () => name,
    getAttributeType: () => "string",
    getValue: () => read() ?? null,
  });
}

/** Запись так, как её отдаёт Web API: GUID в нижнем регистре, имена колонок — логические. */
function entityOf(record) {
  return Object.freeze({
    "@odata.etag": "W/\"1\"",
    incidentid: record.guid.toLowerCase(),
    title: record.title,
    cqa_conversationid: record.conversationId,
  });
}

/** "?$select=…&$filter=…&$top=N" → { filters: [[колонка, значение]], top }. Другие параметры OData макет не знает. */
function parseQueryOptions(options) {
  const query = { filters: [], top: Number.POSITIVE_INFINITY };
  for (const part of String(options ?? "").replace(/^\?/, "").split("&").filter(Boolean)) {
    const separator = part.indexOf("=");
    const key = separator === -1 ? part : part.slice(0, separator);
    const value = safeDecode(separator === -1 ? "" : part.slice(separator + 1));
    if (key === "$filter") query.filters = value.split(/\s+and\s+/i).map(parseCondition);
    else if (key === "$top") query.top = Math.max(1, Number.parseInt(value, 10) || 1);
    else if (key !== "$select") throw new Error(`Макет Web API не поддерживает параметр ${key}.`);
  }
  return query;
}

function parseCondition(condition) {
  const match = FILTER_CONDITION.exec(condition);
  if (!match || !Object.hasOwn(COLUMNS, match[1])) {
    throw new Error(`Макет Web API понимает только фильтр «колонка eq 'значение'»: ${condition}`);
  }
  return [match[1], match[2].replaceAll("''", "'")];
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // одиночный «%» в значении — оставляем как есть
  }
}
