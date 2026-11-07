// Транскрипт диалога: реплики по ролям, якоря #N, плеер звонка с перемоткой по тайм-кодам
// и подсветкой текущей реплики во время воспроизведения. Из панели оценки сюда приходят
// переходы к репликам-доказательствам, проверенный участок и отметки критериев у реплик.

import { focusWithoutScroll, h, prefersReducedMotion } from "../dom.js";
import { icon } from "../icons.js";
import { SPEAKERS, clockFromTimestamp, formatDuration, isIsoTimestamp, messageNumber, speakerName } from "../format.js";
import { buildHash, paths, replaceHash } from "../router.js";

const CURRENT_LEAD_SEC = 0.25;
const TARGET_FLASH_MS = 3800;

export const messageDomId = (index) => `cqa-msg-${index}`;

/**
 * @param {{ id: string, channel: string, audioUrl: string | null, messages: ReadonlyArray<object> }} conversation
 * @param {{ groupId: string, onMarker?: (criterionId: string) => void }} options
 * @returns {{ el: HTMLElement, focusMessage: (index: number, options?: { seek?: boolean }) => boolean,
 *   highlightRange: (range: readonly [number, number]) => boolean, setMarkers: (markers: Map<number, Array<object>>) => void,
 *   dispose: () => void }}
 */
export function renderTranscript(conversation, { groupId, onMarker }) {
  const hasAudio = conversation.channel === "call" && Boolean(conversation.audioUrl);
  const items = new Map();
  const offsets = new Map(conversation.messages.map((message) => [message.index, message.offsetSec]));
  const list = h("ol", { className: "cqa-msgs", attrs: { "aria-label": "Реплики диалога" } },
    conversation.messages.map((message) => {
      const li = messageItem(message, { conversationId: conversation.id, groupId, hasAudio });
      items.set(message.index, li);
      return li;
    }));
  const player = hasAudio ? createPlayer(conversation, items) : null;
  const announcer = h("p", { className: "cqa-sr-only", attrs: { role: "status" } });
  let flashTimer = 0;
  let range = [];

  function focusMessage(index, { seek = false } = {}) {
    const li = items.get(index);
    if (!li) return false;
    if (seek) clearRange();
    li.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    flash(li);
    focusWithoutScroll(li.querySelector(".cqa-msg__num"));
    const offset = offsets.get(index);
    if (seek && player && typeof offset === "number") player.seek(offset);
    return true;
  }

  function flash(li) {
    li.classList.remove("is-target");
    void li.offsetWidth; // перезапуск анимации подсветки
    li.classList.add("is-target");
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => li.classList.remove("is-target"), TARGET_FLASH_MS);
  }

  /** Проверенный участок (где ожидалось пропущенное действие) — подсветка до следующего перехода. */
  function highlightRange([from, to]) {
    clearRange();
    range = [...items.entries()].filter(([index]) => index >= from && index <= to).map(([, li]) => li);
    if (range.length === 0) return false;
    range.forEach((li, i) => {
      li.classList.add("is-range");
      if (i === 0) li.classList.add("is-range-start");
      if (i === range.length - 1) li.classList.add("is-range-end");
    });
    range[0].scrollIntoView({ block: range.length > 4 ? "start" : "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    focusWithoutScroll(range[0].querySelector(".cqa-msg__num"));
    announcer.textContent = `Подсвечен проверенный участок: реплики ${messageNumber(from)}–${messageNumber(to)}`;
    return true;
  }

  function clearRange() {
    for (const li of range) li.classList.remove("is-range", "is-range-start", "is-range-end");
    range = [];
  }

  /** Отметки критериев у реплик-доказательств (невыполненные критерии и грубая ошибка). */
  function setMarkers(markers) {
    for (const li of items.values()) {
      li.querySelector(".cqa-msg__marks")?.remove();
      li.classList.remove("has-critical");
    }
    for (const [index, list] of markers) {
      const li = items.get(index);
      const meta = li?.querySelector(".cqa-msg__meta, .cqa-msg__sys");
      if (!meta) continue;
      if (list.some((marker) => marker.tone === "critical")) li.classList.add("has-critical");
      meta.append(h("span", { className: "cqa-msg__marks" }, list.map((marker) => h("button", {
        className: `cqa-mark cqa-mark--${marker.tone}`,
        attrs: { type: "button", "data-criterion": marker.criterionId, title: `Доказательство по критерию ${marker.number} «${marker.title}» — показать в оценке` },
      }, marker.tone === "critical" ? `${marker.number} · грубая ошибка` : `Критерий ${marker.number}`))));
    }
  }

  list.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const seek = target?.closest("[data-seek]");
    if (seek && player) {
      player.seek(Number(seek.getAttribute("data-seek")));
      return;
    }
    const mark = target?.closest("[data-criterion]");
    if (mark) {
      onMarker?.(mark.getAttribute("data-criterion"));
      return;
    }
    const anchor = target?.closest(".cqa-msg__num");
    if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); // без hashchange: перерисовка остановила бы плеер
    replaceHash(anchor.getAttribute("href"));
    focusMessage(Number(anchor.getAttribute("data-index")));
  });

  const el = h("div", { className: "cqa-transcript__body" },
    player ? player.el : null,
    list,
    announcer);
  return {
    el,
    focusMessage,
    highlightRange,
    setMarkers,
    dispose() {
      window.clearTimeout(flashTimer);
      player?.dispose();
    },
  };
}

