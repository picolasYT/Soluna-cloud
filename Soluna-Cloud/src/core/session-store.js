import { readFile, writeFile, mkdir, readdir, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * Persistent storage in the user's home directory.
 *
 *   ~/.soluna/
 *     config.json          Global preferences and custom providers
 *     models.json          Cached context limits (from models.dev)
 *     mcp.json             MCP server definitions
 *     sessions/<id>.json   One file per conversation
 *     skills/<name>/SKILL.md
 *
 * Set SOLUNA_HOME to relocate all of it (useful for tests and sandboxes).
 * ZYN_HOME and an existing ~/.zyn directory remain supported for migration.
 */

/**
 * Home directory that works on every platform. On Windows, HOME is usually
 * unset (or a POSIX-style /c/Users/x path when started from Git Bash), so
 * USERPROFILE and os.homedir() are preferred; on Termux/Linux HOME is right.
 */
function resolveUserHome() {
  const candidates = process.platform === "win32"
    ? [process.env.USERPROFILE, process.env.HOME, homedir()]
    : [process.env.HOME, homedir(), process.env.USERPROFILE];
  for (const dir of candidates) {
    if (dir && isAbsolute(dir) && !(process.platform === "win32" && /^\/[a-z]\//i.test(dir))) return dir;
  }
  return homedir() || process.cwd();
}

const userHome = resolveUserHome();
const solunaHome = join(userHome, ".soluna");
const legacyHome = join(userHome, ".zyn");
export const SOLUNA_HOME = resolve(
  process.env.SOLUNA_HOME || process.env.ZYN_HOME ||
  (existsSync(solunaHome) || !existsSync(legacyHome) ? solunaHome : legacyHome),
);
// Kept as an export alias for library consumers upgrading from Zyn.
export const ZYN_HOME = SOLUNA_HOME;
export const SESSIONS_DIR = join(SOLUNA_HOME, "sessions");
export const SKILLS_DIR = join(SOLUNA_HOME, "skills");
export const CONFIG_PATH = join(SOLUNA_HOME, "config.json");
export const MCP_PATH = join(SOLUNA_HOME, "mcp.json");

export const DEFAULT_CONFIG = {
  /** Last used provider id. */
  provider: null,
  /** Last used model id. */
  model: null,
  /** Colour theme name. */
  theme: "soluna",
  /** Compact automatically when the context fills up. */
  autoCompact: true,
  /** Fraction of the context window that triggers compaction. */
  compactThreshold: 0.80,
  /** Retry attempts for transient provider failures. */
  retries: 3,
  /** How many sessions to keep before pruning the oldest. */
  maxSessions: 50,
  /**
   * User-defined providers, keyed by id. Any OpenAI-compatible endpoint works.
   *
   *   "my-llm": {
   *     "label": "My LLM",
   *     "baseUrl": "http://localhost:8080/v1",
   *     "apiKeyEnv": "MY_LLM_KEY",
   *     "models": [{ "id": "llama-3", "label": "Llama 3" }]
   *   }
   */
  customProviders: {},
  /** Extra models added to built-in providers: { providerId: [{id,label}] } */
  customModels: {},
  /**
   * API keys entered through the TUI, keyed by provider id.
   *
   * Environment variables always win, so exporting a key keeps it out of
   * this file. Stored keys exist so users who do not want to manage shell
   * exports can still configure a provider entirely from the UI.
   */
  apiKeys: {},
  /** Additional keys used for automatic provider failover. */
  apiKeyPools: {},
};

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/** Atomic write, so a crash mid-save cannot leave truncated JSON behind. */
async function writeJSONAtomic(path, data) {
  await ensureDir(join(path, ".."));
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, path);
}

async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Global configuration                                                */
/* ------------------------------------------------------------------ */

export async function loadConfig() {
  const stored = await readJSON(CONFIG_PATH, {});
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    customProviders: { ...DEFAULT_CONFIG.customProviders, ...(stored.customProviders || {}) },
    customModels: { ...DEFAULT_CONFIG.customModels, ...(stored.customModels || {}) },
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...(stored.apiKeys || {}) },
    apiKeyPools: { ...DEFAULT_CONFIG.apiKeyPools, ...(stored.apiKeyPools || {}) },
  };
}

