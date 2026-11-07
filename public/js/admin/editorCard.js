// Карточка критерия в редакторе: заголовок с чипами и инструментами, форма полей, ступени шкалы.
// Состояние держит editor.js; карточка только вызывает операции из model.js через api.

import { h } from "../dom.js";
import { formatDecimal } from "../format.js";
import { criterionChips } from "./viewer.js";
import { adminIcon } from "./icons.js";
import { addScaleStep, canMove, criterionLabel, moveCriterion, moveCriterionToSection, removeCriterion, removeScaleStep,
  replaceCriterion, sectionOf, setAnswerType, setCritical, toNumber, updateCriterion, updateScaleStep, weightSum } from "./model.js";
import { badge, field, iconButton, nextId } from "./ui.js";

/**
 * @typedef {{ doc: () => import("./model.js").DraftDoc, isExpanded: (id: string) => boolean, toggle: (id: string) => void,
 *   edit: (doc: object) => void, restructure: (doc: object, focusKey?: string, expandId?: string) => void,
 *   register: (key: string, handle: { setError: Function }) => void, touch: (key: string) => void,
 *   reservedIds: string[], mark: (id: string) => "new" | "changed" | null, replacedFrom: Map<string, string> }} EditorApi
 * @param {import("./model.js").DraftCriterion} criterion @param {EditorApi} api
 */
export function criterionCard(criterion, api) {
  const doc = api.doc();
  const id = criterion.id;
  const bodyId = nextId("cqa-ed-body");
  const expanded = api.isExpanded(id);
  const toggle = h("button", {
    className: "cqa-ed-crit__toggle",
    attrs: { type: "button", "aria-expanded": String(expanded), "aria-controls": bodyId, "data-key": `${id}:toggle` },
    on: { click: () => api.toggle(id) },
  },
  h("span", { className: "cqa-ed-crit__title", text: criterion.title.trim() || "Новый критерий — заполните название" }),
  h("span", { className: "cqa-ed-crit__chips" }, criterionChips(criterion, api.mark(id))),
  adminIcon("chevron", { size: 20, className: "cqa-ed-crit__chevron" }));

  const replaced = api.replacedFrom.get(id);
  return h("li", { className: "cqa-ed-crit", dataset: { criterion: id, state: api.mark(id) ?? "same" } },
    h("div", { className: "cqa-ed-crit__head" },
      h("span", { className: "cqa-ed-crit__num", text: criterionLabel(doc, id) }),
      toggle,
      h("span", { className: "cqa-ed-crit__issues", attrs: { "aria-hidden": "true" } }),
      tools(criterion, api)),
    replaced ? h("p", { className: "cqa-ed-crit__note", text: `Заменяет критерий ${replaced}. Вес и тип ответа перенесены — опишите новый критерий.` }) : null,
    h("div", { className: "cqa-ed-crit__body", attrs: { id: bodyId, hidden: !expanded } }, expanded ? form(criterion, api) : null));
}

/** Обновляет заголовок карточки без перерисовки формы (ввод текста не теряет фокус). */
export function refreshCardHead(cardEl, criterion, api) {
  const title = cardEl.querySelector(".cqa-ed-crit__title");
  if (title) title.textContent = criterion.title.trim() || "Новый критерий — заполните название";
  const chips = cardEl.querySelector(".cqa-ed-crit__chips");
  if (chips) chips.replaceChildren(...criterionChips(criterion, api.mark(criterion.id)).filter(Boolean));
  cardEl.dataset.state = api.mark(criterion.id) ?? "same";
  const share = cardEl.querySelector("[data-share]");
  if (share) share.textContent = shareText(api.doc(), criterion);
  for (const points of cardEl.querySelectorAll(".cqa-ed-scale__points[data-step]")) {
    points.textContent = stepPointsText(criterion, Number(points.dataset.step));
  }
}

/** «= 15 из 20»: сколько баллов даёт ступень при текущем весе. */
function stepPointsText(criterion, index) {
  const values = criterion.scale.map((s) => toNumber(s.value)).filter(Number.isFinite);
  const top = values.length ? Math.max(0, ...values) : 0;
  const weight = toNumber(criterion.weight) || 0;
  const value = toNumber(criterion.scale[index]?.value);
  if (!(top > 0) || !Number.isFinite(value)) return "";
  return `= ${formatDecimal(Math.round((value / top) * weight * 100) / 100)} из ${formatDecimal(weight)}`;
}

