// Подписи, склонения и форматирование чисел/времени. Чистые функции без DOM.

export const LANGUAGES = Object.freeze(["RU", "KZ", "EN"]);
export const CHANNELS = Object.freeze(["chat", "call"]);
export const SPEAKERS = Object.freeze(["client", "operator", "bot", "system"]);

const LANGUAGE_NAMES = { RU: "Русский", KZ: "Қазақша", EN: "English" };
const CHANNEL_NAMES = { chat: "Чат", call: "Звонок" };
const SPEAKER_NAMES = { client: "Клиент", operator: "Оператор", bot: "Бот", system: "Система" };

/** Номер реплики для людей. В URL и id элемента остаётся исходный index из API. */
export const MESSAGE_NUMBER_BASE = 1;

/** @param {number} index @returns {number} */
export function messageNumber(index) {
  return index + MESSAGE_NUMBER_BASE;
}

/** @param {string} code @returns {string} */
export function languageName(code) {
  return LANGUAGE_NAMES[code] ?? code;
}

/** @param {string} channel @returns {string} */
export function channelName(channel) {
  return CHANNEL_NAMES[channel] ?? channel;
}

/** @param {string} speaker @returns {string} */
export function speakerName(speaker) {
  return SPEAKER_NAMES[speaker] ?? speaker;
}

/**
 * Русское склонение: plural(5, ["реплика", "реплики", "реплик"]) → "реплик".
 * @param {number} n @param {[string, string, string]} forms @returns {string}
 */
export function plural(n, [one, few, many]) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** @param {number} n @param {[string, string, string]} forms @returns {string} */
export function countLabel(n, forms) {
  return `${formatInt(n)} ${plural(n, forms)}`;
}

export const FORMS = Object.freeze({
  dialog: ["диалог", "диалога", "диалогов"],
  chat: ["чат", "чата", "чатов"],
  call: ["звонок", "звонка", "звонков"],
  message: ["реплика", "реплики", "реплик"],
  criterion: ["критерий", "критерия", "критериев"],
  section: ["секция", "секции", "секций"],
  point: ["балл", "балла", "баллов"],
  second: ["секунда", "секунды", "секунд"],
  appeal: ["апелляция", "апелляции", "апелляций"],
  evaluation: ["оценка", "оценки", "оценок"],
  model: ["модель", "модели", "моделей"],
  error: ["ошибка", "ошибки", "ошибок"],
});

const intFormat = new Intl.NumberFormat("ru-RU");
const decimalFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 0 });
const usdFormat = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdSmallFormat = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** @param {number} n @returns {string} */
export function formatInt(n) {
  return intFormat.format(n);
}

/** @param {number} n @returns {string} */
export function formatDecimal(n) {
  return decimalFormat.format(n);
}

/** Баллы: 18.75 → "18,75"; null (N/A, без баллов) → "—". */
export function formatPoints(value) {
  return typeof value === "number" && Number.isFinite(value) ? decimalFormat.format(value) : "—";
}

/** Доля 0..1 → "67 %". */
export function formatPercent(share) {
  return typeof share === "number" && Number.isFinite(share) ? percentFormat.format(share) : "—";
}

/** Стоимость оценки: 0.042 → "0,042 $", 1.5 → "1,50 $"; неизвестно → "". */
export function formatCost(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return "";
  if (usd > 0 && usd < 0.001) return `< ${usdSmallFormat.format(0.001)}`;
  return usd < 1 ? usdSmallFormat.format(usd) : usdFormat.format(usd);
}

/** Длительность в миллисекундах для подписей: 38000 → "38 с". */
export function formatElapsedMs(ms) {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? formatDurationLong(ms / 1000) : "";
}

/** ISO-время → "7 нояб., 20:00" в поясе браузера; без даты — "". */
export function formatDateTime(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const ANSWER_LABELS = Object.freeze({ yes: "Да", no: "Нет", na: "N/A" });
const CRITICAL_LABELS = Object.freeze({ yes: "Есть нарушение", no: "Нарушений нет", na: "N/A" });

/**
 * Ответ по критерию для людей. Для критического критерия (08) «Да» означает «нарушение есть».
 * @param {"yes" | "no" | "na" | number | null} answer
 * @param {{ critical?: boolean, maxStep?: number | null }} [options]
 * @returns {string}
 */
export function answerLabel(answer, { critical = false, maxStep = null } = {}) {
  if (answer === null || answer === undefined) return "—";
  if (typeof answer === "number") return maxStep ? `${formatInt(answer)} из ${formatInt(maxStep)}` : formatInt(answer);
  const labels = critical ? CRITICAL_LABELS : ANSWER_LABELS;
  return labels[answer] ?? String(answer);
}

/**
 * Длительность для бейджей: 399 → "6:39", 3723 → "1:02:03".
 * @param {number | null | undefined} sec @returns {string}
 */
export function formatDuration(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "—";
  const total = Math.round(sec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Развёрнутая длительность для подписей: "6 мин 39 с". */
export function formatDurationLong(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "";
  const total = Math.round(sec);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} с`;
  return seconds === 0 ? `${minutes} мин` : `${minutes} мин ${seconds} с`;
}

const ISO_TIME = /T(\d{2}:\d{2}:\d{2})/;

/** Звонки приходят в ISO 8601; показываем ЧЧ:ММ:СС из исходной строки без пересчёта поясов. */
export function isIsoTimestamp(value) {
  return typeof value === "string" && ISO_TIME.test(value);
}

/** @param {string} value @returns {string} */
export function clockFromTimestamp(value) {
  const match = typeof value === "string" ? value.match(ISO_TIME) : null;
  return match ? match[1] : String(value ?? "");
}

/** @param {string} iso @returns {string} */
export function formatFetchedAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** Нормализация для поиска: регистр, ё → е, лишние пробелы. */
export function normalizeForSearch(value) {
  return String(value ?? "").toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").trim();
}

/** Двузначный номер критерия из id: "c04" → "04". */
export function criterionNumber(id, fallbackIndex) {
  const match = /(\d+)$/.exec(String(id ?? ""));
  return match ? match[1].padStart(2, "0") : String(fallbackIndex + 1).padStart(2, "0");
}
