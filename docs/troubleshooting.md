# Troubleshooting

Common problems and their fixes, grouped by symptom. If none of these help,
run with `SOLUNA_DEBUG=1` (or `-v`) and look at `~/.soluna/logs/` — the logs
capture the real error.

## Installation

### `soluna: command not found`
`npm link` was not run, or its target is not on your PATH. Either run
`npm link` from the repo, or invoke it directly:

```bash
node bin/soluna.js
```

### `Error: Cannot find module 'ink'`
Dependencies were not installed. Run:

```bash
npm install
```

Soluna has two runtime dependencies (`ink` and `react`).

## Starting

### `The TUI will not start` / garbled screen
Soluna needs a real TTY. In a pipe, `ssh` without a pty, or most CI, use
`--print`:

```bash
soluna --print "your prompt here"
```

### `Error: --print requires a prompt`
Headless mode needs a prompt. Pass one:

```bash
soluna --print "list the files"
```

or set `options.prompt`. Without it there is nothing to run.

## Providers and keys

### `needs a key` in the provider list
No key is available for that provider. Three ways to fix it:

1. Select it in the list and Soluna jumps to the key form (`/setkey`).
2. Export the variable before starting:
   `export GROQ_API_KEY="gsk_..."`.
3. Switch to a keyless provider (`zen`, `ollama`, `lmstudio`).

A stored key is in `config.json` under `apiKeys`; an environment variable
always wins over it.

### `401` / `Authentication` from a provider
The key is wrong, expired, or not set. These errors are **not retried** —
retrying would just fail again. Check the key and the env var name.

### A specific model returns `401` while others work
Some providers lack credentials for certain models. Switch to another model
under the same provider via `/models`.

### `Unknown provider "<x>"`
The provider id is not in the catalog. Add it as a custom provider
(`/providers → + Add a custom provider`) or fix the id. Ids are
case-insensitive.

### Model list is empty or stale
Dynamic providers (`ollama`, `lmstudio`, `openrouter`) list models
at runtime. If the server is down the list may be empty — start the server
and switch provider again.

## Sessions

### `No saved sessions in <dir>`
There is no session for this exact directory. Sessions are scoped by a hash
of the cwd, so a parent or sibling directory has its own sessions. Start
Soluna in the original directory, or use `/sessions` to see what exists.

### A session does not resume
The session file may be corrupt. Soluna skips files it cannot parse, so a
corrupt JSON in `~/.soluna/sessions/` never blocks startup. Move the bad file
out and retry.

### I quit but my last messages are missing
Sessions save on every change (debounced ~1.5 s) and on exit. If the process
was killed hard (SIGKILL) mid-write, the atomic rename may not have
committed — the previous state survives, so at most a little is lost.

## The agent's behaviour

### The agent is looping without finishing
The loop has a hard stop of 50 iterations. If it triggers, the problem is
usually a tool that keeps failing. Check the transcript for the repeated
error and correct it (a wrong path, a command that always exits non-zero).

### The agent edits the wrong file
It likely read a similar path first. Tell it the exact path, or narrow the
task. The `edit` tool requires `old_string` to match exactly, so a wrong
guess fails loudly rather than silently.

### A command was refused as risky
Soluna's classifier flags destructive commands and asks for approval. Approve
it in the permission dialog. To avoid the prompt, the model can classify
read-only commands as `safe`; to work outside the workspace, pass
`--add-dir <path>`. See [safety.md](safety.md).

### Context fills too quickly
Lower `compactThreshold` in `config.json` (e.g. `0.80`), or run `/compact`
manually. `/status` shows exactly what is using the window. Very long files
read with `read` are the usual culprit — use `offset`/`limit`.

### Compaction lost something important
Compaction keeps the first message and the last 8, and condenses the middle
into a structured handoff. If a fact keeps getting lost, add it to
`AGENTS.md` — project instructions are never compacted out. See
[compaction.md](compaction.md) and [safety.md](safety.md).

### Skill is never used
The skill's `description` must read as a trigger ("Use when the user asks
to…"), not a summary ("API testing helper"). Without a good description the
model cannot know when to apply it. Check `/skills` to confirm it is listed.
See [skills.md](skills.md).

## MCP

### An MCP server does not appear
Servers load at startup. After adding one with `/mcp`, restart Soluna. Confirm
the command runs standalone, then check `/mcp` for its status.

### `SOLUNA_DEBUG=1` shows an MCP connection error
That is the server's stderr or a spawn failure. Fix the command, args or
env in `~/.soluna/mcp.json`. One failed server never blocks the others.

### MCP tool names collide
Tools are namespaced `mcp__<server>__<tool>`, so collisions are
impossible. If two servers expose a tool with the same name, the namespace
disambiguates them.

## Performance

### Everything is slow to start
MCP servers launch at first use but the connection is at startup. Run
`soluna --no-mcp` to isolate the cause. A slow provider's models.dev fetch
has a short timeout and falls back to defaults.

### The status bar shows `0/0` context
The real context limit has not loaded yet. Soluna fetches it in the background
and updates when it arrives.

## Getting help

1. Run with `SOLUNA_DEBUG=1` and read `~/.soluna/logs/`.
2. Check this manual — especially [safety.md](safety.md) and the
   [commands](commands.md) and [tools](tools.md) references.
3. Open an issue in the repository where you obtained this Soluna copy with the
   relevant log lines.

## Termux (Android) and Windows

### Which shell does the `bash` tool use?
- **Linux / macOS / Termux:** `bash` from `PATH`, then `$PREFIX/bin/bash`, `/bin/bash`, and finally `sh`.
  Termux has no `/bin`, `/tmp` or `sudo`: install packages with `pkg install <name>`
  and use `$TMPDIR` for temporary files.
- **Windows:** Git Bash when it is installed (`C:\Program Files\Git\bin\bash.exe`), otherwise
  PowerShell with common Bash commands translated (`export`, `VAR=x cmd`, `>/dev/null`, `mkdir -p`,
  `cp -r`, `touch`, `head`/`tail`/`grep`/`wc` in pipes, `python3` → `python`, …).
  The `bash.exe` in `System32` is WSL and is deliberately **not** used.
- Override either choice with `SOLUNA_SHELL=/full/path/to/shell`.

### `npm.ps1 cannot be loaded because running scripts is disabled`
Soluna starts PowerShell with `-ExecutionPolicy Bypass`, so this should not happen. If you still see it,
call `npm.cmd`/`npx.cmd` or install Git for Windows.

### `Heredocs (<<EOF) are not supported in PowerShell`
Use the `write` tool to create the file, or install Git for Windows so commands run in Git Bash.

### Process "terminated by signal SIGKILL" on Termux
Android's phantom-process killer stopped it. Run `termux-wake-lock`, reduce parallelism, or disable the
killer with `adb shell "settings put global settings_enable_monitor_phantom_procs false"` (Android 12+).

### Web UI: `Port 3456 is already in use`
Soluna now tries the next ports automatically (3457, 3458, …) and prints the URL it actually used.
Set `SOLUNA_WEB_PORT_STRICT=1` to fail instead.
