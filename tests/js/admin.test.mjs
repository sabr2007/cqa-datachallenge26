// Логика редактора чек-листа без DOM: черновик, операции, проверка, сравнение версий, сравнение оценок, очередь.
// Запуск: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareEvaluations, summarizeComparisons } from "../../public/js/admin/compare.js";
import { diffChecklists, summarizeDiff, touchedCriteria } from "../../public/js/admin/diff.js";
import {
  addCriterion, addSection, moveCriterion, moveSection, nextCriterionId, removeCriterion, removeSection,
  replaceCriterion, setAnswerType, setCritical, toDraft, toNumber, toPayload, updateCriterion,
} from "../../public/js/admin/model.js";
import { countResults, runQueue } from "../../public/js/admin/runner.js";
import { validateDraft } from "../../public/js/admin/validate.js";
import { scoreEvaluation } from "../../public/js/scoring.js";

const CHECKLIST = JSON.parse(readFileSync(fileURLToPath(new URL("../../config/checklists/chat-default.json", import.meta.url)), "utf8"));
// Поля, по которым движок решает, что критерий не менялся (app/engine/reuse.py, DEFINITION_FIELDS).
const DEFINITION_FIELDS = ["title", "answerType", "naAllowed", "yes", "no", "na", "scale", "guidance", "critical"];
const fingerprint = (criterion) => JSON.stringify(DEFINITION_FIELDS.map((name) => criterion[name] ?? null));
const errorsOf = (doc) => validateDraft(doc).errors.map((e) => `${e.targetId}:${e.field}`);

test("черновик без правок сохраняется тем же документом: отпечатки критериев и баллы не меняются", () => {
  const payload = toPayload(toDraft(CHECKLIST), { note: "без правок" });
  for (const original of CHECKLIST.criteria) {
    const saved = payload.criteria.find((c) => c.id === original.id);
    assert.equal(fingerprint(saved), fingerprint(original), `отпечаток ${original.id}`);
    assert.equal(saved.weight, original.weight);
  }
  assert.deepEqual(payload.sections.map((s) => s.criteria), CHECKLIST.sections.map((s) => s.criteria));
  assert.equal(payload.note, "без правок");
  assert.equal("version" in payload, false, "номер версии назначает бэкенд");
  assert.equal(diffChecklists(CHECKLIST, payload).isEmpty, true);
});

