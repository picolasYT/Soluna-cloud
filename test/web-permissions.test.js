import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(join(tmpdir(), "soluna-permission-"));
process.env.SOLUNA_HOME = join(root, "config");
const { startWebServer } = await import("../src/web/server.js");
const { saveCustomProvider } = await import("../src/core/session-store.js");

test("browser approvals gate actual commands, survive reconnects and cancel cleanly", async (t) => {
  let tool = null;
  const provider = createServer(async (req, res) => {
    for await (const chunk of req) { /* drain request */ }
    const delta = tool ? { tool_calls: [{ index: 0, id: `tool-${Date.now()}`, type: "function", function: { name: "bash", arguments: JSON.stringify(tool) } }] } : { content: "Terminado" };
    tool = null;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  await saveCustomProvider("test", { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: "test-model" }] });
  const instance = await startWebServer({ cwd: root, host: "127.0.0.1", port: 0, noMcp: true, initialProvider: "test", initialModel: "test-model", token: "secret" });
  t.after(async () => {
    await instance.close();
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const headers = { Authorization: "Bearer secret", "Content-Type": "application/json" };
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const state = async () => (await fetch(`${base}/api/state`, { headers })).json();
  const pending = async () => {
    for (let i = 0; i < 200; i++) {
      const s = await state();
      if (s.askRequest) return s;
      await delay(20);
    }
    assert.fail("Expected pending browser approval");
  };
  const answer = (request, label) => ({ id: request.id, answers: [{ answers: [label] }] });

  await t.test("waits until approved once and validates authentication and decision ID", async () => {
    tool = { command: "printf approved > allowed.txt", permission: "ask" };
    assert.equal((await post("/api/message", { text: "Ejecutar" })).status, 200);
    const s = await pending();
    assert.equal(s.busy, true);
    assert.match(s.askRequest.questions[0].question, /printf approved/);
    await assert.rejects(access(join(root, "allowed.txt")));
    const body = answer(s.askRequest, "Permitir una vez");
    assert.equal((await fetch(`${base}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 401);
    assert.equal((await post("/api/ask", { ...body, id: "stale-id" })).status, 409);
    assert.equal((await post("/api/ask", answer(s.askRequest, "unknown"))).status, 400);

    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, { headers, signal: abort.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let transcript = "";
    while (!transcript.includes('"kind":"state"')) transcript += decoder.decode((await reader.read()).value);
    abort.abort();
    assert.match(transcript, /Permitir acción/);
    assert.match(transcript, new RegExp(s.askRequest.id));
    assert.equal((await post("/api/ask", body)).status, 200);
    await instance.jobs.waitIdle();
    assert.equal(await readFile(join(root, "allowed.txt"), "utf8"), "approved");
    assert.equal((await post("/api/ask", body)).status, 409);
    assert.equal((await state()).askRequest, null);
  });

  await t.test("denial prevents execution", async () => {
    tool = { command: "printf denied > denied.txt", permission: "ask" };
    await post("/api/message", { text: "Rechazar" });
    const s = await pending();
    assert.equal((await post("/api/ask", answer(s.askRequest, "Rechazar"))).status, 200);
    await instance.jobs.waitIdle();
    await assert.rejects(access(join(root, "denied.txt")));
  });

  await t.test("stop releases a waiting decision and returns the queue to idle", async () => {
    tool = { command: "printf cancelled > cancelled.txt", permission: "ask" };
    await post("/api/message", { text: "Cancelar" });
    const s = await pending();
    assert.equal((await post("/api/cancel", { id: s.currentRunId })).status, 200);
    await instance.jobs.waitIdle();
    await assert.rejects(access(join(root, "cancelled.txt")));
    const finished = await state();
    assert.equal(finished.busy, false);
    assert.equal(finished.askRequest, null);
  });
});
