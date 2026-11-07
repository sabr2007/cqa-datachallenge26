// Запросы экранов «Чек-лист» и «Аналитика» поверх общего apiRequest (docs/CONTRACT.md, «API» и «Дополнения (v2)»).
// Ответы проверяются на границе: списки приходят как {"items": [...]}, лишние поля отбрасываются,
// отсутствующие получают безопасные значения. Документ чек-листа отдаётся как есть (редактору нужна исходная схема).

import { ApiError, apiRequest, apiUrl, isValidId } from "../api.js";

const TIMEOUT_MS = Object.freeze({
  checklist: 20_000,
  save: 30_000,
  listing: 150_000,
  evaluation: 20_000,
  evaluate: 240_000, // движок: до 90 с на диалог, плюс запас на очередь бэкенда
  metrics: 90_000,
  models: 15_000,
});

/* ---------- чек-листы ---------- */

/**
 * @typedef {{ version: number, createdAt: string, note: string, sandbox: boolean }} VersionInfo
 * @typedef {{ id: string, title: string, latestVersion: number | null, versions: VersionInfo[] }} ChecklistInfo
 * @returns {Promise<ChecklistInfo[]>}
 */
export async function listChecklists({ signal } = {}) {
  const body = await apiRequest("/api/checklists", { signal, timeoutMs: TIMEOUT_MS.checklist });
  return itemsOf(body, "список чек-листов").map(parseChecklistInfo).filter(Boolean);
}

/**
 * Документ версии чек-листа (по умолчанию — последней).
 * @param {string} checklistId @param {{ version?: number | null, signal?: AbortSignal }} [options]
 * @returns {Promise<object>}
 */
export async function getChecklist(checklistId, { version = null, signal } = {}) {
  assertId(checklistId, "checklist_id");
  const query = Number.isInteger(version) ? `?version=${version}` : "";
  const body = await apiRequest(`/api/checklists/${encodeURIComponent(checklistId)}${query}`, { signal, timeoutMs: TIMEOUT_MS.checklist });
  return parseChecklistDoc(body);
}

/**
 * Сохраняет документ новой версией. Версии неизменяемы: правка = новая версия.
 * @param {string} checklistId @param {object} payload документ без version + note (см. admin/model.js toPayload)
 * @returns {Promise<{ version: number | null, doc: object | null }>}
 */
export async function saveChecklistVersion(checklistId, payload, { signal } = {}) {
  assertId(checklistId, "checklist_id");
  const body = await apiRequest(`/api/checklists/${encodeURIComponent(checklistId)}/versions`,
    { method: "POST", body: payload, signal, timeoutMs: TIMEOUT_MS.save });
  const doc = isObject(body) && Array.isArray(body.criteria) ? parseChecklistDoc(body) : null;
  const version = intOrNull(body?.version) ?? intOrNull(body?.checklist?.version) ?? intOrNull(doc?.version);
  return { version, doc };
}

/* ---------- набор диалогов и оценки ---------- */

/**
 * @typedef {{ evaluationId: string, total: number | null, finalTotal: number | null, critical: boolean,
 *   needsReview: boolean, appealStatus: string, checklistVersion: number | null }} EvaluationSummary
 * @typedef {{ id: string, channel: string, language: string, preview: string, evaluation: EvaluationSummary | null }} GroupItem
 * @returns {Promise<{ groupId: string, items: GroupItem[] }>}
 */
export async function fetchGroupConversations(groupId, { signal } = {}) {
  assertId(groupId, "group_id");
  const body = await apiRequest(`/api/datasets/${encodeURIComponent(groupId)}/conversations`, { signal, timeoutMs: TIMEOUT_MS.listing });
  const items = itemsOf(body, "список диалогов").map(parseGroupItem).filter(Boolean);
  return { groupId: str(body.group_id) || groupId, items };
}

/**
 * Синхронная оценка одного диалога (сохраняется на бэкенде).
 * @param {{ groupId: string, conversationId: string, checklistId?: string, checklistVersion?: number,
 *   reusePrevious?: boolean, purpose?: "regular" | "sandbox", models?: string[] }} request
 */
