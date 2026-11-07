// Живой пересчёт в редакторе: как изменится итог примерного диалога при весах и N/A черновика.
// Ответы берутся из последней оценки выбранного диалога набора (если оценок нет — задаются вручную);
// любой ответ можно поменять, новые критерии получают предполагаемый ответ. Расчёт — scoring.js.

import { h } from "../dom.js";
import { buildHash, paths } from "../router.js";
import { maxScaleValue, normalizeAnswer, scaleValues, scoreEvaluation } from "../scoring.js";
import { fetchGroupConversations, getEvaluation } from "./api.js";
import { answerLabel, formatScore, versionLabel } from "./labels.js";
import { criterionLabel, toDraft, toPayload } from "./model.js";
import { deltaChip, nextId, setChildren } from "./ui.js";
import { isAbortError } from "../api.js";

const MANUAL = "__manual__";
const UNSET = "__unset__";

/**
 * @param {{ groupId: string, signal: AbortSignal }} options
 * @returns {{ el: HTMLElement, update: (baseDoc: object, draft: import("./model.js").DraftDoc) => void }}
 */
export function createPreview({ groupId, signal }) {
  let samples = [];
  let sampleId = MANUAL;
  let evaluation = null;
  let status = "loading"; // loading | ready | error
  let message = "";
  let overrides = new Map();
  let base = null;
  let draft = null;
  const headingId = nextId("cqa-pv-title");
  const body = h("div", { className: "cqa-pv__body" });
  const el = h("section", { className: "cqa-pv", attrs: { "aria-labelledby": headingId } },
    h("div", { className: "cqa-pv__head" },
      h("h2", { className: "cqa-pv__title", attrs: { id: headingId }, text: "Живой пересчёт" }),
      h("p", { className: "cqa-pv__lead", text: "Как изменится итог диалога при весах и N/A черновика." })),
    body);

  loadSamples();

  async function loadSamples() {
    status = "loading";
    render();
    try {
      const listing = await fetchGroupConversations(groupId, { signal });
      samples = listing.items.filter((item) => item.evaluation);
      status = "ready";
      if (samples.length) await selectSample(samples[0].id, { focus: false });
      else render();
    } catch (error) {
      if (isAbortError(error)) return;
      status = "error";
      message = error.message;
      render();
    }
  }

  /** focus: вернуть фокус на выбор примера (только когда пример выбрал пользователь, а не автозагрузка). */
  async function selectSample(id, { focus = true } = {}) {
    const focusKey = focus ? "pv:sample" : null;
    sampleId = id;
    overrides = new Map();
    evaluation = null;
    if (id === MANUAL) {
      render(focusKey);
      return;
    }
    const sample = samples.find((s) => s.id === id);
    status = "loading";
    render(focusKey);
    try {
      evaluation = await getEvaluation(sample.evaluation.evaluationId, { signal });
      status = "ready";
    } catch (error) {
      if (isAbortError(error)) return;
      status = "error";
      message = `Не удалось загрузить оценку ${id}: ${error.message}`;
    }
    render(focusKey && body.contains(document.activeElement) ? focusKey : null);
  }

  /* ---------- расчёт ---------- */

  function answerFromEvaluation(criterionId) {
    const entry = evaluation?.criteria.find((c) => c.criterionId === criterionId);
    return entry ? entry.finalAnswer : undefined;
  }

  /** Ответ для критерия черновика: правка пользователя → оценка диалога → «идеальный» ответ в ручном режиме. */
  function resolve(criterion) {
    if (overrides.has(criterion.id)) return { answer: overrides.get(criterion.id), source: "override" };
    if (evaluation) {
      const raw = answerFromEvaluation(criterion.id);
      if (raw === undefined) return { answer: null, source: "missing" };
      return validFor(criterion, raw) ? { answer: raw, source: "evaluation" } : { answer: null, source: "invalid" };
    }
    if (criterion.critical) return { answer: "no", source: "manual" };
    return { answer: criterion.answerType === "scale" ? maxScaleValue(numeric(criterion)) : "yes", source: "manual" };
  }

  function validFor(criterion, raw) {
    const answer = normalizeAnswer(criterion, raw);
    if (answer === null) return false;
    if (answer === "na") return criterion.naAllowed;
    if (criterion.answerType === "scale") return scaleValues(numeric(criterion)).includes(answer);
    return true;
  }

  function compute() {
    const numericDraft = toPayload(draft);
    const baseDraft = toDraft(base);
    const afterAnswers = Object.fromEntries(draft.criteria.map((c) => [c.id, resolve(c).answer]));
    const beforeAnswers = Object.fromEntries(baseDraft.criteria.map((c) => {
      const inDraft = draft.criteria.find((d) => d.id === c.id);
      if (inDraft && overrides.has(c.id) && validFor(c, overrides.get(c.id))) return [c.id, overrides.get(c.id)];
      const fromEval = evaluation ? answerFromEvaluation(c.id) : undefined;
      if (evaluation) return [c.id, fromEval !== undefined && validFor(c, fromEval) ? fromEval : null];
      return [c.id, c.critical ? "no" : c.answerType === "scale" ? maxScaleValue(c) : "yes"];
    }));
    return {
      before: scoreEvaluation(base, beforeAnswers),
      after: scoreEvaluation(numericDraft, afterAnswers),
      removed: baseDraft.criteria.filter((c) => !draft.criteria.some((d) => d.id === c.id)),
    };
  }

  /* ---------- отрисовка ---------- */

  function render(focusKey = null) {
    if (!base || !draft) return;
    const { before, after, removed } = compute();
    setChildren(body,
      sampleControl(),
      status === "error" ? h("p", { className: "cqa-pv__error", attrs: { role: "alert" }, text: message }) : null,
      totals(before.total, after.total),
      sourceNote(),
      h("ol", { className: "cqa-pv__rows" },
        draft.criteria.map((c) => row(c, before.criteria[c.id], after.criteria[c.id])),
        removed.map((c) => removedRow(c, before.criteria[c.id]))));
    if (focusKey) body.querySelector(`[data-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  function sampleControl() {
    const id = nextId("cqa-pv-sample");
    const select = h("select", { className: "cqa-a-input cqa-a-select", attrs: { id, "data-key": "pv:sample", disabled: status === "loading" && !samples.length } },
      samples.map((s) => h("option", {
        attrs: { value: s.id, selected: s.id === sampleId },
        text: `${s.id} · ${s.language} · итог ${formatScore(s.evaluation.finalTotal)} · ${versionLabel(s.evaluation.checklistVersion)}`,
      })),
      h("option", { attrs: { value: MANUAL, selected: sampleId === MANUAL }, text: "Ответы вручную (без диалога)" }));
    select.addEventListener("change", () => selectSample(select.value));
    const link = sampleId !== MANUAL
      ? h("a", { className: "cqa-pv__link", attrs: { href: buildHash(paths.conversation(sampleId), { g: groupId }) }, text: "Открыть диалог" })
      : null;
    return h("div", { className: "cqa-pv__sample" },
      h("label", { className: "cqa-a-field__label", attrs: { for: id }, text: samples.length ? `Пример из набора ${groupId}` : "Пример" }),
      select, link,
      status === "loading" ? h("p", { className: "cqa-pv__hint", attrs: { role: "status" }, text: samples.length ? "Загружаем оценку…" : `Ищем оценённые диалоги набора ${groupId}…` }) : null,
      status === "ready" && !samples.length ? h("p", { className: "cqa-pv__hint", text: `В наборе ${groupId} ещё нет оценённых диалогов — ответы задаются вручную.` }) : null);
  }

  function totals(before, after) {
    const delta = typeof before === "number" && typeof after === "number" ? after - before : null;
    return h("div", { className: "cqa-pv__totals", attrs: { "aria-live": "polite" } },
      h("p", { className: "cqa-pv__total" },
        h("span", { className: "cqa-pv__total-label", text: `Сейчас (${versionLabel(base.version)})` }),
        h("span", { className: "cqa-pv__total-value cqa-num", text: formatScore(before) })),
      h("span", { className: "cqa-pv__arrow", attrs: { "aria-hidden": "true" }, text: "→" }),
      h("p", { className: "cqa-pv__total cqa-pv__total--after" },
        h("span", { className: "cqa-pv__total-label", text: "С черновиком" }),
        h("span", { className: "cqa-pv__total-value cqa-num", text: formatScore(after) })),
      deltaChip(delta));
  }

  function sourceNote() {
    if (sampleId === MANUAL || !evaluation) {
      return h("p", { className: "cqa-pv__hint", text: "Ответы заданы вручную: «Да» и верхние ступени. Меняйте ответы, веса и N/A — итог пересчитается сразу." });
    }
    return h("p", { className: "cqa-pv__hint", text: `Ответы — из оценки диалога ${evaluation.conversationId} по ${versionLabel(evaluation.checklistVersion)}. Новые критерии ещё не оценены — задайте предполагаемый ответ.` });
  }

  function row(criterion, before, after) {
    const { answer, source } = resolve(criterion);
    const key = `pv:${criterion.id}`;
    const id = nextId("cqa-pv-answer");
    const select = h("select", { className: "cqa-a-input cqa-a-select cqa-pv__answer", attrs: { id, "data-key": key } },
      answerOptions(criterion, answer));
    select.addEventListener("change", () => {
      overrides = new Map(overrides).set(criterion.id, select.value === UNSET ? null : normalizeAnswer(criterion, select.value));
      render(key);
    });
    const points = criterion.critical
      ? h("span", { className: "cqa-pv__points cqa-pv__points--flag", text: answer === "yes" ? "грубая ошибка" : "отметка" })
      : pointsCell(before, after, answer);
    const note = source === "missing" ? "не оценён" : source === "invalid" ? "ответ не подходит к новой версии" : "";
    return h("li", { className: "cqa-pv__row", dataset: { source } },
      h("span", { className: "cqa-pv__num", text: criterionLabel(draft, criterion.id) }),
      h("label", { className: "cqa-pv__name", attrs: { for: id } },
        h("span", { text: criterion.title.trim() || "Новый критерий" }),
        note ? h("span", { className: "cqa-pv__note", text: note }) : null),
      select, points);
  }

  function removedRow(criterion, before) {
    return h("li", { className: "cqa-pv__row cqa-pv__row--removed" },
      h("span", { className: "cqa-pv__num", text: criterionLabel(toDraft(base), criterion.id) }),
      h("span", { className: "cqa-pv__name" }, h("span", { text: criterion.title }), h("span", { className: "cqa-pv__note", text: "удалён в черновике" })),
      h("span", { className: "cqa-pv__answer-static", text: answerLabel(evaluation ? answerFromEvaluation(criterion.id) : null) }),
      h("span", { className: "cqa-pv__points cqa-num" }, h("s", { text: formatScore(before?.points) })));
  }

  function pointsCell(before, after, answer) {
    const b = before?.points ?? null;
    const a = after?.points ?? null;
    if (a === null && b === null) {
      return h("span", { className: "cqa-pv__points", text: answer === "na" ? "N/A — вес перераспределён" : "не учитывается в итоге" });
    }
    const changed = b !== a;
    return h("span", { className: `cqa-pv__points cqa-num${changed ? " is-changed" : ""}`, attrs: { title: `Было ${formatScore(b)} из ${formatScore(before?.max_points)}, станет ${formatScore(a)} из ${formatScore(after?.max_points)}` } },
      changed ? h("span", { className: "cqa-pv__was", text: formatScore(b) }) : null,
      h("span", { text: formatScore(a) }),
      h("span", { className: "cqa-pv__max", text: `/${formatScore(after?.max_points)}` }));
  }

  function answerOptions(criterion, current) {
    const options = criterion.answerType === "scale"
      ? [...scaleValues(numeric(criterion))].sort((x, y) => y - x).map((value) => [String(value), answerLabel(value)])
      : [["yes", criterion.critical ? "Да — есть грубая ошибка" : "Да"], ["no", criterion.critical ? "Нет" : "Нет"]];
    if (criterion.naAllowed) options.push(["na", "N/A"]);
    options.push([UNSET, "не учитывать"]);
    const selected = current === null || current === undefined ? UNSET : String(current);
    return options.map(([value, label]) => h("option", { attrs: { value, selected: value === selected }, text: label }));
  }

  return {
    el,
    update(baseDoc, nextDraft) {
      base = baseDoc;
      draft = nextDraft;
      const active = document.activeElement;
      const key = body.contains(active) ? active?.dataset?.key ?? null : null;
      render(key);
    },
  };
}

/** Критерий черновика с числовыми весом и ступенями (поля формы могут хранить строки). */
function numeric(criterion) {
  const doc = toPayload({ id: "", title: "", rules: {}, sections: [], criteria: [criterion] });
  return doc.criteria[0];
}
