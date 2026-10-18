import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "soluna-clean-"));
process.env.SOLUNA_HOME = join(root, "data");
const { startWebServer } = await import("../src/web/server.js");
const { Workspace } = await import("../src/core/workspace.js");

test("clean chats isolate files, restore their own folder and survive a server restart", async (t) => {
  const app = join(root, "application");
  await mkdir(app);
  await writeFile(join(app, "server.js"), "application source");
  const options = { cwd: app, cleanWorkspace: true, host: "127.0.0.1", port: 0, noMcp: true };
  let instance = await startWebServer(options);
  t.after(async () => { await instance.close(); await rm(root, { recursive: true, force: true }); });
  let base = `http://127.0.0.1:${instance.server.address().port}`;
  const get = async (path) => (await fetch(base + path)).json();
  const post = (path, body = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const first = await get("/api/sessions/export");
  assert.notEqual(first.cwd, app);
  assert.deepEqual((await get("/api/files")).files, []);
  await writeFile(join(first.cwd, "gatos.html"), "<h1>Gatos</h1>");
  assert.equal((await get("/api/files")).files[0].path, "gatos.html");

  assert.equal((await post("/api/sessions/new")).status, 200);
  const second = await get("/api/sessions/export");
  assert.notEqual(second.cwd, first.cwd);
  assert.deepEqual((await get("/api/files")).files, []);
  assert.equal((await fetch(base + "/api/file?path=" + encodeURIComponent(join(first.cwd, "gatos.html")))).status, 404);
  assert.equal((await fetch(base + "/api/file?path=" + encodeURIComponent(join(app, "server.js")))).status, 404);

  const sandbox = new Workspace(first.cwd);
  sandbox.resetRoot(second.cwd);
  await assert.rejects(sandbox.resolvePath(join(first.cwd, "gatos.html")), /outside the workspace/);
  assert.ok((await get("/api/sessions")).some((item) => item.id === first.id));
  assert.equal((await post("/api/sessions/load", { id: first.id })).status, 200);
  assert.equal((await get("/api/files")).files[0].path, "gatos.html");
  assert.equal(await readFile(join(app, "server.js"), "utf8"), "application source");

  await instance.close();
  instance = await startWebServer(options);
  base = `http://127.0.0.1:${instance.server.address().port}`;
  assert.deepEqual((await get("/api/files")).files, []);
  assert.ok((await get("/api/sessions")).some((item) => item.id === first.id));
  assert.equal((await post("/api/sessions/load", { id: first.id })).status, 200);
  assert.equal((await get("/api/files")).files[0].path, "gatos.html");
});
