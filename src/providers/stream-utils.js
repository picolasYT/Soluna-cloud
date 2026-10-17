/**
 * Shared helpers for SSE streaming from OpenAI-compatible APIs.
 */

/** Iterate the JSON objects of an SSE stream. */
export async function* parseSSE(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  const decodeEvent = () => {
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload) return null;
    if (payload === "[DONE]") return "done";
    try { return JSON.parse(payload); }
    catch { throw new Error("Provider stream dropped an invalid or incomplete JSON event."); }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");

      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer && !buffer.endsWith("\n")) buffer += "\n";

      // SSE events are newline-separated and may arrive split.
      let newlineAt;
      while ((newlineAt = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);

        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        else if (!line) {
          const event = decodeEvent();
          if (event === "done") return;
          if (event) yield event;
        }
      }
      if (done) {
        const event = decodeEvent();
        if (event && event !== "done") yield event;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
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
      assertProviderResponse(chunk);
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason === "error") throw new Error("Provider API error 502: generation failed during streaming.");
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta || choice.message;
      if (!delta) return;

      const text = responseText(delta.content);
      if (text) {
        content += text;
        onTextDelta?.(text, content);
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
      const result = {
        content,
        tool_calls: [...byId.values()],
        finish_reason: finishReason,
        usage,
      };
      assertVisibleResponse(result);
      return result;
    },
  };
}

export function responseText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part.type === "text").map((part) => part.text || "").join("");
  return "";
}

/** HTTP 200 can still carry a provider error inside JSON or SSE. */
export function assertProviderResponse(data, label = "Provider") {
  if (!data?.error) return;
  const error = data.error;
  throw new Error(`${label} API error ${error.code || error.metadata?.error_type || "unknown"}: ${typeof error === "string" ? error : error.message || "generation failed"}`);
}

export function assertVisibleResponse(result) {
  if (result.content.trim() || result.tool_calls.length) return;
  if (result.finish_reason === "length") {
    throw new Error("El modelo agotó el límite de generación sin producir texto visible. Aumentá el presupuesto de salida o elegí otro modelo.");
  }
  if (result.finish_reason === "content_filter") {
    throw new Error("El proveedor bloqueó la respuesta por su filtro de contenido. Revisá el mensaje o elegí otro modelo.");
  }
}
