import { getSystemPrompt } from "./system-prompt.js";
import { loadProjectInstructions, renderProjectInstructions } from "./project-instructions.js";
import { parsePartialJSON } from "./partial-json.js";
import {
  checkContext,
  compactConversation,
  isContextOverflowError,
} from "./compaction.js";
import { withRetry, DEFAULT_ATTEMPTS } from "./retry.js";
import { logger } from "./logger.js";

/**
 * Main agent loop.
 *
 * Emits granular events so the UI can show live progress:
 *   onMessage        assistant text while streaming (ephemeral)
 *   onMessageFinal   a closed text block, ready for the transcript
 *   onToolPrepare    partial arguments while they stream
 *   onToolCall       a tool begins executing
 *   onToolResult     a tool finished
 *   onUsage          token usage reported by the provider
 *
 * `onMessageFinal` fires BEFORE the tools of that same iteration run, so the
 * UI can insert text and tool activity in the order they actually happened.
 */
export async function runAgentLoop(options) {
  const {
    messages = [],
    tools = [],
    provider,
    model,
    cwd,
    signal,
    onMessage,
    onMessageFinal,
    onToolPrepare,
    onToolCall,
    onToolResult,
    onUsage,
    onCompaction,
    onRetry,
    onRetryResolved,
    maxIterations = 50,
    autoCompact = true,
    retries = DEFAULT_ATTEMPTS,
  } = options;

  // Compaction state that persists across iterations of this turn.
  let previousSummary = options.previousSummary || null;
  const toolStats = { total: 0, byName: {} };

  // Project instructions (AGENTS.md) join the skills index in the prompt.
  let systemExtra = options.systemExtra || "";
  try {
    const project = await loadProjectInstructions(cwd);
    if (project) {
      systemExtra += renderProjectInstructions(project);
      if (cwd && cwd === process.cwd()) logger.debug("loaded project instructions", { file: project.file });
    }
  } catch {
    // Ignore: a broken instructions file must not break the agent.
  }

  const systemPrompt = getSystemPrompt(cwd, tools, systemExtra);
  const conversation = [{ role: "system", content: systemPrompt }, ...messages];
  let iterations = 0;

  const toolSchemas = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  /** Compact the running conversation and update turn state. */
  const runCompaction = async (reason) => {
    const result = await compactConversation({
      messages: conversation,
      provider,
      model,
      cwd,
      signal,
      previousSummary,
      toolStats,
      onProgress: (p) => onCompaction?.({ ...p, reason }),
    });

    if (result.skipped) return false;

    previousSummary = result.summary;
    // Keep the system prompt, replace everything else.
    conversation.length = 0;
    conversation.push({ role: "system", content: systemPrompt }, ...result.messages);

    onCompaction?.({
      phase: "done",
      reason,
      before: result.before,
      after: result.after,
      saved: result.saved,
      compactedCount: result.compactedCount,
      summary: result.summary,
    });
    return true;
  };

  while (iterations < maxIterations) {
    if (signal?.aborted) throw new Error("Agent loop aborted");
    iterations++;

    // Compact pre-emptively: before the call, not after it fails.
    if (autoCompact) {
      const status = checkContext(conversation, model);
      if (status.needed) {
        onCompaction?.({
          phase: "start",
          reason: "threshold",
          used: status.used,
          limit: status.limit,
          ratio: status.ratio,
        });
        try {
          await runCompaction("threshold");
        } catch (err) {
          // If it fails, carry on: the request may still fit.
          onCompaction?.({ phase: "failed", reason: "threshold", error: err.message });
        }
      }
    }

    const supportsStream = typeof provider.stream === "function";

    // Some providers expect the tool result inside the same generation.
    // For those we run tools through this callback instead of the loop
    // further down.
    const sessionScoped = provider.sessionScopedTools === true;

    // Text already emitted this iteration, so we do not repeat it on close.
    let streamedText = "";
    let flushedText = "";

    /**
     * Flush pending text into the transcript.
     *
     * With `sessionScopedTools` the tool runs INSIDE the stream, so we must
     * close the text block right before executing it, or the UI would show
     * the tool above the comment that introduced it.
     */
    const flushText = () => {
      const pending = streamedText.slice(flushedText.length).trim();
      if (!pending) return;
      flushedText = streamedText;
      onMessageFinal?.(pending);
    };

    const executeTool = sessionScoped
      ? async (call) => {
          flushText();

          const name = call.function?.name;
          const tool = tools.find((t) => t.name === name);
          if (!tool) return { error: `Tool "${name}" not found` };

          let args = {};
          try {
            args =
              typeof call.function?.arguments === "string"
                ? JSON.parse(call.function.arguments || "{}")
                : call.function?.arguments || {};
          } catch (err) {
            return { error: `Invalid arguments: ${err.message}` };
          }

          toolStats.total++;
          toolStats.byName[name] = (toolStats.byName[name] || 0) + 1;

          onToolCall?.({ id: call.id, name, args });
          try {
            const result = await tool.execute(args, signal);
            onToolResult?.({ id: call.id, name, args, result });
            return (result.content || [])
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
          } catch (err) {
            onToolResult?.({ id: call.id, name, args, error: err });
            return { error: err.message };
          }
        }
      : undefined;

    const callProvider = () =>
      supportsStream
      ? provider.stream({
          messages: conversation,
          model,
          tools: toolSchemas,
          signal,
          executeTool,
          onTextDelta: (delta, full) => {
            streamedText = full;
            onMessage?.({ role: "assistant", content: full, delta });
          },
          onToolCalls: (calls) => {
            for (const c of calls) {
              onToolPrepare?.({
                id: c.id,
                name: c.function?.name,
                args: parsePartialJSON(c.function?.arguments) || {},
                complete: true,
              });
            }
          },
          onToolDelta: (partial) => {
            // partial: { index, id, name, argumentsText }
            const args = parsePartialJSON(partial.argumentsText) || {};
            onToolPrepare?.({
              id: partial.id,
              index: partial.index,
              name: partial.name,
              args,
              complete: false,
            });
          },
        })
      : provider.chat({ messages: conversation, model, tools: toolSchemas, signal });

    // Wrap the provider call so that an empty response (no content, no tool
    // calls) is treated as a transient failure and retried, instead of silently
    // ending the turn. This happens when the stream drops mid-generation.
    const callAndValidate = async () => {
      const response = await callProvider();
      const emptyContent = !response.content || String(response.content).trim() === "";
      const emptyTools = !response.tool_calls || response.tool_calls.length === 0;
      if (emptyContent && emptyTools) {
        throw new Error("Provider returned an empty response — the stream may have dropped.");
      }
      return response;
    };

    const retryOpts = () => ({
      attempts: retries,
      signal,
      onRetry: (info) => {
        logger.warn("provider retry", { attempt: info.attempt, error: String(info.error?.message || info.error) });
        onRetry?.(info);
      },
      onRetryResolved: (info) => {
        logger.info("provider recovered after retry", { attempt: info.attempt });
        onRetryResolved?.(info);
      },
    });

    let response;
    try {
      response = await withRetry(callAndValidate, retryOpts());
    } catch (err) {
      // Safety net: the provider rejected on context size despite our estimate.
      // Compact once and retry.
      if (!autoCompact || signal?.aborted || !isContextOverflowError(err)) throw err;

      logger.info("compacting after overflow", { error: String(err.message) });
      onCompaction?.({ phase: "start", reason: "overflow", error: err.message });
      const didCompact = await runCompaction("overflow");
      if (!didCompact) throw err;
      response = await withRetry(callAndValidate, retryOpts());
    }

    if (response.usage) onUsage?.(response.usage);

    // Without streaming the text was never emitted during generation.
    if (!supportsStream && response.content) {
      onMessage?.({ role: "assistant", content: response.content });
    }

    // Deduplicate tool calls by id as a safety net for the non-streaming path
    // (the streaming accumulator already dedups). Some providers return the same
    // call twice, which would execute it multiple times.
    const rawCalls = response.tool_calls || [];
    const seen = new Set();
    const toolCalls = [];
    for (const tc of rawCalls) {
      const id = tc?.id;
      if (!id) {
        toolCalls.push(tc);
      } else if (!seen.has(id)) {
        seen.add(id);
        toolCalls.push(tc);
      }
    }

    // Close the text block before running tools so the UI pins it at the right
    // point in the transcript. If part was already flushed mid-stream, only
    // the remainder is emitted.
    if (response.content) {
      const remaining = response.content.slice(flushedText.length).trim();
      if (remaining) onMessageFinal?.(remaining);
    }

    if (toolCalls.length === 0) {
      return {
        messages: [...conversation, { role: "assistant", content: response.content }],
        iterations,
        summary: previousSummary,
      };
    }

    conversation.push({
      role: "assistant",
      content: response.content,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      if (signal?.aborted) throw new Error("Agent loop aborted");

      const name = toolCall.function.name;
      const tool = tools.find((t) => t.name === name);

      if (!tool) {
        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: Tool "${name}" not found`,
        });
        onToolResult?.({ id: toolCall.id, name, error: new Error(`Tool "${name}" not found`) });
        continue;
      }

      let args;
      try {
        args =
          typeof toolCall.function.arguments === "string"
            ? JSON.parse(toolCall.function.arguments || "{}")
            : toolCall.function.arguments || {};
      } catch (err) {
        const message = `Error parsing arguments: ${err.message}`;
        conversation.push({ role: "tool", tool_call_id: toolCall.id, content: message });
        onToolResult?.({ id: toolCall.id, name, error: new Error(message) });
        continue;
      }

      toolStats.total++;
      toolStats.byName[name] = (toolStats.byName[name] || 0) + 1;

      onToolCall?.({ id: toolCall.id, name, args });

      try {
        const result = await tool.execute(args, signal);
        onToolResult?.({ id: toolCall.id, name, args, result });

        const resultText = (result.content || [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultText || "Tool executed successfully",
        });
      } catch (err) {
        logger.warn("tool error", { tool: name, error: String(err.message) });
        onToolResult?.({ id: toolCall.id, name, args, error: err });
        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: ${err.message}`,
        });
      }
    }
  }

  return { messages: conversation, iterations, summary: previousSummary };
}
