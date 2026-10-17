# Context and compaction

A model has a fixed amount of "memory" — the context window. Everything Soluna
sends to the model (system prompt, project instructions, skills index,
conversation history, tool results) lives in that window. When it fills up,
one of two things must happen: the conversation stops, or the oldest content
is condensed. Soluna does the second, automatically.

## How much memory does a model have?

Soluna fetches real context windows from [models.dev](https://models.dev) and
caches them in `~/.soluna/models.json`. When the cache is missing or stale, it
refreshes in the background with a short timeout — your session never blocks
on a network call. If models.dev is unreachable, conservative defaults apply.

The status bar shows how full the window is:

```text
zen/big-pickle · ████░░░░ 32% · 41k/128k · ↑2.1k ↓480 · 4t
```

`41k/128k` is tokens used against the window. `31k` of that might be history;
the rest is the system prompt, your messages and recent tool output.

## When compaction triggers

Two triggers, both to prevent a hard failure:

1. **Automatic, at 80% of the context window.** This is the default
`compactThreshold` in `config.json`. Tune it per-project:
```json
{ "autoCompact": true, "compactThreshold": 0.75 }
```
2. **On overflow, as a safety net.** If a provider rejects a request for
   size despite the estimate (context windows drift between providers and
   versions), Soluna compacts once and retries before giving up.

You can also compact on demand with `/compact` — useful before a long
refactor so the model is not wading through stale history.

## What compaction does

The conversation is split into three parts:

- **Head** — the first user message: the original goal, preserved verbatim.
- **Middle** — everything in between, condensed into a structured document.
- **Tail** — the last 8 messages, kept verbatim because they are the
  immediate work.

The middle is replaced by the handoff document; head and tail remain. The
model never loses the reason the session exists or the last thing it was
doing. Soluna never splits between a tool call and its result.

The `summary` is stored in the session, so a resumed session remembers that
compaction happened.

## The 14-section handoff document

This is not a "summarise the conversation" prompt. It is a fixed, structured
template that forces the model to write down the expensive things a summary
drops — decisions, failures, and user feedback.

| # | Section | Why it exists |
|---|---|---|
| 1 | Original request | The literal goal, in the user's words |
| 2 | Current state | Complete / in progress / blocked |
| 3 | Mental model | How the codebase is organised |
| 4 | Files touched | Every file, what changed and why |
| 5 | Changes made | Concrete edits with snippets |
| 6 | Commands run | With exit codes and what they proved |
| 7 | Decisions | Choices made, alternatives rejected |
| 8 | What was learned | Non-obvious facts about the codebase |
| 9 | Failed attempts | What not to retry, with verbatim errors |
| 10 | User feedback | Corrections and preferences, quoted |
| 11 | Open questions | Anything unresolved |
| 12 | Next steps | Ordered and actionable |
| 13 | Verification | How to confirm the work |
| 14 | Constraints | What must not be violated |

Sections 7, 9 and 10 are the ones a plain summary loses — and the most
expensive to reconstruct. The full prompt lives in
`src/core/compaction-prompt.js`.

## Why 80%?

Compaction needs room to work: generating the handoff document consumes
tokens too. Firing at 80% leaves headroom for the compaction itself, then
plenty of window for continued work. It is a safe default; tune it down if
you notice overflow errors, up if you rarely fill the window.

## Watching it happen

When compaction runs you will see:

```text
⟳ Summarising the conversation to free up context…
```

and afterwards the status bar reflects the freed space. `/status` shows the
summary's existence. The handoff document is part of the conversation, so
the model continues knowing everything important.

## When compaction is skipped

- With `autoCompact: false` in config — then only the overflow safety net
  (still active) and manual `/compact` run.
- When there is nothing to compact (a conversation too small to matter).
- When the user cancels or the signal is aborted.

## Cost and benefit

Compaction trades *fidelity* for *space*: the middle is condensed, not
stored. For long sessions that is usually the right trade — the alternative
is a hard "context too long" error. For short sessions it never runs at all,
so there is no quality cost in normal use.
