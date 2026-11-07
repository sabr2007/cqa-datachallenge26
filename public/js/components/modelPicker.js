// Выбор моделей оценки — компактный раскрывающийся блок. По умолчанию — модели сервера
// (поле models в запросе не отправляется); выбор общий для карточки и пакетной оценки в рамках сессии.

import { fetchModels } from "../api.js";
import { h } from "../dom.js";
import { icon } from "../icons.js";

const PROVIDERS = Object.freeze({ anthropic: "Anthropic", cloudflare: "Cloudflare Workers AI", ollama: "локально, Ollama" });

let selection = null; // null — модели по умолчанию сервера; иначе замороженный список id
let pickerSeq = 0;

/** Выбранные модели для запроса или null (умолчание сервера). */
export function selectedModels() {
  return selection;
}

/** @param {{ compact?: boolean }} [options] */
export function modelPicker({ compact = false } = {}) {
  const id = `cqa-models-${++pickerSeq}`;
  const value = h("span", { className: "cqa-models__value", text: "по умолчанию сервера" });
  const list = h("div", { className: "cqa-models__list", attrs: { id: `${id}-list` } },
    h("p", { className: "cqa-models__note", text: "Загружаем список моделей…" }));
  const el = h("details", { className: `cqa-models${compact ? " cqa-models--compact" : ""}` },
    h("summary", { className: "cqa-models__summary cqa-hl", attrs: { "aria-describedby": `${id}-hint` } },
      h("span", { className: "cqa-models__label", text: "Модели" }), value,
      icon("chevronDown", { size: 18, className: "cqa-models__chevron" })),
    h("fieldset", { className: "cqa-models__body" },
      h("legend", { className: "cqa-sr-only", text: "Модели для оценки" }),
      list,
      h("p", { className: "cqa-models__note", attrs: { id: `${id}-hint` },
        text: "Каждая модель оценивает критерии независимо; расхождение голосов отмечается «Нужна проверка»." })));

  let models = [];
  load();

  async function load() {
    try {
      models = await fetchModels();
      render();
    } catch (error) {
      list.replaceChildren(h("p", { className: "cqa-models__note cqa-models__note--error",
        text: `Список моделей недоступен (${error.message}). Оценка пойдёт на моделях по умолчанию сервера.` }));
    }
  }

  function defaults() {
    const ids = models.filter((m) => m.isDefault && m.available).map((m) => m.id);
    return ids.length ? ids : models.filter((m) => m.available).slice(0, 1).map((m) => m.id);
  }

  function effective() {
    const known = new Set(models.filter((m) => m.available).map((m) => m.id));
    const chosen = (selection ?? defaults()).filter((modelId) => known.has(modelId));
    return chosen.length ? chosen : defaults();
  }

  function render() {
    const chosen = new Set(effective());
    const items = models.map((model) => {
      const input = h("input", {
        attrs: { type: "checkbox", name: `${id}-model`, value: model.id, checked: chosen.has(model.id), disabled: !model.available },
        on: { change: onChange },
      });
      return h("label", { className: `cqa-models__item${model.available ? "" : " is-off"}` },
        input,
        h("span", { className: "cqa-models__name", text: model.label }),
        h("span", { className: "cqa-models__meta", text: [PROVIDERS[model.provider] ?? model.provider, model.isDefault ? "по умолчанию" : "", model.available ? "" : "недоступна"].filter(Boolean).join(" · ") }));
    });
    list.replaceChildren(...items);
    syncSummary();
  }

  function onChange(event) {
    const checked = [...list.querySelectorAll("input:checked")].map((input) => input.value);
    if (checked.length === 0) {
      event.target.checked = true; // хотя бы одна модель
      return;
    }
    const isDefault = sameSet(checked, defaults());
    selection = isDefault ? null : Object.freeze(checked);
    syncSummary();
  }

  function syncSummary() {
    const labels = effective().map((modelId) => models.find((m) => m.id === modelId)?.label ?? modelId);
    value.textContent = selection === null ? `по умолчанию: ${labels.join(", ")}` : labels.join(", ");
  }

  return {
    el,
    /** Обновить отметки после смены выбора в другом месте. */
    refresh: () => (models.length ? render() : undefined),
  };
}

function sameSet(a, b) {
  return a.length === b.length && a.every((value) => b.includes(value));
}
