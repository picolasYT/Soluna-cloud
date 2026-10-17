# The interface (TUI)

Soluna's interactive interface is a terminal UI built with a **custom ANSI
renderer** — no Ink, no React, no heavy framework. This keeps RAM usage at
~15-25MB (vs 100+MB for Ink-based TUIs) and avoids the scroll-loop and text
duplication bugs that plague Ink-based renderers.

Everything is keyboard-driven. This page explains each part of the screen,
the themes, and every key.

## Anatomy of the screen

```text
┌──────────────────────────────────────────────────────────────┐
│ Soluna v1.0.0                              zen/big-pickle      │
│                                                              │
│ ❯ what files are here?                                      │
│                                                              │
│ Let me look at the layout.                                   │
│                                                              │
│   ✓ Read package.json 3ms                                    │
│   ✓ Ran ls . 5ms                                             │
│                                                              │
│ There are four source directories: src/, test/, ...          │
│                                                              │
│ ❯ Ask anything · / for commands                              │
│ zen/big-pickle · ████░░░░ 32% · 41k/128k · ↑2.1k ↓480 · 4t │
└──────────────────────────────────────────────────────────────┘
```

| Element | What it shows |
|---|---|
| Header | App name, version, and the active provider/model |
| Transcript | The conversation so far: your messages, the agent's text, tool results |
| Streaming text | The assistant text currently being generated, before it is committed |
| Input line | Where you type. Stays active while the agent works |
| Status bar | Provider · model, context bar, tokens, turns |

## The status bar

The bottom line tells you exactly what the agent is doing and how much
"memory" it has left:

```text
zen/big-pickle · ████░░░░ 32% · 41k/128k · ↑2.1k ↓480 · 4t
```

Left to right:

- `zen/big-pickle` — provider id and model id.
- `████░░░░ 32%` — the fraction of the context window in use, as a bar.
  At 80% Soluna automatically compacts (see [compaction.md](compaction.md)).
- `41k/128k` — tokens used vs the model's context limit (real values come
  from [models.dev](https://models.dev) when reachable).
- `↑2.1k ↓480` — input tokens and output tokens for this session.
- `4t` — number of conversation turns.

The bar's width tracks your terminal width, so it works at any size.

## Slash commands

Type `/` to open the command menu. Every command filters as you type;
`tab` completes.

Full reference: [commands.md](commands.md).

## Overlays

Commands that need a choice — providers, models, themes, sessions, tools,
skills, MCP, config, help — open a floating window. The window always shows a
menu or form and a hint line at the bottom explaining what the keys do.

Forms (for example adding a custom provider) validate as you go and show
helpful errors instead of silently accepting bad input. Press `esc` to close
any overlay.

## Themes

Six themes are built in: `dark`, `nord`, `dracula`, `gruvbox`, `tokyo` and
`light`. Switch live with `/theme`; the choice is saved to `config.json` and
restored next launch.

| Theme | Vibe |
|---|---|
| `dark` | Neutral dark, the default |
| `nord` | Cool blues and greys |
| `dracula` | Purple-tinted dark |
| `gruvbox` | Warm retro |
| `tokyo` | Night-city neon |
| `light` | For bright terminals |

## Keyboard reference

| Key | Action |
|---|---|
| `enter` | Send, or select |
| `enter` while busy | Queue the message for after the current task |
| `↑` `↓` | Move through options, or through input history |
| `space` | Toggle an option in multi-select |
| `tab` | Complete a `/` command |
| `esc` | Clear input, close overlay, or cancel a form |
| `ctrl+c` | Cancel the running task; press again to quit |
| `ctrl+a` / `ctrl+e` | Jump to start / end of the input line |
| `ctrl+u` | Clear the input line |
| `pgup` / `pgdn` | Page through long lists |

## Typing while the agent works

Soluna deliberately keeps the input line active during a task:

- Type a **message** and press `enter`: it is queued and sent the moment the
  current task finishes.
- Type a **slash command** and press `enter`: it runs immediately, even
  mid-task.

This means you can steer a long-running task without interrupting it.

## Terminal title

Soluna sets the terminal window title to `Soluna - <session>` where `<session>` is
the current session's ID or title. This helps identify which window belongs
to which project when running multiple instances.

## Non-interactive mode

In pipes, scripts and CI there is no TTY. Use `--print` for plain output:

```bash
soluna --print "list every TODO in src" > todos.txt
```

In headless mode streaming output is printed directly, and risky commands are
refused outright because there is no one to approve them. Sessions still save,
so `--continue` works next time. See [cli.md](cli.md).
