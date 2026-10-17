# Slash commands

Every command in the TUI, in depth. Type `/` to see them all with live
filtering; `tab` completes. Most commands work even while a task is running.

| Command | Short | What it does |
|---|---|---|
| `/help` | `/h`-like | Opens the command list |
| `/providers` | — | Switch provider, or add a custom one |
| `/setkey [id]` | — | Set or remove a provider's API key |
| `/openrouter-keys` | — | Add/remove OpenRouter keys for automatic quota failover |
| `/models` | — | Switch model, or add a custom one |
| `/theme` | — | Change the colour theme |
| `/tools` | — | List every tool available to the agent |
| `/skills` | — | List installed skills |
| `/mcp` | — | Manage MCP servers |
| `/config` | — | Show config paths and settings |
| `/sessions` | — | Browse and resume past sessions |
| `/status` | — | Session info, tokens, context |
| `/resume` | — | Resume the most recent session here |
| `/save` | — | Save the session now |
| `/cwd <path>` | — | Show or change the working directory |
| `/compact` | — | Summarise to free context |
| `/clear` | — | Clear the conversation |
| `/exit` | — | Quit |

## `/help`

Opens the command reference overlay. Every command's description and any
argument syntax is shown. There is no way to get lost: type `/` and it is
right there.

## `/providers`

Opens the provider list. The current provider is marked; those that need a
key show whether one is available (`env`, `saved`, or `needs a key`).
Selecting a keyless provider switches to it immediately. Selecting one that
needs a key and has none jumps straight to the key form.

The last menu entry is **+ Add a custom provider** — a form for any
OpenAI-compatible endpoint. See [providers.md](providers.md).

## `/setkey [id]`

Sets or removes a stored API key. Without an argument it opens the provider
picker first. With one it jumps straight to the key form for that provider.

```text
/setkey groq          # enter groq's key (masked input)
/setkey groq -        # remove groq's stored key
```

## `/openrouter-keys`

Add multiple OpenRouter keys. Soluna retries the same request with the next
saved key when OpenRouter returns HTTP 402 (payment/credits) or 429 (quota or
rate limit). The selected model and request stay unchanged. Keys are stored in
`~/.soluna/config.json`; the command only displays a masked suffix. Removing a
key is immediate. If every key is exhausted or limited, Soluna reports the
last OpenRouter error.

The key is saved to `config.json` under `apiKeys`. An exported environment
variable always wins over a stored key. See [providers.md](providers.md).

## `/models`

Opens the model list for the current provider. Selecting one switches and
persists. The last entry is **+ Add a custom model**, a form for model ids
that are not in the catalog. See [providers.md](providers.md).

## `/theme`

Opens the theme picker: `dark`, `nord`, `dracula`, `gruvbox`, `tokyo`,
`light`. The choice is previewed immediately and saved to `config.json`.
See [tui.md](tui.md).

## `/tools`

Lists every tool the agent can call this session — the built-ins plus any
MCP tools, each with its description. Useful to confirm that a tool exists
and what it expects before describing a task.

## `/skills`

Lists installed skills, their descriptions, and whether each is `user`
(global) or `project` scope. See [skills.md](skills.md).

## `/mcp`

Manages MCP servers: shows the configured servers and their connection
status, and offers **+ Add an MCP server**. Server definitions live in
`~/.soluna/mcp.json`; a new server takes effect after a restart.
See [mcp.md](mcp.md).

## `/config`

Shows where everything lives:

```text
home        /home/you/.soluna
config      /home/you/.soluna/config.json
mcp         /home/you/.soluna/mcp.json
sessions    /home/you/.soluna/sessions
skills      /home/you/.soluna/skills
saved keys  2 (use /setkey)
skills loaded  3
theme       dracula
auto-compact   on at 80% context
```

## `/sessions`

Browses the saved sessions for the current project, newest first, each with
its title, timestamp and message count. Selecting one loads it — useful when
you want a specific conversation rather than the most recent.
See [sessions.md](sessions.md).

## `/status`

Shows the current session: provider, model, working directory, token usage
(input/output), turn count, and how much of the context window is in use.
This is the same data as the status bar, in a readable window.

## `/resume`

Resumes the most recent session for the current project. Equivalent to
starting Soluna with `--continue` (`-c`). See [sessions.md](sessions.md).

## `/save`

Flushes the current session to disk immediately. Sessions also autosave as
you work, but `/save` is handy before something drastic like `/clear`.

## `/cwd <path>`

Without an argument, shows the working directory. With one, changes it:

```text
/cwd src          # move into src/
/cwd /abs/path    # absolute path
```

The new directory must be inside the workspace sandbox; Soluna refuses paths
that would leave it. See [safety.md](safety.md).

## `/compact`

Runs context compaction immediately, regardless of the 80% threshold. The
conversation is distilled into a structured 14-section handoff document and
the oldest content is dropped. See [compaction.md](compaction.md).

## `/clear`

Empties the current transcript and starts a fresh conversation in the same
session. Saved context from before survives on disk; only the in-memory
conversation is dropped. Run `/save` first if you want it preserved.

## `/exit`

Quits Soluna. Sessions autosave on the way out, so the next launch with
`--continue` picks up where you left off.

## CLI-only equivalents

Some headless operations live on the command line instead of the TUI:

| Flag | Equivalent to |
|---|---|
| `-p/--provider` | `/providers` (one-shot) |
| `-m/--model` | `/models` (one-shot) |
| `-c/--continue` | `/resume` |
| `--sessions` | `/sessions` (headless listing) |
| `--no-mcp` | a `/mcp` with no servers loaded |

See [cli.md](cli.md).
