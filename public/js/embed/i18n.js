// Подписи встраиваемой панели на языках пользователя Dynamics 365: RU, KZ, EN.
// Язык приходит из userSettings.languageId (LCID) формы или параметра userlcid.
// Содержимое оценки (названия критериев, объяснения модели) приходит из API по-русски и не переводится.
// Все строки вставляются в DOM только как текст: подстановки {name} — не разметка.

const LCID_PRIMARY_LANGUAGE_MASK = 0x3ff;
const PRIMARY_LANGUAGE_TO_LANG = Object.freeze({ 0x19: "ru", 0x3f: "kk", 0x09: "en" });

export const LANGS = Object.freeze(["ru", "kk", "en"]);
export const DEFAULT_LANG = "ru";

// Числа и даты в Казахстане пишутся как в RU («12,5», «07.11.2026»), а данных ICU для kk во многих
// сборках Chromium нет (дата выходит как «2026 M11 7») — поэтому для KZ форматируем через ru-RU,
// а дату — числами, без названий месяцев.
const FORMAT_LOCALES = Object.freeze({ ru: "ru-RU", kk: "ru-RU", en: "en-GB" });
const DATE_OPTIONS = Object.freeze({
  ru: { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
  kk: { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" },
  en: { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
});
const LANG_CODES = Object.freeze({ ru: "RU", kk: "KZ", en: "EN" });

const COUNTED = Object.freeze({
  model: { ru: { one: "модель", few: "модели", many: "моделей", other: "модели" }, kk: { other: "модель" }, en: { one: "model", other: "models" } },
  criterion: { ru: { one: "критерий", few: "критерия", many: "критериев", other: "критерия" }, kk: { other: "критерий" }, en: { one: "criterion", other: "criteria" } },
});

const RU = Object.freeze({
  title: "Оценка качества",
  subtitle: "Диалог {id} · набор {group}",
  refresh: "Обновить оценку",
  loading: "Загружаем оценку…",
  scoreLabel: "Итог",
  scoreAria: "Итог {score} из {max}",
  scoreInitial: "до апелляций {value}",
  scoreNone: "Итог не рассчитан: нет применимых критериев с весом.",
  statusDone: "Оценено",
  statusCritical: "Грубая ошибка",
  statusReview: "Нужна проверка",
  statusAppealOpen: "Апелляция",
  statusAppealResolved: "Апелляция решена",
  criticalLifted: "Грубая ошибка снята по апелляции.",
  metaChecklist: "чек-лист v{version}",
  metaCost: "стоимость {cost}",
  metaLatency: "{seconds} с",
  dispute: "Оспорить",
  disputeCriterion: "Оспорить критерий",
  openCard: "Полная карточка",
  newTab: "откроется в новой вкладке",
  evaluate: "Оценить",
  evaluateAgain: "Оценить заново",
  sectionsTitle: "Секции",
  criteriaTitle: "Критерии",
  notScored: "без баллов",
  answerYes: "Да",
  answerNo: "Нет",
  answerNa: "N/A",
  answerViolation: "Есть нарушение",
  answerNoViolation: "Нарушений нет",
  answerScale: "{value} из {max}",
  pointsAria: "{points} из {max} баллов",
  tagReview: "проверить",
  tagAppeal: "апелляция",
  tagCritical: "грубая ошибка",
  evidenceTitle: "Цитаты",
  quoteVerified: "цитата сверена с репликой",
  quoteUnverified: "цитата не подтверждена",
  messageLink: "Реплика #{n} в полной карточке",
  checkedRange: "Проверенный участок: #{from}–#{to}",
  naReason: "Почему N/A: {reason}",
  scaleStep: "Ступень шкалы: {label}",
  confidence: "Согласие моделей {pct}",
  needsReviewNote: "Модели разошлись или цитата не подтверждена — нужна проверка человеком.",
  appealOpen: "Апелляция на рассмотрении",
  appealComment: "Комментарий: {comment}",
  appealChanged: "Апелляция принята: «{from}» → «{to}»",
  appealConfirmed: "Апелляция рассмотрена: оценка подтверждена",
  appealReason: "Причина: {reason}",
  emptyTitle: "Диалог ещё не оценён",
  emptyText: "Модель проверит диалог по чек-листу — каждый критерий отдельно, с цитатами реплик. Обычно это занимает до 90 секунд.",
  evaluating: "Модель оценивает диалог…",
  evaluatingHint: "Критерии проверяются параллельно, несколько моделей голосуют. Обычно до 90 секунд — панель можно закрыть, результат сохранится.",
  evaluatingResumed: "Оценка запущена раньше — ждём результат.",
  elapsed: "{n} с",
  evaluatedNotice: "Оценка готова.",
  errorLoadTitle: "Не удалось загрузить оценку",
  errorEvaluateTitle: "Не удалось оценить диалог",
  evaluationFailedTitle: "Оценка завершилась с ошибкой",
  errorCode: "Код: {code}",
  retry: "Повторить",
  noContextTitle: "Не удалось определить диалог",
  noContextText: "Откройте панель из формы обращения или передайте параметр data с полями group и conversation (или параметр id).",
  unsavedTitle: "Запись ещё не сохранена",
  unsavedText: "Сохраните обращение — оценка качества появится после сохранения.",
  invalidIdTitle: "Некорректный идентификатор",
  invalidIdText: "Получено «{value}». Допустимы латинские буквы, цифры, «_» и «-», до 64 символов.",
  contextLabel: "Контекст",
  sourceXrm: "форма (parent.Xrm)",
  sourceData: "параметр data",
  sourceId: "параметр id",
  sourceNone: "не найден",
  contextField: "поле {field}",
  contextRecord: "id записи",
  contextLang: "язык {code}",
  appealTitle: "Оспорить оценку",
  appealIntro: "Апелляцию рассмотрит специалист контроля качества; итог пересчитается после решения.",
  appealCriterionLabel: "Критерий",
  appealCurrent: "Сейчас: {answer} · {points}",
  appealCommentLabel: "Комментарий",
  appealCommentHelp: "С чем вы не согласны и почему. Сошлитесь на реплику, например #10.",
  appealCommentShort: "Напишите комментарий — хотя бы {min} символов.",
  appealTaken: "уже оспорен",
  appealNothing: "Все критерии этой оценки уже оспорены.",
  appealSubmit: "Отправить апелляцию",
  appealSending: "Отправляем…",
  appealSent: "Апелляция по критерию «{criterion}» отправлена.",
  appealExists: "По этому критерию апелляция уже подана — её статус виден в карточке критерия.",
  errEngineUnavailable: "Движок оценки сейчас недоступен: модели не отвечают. Попробуйте через пару минут.",
  errEngineFailed: "Модель вернула ошибку, и оценка не завершилась. Запустите её ещё раз.",
  errTimeout: "Оценка не уложилась во время. Запустите её ещё раз — обычно она занимает до 90 секунд.",
  errBadGateway: "Сервер оценки получил ошибку от модели или источника данных. Попробуйте ещё раз.",
  errUnavailable: "Сервис оценки временно недоступен. Попробуйте позже.",
  errNetwork: "Нет связи с сервером оценки. Проверьте сеть и адрес API (data-api-base в embed.html).",
  errNotFound: "Диалог {id} не найден в наборе {group}.",
  errNotAppealable: "Оценка завершилась ошибкой — оспаривать в ней нечего. Запустите оценку заново.",
  errUnknown: "Неизвестная ошибка сервера.",
  cancel: "Отмена",
  close: "Закрыть",
});

const KK = Object.freeze({
  title: "Сапа бағасы",
  subtitle: "Диалог {id} · {group} жинағы",
  refresh: "Бағаны жаңарту",
  loading: "Баға жүктелуде…",
  scoreLabel: "Қорытынды",
  scoreAria: "Қорытынды: {max} ұпайдан {score}",
  scoreInitial: "апелляцияға дейін {value}",
  scoreNone: "Қорытынды есептелмеді: салмағы бар қолданылатын критерий жоқ.",
  statusDone: "Бағаланды",
  statusCritical: "Өрескел қате",
  statusReview: "Тексеру қажет",
  statusAppealOpen: "Апелляция",
  statusAppealResolved: "Апелляция шешілді",
  criticalLifted: "Өрескел қате апелляция бойынша алынып тасталды.",
  metaChecklist: "чек-лист, {version}-нұсқа",
  metaCost: "құны {cost}",
  metaLatency: "{seconds} с",
  dispute: "Дау айту",
  disputeCriterion: "Критерийге дау айту",
  openCard: "Толық карточка",
  newTab: "жаңа бетте ашылады",
  evaluate: "Бағалау",
  evaluateAgain: "Қайта бағалау",
  sectionsTitle: "Бөлімдер",
  criteriaTitle: "Критерийлер",
  notScored: "ұпайсыз",
  answerYes: "Иә",
  answerNo: "Жоқ",
  answerNa: "N/A",
  answerViolation: "Бұзушылық бар",
  answerNoViolation: "Бұзушылық жоқ",
  answerScale: "{max} ішінен {value}",
  pointsAria: "{max} ұпайдан {points}",
  tagReview: "тексеру",
  tagAppeal: "апелляция",
  tagCritical: "өрескел қате",
  evidenceTitle: "Дәйексөздер",
  quoteVerified: "дәйексөз репликамен салыстырылды",
  quoteUnverified: "дәйексөз расталмады",
  messageLink: "Толық карточкадағы #{n} реплика",
  checkedRange: "Тексерілген бөлік: #{from}–#{to}",
  naReason: "Неге N/A: {reason}",
  scaleStep: "Шкала сатысы: {label}",
  confidence: "Модельдер келісімі {pct}",
  needsReviewNote: "Модельдер келіспеді немесе дәйексөз расталмады — адамның тексеруі қажет.",
  appealOpen: "Апелляция қаралуда",
  appealComment: "Түсініктеме: {comment}",
  appealChanged: "Апелляция қабылданды: «{from}» → «{to}»",
  appealConfirmed: "Апелляция қаралды: баға расталды",
  appealReason: "Себебі: {reason}",
  emptyTitle: "Диалог әлі бағаланбаған",
  emptyText: "Модель диалогты чек-лист бойынша тексереді — әр критерийді жеке, реплика дәйексөздерімен. Әдетте 90 секундқа дейін созылады.",
  evaluating: "Модель диалогты бағалап жатыр…",
  evaluatingHint: "Критерийлер қатар тексеріледі, бірнеше модель дауыс береді. Әдетте 90 секундқа дейін — панельді жабуға болады, нәтиже сақталады.",
  evaluatingResumed: "Бағалау бұрын басталған — нәтижені күтудеміз.",
  elapsed: "{n} с",
  evaluatedNotice: "Баға дайын.",
  errorLoadTitle: "Бағаны жүктеу мүмкін болмады",
  errorEvaluateTitle: "Диалогты бағалау мүмкін болмады",
  evaluationFailedTitle: "Бағалау қатемен аяқталды",
  errorCode: "Код: {code}",
  retry: "Қайталау",
  noContextTitle: "Диалогты анықтау мүмкін болмады",
  noContextText: "Панельді өтініш формасынан ашыңыз немесе group және conversation өрістері бар data параметрін (не id параметрін) беріңіз.",
  unsavedTitle: "Жазба әлі сақталмаған",
  unsavedText: "Өтінішті сақтаңыз — сапа бағасы сақталғаннан кейін пайда болады.",
  invalidIdTitle: "Идентификатор қате",
  invalidIdText: "Алынған мән: «{value}». Латын әріптері, сандар, «_» және «-» рұқсат етіледі, 64 таңбаға дейін.",
  contextLabel: "Контекст",
  sourceXrm: "форма (parent.Xrm)",
  sourceData: "data параметрі",
  sourceId: "id параметрі",
  sourceNone: "табылмады",
  contextField: "{field} өрісі",
  contextRecord: "жазба id",
  contextLang: "тіл {code}",
  appealTitle: "Бағаға дау айту",
  appealIntro: "Апелляцияны сапа бақылау маманы қарайды; шешімнен кейін қорытынды қайта есептеледі.",
  appealCriterionLabel: "Критерий",
  appealCurrent: "Қазір: {answer} · {points}",
  appealCommentLabel: "Түсініктеме",
  appealCommentHelp: "Неге келіспейтініңізді жазыңыз. Репликаға сілтеме жасаңыз, мысалы #10.",
  appealCommentShort: "Түсініктеме жазыңыз — кемінде {min} таңба.",
  appealTaken: "дау айтылған",
  appealNothing: "Бұл бағаның барлық критерийіне дау айтылған.",
  appealSubmit: "Апелляцияны жіберу",
  appealSending: "Жіберілуде…",
  appealSent: "«{criterion}» критерийі бойынша апелляция жіберілді.",
  appealExists: "Бұл критерий бойынша апелляция бұрын берілген — оның күйі критерий карточкасында көрінеді.",
  errEngineUnavailable: "Бағалау қозғалтқышы қазір қолжетімсіз: модельдер жауап бермей тұр. Бірнеше минуттан кейін қайталап көріңіз.",
  errEngineFailed: "Модель қате қайтарды, бағалау аяқталмады. Оны қайта іске қосыңыз.",
  errTimeout: "Бағалау уақытқа сыймады. Қайта іске қосыңыз — әдетте 90 секундқа дейін созылады.",
  errBadGateway: "Бағалау сервері модельден немесе дерек көзінен қате алды. Қайталап көріңіз.",
  errUnavailable: "Бағалау қызметі уақытша қолжетімсіз. Кейінірек қайталап көріңіз.",
  errNetwork: "Бағалау серверімен байланыс жоқ. Желіні және API мекенжайын (embed.html ішіндегі data-api-base) тексеріңіз.",
  errNotFound: "{group} жинағынан {id} диалогы табылмады.",
  errNotAppealable: "Бағалау қатемен аяқталған — дау айтатын ештеңе жоқ. Бағалауды қайта іске қосыңыз.",
  errUnknown: "Сервердің белгісіз қатесі.",
  cancel: "Болдырмау",
  close: "Жабу",
});

const EN = Object.freeze({
  title: "Quality review",
  subtitle: "Conversation {id} · dataset {group}",
  refresh: "Refresh review",
  loading: "Loading the review…",
  scoreLabel: "Total",
  scoreAria: "Total {score} out of {max}",
  scoreInitial: "before appeals {value}",
  scoreNone: "No total: there are no applicable weighted criteria.",
  statusDone: "Reviewed",
  statusCritical: "Critical error",
  statusReview: "Needs review",
  statusAppealOpen: "Appeal",
  statusAppealResolved: "Appeal resolved",
  criticalLifted: "The critical error was withdrawn on appeal.",
  metaChecklist: "checklist v{version}",
  metaCost: "cost {cost}",
  metaLatency: "{seconds} s",
  dispute: "Dispute",
  disputeCriterion: "Dispute criterion",
  openCard: "Full record",
  newTab: "opens in a new tab",
  evaluate: "Evaluate",
  evaluateAgain: "Evaluate again",
  sectionsTitle: "Sections",
  criteriaTitle: "Criteria",
  notScored: "not scored",
  answerYes: "Yes",
  answerNo: "No",
  answerNa: "N/A",
  answerViolation: "Violation",
  answerNoViolation: "No violation",
  answerScale: "{value} of {max}",
  pointsAria: "{points} of {max} points",
  tagReview: "check",
  tagAppeal: "appeal",
  tagCritical: "critical",
  evidenceTitle: "Quotes",
  quoteVerified: "quote matched to the message",
  quoteUnverified: "quote not verified",
  messageLink: "Message #{n} in the full record",
  checkedRange: "Checked span: #{from}–#{to}",
  naReason: "Why N/A: {reason}",
  scaleStep: "Scale step: {label}",
  confidence: "Model agreement {pct}",
  needsReviewNote: "Models disagreed or a quote was not verified — a human check is needed.",
  appealOpen: "Appeal under review",
  appealComment: "Comment: {comment}",
  appealChanged: "Appeal accepted: “{from}” → “{to}”",
  appealConfirmed: "Appeal reviewed: the score stands",
  appealReason: "Reason: {reason}",
  emptyTitle: "Not reviewed yet",
  emptyText: "A model checks the conversation against the checklist, criterion by criterion, quoting the messages. It usually takes under 90 seconds.",
  evaluating: "Reviewing the conversation…",
  evaluatingHint: "Criteria are checked in parallel and several models vote. Usually under 90 seconds — you can close the panel, the result is saved.",
  evaluatingResumed: "A review was started earlier — waiting for the result.",
  elapsed: "{n} s",
  evaluatedNotice: "The review is ready.",
  errorLoadTitle: "Couldn't load the review",
  errorEvaluateTitle: "Couldn't review the conversation",
  evaluationFailedTitle: "The review failed",
  errorCode: "Code: {code}",
  retry: "Try again",
  noContextTitle: "No conversation in context",
  noContextText: "Open this panel from a case form, or pass a data parameter with group and conversation (or an id parameter).",
  unsavedTitle: "The record isn't saved yet",
  unsavedText: "Save the case to see its quality review.",
  invalidIdTitle: "Invalid identifier",
  invalidIdText: "Got “{value}”. Use Latin letters, digits, “_” and “-”, up to 64 characters.",
  contextLabel: "Context",
  sourceXrm: "form (parent.Xrm)",
  sourceData: "data parameter",
  sourceId: "id parameter",
  sourceNone: "not found",
  contextField: "field {field}",
  contextRecord: "record id",
  contextLang: "language {code}",
  appealTitle: "Dispute the review",
  appealIntro: "A quality specialist reviews the appeal; the total is recalculated after the decision.",
  appealCriterionLabel: "Criterion",
  appealCurrent: "Now: {answer} · {points}",
  appealCommentLabel: "Comment",
  appealCommentHelp: "What you disagree with and why. Refer to a message, e.g. #10.",
  appealCommentShort: "Write a comment of at least {min} characters.",
  appealTaken: "already disputed",
  appealNothing: "Every criterion of this review is already disputed.",
  appealSubmit: "Submit appeal",
  appealSending: "Sending…",
  appealSent: "Appeal on “{criterion}” submitted.",
  appealExists: "An appeal on this criterion already exists — its status is shown on the criterion.",
  errEngineUnavailable: "The evaluation engine is unavailable: the models aren't responding. Try again in a couple of minutes.",
  errEngineFailed: "The model returned an error and the review didn't finish. Run it again.",
  errTimeout: "The review ran out of time. Run it again — it usually takes under 90 seconds.",
  errBadGateway: "The review server got an error from a model or the data source. Try again.",
  errUnavailable: "The review service is temporarily unavailable. Try again later.",
  errNetwork: "Can't reach the review server. Check the network and the API address (data-api-base in embed.html).",
  errNotFound: "Conversation {id} isn't in dataset {group}.",
  errNotAppealable: "The review failed, so there's nothing to dispute. Run the review again.",
  errUnknown: "Unknown server error.",
  cancel: "Cancel",
  close: "Close",
});

const DICTIONARIES = Object.freeze({ ru: RU, kk: KK, en: EN });

/**
 * LCID пользователя Dynamics (1049, 1087, 1033, 2057…) → язык панели; неизвестный → null.
 * Сравнивается основной язык (младшие 10 бит LCID), поэтому любой вариант английского — EN.
 * @param {unknown} lcid @returns {"ru" | "kk" | "en" | null}
 */
export function langFromLcid(lcid) {
  const value = Number(lcid);
  if (!Number.isInteger(value) || value <= 0) return null;
  return PRIMARY_LANGUAGE_TO_LANG[value & LCID_PRIMARY_LANGUAGE_MASK] ?? null;
}

/**
 * Код языка из параметров ("RU", "kz", "kk", "en") → язык панели; иначе null.
 * @param {unknown} code @returns {"ru" | "kk" | "en" | null}
 */
export function langFromCode(code) {
  const value = String(code ?? "").trim().toLowerCase();
  if (value === "kz") return "kk";
  return LANGS.includes(value) ? value : null;
}

/**
 * Словарь и форматтеры для языка панели.
 * @param {string} lang
 */
export function createI18n(lang) {
  const code = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const dictionary = DICTIONARIES[code];
  const locale = supportedLocale(FORMAT_LOCALES[code]);
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const percentFormat = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const costFormat = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const dateFormat = new Intl.DateTimeFormat(locale, DATE_OPTIONS[code]);
  const pluralRules = new Intl.PluralRules(locale);

  /** @param {keyof typeof RU} key @param {Record<string, string | number>} [params] */
  function t(key, params = {}) {
    const template = dictionary[key] ?? RU[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  }

  return Object.freeze({
    lang: code,
    code: LANG_CODES[code],
    htmlLang: code,
    t,
    number: (value) => (isFiniteNumber(value) ? numberFormat.format(value) : "—"),
    percent: (share) => (isFiniteNumber(share) ? percentFormat.format(share) : "—"),
    cost: (usd) => (isFiniteNumber(usd) && usd >= 0 ? costFormat.format(usd) : ""),
    date: (iso) => {
      const date = new Date(iso);
      return iso && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : "";
    },
    /** @param {number} n @param {keyof typeof COUNTED} noun */
    count: (n, noun) => {
      const forms = COUNTED[noun]?.[code] ?? {};
      return `${numberFormat.format(n)} ${forms[pluralRules.select(n)] ?? forms.other ?? ""}`.trim();
    },
  });
}

function supportedLocale(locale) {
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale]).length ? locale : FORMAT_LOCALES[DEFAULT_LANG];
  } catch {
    return FORMAT_LOCALES[DEFAULT_LANG]; // старый движок без supportedLocalesOf: русская локаль всегда есть
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
