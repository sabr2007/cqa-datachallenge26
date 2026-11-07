// Страница веб-ресурса приложения CQA в области содержимого: заголовок вида и iframe
// cqa_/quality/index.html?data=host=d365&route=… — так открывает его пункт карты сайта типа «Веб-ресурс»
// и Xrm.Navigation.navigateTo({ pageType: "webresource" }, { target: 1 }). Прокрутка — внутри веб-ресурса.
// Фильтры и вкладки экрана живут в hash веб-ресурса: платформа запоминает его в своей записи истории,
// чтобы «Назад» и перезагрузка вернули экран как был.

import { h } from "../../js/dom.js";
import { APP_RESOURCE, appData, routeFromHash } from "./navigation.js";
import { WEB_RESOURCES } from "./xrmStub.js";

const TITLE_ID = "d365-view-title";

/**
 * @param {{ route: string, title: string, subtitle: string, onRouteChange: (route: string) => void }} options
 * @returns {{ el: HTMLElement, currentRoute: () => string, reload: () => void, focus: () => void }}
 */
export function createAppPage({ route, title, subtitle, onRouteChange }) {
  const heading = h("h1", { className: "d365-view__title", attrs: { id: TITLE_ID, tabindex: "-1" }, text: title });
  let lastRoute = route;
  const changed = () => {
    lastRoute = currentRoute();
    onRouteChange(lastRoute);
  };
  let frame = buildFrame(route, title, changed);
  const el = h("section", { className: "d365-view", attrs: { "aria-labelledby": TITLE_ID } },
    h("header", { className: "d365-view__head" },
      heading,
      subtitle ? h("p", { className: "d365-view__sub", text: subtitle }) : null),
    frame);

  /** Текущий экран веб-ресурса с фильтрами и вкладками (они в hash); пока веб-ресурс грузится — последний известный. */
  function currentRoute() {
    try {
      return routeFromHash(frame.contentWindow?.location.hash, lastRoute);
    } catch {
      return lastRoute; // веб-ресурс с другого origin: известен только маршрут, с которым его открыли
    }
  }

  return {
    el,
    currentRoute,
    /** «Обновить»: веб-ресурс загружается заново на том же экране. */
    reload() {
      lastRoute = currentRoute();
      const next = buildFrame(lastRoute, title, changed);
      frame.replaceWith(next);
      frame = next;
    },
    focus() {
      heading.focus({ preventScroll: true });
    },
  };
}

function buildFrame(route, title, onChange) {
  const url = new URL(WEB_RESOURCES[APP_RESOURCE], document.baseURI);
  url.searchParams.set("data", appData(route));
  const frame = h("iframe", {
    className: "d365-view__frame",
    attrs: { src: url.href, title: `${title} — веб-ресурс ${APP_RESOURCE}` },
  });
  frame.addEventListener("load", () => watchRoute(frame, onChange));
  return frame;
}

/**
 * Изменения hash веб-ресурса, в том числе через history.replaceState (фильтры), — через Navigation API.
 * Без него платформа запоминает экран при уходе со страницы (main.js, rememberAppRoute).
 */
function watchRoute(frame, onChange) {
  try {
    const navigation = frame.contentWindow?.navigation;
    if (typeof navigation?.addEventListener !== "function") return;
    navigation.addEventListener("currententrychange", onChange);
    onChange();
  } catch {
    // веб-ресурс с другого origin — его адрес платформе не виден
  }
}
