// Экран «Диалоги»: герой со сводкой набора, фильтры (в том числе по результатам оценки),
// пакетная оценка, экспорт и таблица диалогов. Фильтры и сортировка живут в hash
// (?lang=&ch=&q=&status=&score=&appeal=&fail=&sort=&dir=), чтобы ссылкой можно было поделиться.

import { exportUrl, fetchChecklist, fetchListing, isAbortError, peekChecklist, peekListing } from "../api.js";
import { h } from "../dom.js";
import { icon } from "../icons.js";
import {
  CHANNELS, FORMS, LANGUAGES, countLabel, criterionNumber, formatFetchedAt, formatInt, languageName, normalizeForSearch, plural,
} from "../format.js";
import {
  APPEAL_FILTERS, SCORE_FILTERS, STATUS_FILTERS, UNAVAILABLE_HINT, effectiveTotal, hasEvaluations, isFailAnswer, matchesEvaluation,
} from "../evaluation.js";
import { isHosted } from "../host.js";
import { DEFAULT_GROUP, buildHash, paths, replaceHash } from "../router.js";
import { batchPanel } from "../components/batchBar.js";
import { filterGroup, searchField, segmented, selectFilter } from "../components/controls.js";
import { batchStateOf, getJob, subscribeBatch, subscribeJobs } from "../components/evalJobs.js";
import { button, loadingNote, skeletonRows, stateBlock, summaryCard, summarySkeleton } from "../components/ui.js";
import { conversationTable } from "./conversationTable.js";

const SKELETON_ROWS = 8;
const SEARCH_DEBOUNCE_MS = 150;
const CHANNEL_FILTERS = Object.freeze([{ value: "chat", label: "Чаты" }, { value: "call", label: "Звонки" }]);
const SORT_KEYS = Object.freeze(["id", "messages", "duration", "score"]);
const CRITERION_ID = /^[A-Za-z0-9_-]{1,32}$/;
const EMPTY_FILTERS = Object.freeze({ lang: "", ch: "", q: "", status: "", score: "", appeal: "", fail: "" });

/** @param {HTMLElement} main @param {object} ctx */
export function renderConversations(main, ctx) {
  const { groupId } = ctx;
  const controller = new AbortController();
  const view = { listing: null, filters: readFilters(ctx.route.query), note: null, checklist: peekChecklist(), frame: 0 };
  ctx.setTitle(`Диалоги · ${groupId}`);

  const hero = buildHero(groupId);
  const sheet = buildSheet(view.filters, groupId, { onFilters: changeFilters, onRefresh: () => load(true) });
  main.replaceChildren(hero.el, sheet.el);

  const cached = peekListing(groupId);
  if (cached) {
    show(cached);
    ctx.restoreScroll?.();
  } else {
    load(false);
  }
  loadChecklist();

  // Оценки идут в фоне (одиночные и пакет): список перерисовывается по событиям, не чаще кадра.
  const unsubscribeJobs = subscribeJobs(({ job }) => { if (job.groupId === groupId) scheduleRefresh(); });
  const unsubscribeBatch = subscribeBatch(() => scheduleRefresh());

  async function load(refresh) {
    view.note?.stop();
    view.note = loadingNote(refresh ? `Обновляем набор ${groupId} из API кейса…` : `Загружаем набор ${groupId} из API кейса…`);
    sheet.showLoading(view.note.el);
    hero.showLoading();
    try {
      show(await fetchListing(groupId, { signal: controller.signal, refresh }));
    } catch (error) {
      if (!isAbortError(error)) showError(error);
    } finally {
      view.note?.stop();
    }
  }

  async function loadChecklist() {
    try {
      view.checklist = await fetchChecklist({ signal: controller.signal });
      if (view.listing) sheet.showListing(view.listing, view.filters, view.checklist);
    } catch {
      // без чек-листа недоступен только фильтр «Не выполнен критерий»
    }
  }

  function show(listing) {
    view.listing = listing;
    hero.showListing(listing);
    sheet.showListing(listing, view.filters, view.checklist);
  }

  function scheduleRefresh() {
    if (view.frame) return;
    view.frame = window.requestAnimationFrame(() => {
      view.frame = 0;
      const listing = peekListing(groupId);
      if (listing) show(listing);
    });
  }

  function showError(error) {
    hero.showError();
    const actions = [button({ label: "Повторить", iconName: "refresh", onClick: () => load(false) })];
    if (groupId !== DEFAULT_GROUP) {
      actions.push(button({ label: `Открыть набор ${DEFAULT_GROUP}`, variant: "gray", href: buildHash(paths.conversations, { g: DEFAULT_GROUP }) }));
    }
    sheet.showState(stateBlock({ kind: "error", title: `Не удалось загрузить набор ${groupId}`, text: error.message, code: error.code, actions }));
  }

  function changeFilters(next) {
    view.filters = next;
    const hash = buildHash(paths.conversations, {
      g: groupId, lang: next.lang, ch: next.ch, q: next.q, status: next.status, score: next.score, appeal: next.appeal, fail: next.fail,
      sort: next.sort, dir: next.sort ? next.dir : "",
    });
    replaceHash(hash);
    ctx.onListHash?.(hash);
    if (view.listing) sheet.showListing(view.listing, next, view.checklist);
  }

  return () => {
    controller.abort();
    view.note?.stop();
    window.cancelAnimationFrame(view.frame);
    unsubscribeJobs();
    unsubscribeBatch();
    sheet.dispose();
  };
}

