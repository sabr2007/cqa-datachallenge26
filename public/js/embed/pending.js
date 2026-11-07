// Отметка «оценка запущена» на время синхронного POST /api/evaluations (до 90 с).
// Форма Dynamics уничтожает и пересоздаёт веб-ресурс при переходе между вкладками: запрос из старого
// iframe обрывается, а сервер оценку досчитывает и сохраняет. Новый iframe по отметке понимает,
// что оценка уже идёт, и ждёт её результат вместо повторного запуска.
// sessionStorage — только удобство одного зрителя: без него панель работает, просто не «помнит» запуск.

const KEY_PREFIX = "cqa-embed:evaluating:";
/** Дольше таймаута POST /api/evaluations (150 с): ждём, пока сервер точно ответит или сохранит ошибку. */
export const PENDING_TTL_MS = 180_000;

/**
 * @typedef {{ startedAt: number, previousId: string }} PendingEvaluation
 * previousId — id последней оценки до запуска: новая оценка — это любая другая последняя.
 */

/** @param {string} groupId @param {string} conversationId @returns {PendingEvaluation | null} */
export function readPending(groupId, conversationId) {
  const raw = storage()?.getItem(key(groupId, conversationId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const fresh = Number.isFinite(value?.startedAt) && Date.now() - value.startedAt < PENDING_TTL_MS;
    if (fresh && typeof value.previousId === "string") return Object.freeze({ startedAt: value.startedAt, previousId: value.previousId });
  } catch {
    // повреждённая запись — удаляем ниже, как просроченную
  }
  clearPending(groupId, conversationId);
  return null;
}

/** @param {string} groupId @param {string} conversationId @param {PendingEvaluation} pending */
export function writePending(groupId, conversationId, pending) {
  try {
    storage()?.setItem(key(groupId, conversationId), JSON.stringify(pending));
  } catch {
    // квота или запрет хранилища: продолжим без отметки (худший случай — повторный запуск оценки)
  }
}

/** @param {string} groupId @param {string} conversationId */
export function clearPending(groupId, conversationId) {
  try {
    storage()?.removeItem(key(groupId, conversationId));
  } catch {
    // хранилище недоступно — отметки и не было
  }
}

function key(groupId, conversationId) {
  return `${KEY_PREFIX}${groupId}/${conversationId}`;
}

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null; // доступ к хранилищу запрещён политикой браузера или iframe
  }
}
