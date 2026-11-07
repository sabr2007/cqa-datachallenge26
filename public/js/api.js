// Единственная точка обращения к бэкенду. API_BASE настраивается (по умолчанию "" —
// тот же origin); ответы проверяются на границе и приводятся к неизменяемым объектам.
// Контракт — docs/CONTRACT.md: поля snake_case из API здесь становятся camelCase.

import { summarizeEvaluation } from "./evaluation.js";
import { CHANNELS, SPEAKERS } from "./format.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Оценка синхронная: движок укладывается в ~90 с, сервер обрывает её на 150 с и сам отвечает 504 —
// клиент ждёт чуть дольше, чтобы получить ответ сервера, а не собственный таймаут.
const TIMEOUT_MS = Object.freeze({
  dataset: 150_000, conversation: 150_000, checklist: 20_000, health: 8_000,
  evaluate: 165_000, read: 20_000, write: 30_000,
});
const CONVERSATION_CACHE_LIMIT = 40;
const STATUS_MESSAGES = Object.freeze({
  400: "Некорректный запрос.",
  404: "Не найдено.",
  409: "Данные уже изменились: обновите экран.",
  502: "Источник данных вернул ошибку. Попробуйте позже.",
  503: "Сервис временно недоступен.",
  504: "Источник данных не ответил вовремя. Попробуйте ещё раз.",
});
const ANSWERS = Object.freeze(["yes", "no", "na"]);

let apiBase = "";
const listingCache = new Map();
const conversationCache = new Map();
const checklistVersionCache = new Map();
let checklistCache = null;
let modelsCache = null;