/* ---------- фильтры и сортировка ---------- */

function readFilters(query) {
  const lang = (query.get("lang") ?? "").toUpperCase();
  const pick = (value, allowed) => (allowed.includes(value) ? value : "");
  const fail = query.get("fail") ?? "";
  return Object.freeze({
    lang: pick(lang, LANGUAGES),
    ch: pick(query.get("ch") ?? "", CHANNELS),
    q: (query.get("q") ?? "").slice(0, 200),
    status: pick(query.get("status") ?? "", STATUS_FILTERS.map((f) => f.value)),
    score: pick(query.get("score") ?? "", SCORE_FILTERS.map((f) => f.value)),
    appeal: pick(query.get("appeal") ?? "", APPEAL_FILTERS.map((f) => f.value)),
    fail: CRITERION_ID.test(fail) ? fail : "",
    sort: pick(query.get("sort") ?? "", SORT_KEYS),
    dir: query.get("dir") === "asc" ? "asc" : "desc",
  });
}

function applyFilters(items, filters, context) {
  const needle = normalizeForSearch(filters.q);
  return items.filter((item) => (!filters.lang || item.language === filters.lang)
    && (!filters.ch || item.channel === filters.ch)
    && (!needle || normalizeForSearch(`${item.id} ${item.preview}`).includes(needle))
    && matchesEvaluation(item.evaluation, filters, context));
}

function applySort(items, { sort, dir }) {
  if (!sort) return items;
  const sign = dir === "asc" ? 1 : -1;
  const key = {
    id: (item) => item.id,
    messages: (item) => item.messageCount,
    duration: (item) => item.durationSec ?? -1,
    score: (item) => effectiveTotal(item.evaluation) ?? -1,
  }[sort];
  return [...items].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    const order = typeof left === "string" ? left.localeCompare(right, "ru", { numeric: true }) : left - right;
    return order * sign || a.id.localeCompare(b.id, "ru", { numeric: true });
  });
}

function tally(items, key) {
  return items.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] ?? 0) + 1 }), {});
}

function countMatches(items, filters, pick) {
  return Object.fromEntries(filters.map((f) => [f.value, items.filter((item) => pick(f, item.evaluation)).length]));
}

/** Критерии, по которым можно искать «не выполнен» (с баллами, без отметки грубой ошибки). */
function failCriteria(checklist) {
  return (checklist?.criteria ?? []).filter((criterion) => criterion.scored && !criterion.critical);
}