function tools(criterion, api) {
  const doc = api.doc();
  const id = criterion.id;
  const { up, down } = canMove(doc, id);
  const label = criterionLabel(doc, id);
  return h("div", { className: "cqa-ed-crit__tools" },
    iconButton({ label: `Переместить критерий ${label} выше`, iconName: "up", disabled: !up, attrs: { "data-key": `${id}:up` },
      onClick: () => api.restructure(moveCriterion(api.doc(), id, -1), `${id}:up`) }),
    iconButton({ label: `Переместить критерий ${label} ниже`, iconName: "down", disabled: !down, attrs: { "data-key": `${id}:down` },
      onClick: () => api.restructure(moveCriterion(api.doc(), id, 1), `${id}:down`) }),
    iconButton({ label: `Заменить критерий ${label} новым`, iconName: "swap", attrs: { "data-key": `${id}:replace` },
      onClick: () => {
        const result = replaceCriterion(api.doc(), id, { reservedIds: api.reservedIds });
        api.replacedFrom.set(result.id, `${label} «${criterion.title.trim() || "без названия"}»`);
        api.restructure(result.doc, `${result.id}:title`, result.id);
      } }),
    iconButton({ label: `Удалить критерий ${label}`, iconName: "trash", className: "cqa-a-icon-btn--danger", attrs: { "data-key": `${id}:remove` },
      onClick: () => api.restructure(removeCriterion(api.doc(), id), nextFocusAfterRemoval(api.doc(), id)) }));
}

function nextFocusAfterRemoval(doc, id) {
  const section = sectionOf(doc, id);
  if (!section) return "add-section";
  const position = section.criteria.indexOf(id);
  const neighbour = section.criteria[position + 1] ?? section.criteria[position - 1];
  return neighbour ? `${neighbour}:toggle` : `${section.id}:add`;
}

/* ---------- форма ---------- */

function form(criterion, api) {
  const id = criterion.id;
  const isScale = criterion.answerType === "scale";
  return h("div", { className: "cqa-ed-form" },
    textField(api, criterion, "title", "Название", { className: "cqa-ed-form__wide", placeholder: "Например: Предложил дальнейшую помощь" }),
    h("div", { className: "cqa-ed-form__row" },
      answerTypeField(criterion, api),
      weightField(criterion, api),
      h("div", { className: "cqa-ed-form__switches" },
        switchControl(api, `${id}:naAllowed`, "N/A допустим", criterion.naAllowed,
          (checked) => api.restructure(updateCriterion(api.doc(), id, { naAllowed: checked }), `${id}:naAllowed`, id)),
        switchControl(api, `${id}:critical`, "Грубая ошибка — без баллов", criterion.critical,
          (checked) => api.restructure(setCritical(api.doc(), id, checked), `${id}:critical`, id)))),
    h("div", { className: "cqa-ed-form__row" },
      sectionField(criterion, api),
      h("p", { className: "cqa-ed-form__id" }, "id ", h("code", { text: id }), api.mark(id) === "new" ? " · новый, оценится с нуля" : "")),
    isScale ? null : textArea(api, criterion, "yes", "Когда «Да»", "Что должен сделать оператор, чтобы критерий был выполнен."),
    textArea(api, criterion, "no", "Когда «Нет» (необязательно)", "Уточнение для спорных случаев: что считается невыполнением."),
    criterion.naAllowed ? textArea(api, criterion, "na", "Когда N/A", "Условие неприменимости — тогда вес перераспределяется между остальными.") : null,
    isScale ? scaleEditor(criterion, api) : null,
    textArea(api, criterion, "guidance", "Указания для ИИ-оценщика (необязательно)",
      "Правила для спорных мест — попадают в промпт модели. Например: «формальное „верно?“ не считается уточнением».", 3));
}

