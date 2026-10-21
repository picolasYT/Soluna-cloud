export const SUN_MODELS_URL = "https://sun.soymaycol.icu/api/models";
const caches = new WeakMap();

/** Sun's public catalog includes tool support; it never needs a user's key. */
export async function fetchSunModels(fetchImpl = fetch) {
  const response = await fetchImpl(SUN_MODELS_URL, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Sun respondió ${response.status} al cargar los modelos.`);
  const body = await response.json();
  if (!Array.isArray(body?.models)) throw new Error("Sun devolvió una lista de modelos inválida.");
  const seen = new Set();
  return body.models.filter((item) => {
    if (typeof item?.id !== "string" || !item.id.trim() || item.id.length > 256 || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).map((item) => ({
    id: item.id,
    label: typeof item.name === "string" && item.name ? item.name : item.id,
    aliases: Array.isArray(item.aliases) ? item.aliases.filter((alias) => typeof alias === "string") : [],
    tools: typeof item.capabilities?.tools === "boolean" ? item.capabilities.tools : null,
    available: item.available !== false,
    contextLength: Number(item.contextWindow) || null,
    context: Number(item.contextWindow) || null,
    maxOutputTokens: Number(item.maxOutputTokens) || null,
    hint: item.available === false ? "no disponible" : item.capabilities?.tools === false ? "solo chat" : item.capabilities?.tools === true ? "herramientas" : "herramientas sin confirmar",
  })).sort((a, b) => a.label.localeCompare(b.label, "es", { sensitivity: "base" }));
}

/** Coalesce refreshes and cache the public metadata for ten minutes. */
export function getSunModels(fetchImpl = fetch, { refresh = false } = {}) {
  let entry = caches.get(fetchImpl);
  if (!entry) { entry = {}; caches.set(fetchImpl, entry); }
  if (!refresh && entry.models && entry.expires > Date.now()) return Promise.resolve(entry.models);
  if (entry.pending) return entry.pending;
  entry.pending = fetchSunModels(fetchImpl).then((models) => {
    entry.models = models;
    entry.expires = Date.now() + 10 * 60 * 1000;
    return models;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}
