// Боковой (position: 2) и центральный (position: 1) диалог для Xrm.Navigation.navigateTo макета.
// Нативный <dialog> с showModal(): фон недоступен, Esc закрывает, фокус возвращается к команде.
// Промис navigateTo завершается при закрытии диалога — как в настоящем Client API.

import { h } from "../../js/dom.js";
import { hostIcon } from "./hostIcons.js";

const DEFAULT_WIDTH = "480px";

/** @param {HTMLElement} root */
export function createSidePanel(root) {
  const title = h("h2", { className: "d365-side__title", attrs: { id: "d365-side-title" } });
  const close = h("button", {
    className: "d365-icon-btn", attrs: { type: "button", "aria-label": "Закрыть панель", title: "Закрыть" },
  }, hostIcon("close"));
  const body = h("div", { className: "d365-side__body" });
  const dialog = h("dialog", { className: "d365-side", attrs: { "aria-labelledby": "d365-side-title" } },
    h("div", { className: "d365-side__head" }, title, close), body);
  root.append(dialog);

  let settle = null;
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    body.replaceChildren(); // веб-ресурс уничтожается вместе с диалогом
    settle?.();
    settle = null;
  });

  return {
    /** @param {{ url: string, title: string, width: unknown, position: 1 | 2 }} options */
    open({ url, title: text, width, position }) {
      if (dialog.open) dialog.close();
      title.textContent = text || "Веб-ресурс";
      dialog.classList.toggle("d365-side--center", position !== 2);
      dialog.style.setProperty("--d365-side-w", cssSize(width));
      const frame = h("iframe", { className: "d365-side__frame", attrs: { src: url, title: text || "Веб-ресурс" } });
      frame.addEventListener("load", () => closeOnEscapeInside(frame));
      body.replaceChildren(frame);
      dialog.showModal();
      return new Promise((resolve) => { settle = resolve; });
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };

  /** Esc при фокусе внутри веб-ресурса тоже закрывает панель — если там не открыт свой диалог. */
  function closeOnEscapeInside(frame) {
    try {
      frame.contentWindow.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (frame.contentDocument.querySelector("dialog[open]")) return; // сначала закрывается диалог веб-ресурса
        dialog.close();
      });
    } catch {
      // веб-ресурс с другого origin: Esc закрывает панель, когда фокус на её заголовке
    }
  }
}

/** Ширина navigateTo: число — пиксели, { value, unit: "px" | "%" } — как в Client API. */
function cssSize(width) {
  if (typeof width === "number" && width > 0) return `${width}px`;
  if (width && typeof width === "object" && Number.isFinite(width.value) && width.value > 0) {
    return width.unit === "%" ? `${width.value}vw` : `${width.value}px`;
  }
  return DEFAULT_WIDTH;
}
