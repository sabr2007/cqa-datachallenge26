// Сравнение двух оценок одного диалога: итог до → после и какие ответы по критериям изменились.
// Чистая функция — проверяется в tests/js/admin.test.mjs.

/**
 * @typedef {{ kind: "changed" | "added" | "removed", criterionId: string, title: string, critical: boolean,
 *   before: unknown, after: unknown }} AnswerChange
 * @typedef {{ before: number | null, after: number | null, delta: number | null, changes: AnswerChange[],
 *   criticalBefore: boolean | null, criticalAfter: boolean | null }} EvaluationComparison
 * @param {object | null} prev прошлая оценка (admin/api.js parseEvaluation) или null, если её не было
 * @param {object} next новая оценка
 * @returns {EvaluationComparison}
 */
export function compareEvaluations(prev, next) {
  const before = prev ? prev.finalTotal ?? prev.total ?? null : null;
  const after = next ? next.finalTotal ?? next.total ?? null : null;
  const prevById = new Map((prev?.criteria ?? []).map((c) => [c.criterionId, c]));
  const nextById = new Map((next?.criteria ?? []).map((c) => [c.criterionId, c]));
  const changes = [];
  if (prev) {
    for (const c of next?.criteria ?? []) {
      const old = prevById.get(c.criterionId);
      if (!old) changes.push(change("added", c, null, c.finalAnswer));
      else if (!sameAnswer(old.finalAnswer, c.finalAnswer)) changes.push(change("changed", c, old.finalAnswer, c.finalAnswer));
    }
    for (const old of prev.criteria) {
      if (!nextById.has(old.criterionId)) changes.push(change("removed", old, old.finalAnswer, null));
    }
  }
  return Object.freeze({
    before,
    after,
    delta: typeof before === "number" && typeof after === "number" ? Math.round((after - before) * 100) / 100 : null,
    changes: Object.freeze(changes),
    criticalBefore: prev ? prev.criticalFlag === true : null,
    criticalAfter: next ? next.criticalFlag === true : null,
  });
}

/**
 * Сводка по набору: сколько итогов изменилось, средний итог до/после, грубые ошибки до/после.
 * @param {EvaluationComparison[]} comparisons
 */
export function summarizeComparisons(comparisons) {
  const withBoth = comparisons.filter((c) => typeof c.before === "number" && typeof c.after === "number");
  const mean = (values) => (values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100 : null);
  return Object.freeze({
    count: comparisons.length,
    changedTotals: withBoth.filter((c) => c.delta !== 0).length,
    changedAnswers: comparisons.filter((c) => c.changes.length > 0).length,
    meanBefore: mean(withBoth.map((c) => c.before)),
    meanAfter: mean(withBoth.map((c) => c.after)),
    criticalBefore: comparisons.filter((c) => c.criticalBefore === true).length,
    criticalAfter: comparisons.filter((c) => c.criticalAfter === true).length,
    firstTime: comparisons.filter((c) => c.before === null && c.criticalBefore === null).length,
  });
}

function change(kind, criterion, before, after) {
  return Object.freeze({ kind, criterionId: criterion.criterionId, title: criterion.title, critical: criterion.critical === true, before, after });
}

function sameAnswer(a, b) {
  return a === b || (a === null && b === undefined) || (a === undefined && b === null);
}