test("исходный чек-лист проходит проверку без ошибок и предупреждений", () => {
  const { errors, warnings } = validateDraft(toDraft(CHECKLIST));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("замена критерия: новый id на том же месте, вес и тип перенесены, старый удалён", () => {
  const draft = toDraft(CHECKLIST);
  const { doc, id } = replaceCriterion(draft, "c05", { reservedIds: CHECKLIST.criteria.map((c) => c.id) });
  assert.equal(id, "c09");
  const section = doc.sections.find((s) => s.id === "conduct");
  assert.deepEqual(section.criteria, ["c09", "c06", "c07"]);
  const added = doc.criteria.find((c) => c.id === "c09");
  assert.equal(added.weight, 15);
  assert.equal(added.title, "");
  assert.ok(!doc.criteria.some((c) => c.id === "c05"));
  assert.deepEqual(errorsOf(doc), ["c09:title", "c09:yes"], "пустые формулировки нового критерия — ошибки");
});

test("id не переиспользуются: после удаления последнего критерия следующий id всё равно новый", () => {
  const draft = removeCriterion(toDraft(CHECKLIST), "c08");
  assert.equal(nextCriterionId(draft), "c08", "без истории id освободился бы");
  assert.equal(nextCriterionId(draft, ["c08"]), "c09", "с id прошлых версий — нет");
});

test("перемещение: на границе секции критерий переходит в соседнюю, порядок criteria[] следует секциям", () => {
  const draft = toDraft(CHECKLIST);
  const moved = moveCriterion(draft, "c02", 1);
  assert.deepEqual(moved.sections.find((s) => s.id === "start").criteria, ["c01"]);
  assert.deepEqual(moved.sections.find((s) => s.id === "security").criteria, ["c02", "c03", "c04"]);
  assert.deepEqual(moved.criteria.map((c) => c.id).slice(0, 4), ["c01", "c02", "c03", "c04"]);
  assert.equal(moveCriterion(draft, "c01", -1), draft, "первый критерий выше не двигается");
  const sections = moveSection(draft, "critical", -1);
  assert.deepEqual(sections.sections.map((s) => s.id), ["start", "security", "critical", "conduct"]);
  assert.equal(sections.criteria.at(-1).id, "c07");
});

test("операции не меняют исходный черновик", () => {
  const draft = toDraft(CHECKLIST);
  const snapshot = JSON.stringify(draft);
  updateCriterion(draft, "c01", { weight: 30 });
  addCriterion(draft, "start");
  setAnswerType(draft, "c01", "scale");
  setCritical(draft, "c02", true);
  removeCriterion(draft, "c03");
  addSection(draft);
  assert.equal(JSON.stringify(draft), snapshot);
});

test("проверка: веса, ступени шкалы, условия N/A, пустые секции", () => {
  let doc = toDraft(CHECKLIST);
  doc = updateCriterion(doc, "c01", { weight: "12,5" });
  assert.equal(toNumber("12,5"), 12.5);
  assert.deepEqual(errorsOf(doc), [], "вес с запятой допустим");
  assert.match(validateDraft(doc).warnings[0].message, /Сумма весов 102,5/);

  doc = updateCriterion(doc, "c01", { weight: "-3" });
  assert.deepEqual(errorsOf(doc), ["c01:weight"]);

  doc = updateCriterion(toDraft(CHECKLIST), "c04", { scale: [{ value: 20, label: "Всё" }, { value: 20, label: "" }] });
  assert.deepEqual(errorsOf(doc), ["c04:scale.1.value", "c04:scale.1.label"]);
  doc = updateCriterion(toDraft(CHECKLIST), "c04", { scale: [{ value: 0, label: "Ничего" }] });
  assert.deepEqual(errorsOf(doc), ["c04:scale"]);

  doc = updateCriterion(toDraft(CHECKLIST), "c01", { naAllowed: true, na: "  " });
  assert.deepEqual(errorsOf(doc), ["c01:na"]);

  const withSection = addSection(toDraft(CHECKLIST)).doc;
  assert.equal(validateDraft(withSection).warnings.some((w) => w.scope === "section"), true);
  assert.equal(removeSection(withSection, "start"), withSection, "непустую секцию не удалить");
});

test("грубая ошибка: без баллов, вес 0, итог не меняется", () => {
  const doc = setCritical(toDraft(CHECKLIST), "c07", true);
  const payload = toPayload(doc);
  const c07 = payload.criteria.find((c) => c.id === "c07");
  assert.equal(c07.critical, true);
  assert.equal(c07.scored, false);
  assert.equal(c07.weight, 0);
  const answers = { c01: "yes", c02: "yes", c03: "yes", c04: 20, c05: "yes", c06: 10, c07: "no", c08: "no" };
  assert.equal(scoreEvaluation(payload, answers).total, 100, "07 вне итога: остальные 95 весов дают 100");
});

test("сравнение версий: добавленные, изменённые поля и удалённые критерии, заметка по умолчанию", () => {
  const draft = toDraft(CHECKLIST);
  const replaced = replaceCriterion(draft, "c05", { reservedIds: ["c08"] });
  let doc = updateCriterion(replaced.doc, replaced.id, { title: "Вежливость", yes: "Оператор вежлив." });
  doc = updateCriterion(doc, "c01", { weight: 20, yes: "Новое условие" });
  const diff = diffChecklists(CHECKLIST, toPayload(doc));
  assert.deepEqual(diff.added.map((c) => c.id), ["c09"]);
  assert.deepEqual(diff.removed.map((c) => c.id), ["c05"]);
  assert.deepEqual(diff.changed.map((c) => [c.id, c.changes.map((ch) => ch.field)]), [["c01", ["yes", "weight"]]]);
  assert.deepEqual([...touchedCriteria(diff)], ["c09", "c01"]);
  assert.equal(summarizeDiff(diff), "Добавлен 09 «Вежливость»; изменён 01 (условие «Да», вес); удалён 05 «Эмпатия и клиентоориентированность»");
});

test("сравнение оценок: итог до → после и изменившиеся ответы", () => {
  const criterion = (id, answer, extra = {}) => ({ criterionId: id, title: id, critical: false, finalAnswer: answer, ...extra });
  const prev = { total: 80, finalTotal: 85, criticalFlag: false, criteria: [criterion("c01", "yes"), criterion("c04", 15), criterion("c05", "no")] };
  const next = { total: 70, finalTotal: 70, criticalFlag: true, criteria: [criterion("c01", "yes"), criterion("c04", 20), criterion("c09", "no")] };
  const result = compareEvaluations(prev, next);
  assert.equal(result.before, 85, "до — с учётом апелляций");
  assert.equal(result.after, 70);
  assert.equal(result.delta, -15);
  assert.deepEqual(result.changes.map((c) => [c.kind, c.criterionId, c.before, c.after]), [
    ["changed", "c04", 15, 20], ["added", "c09", null, "no"], ["removed", "c05", "no", null],
  ]);
  const first = compareEvaluations(null, next);
  assert.equal(first.before, null);
  assert.deepEqual(first.changes, []);
  const stats = summarizeComparisons([result, first]);
  assert.equal(stats.changedTotals, 1);
  assert.equal(stats.criticalAfter, 2);
  assert.equal(stats.firstTime, 1);
});

test("очередь: не больше N одновременно, все результаты на своих местах", async () => {
  let running = 0;
  let peak = 0;
  const { done } = runQueue([1, 2, 3, 4, 5, 6, 7], async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5 + (n % 3) * 3));
    running -= 1;
    if (n === 4) throw new Error("сбой");
    return n * 10;
  }, { concurrency: 3 });
  const { results, cancelled } = await done;
  assert.equal(peak, 3);
  assert.equal(cancelled, false);
  assert.deepEqual(results.map((r) => r.status), ["done", "done", "done", "error", "done", "done", "done"]);
  assert.equal(results[6].value, 70);
  assert.deepEqual(countResults(results), { queued: 0, running: 0, done: 6, error: 1, cancelled: 0, total: 7 });
});

test("очередь: отмена прерывает идущие запросы и снимает ожидающие", async () => {
  const seen = [];
  const queue = runQueue([1, 2, 3, 4, 5], (n, { signal }) => new Promise((resolve, reject) => {
    seen.push(n);
    const timer = setTimeout(() => resolve(n), 50);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  }), { concurrency: 2 });
  setTimeout(() => queue.cancel(), 10);
  const { results, cancelled } = await queue.done;
  assert.equal(cancelled, true);
  assert.deepEqual(seen, [1, 2], "после отмены новые задачи не стартуют");
  assert.deepEqual(results.map((r) => r.status), ["cancelled", "cancelled", "cancelled", "cancelled", "cancelled"]);
});
