// Навигация области содержимого макета — как в model-driven app: у страницы свой адрес (pagetype),
// переходы по карте сайта, Xrm.Navigation.openForm и navigateTo (target: 1) кладут страницу в историю
// браузера, «Назад» (команда или кнопка браузера) возвращает к предыдущей.
//
// Страницы:
//   { type: "app", route: "/conversations?g=DEV" }          веб-ресурс приложения CQA (cqa_/quality/index.html)
//   { type: "record", record: "p1-ru-009", tab: "quality" }  форма записи «Обращение» (record "" — новая запись)
//   { type: "cases" }                                         представление «Активные обращения»
// Адрес повторяет main.aspx: ?pagetype=webresource&webresourceName=…&data=… и ?pagetype=entityrecord&etn=incident&…
// (record — id диалога, а не GUID записи: так адрес стенда читаемее).

export const APP_RESOURCE = "cqa_/quality/index.html";
const HOST = "d365";
const ENTITY = "incident";
const ROUTE_PATTERN = /^\/[^\s#]{0,500}$/;
const RECORD_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DECODE_PASSES = 2;
const PAGE_TYPES = Object.freeze({ app: "webresource", record: "entityrecord", cases: "entitylist" });

/** Пункты «Качество (CQA)» карты сайта → экраны приложения CQA. */
export const QUALITY_VIEWS = Object.freeze([
  Object.freeze({ id: "conversations", path: "/conversations", label: "Оценки диалогов", title: "Оценки диалогов", icon: "quality" }),
  Object.freeze({ id: "appeals", path: "/appeals", label: "Апелляции", title: "Апелляции", icon: "flag" }),
  Object.freeze({ id: "checklist", path: "/checklist", label: "Чек-лист", title: "Чек-лист оценки", icon: "checklist" }),
  Object.freeze({ id: "insights", path: "/insights", label: "Аналитика", title: "Аналитика качества", icon: "chart" }),
]);
export const CASES_VIEW = "cases";

/** @param {string} route "/appeals?g=DEV" */
export function appPage(route) {
  return Object.freeze({ type: "app", route });
}

/** @param {string} record id диалога ("" — новая запись) @param {string} tab */
export function recordPage(record, tab) {
  return Object.freeze({ type: "record", record, tab });
}

export function casesPage() {
  return Object.freeze({ type: "cases" });
}

/** Страница пункта карты сайта. @param {string} id @param {string} group */
export function sitemapPage(id, group) {
  if (id === CASES_VIEW) return casesPage();
  const view = QUALITY_VIEWS.find((item) => item.id === id) ?? QUALITY_VIEWS[0];
  return appPage(`${view.path}?g=${encodeURIComponent(group)}`);
}

/** Какой пункт карты сайта подсветить; null — страница вне карты сайта (полная карточка диалога). */
export function sitemapIdOf(page) {
  if (page.type !== "app") return CASES_VIEW;
  const path = routePath(page.route);
  return QUALITY_VIEWS.find((view) => view.path === path)?.id ?? (path === "/" ? QUALITY_VIEWS[0].id : null);
}

/** Пункт «Качество (CQA)» по маршруту приложения (или undefined). */
export function qualityViewOf(route) {
  return QUALITY_VIEWS.find((view) => view.path === routePath(route));
}

/** id диалога, если маршрут — полная карточка (#/c/<id>). */
export function cardIdOf(route) {
  const match = /^\/c\/([^/?]+)$/.exec(routePath(route));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

/** Набор диалогов (g) из маршрута приложения. */
export function groupOf(route, fallback) {
  const query = route.includes("?") ? route.slice(route.indexOf("?") + 1) : "";
  return new URLSearchParams(query).get("g") || fallback;
}

/** data веб-ресурса приложения: признак хоста и маршрут экрана (так же собирает js/host.js). */
export function appData(route) {
  return new URLSearchParams({ host: HOST, route }).toString();
}

/** Маршрут экрана из data веб-ресурса приложения ("" — не задан или некорректен). */
export function routeFromData(data) {
  let text = typeof data === "string" ? data.trim() : "";
  for (let pass = 0; pass < MAX_DECODE_PASSES && !text.includes("=") && /%[0-9A-Fa-f]{2}/.test(text); pass += 1) {
    try {
      text = decodeURIComponent(text);
    } catch {
      break;
    }
  }
  const route = new URLSearchParams(text).get("route")?.trim() ?? "";
  return ROUTE_PATTERN.test(route) ? route : "";
}

/** Маршрут из hash окна веб-ресурса ("#/appeals?g=DEV" → "/appeals?g=DEV"), иначе fallback. */
export function routeFromHash(hash, fallback) {
  const route = String(hash ?? "").replace(/^#/, "");
  return ROUTE_PATTERN.test(route) ? route : fallback;
}

/** Адрес страницы стенда (search-часть). */
export function pageUrl(page, lcid) {
  const params = new URLSearchParams({ pagetype: PAGE_TYPES[page.type] });
  if (page.type === "app") {
    params.set("webresourceName", APP_RESOURCE);
    params.set("data", appData(page.route));
  } else {
    params.set("etn", ENTITY);
    if (page.type === "record") {
      if (page.record) params.set("record", page.record);
      params.set("tab", page.tab);
    }
  }
  params.set("lang", String(lcid));
  return `${window.location.pathname}?${params}`;
}

/**
 * Страница из адреса. Старые ссылки стенда (?record=…&tab=…) открывают форму записи.
 * @param {URLSearchParams} params
 * @param {{ fallback: object, tabs: ReadonlyArray<string>, defaultTab: string }} options
 */
export function pageFromParams(params, { fallback, tabs, defaultTab }) {
  const type = params.get("pagetype") ?? (params.has("record") ? PAGE_TYPES.record : "");
  const tab = tabs.includes(params.get("tab")) ? params.get("tab") : defaultTab;
  if (type === PAGE_TYPES.record) {
    const record = params.get("record") ?? "";
    if (record === "") return recordPage("", tab);
    return RECORD_PATTERN.test(record) ? recordPage(record, tab) : fallback;
  }
  if (type === PAGE_TYPES.cases) return casesPage();
  if (type === PAGE_TYPES.app && params.get("webresourceName") === APP_RESOURCE) {
    const route = routeFromData(params.get("data"));
    if (route) return appPage(route);
  }
  return fallback;
}

/**
 * История переходов поверх истории браузера: каждая страница — запись pushState со своим адресом.
 * После перезагрузки страница и глубина истории восстанавливаются из history.state.
 * @param {{ initial: object, lcid: () => number, onShow: (page: object, info: { initial: boolean }) => void }} options
 */
export function createHistory({ initial, lcid, onShow }) {
  let index = 0;
  const write = (method, page) => window.history[method]({ d365: true, index, page }, "", pageUrl(page, lcid()));

  window.addEventListener("popstate", (event) => {
    const saved = event.state;
    if (!saved?.d365 || !isPage(saved.page)) return;
    index = Number.isInteger(saved.index) ? saved.index : 0;
    onShow(saved.page, { initial: false });
  });

  return {
    start() {
      const saved = window.history.state;
      const restored = saved?.d365 && isPage(saved.page);
      index = restored && Number.isInteger(saved.index) ? saved.index : 0;
      const page = restored ? saved.page : initial;
      write("replaceState", page);
      onShow(page, { initial: true });
    },
    /** Новая страница поверх текущей. */
    push(page) {
      index += 1;
      write("pushState", page);
      onShow(page, { initial: false });
    },
    /** Та же запись истории, страница открывается заново (повторный клик по текущему пункту карты сайта). */
    replace(page) {
      write("replaceState", page);
      onShow(page, { initial: false });
    },
    /** Текущая страница изменилась на месте (вкладка формы, фильтры экрана, язык) — без новой записи. */
    update(page) {
      write("replaceState", page);
    },
    back() {
      if (index > 0) window.history.back();
    },
    canGoBack() {
      return index > 0;
    },
  };
}

function routePath(route) {
  const value = String(route ?? "");
  const end = value.indexOf("?");
  return end === -1 ? value : value.slice(0, end);
}

function isPage(page) {
  if (!page || typeof page !== "object") return false;
  if (page.type === "app") return typeof page.route === "string" && ROUTE_PATTERN.test(page.route);
  if (page.type === "record") return typeof page.record === "string" && typeof page.tab === "string";
  return page.type === "cases";
}