/** Легенда ролей для заголовка транскрипта. */
export function roleLegend() {
  return h("ul", { className: "cqa-legend", attrs: { "aria-label": "Роли" } },
    SPEAKERS.map((speaker) => h("li", { className: `cqa-pill cqa-pill--gray cqa-pill--sm cqa-role-${speaker}` },
      h("span", { className: "cqa-roles__dot", attrs: { "aria-hidden": "true" } }), speakerName(speaker))));
}

/* ---------- реплика ---------- */

function messageItem(message, { conversationId, groupId, hasAudio }) {
  const number = messageNumber(message.index);
  const anchor = h("a", {
    className: "cqa-msg__num",
    attrs: {
      href: buildHash(paths.conversation(conversationId), { g: groupId, m: message.index }),
      "aria-label": `Реплика ${number}, ссылка`, title: "Ссылка на реплику", "data-index": message.index,
    },
    text: `#${number}`,
  });
  const seek = hasAudio && message.offsetSec !== null ? seekButton(message.offsetSec) : null;
  const meta = [anchor, seek, timeLabel(message.timestamp)];
  const base = { attrs: { id: messageDomId(message.index), "data-index": message.index } };

  if (message.speaker === "system") {
    return h("li", { className: "cqa-msg cqa-msg--system", ...base },
      h("div", { className: "cqa-msg__sys" },
        h("span", { className: "cqa-sr-only", text: "Системное событие: " }),
        h("span", { className: "cqa-msg__sys-text", text: message.text }),
        meta));
  }
  return h("li", { className: `cqa-msg cqa-msg--${message.speaker}`, ...base },
    h("div", { className: "cqa-msg__bubble" },
      h("div", { className: "cqa-msg__meta" }, h("span", { className: "cqa-msg__role", text: speakerName(message.speaker) }), meta),
      h("p", { className: "cqa-msg__text", text: message.text })));
}

function seekButton(offsetSec) {
  const label = formatDuration(offsetSec);
  return h("button", {
    className: "cqa-msg__seek",
    attrs: { type: "button", "data-seek": offsetSec, "aria-label": `Перемотать запись к ${label}`, title: "Перемотать запись к этой реплике" },
  }, icon("play", { size: 12 }), label);
}

function timeLabel(timestamp) {
  if (!timestamp) return null;
  if (!isIsoTimestamp(timestamp)) {
    return h("span", { className: "cqa-msg__time", attrs: { title: `Исходное время: ${timestamp}` }, text: timestamp });
  }
  const datetime = timestamp.replace(/(\.\d{3})\d+/, "$1");
  return h("time", {
    className: "cqa-msg__time",
    attrs: { datetime, title: `Исходное время: ${timestamp}` },
    text: clockFromTimestamp(timestamp),
  });
}

/* ---------- плеер звонка ---------- */

function createPlayer(conversation, items) {
  const timeline = conversation.messages
    .filter((message) => message.offsetSec !== null)
    .map((message) => ({ index: message.index, at: message.offsetSec }))
    .sort((a, b) => a.at - b.at);
  const audio = h("audio", { className: "cqa-player__audio", attrs: { controls: true, preload: "metadata", src: conversation.audioUrl } });
  const follow = h("input", { attrs: { type: "checkbox", checked: true } });
  const notice = h("p", { className: "cqa-player__error", attrs: { role: "alert", hidden: true } });
  const el = h("section", { className: "cqa-player", attrs: { "aria-label": "Запись звонка" } },
    h("div", { className: "cqa-player__top" },
      h("h3", { className: "cqa-player__title", text: "Запись звонка" }),
      h("p", { className: "cqa-player__hint", text: "Нажмите на тайм-код реплики — запись перемотается" })),
    audio,
    h("div", { className: "cqa-player__opts" },
      h("label", { className: "cqa-check" }, follow, "Следовать за записью"),
      h("span", { className: "cqa-num", text: `Транскрипт: ${formatDuration(timeline.at(-1)?.at ?? 0)}` })),
    notice);

  let current = null;
  const sync = () => {
    const t = audio.currentTime + CURRENT_LEAD_SEC;
    let found = null;
    for (const point of timeline) {
      if (point.at > t) break;
      found = point.index;
    }
    if (found === current) return;
    items.get(current)?.classList.remove("is-current");
    current = found;
    const li = items.get(found);
    li?.classList.add("is-current");
    if (li && follow.checked && !audio.paused) keepInView(li, el);
  };
  const onError = () => showNotice("Не удалось загрузить запись: источник недоступен или ссылка устарела. Обновите страницу позже.");
  const showNotice = (text) => {
    notice.textContent = text;
    notice.hidden = false;
  };

  audio.addEventListener("timeupdate", sync);
  audio.addEventListener("seeked", sync);
  audio.addEventListener("error", onError);

  return {
    el,
    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      notice.hidden = true;
      audio.currentTime = Math.max(0, seconds);
      sync();
      audio.play().catch((error) => {
        // AbortError — воспроизведение прервано новой перемоткой, это штатно.
        if (error?.name === "NotAllowedError") showNotice("Браузер не дал начать воспроизведение — нажмите ▶ в плеере.");
      });
    },
    dispose() {
      audio.pause();
      audio.removeEventListener("timeupdate", sync);
      audio.removeEventListener("seeked", sync);
      audio.removeEventListener("error", onError);
      audio.removeAttribute("src");
      audio.load();
    },
  };
}

function keepInView(li, stickyEl) {
  const rect = li.getBoundingClientRect();
  const top = Math.max(0, stickyEl.getBoundingClientRect().bottom) + 8;
  if (rect.top >= top && rect.bottom <= window.innerHeight - 16) return;
  li.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}
