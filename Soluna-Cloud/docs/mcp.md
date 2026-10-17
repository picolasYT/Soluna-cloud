# MCP servers

Soluna is a [Model Context Protocol](https://modelcontextprotocol.io) client,
so any MCP server's tools become Soluna's tools. This page covers the
configuration, the TUI workflow, naming, transport and failure handling.

## Configuration

MCP servers live in `~/.soluna/mcp.json`, in the same format as Claude Code:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/projects"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    }
  }
}
```

Each entry has three fields:

| Field | Required | Purpose |
|---|---|---|
| `command` | yes | Executable to spawn |
| `args` | no | Argument array |
| `env` | no | Extra environment variables for the server process |

## Adding from the TUI

```text
/mcp  ->  + Add an MCP server
```

asks for a name, command and arguments. The definition is saved to
`mcp.json` and the new tools load after a restart.

## Naming

Tools are namespaced so they can never collide with built-ins or with each
other:

```
mcp__<server>__<tool>
```

For example `mcp__github__create_issue`. Status lines read naturally:

```text
  ⏵ Running create_issue on github
  ✓ Finished create_issue on github
```

The namespace is the server name (`github`) plus the tool name
(`create_issue`).

## Transport

Soluna speaks **JSON-RPC 2.0** over the server's stdin/stdout with newline
framing, and performs the standard handshake:

```
initialize -> notifications/initialized -> tools/list
```

`stderr` is ignored, since most servers log progress there. Only the stdio
transport is implemented today; HTTP/SSE transports are not yet supported.

## Failure handling

Servers connect **in parallel** at startup. One that fails is reported and
skipped; the rest still load. A failed server never stops Soluna from starting.
To see why a server failed:

```bash
SOLUNA_DEBUG=1 soluna
```

Check status any time with `/mcp`, which shows each server and its
connection state.

## Tools from MCP vs built-ins

| | Built-in tools | MCP tools |
|---|---|---|
| Source | `src/core/tools/` | external servers |
| Names | `read`, `edit`, … | `mcp__<server>__<tool>` |
| Sandbox | workspace sandbox applies | server-side |
| Availability | always | if a server is configured and loads |

MCP tools are ordinary tools inside the loop — the model sees their
descriptions, calls them, and reads their results exactly like a built-in.

## Examples of MCP servers

- **filesystem** — read/write files outside the sandbox (the server owns the
  path scope).
- **github** — issues, PRs, CI runs, code review.
- **postgres** — run queries, inspect schemas.
- **slack, notion, linear** — post messages, manage tickets.
- **custom** — any server you write yourself, in any language, as long as it
  speaks JSON-RPC over stdio.

## Skipping MCP

```bash
soluna --no-mcp
```

Useful when a server is slow to start, or when you are debugging tool
behaviour and want to isolate the built-ins.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server does not appear | Restart Soluna — servers load at startup |
| Connection error | Run `SOLUNA_DEBUG=1`; fix the command, args or env |
| Tool not listed | The server loaded but exposed no tools; check the server |
| Two tools collide | Impossible — the `mcp__<server>__<tool>` namespace prevents it |

See also [tools.md](tools.md) and [troubleshooting.md](troubleshooting.md).
