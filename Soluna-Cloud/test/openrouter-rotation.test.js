import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createProvider } from "../src/providers/index.js";

test("OpenRouter falls through exhausted keys without changing model or payload", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push({ key: options.headers.Authorization, body: JSON.parse(options.body) });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), {
        status: 402, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleProvider({
    id: "openrouter", label: "OpenRouter", baseUrl: "https://example.test/api/v1",
    apiKey: "first", apiKeys: ["second"], requiresKey: true,
  });
  const result = await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "vendor/model-x" });

  assert.equal(result.content, "ok");
  assert.deepEqual(calls.map((call) => call.key), ["Bearer first", "Bearer second"]);
  assert.deepEqual(calls.map((call) => call.body.model), ["vendor/model-x", "vendor/model-x"]);
  assert.deepEqual(calls[0].body.messages, calls[1].body.messages);
});

test("OpenRouter rotates keys on the free-model daily 429 and reports the switch", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const rotations = [];
  globalThis.fetch = async (_url, options) => {
    calls.push({ key: options.headers.Authorization, body: JSON.parse(options.body) });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: "Rate limit exceeded: free-models-per-day",
          metadata: { limit_source: "openrouter_free_tier_daily" },
        },
      }), { status: 429, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleProvider({
    id: "openrouter", baseUrl: "https://example.test/api/v1", apiKey: "first",
    apiKeys: ["second"], requiresKey: true, onKeyRotation: (event) => rotations.push(event),
  });
  provider.keyIndex = 0;
  const result = await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "vendor/free-model" });

  assert.equal(result.content, "ok");
  assert.deepEqual(calls.map((call) => call.key), ["Bearer first", "Bearer second"]);
  assert.deepEqual(calls.map((call) => call.body.model), ["vendor/free-model", "vendor/free-model"]);
  assert.deepEqual(rotations, [{ failedKey: 1, nextKey: 2, keyCount: 2, status: 429 }]);
});

test("OpenRouter explains when all configured keys share an exhausted free daily quota", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: "Rate limit exceeded: free-models-per-day",
      metadata: { limit_source: "openrouter_free_tier_daily" },
    },
  }), { status: 429, headers: { "Content-Type": "application/json" } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleProvider({
    id: "openrouter", baseUrl: "https://example.test/api/v1", apiKey: "first",
    apiKeys: ["second"], requiresKey: true,
  });
  await assert.rejects(
    provider.chat({ messages: [], model: "vendor/free-model" }),
    /tried 2 configured key\(s\).*quota is shared by the OpenRouter account/i,
  );
});

test("OpenRouter does not rotate keys for unrelated errors", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options.headers.Authorization);
    return new Response("invalid model", { status: 400 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleProvider({
    id: "openrouter", baseUrl: "https://example.test/api/v1", apiKey: "first",
    apiKeys: ["second"], requiresKey: true,
  });
  await assert.rejects(provider.chat({ messages: [], model: "missing" }), /400/);
  assert.equal(calls.length, 1);
  assert.ok(["Bearer first", "Bearer second"].includes(calls[0]));
});

test("createProvider uses a saved OpenRouter key when no environment key exists", (t) => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  const provider = createProvider("openrouter", {
    config: { apiKeys: { openrouter: "saved-key" }, apiKeyPools: { openrouter: ["backup-key"] } },
  });
  assert.equal(provider.apiKey, "saved-key");
  assert.deepEqual(provider.apiKeys, ["saved-key", "backup-key"]);
});

test("OpenRouter model discovery loads the full public catalog without a bearer key", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  let request;
  const data = Array.from({ length: 400 }, (_, i) => ({ id: `vendor/model-${i}`, name: `Model ${i}` }));
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  const provider = createProvider("openrouter", { allowNoKey: true, config: {} });
  const models = await provider.listModels();

  assert.equal(models.length, 400);
  assert.equal(models[0].id, "vendor/model-0");
  assert.equal(models[399].id, "vendor/model-399");
  assert.equal(request.url, "https://openrouter.ai/api/v1/models");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, undefined);
});
