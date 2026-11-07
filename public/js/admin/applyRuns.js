// Прогоны «Применить к набору» живут на уровне модуля, а не экрана: можно открыть диалог из таблицы
// результатов и вернуться — переоценка продолжается и панель подхватывает её прогресс.
// Остановить прогон можно только явно (кнопка «Остановить»).

import { isAbortError } from "../api.js";
import { evaluateConversation, getEvaluation } from "./api.js";
import { compareEvaluations } from "./compare.js";
import { runQueue } from "./runner.js";

/**
 * @typedef {{ key: string, groupId: string, checklistId: string, version: number, items: import("./api.js").GroupItem[],
 *   results: import("./runner.js").TaskResult[], durations: number[], startedAt: number, concurrency: number,
 *   finished: boolean, cancelled: boolean, cancel: () => void }} ApplyRun
 */

/** @type {Map<string, ApplyRun>} */
const runs = new Map();
/** @type {Map<string, Set<(run: ApplyRun, change: { index: number | null }) => void>>} */
const listeners = new Map();

export function runKey(groupId, checklistId) {
  return `${groupId}::${checklistId}`;
}

/** @returns {ApplyRun | null} */
export function getRun(key) {
  return runs.get(key) ?? null;
}

/** Подписка на изменения прогона; возвращает отписку. */
export function subscribe(key, listener) {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => set.delete(listener);
}

export function isRunning(key) {
  const run = runs.get(key);
  return Boolean(run && !run.finished);
}

/**
 * Переоценка диалогов по версии чек-листа: прошлая оценка (для «до → после») + POST /api/evaluations с reuse_previous.
 * @param {{ groupId: string, checklistId: string, version: number, items: import("./api.js").GroupItem[], concurrency: number }} options
 * @returns {ApplyRun}
 */
export function startRun({ groupId, checklistId, version, items, concurrency }) {
  const key = runKey(groupId, checklistId);
  const existing = runs.get(key);
  if (existing && !existing.finished) return existing;
  const begun = new Map();
  let queue = null;
  const update = (patch, index = null) => {
    const next = Object.freeze({ ...runs.get(key), ...patch });
    runs.set(key, next);
    for (const listener of listeners.get(key) ?? []) listener(next, { index });
  };
  runs.set(key, Object.freeze({
    key, groupId, checklistId, version, items, concurrency,
    results: items.map(() => Object.freeze({ status: "queued" })), durations: [], startedAt: Date.now(),
    finished: false, cancelled: false, cancel: () => queue?.cancel(),
  }));

  queue = runQueue(items, async (item, { signal }) => {
    begun.set(item.id, Date.now());
    const prev = item.evaluation
      ? await getEvaluation(item.evaluation.evaluationId, { signal }).catch((error) => {
        if (isAbortError(error)) throw error;
        return null; // без прошлой оценки покажем «впервые», переоценку это не останавливает
      })
      : null;
    const next = await evaluateConversation(
      { groupId, conversationId: item.id, checklistId, checklistVersion: version, reusePrevious: true, purpose: "regular" },
      { signal },
    );
    if (next.status === "error") throw new Error(next.error || "Движок вернул ошибку оценки.");
    return { prev, next, comparison: compareEvaluations(prev, next) };
  }, {
    concurrency,
    onUpdate: ({ index, item, result }) => {
      const run = runs.get(key);
      const finishedTask = result.status === "done" || result.status === "error";
      update({
        results: run.results.map((r, i) => (i === index ? result : r)),
        durations: finishedTask ? [...run.durations, Date.now() - (begun.get(item.id) ?? Date.now())] : run.durations,
      }, index);
    },
  });
  queue.done.then(({ cancelled }) => update({ finished: true, cancelled }));
  return runs.get(key);
}
