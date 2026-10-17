const MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";

/** Retrieve the complete current catalog, without exposing the key to the browser. */
export async function fetchOpenRouterModels(apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`OpenRouter respondió ${response.status} al cargar los modelos.`);

  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error("OpenRouter devolvió una lista de modelos inválida.");

  const seen = new Set();
  return body.data
    .filter((item) => {
      if (typeof item?.id !== "string" || !item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map((item) => ({ id: item.id, label: typeof item.name === "string" && item.name ? item.name : item.id }))
    .sort((a, b) => a.label.localeCompare(b.label, "es", { sensitivity: "base" }));
}
