// Контекст записи для панели — по правилам HTML web resource Dynamics 365:
//   1) форма: parent.Xrm (id записи / колонка с id диалога, язык пользователя userSettings.languageId);
//   2) параметр data — закодированный JSON {"group","conversation"} или строка group=…&conversation=…;
//   3) параметр id (Dynamics передаёт его, если в свойствах веб-ресурса отмечена передача id записи).
// Язык: languageId формы → параметр userlcid → data.lang → русский.

import { isValidId } from "../api.js";
import { DEFAULT_LANG, langFromCode, langFromLcid } from "./i18n.js";

export const DEFAULT_GROUP = "DEV";
/** Колонка обращения с id диалога из контакт-центра (имя настраивается полем field в data). */
export const DEFAULT_FIELD = "cqa_conversationid";

const MAX_DECODE_PASSES = 2;
const ENCODED_CHAR = /%[0-9A-Fa-f]{2}/;
const DATA_KEYS = Object.freeze({
  group: ["group", "group_id", "g"],
  conversation: ["conversation", "conversation_id", "c"],
  field: ["field"],
  lang: ["lang"],
});

/**
 * @typedef {{
 *   status: "ok" | "missing" | "unsaved" | "invalid",
 *   source: "xrm" | "data" | "id" | "none",
 *   groupId: string, conversationId: string, invalidValue: string,
 *   field: string, recordId: string, entityName: string,
 *   lang: "ru" | "kk" | "en", lcid: number | null,
 *   xrm: object | null
 * }} EmbedContext
 */

/**
 * @param {Window} win окно веб-ресурса (в форме — iframe, его parent — страница приложения)
 * @returns {EmbedContext}
 */
export function resolveContext(win = window) {
  const params = new URLSearchParams(win.location.search);
  const data = parseDataParam(params.get("data"));
  const xrm = readHostXrm(win);
  const field = isValidId(data.field) ? data.field : DEFAULT_FIELD;
  const form = xrm ? readForm(xrm, field) : null;
  const lcid = form?.lcid ?? toLcid(params.get("userlcid"));
  const lang = langFromLcid(lcid) ?? langFromCode(data.lang) ?? DEFAULT_LANG;
  const groupId = data.group || DEFAULT_GROUP;
  const target = pickConversation({ form, data, idParam: stripBraces(params.get("id")) });
  const base = {
    groupId, field, lang, lcid: lcid ?? null, xrm,
    recordId: form?.recordId ?? "", entityName: form?.entityName ?? "",
    source: target.source, conversationId: target.conversationId, invalidValue: "",
  };
  if (target.status !== "ok") return Object.freeze({ ...base, status: target.status });
  const invalid = [groupId, target.conversationId].find((value) => !isValidId(value));
  if (invalid !== undefined) return Object.freeze({ ...base, status: "invalid", invalidValue: invalid });
  return Object.freeze({ ...base, status: "ok" });
}

/**
 * Значение параметра data → { group, conversation, field, lang } (только известные строковые поля).
 * Dynamics кодирует data сам, а редактор формы может закодировать его ещё раз — декодируем до двух раз.
 * @param {string | null} value @returns {{ group?: string, conversation?: string, field?: string, lang?: string }}
 */
export function parseDataParam(value) {
  if (typeof value !== "string" || value.trim() === "") return {};
  let text = value.trim();
  for (let pass = 0; pass < MAX_DECODE_PASSES && ENCODED_CHAR.test(text); pass += 1) {
    try {
      text = decodeURIComponent(text);
    } catch {
      break; // одиночный «%» в значении — дальше декодировать нечего
    }
  }
  const raw = text.startsWith("{") ? parseJsonObject(text) : Object.fromEntries(new URLSearchParams(text));
  return Object.freeze(Object.fromEntries(Object.entries(DATA_KEYS)
    .map(([key, aliases]) => [key, firstString(raw, aliases)])
    .filter(([, found]) => found !== "")));
}

/** "{5B2A…}" → "5B2A…": Xrm и параметр id отдают GUID в фигурных скобках. */
export function stripBraces(value) {
  return typeof value === "string" ? value.trim().replace(/^\{(.*)\}$/, "$1") : "";
}

function pickConversation({ form, data, idParam }) {
  if (form?.fieldValue) return { status: "ok", source: "xrm", conversationId: form.fieldValue };
  if (form?.recordId) return { status: "ok", source: "xrm", conversationId: form.recordId };
  if (data.conversation) return { status: "ok", source: "data", conversationId: data.conversation };
  if (idParam) return { status: "ok", source: "id", conversationId: idParam };
  // Форма есть, а id нет — запись в режиме создания: оценивать ещё нечего.
  if (form) return { status: "unsaved", source: "xrm", conversationId: "" };
  return { status: "missing", source: "none", conversationId: "" };
}

/** parent.Xrm доступен, только если веб-ресурс открыт в форме того же origin (в Dynamics — всегда). */
function readHostXrm(win) {
  try {
    if (!win.parent || win.parent === win) return null;
    const xrm = win.parent.Xrm;
    return xrm && typeof xrm === "object" ? xrm : null;
  } catch {
    return null; // родитель с другого origin (SecurityError): формы нет, работаем по параметрам URL
  }
}

/**
 * Читает запись и пользователя из формы. Поверхность Xrm зависит от места (форма, диалог, карта сайта),
 * поэтому каждая часть читается отдельно: отсутствующая часть — нормальный случай, а не ошибка.
 */
function readForm(xrm, field) {
  const page = attempt(() => xrm.Page);
  const fieldValue = attempt(() => page.getAttribute(field)?.getValue());
  return {
    recordId: stripBraces(attempt(() => page.data.entity.getId()) ?? ""),
    entityName: String(attempt(() => page.data.entity.getEntityName()) ?? ""),
    fieldValue: typeof fieldValue === "string" ? fieldValue.trim() : "",
    lcid: toLcid(attempt(() => xrm.Utility.getGlobalContext().userSettings.languageId)),
  };
}

function attempt(read) {
  try {
    return read();
  } catch {
    return undefined; // см. readForm: части Xrm может не быть в этом месте приложения
  }
}

function toLcid(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // битый JSON — как будто data не передан; панель покажет «не удалось определить диалог»
  }
}

function firstString(raw, keys) {
  for (const key of keys) {
    const value = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}
