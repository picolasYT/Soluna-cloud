# Extending Soluna

Soluna is built to be changed. This page covers the three most common
extensions: writing a tool, writing a provider, and using Soluna as a library.
It also explains how to add a slash command and how to write a good
`AGENTS.md`.

## Writing a tool

A tool is a plain object with a name, a parameter schema, and an `execute`
function. File tools receive the `Workspace`, which enforces the sandbox
for you; everything else receives the arguments the model gives.

### The minimal tool

```js
// src/core/tools/clock.js
export function createClockTool() {
  return {
    name: "clock",
    description: "Return the current time in ISO format. Use only when the user asks for the current time.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(_args, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      return {
        content: [{ type: "text", text: new Date().toISOString() }],
      };
    },
  };
}
```

### A file tool with the workspace sandbox

```js
// src/core/tools/upper.js
import { fileExists, readFileAsText, writeFileContent } from "../utils/file-utils.js";

export function createUpperFileTool(workspace) {
  return {
    name: "upper_file",
    description: "Uppercase the entire contents of a text file. Use for small config or data files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to uppercase (relative or absolute)" },
      },
      required: ["path"],
    },
    async execute({ path }, signal) {
      if (typeof path !== "string" || !path.trim()) {
        throw new Error("upper_file requires a 'path' argument");
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      // The workspace resolves + sandboxes the path.
      const abs = await workspace.resolvePath(path, { mustExist: true });
      if (!(await fileExists(abs))) throw new Error(`File not found: ${path}`);

      const text = await readFileAsText(abs);
      await writeFileContent(abs, text.toUpperCase());

      return {
        content: [{ type: "text", text: `Uppercased ${path} (${text.length} chars)` }],
        details: { diff: { path, added: 0, removed: 0, lines: [], isNew: false } },
      };
    },
  };
}
```

`workspace.resolvePath(path)` for a new file, or
`workspace.resolvePath(path, { mustExist: true })` for an existing one, gives
you a safe absolute path and refuses escapes automatically.

### Registering the tool

In `bin/soluna.js`, import it and add it to the array in `buildTools()`:

```js
import { createClockTool } from "../src/core/tools/clock.js";
import { createUpperFileTool } from "../src/core/tools/upper.js";

const tools = [
  createReadTool(workspace),
  createWriteTool(workspace),
  createEditTool(workspace),
  createBashTool(workspace, { confirm }),
  createUpperFileTool(workspace),  // <-- here
  createLsTool(workspace),
  createGlobTool(workspace),
  createGrepTool(workspace),
  createClockTool(),               // <-- here
  createAskTool(),
];
```

### Adding custom status wording

The status line (`⏵ Reading <path>`) is generated from a per-tool table in
`src/core/tool-status.js`. Add an entry to customise the wording:

```js
upper_file: { running: (a) => `Uppercasing ${a.path}`, done: (a) => `Uppercased ${a.path}` },
```

### Tool guidelines

- **One job per tool.** A tool that reads is cheaper and clearer than a tool
  that reads, parses and writes.
- **Validate inputs.** Check `typeof` and ranges; throw a clear message.
  The model reads the error and adjusts.
- **Honour `signal`.** Check `signal?.aborted` before slow work so a
  cancelled turn stops promptly.
- **Return `{ content: [{ type: "text", text: … }] }`.** The model sees the
  `text`; structured data is optional via `details`.
- **Never log secrets.** API keys and tokens must never appear in tool
  output.

## Writing a provider

A provider exposes `chat({ messages, model, tools, signal })` returning
`{ content, tool_calls, usage }`. A streaming provider additionally exposes
`stream({ …, onTextDelta, onToolCalls, onToolDelta, executeTool })`.

### Adding a built-in provider

In `src/providers/catalog.js`, add an entry to `PROVIDER_CATALOG`:

```js
{
  id: "acme",
  label: "Acme AI",
  hint: "requires API key",
  envKey: "ACME_API_KEY",
  baseUrl: "https://api.acme.ai/v1",
  requiresKey: true,
  models: [
    { id: "acme-1", label: "Acme 1" },
    { id: "acme-2", label: "Acme 2" },
  ],
},
```

If the endpoint is OpenAI-compatible, that is enough — the generic adapter
handles the rest. If it has its own shape, write a dedicated class (see
`src/providers/anthropic.js` for an example) and register it in the
`DEDICATED` map in `src/providers/index.js`.

### Custom providers without code

Any OpenAI-compatible endpoint can be added with no code at all:

```json
{
  "customProviders": {
    "acme": {
      "label": "Acme AI",
      "baseUrl": "https://api.acme.ai/v1",
      "apiKeyEnv": "ACME_API_KEY",
      "models": [{ "id": "acme-1", label": "Acme 1" }]
    }
  }
}
```

or with `/providers → + Add a custom provider`. Custom providers override
built-ins with the same id. See [providers.md](providers.md).

## Adding a slash command

Commands live in `src/tui/commands.js`. Each entry returns an action the app
interprets:

