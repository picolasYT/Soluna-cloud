import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createProvider } from "../src/providers/index.js";
import { withKeyFailover } from "../src/providers/key-failover.js";

test("compatible providers rotate on key failures without changing the request", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  for (const status of [401, 402, 429]) {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(options);
      return calls.length === 1 ? new Response("key unavailable", { status })
        : Response.json({ choices: [{ message: { content: "OK" } }] });
    };
    const provider = new OpenAICompatibleProvider({ id: `test-${status}`, baseUrl: "https://example.test", apiKey: "primary", apiKeys: ["backup"] });
    assert.equal((await provider.chat({ messages: [{ role: "user", content: "Hola" }], model: "same-model" })).content, "OK");
    assert.deepEqual(calls.map((call) => call.headers.Authorization), ["Bearer primary", "Bearer backup"]);
    assert.equal(calls[0].body, calls[1].body);
  }
});

test("OpenAI, Anthropic and Zen use their saved backup keys", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  for (const id of ["openai", "anthropic", "zen"]) {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(options);
      if (calls.length === 1) return new Response("Insufficient credits", { status: 402 });
      return Response.json(id === "anthropic" ? { content: [{ type: "text", text: "OK" }] } : { choices: [{ message: { content: "OK" } }] });
    };
    const provider = createProvider(id, { apiKey: "primary", apiKeys: ["backup"] });
    provider.keyIndex = 0;
    assert.equal((await provider.chat({ messages: [{ role: "user", content: "Hola" }], model: "same-model" })).content, "OK");
    const header = id === "anthropic" ? "x-api-key" : "Authorization";
    assert.deepEqual(calls.map((call) => call.headers[header]), id === "anthropic" ? ["primary", "backup"] : ["Bearer primary", "Bearer backup"]);
    assert.equal(calls[0].body, calls[1].body);
  }
});

test("a server key does not discard the user's saved primary and backup keys", (t) => {
  const previous = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "server-key";
  t.after(() => { if (previous === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous; });
  const provider = createProvider("groq", { config: { apiKeys: { groq: "saved-primary" }, apiKeyPools: { groq: ["saved-backup", "server-key"] } } });
  assert.deepEqual(provider.apiKeys, ["server-key", "saved-primary", "saved-backup"]);
});

test("dedicated failover never repeats output or tool execution after a stream starts", async () => {
  for (const callback of ["onTextDelta", "onToolDelta", "executeTool"]) {
    let calls = 0;
    let emitted = 0;
    const provider = withKeyFailover({ apiKey: "primary", stream: async (options) => {
      calls++;
      await options[callback]("partial");
      throw Object.assign(new Error("API error: 429 limited"), { status: 429 });
    } }, { id: `stream-${callback}`, keys: ["primary", "backup"] });
    await assert.rejects(provider.stream({ [callback]: () => { emitted++; } }), /429/);
    assert.equal(calls, 1);
    assert.equal(emitted, 1);
  }
});

test("dedicated adapters do not switch keys for malformed requests or cancellation", async () => {
  for (const message of ["API error: 400 invalid model", "aborted"]) {
    let calls = 0;
    const provider = withKeyFailover({ chat: async () => { calls++; throw new Error(message); } }, { id: message, keys: ["one", "two"] });
    await assert.rejects(provider.chat({}), new RegExp(message));
    assert.equal(calls, 1);
  }
});
