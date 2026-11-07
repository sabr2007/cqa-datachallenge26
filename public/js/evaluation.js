// Оценка диалога на клиенте: сводка для списка, фильтры по результатам и «тон» ответа критерия.
// Чистые функции без DOM и сети. Формат данных — docs/CONTRACT.md, разбор ответов API — api.js.

export const STATUS_FILTERS = Object.freeze([
  { value: "pending", label: "Не оценено", needsData: false, match: (ev) => !ev },
  { value: "done", label: "Оценено", needsData: true, match: (ev) => Boolean(ev) },
  { value: "critical", label: "Грубая ошибка", needsData: true, match: (ev) => ev?.critical === true },
  { value: "review", label: "Нужна проверка", needsData: true, match: (ev) => ev?.needsReview === true },
]);

export const APPEAL_FILTERS = Object.freeze([
  { value: "open", label: "Открыта", match: (ev) => ev?.appealStatus === "open" },
  { value: "resolved", label: "Решена", match: (ev) => ev?.appealStatus === "resolved" },
]);

export const SCORE_FILTERS = Object.freeze([
  { value: "lt60", label: "до 60", match: (total) => total < 60 },
  { value: "60-79", label: "60–79", match: (total) => total >= 60 && total < 80 },
  { value: "gte80", label: "80+", match: (total) => total >= 80 },
]);

export const UNAVAILABLE_HINT = "Станет доступно после оценки диалогов";

/** @param {ReadonlyArray<{ evaluation: object | null }>} items */
export function hasEvaluations(items) {
  return items.some((item) => item.evaluation);
}

/** Итог с учётом решений по апелляциям. */
export function effectiveTotal(summary) {
  if (!summary) return null;
  return typeof summary.finalTotal === "number" ? summary.finalTotal : summary.total;
}

/** Верхняя ступень шкалы критерия чек-листа (шкала в api.js отсортирована по убыванию). */
export function maxStepOf(criterion) {
  return criterion?.answerType === "scale" && criterion.scale.length ? criterion.scale[0].value : null;
}

/**
 * Ответ «не выполнено»: Да/Нет — «Нет»; шкала — ниже верхней ступени; критический (08) — «Да» (нарушение есть).
 * @param {"yes" | "no" | "na" | number | null} answer
 * @param {{ answerType: string, critical?: boolean, scale?: ReadonlyArray<{ value: number }> }} criterion
 */
export function isFailAnswer(answer, criterion) {
  if (!criterion) return false;
  if (criterion.critical) return answer === "yes";
  if (criterion.answerType === "scale") {
    const top = maxStepOf(criterion);
    return typeof answer === "number" && top !== null && answer < top;
  }
  return answer === "no";
}

/**
 * Тон ответа для цвета: pass / fail / partial / na / none.
 * @param {"yes" | "no" | "na" | number | null} answer
 * @param {{ critical?: boolean, maxStep?: number | null }} options
 */
export function answerTone(answer, { critical = false, maxStep = null } = {}) {
  if (answer === null || answer === undefined) return "none";
  if (answer === "na") return "na";
  if (critical) return answer === "yes" ? "fail" : "pass";
  if (typeof answer === "number") {
    if (answer === 0) return "fail";
    return maxStep !== null && answer >= maxStep ? "pass" : "partial";
  }
  return answer === "yes" ? "pass" : "fail";
}

/**
 * Грубая ошибка «сейчас» (по final_answer) и «исходно» (по ответу системы).
 * Если критического критерия в оценке нет — по флагу critical_flag.
 */
export function criticalState(evaluation) {
  const critical = evaluation.criteria.filter((criterion) => criterion.critical);
  if (critical.length === 0) {
    return Object.freeze({ now: evaluation.criticalFlag, before: evaluation.criticalFlag, criteria: Object.freeze([]) });
  }
  return Object.freeze({
    now: critical.some((criterion) => criterion.finalAnswer === "yes"),
    before: critical.some((criterion) => criterion.answer === "yes"),
    criteria: Object.freeze(critical),
  });
}

/** Статус апелляций оценки: open, если есть открытая; resolved, если все решены; "" — апелляций нет. */
export function appealStatusOf(evaluation) {
  const statuses = evaluation.criteria.map((criterion) => criterion.appeal?.status).filter(Boolean);
  if (statuses.includes("open")) return "open";
  return statuses.length ? "resolved" : "";
}

/** Полная оценка → сводка для строки списка (та же форма, что разбирает api.js из листинга). */
export function summarizeEvaluation(evaluation) {
  return Object.freeze({
    evaluationId: evaluation.id,
    total: evaluation.total,
    finalTotal: evaluation.finalTotal,
    critical: criticalState(evaluation).now,
    criticalNote: evaluation.criticalNote,
    needsReview: evaluation.needsReview,
    appealStatus: appealStatusOf(evaluation),
    checklistVersion: evaluation.checklistVersion,
    answers: Object.freeze(Object.fromEntries(evaluation.criteria.map((criterion) => [criterion.criterionId, criterion.finalAnswer]))),
  });
}

/**
 * @param {object | null} evaluation сводка оценки из списка
 * @param {{ status: string, score: string, appeal: string, fail: string }} filters
 * @param {{ dataAvailable: boolean, criteriaById: Map<string, object> }} context
 */
export function matchesEvaluation(evaluation, { status, score, appeal, fail }, { dataAvailable, criteriaById }) {
  const statusFilter = STATUS_FILTERS.find((f) => f.value === status);
  if (statusFilter && (dataAvailable || !statusFilter.needsData) && !statusFilter.match(evaluation)) return false;
  if (!dataAvailable) return true;
  const scoreFilter = SCORE_FILTERS.find((f) => f.value === score);
  if (scoreFilter) {
    const total = effectiveTotal(evaluation);
    if (typeof total !== "number" || !scoreFilter.match(total)) return false;
  }
  const appealFilter = APPEAL_FILTERS.find((f) => f.value === appeal);
  if (appealFilter && !appealFilter.match(evaluation)) return false;
  if (fail) {
    const criterion = criteriaById.get(fail);
    if (!criterion || !evaluation?.answers || !isFailAnswer(evaluation.answers[fail], criterion)) return false;
  }
  return true;
}
