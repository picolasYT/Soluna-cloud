import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "soluna-overload-"));
process.env.SOLUNA_HOME = join(root, "config");
const { startWebServer } = await import("../src/web/server.js");
const { saveCustomProvider } = await import("../src/core/session-store.js");

test("503 overload leaves a retryable message and the next turn works without duplicated context", async (t) => {
  const calls = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw));
    if (calls.length <= 3) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Upstream error from Nvidia: Service temporarily overloaded" } }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"Respuesta recuperada"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
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
  const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
  const events = [];
  const pump = (async () => {
    let buffer = "";
    for await (const bytes of stream.body) {
      buffer += new TextDecoder().decode(bytes);
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) throw error; });
  t.after(() => pump);
  const send = (text) => fetch(`${base}/api/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });

  assert.equal((await send("Primer intento")).status, 200);
  await instance.jobs.waitIdle();
  assert.equal(calls.length, 3);
  const errors = events.filter((event) => event.kind === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /saturado temporalmente/);
  assert.equal(errors[0].retryable, true);
  const exportData = async () => (await fetch(`${base}/api/sessions/export`)).json();
  assert.deepEqual((await exportData()).messages, []);

  assert.equal((await send("Segundo intento")).status, 200);
  await instance.jobs.waitIdle();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].messages.filter((message) => message.role === "user").map((message) => message.content), ["Segundo intento"]);
  assert.equal((await exportData()).messages.at(-1).content, "Respuesta recuperada");
});
