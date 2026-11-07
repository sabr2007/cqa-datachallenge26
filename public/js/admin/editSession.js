// Режим правки: редактор + живой пересчёт + панель сохранения. Черновик переживает случайный уход
// со страницы (sessionStorage этого браузера), закрытие вкладки с несохранёнными правками — с предупреждением.

import { h } from "../dom.js";
import { plural } from "../format.js";
import { diffChecklists, summarizeDiff } from "./diff.js";
import { createEditor } from "./editor.js";
import { adminIcon } from "./icons.js";
import { versionLabel } from "./labels.js";
import { createPreview } from "./preview.js";
import { openSandbox } from "./sandbox.js";
import { actionButton, iconButton, liveRegion, setChildren } from "./ui.js";
import { validateDraft } from "./validate.js";

const STORAGE_PREFIX = "cqa.checklist.draft.";

/**
 * @param {{ checklistId: string, baseDoc: object, draft: import("./model.js").DraftDoc, reservedIds: string[],
 *   nextVersion: number | null | (() => number | null), latest: number | null, groupId: string, dialogHost: HTMLElement, signal: AbortSignal,
 *   onSave: (doc: object, note: string) => Promise<void>, onExit: () => void, onDraftChange: (doc: object) => void,
 *   onVersionsChanged: () => void }} options
 */
