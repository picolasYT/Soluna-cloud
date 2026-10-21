import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "soluna-chat-delete-"));
process.env.SOLUNA_HOME = join(root, "data");
const { startWebServer } = await import("../src/web/server.js");
const { Session, saveSession, loadSession, deleteSession } = await import("../src/core/session-store.js");

test("deleted chats stay deleted while project files and other workspaces are preserved", async (t) => {
  const options = { cwd: root, cleanWorkspace: true, host: "127.0.0.1", port: 0, noMcp: true, token: "chat-delete-test" };
  let app = await startWebServer(options);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: "Bearer chat-delete-test", "Content-Type": "application/json" };
  const get = (path) => fetch(base + path, { headers }).then((r) => r.json());
  const post = (path, body = {}) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });

  assert.equal((await fetch(base + "/api/sessions/delete", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await post("/api/sessions/delete", { id: "../outside" })).status, 400);
  await saveSession({ id: "foreign-chat", cwd: join(root, "foreign"), messages: [] });
  assert.equal((await post("/api/sessions/delete", { id: "foreign-chat" })).status, 404);
  assert.ok(await loadSession("foreign-chat"));

  const first = await get("/api/sessions/export");
  assert.equal((await get("/api/state")).sessionId, first.id);
  await writeFile(join(first.cwd, "index.html"), "<h1>Mi proyecto</h1>");
  assert.equal((await post("/api/sessions/new")).status, 200);
  const second = await get("/api/sessions/export");
  assert.equal((await post("/api/sessions/load", { id: first.id })).status, 200);
  assert.equal((await post("/api/sessions/delete", { id: first.id })).status, 409);

  // This is the UI flow for deleting the currently open chat.
  assert.equal((await post("/api/sessions/new")).status, 200);
  const replacement = await get("/api/state");
  assert.notEqual(replacement.sessionId, first.id);
  assert.equal((await post("/api/sessions/delete", { id: first.id })).status, 200);
  assert.equal((await post("/api/sessions/delete", { id: second.id })).status, 200);
  assert.equal(await readFile(join(first.cwd, "index.html"), "utf8"), "<h1>Mi proyecto</h1>");
  assert.equal((await post("/api/sessions/load", { id: first.id })).status, 404);
  assert.ok(!(await get("/api/sessions")).some((s) => [first.id, second.id].includes(s.id)));

  await app.close();
  app = await startWebServer(options);
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.ok(!(await get("/api/sessions")).some((s) => [first.id, second.id].includes(s.id)));
  assert.equal(await readFile(join(first.cwd, "index.html"), "utf8"), "<h1>Mi proyecto</h1>");
});

test("flushing before deletion cancels delayed saves so history does not reappear", async (t) => {
  const session = new Session({ cwd: root });
  session.messages.push({ role: "user", content: "Una conversación" });
  session.scheduleSave(10);
  await session.flush();
  assert.ok(await loadSession(session.id));
  assert.equal(await deleteSession(session.id), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await loadSession(session.id), null);
  t.after(() => rm(root, { recursive: true, force: true }));
});
