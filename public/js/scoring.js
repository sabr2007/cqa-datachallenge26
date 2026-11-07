// Расчёт итога оценки — JS-копия app.engine.score_evaluation (docs/CONTRACT.md, «Дополнения (v2)»).
// Чистые функции без DOM: используются в редакторе чек-листа (живой пересчёт) и в тестах node --test.
//
// Правила (docs/TASK.md, раздел 4):
//   «Да» — полный вес, «Нет» — 0, шкала — пропорционально верхней ступени;
//   N/A и критерии scored=false в итог не входят, вес N/A перераспределяется между применимыми;
//   все суммы — по точным значениям (рациональные числа на BigInt, как Decimal на бэкенде),
//   наружу каждое число округляется отдельно: half-up до rules.rounding.decimals (по умолчанию 2).

const DEFAULT_MAX_TOTAL = 100;
const DEFAULT_DECIMALS = 2;
const ZERO = Object.freeze({ n: 0n, d: 1n });
const ONE = Object.freeze({ n: 1n, d: 1n });
const NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

/**
 * @typedef {"yes" | "no" | "na" | number} Answer
 * @typedef {{ points: number | null, max_points: number | null }} CriterionScore
 * @typedef {{ id: string, title: string, points: number | null, max_points: number | null }} SectionScore
 * @typedef {{ criteria: Record<string, CriterionScore>, sections: SectionScore[], total: number | null }} Score
 */

/**
 * Итог по ответам. Ответ без значения (нет в answers) считается неприменимым, как N/A.
 * @param {{ criteria?: object[], sections?: object[], rules?: object }} checklist документ версии чек-листа
 * @param {Record<string, Answer | string | null | undefined>} answers {criterion_id: ответ}
 * @returns {Score}
 */
export function scoreEvaluation(checklist, answers = {}) {
  const criteria = Array.isArray(checklist?.criteria) ? checklist.criteria.filter(isCriterion) : [];
  const rules = isObject(checklist?.rules) ? checklist.rules : {};
  const maxTotal = toFraction(finiteOr(rules.maxTotal, DEFAULT_MAX_TOTAL));
  const decimals = Number.isInteger(rules.rounding?.decimals) && rules.rounding.decimals >= 0 ? rules.rounding.decimals : DEFAULT_DECIMALS;

  const applicable = criteria
    .map((criterion) => ({ criterion, fraction: answerFraction(criterion, answers?.[criterion.id]) }))
    .filter(({ criterion, fraction }) => isScored(criterion) && fraction !== null);
  const weightSum = applicable.reduce((sum, { criterion }) => add(sum, weightOf(criterion)), ZERO);
  const hasWeight = weightSum.n > 0n;

  /** @type {Map<string, { points: Fraction, max: Fraction }>} */
  const exact = new Map();
  if (hasWeight) {
    for (const { criterion, fraction } of applicable) {
      const max = div(mul(weightOf(criterion), maxTotal), weightSum);
      exact.set(criterion.id, { points: mul(max, fraction), max });
    }
  }

  const round = (value) => (value === null ? null : toNumber(roundHalfUpFraction(value, decimals), decimals));
  const criteriaOut = Object.fromEntries(criteria.map((criterion) => {
    const entry = exact.get(criterion.id);
    return [criterion.id, Object.freeze({ points: entry ? round(entry.points) : null, max_points: entry ? round(entry.max) : null })];
  }));

  const sections = (Array.isArray(checklist?.sections) ? checklist.sections : []).filter(isObject).map((section) => {
    const entries = (Array.isArray(section.criteria) ? section.criteria : []).map((id) => exact.get(id)).filter(Boolean);
    const points = entries.length ? entries.reduce((sum, e) => add(sum, e.points), ZERO) : null;
    const max = entries.length ? entries.reduce((sum, e) => add(sum, e.max), ZERO) : null;
    return Object.freeze({ id: String(section.id ?? ""), title: String(section.title ?? ""), points: round(points), max_points: round(max) });
  });

  const total = hasWeight ? [...exact.values()].reduce((sum, e) => add(sum, e.points), ZERO) : null;
  return Object.freeze({ criteria: Object.freeze(criteriaOut), sections: Object.freeze(sections), total: round(total) });
}

