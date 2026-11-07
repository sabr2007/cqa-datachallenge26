// Оценки в работе — на уровне модуля, поэтому переживают переход между экранами:
// можно запустить оценку в карточке, уйти в список и вернуться — карточка подхватит ожидание.
// Пакетная оценка набора идёт через тот же реестр с ограничением параллельности.

import { evaluateConversation, isAbortError } from "../api.js";

export const BATCH_CONCURRENCY = Object.freeze([2, 3]);
const DEFAULT_CONCURRENCY = 2;

let jobs = new Map(); // `${groupId}/${conversationId}` → Job
const jobListeners = new Set();
let batch = null;
const batchListeners = new Set();

/**
 * @typedef {{ key: string, groupId: string, conversationId: string, startedAt: number, finishedAt: number | null,
 *   state: "running" | "done" | "error" | "cancelled", evaluation: object | null, error: object | null,
 *   promise: Promise<object>, controller: AbortController }} Job
 */

export function jobKey(groupId, conversationId) {
  return `${groupId}/${conversationId}`;
}

/** @returns {Job | null} */
export function getJob(groupId, conversationId) {
  return jobs.get(jobKey(groupId, conversationId)) ?? null;
}

/** Слушатель событий оценок: ({ type: "start" | "done" | "error" | "cancelled", job }) => void. */
export function subscribeJobs(listener) {
  jobListeners.add(listener);
  return () => jobListeners.delete(listener);
}

/**
 * Запускает оценку диалога; если она уже идёт — возвращает текущую.
 * @param {{ groupId: string, conversationId: string, models?: string[] | null, checklistVersion?: number, reusePrevious?: boolean }} request
 * @returns {Job}
 */
export function runEvaluation(request) {
  const key = jobKey(request.groupId, request.conversationId);
  const existing = jobs.get(key);
  if (existing?.state === "running") return existing;
  const controller = new AbortController();
  const promise = evaluateConversation(request, { signal: controller.signal });
  const job = Object.freeze({
    key, groupId: request.groupId, conversationId: request.conversationId, startedAt: Date.now(), finishedAt: null,
    state: "running", evaluation: null, error: null, promise, controller,
  });
  setJob(job);
  emitJob({ type: "start", job });
  promise.then(
    (evaluation) => settle(job, { state: "done", evaluation }),
    (error) => settle(job, { state: isAbortError(error) ? "cancelled" : "error", error }),
  );
  return job;
}

/** Прекращает ожидание ответа. Сервер может всё же закончить оценку — она появится в истории. */
export function cancelJob(groupId, conversationId) {
  const job = getJob(groupId, conversationId);
  if (job?.state === "running") job.controller.abort();
}

function settle(job, patch) {
  if (jobs.get(job.key) !== job) return; // уже заменена новой оценкой того же диалога
  const next = Object.freeze({ ...job, ...patch, finishedAt: Date.now() });
  setJob(next);
  emitJob({ type: next.state, job: next });
}

function setJob(job) {
  jobs = new Map(jobs).set(job.key, job);
}

function emitJob(event) {
  for (const listener of [...jobListeners]) listener(event);
}

/* ---------- пакетная оценка ---------- */

/**
 * @typedef {{ id: number, groupId: string, ids: ReadonlyArray<string>, concurrency: number, status: "running" | "done" | "cancelled",
 *   startedAt: number, finishedAt: number | null, next: number,
 *   results: ReadonlyMap<string, { state: "running" | "done" | "error" | "cancelled", evaluation?: object, error?: object }> }} Batch
 */

/** @returns {Batch | null} */
export function getBatch() {
  return batch;
}

export function subscribeBatch(listener) {
  batchListeners.add(listener);
  return () => batchListeners.delete(listener);
}

/**
 * Пакетная оценка списка диалогов с ограничением параллельности (2–3).
 * @param {{ groupId: string, ids: string[], concurrency?: number, models?: string[] | null, checklistVersion?: number, reusePrevious?: boolean }} options
 */
