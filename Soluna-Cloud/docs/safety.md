# Safety

Soluna is an agent with write access to your machine. This page documents the
guardrails it ships with — they are enforced in code, not requested in a
prompt.

## The workspace sandbox

`read`, `write`, `edit`, `ls`, `glob` and `grep` all resolve their paths
against the **workspace root** — the directory Soluna started in (or `--cwd`).
Every path is checked twice:

1. **Lexically.** `../` traversal and absolute paths outside the root are
   rejected: `../../../etc/hosts`, `/etc/passwd`, `~/.bashrc`, anything that
   resolves above or outside the root.
2. **Physically.** Symlinks can point anywhere, so after resolving the path
   Soluna `realpath`s it (or its nearest existing ancestor) and checks *again*.
   A symlink inside the workspace that points outside is refused.

The result of both checks is a clear error:

```text
Refusing to touch "../../x": it resolves outside the workspace (/home/you/proj).
Start Soluna there, or pass --add-dir to allow it.
```

### Allowing extra directories

When a task legitimately needs another directory, allow it explicitly:

```bash
soluna --add-dir ~/shared --add-dir /tmp/build
```

`--add-dir` can be repeated. `/cwd <path>` inside the TUI only moves within
the sandbox — it refuses paths that would leave it.

### Disabling the sandbox

`--unsafe` disables the sandbox *and* command approval entirely. It exists
for trusted, throwaway environments (containers, CI scratch, experiments)
and is printed as a deliberate choice in help. For normal work, do not use
it.

`--auto-accept` is a narrower convenience option: it auto-confirms risky shell
commands that remain inside the workspace, but keeps the workspace sandbox
active and refuses commands flagged as writing outside it. It does not override
a command explicitly classified as `deny` by the model. It applies in both the
interactive UI and `--print` mode; use it only when you trust the task.

## Command approval

The `bash` tool is the one place an agent can do irreversible damage —
deleting files, rewriting git history, wiping a disk. Two independent layers
guard it:

### 1. The model self-classifies

The model is asked to set `permission` on every command:

| Value | Meaning |
|---|---|
| `safe` | Read-only or clearly harmless |
| `ask` | Destructive or risky — needs user approval |
| `deny` | Refuse, do not even ask |

### 2. A static classifier double-checks

The model's word is not trusted. Soluna scans the command text for destructive
patterns regardless of what the model claims. Anything matched is flagged:

| Pattern | Example |
|---|---|
| Recursive or forced deletion | `rm -rf`, `rm -f` |
| Deletion from filesystem root | `rm -rf /` |
| Git history rewrites | `git reset --hard`, `git clean -fdx`, `git filter-branch` |
| Force pushes / destructive git | `git push --force`, `git rm --cached`, `git remote rm` |
| Disk and system operations | `mkfs`, `dd if=… of=…`, `shutdown`, `reboot`, `halt`, `poweroff` |
| Process killing | `kill -9`, `pkill -9` |
| Root escalation | `sudo`, `su` |
| Remote pipe-to-shell | `curl … \| bash`, `wget … \| sh` |
| Downloaded files into system dirs | `curl -o /etc/…` |
| Remote writes | `curl -X PUT/POST/PATCH` |
| Broad permission changes | `chmod -R`, `chown -R`, `chmod 777` |
| Writes outside the workspace | `echo x > /etc/hosts`, `tee ~/.bashrc` |

### The approval dialog

When a command is flagged, Soluna stops and asks:

```text
? Permission                                                    1/2
Soluna wants to run a command flagged as risky.

Command:
  rm -rf build

Reason: recursive delete (rm -r)

› Allow this command
  Deny
```

- **Allow** runs it once.
- **Deny** refuses; the agent sees a "rejected by the user" error and must
  adapt.

A `deny` permission from the model refuses without any dialog. In `--print`
mode there is no one to ask, so flagged commands are refused outright.

### Philosophy

The classifier is deliberately conservative. A false positive only costs you
a keypress; a false negative can cost a file system. When in doubt, Soluna asks.

## Logging

Soluna writes a daily JSON log:

```
~/.soluna/logs/soluna-YYYY-MM-DD.log
```

One object per line:

```json
{"ts":"2026-08-09T16:51:08.009Z","level":"info","message":"starting","cwd":"/home/you/proj"}
```

What is logged:

- startup (cwd, provider, model, flags)
- provider retries (attempt, error)
- compaction runs
- tool errors
- crashes (`uncaughtException`, `unhandledRejection`, `SIGTERM`)

**Secrets are redacted** before anything is written: `sk-…` keys, long
tokens, `Bearer …` headers never appear in the log. Errors and warnings are
always written; debug detail requires `-v` or `SOLUNA_DEBUG=1`. Logging is
fire-and-forget — a slow or failing disk can never block the agent.

## Project instructions (AGENTS.md)

If the workspace contains `AGENTS.md` — or `CLAUDE.md` as a fallback — its
contents are injected into the system prompt:

```text
# Project Instructions (from /home/you/proj/AGENTS.md)

Follow these project-specific rules. They take precedence over generic
habits when they conflict.
```

This is the standard convention shared by Claude Code, Codex and opencode, so
existing instruction files work unchanged. Use it for build/test commands,
code conventions, and "do not touch" areas. A broken file is ignored rather
than fatal. See [extending.md](extending.md) for what makes a good AGENTS.md.

## Failure handling philosophy

Three rules hold across everything above:

1. **Never lose work silently.** Sessions save atomically and frequently; a
   crash mid-write cannot truncate a file.
2. **Never fail the whole agent for one problem.** A corrupt session, a
   failed MCP server, a broken log disk, a missing models.dev — each is
   isolated and reported, never fatal.
3. **Fail loud where it matters.** Provider auth errors are not retried
   (they would fail identically); transient network errors are retried with
   backoff. The distinction is deliberate and tested.
