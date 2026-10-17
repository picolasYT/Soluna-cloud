# Tools

These are the actions the agent can take in your workspace. The system prompt
tells the model which tools exist and when to use each one; this page explains
the details — parameters, edge cases, and best practices — so *you* can judge
whether Soluna is behaving sensibly.

## The tool set

| Tool | Category | Purpose |
|---|---|---|
| `read` | file | Read text or images with offset/limit |
| `write` | file | Create or fully overwrite a file |
| `edit` | file | Targeted search-and-replace |
| `ls` | search | List a directory |
| `glob` | search | Find files by name pattern |
| `grep` | search | Search file contents |
| `bash` | shell | Run a command with a timeout |
| `ask` | user | Ask you a question with options |
| `skill` | knowledge | Load a skill's instructions |
| `mcp__*__*` | external | Tools from your MCP servers |

Every file and search tool resolves paths against the **workspace sandbox**
and refuses anything outside it — including symlinks that point out. See
[safety.md](safety.md).

## `read`

```
read(path, offset?, limit?)
```

Reads a file as text, or as an image when the extension is a supported image
type (`jpg`, `png`, `gif`, `webp`, `bmp`).

- `path` — file to read, relative or absolute (must stay inside the sandbox).
- `offset` — 1-indexed starting line.
- `limit` — maximum number of lines.

Large files are truncated at **4000 lines** or **100 KB**; the result tells
the model exactly which lines were shown and gives the offset to continue
from. Binary files (an executable, an image without a known extension, a
`.dat` blob) are refused with a hint to use `bash` (`file`, `strings`)
instead — dumping binary garbage into a model is never useful.

Best practices:

- Read before editing; the model is told this explicitly.
- Use `offset`/`limit` on large files instead of one giant read.
- For images, the model receives the actual image, not a description.

## `write`

```
write(path, content)
```

Creates a file (and any missing parent directories) or overwrites one
entirely. Reports a diff of added/removed lines, so a full rewrite is still
reviewable.

Best practices:

- Use `write` for new files and complete rewrites only.
- For a small change to an existing file, `edit` is cheaper and safer.

## `edit`

```
edit(path, old_string, new_string, replace_all?)
```

Replaces `old_string` with `new_string`. Without `replace_all` only the first
occurrence changes; with it, every occurrence does. Requires `old_string` to
match exactly — including whitespace — and errors clearly if it is not found,
so a stale guess can never silently do nothing.

Best practices:

- Include enough surrounding context to make `old_string` unique.
- Prefer `edit` over `write` for targeted changes; the model is told this.

## `ls`

```
ls(path?, limit?)
```

Lists a directory: directories first (with a trailing `/`), then files,
sorted. Defaults to the workspace root; `limit` caps the entries (default
200). `.git` is skipped.

Use `ls` to orient yourself in an unfamiliar directory before reading files.

## `glob`

```
glob(pattern, path?, limit?)
```

Finds files whose relative path matches a glob pattern. Patterns follow
familiar shell rules:

| Pattern | Matches |
|---|---|
| `**/*.js` | every `.js` file, recursively |
| `src/**` | everything under `src/` |
| `*.test.*` | any file like `foo.test.js` in the root |
| `*.{ts,tsx}` | `.ts` or `.tsx` (brace alternation) |
| `?` | a single character |

Searches the workspace root by default, or `path` if given. Skips `.git` and
`node_modules`, never follows symlinks, and caps results (default 200,
maximum 1000) with a note to narrow the pattern. Returns paths relative to
the workspace root.

## `grep`

```
grep(pattern, path?, include?, case_sensitive?, limit?)
```

Searches file contents with a regular expression, returning
`file:line:text` hits. Case-insensitive by default. `include` filters files
by a name glob (e.g. `*.js`, `*.{ts,tsx}`). Skips `.git` and `node_modules`,
never follows symlinks, and skips binary files. Default limit 100 results.

The pattern is a real regular expression; an invalid one produces a clear
error rather than silently matching nothing.

Best practices:

- Use `grep` to find code by content instead of `bash` + `grep`, so the
  model gets structured, truncated results.
- Use `include` to cut noise in large repos.

## `bash`

```
bash(command, timeout?, permission?)
```

Runs a command in the workspace with `bash -c`. Captures stdout and stderr,
truncates to the same 4000-line / 100 KB budget, and reports the exit code.

- `timeout` — seconds; the process group is killed on timeout.
- `permission` — the model's own classification of the command:
  - `safe` (default) — read-only or clearly harmless.
  - `ask` — destructive, irreversible, or risky: **requires your approval**.
  - `deny` — refuse without asking.

Soluna does not rely on the model's word. A static classifier also scans the
command text for destructive patterns — `rm -rf`, `git reset --hard`, force
pushes, `mkfs`/`dd`, `sudo`/`su`, `chmod`/`chown -R`, `shutdown`/`reboot`,
piping a remote script straight into a shell, `kill -9`, and any redirect
that writes outside the workspace. Anything flagged is refused unless you
approve it. In `--print` mode there is no approval dialog, so flagged
commands are refused outright.

See [safety.md](safety.md) for the full policy.

Best practices:

- Prefer Soluna's tools over shell for file work (`read`, `edit`, `grep`…).
- Use `bash` for what the tools cannot do: build, test, install, git.

## `ask`

```
ask(questions[])
```

Asks you one or more questions. Each question can offer selectable options
plus a free-form "write my own answer" choice. Supports multi-select
(`multiple: true`) and up to 10 questions per call, 12 options per question.

The model is told to use `ask` only for decisions that are genuinely yours —
not to avoid work it can do itself. In the TUI it renders a panel with the
options; in `--print` mode it falls back to numbered readline prompts.

## `skill`

```
skill(name)
```

Loads a skill's full instructions. Only the skill *index* (name +
description + location) is preloaded into the system prompt; the body enters
the context only when this tool is called. This keeps large skill libraries
cheap. See [skills.md](skills.md).

## `mcp__server__tool`

Every tool exposed by your MCP servers, namespaced to avoid collisions:

```
mcp__<server>__<tool>
```

For example `mcp__github__create_issue`. Configure servers with `/mcp` or by
editing `~/.soluna/mcp.json`. See [mcp.md](mcp.md).

## How tool results are fed back

After a tool runs, its output is appended to the conversation as a `tool`
message and the loop continues: the model sees the result and decides what to
do next — another tool, or a final answer. The loop ends when the model
produces an answer with no tool calls, or after 50 iterations (a hard stop
that avoids runaway loops).

Tool errors are also returned to the model as messages, so it can read the
error and adjust instead of crashing. Failed or refused commands are surfaced
in the transcript with the reason.

## The `tool-status` wording

Each tool shows a short phase line while it runs:

```text
  ⏵ Reading <path>
  ✓ Read <path> 3ms
  ⏵ Writing <path>
  ✓ Wrote <path> 12ms
  ⏵ Running <command> on <host>
  ✓ Ran <command> 1.2s
```

The wording lives in `src/core/tool-status.js` and is easy to customise when
extending Soluna. See [extending.md](extending.md).
