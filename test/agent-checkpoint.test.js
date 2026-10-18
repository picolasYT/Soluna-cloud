import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../src/core/agent-loop.js";

test("a rate limit after tool execution preserves a complete checkpoint for continuation", async () => {
  let calls = 0;
  let executions = 0;
  let checkpoint;
  const toolCall = { id: "write-once", type: "function", function: { name: "write", arguments: '{"path":"gatos/index.html"}' } };
  const tools = [{ name: "write", description: "write", parameters: { type: "object", properties: {} }, execute: async () => { executions++; return { content: [{ type: "text", text: "Created gatos/index.html" }] }; } }];
  const provider = { chat: async () => {
    if (++calls === 1) return { content: "Creando página", tool_calls: [toolCall] };
    throw Object.assign(new Error("Provider API error 429: rate limited"), { status: 429 });
  } };
  await assert.rejects(runAgentLoop({ messages: [{ role: "user", content: "Creá una página" }], tools, provider, autoCompact: false, retries: 1, onCheckpoint: (value) => { checkpoint = value; } }), /429/);
  assert.equal(executions, 1);
  assert.equal(checkpoint.messages.at(-1).role, "tool");
  assert.equal(checkpoint.messages.at(-1).tool_call_id, "write-once");
  assert.match(checkpoint.messages.at(-1).content, /gatos\/index.html/);
  const continuation = { chat: async ({ messages }) => {
    assert.ok(messages.some((message) => message.role === "tool" && message.tool_call_id === "write-once"));
    return { content: "Terminado" };
  } };
  const result = await runAgentLoop({ messages: [...checkpoint.messages.filter((message) => message.role !== "system"), { role: "user", content: "Continuá" }], tools, provider: continuation, autoCompact: false });
  assert.equal(result.messages.at(-1).content, "Terminado");
  assert.equal(executions, 1);
});
