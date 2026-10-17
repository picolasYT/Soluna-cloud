# Configuration reference

Everything Soluna persists lives under `~/.soluna/`. Override the location with `SOLUNA_HOME`.

## config.json

```json
{
  "provider": "zen",
  "model": "big-pickle",
  "theme": "soluna",
  "autoCompact": true,
  "compactThreshold": 0.80,
  "retries": 3,
  "maxSessions": 50,
  "customProviders": {},
  "customModels": {}
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `provider` | string / null | `null` | Provider restored at startup |
| `model` | string / null | `null` | Model restored at startup |
| `theme` | string | `"soluna"` | soluna, dark, nord, dracula, gruvbox, tokyo, light |
| `autoCompact` | boolean | `true` | Compact automatically when context fills |
| `compactThreshold` | number | `0.80` | Fraction of the window that triggers compaction |
| `retries` | number | `3` | Attempts on transient provider failures |
| `maxSessions` | number | `50` | Sessions kept before pruning the oldest |
| `customProviders` | object | `{}` | Your own OpenAI-compatible endpoints |
| `customModels` | object | `{}` | Extra models keyed by provider id |

Writes are serialised and atomic: concurrent saves cannot lose each other's changes, and a crash mid-write cannot truncate the file.

## Custom providers

```json
{
  "customProviders": {
    "myllm": {
      "label": "My LLM",
      "baseUrl": "http://localhost:8080/v1",
      "apiKeyEnv": "MY_LLM_KEY",
      "models": [
        { "id": "llama-3", "label": "Llama 3" },
        { "id": "llama-3-70b", "label": "Llama 3 70B" }
      ]
    }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `label` | yes | Shown in `/providers` |
| `baseUrl` | yes | Must serve `POST /chat/completions` |
| `apiKeyEnv` | no | Omit or null when no key is needed |
| `models` | no | Starting list; more can be added later |

The endpoint must accept the OpenAI chat-completions shape. Streaming (`stream: true`) and tool calling are used when the endpoint supports them.

## Custom models

```json
{
  "customModels": {
    "openai": [{ "id": "gpt-5-preview", "label": "GPT-5 Preview" }],
    "myllm": [{ "id": "mixtral", "label": "Mixtral" }]
  }
}
```

Works for built-in providers too, which is how you use a model released after this version shipped.

## Environment variables

| Variable | Purpose |
|---|---|
| `SOLUNA_HOME` | Relocate the whole config directory (used verbatim) |
| `SOLUNA_DEBUG` | Verbose logging + MCP connection errors |
| `OPENAI_API_KEY` etc. | Provider keys, one per provider |

## Logs

Notable events are written as JSON lines to `~/.soluna/logs/soluna-YYYY-MM-DD.log`:
retries, compaction, tool errors and crashes. Secrets in the message text are
redacted. `-v` or `SOLUNA_DEBUG=1` enables debug detail.

## Workspace and permissions

`read`, `write`, `edit`, `ls`, `glob` and `grep` refuse paths outside the
working directory (`../` traversal, absolute paths elsewhere, and symlinks
pointing out are all blocked). Allow extra directories with `--add-dir
<path>`, or disable every guard with `--unsafe`.

Risky `bash` commands — recursive deletes, `git reset --hard`, force pushes,
disk operations, writes outside the workspace — are refused until the user
approves them in the TUI. In `--print` mode they are refused outright.

## Precedence

Command-line flags beat saved config, which beats auto-detection:

```
--provider / --model  >  ~/.soluna/config.json  >  detectProvider()
```

For upgrades, Soluna continues using an existing `~/.zyn/` data directory if
there is no `~/.soluna/` directory yet. `ZYN_HOME` and `ZYN_DEBUG` remain
accepted as legacy environment variables. `SOLUNA_HOME` takes precedence
when both home variables are set.

`detectProvider()` checks for keys in the environment and falls back to `zen`, which needs none.
