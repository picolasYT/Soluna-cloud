/**
 * Anthropic provider.
 */
export class AnthropicProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    this.baseUrl = options.baseUrl || "https://api.anthropic.com/v1";
    this.defaultModel = options.model || "claude-sonnet-4-20250514";

    if (!this.apiKey) {
      throw new Error("Anthropic API key required. Set ANTHROPIC_API_KEY environment variable.");
    }
  }

  async chat(options) {
    const { messages, model, tools, signal } = options;

    // Convert OpenAI-shaped messages into Anthropic's format
    const systemMessage = messages.find((m) => m.role === "system");
    const otherMessages = messages.filter((m) => m.role !== "system");

    // Convert the assistant's tool_calls
    const convertedMessages = [];
    for (const msg of otherMessages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        // Convert tool_calls into Anthropic's format
        const content = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments,
          });
        }
        convertedMessages.push({ role: "assistant", content });
      } else if (msg.role === "tool") {
        // Convert a tool result into Anthropic's format
        convertedMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            },
          ],
        });
      } else {
        convertedMessages.push(msg);
      }
    }

    // Convert tools into Anthropic's format
    const anthropicTools = tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));

    const body = {
      model: model || this.defaultModel,
      max_tokens: 4096,
      system: systemMessage?.content || "",
      messages: convertedMessages,
      tools: anthropicTools && anthropicTools.length > 0 ? anthropicTools : undefined,
    };

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = await response.json();

    // Convert the response back into OpenAI's format
    let content = "";
    const toolCalls = [];

    for (const block of data.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content,
      tool_calls: toolCalls,
      finish_reason: data.stop_reason,
      usage: data.usage,
    };
  }

  get name() {
    return "anthropic";
  }

  get models() {
    return [
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ];
  }
}
