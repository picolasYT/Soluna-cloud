import test from "node:test";
import assert from "node:assert/strict";
import { parseSSE, createStreamAccumulator } from "../src/providers/stream-utils.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { isRetryable } from "../src/core/retry.js";

const chunk = (content, finish_reason = "stop") => ({ choices: [{ delta: { content }, finish_reason }] });
const sse = (data) => new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const json = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function mockFetch(t, handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = previous; });
}
const provider = () => new OpenAICompatibleProvider({ id: "openrouter", label: "OpenRouter", baseUrl: "https://example.test/v1", apiKey: "test-key", requiresKey: true });

test("SSE parser preserves the final event without a newline and split UTF-8", async () => {
  const bytes = new TextEncoder().encode(`: comment\r\ndata: ${JSON.stringify(chunk("¡Hola! 👋"))}`);
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }));
  const acc = createStreamAccumulator({});
  for await (const event of parseSSE(response)) acc.push(event);
  assert.equal(acc.result().content, "¡Hola! 👋");
});

test("SSE supports multiline JSON and stops on DONE", async () => {
  const response = new Response('data: {"choices":\ndata: [{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\ndata: {"bad":true}\n\n');
  const events = [];
  for await (const event of parseSSE(response)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].choices[0].delta.content, "ok");
});

test("OpenRouter HTTP 200 stream errors retain the real error code", async (t) => {
  let requests = 0;
  mockFetch(t, async () => { requests++; return sse({ error: { code: 401, message: "Invalid API key" }, choices: [] }); });
  await assert.rejects(provider().stream({ messages: [] }), (error) => {
    assert.match(error.message, /401.*Invalid API key/);
    assert.equal(isRetryable(error), false);
    return true;
  });
  assert.equal(requests, 1);
});

test("OpenRouter empty stream falls back once to JSON and emits visible text", async (t) => {
  const calls = [];
  const text = [];
  mockFetch(t, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length === 1 ? sse({ ...chunk(""), usage: { prompt_tokens: 2, completion_tokens: 1 } }) : json({ choices: [{ message: { content: "¡Hola!" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  });
  const p = provider();
  const options = { messages: [{ role: "user", content: "Hola" }], model: "same-model", onTextDelta: (delta, full) => text.push(full) };
  const result = await p.stream(options);
  assert.equal(result.content, "¡Hola!");
  assert.deepEqual(text, ["¡Hola!"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stream, true);
  assert.equal(calls[1].stream, undefined);
  assert.equal(calls[1].model, calls[0].model);
  assert.deepEqual(calls[1].messages, calls[0].messages);
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 5 });
  await p.stream(options);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].stream, undefined);
});

test("JSON returned to a stream request is read without generating twice", async (t) => {
  let requests = 0;
  mockFetch(t, async () => { requests++; return json({ choices: [{ message: { content: "JSON answer" } }] }); });
  assert.equal((await provider().stream({ messages: [] })).content, "JSON answer");
  assert.equal(requests, 1);
});

test("HTTP 200 JSON errors propagate rather than becoming empty responses", async (t) => {
  mockFetch(t, async () => json({ error: { code: 402, message: "Insufficient credits" } }));
  await assert.rejects(provider().chat({ messages: [] }), /402.*Insufficient credits/);
});

test("reasoning exhausting the output budget fails clearly without repeating requests", async (t) => {
  let requests = 0;
  mockFetch(t, async () => { requests++; return sse({ choices: [{ delta: { reasoning: "hidden" }, finish_reason: "length" }] }); });
  await assert.rejects(provider().stream({ messages: [] }), (error) => {
    assert.match(error.message, /límite de generación/);
    assert.equal(isRetryable(error), false);
    assert.ok(!error.message.includes("hidden"));
    return true;
  });
  assert.equal(requests, 1);
});

test("tool-only stream never generates a second completion", async (t) => {
  let requests = 0;
  mockFetch(t, async () => { requests++; return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "ls", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }); });
  const result = await provider().stream({ messages: [] });
  assert.equal(result.tool_calls[0].function.name, "ls");
  assert.equal(requests, 1);
});