export async function evaluateConversation(request, { signal } = {}) {
  const { groupId, conversationId, checklistId, checklistVersion, reusePrevious = true, purpose = "regular", models } = request;
  assertId(groupId, "group_id");
  assertId(conversationId, "conversation_id");
  const payload = {
    group_id: groupId,
    conversation_id: conversationId,
    ...(checklistId ? { checklist_id: checklistId } : {}),
    ...(Number.isInteger(checklistVersion) ? { checklist_version: checklistVersion } : {}),
    ...(Array.isArray(models) && models.length ? { models } : {}),
    reuse_previous: reusePrevious,
    purpose,
  };
  const body = await apiRequest("/api/evaluations", { method: "POST", body: payload, signal, timeoutMs: TIMEOUT_MS.evaluate });
  return parseEvaluation(body);
}

export async function getEvaluation(evaluationId, { signal } = {}) {
  assertId(evaluationId, "evaluation_id");
  const body = await apiRequest(`/api/evaluations/${encodeURIComponent(evaluationId)}`, { signal, timeoutMs: TIMEOUT_MS.evaluation });
  return parseEvaluation(body);
}

/** История оценок диалога, новые первыми. */
export async function listEvaluations(groupId, conversationId, { signal } = {}) {
  assertId(groupId, "group_id");
  assertId(conversationId, "conversation_id");
  const query = `group_id=${encodeURIComponent(groupId)}&conversation_id=${encodeURIComponent(conversationId)}`;
  const body = await apiRequest(`/api/evaluations?${query}`, { signal, timeoutMs: TIMEOUT_MS.evaluation });
  return itemsOf(body, "история оценок").map(safeParseEvaluation).filter(Boolean);
}

/** Ссылка на выгрузку последних оценок набора (JSON/CSV) — для сдачи контроля. */
export function exportUrl(groupId, format = "csv") {
  const safeFormat = format === "json" ? "json" : "csv";
  return apiUrl(`/api/export?group_id=${encodeURIComponent(groupId)}&format=${safeFormat}`);
}

/* ---------- метрики и аналитика ---------- */

/**
 * Точность оценки против эталона (eval/gold.json).
 * @param {{ groupId: string, checklistId?: string, checklistVersion?: number | null, purpose?: string }} query
 */
export async function getAccuracy({ groupId, checklistId, checklistVersion = null, purpose }, { signal } = {}) {
  assertId(groupId, "group_id");
  const params = new URLSearchParams({ group_id: groupId });
  if (checklistId) params.set("checklist_id", checklistId);
  if (Number.isInteger(checklistVersion)) params.set("checklist_version", String(checklistVersion));
  if (purpose) params.set("purpose", purpose);
  const body = await apiRequest(`/api/metrics/accuracy?${params}`, { signal, timeoutMs: TIMEOUT_MS.metrics });
  return parseAccuracy(body, groupId);
}

export async function getAnalytics(groupId, { signal } = {}) {
  assertId(groupId, "group_id");
  const body = await apiRequest(`/api/analytics?group_id=${encodeURIComponent(groupId)}`, { signal, timeoutMs: TIMEOUT_MS.metrics });
  return parseAnalytics(body, groupId);
}

/* ---------- разбор ответов ---------- */

function parseChecklistInfo(raw) {
  if (!isObject(raw) || !isNonEmpty(raw.id)) return null;
  const versions = (Array.isArray(raw.versions) ? raw.versions : [])
    .map((v) => (isObject(v) && Number.isInteger(v.version)
      ? Object.freeze({ version: v.version, createdAt: str(v.created_at), note: str(v.note), sandbox: v.sandbox === true })
      : null))
    .filter(Boolean)
    .sort((a, b) => b.version - a.version);
  return Object.freeze({
    id: raw.id,
    title: str(raw.title) || raw.id,
    latestVersion: intOrNull(raw.latest_version) ?? versions.find((v) => !v.sandbox)?.version ?? null,
    versions: Object.freeze(versions),
  });
}

function parseChecklistDoc(body) {
  if (!isObject(body) || !Array.isArray(body.criteria)) throw badShape("чек-лист");
  return deepFreeze(structuredClone(body));
}

function parseGroupItem(raw) {
  if (!isObject(raw) || !isValidId(raw.conversation_id)) return null;
  const ev = isObject(raw.evaluation) ? raw.evaluation : null;
  return Object.freeze({
    id: raw.conversation_id,
    channel: str(raw.channel),
    language: str(raw.language).toUpperCase(),
    preview: str(raw.preview),
    evaluation: ev && isNonEmpty(ev.evaluation_id) ? Object.freeze({
      evaluationId: ev.evaluation_id,
      total: num(ev.total),
      finalTotal: num(ev.final_total) ?? num(ev.total),
      critical: ev.critical === true,
      needsReview: ev.needs_review === true,
      appealStatus: str(ev.appeal_status),
      checklistVersion: intOrNull(ev.checklist_version),
    }) : null,
  });
}

