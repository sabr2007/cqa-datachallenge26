// Режим хоста: приложение CQA открыто внутри Dynamics 365 как HTML web resource в области содержимого
// model-driven app (пункт карты сайта или Xrm.Navigation.navigateTo с target: 1).
// Единственный модуль приложения, который знает про хост: признак режима, доступ к parent.Xrm, навигация.
//
// Признак режима — host=d365: в параметре адреса (?host=d365#/appeals — стенд, разработка) или в data
// (?data=host%3Dd365%26route%3D%252Fappeals…). Dynamics передаёт веб-ресурсу из своих параметров только data,
// поэтому маршрут экрана тоже едет в data (route=/appeals?g=DEV), а hash в адресе веб-ресурса не нужен.
//
// В режиме хоста переход с экрана на экран идёт через платформу:
//   диалог (#/c/<id>)          → форма записи «Обращение» этого диалога, вкладка «Качество» (openForm);
//   реплика (#/c/<id>?m=<i>)   → полная карточка на этой реплике в области содержимого (navigateTo);
//   другой экран (#/appeals…)  → тот же веб-ресурс с новым route (navigateTo) — «Назад» платформы вернёт.
// Переходы внутри экрана (фильтры, вкладки, реплики той же карточки) остаются в приложении.

import { navigate, parseRoute } from "./router.js";
import { APPEALS_CHANGED_EVENT } from "./components/header.js";

export const HOST_D365 = "d365";
/** Имя веб-ресурса приложения в решении (рядом со встраиваемой панелью cqa_/quality/embed.html). */
export const APP_WEB_RESOURCE = "cqa_/quality/index.html";

