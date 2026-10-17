/**
 * Shared helpers for SSE streaming from OpenAI-compatible APIs.
 */

/** Iterate the JSON objects of an SSE stream. */
export async function* parseSSE(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are newline-separated and may arrive split.
      let newlineAt;
      while ((newlineAt = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);

        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;

        try {
          yield JSON.parse(payload);
        } catch {
          // Incomplete frame or keep-alive: ignore.
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be closed.
    }
  }
}

/**
 * Accumulate OpenAI stream chunks into a complete response.
 * Reassembles tool_calls that arrive fragmented by index.
 */
export function createStreamAccumulator({ onTextDelta, onToolDelta }) {
  let content = "";
  // Index-based during accumulation so fragmented chunks (id+name first,
  // argument fragments after) reassemble correctly. Deduped by id on result().
  const toolCalls = [];
  let usage = null;
  let finishReason = null;

  return {
    push(chunk) {
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) return;

      if (delta.content) {
        content += delta.content;
        onTextDelta?.(delta.content, content);
      }

      for (const tc of delta.tool_calls || []) {
        const index = tc.index ?? 0;

        if (!toolCalls[index]) {
          toolCalls[index] = {
            id: tc.id || `call_${index}`,
            type: "function",
            function: { name: "", arguments: "" },
          };
        }

        const target = toolCalls[index];
        if (tc.id) target.id = tc.id;
        if (tc.function?.name) target.function.name += tc.function.name;
        if (tc.function?.arguments) target.function.arguments += tc.function.arguments;

        onToolDelta?.({
          index,
          id: target.id,
          name: target.function.name,
          argumentsText: target.function.arguments,
        });
      }
    },

    result() {
      // Deduplicate by id: some providers re-emit the same tool call with
      // different indices, which would otherwise execute it multiple times.
      const byId = new Map();
      for (const tc of toolCalls) {
        if (!tc) continue;
        if (tc.id && byId.has(tc.id)) continue;
        if (tc.id) byId.set(tc.id, tc);
        else byId.set(`idx_${toolCalls.indexOf(tc)}`, tc);
      }
      return {
        content,
        tool_calls: [...byId.values()],
        finish_reason: finishReason,
        usage,
      };
    },
  };
}
