import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(join(tmpdir(), "soluna-followup-"));
process.env.SOLUNA_HOME = join(root, "config");
const { startWebServer } = await import("../src/web/server.js");
const { saveCustomProvider } = await import("../src/core/session-store.js");

test("browser receives idle after every reply and can continue and start a new chat without a restart", async (t) => {
  const histories = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    histories.push(JSON.parse(body).messages);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `Respuesta ${histories.length}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  await saveCustomProvider("test", { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: "test" }] });
  const instance = await startWebServer({ cwd: root, host: "127.0.0.1", port: 0, noMcp: true, initialProvider: "test", initialModel: "test" });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await instance.close();
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const events = [];
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) throw error; });
  t.after(() => pump);
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (let turn = 1; turn <= 3; turn++) {
    if (turn === 3) assert.equal((await post("/api/sessions/new", {})).status, 200);
    const start = events.length;
    assert.equal((await post("/api/message", { text: `Mensaje ${turn}` })).status, 200);
    await instance.jobs.waitIdle();
    for (let attempt = 0; attempt < 100; attempt++) {
      const reply = events.findIndex((event, index) => index >= start && event.kind === "stream-end" && event.text === `Respuesta ${turn}`);
      if (reply >= 0 && events.slice(reply + 1).some((event) => event.kind === "state" && event.busy === false)) break;
      await delay(10);
    }
    const reply = events.findIndex((event, index) => index >= start && event.kind === "stream-end" && event.text === `Respuesta ${turn}`);
    assert.ok(reply >= 0, `Reply ${turn} must reach the browser`);
    const lastState = events.slice(reply + 1).filter((event) => event.kind === "state").at(-1);
    assert.equal(lastState?.busy, false, "Send button must be re-enabled after the reply");
    assert.equal(lastState.currentRunId, null);
  }
  assert.equal(histories.length, 3);
  assert.deepEqual(histories[1].filter((message) => message.role === "user").map((message) => message.content), ["Mensaje 1", "Mensaje 2"]);
  assert.deepEqual(histories[2].filter((message) => message.role === "user").map((message) => message.content), ["Mensaje 3"]);
});
