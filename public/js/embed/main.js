// Точка входа встраиваемой панели оценки (HTML web resource Dynamics 365).
// Ограничения веб-ресурса: только относительные пути, без inline-скриптов, обработчиков в разметке,
// eval и внешних CDN; всё монтируется в #cqa-root под .cqa. Инициализация повторяемая:
// форма пересоздаёт iframe при смене вкладок, а из bfcache страница возвращается без перезагрузки.

import { configureApi } from "../api.js";
import { resolveContext } from "./context.js";
import { createI18n } from "./i18n.js";
import { createPanel } from "./panel.js";

const ROOT_ID = "cqa-root";
const DEFAULT_APP_URL = "index.html";
/** Имя веб-ресурса: буквы, цифры, «_», «.» и «/» — как требует Dynamics. */
const WEB_RESOURCE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./]{0,199}$/;

let mounted = null;

function mount() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  mounted?.destroy();
  configureApi({ base: root.dataset.apiBase ?? "" });
  const context = resolveContext(window);
  const i18n = createI18n(context.lang);
  document.documentElement.lang = i18n.htmlLang;
  document.title = i18n.t("title");
  root.lang = i18n.htmlLang;
  mounted = createPanel(root, {
    context, i18n, appUrl: safeAppUrl(root.dataset.appUrl), appResource: safeWebResource(root.dataset.appWebresource),
  });
}

/** Веб-ресурс приложения для «Полной карточки» в области содержимого; пусто — карточка в новой вкладке. */
function safeWebResource(value) {
  const name = String(value ?? "").trim();
  return WEB_RESOURCE_NAME.test(name) ? name : "";
}

/** Адрес основного приложения для «Полной карточки»: относительный путь или http(s); иначе — по умолчанию. */
function safeAppUrl(value) {
  const candidate = String(value ?? "").trim() || DEFAULT_APP_URL;
  try {
    const url = new URL(candidate, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? candidate : DEFAULT_APP_URL;
  } catch {
    return DEFAULT_APP_URL; // некорректный адрес в конфигурации — ведём на приложение рядом с веб-ресурсом
  }
}

window.addEventListener("pagehide", () => {
  mounted?.destroy();
  mounted = null;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted || !mounted) mount();
});

mount();