export function startBatch({ groupId, ids, concurrency = DEFAULT_CONCURRENCY, models = null, checklistVersion, reusePrevious = false }) {
  if (batch?.status === "running" || ids.length === 0) return batch;
  const limit = BATCH_CONCURRENCY.includes(concurrency) ? concurrency : DEFAULT_CONCURRENCY;
  batch = Object.freeze({
    id: Date.now(), groupId, ids: Object.freeze([...new Set(ids)]), concurrency: limit, status: "running",
    startedAt: Date.now(), finishedAt: null, next: 0, results: new Map(),
    request: Object.freeze({ models, checklistVersion, reusePrevious }),
  });
  emitBatch();
  pump(batch.id);
  return batch;
}

/** Останавливает пакет: новые диалоги не запускаются, ожидание текущих прекращается. */
export function cancelBatch() {
  if (batch?.status !== "running") return;
  const running = [...batch.results.entries()].filter(([, result]) => result.state === "running").map(([id]) => id);
  updateBatch({ status: "cancelled", finishedAt: Date.now() });
  for (const id of running) cancelJob(batch.groupId, id);
}

/** Убирает итоги завершённого пакета (панель сводки закрыта). */
export function clearBatch() {
  if (batch?.status === "running") return;
  batch = null;
  emitBatch();
}

/** Сводка пакета для прогресса и итогов. */
export function batchStats(current) {
  const results = [...current.results.values()];
  const done = results.filter((r) => r.state === "done");
  const totals = done.map((r) => r.evaluation?.finalTotal ?? r.evaluation?.total).filter((t) => typeof t === "number");
  return Object.freeze({
    total: current.ids.length,
    finished: results.filter((r) => r.state !== "running").length,
    running: results.filter((r) => r.state === "running").length,
    done: done.length,
    failed: results.filter((r) => r.state === "error").length,
    cancelled: results.filter((r) => r.state === "cancelled").length,
    queued: current.ids.length - results.length,
    critical: done.filter((r) => r.evaluation?.criticalFlag).length,
    needsReview: done.filter((r) => r.evaluation?.needsReview).length,
    averageTotal: totals.length ? totals.reduce((sum, t) => sum + t, 0) / totals.length : null,
    costUsd: done.reduce((sum, r) => sum + (r.evaluation?.costUsd ?? 0), 0),
    failedIds: Object.freeze([...current.results.entries()].filter(([, r]) => r.state === "error").map(([id]) => id)),
    runningIds: Object.freeze([...current.results.entries()].filter(([, r]) => r.state === "running").map(([id]) => id)),
  });
}

/** Состояние диалога внутри пакета: queued / running / done / error / cancelled / null (не в пакете). */
export function batchStateOf(groupId, conversationId) {
  if (!batch || batch.groupId !== groupId || !batch.ids.includes(conversationId)) return null;
  const result = batch.results.get(conversationId);
  if (result) return result.state;
  return batch.status === "running" ? "queued" : null;
}

function pump(batchId) {
  while (batch?.id === batchId && batch.status === "running" && runningCount() < batch.concurrency && batch.next < batch.ids.length) {
    const id = batch.ids[batch.next];
    const job = runEvaluation({ groupId: batch.groupId, conversationId: id, ...batch.request });
    updateBatch({ next: batch.next + 1, results: new Map(batch.results).set(id, { state: "running" }) });
    job.promise.then(
      (evaluation) => finishItem(batchId, id, { state: "done", evaluation }),
      (error) => finishItem(batchId, id, { state: isAbortError(error) ? "cancelled" : "error", error }),
    );
  }
  if (batch?.id === batchId && batch.status === "running" && runningCount() === 0 && batch.next >= batch.ids.length) {
    updateBatch({ status: "done", finishedAt: Date.now() });
  }
}

function finishItem(batchId, id, result) {
  if (batch?.id !== batchId) return;
  updateBatch({ results: new Map(batch.results).set(id, Object.freeze(result)) });
  pump(batchId);
}

function runningCount() {
  return [...batch.results.values()].filter((result) => result.state === "running").length;
}

function updateBatch(patch) {
  batch = Object.freeze({ ...batch, ...patch });
  emitBatch();
}

function emitBatch() {
  for (const listener of [...batchListeners]) listener(batch);
}
