# Sessions

Every conversation is a **session**. Soluna saves it as you work, so quitting is
never lossy, and you can resume any past conversation — for the same project
or another.

## Where sessions live

```
~/.soluna/sessions/<YYYY-MM-DD>-<project>-<random>.json
```

Each file is the full conversation history, the provider and model used, the
working directory, and a timestamp. Sessions are scoped to a **project** — a
stable hash of the working directory — so `~/.soluna/sessions/` is shared across
projects but each project only sees its own sessions.

## Autosave

The current session is written to disk automatically:

- **on every change**, debounced by ~1.5 seconds, so rapid back-and-forth
  does not hammer the disk;
- **atomically** (write to a temp file, then rename), so a crash mid-write
  can never truncate a session;
- **on exit**.

A disk failure never takes down the conversation — save errors are swallowed
and the in-memory session continues. You can force a save at any time with
`/save`.

## Starting, continuing, resuming

| Action | How |
|---|---|
| New session | `soluna` |
| Resume the most recent session in this project | `soluna --continue` or `-c`, or `/resume` inside the TUI |
| Resume a specific session | `/sessions`, pick one |
| Headless list | `soluna --sessions` |

Resuming restores the full transcript, the summary from any compaction, and
the token counters — the status bar starts where you left off.

## Browsing sessions

Inside the TUI:

```text
/sessions
```

shows the sessions for the current project, newest first: title (first
message), timestamp, message count. Select one to load it.

From the shell:

```bash
soluna --sessions
```

prints a headless list (id, timestamp, title) and exits — handy in scripts
and CI.

## Session file format

A session file is one JSON object:

```json
{
  "id": "2026-08-09-a1b2c3d4e5f6-9f2a1b3c",
  "projectKey": "a1b2c3d4e5f6",
  "cwd": "/home/you/project",
  "provider": "zen",
  "model": "big-pickle",
  "title": "add validation to the signup endpoint",
  "summary": null,
  "usage": { "input": 4123, "output": 890, "turns": 4, "toolCalls": 9 },
  "messages": [
    { "role": "user", "content": "add validation to the signup endpoint" },
    { "role": "assistant", "content": "Let me look at the handler…", "tool_calls": [] }
  ],
  "updatedAt": 1784612000000
}
```

The format is plain JSON on purpose: you can read, back up, or archive
sessions by hand, and Soluna's tests use the same files.

## Pruning

`config.json` has `maxSessions` (default **50**). When a session is saved and
the count exceeds the limit, the oldest sessions are pruned. Raise it if you
work across many projects:

```json
{ "maxSessions": 200 }
```

## Corruption safety

A session file that cannot be parsed is skipped, never fatal. `listSessions`
and `loadSession` both tolerate a broken file, so one corrupt JSON in the
folder cannot prevent Soluna from starting or listing the rest.

## Clearing vs deleting

- `/clear` empties the in-memory conversation. The old file stays on disk;
  the new conversation is saved from that point on.
- There is no built-in delete command; remove the file manually:

  ```bash
  rm ~/.soluna/sessions/<id>.json
  ```
