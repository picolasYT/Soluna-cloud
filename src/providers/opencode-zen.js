import { parseSSE, createStreamAccumulator } from "./stream-utils.js";

/**
 * OpenCode Zen provider.
 * 
 * OpenCode Zen is an OpenAI-compatible AI model gateway.
 * Base URL: https://opencode.ai/zen/v1
 * 
 * FREE models (no API key required):
 * - big-pickle
 * - deepseek-v4-flash-free
 * - mimo-v2.5-free
 * - nemotron-3-ultra-free
 * - north-mini-code-free
 * - laguna-s-2.1-free
 * - ling-3.0-tiny-free
 * - longcat-2.0-free
 * 
 * Paid models (API key required):
 * - gpt-5.5, gpt-5.4, etc.
 * - claude-sonnet-4-5, etc.
 */
export class OpenCodeZenProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.OPENCODE_API_KEY || null;
    this.baseUrl = options.baseUrl || "https://opencode.ai/zen/v1";
    this.defaultModel = options.model || "deepseek-v4-flash-free";
    
    // Models that work without an API key (free tier)
    this.freeModels = [
      "big-pickle",
      "deepseek-v4-flash-free",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "north-mini-code-free",
      "laguna-s-2.1-free",
      "ling-3.0-tiny-free",
      "longcat-2.0-free",
    ];
  }

  async chat(options) {
    const { messages, model, tools, signal } = options;
    const selectedModel = model || this.defaultModel;

    const body = {
      model: selectedModel,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
    };

    // Build headers
    const headers = {
      "Content-Type": "application/json",
    };

    // Only add Authorization when a key is present
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      
      // On 401 with a free model, give a clearer hint
      if (response.status === 401 && this.freeModels.includes(selectedModel)) {
        throw new Error(`Model "${selectedModel}" is free but requires auth. Try: export OPENCODE_API_KEY="your-key" or use --provider zen`);
      }
      
      throw new Error(`OpenCode Zen API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error("No response from OpenCode Zen");
    }

    return {
      content: choice.message?.content || "",
      tool_calls: choice.message?.tool_calls || [],
      finish_reason: choice.finish_reason,
      usage: data.usage,
    };
  }

  /**
   * Same as chat() but over SSE, emitting live deltas.
   */
  async stream(options) {
    const { messages, model, tools, signal, onTextDelta, onToolDelta } = options;

    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || this.defaultModel,
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenCode Zen API error: ${response.status} ${error}`);
    }

    const acc = createStreamAccumulator({ onTextDelta, onToolDelta });
    for await (const chunk of parseSSE(response, signal)) {
      acc.push(chunk);
    }
    return acc.result();
  }

  /**
   * Fetch the list of available models
   */
  async listModels() {
    const headers = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/models`, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();
    return data.data || [];
  }

  get name() {
    return "opencode-zen";
  }

  get models() {
    return [
      // Gratuitos (sin API key)
      "deepseek-v4-flash-free",
      "big-pickle",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "north-mini-code-free",
      "laguna-s-2.1-free",
      "ling-3.0-tiny-free",
      "longcat-2.0-free",
      // De pago (requieren API key)
      "minimax-m2.5",
      "minimax-m2.7",
      "glm-5.1",
      "kimi-k2.6",
      "qwen3.6-plus",
      "gpt-5.5",
      "gpt-5.4-mini",
    ];
  }
}