function textField(api, criterion, key, label, { className = "", placeholder = "" } = {}) {
  const id = criterion.id;
  const input = h("input", {
    className: "cqa-a-input",
    attrs: { type: "text", value: criterion[key], placeholder, autocomplete: "off", "data-key": `${id}:${key}`, maxlength: 200 },
  });
  const handle = field({ label, control: input, className });
  input.addEventListener("input", () => api.edit(updateCriterion(api.doc(), id, { [key]: input.value })));
  input.addEventListener("change", () => api.touch(`criterion:${id}:${key}`));
  api.register(`criterion:${id}:${key}`, handle);
  return handle.el;
}

function textArea(api, criterion, key, label, hint, rows = 2) {
  const id = criterion.id;
  const area = h("textarea", { className: "cqa-a-input cqa-a-textarea", attrs: { rows, "data-key": `${id}:${key}`, maxlength: 4000 } });
  area.value = criterion[key];
  const handle = field({ label, control: area, hint, className: "cqa-ed-form__wide" });
  area.addEventListener("input", () => api.edit(updateCriterion(api.doc(), id, { [key]: area.value })));
  area.addEventListener("change", () => api.touch(`criterion:${id}:${key}`));
  api.register(`criterion:${id}:${key}`, handle);
  return handle.el;
}

function answerTypeField(criterion, api) {
  const id = criterion.id;
  const name = nextId("cqa-ed-type");
  const option = (value, label) => {
    const input = h("input", { className: "cqa-ed-radio__input", attrs: { type: "radio", name, value, checked: criterion.answerType === value, "data-key": `${id}:answerType:${value}` } });
    input.addEventListener("change", () => {
      if (input.checked) api.restructure(setAnswerType(api.doc(), id, value), `${id}:answerType:${value}`, id);
    });
    return h("label", { className: "cqa-ed-radio" }, input, h("span", { className: "cqa-ed-radio__label", text: label }));
  };
  return h("fieldset", { className: "cqa-ed-fieldset" },
    h("legend", { className: "cqa-a-field__label", text: "Тип ответа" }),
    h("div", { className: "cqa-ed-radios" }, option("yes_no", "Да / Нет"), option("scale", "Шкала")));
}

function weightField(criterion, api) {
  const id = criterion.id;
  const input = h("input", {
    className: "cqa-a-input cqa-a-input--num",
    attrs: { type: "text", inputmode: "decimal", value: String(criterion.critical ? 0 : criterion.weight), disabled: criterion.critical, "data-key": `${id}:weight`, autocomplete: "off", maxlength: 8 },
  });
  const handle = field({ label: "Вес", control: input, className: "cqa-ed-form__weight" });
  const share = h("p", { className: "cqa-a-field__hint", attrs: { "data-share": "" }, text: shareText(api.doc(), criterion) });
  handle.el.insertBefore(share, handle.el.querySelector(".cqa-a-field__error"));
  input.addEventListener("input", () => {
    const raw = input.value.trim();
    const value = toNumber(raw);
    api.edit(updateCriterion(api.doc(), id, { weight: Number.isFinite(value) ? value : raw }));
  });
  input.addEventListener("change", () => api.touch(`criterion:${id}:weight`));
  api.register(`criterion:${id}:weight`, handle);
  return handle.el;
}

function shareText(doc, criterion) {
  if (criterion.critical) return "Отдельная отметка, в итог не входит";
  const sum = weightSum(doc);
  const weight = toNumber(criterion.weight);
  if (!Number.isFinite(weight) || !(sum > 0)) return "Доля в итоге — после ввода веса";
  return `≈ ${formatDecimal(Math.round((weight / sum) * 10000) / 100)}% итога`;
}

function switchControl(api, key, label, checked, onToggle) {
  const input = h("input", { className: "cqa-ed-switch__input", attrs: { type: "checkbox", role: "switch", checked, "data-key": key } });
  input.addEventListener("change", () => onToggle(input.checked));
  return h("label", { className: "cqa-ed-switch" }, input, h("span", { className: "cqa-ed-switch__track", attrs: { "aria-hidden": "true" } }), h("span", { text: label }));
}

