import { parseSSE, createStreamAccumulator } from "./stream-utils.js";

const keyCursors = new Map();

/**
 * Generic provider for any OpenAI-compatible chat-completions endpoint.
 *
 * Covers Groq, DeepSeek, Mistral, OpenRouter, Together, xAI, Cerebras,
 * Ollama, LM Studio, Gemini's compatibility layer, and any custom provider
 * the user defines in ~/.soluna/config.json.
 */
export class OpenAICompatibleProvider {
  /**
   * @param {object} options
   * @param {string} options.id        Provider id, used in error messages
   * @param {string} options.label     Human-readable name
   * @param {string} options.baseUrl   Endpoint root, e.g. https://api.groq.com/openai/v1
   * @param {string} [options.apiKey]  Key, or read from apiKeyEnv
   * @param {string} [options.apiKeyEnv]
   * @param {boolean} [options.requiresKey]
   * @param {string} [options.model]   Default model
   */
  constructor(options = {}) {
    this.id = options.id || "custom";
    this.label = options.label || this.id;
    this.baseUrl = String(options.baseUrl || "").replace(/\/+$/, "");
    this.apiKeyEnv = options.apiKeyEnv || null;
    this.apiKey = options.apiKey || (this.apiKeyEnv ? process.env[this.apiKeyEnv] : null) || options.apiKeys?.[0] || null;
    this.apiKeys = this.id === "openrouter"
      ? [...new Set([this.apiKey, ...(options.apiKeys || [])].filter(Boolean))]
      : [this.apiKey].filter(Boolean);
    const savedCursor = keyCursors.get(this.id) || 0;
    this.keyIndex = this.apiKeys.length ? savedCursor % this.apiKeys.length : 0;
    this.requiresKey = options.requiresKey ?? Boolean(this.apiKeyEnv);
    this.defaultModel = options.model || null;
    this.extraHeaders = options.headers || {};
    this.onKeyRotation = options.onKeyRotation;

    if (!this.baseUrl) {
      throw new Error(`Provider "${this.id}" has no baseUrl configured`);
    }
    if (this.requiresKey && !this.apiKey) {
      throw new Error(
        `${this.label} needs an API key. Run /setkey to enter one, ` +
          `or export ${this.apiKeyEnv} before starting.`,
      );
    }
  }

  get name() {
    return this.id;
  }

  #headers() {
    const headers = { "Content-Type": "application/json", ...this.extraHeaders };
    const key = this.apiKeys[this.keyIndex] || this.apiKey;
    if (key) headers.Authorization = `Bearer ${key}`;
    // OpenRouter asks callers to identify themselves.
    if (this.id === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/";
      headers["X-Title"] = "Soluna";
    }
    return headers;
  }

  #body(messages, model, tools, stream) {
    return JSON.stringify({
      model: model || this.defaultModel,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
  }

  async #fail(response) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${this.label} API error ${response.status}: ${detail.slice(0, 300)}`);
  }

  async #request(body, signal, path = "/chat/completions", method = "POST") {
    const count = this.id === "openrouter" && method !== "GET" ? this.apiKeys.length : 1;
    let lastError;
    for (let tried = 0; tried < count; tried++) {
      const headers = this.#headers();
      // OpenRouter's model catalog is public. A stale/limited bearer key must
      // not prevent the full catalog from loading in the model picker.
      if (method === "GET" && path === "/models") delete headers.Authorization;
      const response = await fetch(`${this.baseUrl}${path}`, {
        method, headers, ...(body ? { body } : {}), signal,
      });
      if (response.ok) return response;
      const detail = await response.text().catch(() => "");
      lastError = new Error(`${this.label} API error ${response.status}: ${detail.slice(0, 300)}`);
      const isOpenRouterQuota = this.id === "openrouter" && [402, 429].includes(response.status);
      if (!isOpenRouterQuota) throw lastError;
      if (tried + 1 >= count) {
        if (/free-models-per-day|openrouter_free_tier_daily/i.test(detail)) {
          throw new Error(
            `${lastError.message}\nAutomatic key failover tried ${count} configured key(s), but the OpenRouter free-model daily quota is exhausted. This quota is shared by the OpenRouter account: another key from the same account will not add quota. Add credits/use a paid model, wait for reset, or configure keys from different eligible accounts.`,
          );
        }
        throw lastError;
      }
      this.keyIndex = (this.keyIndex + 1) % count;
      keyCursors.set(this.id, this.keyIndex);
      this.onKeyRotation?.({
        failedKey: tried + 1,
        nextKey: this.keyIndex + 1,
        keyCount: count,
        status: response.status,
      });
    }
    throw lastError;
  }

  async chat({ messages, model, tools, signal }) {
    const response = await this.#request(this.#body(messages, model, tools, false), signal);

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error(`${this.label} returned no choices`);

    return {
      content: choice.message?.content || "",
      tool_calls: choice.message?.tool_calls || [],
      finish_reason: choice.finish_reason,
      usage: data.usage,
    };
  }

  async stream({ messages, model, tools, signal, onTextDelta, onToolDelta }) {
    const response = await this.#request(this.#body(messages, model, tools, true), signal);

    const acc = createStreamAccumulator({ onTextDelta, onToolDelta });
    for await (const chunk of parseSSE(response, signal)) acc.push(chunk);
    return acc.result();
  }

  /** Discover models from GET /models when the provider supports it. */
  async listModels() {
    const response = await this.#request(undefined, undefined, "/models", "GET");

    const data = await response.json();
    const arr = Array.isArray(data) ? data : data.data || data.models || [];
    return arr
      .map((m) => {
        const id = typeof m === "string" ? m : m.id || m.name;
        if (!id) return null;
        return {
          id,
          label: typeof m === "string" ? m : m.name || m.id,
          context: m?.context_length ?? m?.context_window,
          hint: m?.owned_by || "",
        };
      })
      .filter(Boolean);
  }
}
