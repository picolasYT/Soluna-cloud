import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "soluna-keys-"));
process.env.SOLUNA_HOME = join(root, "config");
const { startWebServer } = await import("../src/web/server.js");
const { loadConfig } = await import("../src/core/session-store.js");

test("multiple keys can be added and removed per provider without exposing credentials", async (t) => {
  const options = { cwd: root, host: "127.0.0.1", port: 0, noMcp: true, token: "test-access" };
  let instance = await startWebServer(options);
  t.after(async () => { await instance.close(); await rm(root, { recursive: true, force: true }); });
  let base = `http://127.0.0.1:${instance.server.address().port}`;
  const headers = { Authorization: "Bearer test-access", "Content-Type": "application/json" };
  const get = async (path) => (await fetch(base + path, { headers })).json();
  const mutate = (method, body) => fetch(base + "/api/keys", { method, headers, body: JSON.stringify(body) });
  for (const method of ["GET", "POST", "DELETE"]) {
    assert.equal((await fetch(base + "/api/keys?provider=openrouter", { method, ...(method !== "GET" ? { body: "{}" } : {}) })).status, 401);
  }
  assert.equal((await fetch(base + "/api/keys?provider=unknown", { headers })).status, 400);
  const first = "test-primary-1234";
  const second = "test-backup-5678";
  const added = await mutate("POST", { provider: "openrouter", keys: [first, second, first] });
  assert.equal(added.status, 200);
  const metadata = await added.json();
  assert.equal(metadata.keys.length, 2);
  assert.equal(metadata.keys[0].masked, "•••• 1234");
  assert.ok(!JSON.stringify(metadata).includes(first));
  assert.ok(!JSON.stringify(metadata).includes(second));
  const legacy = await fetch(base + "/api/save-key", { method: "POST", headers, body: JSON.stringify({ provider: "openrouter", key: "third-key-1111" }) });
  assert.equal(legacy.status, 200);
  await Promise.all([
    mutate("POST", { provider: "openrouter", keys: ["concurrent-a-2222"] }),
    mutate("POST", { provider: "openrouter", keys: ["concurrent-b-3333"] }),
  ]);
  assert.equal((await get("/api/keys?provider=openrouter")).keys.length, 5);
  assert.equal((await mutate("POST", { provider: "groq", keys: ["groq-only-4444"] })).status, 200);
  const catalog = await get("/api/config");
  assert.equal(catalog.providers.find((provider) => provider.id === "openrouter").keyCount, 5);
  assert.ok(!JSON.stringify(catalog).includes(first));
  assert.ok(!JSON.stringify(catalog).includes("groq-only-4444"));
  assert.equal((await mutate("DELETE", { provider: "openrouter", id: metadata.keys[0].id })).status, 200);
  const cfg = await loadConfig();
  assert.equal(cfg.apiKeys.openrouter, second);
  assert.equal(cfg.apiKeyPools.openrouter.length, 3);
  assert.equal(cfg.apiKeys.groq, "groq-only-4444");
  assert.equal((await mutate("DELETE", { provider: "groq", id: metadata.keys[1].id })).status, 404);
  assert.equal((await mutate("POST", { provider: "groq", keys: [] })).status, 400);
  assert.equal((await mutate("POST", { provider: "groq", keys: ["invalid key"] })).status, 400);

  await instance.close();
  instance = await startWebServer(options);
  base = `http://127.0.0.1:${instance.server.address().port}`;
  const restored = await get("/api/keys?provider=openrouter");
  assert.equal(restored.keys.length, 4);
  for (const key of restored.keys) assert.equal((await mutate("DELETE", { provider: "openrouter", id: key.id })).status, 200);
  assert.equal((await get("/api/keys?provider=openrouter")).keys.length, 0);
  assert.equal((await loadConfig()).apiKeyPools.openrouter, undefined);
  assert.equal((await get("/api/keys?provider=groq")).keys.length, 1);
  const environment = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "server-only-9999";
  t.after(() => { if (environment === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = environment; });
  const serverKeys = await get("/api/keys?provider=groq");
  assert.equal(serverKeys.environmentKey, true);
  assert.equal(serverKeys.count, 2);
  assert.equal(serverKeys.keys.length, 1);
  assert.ok(!JSON.stringify(serverKeys).includes("server-only-9999"));
});
