// Куда вернуться после входа: только путь внутри этого сайта (?next=/…).
// Абсолютные адреса, «//host», «/\host», другой origin и сама страница входа отбрасываются —
// страница входа не должна уводить на чужой сайт (open redirect) или зацикливаться.

const LOGIN_PAGE = "login.html";

/**
 * @param {string | null} raw значение параметра next
 * @param {string} pageUrl адрес страницы входа (location.href)
 * @returns {string} путь с query и hash того же origin; по умолчанию — корень приложения
 */
export function safeNext(raw, pageUrl) {
  const page = new URL(pageUrl);
  const fallback = new URL("./", page).pathname;
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return fallback;
  }
  let target;
  try {
    target = new URL(raw, page);
  } catch {
    return fallback;
  }
  if (target.origin !== page.origin || target.pathname.endsWith(`/${LOGIN_PAGE}`)) return fallback;
  return `${target.pathname}${target.search}${target.hash}`;
}