function sectionField(criterion, api) {
  const id = criterion.id;
  const doc = api.doc();
  const current = sectionOf(doc, id)?.id ?? "";
  const select = h("select", { className: "cqa-a-input cqa-a-select", attrs: { "data-key": `${id}:section` } },
    doc.sections.map((s) => h("option", { attrs: { value: s.id, selected: s.id === current }, text: s.title.trim() || "Без названия" })));
  select.addEventListener("change", () => api.restructure(moveCriterionToSection(api.doc(), id, select.value), `${id}:section`, id));
  const handle = field({ label: "Секция", control: select });
  api.register(`criterion:${id}:section`, handle);
  return handle.el;
}

/* ---------- шкала ---------- */

function scaleEditor(criterion, api) {
  const id = criterion.id;
  const rows = criterion.scale.map((step, i) => {
    const value = h("input", {
      className: "cqa-a-input cqa-a-input--num",
      attrs: { type: "text", inputmode: "decimal", value: String(step.value), "aria-label": `Значение ступени ${i + 1}`, "data-key": `${id}:scale.${i}.value`, maxlength: 6 },
    });
    const label = h("input", {
      className: "cqa-a-input",
      attrs: { type: "text", value: step.label, "aria-label": `Когда ставится ступень ${i + 1}`, placeholder: "Когда ставится эта ступень", "data-key": `${id}:scale.${i}.label`, maxlength: 400 },
    });
    const valueHandle = field({ label: "Значение", control: value, className: "cqa-ed-scale__value" });
    const labelHandle = field({ label: "Описание", control: label, className: "cqa-ed-scale__label" });

    value.addEventListener("input", () => {
      const parsed = toNumber(value.value);
      api.edit(updateScaleStep(api.doc(), id, i, { value: Number.isFinite(parsed) ? parsed : value.value }));
    });
    label.addEventListener("input", () => api.edit(updateScaleStep(api.doc(), id, i, { label: label.value })));
    value.addEventListener("change", () => api.touch(`criterion:${id}:scale.${i}.value`));
    label.addEventListener("change", () => api.touch(`criterion:${id}:scale.${i}.label`));
    api.register(`criterion:${id}:scale.${i}.value`, valueHandle);
    api.register(`criterion:${id}:scale.${i}.label`, labelHandle);
    return h("li", { className: "cqa-ed-scale__row" },
      valueHandle.el, labelHandle.el,
      h("span", { className: "cqa-ed-scale__points", dataset: { step: String(i) }, text: stepPointsText(criterion, i) }),
      iconButton({ label: `Удалить ступень ${i + 1}`, iconName: "close", attrs: { "data-key": `${id}:scale.${i}.remove` },
        onClick: () => api.restructure(removeScaleStep(api.doc(), id, i), `${id}:scale.add`, id) }));
  });
  const summary = h("p", { className: "cqa-a-field__error", attrs: { hidden: true } });
  api.register(`criterion:${id}:scale`, {
    setError(message, level = "error") {
      summary.textContent = message;
      summary.hidden = !message;
      summary.dataset.level = level;
    },
  });
  return h("fieldset", { className: "cqa-ed-fieldset cqa-ed-scale cqa-ed-form__wide" },
    h("legend", { className: "cqa-a-field__label", text: "Ступени шкалы" }),
    h("p", { className: "cqa-a-field__hint", text: "Верхняя ступень даёт полный вес, остальные — пропорционально. Порядок не важен — при сохранении ступени отсортируются." }),
    h("ol", { className: "cqa-ed-scale__list" }, rows),
    summary,
    h("button", {
      className: "cqa-ed-add cqa-ed-add--inline",
      attrs: { type: "button", "data-key": `${id}:scale.add` },
      on: { click: () => api.restructure(addScaleStep(api.doc(), id), `${id}:scale.${criterion.scale.length}.label`, id) },
    }, adminIcon("plus", { size: 18 }), "Добавить ступень"));
}

/** Бейдж с числом ошибок в заголовке карточки (видно и у свёрнутой). */
export function setCardIssues(cardEl, errors, warnings) {
  const holder = cardEl.querySelector(".cqa-ed-crit__issues");
  if (!holder) return;
  cardEl.toggleAttribute("data-invalid", errors > 0);
  const items = [
    errors ? badge(`${errors} ${errors === 1 ? "ошибка" : errors < 5 ? "ошибки" : "ошибок"}`, "error") : null,
    !errors && warnings ? badge("проверьте", "warning") : null,
  ];
  holder.replaceChildren(...items.filter(Boolean));
}