export function createEditSession(options) {
  const { checklistId, baseDoc, draft, reservedIds, nextVersion, latest, groupId, dialogHost, signal, onSave, onExit, onDraftChange, onVersionsChanged } = options;
  const upcomingVersion = typeof nextVersion === "function" ? nextVersion : () => nextVersion;
  const live = liveRegion();
  let saving = false;
  let saveError = "";
  let current = draft;
  let storeTimer = 0;

  const preview = createPreview({ groupId, signal });
  const editor = createEditor({
    doc: draft,
    baseDoc,
    reservedIds,
    onChange: (doc) => {
      current = doc;
      saveError = "";
      update();
      scheduleStore();
      onDraftChange(doc);
    },
  });
  const note = h("input", {
    className: "cqa-a-input cqa-sbar__note-input",
    attrs: { type: "text", maxlength: 300, autocomplete: "off", "aria-label": "Заметка к новой версии", "data-key": "sbar:note" },
  });
  const status = h("div", { className: "cqa-sbar__status" });
  const undoButton = iconButton({ label: "Отменить последнее действие", iconName: "undo", className: "cqa-sbar__undo", onClick: () => editor.undo() });
  const saveButton = actionButton({ label: "Сохранить", iconName: "check", variant: "dark", className: "cqa-sbar__save", attrs: { "data-key": "sbar:save" }, onClick: save });
  const bar = h("div", { className: "cqa-sbar", attrs: { role: "region", "aria-label": "Сохранение черновика" } },
    status,
    h("div", { className: "cqa-sbar__note" }, note),
    h("div", { className: "cqa-sbar__actions" },
      undoButton,
      actionButton({ label: "Песочница", iconName: "flask", variant: "gray sm", attrs: { title: "Проверить черновик на размеченных диалогах", "data-key": "sbar:sandbox" }, onClick: sandbox }),
      actionButton({ label: "Выйти", variant: "gray sm", attrs: { "data-key": "sbar:exit" }, onClick: exit }),
      saveButton),
    live.el);

  const baseNote = Number.isInteger(baseDoc.version) && latest !== null && baseDoc.version !== latest
    ? h("p", { className: "cqa-a-alert", text: `Черновик основан на ${versionLabel(baseDoc.version)}, а действующая — ${versionLabel(latest)}. Новая версия заменит изменения ${versionLabel(latest)}.` })
    : null;
  const el = h("div", { className: "cqa-edit" },
    h("div", { className: "cqa-edit__grid" },
      h("div", { className: "cqa-edit__main" }, baseNote, editor.el),
      h("aside", { className: "cqa-edit__aside" }, preview.el)),
    bar);

  const onBeforeUnload = (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  update();

  function isDirty() {
    return !diffChecklists(baseDoc, current).isEmpty;
  }

  function update() {
    const { errors, warnings, all } = validateDraft(current);
    editor.setIssues(all);
    preview.update(baseDoc, current);
    const diff = diffChecklists(baseDoc, current);
    const changes = diff.added.length + diff.changed.length + diff.removed.length + diff.sections.length + (diff.title ? 1 : 0) + (diff.reordered ? 1 : 0);
    note.placeholder = summarizeDiff(diff) || "Заметка: что и зачем изменили";
    bar.dataset.dirty = String(!diff.isEmpty);
    undoButton.disabled = !editor.canUndo();
    saveButton.setAttribute("aria-disabled", String(saving || diff.isEmpty));
    saveButton.lastChild.textContent = saving ? "Сохраняем…" : `Сохранить как ${versionLabel(upcomingVersion())}`;
    const firstError = errors[0];
    setChildren(status,
      h("p", { className: "cqa-sbar__base", text: `Черновик на основе ${versionLabel(baseDoc.version)}` }),
      h("p", { className: "cqa-sbar__summary" },
        diff.isEmpty ? "Изменений пока нет" : `${changes} ${plural(changes, ["изменение", "изменения", "изменений"])}`,
        errors.length
          ? h("button", { className: "cqa-sbar__errors", attrs: { type: "button" }, on: { click: () => editor.focusIssue(firstError) } },
            adminIcon("alert", { size: 16 }), `${errors.length} ${plural(errors.length, ["ошибка", "ошибки", "ошибок"])} — к первой`)
          : warnings.length ? h("span", { className: "cqa-sbar__warn", text: ` · ${warnings.length} ${plural(warnings.length, ["предупреждение", "предупреждения", "предупреждений"])}` }) : null),
      saveError ? h("p", { className: "cqa-sbar__error", attrs: { role: "alert" }, text: saveError }) : null);
  }

  async function save() {
    if (saving) return;
    const diff = diffChecklists(baseDoc, current);
    if (diff.isEmpty) {
      live.say("Изменений нет — сохранять нечего.");
      return;
    }
    const { errors } = validateDraft(current);
    if (errors.length) {
      editor.revealAll();
      editor.focusIssue(errors[0]);
      live.say(`Не сохранено: ${errors.length} ${plural(errors.length, ["ошибка", "ошибки", "ошибок"])}. ${errors[0].message}`);
      return;
    }
    saving = true;
    saveError = "";
    update();
    try {
      await onSave(current, note.value.trim() || summarizeDiff(diff));
      clearStoredDraft(checklistId);
    } catch (error) {
      saveError = `Не удалось сохранить: ${error.message}`;
      live.say(saveError);
    } finally {
      saving = false;
      if (el.isConnected) update();
    }
  }

  function sandbox() {
    const { errors } = validateDraft(current);
    if (errors.length) {
      editor.revealAll();
      editor.focusIssue(errors[0]);
      live.say("Сначала исправьте ошибки в черновике.");
      return;
    }
    openSandbox({ host: dialogHost, checklistId, draft: current, baseDoc, onPromote: save, onVersionsChanged });
  }

  function exit() {
    if (isDirty() && !window.confirm("Выйти из редактора? Несохранённые изменения будут потеряны.")) return;
    clearStoredDraft(checklistId);
    onExit();
  }

  function scheduleStore() {
    window.clearTimeout(storeTimer);
    storeTimer = window.setTimeout(() => {
      if (isDirty()) storeDraft(checklistId, baseDoc.version, current);
      else clearStoredDraft(checklistId);
    }, 400);
  }

  return {
    el,
    isDirty,
    /** Перерисовать панель сохранения (например, после новой версии из песочницы). */
    refresh: update,
    getDoc: () => current,
    focusFirst: () => el.querySelector('[data-key="doc:title"]')?.focus({ preventScroll: true }),
    /** discard: черновик сохранён или отброшен — не оставлять его в sessionStorage. */
    destroy({ discard = false } = {}) {
      window.clearTimeout(storeTimer);
      if (discard) clearStoredDraft(checklistId);
      else if (isDirty()) storeDraft(checklistId, baseDoc.version, current);
      window.removeEventListener("beforeunload", onBeforeUnload);
    },
  };
}

/* ---------- черновик в sessionStorage (удобство одного браузера; без него всё работает) ---------- */

/** @returns {{ baseVersion: number | null, doc: object, savedAt: string } | null} */
export function readStoredDraft(checklistId) {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + checklistId);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" && value.doc && Array.isArray(value.doc.criteria) ? value : null;
  } catch {
    return null;
  }
}

export function clearStoredDraft(checklistId) {
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + checklistId);
  } catch {
    // хранилище недоступно (приватный режим) — черновик просто не восстановится
  }
}

function storeDraft(checklistId, baseVersion, doc) {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + checklistId, JSON.stringify({ baseVersion, doc, savedAt: new Date().toISOString() }));
  } catch {
    // хранилище недоступно или переполнено — не критично
  }
}
