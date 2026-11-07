// Неизвестный адрес: объясняем и предлагаем выход — без тупиков.

import { h } from "../dom.js";
import { buildHash, paths } from "../router.js";
import { button, stateBlock } from "../components/ui.js";

/** @param {HTMLElement} main @param {object} ctx */
export function renderNotFound(main, ctx) {
  ctx.setTitle("Страница не найдена");
  main.replaceChildren(
    h("section", { className: "cqa-hero cqa-hero--compact", attrs: { "aria-labelledby": "cqa-page-title" } },
      h("div", { className: "cqa-container" },
        h("div", { className: "cqa-hero__copy" },
          h("h1", { className: "cqa-display", attrs: { id: "cqa-page-title", tabindex: "-1" }, text: "Страница не найдена" })))),
    h("div", { className: "cqa-sheet" },
      h("div", { className: "cqa-container" },
        stateBlock({
          kind: "empty",
          title: "Такого раздела нет",
          text: "Возможно, ссылка устарела или в ней опечатка. Выберите раздел:",
          actions: [
            button({ label: "К списку диалогов", href: buildHash(paths.conversations, { g: ctx.groupId }) }),
            button({ label: "Апелляции", variant: "gray", href: buildHash(paths.appeals, { g: ctx.groupId }) }),
            button({ label: "Открыть чек-лист", variant: "gray", href: buildHash(paths.checklist, { g: ctx.groupId }) }),
          ],
        }))));
}