/** Критерий входит в итог: scored не выключен явно. Грубые ошибки (critical) идут с scored=false. */
export function isScored(criterion) {
  return isObject(criterion) && criterion.scored !== false;
}

/** Верхняя ступень шкалы (0, если шкала пуста). */
export function maxScaleValue(criterion) {
  const values = scaleValues(criterion);
  return values.length ? Math.max(...values) : 0;
}

/** Числовые значения ступеней шкалы. */
export function scaleValues(criterion) {
  return (Array.isArray(criterion?.scale) ? criterion.scale : [])
    .map((step) => (isObject(step) ? step.value : undefined))
    .filter((value) => typeof value === "number" && Number.isFinite(value));
}

/**
 * Приводит ответ к виду API: "yes" | "no" | "na" | число (для шкалы) | null, если ответа нет или он не подходит.
 * @param {object} criterion @param {unknown} raw
 * @returns {Answer | null}
 */
export function normalizeAnswer(criterion, raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw === "na") return "na";
  if (criterion?.answerType === "scale") {
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return raw === "yes" || raw === "no" ? raw : null;
}

/**
 * Доля веса, которую приносит ответ: 1 для «Да», 0 для «Нет», ступень/верхняя ступень для шкалы.
 * null — критерий неприменим (N/A, нет ответа или ответ не подходит к типу).
 * @returns {Fraction | null}
 */
function answerFraction(criterion, raw) {
  const answer = normalizeAnswer(criterion, raw);
  if (answer === null || answer === "na") return null;
  if (criterion.answerType === "scale") {
    const top = maxScaleValue(criterion);
    if (!(top > 0) || typeof answer !== "number") return null;
    return clampUnit(div(toFraction(answer), toFraction(top)));
  }
  return answer === "yes" ? ONE : ZERO;
}

/**
 * Округление half-up обычного числа через его десятичную запись: roundHalfUp(50.625) → 50.63.
 * @param {number} value @param {number} [decimals]
 */
export function roundHalfUp(value, decimals = DEFAULT_DECIMALS) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return toNumber(roundHalfUpFraction(toFraction(value), decimals), decimals);
}

/* ---------- точная арифметика: рациональные числа на BigInt ---------- */

/** @typedef {{ n: bigint, d: bigint }} Fraction */

function weightOf(criterion) {
  const weight = criterion.weight;
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? toFraction(weight) : ZERO;
}

/** Точное значение числа в его кратчайшей десятичной записи (как Decimal(str(x)) в Python). */
function toFraction(value) {
  const match = NUMBER_TEXT.exec(String(value));
  if (!match) return ZERO;
  const [, sign, intPart, fracPart = "", expPart = "0"] = match;
  const exp = Number(expPart);
  let n = BigInt(intPart + fracPart);
  let d = 10n ** BigInt(fracPart.length);
  if (exp > 0) n *= 10n ** BigInt(exp);
  if (exp < 0) d *= 10n ** BigInt(-exp);
  return reduce({ n: sign ? -n : n, d });
}

function add(a, b) {
  return reduce({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
}

function mul(a, b) {
  return reduce({ n: a.n * b.n, d: a.d * b.d });
}

function div(a, b) {
  if (b.n === 0n) throw new RangeError("Деление на ноль при расчёте итога");
  const sign = b.n < 0n ? -1n : 1n;
  return reduce({ n: a.n * b.d * sign, d: a.d * b.n * sign });
}

function clampUnit(f) {
  if (f.n <= 0n) return ZERO;
  return f.n >= f.d ? ONE : f;
}

function reduce({ n, d }) {
  const g = gcd(n < 0n ? -n : n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

function gcd(a, b) {
  let x = a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

/** Целое число сотых (при decimals=2), округлённое half-up — от нуля на половине, как ROUND_HALF_UP. */
function roundHalfUpFraction(f, decimals) {
  const scale = 10n ** BigInt(decimals);
  const abs = f.n < 0n ? -f.n : f.n;
  const rounded = (2n * abs * scale + f.d) / (2n * f.d);
  return f.n < 0n ? -rounded : rounded;
}

function toNumber(scaledInteger, decimals) {
  const value = Number(scaledInteger) / 10 ** decimals;
  return Object.is(value, -0) ? 0 : value;
}

function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isCriterion(value) {
  return isObject(value) && typeof value.id === "string" && value.id !== "";
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