/**
 * Resolve a provider's API key.
 *
 * The environment takes precedence over stored keys: an exported variable
 * should always beat whatever was saved earlier.
 */
export function resolveApiKey(providerId, envKey, config) {
  if (envKey && process.env[envKey]) return process.env[envKey];
  return config?.apiKeys?.[providerId] || null;
}

/** Save an API key for a provider. Pass null to remove it. */
export async function saveApiKey(providerId, key) {
  const config = await loadConfig();
  if (key) config.apiKeys[providerId] = key;
  else delete config.apiKeys[providerId];
  const saved = await saveConfig({ apiKeys: config.apiKeys });
  const verified = await loadConfig();
  if ((key && verified.apiKeys[providerId] !== key) || (!key && verified.apiKeys[providerId])) {
    throw new Error(`Could not verify saved API key in ${CONFIG_PATH}`);
  }
  return saved;
}

/** Manage a provider's ordered failover keys without exposing them in the UI. */
export async function saveApiKeyPool(providerId, keys) {
  const config = await loadConfig();
  const clean = [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key).trim()).filter(Boolean))];
  if (clean.length) config.apiKeyPools[providerId] = clean;
  else delete config.apiKeyPools[providerId];
  return saveConfig({ apiKeyPools: config.apiKeyPools });
}

/** Replace a provider's complete ordered key set in one atomic config save. */
export async function saveApiKeySet(providerId, keys) {
  const clean = [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key).trim()).filter(Boolean))];
  const config = await loadConfig();
  const apiKeys = { ...config.apiKeys };
  const apiKeyPools = { ...config.apiKeyPools };
  if (clean.length) apiKeys[providerId] = clean[0];
  else delete apiKeys[providerId];
  if (clean.length > 1) apiKeyPools[providerId] = clean.slice(1);
  else delete apiKeyPools[providerId];
  const saved = await saveConfig({ apiKeys, apiKeyPools });
  // Read-after-write check so callers never report success for an incomplete save.
  const verified = await loadConfig();
  const actual = [verified.apiKeys[providerId], ...(verified.apiKeyPools[providerId] || [])].filter(Boolean);
  if (actual.length !== clean.length || actual.some((key, index) => key !== clean[index])) {
    throw new Error(`Could not verify saved API keys in ${CONFIG_PATH}`);
  }
  return saved;
}

/**
 * Serialises config writes.
 *
 * Every save is read-modify-write. Without a queue, two overlapping saves
 * both read the same snapshot and the second silently discards the first —
 * which is how a freshly added custom provider can vanish when the UI
 * persists preferences at the same moment.
 */
let configQueue = Promise.resolve();

export function saveConfig(patch) {
  configQueue = configQueue.then(async () => {
    const current = await loadConfig();
    const next = { ...current, ...patch };
    await writeJSONAtomic(CONFIG_PATH, next);
    return next;
  });
  return configQueue;
}

/** Add or replace a custom provider definition. */
export async function saveCustomProvider(id, definition) {
  const config = await loadConfig();
  config.customProviders[id] = definition;
  return saveConfig({ customProviders: config.customProviders });
}

export async function removeCustomProvider(id) {
  const config = await loadConfig();
  delete config.customProviders[id];
  return saveConfig({ customProviders: config.customProviders });
}

/** Append a model to a provider's list, avoiding duplicates. */
export async function addCustomModel(providerId, model) {
  const config = await loadConfig();
  const list = config.customModels[providerId] || [];
  if (!list.some((m) => m.id === model.id)) list.push(model);
  config.customModels[providerId] = list;
  return saveConfig({ customModels: config.customModels });
}

export async function removeCustomModel(providerId, modelId) {
  const config = await loadConfig();
  config.customModels[providerId] = (config.customModels[providerId] || []).filter(
    (m) => m.id !== modelId,
  );
  return saveConfig({ customModels: config.customModels });
}

/* ------------------------------------------------------------------ */
/* MCP configuration                                                   */
/* ------------------------------------------------------------------ */

export async function loadMCPServers() {
  const raw = await readJSON(MCP_PATH, {});
  return raw.mcpServers || raw.servers || {};
}

