# Soluna Documentation

Soluna is an AI coding agent that runs in your terminal. It reads
your code, edits files, runs commands, and asks you questions when a decision
is genuinely yours to make.

This is the complete manual. It is written to take you from first install to
writing your own tools. Every page is written in English and reflects the
current behaviour of the software.

---

## Reading paths

New to Soluna? Read in this order:

1. [Getting started](getting-started.md) — install, first run, the tour
2. [The interface (TUI)](tui.md) — what you are looking at, themes, keys
3. [Providers](providers.md) — where the models come from
4. [Commands](commands.md) — every `/command`
5. [Tools](tools.md) — what the agent can do
6. [Sessions](sessions.md) — persistence and resuming
7. [Context and compaction](compaction.md) — how Soluna manages its memory
8. [Safety](safety.md) — sandbox, permissions, logging

Already comfortable? Reference pages:

- [Configuration reference](configuration.md) — `config.json`, env vars
- [Skills](skills.md) — teach Soluna specialised workflows
- [MCP servers](mcp.md) — plug in any MCP tool server
- [CLI reference](cli.md) — every flag and exit code
- [Extending Soluna](extending.md) — write tools and providers, use it as a library
- [Troubleshooting](troubleshooting.md) — what to do when something goes wrong
- [Glossary](glossary.md) — the terms used across these pages

---

## The one-paragraph summary

Soluna is a loop. It builds a system prompt from your working directory (plus an
optional `AGENTS.md`), sends your message plus the conversation history to a
model, and streams the reply into a terminal UI. When the model decides it
needs to inspect or change the world, it emits tool calls (`read`, `write`,
`edit`, `bash`, `ls`, `glob`, `grep`, `ask`, `skill`, MCP tools). Soluna executes
them, feeds the results back, and loops until the model produces a final
answer — up to 50 iterations. Everything you do is saved to `~/.soluna/` so you
can resume later.

It is built to be boring and reliable: a workspace sandbox stops the agent
from touching files outside your project, risky shell commands need your
approval, provider failures are retried with backoff, and long conversations
are compacted into a structured handoff document before the context window
overflows.

---

## The docs at a glance

| Page | What you will learn |
|---|---|
| [getting-started.md](getting-started.md) | Install, first run, a guided tour |
| [tui.md](tui.md) | The interface, the status bar, themes, keys |
| [providers.md](providers.md) | All 13 providers, keys, custom endpoints |
| [commands.md](commands.md) | Every slash command, in depth |
| [tools.md](tools.md) | Every tool, its parameters, and best practices |
| [sessions.md](sessions.md) | Saving, resuming, pruning, file format |
| [compaction.md](compaction.md) | Context limits and the 14-section handoff |
| [safety.md](safety.md) | Sandbox, command approval, logs, AGENTS.md |
| [configuration.md](configuration.md) | config.json keys, env vars, precedence |
| [skills.md](skills.md) | Authoring and installing skills |
| [mcp.md](mcp.md) | Model Context Protocol servers |
| [cli.md](cli.md) | Full CLI reference |
| [extending.md](extending.md) | Writing tools, providers, using as a library |
| [troubleshooting.md](troubleshooting.md) | Common problems and fixes |
| [glossary.md](glossary.md) | Terminology |

---

## Conventions used in this manual

- `code` inline is a command, key, file name or identifier.
- Code blocks with `bash` are things you type in your shell.
- Code blocks with no language are file contents.
- Text in ```` ```text ```` blocks is what appears on screen.
- Soluna writes logs to `~/.soluna/logs/`; set `SOLUNA_DEBUG=1` (or `-v`)
  before starting to get verbose detail.

If a page disagrees with what you observe, the code is right and this manual
is wrong — open an issue on the repository where you obtained this Soluna copy.
