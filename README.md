# Soluna

A minimal, extensible AI coding agent for your terminal and browser. Soluna is based on the open source [Zyn](https://github.com/toZyn/Zyn) project and keeps its agent architecture and capabilities.

Soluna reads your code, edits files, runs commands, and asks you questions when a decision is genuinely yours to make. It works with 13+ model providers out of the box — including several that are completely free and need no API key.

```
❯ add input validation to the signup endpoint

Let me look at the current handler first.

  ✓ Read src/routes/signup.js 41ms
Adding validation before the database call.

  ✓ Edited the file src/routes/signup.js 28ms
    +14 -2
    + if (!isEmail(body.email)) {
    +   return res.status(400).json({ error: "Invalid email" });
    + }
  ✓ Ran npm test 2.1s
      12 passing

Added email and password-length checks. Tests pass.

zen/big-pickle · ██░░░░░░ 18% · 23k/128k · ↑4.2k ↓890 · 3 turns
```

---

## Why Soluna

Soluna is built to be a **serious** agent — reliable, extensible, and designed to stay out of the way.

**Guardrails that are enforced, not requested.** A workspace sandbox stops the agent from touching files outside your project — `../` traversal, absolute paths, and symlinks that point out are all rejected in code, not just forbidden in a prompt. Risky shell commands need your explicit approval before they run, and a static classifier double-checks the model's own judgement.

**Memory that survives.** Every conversation is saved automatically, scoped per project, and resumes exactly where it left off — transcript, token counters and all. Long conversations are compacted into a structured 14-section handoff document that preserves the expensive things a summary drops: decisions, failed attempts, and user feedback.

**A focused interface.** The terminal UI uses Ink and React, while the browser UI is served from lightweight native HTML, CSS, and JavaScript. Both keep the same agent loop, tools, permissions, and session store.

**Extensible without forking.** Add a tool, a slash command, a provider, a skill, or an MCP server — most of them with no code at all. The skill format matches Claude Code and Codex, so skills are portable. Use Soluna as a library and drive the loop yourself.

**Observable.** Notable events are written to daily JSON logs with secret redaction. Provider failures are retried with backoff; auth errors are not. A real test suite covers the sandbox, the classifier, every tool, and the full loop.

**Free to try, cheap to run.** The default provider serves capable models with no API key. Local models via Ollama or LM Studio need none either.

---

## Documentation

This repository ships a complete manual in [`docs/`](docs/). Read it in order when you are new, or jump to a page when you need it.

| Page | What you will learn |
|---|---|
| [docs/README.md](docs/README.md) | Documentation index and reading paths |
| [docs/getting-started.md](docs/getting-started.md) | Install, first run, a guided tour |
| [docs/tui.md](docs/tui.md) | The interface, the status bar, themes, keys |
| [docs/providers.md](docs/providers.md) | All 13 providers, keys, custom endpoints |
| [docs/commands.md](docs/commands.md) | Every slash command, in depth |
| [docs/tools.md](docs/tools.md) | Every tool, its parameters, and best practices |
| [docs/sessions.md](docs/sessions.md) | Saving, resuming, pruning, file format |
| [docs/compaction.md](docs/compaction.md) | Context limits and the 14-section handoff |
| [docs/safety.md](docs/safety.md) | Sandbox, command approval, logs, AGENTS.md |
| [docs/configuration.md](docs/configuration.md) | config.json keys, env vars, precedence |
| [docs/skills.md](docs/skills.md) | Authoring and installing skills |
| [docs/mcp.md](docs/mcp.md) | Model Context Protocol servers |
| [docs/cli.md](docs/cli.md) | Full CLI reference |
| [docs/extending.md](docs/extending.md) | Writing tools, providers, using as a library |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems and fixes |
| [docs/glossary.md](docs/glossary.md) | Terminology |

---

## The one-paragraph summary

Soluna is an agent loop. It builds a system prompt from your working directory (plus an optional `AGENTS.md`), sends your message and conversation history to a model, and streams the reply into a terminal UI. The model can call `read`, `write`, `edit`, `bash`, `ls`, `glob`, `grep`, `ask`, `skill`, and MCP tools. Soluna executes them and loops until the model produces a final answer — up to 50 iterations. Sessions and settings are saved to `~/.soluna/` so you can resume later.

It is built to be boring and reliable: a workspace sandbox stops the agent from touching files outside your project, risky shell commands need your approval, provider failures are retried with backoff, and long conversations are compacted into a structured handoff document before the context window overflows.

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
