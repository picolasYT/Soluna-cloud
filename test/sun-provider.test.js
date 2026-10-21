import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, detectProvider } from '../src/providers/index.js';
import { getProviderInfo, isProviderReady } from '../src/providers/catalog.js';
import { fetchSunModels, getSunModels, SUN_MODELS_URL } from '../src/providers/sun-models.js';

const tools = [{ type: 'function', function: { name: 'write', parameters: { type: 'object' } } }];
const metadata = { models: [
  { id: 'coding', name: 'Coding', capabilities: { tools: true }, contextWindow: 128000, available: true },
  { id: 'chat', name: 'Chat', aliases: ['chat-alias'], capabilities: { tools: false }, available: true },
  { id: 'unknown', name: 'Unknown', capabilities: {}, available: true },
  { id: 'offline', name: 'Offline', available: false },
] };
function mockFetch(t, handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = previous; });
}

test('Sun is available from saved keys or SUN_API_KEY and has a coding default', (t) => {
  const info = getProviderInfo('sun');
  assert.equal(info.baseUrl, 'https://sun.soymaycol.icu/v1');
  assert.equal(info.dynamic, true);
  assert.equal(info.models[0].tools, true);
  assert.equal(isProviderReady('sun', undefined, { apiKeys: { sun: 'sun_live_test_saved_1234' } }), true);
  const previous = Object.fromEntries(['SUN_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'].map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  for (const name of Object.keys(previous)) delete process.env[name];
  process.env.SUN_API_KEY = 'sun_live_test_environment_1234';
  assert.equal(detectProvider(), 'sun');
  assert.equal(createProvider('sun').apiKey, process.env.SUN_API_KEY);
});

test('Sun discovers all models without credentials and preserves known and unknown capabilities', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, SUN_MODELS_URL);
    assert.equal(options.headers.Authorization, undefined);
    calls++;
    return Response.json({ models: [...metadata.models, metadata.models[0], { id: '' }, null, ...Array.from({ length: 70 }, (_, i) => ({ id: `extra-${i}` }))] });
  };
  const [first, second] = await Promise.all([getSunModels(fetchImpl), getSunModels(fetchImpl)]);
  assert.equal(calls, 1);
  assert.equal(first.length, 74);
  assert.deepEqual(first, second);
  assert.equal(first.find((m) => m.id === 'chat').tools, false);
  assert.equal(first.find((m) => m.id === 'unknown').tools, null);
  assert.equal(first.find((m) => m.id === 'offline').available, false);
  assert.equal(first.find((m) => m.id === 'coding').contextLength, 128000);
  assert.ok(first.every((m) => m.free !== true));
  await getSunModels(fetchImpl);
  assert.equal(calls, 1);
  await getSunModels(fetchImpl, { refresh: true });
  assert.equal(calls, 2);
  await assert.rejects(fetchSunModels(async () => Response.json({ data: [] })), /inválida/);
  await assert.rejects(fetchSunModels(async () => new Response('upstream', { status: 503 })), /Sun respondió 503/);
});

test('Sun tool completions keep Bearer auth, tool arguments and backup-key failover', async (t) => {
  const requests = [];
  mockFetch(t, async (url, options) => {
    if (url === SUN_MODELS_URL) return Response.json(metadata);
    assert.equal(url, 'https://sun.soymaycol.icu/v1/chat/completions');
    requests.push(options);
    if (requests.length === 1) return new Response('key limited', { status: 429 });
    return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write', arguments: '{"path":"index.html"}' } }] }, finish_reason: 'tool_calls' }] });
  });
  const provider = createProvider('sun', { apiKey: 'sun_live_test_primary_1234', apiKeys: ['sun_live_test_backup_5678'] });
  provider.keyIndex = 0;
  const result = await provider.stream({ messages: [{ role: 'user', content: 'Crear archivo' }], model: 'coding', tools });
  assert.deepEqual(requests.map((r) => r.headers.Authorization), ['Bearer sun_live_test_primary_1234', 'Bearer sun_live_test_backup_5678']);
  assert.equal(requests[0].body, requests[1].body);
  const sent = JSON.parse(requests[1].body);
  assert.deepEqual(sent.tools, tools);
  assert.equal(sent.stream, undefined);
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].function.arguments, '{"path":"index.html"}');
});

test('Sun chat-only models omit unsupported tools and still stream visible text', async (t) => {
  mockFetch(t, async (url, options) => {
    if (url === SUN_MODELS_URL) return Response.json(metadata);
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, 'chat-alias');
    assert.equal(sent.tools, undefined);
    assert.equal(sent.stream, true);
    return new Response('data: {"choices":[{"delta":{"content":"Hola"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const output = [];
  const result = await createProvider('sun', { apiKey: 'sun_live_test_only_chat_1234' }).stream({ messages: [{ role: 'user', content: 'Hola' }], model: 'chat-alias', tools, onTextDelta: (text) => output.push(text) });
  assert.equal(result.content, 'Hola');
  assert.deepEqual(output, ['Hola']);
});

test('catalog failures do not suppress unknown tools and cancellation prevents generation', async (t) => {
  let completions = 0;
  mockFetch(t, async (url, options) => {
    if (url === SUN_MODELS_URL) return new Response('', { status: 503 });
    completions++;
    assert.deepEqual(JSON.parse(options.body).tools, tools);
    return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
  });
  const provider = createProvider('sun', { apiKey: 'sun_live_test_no_catalog_1234' });
  await provider.stream({ model: 'unknown', messages: [], tools });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.stream({ model: 'coding', messages: [], tools, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(completions, 1);
});
