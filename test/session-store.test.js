import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
const ORIGINAL_SOLUNA_HOME = process.env.SOLUNA_HOME;
const ORIGINAL_ZYN_HOME = process.env.ZYN_HOME;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "zyn-store-"));
  process.env.SOLUNA_HOME = home;
});

after(async () => {
  if (ORIGINAL_SOLUNA_HOME === undefined) delete process.env.SOLUNA_HOME;
  else process.env.SOLUNA_HOME = ORIGINAL_SOLUNA_HOME;
  if (ORIGINAL_ZYN_HOME === undefined) delete process.env.ZYN_HOME;
  else process.env.ZYN_HOME = ORIGINAL_ZYN_HOME;
  await rm(home, { recursive: true, force: true });
});

test("SOLUNA_HOME is used verbatim as the config directory", async () => {
  // Re-import with the env var in place. Because ESM caches, we import the
  // module after setting the env in `before`; the value is computed at import.
  const { SOLUNA_HOME, ZYN_HOME, CONFIG_PATH, SESSIONS_DIR } = await import("../src/core/session-store.js");
  assert.equal(SOLUNA_HOME, home);
  assert.equal(ZYN_HOME, home);
  assert.equal(CONFIG_PATH, join(home, "config.json"));
  assert.equal(SESSIONS_DIR, join(home, "sessions"));
});

test("loadConfig returns defaults when nothing is saved", async () => {
  const { loadConfig } = await import("../src/core/session-store.js");
  const config = await loadConfig();
  assert.equal(config.theme, "soluna");
  assert.equal(typeof config.customProviders, "object");
});

test("saveConfig round-trips and merges", async () => {
  const { loadConfig, saveConfig } = await import("../src/core/session-store.js");
  await saveConfig({ theme: "monokai", custom: 1 });
  const loaded = await loadConfig();
  assert.equal(loaded.theme, "monokai");
  assert.equal(loaded.custom, 1);
  await saveConfig({ provider: "groq" });
  const merged = await loadConfig();
  assert.equal(merged.theme, "monokai");
  assert.equal(merged.provider, "groq");
});

test("saveApiKey and resolveApiKey with env precedence", async () => {
  const { saveApiKey, resolveApiKey, loadConfig } = await import("../src/core/session-store.js");
  await saveApiKey("groq", "stored-key");
  const config = await loadConfig();
  const stored = resolveApiKey("groq", "GROQ_API_KEY", config);
  assert.equal(stored, "stored-key");

  process.env.GROQ_API_KEY = "env-key";
  const viaEnv = resolveApiKey("groq", "GROQ_API_KEY", config);
  assert.equal(viaEnv, "env-key");
  delete process.env.GROQ_API_KEY;

  assert.equal(config.apiKeys.groq, "stored-key");
});

test("saveApiKeySet atomically persists, reloads, and replaces the ordered key pool", async () => {
  const { saveApiKeySet, loadConfig } = await import("../src/core/session-store.js");
  await saveApiKeySet("openrouter", ["test-key-a", "test-key-b", "test-key-c"]);
  let config = await loadConfig();
  assert.equal(config.apiKeys.openrouter, "test-key-a");
  assert.deepEqual(config.apiKeyPools.openrouter, ["test-key-b", "test-key-c"]);

  await saveApiKeySet("openrouter", ["replacement-key"]);
  config = await loadConfig();
  assert.equal(config.apiKeys.openrouter, "replacement-key");
  assert.equal(config.apiKeyPools.openrouter, undefined);
});

test("corrupted session file does not crash listSessions", async () => {
  const { SESSIONS_DIR, listSessions } = await import("../src/core/session-store.js");
  await mkdir(SESSIONS_DIR, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(SESSIONS_DIR, "corrupt.json"), "{ this is not json", "utf-8");
  const list = await listSessions({ limit: 10 });
  assert.ok(Array.isArray(list));
});

test("Session.flush persists immediately, bypassing the debounce", async () => {
  const { Session, SESSIONS_DIR } = await import("../src/core/session-store.js");
  const { readFile } = await import("node:fs/promises");
  const s = new Session({ cwd: home });
  s.messages = [{ role: "user", content: "hello" }];
  s.usage = { input: 10, output: 5, turns: 1, toolCalls: 0 };
  await s.flush();

  const file = join(SESSIONS_DIR, `${s.id}.json`);
  const raw = await readFile(file, "utf-8");
  const saved = JSON.parse(raw);
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].content, "hello");
  assert.equal(saved.usage.turns, 1);
});

test("Session.scheduleSave debounces rapid changes", async () => {
  const { Session, SESSIONS_DIR } = await import("../src/core/session-store.js");
  const { readdir } = await import("node:fs/promises");
  const s = new Session({ cwd: home });
  // Schedule several saves in rapid succession.
  s.scheduleSave();
  s.messages = [{ role: "a" }];
  s.scheduleSave();
  s.messages = [{ role: "b" }];
  s.scheduleSave();
  // Only the last one should land after the debounce.
  await new Promise((r) => setTimeout(r, 2000));
  const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json"));
  const ours = files.filter((f) => f.includes(s.id));
  assert.equal(ours.length, 1);
});
