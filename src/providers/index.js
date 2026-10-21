import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenCodeZenProvider } from "./opencode-zen.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { PROVIDER_CATALOG, getProviderInfo } from "./catalog.js";
import { resolveApiKeys } from "../core/session-store.js";
import { withKeyFailover } from "./key-failover.js";
import { SunProvider } from "./sun.js";
export { SunProvider } from "./sun.js";

export { OpenAIProvider } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
export { OpenCodeZenProvider } from "./opencode-zen.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";

/** Providers with a dedicated adapter rather than the generic one. */
const DEDICATED = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  zen: OpenCodeZenProvider,
  "opencode-zen": OpenCodeZenProvider,
  opencodezen: OpenCodeZenProvider,
};

/**
 * Instantiate a provider by id.
 *
 * Anything not in DEDICATED falls back to the generic OpenAI-compatible
 * client, configured from the catalog (or the user's custom definition).
 *
 * @param {string} name    Provider id
 * @param {object} options { model, catalog, config, apiKey, baseUrl }
 */
export function createProvider(name, options = {}) {
  const id = String(name || "").toLowerCase();

  const catalog = options.catalog || PROVIDER_CATALOG;
  const info = getProviderInfo(id, catalog);
  if (!info) {
    const known = catalog.map((p) => p.id).join(", ");
    throw new Error(`Unknown provider "${name}". Available: ${known}`);
  }

  // Env var wins over a key saved through the TUI.
  const keys = [...new Set([options.apiKey, ...(options.apiKeys || []), ...resolveApiKeys(id, info.envKey, options.config)].filter(Boolean))];
  const key = keys[0] || undefined;
  const opts = { ...options, apiKey: key };

  const Dedicated = DEDICATED[id];
  if (Dedicated) return withKeyFailover(new Dedicated(opts), { id, keys, onKeyRotation: options.onKeyRotation });

  const Compatible = id === "sun" ? SunProvider : OpenAICompatibleProvider;
  return new Compatible({
    id: info.id,
    label: info.label,
    baseUrl: opts.baseUrl || info.baseUrl,
    apiKeyEnv: info.envKey,
    apiKey: opts.apiKey,
    apiKeys: keys,
    onKeyRotation: options.onKeyRotation,
    // Public catalog discovery (notably OpenRouter /models) should work even
    // when the user has not entered a completion key yet.
    requiresKey: options.allowNoKey ? false : info.requiresKey,
    model: opts.model,
  });
}

/**
 * Pick a sensible default provider from the environment.
 *
 * Never throws: with no keys at all we fall back to "zen", which serves
 * free models without authentication.
 */
export function detectProvider() {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.SUN_API_KEY) return "sun";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.GEMINI_API_KEY) return "google";
  return "zen";
}