export async function saveMCPServer(name, definition) {
  const servers = await loadMCPServers();
  servers[name] = definition;
  await writeJSONAtomic(MCP_PATH, { mcpServers: servers });
  return servers;
}

export async function removeMCPServer(name) {
  const servers = await loadMCPServers();
  delete servers[name];
  await writeJSONAtomic(MCP_PATH, { mcpServers: servers });
  return servers;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

/** Stable identifier derived from the working directory. */
export function projectKey(cwd) {
  return createHash("sha256").update(String(cwd)).digest("hex").slice(0, 12);
}

export function newSessionId(cwd) {
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${projectKey(cwd)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Persist a session. Called frequently, so failures are swallowed:
 * a disk error must never take down the conversation.
 */
export async function saveSession(session) {
  try {
    await ensureDir(SESSIONS_DIR);
    await writeJSONAtomic(join(SESSIONS_DIR, `${session.id}.json`), {
      ...session,
      updatedAt: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadSession(id) {
  return readJSON(join(SESSIONS_DIR, `${id}.json`), null);
}

/** List sessions newest first, optionally scoped to one project. */
export async function listSessions({ cwd, limit = 30 } = {}) {
  try {
    const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json"));
    const key = cwd ? projectKey(cwd) : null;

    const sessions = [];
    for (const file of files) {
      const data = await readJSON(join(SESSIONS_DIR, file), null);
      if (!data?.id) continue;
      if (key && data.projectKey !== key) continue;
      sessions.push({
        id: data.id,
        cwd: data.cwd,
        title: data.title || firstLine(data.messages),
        updatedAt: data.updatedAt || 0,
        messageCount: data.messages?.length || 0,
        provider: data.provider,
        model: data.model,
      });
    }

    return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  } catch {
    return [];
  }
}

/** Most recent session for a directory, used by `--continue`. */
export async function latestSession(cwd) {
  const [first] = await listSessions({ cwd, limit: 1 });
  return first ? loadSession(first.id) : null;
}

export async function deleteSession(id) {
  try {
    await unlink(join(SESSIONS_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Delete the oldest sessions beyond the configured cap. */
export async function pruneSessions(max = DEFAULT_CONFIG.maxSessions) {
  const all = await listSessions({ limit: Number.MAX_SAFE_INTEGER });
  const excess = all.slice(max);
  for (const s of excess) await deleteSession(s.id);
  return excess.length;
}

function firstLine(messages) {
  const first = (messages || []).find((m) => m.role === "user");
  if (!first) return "(empty)";
  const text = typeof first.content === "string" ? first.content : "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean || "(empty)";
}

/**
 * A live conversation. Accumulates state and persists it on a debounce so
 * we are not writing to disk on every keystroke.
 */
export class Session {
  constructor({ id, cwd, provider, model } = {}) {
    this.id = id || newSessionId(cwd || process.cwd());
    this.cwd = cwd || process.cwd();
    this.projectKey = projectKey(this.cwd);
    this.provider = provider || null;
    this.model = model || null;
    this.messages = [];
    this.summary = null;
    this.title = null;
    this.createdAt = Date.now();
    this.usage = { input: 0, output: 0, turns: 0, toolCalls: 0 };
    this.compactions = 0;
    this._timer = null;
  }

  static fromJSON(data) {
    const s = new Session({
      id: data.id,
      cwd: data.cwd,
      provider: data.provider,
      model: data.model,
    });
    s.messages = data.messages || [];
    s.summary = data.summary || null;
    s.title = data.title || null;
    s.createdAt = data.createdAt || Date.now();
    s.usage = data.usage || s.usage;
    s.compactions = data.compactions || 0;
    return s;
  }

  toJSON() {
    return {
      id: this.id,
      cwd: this.cwd,
      projectKey: this.projectKey,
      provider: this.provider,
      model: this.model,
      messages: this.messages,
      summary: this.summary,
      title: this.title,
      createdAt: this.createdAt,
      usage: this.usage,
      compactions: this.compactions,
    };
  }

  /** Persist at most once per `delay` ms. */
  scheduleSave(delay = 1500) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      saveSession(this.toJSON());
    }, delay);
    this._timer.unref?.();
  }

  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return saveSession(this.toJSON());
  }
}