export class ApiError extends Error {
  /** @param {{ code: string, message: string, status?: number }} init */
  constructor({ code, message, status = 0 }) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** @param {{ base?: string }} options */
export function configureApi({ base = "" } = {}) {
  apiBase = String(base ?? "").trim().replace(/\/+$/, "");
}

/** URL ресурса API: абсолютный http(s) — как есть, путь — от API_BASE. */
export function apiUrl(path) {
  const value = String(path ?? "");
  if (/^https?:\/\//i.test(value)) return value;
  return `${apiBase}${value.startsWith("/") ? "" : "/"}${value}`;
}

/** @param {unknown} value @returns {boolean} */
export function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** @param {unknown} error @returns {boolean} */
export function isAbortError(error) {
  return error instanceof ApiError && error.code === "aborted";
}

export function peekListing(groupId) {
  return listingCache.get(groupId) ?? null;
}

export function peekConversation(groupId, id) {
  return conversationCache.get(`${groupId}/${id}`) ?? null;
}

export function peekChecklist() {
  return checklistCache;
}

export async function fetchListing(groupId, { signal, refresh = false } = {}) {
  assertId(groupId, "group_id");
  const query = refresh ? "?refresh=true" : "";
  const body = await requestJson(`/api/datasets/${encodeURIComponent(groupId)}/conversations${query}`,
    { signal, timeoutMs: TIMEOUT_MS.dataset });
  const listing = parseListing(body, groupId);
  listingCache.set(groupId, listing);
  if (refresh) dropConversations(groupId);
  return listing;
}

export async function fetchConversation(groupId, id, { signal } = {}) {
  assertId(groupId, "group_id");
  assertId(id, "conversation_id");
  const path = `/api/datasets/${encodeURIComponent(groupId)}/conversations/${encodeURIComponent(id)}`;
  const conversation = parseConversation(await requestJson(path, { signal, timeoutMs: TIMEOUT_MS.conversation }));
  rememberConversation(`${groupId}/${id}`, conversation);
  return conversation;
}

/** Последняя версия чек-листа по умолчанию. */
export async function fetchChecklist({ signal } = {}) {
  const body = await requestJson("/api/checklists/default", { signal, timeoutMs: TIMEOUT_MS.checklist });
  checklistCache = parseChecklist(body);
  return checklistCache;
}

/**
 * Конкретная версия чек-листа (по ней сделана оценка: ступени шкалы, условия N/A).
 * Версии неизменяемы — кешируются навсегда. Не удалось получить — null (экран работает и без неё).
 */
export async function fetchChecklistVersion(checklistId, version, { signal } = {}) {
  if (!isValidId(checklistId) || !Number.isInteger(version)) return null;
  const key = `${checklistId}@${version}`;
  if (checklistVersionCache.has(key)) return checklistVersionCache.get(key);
  try {
    const body = await requestJson(`/api/checklists/${encodeURIComponent(checklistId)}?version=${version}`,
      { signal, timeoutMs: TIMEOUT_MS.checklist });
    const checklist = parseChecklist(body);
    checklistVersionCache.set(key, checklist);
    return checklist;
  } catch (error) {
    if (isAbortError(error)) throw error;
    const fallback = checklistCache ?? await fetchChecklist({ signal }).catch(() => null);
    return fallback && fallback.id === checklistId && fallback.version === version ? fallback : null;
  }
}

export async function fetchHealth({ signal } = {}) {
  const body = await requestJson("/api/health", { signal, timeoutMs: TIMEOUT_MS.health });
  return isObject(body) && body.ok === true;
}

/* ---------- модели и оценки ---------- */

/** Подпись модели по id из уже загруженного списка (или сам id). */
export function modelLabel(modelId) {
  return modelsCache?.find((model) => model.id === modelId)?.label ?? modelId;
}

/** Модели оценки и их доступность; кешируется на сессию. */
export async function fetchModels({ signal } = {}) {
  if (modelsCache) return modelsCache;
  const body = await requestJson("/api/models", { signal, timeoutMs: TIMEOUT_MS.read });
  modelsCache = Object.freeze(listOf(body, "список моделей").map(parseModel).filter(Boolean));
  return modelsCache;
}

/**
 * Запуск оценки диалога (синхронно, 30–90 с). Пустой models — модели по умолчанию сервера.
 * @param {{ groupId: string, conversationId: string, models?: string[] | null, checklistId?: string, checklistVersion?: number, reusePrevious?: boolean }} request
 */
export async function evaluateConversation(request, { signal } = {}) {
  assertId(request.groupId, "group_id");
  assertId(request.conversationId, "conversation_id");
  const payload = {
    group_id: request.groupId,
    conversation_id: request.conversationId,
    ...(request.checklistId ? { checklist_id: request.checklistId } : {}),
    ...(Number.isInteger(request.checklistVersion) ? { checklist_version: request.checklistVersion } : {}),
    ...(request.models?.length ? { models: [...request.models] } : {}),
    ...(request.reusePrevious ? { reuse_previous: true } : {}),
  };
  const evaluation = parseEvaluation(await requestJson("/api/evaluations",
    { method: "POST", body: payload, signal, timeoutMs: TIMEOUT_MS.evaluate }));
  rememberEvaluation(evaluation);
  return evaluation;
}

/** История оценок диалога (новые первыми); оценки песочницы чек-листа сюда не входят. */
export async function fetchEvaluations(groupId, conversationId, { signal } = {}) {
  assertId(groupId, "group_id");
  assertId(conversationId, "conversation_id");
  const query = `group_id=${encodeURIComponent(groupId)}&conversation_id=${encodeURIComponent(conversationId)}`;
  const body = await requestJson(`/api/evaluations?${query}`, { signal, timeoutMs: TIMEOUT_MS.read });
  const items = listOf(body, "историю оценок").map(parseEvaluationSafe).filter(Boolean);
  return Object.freeze(items.filter((evaluation) => evaluation.purpose !== "sandbox")
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)));
}

export async function fetchEvaluation(evaluationId, { signal } = {}) {
  assertId(evaluationId, "evaluation_id");
  return parseEvaluation(await requestJson(`/api/evaluations/${encodeURIComponent(evaluationId)}`,
    { signal, timeoutMs: TIMEOUT_MS.read }));
}

/* ---------- апелляции ---------- */

/** @param {string} evaluationId @param {{ criterionId: string, comment: string }} appeal */
export async function createAppeal(evaluationId, { criterionId, comment }, { signal } = {}) {
  assertId(evaluationId, "evaluation_id");
  const body = await requestJson(`/api/evaluations/${encodeURIComponent(evaluationId)}/appeals`, {
    method: "POST", body: { criterion_id: criterionId, comment }, signal, timeoutMs: TIMEOUT_MS.write,
  });
  return parseAppeal(body);
}

