import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/core/workspace.js";
import { createReadTool } from "../src/core/tools/read.js";
import { createWriteTool } from "../src/core/tools/write.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { createBashTool } from "../src/core/tools/bash.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { createGlobTool } from "../src/core/tools/glob.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { runAgentLoop } from "../src/core/agent-loop.js";

let home, root;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "zyn-loop-"));
  process.env.ZYN_HOME = home;
  root = join(home, "proj");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "note.txt"), "the answer is 42\n");
  await writeFile(join(root, "AGENTS.md"), "Always greet with hello\n");
});

after(async () => {
  delete process.env.ZYN_HOME;
  await rm(home, { recursive: true, force: true });
});

function buildTools() {
  const ws = new Workspace(root);
  return {
    ws,
    tools: [
      createReadTool(ws),
      createWriteTool(ws),
      createEditTool(ws),
      createBashTool(ws, { confirm: null }),
      createLsTool(ws),
      createGlobTool(ws),
      createGrepTool(ws),
    ],
  };
}

test("agent loop runs a read tool then finishes", async () => {
  const { tools } = buildTools();
  let calls = 0;
  const provider = {
    sessionScopedTools: false,
    chat: async ({ messages }) => {
      calls++;
      if (calls === 1) {
        return {
          content: "Let me read the file.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        content: "Done: the note says 42.",
        tool_calls: [],
        usage: { input_tokens: 20, output_tokens: 10 },
      };
    },
  };

  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "read the note" }],
    tools,
    provider,
    model: "fake",
    cwd: root,
    onToolCall: (c) => events.push(["call", c.name]),
    onToolResult: (r) => events.push(["result", r.name]),
  });

  assert.equal(result.iterations, 2);
  assert.ok(events.some((e) => e[0] === "call" && e[1] === "read"));
  assert.ok(events.some((e) => e[0] === "result" && e[1] === "read"));
  // The tool result text must be in the conversation the model would see.
  const toolMessages = result.messages.filter((m) => m.role === "tool");
  assert.ok(toolMessages.some((m) => m.content.includes("the answer is 42")));
});

test("agent loop blocks a tool that escapes the workspace", async () => {
  const { tools } = buildTools();
  const provider = {
    chat: async () => ({
      content: "oops",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "write", arguments: JSON.stringify({ path: "../../escape.txt", content: "x" }) },
        },
      ],
    }),
  };
  const result = await runAgentLoop({ messages: [], tools, provider, model: "fake", cwd: root, maxIterations: 3 });
  const toolMessages = result.messages.filter((m) => m.role === "tool");
  assert.ok(toolMessages.some((m) => /outside the workspace/.test(m.content)));
});

test("unknown tool returns an error to the model", async () => {
  const { tools } = buildTools();
  const provider = {
    chat: async () => ({
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "nonexistent_tool", arguments: "{}" },
        },
      ],
    }),
  };
  const result = await runAgentLoop({ messages: [], tools, provider, model: "fake", cwd: root, maxIterations: 3 });
  const toolMessages = result.messages.filter((m) => m.role === "tool");
  assert.ok(toolMessages.some((m) => /not found/.test(m.content)));
});

test("AGENTS.md instructions are injected into the system prompt", async () => {
  const { tools } = buildTools();
  const provider = {
    chat: async ({ messages }) => {
      const system = messages.find((m) => m.role === "system");
      assert.match(system.content, /Project Instructions/);
      assert.match(system.content, /Always greet with hello/);
      return { content: "ok", tool_calls: [], usage: {} };
    },
  };
  await runAgentLoop({ messages: [{ role: "user", content: "hi" }], tools, provider, model: "fake", cwd: root });
});

test("agent loop retries transient provider failures", async () => {
  const { tools } = buildTools();
  let attempts = 0;
  const provider = {
    chat: async () => {
      attempts++;
      if (attempts < 3) throw new Error("fetch failed: upstream request failed (502)");
      return { content: "recovered", tool_calls: [], usage: {} };
    },
  };
  const retries = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "hi" }],
    tools,
    provider,
    model: "fake",
    cwd: root,
    retries: 3,
    onRetry: (i) => retries.push(i),
  });
  assert.equal(attempts, 3);
  assert.equal(retries.length, 2);
  assert.ok(result.messages.some((m) => m.content === "recovered"));
});

