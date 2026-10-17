# Glossary

The terms used across this manual, in one place.

**Agent loop** — The core cycle: send the conversation to the model, stream
the reply, execute any tool calls, feed the results back, repeat. Soluna stops
when the model produces a final answer or after 50 iterations.

**AGENTS.md** — A file at the workspace root whose contents are injected into
the system prompt. The convention shared by Claude Code, Codex and opencode.
Also accepts `CLAUDE.md` as a fallback.

**API key** — A secret token a provider uses to authenticate requests. Soluna
reads it from an environment variable (preferred) or a stored entry in
`config.json`. Env vars always win.

**Ask tool** — The tool the model calls to ask the user a question with
selectable options and a free-form answer. Renders a panel in the TUI, a
readline prompt in `--print`.

**Bash tool** — The tool that runs shell commands. Gated by the model's
self-classification (`safe`/`ask`/`deny`) *and* a static risk classifier.
See [safety.md](safety.md).

**Compaction** — Condensing the middle of a conversation into a structured
14-section handoff document so the context window does not overflow. Trigger
automatically at 80%, on overflow, or manually with `/compact`.

**Context window** — The fixed number of tokens a model can see at once:
system prompt + conversation + tool results. Soluna estimates usage and shows
it in the status bar; the real limit comes from models.dev.

**CWD / working directory** — The directory Soluna started in. It becomes the
workspace root for the sandbox and the base for relative paths. Change it
with `--cwd`, `-d`, or `/cwd`.

**Dedicated provider** — A provider with its own adapter (e.g. Anthropic),
as opposed to the generic OpenAI-compatible adapter.

**Dynamic provider** — A provider whose models are listed at runtime
(`ollama`, `lmstudio`, `openrouter`), not from a fixed catalog.

**Env var precedence** — The rule that an exported provider key always wins
over a stored key, so exporting a key keeps it out of any file.

**Glob** — A filename pattern like `**/*.js`. Soluna's `glob` tool matches file
paths against one.

**Grep** — A content search with a regular expression. Soluna's `grep` tool
returns `file:line:text` hits.

**Handoff document** — The 14-section structured summary written during
compaction. Covers the request, current state, files, commands, decisions,
failures, feedback, next steps and more.

**Iteration** — One pass of the agent loop (one model reply plus its tool
executions). The loop stops at 50.

**KEEP_RECENT** — The last 8 messages, kept verbatim during compaction.

**MCP** — Model Context Protocol. A standard for tool servers. Soluna is a
client; any MCP server's tools become Soluna's tools, namespaced
`mcp__<server>__<tool>`.

**maxIterations** — The hard stop of 50 iterations per turn, to avoid
runaway loops.

**maxSessions** — The number of sessions kept before pruning the oldest
(default 50).

**models.dev** — The source of real context-window data, cached in
`~/.soluna/models.json`.

**Overlay** — A floating window in the TUI for a `/` command: providers,
models, themes, sessions, tools, skills, MCP, config, help.

**Permission** — The model's self-classification of a `bash` command:
`safe`, `ask`, or `deny`. Cross-checked by a static classifier.

**Print mode** — `--print` / `--no-tui`: plain output, no interactive UI.
For scripts, pipes and CI.

**Project** — A stable hash of the working directory. Sessions are scoped to
a project; `/sessions` and `--continue` filter by it.

**Provider** — A model service: `zen`, `openai`, `anthropic`, `groq`, …
Soluna ships 14 and supports any OpenAI-compatible endpoint.

**Retries** — Transient provider failures are retried with exponential
backoff (default 3 attempts). Auth errors are not retried.

**Sandbox** — The workspace boundary. File and search tools refuse paths
outside it, including symlinks that point out. See [safety.md](safety.md).

**Session** — A saved conversation: full history, provider, model, usage,
summary. One JSON file per session in `~/.soluna/sessions/`.

**Slash command** — A `/` command in the TUI: `/help`, `/providers`,
`/models`, `/theme`, `/tools`, `/skills`, `/mcp`, `/config`, `/sessions`,
`/status`, `/resume`, `/save`, `/cwd`, `/compact`, `/clear`, `/exit`,
`/setkey`.

**Skill** — A set of instructions loaded only when a task matches it.
Format: `SKILL.md` with a `description` trigger. See [skills.md](skills.md).

**Status bar** — The bottom line of the TUI: provider · model, context bar,
tokens, turns.

**Streaming** — Receiving the model's reply token by token. Soluna renders it
live and flushes text before running tools so the transcript stays in order.

**System prompt** — The instructions prepended to every request: identity,
rules, tool list, project instructions, skills index. Built from the cwd and
`AGENTS.md`.

**TUI** — The terminal (interactive) interface, built with a custom ANSI
renderer (no Ink, no React).

**Tool** — An action the agent can take: `read`, `write`, `edit`, `bash`,
`ls`, `glob`, `grep`, `ask`, `skill`, and any `mcp__*__*` tools.

**Tool call** — A request from the model to execute a tool. Soluna executes it,
returns the result, and loops.

**Workspace** — The working directory and its sandbox. The root for relative
paths and the boundary for file tools. See [safety.md](safety.md).

**SOLUNA_DEBUG** — An env var enabling verbose logging and MCP error output.

**SOLUNA_HOME** — An env var relocating the whole config directory. Used
verbatim.
