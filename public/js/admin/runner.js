// Очередь запросов с ограниченной параллельностью, прогрессом и отменой — для «Применить к набору» и песочницы.
// Без DOM: проверяется в tests/js/runner.test.mjs.

export const DEFAULT_CONCURRENCY = 3;

/**
 * @typedef {"queued" | "running" | "done" | "error" | "cancelled"} TaskStatus
 * @typedef {{ status: TaskStatus, value?: unknown, error?: unknown }} TaskResult
 * @typedef {{ queued: number, running: number, done: number, error: number, cancelled: number, total: number }} QueueCounts
 */

/**
 * Запускает worker для каждого элемента, не больше concurrency одновременно.
 * cancel() прерывает идущие запросы (через signal) и снимает с очереди ожидающие.
 * @template T
 * @param {T[]} items
 * @param {(item: T, ctx: { signal: AbortSignal, index: number }) => Promise<unknown>} worker
 * @param {{ concurrency?: number, signal?: AbortSignal, onUpdate?: (event: { index: number, item: T, result: TaskResult, counts: QueueCounts }) => void }} [options]
 * @returns {{ done: Promise<{ results: TaskResult[], cancelled: boolean }>, cancel: () => void }}
 */
export function runQueue(items, worker, { concurrency = DEFAULT_CONCURRENCY, signal, onUpdate } = {}) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", relayAbort, { once: true });

  /** @type {TaskResult[]} */
  let results = items.map(() => Object.freeze({ status: "queued" }));
  let cursor = 0;

  const set = (index, result) => {
    results = results.map((r, i) => (i === index ? Object.freeze(result) : r));
    onUpdate?.({ index, item: items[index], result: results[index], counts: countResults(results) });
  };

  async function lane() {
    while (!controller.signal.aborted && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      set(index, { status: "running" });
      try {
        const value = await worker(items[index], { signal: controller.signal, index });
        set(index, { status: "done", value });
      } catch (error) {
        set(index, { status: controller.signal.aborted ? "cancelled" : "error", error });
      }
    }
  }

  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  const done = Promise.all(Array.from({ length: items.length ? lanes : 0 }, lane)).then(() => {
    results.forEach((r, i) => { if (r.status === "queued") set(i, { status: "cancelled" }); });
    signal?.removeEventListener("abort", relayAbort);
    return { results, cancelled: controller.signal.aborted };
  });
  return { done, cancel: () => controller.abort() };
}

/** @param {TaskResult[]} results @returns {QueueCounts} */
export function countResults(results) {
  const counts = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0, total: results.length };
  for (const r of results) counts[r.status] += 1;
  return counts;
}
