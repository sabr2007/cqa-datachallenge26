// Экран «Чек-лист» (владелец — фронтенд «Чек-лист и аналитика», docs/CONTRACT.md).
// Просмотр версий, редактор с живым пересчётом, история изменений и переоценка набора — в public/js/admin/.

import { renderChecklistPage } from "../admin/checklistPage.js";

/** @param {HTMLElement} main @param {object} ctx @returns {() => void} */
export function renderChecklist(main, ctx) {
  return renderChecklistPage(main, ctx);
}
