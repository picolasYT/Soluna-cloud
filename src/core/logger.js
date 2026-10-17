import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SOLUNA_HOME } from "./session-store.js";

/**
 * Minimal structured logger.
 *
 * Everything the agent does of note goes to
 *
 *   ~/.soluna/logs/soluna-YYYY-MM-DD.log
 *
 * as one JSON object per line. Errors and warnings are always written;
 * debug lines only when SOLUNA_DEBUG=1 is set. Secrets in messages are
 * redacted on the way out.
 *
 * Writes are fire-and-forget with an internal queue, so a slow disk can
 * never block the agent.
 */

const LOG_DIR = join(SOLUNA_HOME, "logs");
const dateStamp = () => new Date().toISOString().slice(0, 10);
const fileFor = () => join(LOG_DIR, `soluna-${dateStamp()}.log`);

let queue = Promise.resolve();
let debugEnabled = Boolean(process.env.SOLUNA_DEBUG || process.env.ZYN_DEBUG);

export function setDebug(enabled) {
  debugEnabled = Boolean(enabled);
}

/** Replace anything that looks like a secret (long key/token strings). */
function redact(text) {
  return String(text).replace(/(sk-[A-Za-z0-9_\-]{8,}|AIza[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9._\-]{12,}|[A-Za-z0-9]{32,})/g, "[redacted]");
}

function write(level, message, fields) {
  if (level === "debug" && !debugEnabled) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message: redact(message),
    ...(fields ? JSON.parse(redact(JSON.stringify(fields))) : {}),
  };

  const line = `${JSON.stringify(entry)}\n`;
  queue = queue
    .then(async () => {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(fileFor(), line, "utf-8");
    })
    .catch(() => {
      // Logging must never crash the agent.
    });
}

export const logger = {
  debug: (message, fields) => write("debug", message, fields),
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
  /** Flush pending writes (used on shutdown). */
  flush: () => queue,
  get logDir() {
    return LOG_DIR;
  },
};