const INCIDENT = "incident";
/** Колонка обращения с id диалога из контакт-центра (её заполняет интеграция, см. d365/README.md). */
const CONVERSATION_COLUMN = "cqa_conversationid";
/** Параметр формы обращения: вкладка при открытии (объявлен в свойствах формы, читается в OnLoad). */
const FORM_TAB_PARAM = "cqa_tab";
const QUALITY_TAB = "quality";
const TARGET_INLINE = 1;
const MAX_DECODE_PASSES = 2;
const ROUTE_PATTERN = /^\/[^\s#]{0,500}$/;
const ENCODED_CHAR = /%[0-9A-Fa-f]{2}/;
const MESSAGE_SOURCE = "cqa";

let host = Object.freeze({ kind: "", route: "" });

/**
 * Параметры хоста из адреса веб-ресурса.
 * @param {{ search: string }} location
 * @returns {{ kind: "" | "d365", route: string }} route — маршрут экрана из data ("/appeals?g=DEV") или ""
 */
export function readHostParams(location) {
  const params = new URLSearchParams(location.search);
  const data = parseData(params.get("data"));
  const kind = params.get("host") === HOST_D365 || data.get("host") === HOST_D365 ? HOST_D365 : "";
  const route = (data.get("route") ?? "").trim();
  return Object.freeze({ kind, route: ROUTE_PATTERN.test(route) ? route : "" });
}

/**
 * Значение data для веб-ресурса приложения: признак хоста и маршрут экрана.
 * @param {string} hash "#/c/p1-ru-001?g=DEV" или "/c/p1-ru-001?g=DEV"
 */
export function appPageData(hash) {
  return new URLSearchParams({ host: HOST_D365, route: String(hash).replace(/^#/, "") }).toString();
}

/**
 * Включает режим хоста, если он задан в адресе: признак на корне (компактная вёрстка, светлая тема платформы),
 * начальный маршрут из data, перехват переходов между экранами и пересылка событий хосту.
 * @param {HTMLElement} root #cqa-root
 * @returns {boolean} true — приложение работает внутри Dynamics 365
 */
export function installHost(root) {
  host = readHostParams(window.location);
  if (!host.kind) return false;
  root.dataset.host = host.kind;
  root.dataset.theme = "light"; // тема платформы; выбор зрителя в localStorage не трогаем
  if (host.route && !window.location.hash) window.history.replaceState(window.history.state, "", `#${host.route}`);
  document.addEventListener("click", onDocumentClick);
  window.addEventListener(APPEALS_CHANGED_EVENT, (event) => postToHost("appeals-changed", { groupId: event.detail?.groupId ?? "" }));
  return true;
}

/** @returns {boolean} */
export function isHosted() {
  return host.kind === HOST_D365;
}

/**
 * Переход на другой экран по hash-маршруту. Без хоста (или без Xrm) — обычная навигация по hash.
 * @param {string} hash "#/c/p1-ru-001?g=DEV"
 */
export function openRoute(hash) {
  if (!isHosted() || !leaveTo(hash)) navigate(hash);
}

/** Ссылки на другие экраны (#/…) в режиме хоста ведут через платформу; клики с модификаторами — как обычно. */
function onDocumentClick(event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest("a[href^='#/']") : null;
  if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
  const hash = anchor.getAttribute("href");
  if (leavesScreen(hash) && leaveTo(hash)) event.preventDefault();
}

/** Переход меняет экран: другой маршрут или карточка другого диалога. */
function leavesScreen(hash) {
  const target = parseRoute(hash);
  const current = parseRoute(window.location.hash);
  if (target.name !== current.name) return true;
  return target.name === "conversation" && target.id !== current.id;
}

/** @returns {boolean} переход взяла на себя платформа */
function leaveTo(hash) {
  const xrm = hostXrm();
  if (!xrm || typeof xrm.Navigation?.navigateTo !== "function") return false;
  const route = parseRoute(hash);
  if (route.name === "conversation" && route.id && !route.query.has("m")) {
    openConversationRecord(xrm, route.id).catch(() => openInContentArea(xrm, hash));
    return true;
  }
  openInContentArea(xrm, hash);
  return true;
}

/**
 * Форма записи «Обращение» этого диалога на вкладке «Качество»: запись ищется по колонке с id диалога
 * (Web API), затем открывается через Xrm.Navigation.openForm. Нет записи — ошибка, вызывающий покажет карточку.
 */
async function openConversationRecord(xrm, conversationId) {
  if (typeof xrm.WebApi?.retrieveMultipleRecords !== "function" || typeof xrm.Navigation.openForm !== "function") {
    throw new Error("Xrm.WebApi или Xrm.Navigation.openForm недоступны");
  }
  const filter = `${CONVERSATION_COLUMN} eq '${conversationId.replaceAll("'", "''")}'`;
  const result = await xrm.WebApi.retrieveMultipleRecords(INCIDENT, `?$select=incidentid&$filter=${filter}&$top=1`);
  const entityId = result?.entities?.[0]?.incidentid;
  if (typeof entityId !== "string" || entityId === "") throw new Error(`Обращение с диалогом ${conversationId} не найдено`);
  await xrm.Navigation.openForm({ entityName: INCIDENT, entityId }, { [FORM_TAB_PARAM]: QUALITY_TAB });
}

/** Экран приложения в области содержимого: тот же веб-ресурс с новым маршрутом. Не вышло — открываем здесь же. */
function openInContentArea(xrm, hash) {
  const pageInput = { pageType: "webresource", webresourceName: APP_WEB_RESOURCE, data: appPageData(hash) };
  Promise.resolve()
    .then(() => xrm.Navigation.navigateTo(pageInput, { target: TARGET_INLINE }))
    .catch(() => navigate(hash));
}

/** parent.Xrm — только если веб-ресурс открыт платформой того же origin (в Dynamics — всегда). */
function hostXrm() {
  try {
    if (window.parent === window) return null;
    const xrm = window.parent.Xrm;
    return xrm && typeof xrm === "object" ? xrm : null;
  } catch {
    return null; // родитель с другого origin: навигация остаётся внутри приложения
  }
}

/** Событие для страницы хоста (счётчик апелляций в карте сайта). Чужой origin сообщение не получит. */
function postToHost(type, detail) {
  try {
    if (window.parent === window) return;
    window.parent.postMessage({ source: MESSAGE_SOURCE, type, ...detail }, window.location.origin);
  } catch {
    // хост недоступен — счётчик обновится при следующем переходе
  }
}

/** data из адреса: пары key=value; редактор формы может закодировать значение ещё раз — раскодируем до двух раз. */
function parseData(value) {
  let text = typeof value === "string" ? value.trim() : "";
  for (let pass = 0; pass < MAX_DECODE_PASSES && !text.includes("=") && ENCODED_CHAR.test(text); pass += 1) {
    try {
      text = decodeURIComponent(text);
    } catch {
      break; // одиночный «%» — дальше раскодировать нечего
    }
  }
  return new URLSearchParams(text);
}
