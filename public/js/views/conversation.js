// Карточка диалога: герой со сводкой, транскрипт (с плеером для звонков) и панель «Оценка».
// Транскрипт и чек-лист грузятся независимо: медленный API кейса не задерживает панель.

import {
  fetchChecklist, fetchConversation, isAbortError, isValidId, peekChecklist, peekConversation, peekListing,
} from "../api.js";
import { h } from "../dom.js";
import { FORMS, SPEAKERS, channelName, countLabel, formatDurationLong, formatInt, languageName, speakerName } from "../format.js";
import { DEFAULT_GROUP, buildHash, paths, replaceHash } from "../router.js";
import { icon } from "../icons.js";
import { button, loadingNote, stateBlock, statChip, statSkeletons } from "../components/ui.js";
import { createEvalPanel } from "./evalPanel.js";
import { renderTranscript, roleLegend } from "./transcript.js";

/** @param {HTMLElement} main @param {object} ctx */
export function renderConversation(main, ctx) {
  const { groupId } = ctx;
  const id = ctx.route.id ?? "";
  const targetIndex = parseIndex(ctx.route.query.get("m"));
  const controller = new AbortController();
  const state = { transcript: null, note: null, pending: null, markers: new Map() };
  ctx.setTitle(id || "Диалог");

  const hero = buildHero(id, ctx.listHash);
  const slot = h("div", { className: "cqa-transcript__slot" });
  const transcriptSection = h("section", { className: "cqa-transcript", attrs: { "aria-labelledby": "cqa-transcript-title" } },
    h("div", { className: "cqa-section-head" },
      h("h2", { className: "cqa-h3", attrs: { id: "cqa-transcript-title" }, text: "Транскрипт" }),
      roleLegend()),
    slot);
  const valid = isValidId(id);
  const panel = valid ? createEvalPanel({
    groupId,
    conversationId: id,
    appealHref: (appealId) => buildHash(paths.appeals, { g: groupId, status: "all", id: appealId }),
    onEvidence: (index) => goTo({ kind: "message", index }),
    onRange: (range) => goTo({ kind: "range", range }),
    onMarkers: (markers) => {
      state.markers = markers;
      state.transcript?.setMarkers(markers);
    },
    onRetryChecklist: loadChecklist,
  }) : null;
  main.replaceChildren(hero.el, h("div", { className: "cqa-sheet" },
    h("div", { className: "cqa-container cqa-detail" }, transcriptSection, panel?.el ?? null)));

  const summary = peekListing(groupId)?.items.find((item) => item.id === id);
  if (summary) {
    hero.showSummary(summaryFromListItem(summary));
    panel?.setCall(summary.channel === "call");
  }

  if (!valid) {
    showConversationError({ code: "invalid_conversation_id", message: "В адресе указан некорректный id диалога." });
  } else {
    const cached = peekConversation(groupId, id);
    if (cached) showConversation(cached);
    else loadConversation();
    const cachedChecklist = peekChecklist();
    if (cachedChecklist) panel.showChecklist(cachedChecklist);
    loadChecklist(); // версия могла обновиться в редакторе — сверяем каждый раз
  }

  /** Переход из панели оценки к реплике или участку; транскрипт ещё грузится — выполним после. */
  function goTo(target) {
    if (!state.transcript) {
      state.pending = target;
      slot.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    if (target.kind === "range") {
      state.transcript.highlightRange(target.range);
      replaceHash(buildHash(paths.conversation(id), { g: groupId, m: target.range[0] }));
      return;
    }
    if (state.transcript.focusMessage(target.index, { seek: true })) {
      replaceHash(buildHash(paths.conversation(id), { g: groupId, m: target.index }));
    }
  }

  async function loadConversation() {
    state.note?.stop();
    state.note = loadingNote(`Загружаем диалог ${id}…`);
    slot.replaceChildren(state.note.el, transcriptSkeleton());
    try {
      showConversation(await fetchConversation(groupId, id, { signal: controller.signal }));
    } catch (error) {
      if (!isAbortError(error)) showConversationError(error);
    } finally {
      state.note?.stop();
    }
  }

  async function loadChecklist() {
    try {
      panel?.showChecklist(await fetchChecklist({ signal: controller.signal }));
    } catch (error) {
      if (!isAbortError(error)) panel?.showChecklistError(error);
    }
  }

  function showConversation(conversation) {
    state.transcript?.dispose();
    hero.showSummary(summaryFromConversation(conversation));
    panel?.setCall(conversation.channel === "call");
    if (conversation.messages.length === 0) {
      slot.replaceChildren(stateBlock({ kind: "empty", title: "В диалоге нет реплик", text: "Источник вернул пустой транскрипт." }));
      return;
    }
    state.transcript = renderTranscript(conversation, { groupId, onMarker: (criterionId) => panel?.reveal(criterionId) });
    state.transcript.setMarkers(state.markers);
    slot.replaceChildren(state.transcript.el);
    const pending = state.pending;
    state.pending = null;
    if (pending) window.requestAnimationFrame(() => goTo(pending));
    else if (targetIndex !== null) window.requestAnimationFrame(() => state.transcript?.focusMessage(targetIndex));
  }

  function showConversationError(error) {
    hero.showError();
    const actions = [
      button({ label: "Повторить", iconName: "refresh", onClick: loadConversation }),
      button({ label: "К списку диалогов", variant: "gray", href: ctx.listHash ?? buildHash(paths.conversations, { g: groupId || DEFAULT_GROUP }) }),
    ];
    const canRetry = isValidId(id) && error.status !== 404;
    slot.replaceChildren(stateBlock({
      kind: "error", title: "Не удалось открыть диалог", text: error.message, code: error.code,
      actions: canRetry ? actions : actions.slice(1),
    }));
  }

  return () => {
    controller.abort();
    state.note?.stop();
    state.transcript?.dispose();
    panel?.dispose();
  };
}

function parseIndex(value) {
  if (value === null || !/^\d{1,6}$/.test(value)) return null;
  return Number(value);
}

/* ---------- сводка для героя ---------- */

function summaryFromListItem(item) {
  return { channel: item.channel, language: item.language, messageCount: item.messageCount, counts: item.counts, durationSec: item.durationSec };
}

function summaryFromConversation(conversation) {
  const counts = Object.fromEntries(SPEAKERS.map((speaker) => [speaker, 0]));
  const tallied = conversation.messages.reduce((acc, m) => ({ ...acc, [m.speaker]: (acc[m.speaker] ?? 0) + 1 }), counts);
  const offsets = conversation.messages.map((m) => m.offsetSec).filter((v) => v !== null);
  const durationSec = conversation.channel === "call" && offsets.length ? Math.max(...offsets) - Math.min(...offsets) : null;
  return { channel: conversation.channel, language: conversation.language, messageCount: conversation.messages.length, counts: tallied, durationSec };
}

function buildHero(id, listHash) {
  const lead = h("p", { className: "cqa-lead cqa-grad-text", text: " " });
  const stats = h("ul", { className: "cqa-stats", attrs: { "aria-label": "Реплики по ролям" } }, statSkeletons(4));
  const el = h("section", { className: "cqa-hero cqa-hero--compact", attrs: { "aria-labelledby": "cqa-page-title" } },
    h("div", { className: "cqa-container" },
      h("div", { className: "cqa-hero__copy" },
        h("a", { className: "cqa-back cqa-hl", attrs: { href: listHash } }, icon("arrowLeft", { size: 18 }), "Все диалоги"),
        h("h1", { className: "cqa-display cqa-num", attrs: { id: "cqa-page-title", tabindex: "-1" }, text: id || "Диалог" }),
        lead,
        stats)));
  return {
    el,
    showSummary(summary) {
      const parts = [channelName(summary.channel), languageName(summary.language), countLabel(summary.messageCount, FORMS.message)];
      const duration = summary.channel === "call" ? formatDurationLong(summary.durationSec) : "";
      lead.textContent = [...parts, duration].filter(Boolean).join(" · ");
      stats.replaceChildren(...SPEAKERS.map((speaker) => statChip({
        value: formatInt(summary.counts[speaker] ?? 0), label: speakerName(speaker), dotClass: `cqa-role-${speaker}`, labelFirst: true,
      })));
    },
    showError() {
      lead.textContent = " ";
      stats.replaceChildren();
    },
  };
}

function transcriptSkeleton() {
  const widths = ["cqa-skel--w70", "cqa-skel--w90", "cqa-skel--w70", "cqa-skel--w90"];
  return h("div", { className: "cqa-msgs", attrs: { "aria-hidden": "true" } },
    widths.map((width, i) => h("div", { className: `cqa-msg ${i % 2 ? "cqa-msg--operator" : "cqa-msg--client"}` },
      h("div", { className: "cqa-msg__bubble cqa-msg__bubble--skeleton" },
        h("span", { className: `cqa-skel cqa-skel--line ${width}` }),
        h("span", { className: "cqa-skel cqa-skel--line cqa-skel--w70" })))));
}