/** Наборы id для пакетной оценки. */
function batchScopes(listing, visible, latestVersion) {
  const ids = (items) => items.map((item) => item.id);
  return {
    pending: ids(listing.items.filter((item) => !item.evaluation)),
    filtered: ids(visible),
    all: ids(listing.items),
    outdated: latestVersion === null ? [] : ids(listing.items.filter((item) =>
      item.evaluation && item.evaluation.checklistVersion !== null && item.evaluation.checklistVersion < latestVersion)),
  };
}

/* ---------- герой ---------- */

function buildHero(groupId) {
  const aside = h("div", { className: "cqa-hero__aside cqa-hero__aside--wide" }, summarySkeleton("row"));
  const el = h("section", { className: "cqa-hero", attrs: { "aria-labelledby": "cqa-page-title" } },
    h("div", { className: "cqa-container cqa-hero__grid" },
      h("div", { className: "cqa-hero__copy" },
        h("p", { className: "cqa-eyebrow" }, h("span", { className: "cqa-eyebrow__dot", attrs: { "aria-hidden": "true" } }), `Набор ${groupId}`),
        h("h1", { className: "cqa-display", attrs: { id: "cqa-page-title", tabindex: "-1" }, text: "Диалоги" }),
        h("p", { className: "cqa-lead cqa-grad-text", text: "Транскрипты чатов и звонков для проверки работы оператора по чек-листу" })),
      aside));

  return {
    el,
    showLoading() {
      aside.replaceChildren(summarySkeleton("row"));
    },
    showError() {
      aside.replaceChildren();
    },
    showListing(listing) {
      const byChannel = tally(listing.items, "channel");
      const byLang = tally(listing.items, "language");
      aside.replaceChildren(summaryCard({
        layout: "row",
        kicker: `Всего в наборе ${listing.groupId}`,
        value: formatInt(listing.total),
        unit: plural(listing.total, FORMS.dialog),
        groups: [
          { title: "Язык", segments: LANGUAGES.map((lang) => ({ label: lang, value: byLang[lang] ?? 0 })) },
          { title: "Канал", segments: CHANNEL_FILTERS.map((ch) => ({ label: ch.label, value: byChannel[ch.value] ?? 0 })) },
        ],
      }));
    },
  };
}

/* ---------- лист: фильтры, действия, таблица ---------- */

