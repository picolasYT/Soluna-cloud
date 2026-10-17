/**
 * Token estimation and context limits.
 *
 * We do not ship a real tokenizer (tiktoken is ~2MB and native). The ~4
 * characters-per-token heuristic is good enough for a progress bar. When the
 * provider returns real `usage`, that value takes precedence.
 */

const CHARS_PER_TOKEN = 4;

export {
  getContextLimit,
  getOutputLimit,
  loadModelLimits,
  isExact as isExactLimit,
} from "./model-registry.js";

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

/** Estimate tokens for an array of messages, including tool calls. */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages || []) {
    total += 4; // per-message overhead (role, separators)
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text") total += estimateTokens(part.text);
        else if (part?.type === "image") total += 800; // approximation
      }
    }
    for (const tc of msg.tool_calls || []) {
      total += estimateTokens(tc.function?.name);
      total += estimateTokens(
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments || {}),
      );
    }
  }
  return total;
}

/** Format a count: 1234 -> "1.2k" */
export function formatTokens(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  if (num < 1000000) return `${(num / 1000).toFixed(num < 10000 ? 1 : 0)}k`;
  return `${(num / 1000000).toFixed(1)}M`;
}

/** Context progress bar. */
export function contextBar(used, limit, width = 10) {
  const ratio = Math.max(0, Math.min(1, used / limit));
  const filled = Math.round(ratio * width);
  return {
    bar: "█".repeat(filled) + "░".repeat(width - filled),
    percent: Math.round(ratio * 100),
    ratio,
  };
}

/** Accumulates usage across a session. */
export class UsageTracker {
  constructor() {
    this.input = 0;
    this.output = 0;
    this.turns = 0;
    this.toolCalls = 0;
    this.lastInput = 0;
    this.lastOutput = 0;
  }

  /** Record the `usage` returned by the provider. */
  record(usage) {
    if (!usage) return;
    const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
    this.input += input;
    this.output += output;
    this.lastInput = input;
    this.lastOutput = output;
  }

  get total() {
    return this.input + this.output;
  }

  snapshot() {
    return {
      input: this.input,
      output: this.output,
      total: this.total,
      turns: this.turns,
      toolCalls: this.toolCalls,
    };
  }
}
