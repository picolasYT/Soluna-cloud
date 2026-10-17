import { buildCompactionRequest } from "./compaction-prompt.js";
import { estimateMessagesTokens, estimateTokens } from "./tokens.js";
import { getContextLimit } from "./model-registry.js";

/**
 * Context compaction.
 *
 * When the conversation approaches the model's limit we ask the model itself
 * for a handoff document and replace the old transcript with it.
 *
 * Kept verbatim:
 *   - the first user message (the original goal)
 *   - the last N messages (the immediate, still-relevant work)
 *
 * Everything in between is replaced by the document.
 */

/** Fraction of the context window that triggers compaction. */
export const COMPACT_THRESHOLD = 0.80;

/** How many recent messages are kept verbatim. */
const KEEP_RECENT = 8;

/** Headroom reserved for the model's reply. */
const OUTPUT_RESERVE = 4096;

/**
 * @returns {{needed:boolean, used:number, limit:number, ratio:number, headroom:number}}
 */
export function checkContext(messages, model, { reserve = OUTPUT_RESERVE } = {}) {
  const limit = getContextLimit(model);
  const used = estimateMessagesTokens(messages);
  const usable = Math.max(1, limit - reserve);
  const ratio = used / usable;
  return {
    needed: ratio >= COMPACT_THRESHOLD,
    used,
    limit,
    ratio,
    headroom: Math.max(0, usable - used),
  };
}

/** Provider errors that mean "context is full". */
export function isContextOverflowError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    msg.includes("context length") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("prompt is too long") ||
    msg.includes("reduce the length") ||
    (msg.includes("token") && msg.includes("exceed"))
  );
}

/**
 * Split the conversation into the parts kept and the part summarised.
 *
 * Never cut between a tool_call and its result: orphaned messages are
 * rejected by many providers.
 */
export function splitForCompaction(messages, keepRecent = KEEP_RECENT) {
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length <= keepRecent + 1) {
    return { head: [], middle: nonSystem, tail: [] };
  }

  const head = nonSystem.slice(0, 1); // original goal
  let cut = nonSystem.length - keepRecent;

  // Walk back to a safe cut point.
  while (cut > 1 && !isSafeBoundary(nonSystem, cut)) cut--;
  if (cut <= 1) return { head: [], middle: nonSystem, tail: [] };

  return {
    head,
    middle: nonSystem.slice(1, cut),
    tail: nonSystem.slice(cut),
  };
}

/** A cut is safe when it does not separate a tool_call from its result. */
function isSafeBoundary(messages, index) {
  const at = messages[index];
  if (at?.role === "tool") return false;

  const prev = messages[index - 1];
  if (prev?.role === "assistant" && prev.tool_calls?.length) return false;

  return true;
}

/**
 * Run the compaction.
 *
 * @returns {{messages:Array, summary:string, before:number, after:number, saved:number}}
 */
export async function compactConversation({
  messages,
  provider,
  model,
  cwd,
  signal,
  previousSummary,
  toolStats,
  keepRecent = KEEP_RECENT,
  onProgress,
}) {
  const before = estimateMessagesTokens(messages);
  const { head, middle, tail } = splitForCompaction(messages, keepRecent);

  if (middle.length === 0) {
    // Nothing in the middle to summarise.
    return { messages, summary: previousSummary || "", before, after: before, saved: 0, skipped: true };
  }

  onProgress?.({ phase: "summarizing", messages: middle.length });

  const request = buildCompactionRequest(middle, { cwd, model, previousSummary, toolStats });

  // Compaction never uses tools: text only.
  const response =
    typeof provider.stream === "function"
      ? await provider.stream({ messages: request, model, tools: [], signal })
      : await provider.chat({ messages: request, model, tools: [], signal });

  const summary = String(response?.content || "").trim();
  if (!summary) throw new Error("Compaction produced an empty summary");

  onProgress?.({ phase: "rebuilding", summaryTokens: estimateTokens(summary) });

  const rebuilt = [
    ...head,
    {
      role: "user",
      content: `[CONTEXT COMPACTED]

The conversation before this point was summarized to free up context. This handoff document is the authoritative record of everything that happened. Treat it as fact and continue from it.

${summary}`,
    },
    {
      role: "assistant",
      content:
        "Understood. I have the full handoff document and will continue from the next steps it describes.",
    },
    ...tail,
  ];

  const after = estimateMessagesTokens(rebuilt);

  return {
    messages: rebuilt,
    summary,
    before,
    after,
    saved: Math.max(0, before - after),
    compactedCount: middle.length,
  };
}
