/**
 * Retry with exponential backoff for provider calls.
 *
 * Only failures that can resolve themselves are retried: network drops, 5xx,
 * rate limits and timeouts. An auth error or a malformed request will fail
 * exactly the same way twice, so those propagate immediately.
 */

export const DEFAULT_ATTEMPTS = 3;
const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 8000;

/** Network and server errors that a retry often fixes. */
const RETRYABLE_PATTERNS = [
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOTFOUND\b/i,
  /\bEPIPE\b/i,
  /\bEAI_AGAIN\b/i,
  /fetch failed/i,
  /terminated/i,
  /socket hang up/i,
  /network/i,
  /timed? ?out/i,
  /\b(?:429|500|502|503|504)\b/,
  /rate.?limit/i,
  /overloaded/i,
  /temporarily unavailable/i,
  /upstream request failed/i,
  /closed the connection/i,
  /empty response/i,
  /stream.*drop/i,
];

/** Errors that must NOT be retried: they would fail identically. */
const FATAL_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /\b404\b/,
  /auth/i,
  /api key/i,
  /clave api/i,
  /unauthorized/i,
  /forbidden/i,
  /model not found/i,
  /invalid_request_error/i,
  /context length/i,
  /maximum context/i,
  /too many tokens/i,
];

export function isRetryable(error) {
  const msg = String(error?.message || error || "");
  if (!msg) return false;
  // Aborting is a deliberate user action: never retry it.
  if (error?.name === "AbortError" || /\baborted\b/i.test(msg)) return false;
  if (FATAL_PATTERNS.some((re) => re.test(msg))) return false;
  return RETRYABLE_PATTERNS.some((re) => re.test(msg));
}

/** Exponential backoff with jitter, so retries do not synchronise. */
export function backoffDelay(attempt) {
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/**
 * Run `fn`, retrying transient failures.
 *
 * @param {Function} fn        receives the attempt number (1-indexed)
 * @param {object}   options   { attempts, signal, onRetry, onRetryResolved, shouldRetry }
 */
export async function withRetry(fn, options = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    signal,
    onRetry,
    onRetryResolved,
    shouldRetry = isRetryable,
  } = options;

  let lastError;
  let retriesHappened = false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new Error("aborted");

    try {
      const result = await fn(attempt);
      // Succeeded after one or more retries: tell the caller so it can
      // clear any "retrying…" indicator that onRetry raised.
      if (retriesHappened) onRetryResolved?.({ attempt });
      return result;
    } catch (err) {
      lastError = err;
      retriesHappened = true;

      const isLast = attempt === attempts;
      if (isLast || !shouldRetry(err) || signal?.aborted) throw err;

      const delay = backoffDelay(attempt);
      onRetry?.({ attempt, attempts, delay, error: err });

      await sleep(delay, signal);
    }
  }

  throw lastError;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