/**
 * Очередь апелляций набора.
 * @param {string} groupId
 * @param {{ status?: "open" | "resolved" | "", evaluationId?: string, conversationId?: string, signal?: AbortSignal }} [options]
 */
export async function fetchAppeals(groupId, { status = "", evaluationId = "", conversationId = "", signal } = {}) {
  assertId(groupId, "group_id");
  const query = new URLSearchParams({ group_id: groupId });
  if (status) query.set("status", status);
  if (evaluationId) query.set("evaluation_id", evaluationId);
  if (conversationId) query.set("conversation_id", conversationId);
  const body = await requestJson(`/api/appeals?${query}`, { signal, timeoutMs: TIMEOUT_MS.read });
  return Object.freeze(listOf(body, "очередь апелляций").map(parseAppealSafe).filter(Boolean));
}

/** Количество открытых апелляций набора (для шапки); ошибка — null. */
export async function countOpenAppeals(groupId, { signal } = {}) {
  try {
    return (await fetchAppeals(groupId, { status: "open", signal })).length;
  } catch {
    return null;
  }
}

/**
 * Решение проверяющего → { appeal, evaluation } с пересчитанными final_*.
 * @param {string} appealId
 * @param {{ action: "confirm" | "change", newAnswer?: "yes" | "no" | "na" | number, reason: string }} decision
 */
export async function decideAppeal(appealId, { action, newAnswer, reason }, { signal } = {}) {
  assertId(appealId, "appeal_id");
  const payload = { action, reason, ...(action === "change" ? { new_answer: newAnswer } : {}) };
  const body = await requestJson(`/api/appeals/${encodeURIComponent(appealId)}/decision`,
    { method: "POST", body: payload, signal, timeoutMs: TIMEOUT_MS.write });
  if (!isObject(body)) throw badShape("решение по апелляции");
  const evaluation = parseEvaluation(body.evaluation);
  rememberEvaluation(evaluation);
  return Object.freeze({ appeal: parseAppeal(body.appeal), evaluation });
}

/** Ссылка на выгрузку последних оценок набора (обычная загрузка файла с нашего сервера). */
export function exportUrl(groupId, format) {
  const safeFormat = format === "csv" ? "csv" : "json";
  return apiUrl(`/api/export?group_id=${encodeURIComponent(groupId)}&format=${safeFormat}`);
}

/** Новая оценка → сводка в кеше списка, чтобы список сразу показал итог без перезагрузки набора. */
export function rememberEvaluation(evaluation) {
  if (evaluation.purpose === "sandbox") return;
  const listing = listingCache.get(evaluation.groupId);
  if (!listing) return;
  const current = listing.items.find((item) => item.id === evaluation.conversationId);
  if (!current) return;
  const summary = summarizeEvaluation(evaluation);
  const items = listing.items.map((item) => (item === current ? Object.freeze({ ...item, evaluation: summary }) : item));
  listingCache.set(evaluation.groupId, Object.freeze({ ...listing, items: Object.freeze(items) }));
}

/* ---------- транспорт ---------- */

/**
 * Общий JSON-запрос к API для всех модулей фронтенда (контракт — docs/CONTRACT.md).
 * Ошибки приходят как ApiError с кодом и человекочитаемым сообщением.
 * @param {string} path
 * @param {{ method?: "GET" | "POST" | "PUT" | "DELETE", body?: unknown, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<unknown>}
 */
export function apiRequest(path, { method = "GET", body, signal, timeoutMs = 30_000 } = {}) {
  return requestJson(path, { method, body, signal, timeoutMs });
}

