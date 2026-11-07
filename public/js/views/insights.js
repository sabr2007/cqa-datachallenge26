// Экран «Аналитика» (владелец — фронтенд «Чек-лист и аналитика», docs/CONTRACT.md).
// Точность против эталона и «где ломается сценарий» — в public/js/admin/.

import { renderInsightsPage } from "../admin/insightsPage.js";

/** @param {HTMLElement} main @param {object} ctx @returns {() => void} */
export function renderInsights(main, ctx) {
  return renderInsightsPage(main, ctx);
}
