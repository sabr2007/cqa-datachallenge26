// Запись «Обращение» макета: диалог набора, представленный как запись Dataverse.
// В Dataverse у записи GUID, а id диалога из контакт-центра лежит в колонке cqa_conversationid —
// поэтому GUID здесь детерминированно выводится из id диалога (один и тот же при каждой загрузке).

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const GUID_SEEDS = Object.freeze([0x00000000, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]);

const NAME = "([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+)";
const INTRO_PATTERNS = Object.freeze([
  new RegExp(`(?:[Мм]еня зовут|[Мм]енің атым|[Mm]y name is)\\s+${NAME}`, "u"),
  new RegExp(`(?:^|[\\s,.!?])(?:я|Я|мен|Мен|I'm|I am|[Tt]his is)\\s+${NAME}`, "u"),
]);
const NOT_NAMES = new Set(["Вас", "Вам", "Ваш", "Ваша", "Вы", "Сіз", "Сізге", "Сізді"]);
const KZ_PREDICATE_SUFFIX = /(мын|мін|пын|пін)$/u;
const KZ_SUFFIX_MIN_NAME = 6;
const HIDDEN_NAME = /\[Имя скрыто\]/u;
const OPERATOR_LINES_TO_SCAN = 2;

/**
 * Детерминированный GUID записи по строке (FNV-1a с четырьмя затравками, формат v4).
 * @param {string} text @returns {string} "5B2A…-…" в верхнем регистре, как отдаёт Xrm
 */
export function guidFor(text) {
  const hex = GUID_SEEDS.map((seed) => fnv1a(text, seed).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`.toUpperCase();
}

/**
 * Элемент листинга → запись макета.
 * @param {object} item элемент fetchListing (api.js) @param {string} groupId
 */
export function recordFromListItem(item, groupId) {
  return Object.freeze({
    groupId,
    conversationId: item.id,
    guid: guidFor(`${groupId}/${item.id}`),
    title: item.preview || item.id,
    channel: item.channel,
    language: item.language,
    messageCount: item.messageCount,
    counts: item.counts,
    durationSec: item.durationSec,
    hasAudio: item.hasAudio,
    evaluation: item.evaluation,
  });
}

/**
 * Имя оператора из его первых реплик («я Алексей», «Мен Нұрланмын», «I'm Maya») — для шапки записи,
 * как поле «Владелец» в настоящей форме. Не найдено — "", имя скрыто в данных — "hidden".
 * @param {{ messages: ReadonlyArray<{ speaker: string, text: string }> }} conversation
 * @returns {string}
 */
export function operatorName(conversation) {
  const lines = conversation.messages.filter((message) => message.speaker === "operator").slice(0, OPERATOR_LINES_TO_SCAN);
  for (const { text } of lines) {
    for (const pattern of INTRO_PATTERNS) {
      const name = pattern.exec(text)?.[1];
      if (name && !NOT_NAMES.has(name)) {
        return name.length >= KZ_SUFFIX_MIN_NAME ? name.replace(KZ_PREDICATE_SUFFIX, "") : name;
      }
    }
    if (HIDDEN_NAME.test(text)) return "hidden";
  }
  return "";
}

function fnv1a(text, seed) {
  let hash = (FNV_OFFSET ^ seed) >>> 0;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}