async function requestJson(path, { method = "GET", body: payload, signal, timeoutMs }) {
  if (signal?.aborted) throw abortedError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const relayAbort = () => controller.abort();
  signal?.addEventListener("abort", relayAbort, { once: true });
  try {
    const headers = payload === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" };
    const init = { method, headers, signal: controller.signal };
    const response = await fetch(apiUrl(path), payload === undefined ? init : { ...init, body: JSON.stringify(payload) });
    const body = await readJson(response);
    if (!response.ok) {
      const error = errorFromBody(body, response.status);
      if (error.status === 401 && error.code === "auth_required") redirectToLogin();
      throw error;
    }
    if (body === undefined) {
      throw new ApiError({ code: "bad_response", message: "Сервер ответил не в формате JSON.", status: response.status });
    }
    return body;
  } catch (error) {
    throw toApiError(error, { timedOut, timeoutMs, signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relayAbort);
  }
}

async function readJson(response) {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function toApiError(error, { timedOut, timeoutMs, signal }) {
  if (error instanceof ApiError) return error;
  if (timedOut) {
    return new ApiError({ code: "client_timeout", message: `Сервер не ответил за ${Math.round(timeoutMs / 1000)} с. Попробуйте ещё раз.` });
  }
  if (signal?.aborted) return abortedError();
  return new ApiError({ code: "network", message: "Не удалось связаться с сервером API. Проверьте, что бэкенд запущен." });
}

// Понятные формулировки для известных конфликтов (текст бэкенда может быть техническим).
const CODE_MESSAGES = Object.freeze({
  appeal_exists: "По этому критерию в этой оценке апелляция уже подана — её статус виден у критерия и в очереди апелляций.",
  answer_unchanged: "Новый ответ совпадает с исходным. Чтобы оставить ответ системы, выберите «Подтвердить оценку».",
});

function errorFromBody(body, status) {
  const detail = isObject(body) && isObject(body.error) ? body.error : {};
  const code = isNonEmptyString(detail.code) ? detail.code : `http_${status}`;
  const message = CODE_MESSAGES[code]
    ?? (isNonEmptyString(detail.message) ? detail.message.trim() : STATUS_MESSAGES[status] ?? `Ошибка сервера (HTTP ${status}).`);
  return new ApiError({ code, message, status });
}

function abortedError() {
  return new ApiError({ code: "aborted", message: "Запрос отменён." });
}

// Вход для жюри включён, а сессии нет (или она истекла): страница входа, после неё — возврат сюда.
// Во встроенной панели (iframe стенда Dynamics) уходит верхнее окно, если оно того же origin.
let loginRedirectStarted = false;

function redirectToLogin() {
  if (loginRedirectStarted) return;
  loginRedirectStarted = true;
  const target = sameOriginTop() ?? window;
  const { pathname, search, hash } = target.location;
  const login = new URL("../login.html", import.meta.url);
  login.searchParams.set("next", `${pathname}${search}${hash}`);
  try {
    target.location.assign(login.href);
  } catch {
    window.location.assign(login.href); // верхнее окно не дало себя увести (sandbox)
  }
}

function sameOriginTop() {
  try {
    const top = window.top;
    return top && top !== window && top.location.origin === window.location.origin ? top : null;
  } catch {
    return null; // верхнее окно другого origin — читать его адрес нельзя
  }
}

function assertId(value, kind) {
  if (!isValidId(value)) {
    throw new ApiError({ code: `invalid_${kind}`, message: `Некорректный ${kind}: допустимы латинские буквы, цифры, «_» и «-», до 64 символов.`, status: 400 });
  }
}

function rememberConversation(key, conversation) {
  conversationCache.delete(key);
  conversationCache.set(key, conversation);
  if (conversationCache.size > CONVERSATION_CACHE_LIMIT) conversationCache.delete(conversationCache.keys().next().value);
}

function dropConversations(groupId) {
  for (const key of [...conversationCache.keys()]) if (key.startsWith(`${groupId}/`)) conversationCache.delete(key);
}

/* ---------- проверка ответов на границе: набор и диалог ---------- */

function parseListing(body, groupId) {
  if (!isObject(body) || !Array.isArray(body.items)) throw badShape("список диалогов");
  const items = body.items.map(parseListItem).filter(Boolean);
  return Object.freeze({
    groupId: isNonEmptyString(body.group_id) ? body.group_id : groupId,
    total: items.length,
    fetchedAt: str(body.fetched_at),
    items: Object.freeze(items),
  });
}

function parseListItem(raw) {
  if (!isObject(raw) || !isValidId(raw.conversation_id)) return null;
  const counts = isObject(raw.counts) ? raw.counts : {};
  return Object.freeze({
    id: raw.conversation_id,
    channel: CHANNELS.includes(raw.channel) ? raw.channel : str(raw.channel),
    language: str(raw.language).toUpperCase(),
    messageCount: count(raw.message_count),
    counts: Object.freeze(Object.fromEntries(SPEAKERS.map((speaker) => [speaker, count(counts[speaker])]))),
    durationSec: finiteOrNull(raw.duration_sec),
    preview: str(raw.preview),
    hasAudio: raw.has_audio === true,
    evaluation: parseEvaluationSummary(raw.evaluation),
  });
}

/** Сводка последней оценки в листинге; нет оценки — null («Не оценено»). */
function parseEvaluationSummary(raw) {
  if (!isObject(raw)) return null;
  const total = finiteOrNull(raw.total);
  const answers = isObject(raw.answers)
    ? Object.fromEntries(Object.entries(raw.answers).map(([id, answer]) => [id, parseAnswer(answer)]))
    : {};
  return Object.freeze({
    evaluationId: str(raw.evaluation_id),
    total,
    finalTotal: "final_total" in raw ? finiteOrNull(raw.final_total) : total,
    critical: raw.critical === true,
    criticalNote: str(raw.critical_note),
    needsReview: raw.needs_review === true,
    appealStatus: raw.appeal_status === "open" || raw.appeal_status === "resolved" ? raw.appeal_status : "",
    checklistVersion: intOrNull(raw.checklist_version),
    answers: Object.freeze(answers),
  });
}

function parseConversation(body) {
  if (!isObject(body) || !Array.isArray(body.messages)) throw badShape("диалог");
  return Object.freeze({
    id: str(body.conversation_id),
    channel: CHANNELS.includes(body.channel) ? body.channel : str(body.channel),
    language: str(body.language).toUpperCase(),
    audioUrl: parseAudioUrl(body.audio),
    messages: Object.freeze(body.messages.map(parseMessage).filter(Boolean)),
  });
}

function parseMessage(raw, position) {
  if (!isObject(raw)) return null;
  return Object.freeze({
    index: Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : position,
    timestamp: str(raw.timestamp),
    offsetSec: finiteOrNull(raw.offset_sec),
    speaker: SPEAKERS.includes(raw.speaker) ? raw.speaker : "system",
    text: str(raw.text),
  });
}

function parseAudioUrl(audio) {
  if (!isObject(audio) || typeof audio.url !== "string") return null;
  const url = audio.url.trim();
  if (url.startsWith("/") && !url.startsWith("//")) return apiUrl(url);
  return /^https?:\/\//i.test(url) ? url : null;
}

/* ---------- чек-лист ---------- */

function parseChecklist(body) {
  if (!isObject(body) || !Array.isArray(body.criteria)) throw badShape("чек-лист");
  const criteria = body.criteria.map(parseCriterion).filter(Boolean);
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const sections = (Array.isArray(body.sections) ? body.sections : []).map((raw) => parseSection(raw, byId)).filter(Boolean);
  const placed = new Set(sections.flatMap((section) => section.criteria.map((criterion) => criterion.id)));
  const orphans = criteria.filter((criterion) => !placed.has(criterion.id));
  const allSections = orphans.length
    ? [...sections, Object.freeze({ id: "other", title: "Без секции", criteria: Object.freeze(orphans) })]
    : sections;
  return Object.freeze({
    id: str(body.id),
    version: Number.isFinite(body.version) ? body.version : null,
    title: str(body.title) || "Чек-лист",
    languages: Object.freeze(Array.isArray(body.languages) ? body.languages.filter(isNonEmptyString) : []),
    rules: Object.freeze(isObject(body.rules) ? { ...body.rules } : {}),
    sections: Object.freeze(allSections),
    criteria: Object.freeze(criteria),
  });
}

function parseSection(raw, byId) {
  if (!isObject(raw) || !Array.isArray(raw.criteria)) return null;
  const criteria = raw.criteria.map((id) => byId.get(id)).filter(Boolean);
  return Object.freeze({ id: str(raw.id), title: str(raw.title) || "Секция", criteria: Object.freeze(criteria) });
}

function parseCriterion(raw) {
  if (!isObject(raw) || !isNonEmptyString(raw.id)) return null;
  const scale = (Array.isArray(raw.scale) ? raw.scale : [])
    .filter((step) => isObject(step) && Number.isFinite(step.value))
    .map((step) => Object.freeze({ value: step.value, label: str(step.label) }))
    .sort((a, b) => b.value - a.value);
  return Object.freeze({
    id: raw.id,
    title: str(raw.title) || raw.id,
    answerType: raw.answerType === "scale" ? "scale" : "yes_no",
    weight: Number.isFinite(raw.weight) ? raw.weight : 0,
    naAllowed: raw.naAllowed === true,
    scored: raw.scored !== false,
    critical: raw.critical === true,
    yes: str(raw.yes),
    no: str(raw.no),
    na: str(raw.na),
    scale: Object.freeze(scale),
  });
}

/* ---------- модели, оценки, апелляции ---------- */

function parseModel(raw) {
  if (!isObject(raw) || !isNonEmptyString(raw.id)) return null;
  return Object.freeze({
    id: raw.id,
    provider: str(raw.provider),
    label: str(raw.label) || raw.id,
    available: raw.available !== false,
    isDefault: raw.default === true,
  });
}

function parseEvaluationSafe(raw) {
  try {
    return parseEvaluation(raw);
  } catch {
    return null; // одна битая запись истории не должна прятать остальные
  }
}

function parseEvaluation(raw) {
  if (!isObject(raw) || !isNonEmptyString(raw.id) || !Array.isArray(raw.criteria)) throw badShape("оценку");
  const total = finiteOrNull(raw.total);
  const tokens = isObject(raw.tokens) ? raw.tokens : {};
  return Object.freeze({
    id: raw.id,
    groupId: str(raw.group_id),
    conversationId: str(raw.conversation_id),
    createdAt: str(raw.created_at),
    checklistId: str(raw.checklist_id),
    checklistVersion: intOrNull(raw.checklist_version),
    purpose: raw.purpose === "sandbox" ? "sandbox" : "regular",
    models: Object.freeze(Array.isArray(raw.models) ? raw.models.filter(isNonEmptyString) : []),
    criteria: Object.freeze(raw.criteria.map(parseEvaluatedCriterion).filter(Boolean)),
    sections: Object.freeze((Array.isArray(raw.sections) ? raw.sections : []).map(parseEvaluatedSection).filter(Boolean)),
    total,
    finalTotal: "final_total" in raw ? finiteOrNull(raw.final_total) : total,
    criticalFlag: raw.critical_flag === true,
    criticalNote: str(raw.critical_note),
    needsReview: raw.needs_review === true,
    costUsd: finiteOrNull(raw.cost_usd),
    tokens: Object.freeze({ input: count(tokens.input), output: count(tokens.output) }),
    latencyMs: finiteOrNull(raw.latency_ms),
    status: raw.status === "error" ? "error" : "done",
    error: errorText(raw.error),
  });
}

function parseEvaluatedCriterion(raw) {
  if (!isObject(raw) || !isNonEmptyString(raw.criterion_id)) return null;
  const answer = parseAnswer(raw.answer);
  const points = finiteOrNull(raw.points);
  const maxPoints = finiteOrNull(raw.max_points);
  return Object.freeze({
    criterionId: raw.criterion_id,
    title: str(raw.title) || raw.criterion_id,
    answerType: raw.answer_type === "scale" ? "scale" : "yes_no",
    weight: Number.isFinite(raw.weight) ? raw.weight : 0,
    critical: raw.critical === true,
    scored: raw.scored !== false,
    answer,
    finalAnswer: "final_answer" in raw ? parseAnswer(raw.final_answer) : answer,
    points,
    maxPoints,
    finalPoints: "final_points" in raw ? finiteOrNull(raw.final_points) : points,
    finalMaxPoints: "final_max_points" in raw ? finiteOrNull(raw.final_max_points) : maxPoints,
    explanation: str(raw.explanation),
    evidence: Object.freeze((Array.isArray(raw.evidence) ? raw.evidence : []).map(parseEvidence).filter(Boolean)),
    checkedRange: parseRange(raw.checked_range),
    naReason: str(raw.na_reason),
    confidence: finiteOrNull(raw.confidence),
    votes: Object.freeze((Array.isArray(raw.votes) ? raw.votes : [])
      .filter((vote) => isObject(vote) && isNonEmptyString(vote.model))
      .map((vote) => Object.freeze({ model: vote.model, answer: parseAnswer(vote.answer) }))),
    needsReview: raw.needs_review === true,
    appeal: parseCriterionAppeal(raw.appeal),
  });
}

/** Апелляция в критерии оценки: статус и (если бэкенд прислал) комментарий и решение. */
function parseCriterionAppeal(raw) {
  if (!isObject(raw) || !isNonEmptyString(raw.id)) return null;
  return Object.freeze({
    id: raw.id,
    status: raw.status === "resolved" ? "resolved" : "open",
    comment: str(raw.comment),
    createdAt: str(raw.created_at),
    originalAnswer: "original_answer" in raw ? parseAnswer(raw.original_answer) : null,
    decision: parseDecision(raw.decision),
  });
}

function parseDecision(raw) {
  if (!isObject(raw)) return null;
  return Object.freeze({
    action: raw.action === "change" ? "change" : "confirm",
    newAnswer: parseAnswer(raw.new_answer),
    reason: str(raw.reason),
    decidedAt: str(raw.decided_at),
  });
}

function parseEvidence(raw) {
  if (!isObject(raw) || !Number.isInteger(raw.index) || raw.index < 0) return null;
  return Object.freeze({ index: raw.index, quote: str(raw.quote), verified: raw.verified !== false });
}

function parseRange(raw) {
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((n) => Number.isInteger(n) && n >= 0)) return null;
  const [from, to] = raw[0] <= raw[1] ? raw : [raw[1], raw[0]];
  return Object.freeze([from, to]);
}

function parseEvaluatedSection(raw) {
  if (!isObject(raw) || !isNonEmptyString(raw.id)) return null;
  const points = finiteOrNull(raw.points);
  const maxPoints = finiteOrNull(raw.max_points);
  return Object.freeze({
    id: raw.id,
    title: str(raw.title) || raw.id,
    points,
    maxPoints,
    finalPoints: "final_points" in raw ? finiteOrNull(raw.final_points) : points,
    finalMaxPoints: "final_max_points" in raw ? finiteOrNull(raw.final_max_points) : maxPoints,
  });
}

function parseAppealSafe(raw) {
  try {
    return parseAppeal(raw);
  } catch {
    return null;
  }
}

function parseAppeal(raw) {
  if (!isObject(raw) || !isNonEmptyString(raw.id)) throw badShape("апелляцию");
  return Object.freeze({
    id: raw.id,
    evaluationId: str(raw.evaluation_id),
    groupId: str(raw.group_id),
    conversationId: str(raw.conversation_id),
    criterionId: str(raw.criterion_id),
    criterionTitle: str(raw.criterion_title),
    answerType: raw.answer_type === "scale" ? "scale" : raw.answer_type === "yes_no" ? "yes_no" : "",
    comment: str(raw.comment),
    createdAt: str(raw.created_at),
    status: raw.status === "resolved" ? "resolved" : "open",
    originalAnswer: parseAnswer(raw.original_answer),
    finalAnswer: "final_answer" in raw ? parseAnswer(raw.final_answer) : null,
    decision: parseDecision(raw.decision),
    options: Object.freeze((Array.isArray(raw.options) ? raw.options : [])
      .filter((option) => isObject(option) && parseAnswer(option.value) !== null)
      .map((option) => Object.freeze({ value: parseAnswer(option.value), label: str(option.label) }))),
    fragment: Object.freeze((Array.isArray(raw.fragment) ? raw.fragment : []).map(parseMessage).filter(Boolean)
      .sort((a, b) => a.index - b.index)),
  });
}

/* ---------- примитивы ---------- */

/** Ответ критерия: "yes" | "no" | "na" | число (ступень шкалы) | null. */
function parseAnswer(value) {
  if (ANSWERS.includes(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function listOf(body, what) {
  if (Array.isArray(body)) return body;
  if (isObject(body) && Array.isArray(body.items)) return body.items;
  throw badShape(what);
}

function errorText(value) {
  if (isNonEmptyString(value)) return value;
  if (isObject(value) && isNonEmptyString(value.message)) return value.message;
  return "";
}

function badShape(what) {
  return new ApiError({ code: "bad_response", message: `Сервер вернул ${what} в неожиданном формате.` });
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function str(value) {
  return typeof value === "string" ? value : "";
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
