// Подписи и форматирование для экранов «Чек-лист» и «Аналитика». Чистые функции без DOM.

const decimal = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const decimalFixed = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const MINUS = "−";

/** Ответ по критерию для людей: Да / Нет / N/A / число ступени. */
export function answerLabel(answer) {
  if (answer === "yes") return "Да";
  if (answer === "no") return "Нет";
  if (answer === "na") return "N/A";
  if (typeof answer === "number" && Number.isFinite(answer)) return decimal.format(answer);
  return "—";
}

/**
 * Тон ответа для цвета: good / bad / na / partial / none.
 * Для грубых ошибок (critical) «Да» — плохо.
 */
export function answerTone(answer, { critical = false, top = null } = {}) {
  if (answer === "na") return "na";
  if (answer === "yes") return critical ? "bad" : "good";
  if (answer === "no") return critical ? "good" : "bad";
  if (typeof answer === "number") {
    if (top !== null && answer >= top) return "good";
    return answer > 0 ? "partial" : "bad";
  }
  return "none";
}

/** Балл: 81,25; null → «—». */
export function formatScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? decimal.format(value) : "—";
}

/** Балл с двумя знаками для колонок: 81,20. */
export function formatScoreFixed(value) {
  return typeof value === "number" && Number.isFinite(value) ? decimalFixed.format(value) : "—";
}

/** Разница с явным знаком и настоящим минусом: +2,5 / −1,25 / 0. */
export function formatDelta(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : MINUS}${decimal.format(Math.abs(rounded))}`;
}

/** Доля 0..1 → «82%»; null → «—». */
export function formatPercent(share) {
  return typeof share === "number" && Number.isFinite(share) ? `${percentFormat.format(share * 100)}%` : "—";
}

/** Разница долей в процентных пунктах: +4 п. п. */
export function formatPointsDelta(delta) {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return "";
  const pp = Math.round(delta * 100);
  if (pp === 0) return "0 п. п.";
  return `${pp > 0 ? "+" : MINUS}${Math.abs(pp)} п. п.`;
}

export function versionLabel(version) {
  return Number.isInteger(version) ? `v${version}` : "—";
}

/** «7 ноя, 20:15» в локальном времени; пустая строка, если дата не разбирается. */
export function formatDateTime(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  const day = date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

/** Секунды → «1 мин 05 с» для оценки оставшегося времени. */
export function formatEta(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} с`;
  return `${minutes} мин ${String(rest).padStart(2, "0")} с`;
}

export const SET_NAMES = Object.freeze({ holdout: "Отложенные", tuning: "Настроечные" });
export const LANGUAGE_NAMES = Object.freeze({ RU: "Русский", KZ: "Қазақша", EN: "English" });
