import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SOLUNA_HOME } from "./session-store.js";

/**
 * Real context limits, sourced from models.dev.
 *
 * Cascading strategy:
 *   1. on-disk cache (~/.soluna/models.json), valid for 24h
 *   2. background download from models.dev
 *   3. an embedded table as an offline fallback
 *
 * Lookup is synchronous (`getLimits`) so rendering never blocks; the download
 * runs once at startup and refreshes the in-memory table.
 */

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimal fallback with no network or cache. Values verified on models.dev. */
const FALLBACK = {
  "deepseek-v4-flash-free": { context: 200000, output: 128000 },
  "big-pickle": { context: 200000, output: 32000 },
  "mimo-v2.5-free": { context: 128000, output: 32000 },
  "longcat-2.0-free": { context: 1000000, output: 131072 },
  "nemotron-3-ultra-free": { context: 256000, output: 32000 },
  "north-mini-code-free": { context: 256000, output: 32000 },
  "laguna-s-2.1-free": { context: 128000, output: 32000 },
  "ling-3.0-tiny-free": { context: 128000, output: 32000 },
  "minimax-m2.7": { context: 200000, output: 131072 },
  "glm-5.1": { context: 200000, output: 128000 },
  "kimi-k2.6": { context: 256000, output: 32000 },
  "qwen3.6-plus": { context: 262144, output: 32768 },
  "gpt-4o": { context: 128000, output: 16384 },
  "gpt-4o-mini": { context: 128000, output: 16384 },
  "gpt-4-turbo": { context: 128000, output: 4096 },
  o1: { context: 200000, output: 100000 },
  "o1-mini": { context: 128000, output: 65536 },
  "claude-sonnet-4-20250514": { context: 200000, output: 64000 },
  "claude-3-5-sonnet-20241022": { context: 200000, output: 8192 },
  "claude-3-5-haiku-20241022": { context: 200000, output: 8192 },
  "claude-3-opus-20240229": { context: 200000, output: 4096 },
};

const DEFAULT_LIMITS = { context: 128000, output: 8192 };

/** models.dev providers to search, in order of preference. */
const LOOKUP_ORDER = ["opencode", "openai", "anthropic", "google", "deepseek"];

let memory = new Map();
let loaded = false;
let loadingPromise = null;

function cachePath() {
  return join(SOLUNA_HOME, "models.json");
}

/** Flatten the models.dev payload into `id -> {context, output}`. */
function index(db) {
  const map = new Map();
  const providers = [...LOOKUP_ORDER, ...Object.keys(db).filter((p) => !LOOKUP_ORDER.includes(p))];
  for (const provider of providers) {
    const models = db[provider]?.models;
    if (!models) continue;
    for (const [id, meta] of Object.entries(models)) {
      // The first provider in the order wins.
      if (map.has(id)) continue;
      const context = meta?.limit?.context;
      const output = meta?.limit?.output;
      if (typeof context === "number" && context > 0) {
        map.set(id, { context, output: typeof output === "number" ? output : undefined });
      }
    }
  }
  return map;
}

async function readCache() {
  try {
    const raw = await readFile(cachePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed?.fetchedAt || Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.models || null;
  } catch {
    return null;
  }
}

async function writeCache(models) {
  try {
    const path = cachePath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ fetchedAt: Date.now(), models }), "utf-8");
  } catch {
    // The cache is best-effort.
  }
}

/**
 * Load the limits. Safe to call repeatedly: it downloads only once.
 * Never throws: on network failure it keeps the fallback table.
 */
export function loadModelLimits({ timeoutMs = 4000 } = {}) {
  if (loaded) return Promise.resolve(memory);
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const cached = await readCache();
    if (cached) {
      memory = new Map(Object.entries(cached));
      loaded = true;
      return memory;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const db = await res.json();
      memory = index(db);
      loaded = true;
      await writeCache(Object.fromEntries(memory));
    } catch {
      // Offline: the embedded fallback covers the common models.
      loaded = true;
    }
    return memory;
  })();

  return loadingPromise;
}

/** Synchronous lookup. Returns the best data available at that moment. */
export function getLimits(model) {
  if (!model) return DEFAULT_LIMITS;
  return memory.get(model) || FALLBACK[model] || DEFAULT_LIMITS;
}

export function getContextLimit(model) {
  return getLimits(model).context;
}

export function getOutputLimit(model) {
  return getLimits(model).output ?? DEFAULT_LIMITS.output;
}

/** True when the value came from models.dev rather than the fallback. */
export function isExact(model) {
  return memory.has(model);
}
