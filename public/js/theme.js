// Тема интерфейса: светлая по умолчанию, выбор зрителя хранится в localStorage
// (только как удобство — без хранилища интерфейс работает так же).

const STORAGE_KEY = "cqa-theme";
const THEMES = Object.freeze(["light", "dark"]);

/** @returns {"light" | "dark"} */
export function readStoredTheme() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value) ? value : "light";
  } catch {
    return "light";
  }
}

/** @param {HTMLElement} root @param {"light" | "dark"} theme */
export function applyTheme(root, theme) {
  const next = THEMES.includes(theme) ? theme : "light";
  root.dataset.theme = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // хранилище недоступно (приватный режим, политика) — тема просто не запомнится
  }
  return next;
}

/** @param {HTMLElement} root */
export function currentTheme(root) {
  return root.dataset.theme === "dark" ? "dark" : "light";
}
