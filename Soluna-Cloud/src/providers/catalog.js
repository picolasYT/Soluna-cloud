/**
 * Provider catalog.
 *
 * Every entry here speaks either the OpenAI chat-completions format or has a
 * dedicated adapter. Adding a provider is usually just a base URL plus an
 * environment variable holding the key.
 *
 * `models` is a curated starting list, not a limit: users can add their own
 * from the TUI (`/models` -> Add a custom model) and they are merged in.
 */

export const PROVIDER_CATALOG = [
  {
    id: "zen",
    label: "OpenCode Zen",
    hint: "free models, no key",
    envKey: "OPENCODE_API_KEY",
    baseUrl: "https://opencode.ai/zen/v1",
    requiresKey: false,
    docs: "https://opencode.ai/docs/zen",
    models: [
      { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash", hint: "free" },
      { id: "big-pickle", label: "Big Pickle", hint: "free" },
      { id: "mimo-v2.5-free", label: "MiMo V2.5", hint: "free" },
      { id: "longcat-2.0-free", label: "LongCat 2.0", hint: "free" },
      { id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra", hint: "free" },
      { id: "north-mini-code-free", label: "North Mini Code", hint: "free" },
      { id: "laguna-s-2.1-free", label: "Laguna S 2.1", hint: "free" },
      { id: "ling-3.0-tiny-free", label: "Ling 3.0 Tiny", hint: "free" },
      { id: "minimax-m2.7", label: "MiniMax M2.7", hint: "paid" },
      { id: "glm-5.1", label: "GLM 5.1", hint: "paid" },
      { id: "kimi-k2.6", label: "Kimi K2.6", hint: "paid" },
      { id: "qwen3.6-plus", label: "Qwen3.6 Plus", hint: "paid" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    hint: "requires API key",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    docs: "https://platform.openai.com/docs/models",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
      { id: "o1", label: "o1" },
      { id: "o1-mini", label: "o1 mini" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    hint: "requires API key",
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    docs: "https://docs.anthropic.com/en/docs/about-claude/models",
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
      { id: "claude-3-opus-20240229", label: "Claude 3 Opus" },
    ],
  },
  {
    id: "google",
    label: "Google Gemini",
    hint: "requires API key",
    envKey: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresKey: true,
    compatible: "openai",
    docs: "https://ai.google.dev/gemini-api/docs/models",
    models: [
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    hint: "very fast inference",
    envKey: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    compatible: "openai",
    docs: "https://console.groq.com/docs/models",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B" },
      { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "requires API key",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    requiresKey: true,
    compatible: "openai",
    docs: "https://api-docs.deepseek.com",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  {
    id: "mistral",
    label: "Mistral",
    hint: "requires API key",
    envKey: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
    requiresKey: true,
    compatible: "openai",
    docs: "https://docs.mistral.ai/getting-started/models",
    models: [
      { id: "mistral-large-latest", label: "Mistral Large" },
      { id: "codestral-latest", label: "Codestral" },
      { id: "mistral-small-latest", label: "Mistral Small" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    hint: "300+ models via one key",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    compatible: "openai",
    dynamic: true,
    docs: "https://openrouter.ai/models",
    models: [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "openai/gpt-4o", label: "GPT-4o" },
      { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    ],
  },
  {
    id: "together",
    label: "Together AI",
    hint: "open models",
    envKey: "TOGETHER_API_KEY",
    baseUrl: "https://api.together.xyz/v1",
    requiresKey: true,
    compatible: "openai",
    docs: "https://docs.together.ai/docs/inference-models",
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo" },
      { id: "Qwen/Qwen2.5-Coder-32B-Instruct", label: "Qwen2.5 Coder 32B" },
    ],
  },
  {
    id: "xai",
    label: "xAI Grok",
    hint: "requires API key",
    envKey: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    requiresKey: true,
    compatible: "openai",
    docs: "https://docs.x.ai/docs/models",
    models: [
      { id: "grok-2-latest", label: "Grok 2" },
      { id: "grok-beta", label: "Grok Beta" },
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    hint: "fastest inference",
    envKey: "CEREBRAS_API_KEY",
    baseUrl: "https://api.cerebras.ai/v1",
    requiresKey: true,
    compatible: "openai",
    docs: "https://inference-docs.cerebras.ai",
    models: [
      { id: "llama3.3-70b", label: "Llama 3.3 70B" },
      { id: "llama3.1-8b", label: "Llama 3.1 8B" },
    ],
  },
  {
    id: "ollama",
    label: "Ollama",
    hint: "local models, no key",
    envKey: "OLLAMA_HOST",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    compatible: "openai",
    dynamic: true,
    docs: "https://ollama.com/library",
    models: [
      { id: "qwen2.5-coder", label: "Qwen2.5 Coder" },
      { id: "llama3.2", label: "Llama 3.2" },
      { id: "deepseek-coder-v2", label: "DeepSeek Coder V2" },
    ],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    hint: "local models, no key",
    envKey: "LMSTUDIO_URL",
    baseUrl: "http://localhost:1234/v1",
    requiresKey: false,
    compatible: "openai",
    dynamic: true,
    docs: "https://lmstudio.ai/docs/local-server",
    models: [{ id: "local-model", label: "Loaded model" }],
  },
];

/**
 * Merge the built-in catalog with the user's custom providers and models.
 * Custom entries win on id collisions, so users can override defaults.
 */
export function buildCatalog(config = {}) {
  const customProviders = config.customProviders || {};
  const customModels = config.customModels || {};

  const merged = PROVIDER_CATALOG.map((provider) => {
    const extra = customModels[provider.id] || [];
    if (extra.length === 0) return provider;
    const known = new Set(provider.models.map((m) => m.id));
    return {
      ...provider,
      models: [...provider.models, ...extra.filter((m) => !known.has(m.id)).map(tagCustom)],
    };
  });

  for (const [id, def] of Object.entries(customProviders)) {
    const entry = {
      id,
      label: def.label || id,
      hint: def.hint || "custom",
      envKey: def.apiKeyEnv || null,
      baseUrl: def.baseUrl,
      requiresKey: Boolean(def.apiKeyEnv),
      compatible: "openai",
      custom: true,
      models: [...(def.models || []).map(tagCustom), ...(customModels[id] || []).map(tagCustom)],
    };
    const at = merged.findIndex((p) => p.id === id);
    if (at === -1) merged.push(entry);
    else merged[at] = { ...merged[at], ...entry };
  }

  return merged;
}

function tagCustom(model) {
  return { ...model, hint: model.hint || "custom", custom: true };
}

export function getProviderInfo(id, catalog = PROVIDER_CATALOG) {
  return catalog.find((p) => p.id === id) || null;
}

export function getDefaultModel(providerId, catalog = PROVIDER_CATALOG) {
  return getProviderInfo(providerId, catalog)?.models?.[0]?.id || null;
}

/**
 * True when the provider can be used right now.
 *
 * A key counts as present if it is exported in the environment OR was saved
 * through the TUI, so both configuration styles work.
 */
export function isProviderReady(providerId, catalog = PROVIDER_CATALOG, config = null) {
  const info = getProviderInfo(providerId, catalog);
  if (!info) return false;
  if (!info.requiresKey) return true;
  if (info.envKey && process.env[info.envKey]) return true;
  return Boolean(config?.apiKeys?.[providerId]);
}

/** Where a provider's key comes from, for display purposes. */
export function keySource(providerId, catalog = PROVIDER_CATALOG, config = null) {
  const info = getProviderInfo(providerId, catalog);
  if (!info?.requiresKey) return "not needed";
  if (info.envKey && process.env[info.envKey]) return `from ${info.envKey}`;
  if (config?.apiKeys?.[providerId]) return "saved in config";
  return null;
}
