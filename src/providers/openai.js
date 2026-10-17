import { parseSSE, createStreamAccumulator } from "./stream-utils.js";

/**
 * OpenAI provider.
 */
export class OpenAIProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    this.baseUrl = options.baseUrl || "https://api.openai.com/v1";
    this.defaultModel = options.model || "gpt-4o";

    if (!this.apiKey) {
      throw new Error("OpenAI API key required. Set OPENAI_API_KEY environment variable.");
    }
  }

  async chat(options) {
    const { messages, model, tools, signal } = options;

    const body = {
      model: model || this.defaultModel,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error("No response from OpenAI");
    }

    return {
      content: choice.message?.content || "",
      tool_calls: choice.message?.tool_calls || [],
      finish_reason: choice.finish_reason,
      usage: data.usage,
    };
  }

  /** Same as chat() but over SSE, emitting live deltas. */
  async stream(options) {
    const { messages, model, tools, signal, onTextDelta, onToolDelta } = options;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
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
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const acc = createStreamAccumulator({ onTextDelta, onToolDelta });
    for await (const chunk of parseSSE(response, signal)) {
      acc.push(chunk);
    }
    return acc.result();
  }

  get name() {
    return "openai";
  }

  get models() {
    return [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-4",
      "gpt-3.5-turbo",
      "o1",
      "o1-mini",
      "o1-pro",
    ];
  }
}