```js
{ name: "clock", description: "Show the current time",
  run: () => ({ type: "message", text: `It is ${new Date().toISOString()}` }) }
```

Action types:

| Type | Effect |
|---|---|
| `{ type: "message", text, tone }` | Print into the transcript |
| `{ type: "overlay", overlay, props }` | Open a window |
| `{ type: "exit" }` | Quit |
| `{ type: "clear" }` | Clear the conversation |
| `{ type: "compact" }` | Compact the context |
| `{ type: "save" }` | Save the session |
| `{ type: "resume" }` | Resume the latest session |
| `{ type: "cwd", value }` | Change directory |
| `{ type: "noop" }` | Nothing (used for handled actions) |

For a richer command you open a custom overlay component and pass props to it.
The app calls `command.run(args)` where `args` is everything after the
command name.

## Using Soluna as a library

Soluna is a library as much as a CLI. Install it and drive the loop yourself:

```js
import {
  runAgentLoop,
  createReadTool,
  createBashTool,
  createProvider,
  Workspace,
} from "soluna-agent";

const workspace = new Workspace(process.cwd());
const provider = createProvider("zen", { model: "big-pickle" });

const result = await runAgentLoop({
  messages: [{ role: "user", content: "count the JS files here" }],
  tools: [createReadTool(workspace), createBashTool(workspace)],
  provider,
  model: "big-pickle",
  cwd: process.cwd(),
  onMessageFinal: (text) => console.log(text),
  onToolResult: ({ name, result, error }) => {
    console.log(error ? `✗ ${name}: ${error.message}` : `✓ ${name}`);
  },
  onRetry: ({ attempt, error }) => console.log(`retry ${attempt}: ${error.message}`),
  onCompaction: ({ phase }) => console.log(`compaction: ${phase}`),
  onUsage: (u) => console.log(`tokens: +${u.input_tokens}/+${u.completion_tokens}`),
});

console.log(`finished in ${result.iterations} iterations`);
console.log(`messages: ${result.messages.length}`);
```

### Loop events

| Event | When |
|---|---|
| `onMessage` | Assistant text while streaming (ephemeral) |
| `onMessageFinal` | A closed text block, ready for the transcript |
| `onToolPrepare` | Partial tool arguments while they stream |
| `onToolCall` | A tool begins executing |
| `onToolResult` | A tool finished (or errored) |
| `onUsage` | Token usage reported by the provider |
| `onCompaction` | Compaction phase changes |
| `onRetry` | A provider call is being retried |

`runAgentLoop` resolves to:

```js
{ messages: [...], iterations: 2, summary: "..." }
```

### Library options

```js
await runAgentLoop({
  messages: [],            // seed conversation
  tools: [],               // tool set
  provider: {},            // provider instance from createProvider()
  model: "big-pickle",     // model id
  cwd: process.cwd(),      // working directory (system prompt + sandbox)
  signal: abortController.signal,  // cancel the loop
  maxIterations: 50,       // hard stop for runaway loops
  autoCompact: true,       // compact at the threshold
  retries: 3,              // transient-failure retries
  previousSummary: null,   // resume a compacted session
  systemExtra: "",         // extra text appended to the system prompt
  onMessage, onMessageFinal, onToolPrepare, onToolCall, onToolResult,
  onUsage, onCompaction, onRetry,
});
```

## Writing a good AGENTS.md

`AGENTS.md` (or `CLAUDE.md`) at the workspace root is injected into the
system prompt. Follow the convention: short, imperative, and concrete.

```markdown
# my-project conventions

- Build: `npm run build`. Test: `npm test`. Lint: `npm run lint`.
- Never edit `dist/` — it is generated.
- Use tabs for indentation, single quotes, no semicolons.
- API routes live in `src/routes/`; each route owns its tests.
- The CI runs on Node 20. Do not use features from Node 21+.
```

Good instructions are:

- **Actionable.** "Run `npm test`, not the CI" beats "ensure quality".
- **Negative as well as positive.** "Do not modify `dist/`" is as useful as
  "run tests before pushing".
- **Short.** The system prompt is expensive; every line competes with the
  conversation. Five to fifteen lines is the sweet spot.

See [safety.md](safety.md).

## Project map for extenders

| Goal | File |
|---|---|
| Add a tool | `src/core/tools/<name>.js`, register in `bin/soluna.js` |
| Add a slash command | `src/tui/commands.js` |
| Add a built-in provider | `src/providers/catalog.js` |
| Change tool status wording | `src/core/tool-status.js` |
| Change colours | `src/tui/themes.js` |
| Change the agent's behaviour | `src/core/system-prompt.js` |
| Change the compaction prompt | `src/core/compaction-prompt.js` |
| Adjust the compaction threshold | `src/core/compaction.js` |
| Rename the agent | `src/config/constants.js` |
| Change the permission rules | `src/core/permissions.js` |
| Add a MCP server | `~/.soluna/mcp.json` (no code) |
