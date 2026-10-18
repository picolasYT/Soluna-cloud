import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "soluna-progress-"));
process.env.SOLUNA_HOME = join(root, "config");
const { startWebServer } = await import("../src/web/server.js");
const { saveCustomProvider } = await import("../src/core/session-store.js");

test("a provider quota after a file write preserves progress across session reload and continuation", async (t) => {
  const calls = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const bytes of req) body += bytes;
    calls.push(JSON.parse(body));
    if (calls.length === 2) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "openrouter_free_tier_daily quota exhausted" } }));
    }
    const delta = calls.length === 1 ? { tool_calls: [{ index: 0, id: "write-html", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "gatos.html", content: "<h1>Gatos</h1>" }) } }] } : { content: "Continué desde el archivo guardado." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  await saveCustomProvider("test", { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: "test" }] });
  const instance = await startWebServer({ cwd: root, host: "127.0.0.1", port: 0, noMcp: true, initialProvider: "test", initialModel: "test" });
  t.after(async () => { await instance.close(); await new Promise((resolve) => provider.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const exported = async () => (await fetch(base + "/api/sessions/export")).json();
  await post("/api/message", { text: "Creá la página" });
  await instance.jobs.waitIdle();
  assert.equal(calls.length, 2);
  assert.equal(await readFile(join(root, "gatos.html"), "utf8"), "<h1>Gatos</h1>");
  const saved = await exported();
  assert.equal(saved.messages.at(-1).role, "tool");
  assert.equal(saved.messages.at(-1).tool_call_id, "write-html");
  assert.equal((await post("/api/sessions/load", { id: saved.id })).status, 200);
  await post("/api/message", { text: "Continuá" });
  await instance.jobs.waitIdle();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].messages.filter((message) => message.role === "tool").length, 1);
  assert.equal((await exported()).messages.at(-1).content, "Continué desde el archivo guardado.");
});