function buildSheet(initialFilters, groupId, { onFilters, onRefresh }) {
  let filters = initialFilters;
  let debounce = 0;
  const emit = (patch) => {
    filters = Object.freeze({ ...filters, ...patch });
    onFilters(filters);
  };

  const search = searchField(filters.q, (q) => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => emit({ q }), SEARCH_DEBOUNCE_MS);
  }, "id диалога или текст первой реплики клиента");
  const all = { value: "", label: "Все" };
  const hint = { disabledHint: UNAVAILABLE_HINT };
  const langSeg = segmented([all, ...LANGUAGES.map((l) => ({ value: l, label: l, title: languageName(l) }))], filters.lang, (lang) => emit({ lang }));
  const chSeg = segmented([all, ...CHANNEL_FILTERS], filters.ch, (ch) => emit({ ch }));
  const statusSeg = segmented([all, ...STATUS_FILTERS], filters.status, (status) => emit({ status }), hint);
  const scoreSeg = segmented([all, ...SCORE_FILTERS], filters.score, (score) => emit({ score }), hint);
  const appealSeg = segmented([all, ...APPEAL_FILTERS], filters.appeal, (appeal) => emit({ appeal }), hint);
  const failSelect = selectFilter({ name: "fail", placeholder: "Любой", initial: filters.fail, onChange: (fail) => emit({ fail }) });
  const evalHint = h("span", { className: "cqa-filter__note" }, icon("info", { size: 14 }), "заработают после оценки диалогов");

  const resetFilters = () => {
    search.set("");
    for (const seg of [langSeg, chSeg, statusSeg, scoreSeg, appealSeg]) seg.set("");
    failSelect.set("");
    emit(EMPTY_FILTERS);
  };
  const applyPatch = (patch) => {
    const next = { ...EMPTY_FILTERS, ...patch };
    search.set(next.q);
    langSeg.set(next.lang);
    chSeg.set(next.ch);
    statusSeg.set(next.status);
    scoreSeg.set(next.score);
    appealSeg.set(next.appeal);
    failSelect.set(next.fail);
    emit(next);
    content.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const batch = batchPanel({ groupId, onFilter: applyPatch });
  const exportLinks = h("div", { className: "cqa-export", attrs: { role: "group", "aria-label": "Экспорт оценок" } });
  const batchButton = button({
    label: "Оценить набор", variant: "dark sm", iconName: "sparkle",
    attrs: { class: "cqa-btn cqa-btn--dark cqa-btn--sm cqa-batch-open", "aria-controls": "cqa-batch" },
    onClick: () => batch.open(),
  });
  batch.el.id = "cqa-batch";

  const info = h("p", { className: "cqa-meta-row__info", attrs: { "aria-live": "polite" } });
  const side = h("div", { className: "cqa-meta-row__side" });
  const content = h("div", { className: "cqa-results" });
  const el = h("section", { className: "cqa-sheet", attrs: { "aria-labelledby": "cqa-list-title" } },
    h("div", { className: "cqa-container" },
      h("h2", { className: "cqa-sr-only", attrs: { id: "cqa-list-title" }, text: "Список диалогов" }),
      h("div", { className: "cqa-filters" },
        h("div", { className: "cqa-toolbar" },
          filterGroup("cqa-f-search", "Поиск", search.el, "grow"),
          filterGroup("cqa-f-lang", "Язык", langSeg.el),
          filterGroup("cqa-f-ch", "Канал", chSeg.el)),
        h("div", { className: "cqa-toolbar cqa-toolbar--eval" },
          filterGroup("cqa-f-status", "Результат оценки", statusSeg.el, "", evalHint),
          filterGroup("cqa-f-score", "Итоговый балл", scoreSeg.el),
          filterGroup("cqa-f-appeal", "Апелляция", appealSeg.el),
          filterGroup("cqa-f-fail", "Не выполнен критерий", failSelect.el, "select"))),
      h("div", { className: "cqa-actions" },
        h("div", { className: "cqa-actions__main" }, batchButton, exportLinks),
        side),
      batch.el,
      h("div", { className: "cqa-meta-row" }, info),
      content));

  const onKey = (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    search.focus();
  };
  document.addEventListener("keydown", onKey);

  const onSort = (key) => {
    const dir = filters.sort === key ? (filters.dir === "asc" ? "desc" : "asc") : key === "id" ? "asc" : "desc";
    emit({ sort: key, dir });
  };

  return {
    el,
    dispose() {
      window.clearTimeout(debounce);
      document.removeEventListener("keydown", onKey);
      batch.dispose();
    },
    showLoading(noteEl) {
      info.replaceChildren(noteEl);
      side.replaceChildren();
      content.replaceChildren(skeletonRows(SKELETON_ROWS));
    },
    showState(stateEl) {
      info.replaceChildren();
      side.replaceChildren();
      content.replaceChildren(stateEl);
    },
    showListing(listing, activeFilters, checklist) {
      filters = activeFilters;
      const dataAvailable = hasEvaluations(listing.items);
      const criteria = failCriteria(checklist);
      const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
      const needsData = STATUS_FILTERS.filter((f) => f.needsData).map((f) => f.value);
      statusSeg.setDisabled(dataAvailable ? [] : needsData);
      scoreSeg.setDisabled(dataAvailable ? [] : SCORE_FILTERS.map((f) => f.value));
      appealSeg.setDisabled(dataAvailable ? [] : APPEAL_FILTERS.map((f) => f.value));
      langSeg.setCounts(tally(listing.items, "language"), listing.total);
      chSeg.setCounts(tally(listing.items, "channel"), listing.total);
      statusSeg.setCounts(countMatches(listing.items, STATUS_FILTERS, (f, ev) => f.match(ev)), listing.total);
      scoreSeg.setCounts(countMatches(listing.items, SCORE_FILTERS, (f, ev) => typeof effectiveTotal(ev) === "number" && f.match(effectiveTotal(ev))), listing.total);
      appealSeg.setCounts(countMatches(listing.items, APPEAL_FILTERS, (f, ev) => f.match(ev)), listing.total);
      failSelect.setOptions(criteria.map((criterion, i) => ({
        value: criterion.id,
        label: `${criterionNumber(criterion.id, i)} ${criterion.title}`,
        count: listing.items.filter((item) => item.evaluation?.answers && isFailAnswer(item.evaluation.answers[criterion.id], criterion)).length,
      })), { disabled: !dataAvailable || criteria.length === 0 });
      evalHint.hidden = dataAvailable;

      const visible = applySort(applyFilters(listing.items, activeFilters, { dataAvailable, criteriaById }), activeFilters);
      const evaluated = listing.items.filter((item) => item.evaluation).length;
      info.replaceChildren("Показано ", h("strong", { className: "cqa-num", text: formatInt(visible.length) }),
        ` из ${countLabel(listing.total, FORMS.dialog)} · оценено ${formatInt(evaluated)} · строка открывает ${isHosted() ? "обращение" : "карточку диалога"}`);
      side.replaceChildren(...refreshControl(listing, onRefresh));
      exportLinks.replaceChildren(...exportControls(groupId, evaluated));
      batch.update({ scopes: batchScopes(listing, visible, checklist?.version ?? null), latestVersion: checklist?.version ?? null });
      content.replaceChildren(renderResults(listing, visible, {
        groupId, filters: activeFilters, resetFilters, onSort, latestVersion: checklist?.version ?? null,
        jobState: (id) => (getJob(groupId, id)?.state === "running" ? "running" : batchStateOf(groupId, id)),
      }));
    },
  };
}