/**
 * @typedef {{ criterionId: string, title: string, answerType: string, weight: number, critical: boolean, scored: boolean,
 *   answer: unknown, finalAnswer: unknown, points: number | null, maxPoints: number | null, finalPoints: number | null,
 *   explanation: string, evidence: Array<{ index: number, quote: string, verified: boolean }>, naReason: string,
 *   confidence: number | null, needsReview: boolean }} EvaluationCriterion
 */
function parseEvaluation(body) {
  if (!isObject(body) || !Array.isArray(body.criteria)) throw badShape("оценку");
  const criteria = body.criteria.filter((c) => isObject(c) && isNonEmpty(c.criterion_id)).map((c) => Object.freeze({
    criterionId: c.criterion_id,
    title: str(c.title),
    answerType: c.answer_type === "scale" ? "scale" : "yes_no",
    weight: num(c.weight) ?? 0,
    critical: c.critical === true,
    scored: c.scored !== false,
    answer: answerValue(c.answer),
    finalAnswer: answerValue(c.final_answer) ?? answerValue(c.answer),
    points: num(c.points),
    maxPoints: num(c.max_points),
    finalPoints: num(c.final_points) ?? num(c.points),
    explanation: str(c.explanation),
    evidence: Object.freeze((Array.isArray(c.evidence) ? c.evidence : [])
      .filter((e) => isObject(e) && Number.isInteger(e.index) && e.index >= 0)
      .map((e) => Object.freeze({ index: e.index, quote: str(e.quote), verified: e.verified === true }))),
    naReason: str(c.na_reason),
    confidence: num(c.confidence),
    needsReview: c.needs_review === true,
  }));
  return Object.freeze({
    id: str(body.id),
    groupId: str(body.group_id),
    conversationId: str(body.conversation_id),
    createdAt: str(body.created_at),
    checklistId: str(body.checklist_id),
    checklistVersion: intOrNull(body.checklist_version),
    purpose: str(body.purpose) || "regular",
    models: Object.freeze((Array.isArray(body.models) ? body.models : []).filter(isNonEmpty)),
    criteria: Object.freeze(criteria),
    total: num(body.total),
    finalTotal: num(body.final_total) ?? num(body.total),
    criticalFlag: body.critical_flag === true,
    criticalNote: str(body.critical_note),
    needsReview: body.needs_review === true,
    costUsd: num(body.cost_usd),
    latencyMs: num(body.latency_ms),
    status: body.status === "error" ? "error" : "done",
    error: isObject(body.error) ? str(body.error.message) : str(body.error),
  });
}

function safeParseEvaluation(raw) {
  try {
    return parseEvaluation(raw);
  } catch {
    return null;
  }
}

/** {matched, total, accuracy}; accuracy пересчитывается, если не пришла. */
function parseRate(raw) {
  if (!isObject(raw)) return null;
  const matched = count(raw.matched);
  const total = count(raw.total);
  const given = num(raw.accuracy);
  const accuracy = given !== null && given >= 0 && given <= 1 ? given : total > 0 ? matched / total : null;
  return Object.freeze({ matched, total, accuracy });
}

function parseAccuracy(body, groupId) {
  if (!isObject(body)) throw badShape("метрики точности");
  const bySet = isObject(body.by_set) ? body.by_set : {};
  const confusion = isObject(body.na_confusion) ? body.na_confusion : {};
  return Object.freeze({
    groupId: str(body.group_id) || groupId,
    checklistVersion: intOrNull(body.checklist_version),
    goldCount: count(body.gold_count),
    evaluatedCount: count(body.evaluated_count),
    overall: parseRate(body.overall),
    bySet: Object.freeze({ holdout: parseRate(bySet.holdout), tuning: parseRate(bySet.tuning) }),
    byCriterion: listOf(body.by_criterion).filter((r) => isNonEmpty(r.criterion_id)).map((r) => Object.freeze({
      criterionId: r.criterion_id, title: str(r.title), ...parseRate(r), holdout: parseRate(r.holdout), tuning: parseRate(r.tuning),
    })),
    byLanguage: listOf(body.by_language).filter((r) => isNonEmpty(r.language)).map((r) => Object.freeze({ language: r.language.toUpperCase(), ...parseRate(r) })),
    naConfusion: Object.freeze({
      naAsNo: count(confusion.na_as_no),
      noAsNa: count(confusion.no_as_na),
      byCriterion: listOf(confusion.by_criterion).filter((r) => isNonEmpty(r.criterion_id))
        .map((r) => Object.freeze({ criterionId: r.criterion_id, naAsNo: count(r.na_as_no), noAsNa: count(r.no_as_na) })),
    }),
    byModel: listOf(body.by_model).filter((r) => isNonEmpty(r.model)).map((r) => Object.freeze({ model: r.model, ...parseRate(r) })),
    expertAgreement: parseRate(body.expert_agreement),
    conversations: listOf(body.conversations).filter((r) => isValidId(r.conversation_id)).map((r) => Object.freeze({
      conversationId: r.conversation_id,
      language: str(r.language).toUpperCase(),
      set: r.set === "holdout" ? "holdout" : "tuning",
      evaluationId: str(r.evaluation_id),
      checklistVersion: intOrNull(r.checklist_version),
      matched: count(r.matched),
      total: count(r.total),
      mismatches: Object.freeze(listOf(r.mismatches).filter((m) => isNonEmpty(m.criterion_id))
        .map((m) => Object.freeze({ criterionId: m.criterion_id, gold: answerValue(m.gold), system: answerValue(m.system) }))),
    })),
  });
}

