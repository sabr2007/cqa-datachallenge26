// Маршрутизация через hash без библиотек:
//   #/conversations?g=DEV&lang=KZ&ch=call&q=тариф&status=critical
//   #/c/<id>?g=DEV&m=12        (m — index реплики из API)
//   #/checklist?g=DEV
//   #/appeals?g=DEV&status=open&id=ap_…
//   #/insights?g=DEV

export const DEFAULT_GROUP = "DEV";

/**
 * @typedef {{ name: "conversations" | "conversation" | "checklist" | "appeals" | "insights" | "notFound", id?: string, query: URLSearchParams }} Route
 * @param {string} [hash]
 * @returns {Route}
 */
export function parseRoute(hash = window.location.hash) {
  const raw = String(hash).replace(/^#/, "");
  const queryStart = raw.indexOf("?");
  const pathPart = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const query = new URLSearchParams(queryStart === -1 ? "" : raw.slice(queryStart + 1));
  const segments = pathPart.split("/").filter(Boolean).map(safeDecode);

  if (segments.length === 0 || (segments.length === 1 && segments[0] === "conversations")) {
    return { name: "conversations", query };
  }
  if (segments.length === 2 && segments[0] === "c" && segments[1] !== null) {
    return { name: "conversation", id: segments[1], query };
  }
  if (segments.length === 1 && segments[0] === "checklist") return { name: "checklist", query };
  if (segments.length === 1 && segments[0] === "appeals") return { name: "appeals", query };
  if (segments.length === 1 && segments[0] === "insights") return { name: "insights", query };
  return { name: "notFound", query };
}

/**
 * Собирает hash-ссылку; пустые параметры опускаются.
 * @param {string} path @param {Record<string, string | number | null | undefined>} [params]
 * @returns {string}
 */
export function buildHash(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return `#${path}${qs ? `?${qs}` : ""}`;
}

export const paths = Object.freeze({
  conversations: "/conversations",
  checklist: "/checklist",
  appeals: "/appeals",
  insights: "/insights",
  conversation: (id) => `/c/${encodeURIComponent(id)}`,
});

/** Меняет hash без новой записи в истории и без события hashchange. */
export function replaceHash(hash) {
  if (window.location.hash === hash) return;
  history.replaceState(history.state, "", hash);
}

export function navigate(hash) {
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = hash;
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
