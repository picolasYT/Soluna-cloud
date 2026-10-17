# CLI reference

The full command-line interface. Every flag, its default, and the exit codes.

## Usage

```
soluna [options] [prompt]
```

If `prompt` is given (or `--prompt`), Soluna runs it headlessly and exits. If
stdin is not a TTY, Soluna switches to `--print` mode automatically.

## Options

| Flag | Argument | Default | Description |
|---|---|---|---|
| `-p`, `--provider` | `<id>` | saved or auto-detected | Provider to use |
| `-m`, `--model` | `<id>` | saved or provider default | Model to use |
| `-d`, `--cwd` | `<path>` | `process.cwd()` | Working directory |
| `-c`, `--continue` | — | `false` | Resume the most recent session here |
| `--print`, `--no-tui` | — | `false` | Plain output, no interactive UI |
| `--prompt` | `<text>` | — | Initial prompt (headless) |
| `--add-dir` | `<path>` | — | Allow read/write access to an extra directory (repeatable) |
| `--sessions` | — | `false` | List saved sessions and exit |
| `--no-mcp` | — | `false` | Skip loading MCP servers |
| `--auto-accept` | — | `false` | Automatically approve risky shell commands scoped inside the workspace |
| `--unsafe` | — | `false` | Disable the workspace sandbox and command approval |
| `-v`, `--verbose` | — | `false` | Verbose output (enables debug logging) |
| `-h`, `--help` | — | — | Show help and exit |

Flags take precedence over saved config, which takes precedence over
auto-detection:

```
--provider / --model  >  ~/.soluna/config.json  >  detectProvider()
```

## Prompts

A bare word is treated as the prompt:

```bash
soluna "explain what src/parser.js does"
```

is equivalent to:

```bash
soluna --prompt "explain what src/parser.js does"
```

## Headless mode

`--print` (or `--no-tui`) produces plain output with no colours beyond basic
markers. It is the mode for scripts, pipes and CI:

```bash
soluna --print "list every TODO in src" > todos.txt
```

In headless mode:

- `ask` falls back to numbered readline prompts.
- Risky `bash` commands are refused outright (no one to approve them).
- `--auto-accept` opts into approving risky shell commands without a prompt,
  but does not disable the workspace sandbox or permit flagged outside-workspace
  operations. A model `permission: "deny"` remains a refusal.
- Sessions still save, so `--continue` works next time.

## Listing sessions

```bash
soluna --sessions
```

Prints a headless list of saved sessions for the current directory (id,
timestamp, title) and exits 0. With no sessions it prints a short message and
exits 0.

## Environment variables

| Variable | Purpose |
|---|---|
| `SOLUNA_HOME` | Relocate the whole config directory (used verbatim) |
| `SOLUNA_DEBUG` | Verbose logging + MCP connection errors |
| `OPENAI_API_KEY` etc. | Provider keys, one per provider |

See [configuration.md](configuration.md) and [safety.md](safety.md).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (including `--sessions`, `--help`, normal exit) |
| 1 | Fatal error (startup failure, missing prompt in `--print`, etc.) |

A refused risky command in `--print` mode is reported as an error message but
does not change the exit code of a successful run — it is surfaced in the
transcript.

## Examples

```bash
soluna                                       # interactive, default provider
soluna "refactor the auth module"            # one-off task
soluna -p groq -m llama-3.3-70b-versatile    # specific provider and model
soluna -d ~/projects/api --continue          # resume in another directory
soluna --print "list every TODO" > todos.txt # pipe the output
soluna --add-dir ~/shared                    # allow an extra directory
soluna --no-mcp                              # skip MCP servers
soluna --sessions                            # list saved sessions
```

## Interacting with a running Soluna

Once the TUI is open, the CLI flags are fixed for that run. To change
provider, model, theme or directory mid-session, use the slash commands
(`/providers`, `/models`, `/theme`, `/cwd`). See [commands.md](commands.md).