function parseAnalytics(body, groupId) {
  if (!isObject(body)) throw badShape("аналитику");
  const appeals = isObject(body.appeals) ? body.appeals : {};
  return Object.freeze({
    groupId: str(body.group_id) || groupId,
    evaluatedCount: count(body.evaluated_count),
    criteria: listOf(body.criteria).filter((c) => isNonEmpty(c.criterion_id)).map((c) => {
      const answers = isObject(c.answers) ? c.answers : {};
      const cAppeals = isObject(c.appeals) ? c.appeals : {};
      const applicable = count(c.applicable);
      const failCount = count(c.fail_count);
      const failRate = num(c.fail_rate);
      return Object.freeze({
        criterionId: c.criterion_id,
        title: str(c.title),
        answerType: c.answer_type === "scale" ? "scale" : "yes_no",
        applicable,
        answers: Object.freeze(Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, count(value)]))),
        failCount,
        failRate: failRate !== null && failRate >= 0 && failRate <= 1 ? failRate : applicable > 0 ? failCount / applicable : null,
        topQuotes: Object.freeze(listOf(c.top_quotes).filter((q) => isValidId(q.conversation_id)).map((q) => Object.freeze({
          conversationId: q.conversation_id,
          index: Number.isInteger(q.index) && q.index >= 0 ? q.index : null,
          quote: str(q.quote),
          explanation: str(q.explanation),
          count: Math.max(1, count(q.count)),
        }))),
        appeals: Object.freeze(appealStats(cAppeals)),
      });
    }),
    critical: listOf(body.critical).filter((c) => isValidId(c.conversation_id)).map((c) => Object.freeze({
      conversationId: c.conversation_id,
      evaluationId: str(c.evaluation_id),
      note: str(c.note),
      index: Number.isInteger(c.index) && c.index >= 0 ? c.index : null,
      quote: str(c.quote),
    })),
    appeals: Object.freeze({ total: count(appeals.total), resolved: count(appeals.resolved), accepted: count(appeals.accepted) }),
  });
}

/** Апелляции: принятые (решение «изменить») к решённым; rate пересчитывается, если не пришёл. */
function appealStats(raw) {
  const total = count(raw.total);
  const resolved = Number.isInteger(raw.resolved) && raw.resolved >= 0 ? raw.resolved : total;
  const accepted = count(raw.accepted);
  const given = num(raw.rate);
  return { total, resolved, accepted, rate: given !== null && given >= 0 && given <= 1 ? given : resolved > 0 ? accepted / resolved : null };
}

/* ---------- мелочи ---------- */

function itemsOf(body, what) {
  if (Array.isArray(body)) return body; // терпимо к старой форме
  if (isObject(body) && Array.isArray(body.items)) return body.items;
  throw badShape(what);
}

function listOf(value) {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function answerValue(value) {
  if (value === "yes" || value === "no" || value === "na") return value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assertId(value, kind) {
  if (!isValidId(value)) {
    throw new ApiError({ code: `invalid_${kind}`, message: `Некорректный ${kind}: допустимы латинские буквы, цифры, «_» и «-», до 64 символов.`, status: 400 });
  }
}

function badShape(what) {
  return new ApiError({ code: "bad_response", message: `Сервер вернул ${what} в неожиданном формате.` });
}

function deepFreeze(value) {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function str(value) {
  return typeof value === "string" ? value : "";
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