function renderResults(listing, visible, { groupId, filters, resetFilters, onSort, jobState, latestVersion }) {
  if (listing.total === 0) {
    return stateBlock({ kind: "empty", title: "В наборе нет диалогов", text: "API кейса вернул пустой набор. Проверьте group_id в шапке или обновите позже." });
  }
  if (visible.length === 0) {
    return stateBlock({
      kind: "empty", title: "Ничего не найдено", text: "Под выбранные фильтры не подходит ни один диалог. Измените запрос или сбросьте фильтры.",
      actions: [button({ label: "Сбросить фильтры", onClick: resetFilters })],
    });
  }
  return conversationTable(visible, { groupId, sort: filters.sort, dir: filters.dir, onSort, jobState, latestVersion });
}

function refreshControl(listing, onRefresh) {
  const time = formatFetchedAt(listing.fetchedAt);
  return [
    time ? h("span", { text: `Данные получены в ${time}` }) : null,
    h("button", {
      className: "cqa-btn cqa-btn--gray cqa-btn--sm",
      attrs: { type: "button", title: "Запросить набор заново из API кейса" },
      on: { click: onRefresh },
    }, icon("refresh", { size: 16 }), "Обновить"),
  ].filter(Boolean);
}

/** Экспорт последних оценок набора — обычные ссылки на скачивание с нашего сервера. */
function exportControls(groupId, evaluated) {
  const label = h("span", { className: "cqa-export__label", text: "Экспорт" });
  if (!evaluated) {
    return [label, ...["JSON", "CSV"].map((format) => h("span", {
      className: "cqa-export__link", attrs: { "aria-disabled": "true", title: "Нет оценённых диалогов — экспортировать нечего" }, text: format,
    }))];
  }
  return [label, ...["json", "csv"].map((format) => h("a", {
    className: "cqa-export__link cqa-hl",
    attrs: {
      href: exportUrl(groupId, format), download: true, // имя файла с меткой времени задаёт сервер
      title: format === "csv" ? "CSV для Excel: «;» и десятичная запятая" : "JSON для обработки программой",
    },
  }, icon("download", { size: 16 }), format.toUpperCase()))];
}