test("agent loop retries an empty provider response instead of stopping", async () => {
  const { tools } = buildTools();
  let attempts = 0;
  const provider = {
    chat: async () => {
      attempts++;
      // First call: the stream dropped and the provider returned nothing.
      if (attempts === 1) return { content: "", tool_calls: [], usage: {} };
      // Second call: recovered.
      return { content: "back", tool_calls: [], usage: {} };
    },
  };
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "hi" }],
    tools,
    provider,
    model: "fake",
    cwd: root,
    retries: 3,
  });
  assert.equal(attempts, 2);
  assert.ok(result.messages.some((m) => m.content === "back"));
});

test("agent loop retries a null-content provider response", async () => {
  const { tools } = buildTools();
  let attempts = 0;
  const provider = {
    chat: async () => {
      attempts++;
      if (attempts === 1) return { content: null, tool_calls: null, usage: {} };
      return { content: "ok", tool_calls: [], usage: {} };
    },
  };
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "hi" }],
    tools,
    provider,
    model: "fake",
    cwd: root,
    retries: 3,
  });
  assert.equal(attempts, 2);
  assert.ok(result.messages.some((m) => m.content === "ok"));
});

test("agent loop keeps retrying on empty responses until attempts run out", async () => {
  const { tools } = buildTools();
  let attempts = 0;
  const provider = {
    chat: async () => {
      attempts++;
      // Always empty: the stream keeps dropping.
      return { content: "", tool_calls: [], usage: {} };
    },
  };
  await assert.rejects(
    () =>
      runAgentLoop({
        messages: [{ role: "user", content: "hi" }],
        tools,
        provider,
        model: "fake",
        cwd: root,
        retries: 3,
      }),
    /empty response/i,
  );
  assert.equal(attempts, 3);
});

test("onRetryResolved fires when a retried call succeeds", async () => {
  const { tools } = buildTools();
  let attempts = 0;
  const resolved = [];
  const provider = {
    chat: async () => {
      attempts++;
      if (attempts === 1) throw new Error("fetch failed: ECONNRESET");
      return { content: "recovered", tool_calls: [], usage: {} };
    },
  };
  await runAgentLoop({
    messages: [{ role: "user", content: "hi" }],
    tools,
    provider,
    model: "fake",
    cwd: root,
    retries: 3,
    onRetryResolved: (info) => resolved.push(info),
  });
  assert.equal(attempts, 2);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].attempt, 2);
});

test("stream accumulator deduplicates tool_calls with the same id", async () => {
  const { createStreamAccumulator } = await import("../src/providers/stream-utils.js");
  const acc = createStreamAccumulator({});
  // Same tool call arrives fragmented by index (as some providers emit),
  // then is re-emitted with a different index — must collapse to one call.
  acc.push({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path"' } }] } }],
  });
  acc.push({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":"a.js"}' } }] } }],
  });
  acc.push({
    choices: [{ delta: { tool_calls: [{ index: 1, id: "call_1", function: { name: "read", arguments: '{"path":"a.js"}' } }] } }],
  });
  const result = acc.result();
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].id, "call_1");
  assert.equal(result.tool_calls[0].function.name, "read");
});

test("agent loop executes each tool call once even if duplicated in the stream", async () => {
  const { tools } = buildTools();
  let calls = 0;
  const provider = {
    // Non-streaming path: return the same tool call twice with the same id
    // on the first call, then a plain-text response to end the loop.
    chat: async () => {
      calls++;
      if (calls === 1) {
        return {
          content: "Let me read.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.js" }) } },
            { id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.js" }) } },
          ],
          usage: {},
        };
      }
      return { content: "Done.", tool_calls: [], usage: {} };
    },
  };
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "hi" }],
    tools,
    provider,
    model: "fake",
    cwd: root,
  });
  // The read tool must have run exactly once despite the duplicate.
  const toolResults = result.messages.filter((m) => m.role === "tool");
  assert.equal(toolResults.length, 1);
});
