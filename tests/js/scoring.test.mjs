// JS-копия расчёта итога (public/js/scoring.js) против общих тест-векторов движка.
// Запуск: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { maxScaleValue, normalizeAnswer, roundHalfUp, scoreEvaluation } from "../../public/js/scoring.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/scoring_cases.json", import.meta.url));
const CHECKLIST = JSON.parse(readFileSync(fileURLToPath(new URL("../../config/checklists/chat-default.json", import.meta.url)), "utf8"));
const EXAMPLE = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/contract/evaluation.example.json", import.meta.url)), "utf8"));

const ALL_YES = { c01: "yes", c02: "yes", c03: "yes", c04: 20, c05: "yes", c06: 10, c07: "yes", c08: "no" };

test("общие тест-векторы движка (tests/fixtures/scoring_cases.json)", { skip: !existsSync(FIXTURE) && "фикстуры ещё нет" }, async (t) => {
  const cases = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.ok(Array.isArray(cases) && cases.length > 0, "фикстура — непустой массив");
  for (const [position, item] of cases.entries()) {
    await t.test(item.name ?? `случай ${position + 1}`, () => {
      // Arrange
      const { checklist, answers, expected } = item;
      // Act
      const actual = scoreEvaluation(checklist, answers);
      // Assert
      assert.equal(actual.total, expected.total, "итог");
      for (const [id, want] of Object.entries(expected.criteria ?? {})) {
        assert.ok(actual.criteria[id], `критерий ${id} есть в результате`);
        assert.equal(actual.criteria[id].points, want.points, `${id}.points`);
        assert.equal(actual.criteria[id].max_points, want.max_points, `${id}.max_points`);
      }
      for (const want of expected.sections ?? []) {
        const got = actual.sections.find((section) => section.id === want.id);
        assert.ok(got, `секция ${want.id} есть в результате`);
        assert.equal(got.points, want.points, `секция ${want.id}.points`);
        assert.equal(got.max_points, want.max_points, `секция ${want.id}.max_points`);
      }
    });
  }
});

test("все «Да» и верхние ступени дают 100", () => {
  const result = scoreEvaluation(CHECKLIST, ALL_YES);
  assert.equal(result.total, 100);
  assert.deepEqual(result.criteria.c01, { points: 10, max_points: 10 });
  assert.deepEqual(result.criteria.c08, { points: null, max_points: null }, "грубые ошибки без баллов");
});

test("N/A перераспределяет вес: пример оценки из контракта даёт 45", () => {
  const answers = Object.fromEntries(EXAMPLE.criteria.map((c) => [c.criterion_id, c.answer]));
  const result = scoreEvaluation(CHECKLIST, answers);
  assert.equal(result.total, EXAMPLE.total);
  for (const criterion of EXAMPLE.criteria) {
    assert.equal(result.criteria[criterion.criterion_id].points, criterion.points, `${criterion.criterion_id}.points`);
    assert.equal(result.criteria[criterion.criterion_id].max_points, criterion.max_points, `${criterion.criterion_id}.max_points`);
  }
  for (const section of EXAMPLE.sections) {
    const got = result.sections.find((s) => s.id === section.id);
    assert.equal(got.points, section.points, `секция ${section.id}`);
    assert.equal(got.max_points, section.max_points, `секция ${section.id} max`);
  }
});

test("итог округляется half-up до 2 знаков: 50,625 → 50,63", () => {
  // 10 + 15 + 5 + 10,5 = 40,5 из 80 применимых → 40,5 × 100 / 80 = 50,625
  const answers = { c01: "yes", c02: "yes", c03: "na", c04: 5, c05: "no", c06: 7, c07: "no", c08: "no" };
  assert.equal(scoreEvaluation(CHECKLIST, answers).total, 50.63);
});

test("баллы считаются по точным значениям, наружу каждое число округляется отдельно", () => {
  // применимы 01 (10) и 05 (15) и 07 (5): W = 30, коэффициент 100/30
  const answers = { c01: "yes", c02: "na", c03: "na", c04: "na", c05: "yes", c06: undefined, c07: "yes" };
  const checklist = { ...CHECKLIST, criteria: CHECKLIST.criteria.map((c) => (c.id === "c06" ? { ...c, naAllowed: true } : c)) };
  const result = scoreEvaluation(checklist, answers);
  assert.equal(result.criteria.c01.points, 33.33);
  assert.equal(result.criteria.c05.points, 50);
  assert.equal(result.criteria.c07.points, 16.67);
  assert.equal(result.total, 100, "сумма точных значений, а не округлённых (33,33 + 50 + 16,67)");
});

test("без применимых критериев с весом итог не считается", () => {
  const answers = { c01: "na", c02: "na", c03: "na", c04: "na", c05: "na", c06: "na", c07: "na", c08: "yes" };
  const result = scoreEvaluation(CHECKLIST, answers);
  assert.equal(result.total, null);
  assert.deepEqual(result.criteria.c01, { points: null, max_points: null });
  assert.equal(result.sections.find((s) => s.id === "start").points, null);
});

test("критерий scored=false не входит в итог, даже с весом", () => {
  const checklist = { ...CHECKLIST, criteria: CHECKLIST.criteria.map((c) => (c.id === "c01" ? { ...c, scored: false } : c)) };
  const result = scoreEvaluation(checklist, ALL_YES);
  assert.equal(result.total, 100);
  assert.equal(result.criteria.c01.points, null);
  assert.equal(result.criteria.c02.max_points, 16.67, "вес 01 перераспределён: 15 × 100 / 90");
});

test("шкала: баллы пропорциональны верхней ступени, строковое значение из формы приводится к числу", () => {
  const c06 = CHECKLIST.criteria.find((c) => c.id === "c06");
  assert.equal(maxScaleValue(c06), 10);
  assert.equal(normalizeAnswer(c06, "7"), 7);
  assert.equal(normalizeAnswer(c06, "na"), "na");
  const result = scoreEvaluation(CHECKLIST, { ...ALL_YES, c06: "4" });
  assert.equal(result.criteria.c06.points, 6);
  assert.equal(result.total, 91);
});

test("roundHalfUp работает по десятичной записи, а не по двоичной", () => {
  assert.equal(roundHalfUp(50.625), 50.63);
  assert.equal(roundHalfUp(1.005), 1.01, "в float 1.005 чуть меньше — но половина вверх по записи");
  assert.equal(roundHalfUp(2.675), 2.68);
  assert.equal(roundHalfUp(-0.125), -0.13);
  assert.equal(roundHalfUp(Number.NaN), null);
});
