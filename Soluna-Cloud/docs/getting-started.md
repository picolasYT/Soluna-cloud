# Getting started

This page takes you from nothing to a running Soluna session, then gives you a
guided tour of a real task.

## Requirements

- **Node.js 18 or newer** (Node 20+ recommended). Soluna uses Node's
  built-in modules plus Ink and React for its terminal interface.
- A terminal. Soluna's interface needs a real TTY; in pipes or CI use `--print`.

You do **not** need an API key to try Soluna. The default provider (`zen`)
serves free models without authentication.

## Install

After the npm package is published:

```bash
npm install --global soluna-agent
soluna --help
```

To run from a local source checkout instead:

```bash
# In the Soluna project directory:
npm install
npm link          # optional: puts `soluna` on your PATH
```

If you skip `npm link`, run it with:

```bash
node bin/soluna.js
```

Verify the install:

```bash
soluna --help
```

You should see the usage summary. That means the CLI parses, the modules
load, and you are ready to go.

## Your first session

Start Soluna in a directory with some code (or a scratch directory — it works
anywhere):

```bash
cd ~/my-project
soluna
```

You will see a bordered input line at the bottom:

```text
❯ Ask anything · / for commands
```

Type a question and press `enter`. For example:

```text
❯ what files are in this repository and what does the main one do?
```

The agent will announce what it is doing, then call tools. You will see
something like:

```text
Let me look at the layout first.

  ⏵ Running ls on .
  ✓ Finished ls on . 3ms
  ⏵ Running read on package.json 4ms
```

When it is done, the final answer appears, and the input line returns.

## The basics in sixty seconds

- **`/` lists commands** — start typing `/` and every command filters live.
  `tab` completes.
- **Keep typing while it works** — messages queue and are sent when the
  current task finishes. Slash commands run immediately.
- **`ctrl+c` cancels the current turn**; press again to quit.
- **`/theme`** changes colours; **`/providers`** switches models.
- **Everything persists** — quit with `/exit` and start again with `soluna -c`
  (or `/resume`) to continue where you left off.

## A guided task

Let's walk through a realistic task so you recognise what is happening
underneath. We will use a small script.

Say your project has `src/util.js`:

```js
export function priceWithTax(price, taxRate) {
  return price + price * taxRate;
}
```

Ask Soluna:

```text
❯ the priceWithTax function breaks for percentage rates; add a test for it
```

What happens, step by step:

1. **Plan in the open.** The model streams its reasoning as text before any
   tool runs.
2. **It reads.** Soluna calls `read` on `src/util.js` (and probably your test
   directory) to learn the existing style.
3. **It edits.** `edit` makes a targeted change and reports the diff:
   ```text
     ✓ Edited the file src/util.js 28ms
       +3 -1
       -   return price + price * taxRate;
       +   const asFraction = taxRate > 1 ? taxRate / 100 : taxRate;
       +   return price + price * asFraction;
   ```
4. **It verifies.** If your project has a test command, Soluna runs it via
   `bash` and reports the result. If the command is destructive or risky, it
   will ask for your permission first (see [safety.md](safety.md)).
5. **It answers.** The final message summarises what changed and how to
   verify it.

## Where things live

| Path | What is there |
|---|---|
| `~/.soluna/config.json` | Preferences, custom providers, stored keys |
| `~/.soluna/sessions/` | One JSON file per conversation |
| `~/.soluna/skills/` | Your skills |
| `~/.soluna/logs/` | Daily JSON logs |
| `<project>/AGENTS.md` | Project instructions (optional) |

Set `SOLUNA_HOME` to relocate everything:

```bash
SOLUNA_HOME=/tmp/soluna-sandbox soluna
```

See [configuration.md](configuration.md) for the full layout.

## Next steps

- [The interface (TUI)](tui.md) — read the status bar, change themes, keys
- [Providers](providers.md) — use a paid provider or a local model
- [Tools](tools.md) — everything the agent can do
