// Понятные сообщения об ошибках API на языке панели: по коду ошибки бэкенда, иначе по HTTP-статусу.
// Известная ошибка → своя формулировка (код остаётся строкой «Код: …»); неизвестная → текст сервера.
// Коды — app/api/errors.py и app/errors.py; транспортные (network, client_timeout) — js/api.js.

const BY_CODE = Object.freeze({
  engine_unavailable: "errEngineUnavailable",
  evaluation_failed: "errEngineFailed",
  evaluation_invalid: "errEngineFailed",
  evaluation_timeout: "errTimeout",
  client_timeout: "errTimeout",
  network: "errNetwork",
  conversation_not_found: "errNotFound",
  dataset_not_found: "errNotFound",
  appeal_exists: "appealExists",
  evaluation_not_appealable: "errNotAppealable",
});
const BY_STATUS = Object.freeze({ 502: "errBadGateway", 503: "errUnavailable", 504: "errTimeout" });

/**
 * @param {{ code?: string, status?: number, message?: string } | null | undefined} error
 * @param {{ t: Function }} i18n
 * @param {{ groupId: string, conversationId: string }} context
 * @returns {{ text: string, code: string }}
 */
export function describeError(error, i18n, { groupId, conversationId }) {
  const code = typeof error?.code === "string" ? error.code : "";
  const key = BY_CODE[code] ?? BY_STATUS[error?.status];
  if (key) return { text: i18n.t(key, { id: conversationId, group: groupId }), code };
  const raw = typeof error?.message === "string" ? error.message.trim() : "";
  return { text: raw || i18n.t("errUnknown"), code };
}
