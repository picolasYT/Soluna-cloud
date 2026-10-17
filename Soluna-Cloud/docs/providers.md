# Providers

Soluna works with **13 providers out of the box** plus any OpenAI-compatible
endpoint you add yourself. Providers that require a key can be configured two
ways: with an environment variable, or entirely from the UI with `/setkey`.

## The catalog

### No API key required

| Provider | id | Endpoint | Notes |
|---|---|---|---|
| OpenCode Zen | `zen` | `https://opencode.ai/zen/v1` | Free models, the default |
| Ollama | `ollama` | `http://localhost:11434/v1` | Local models |
| LM Studio | `lmstudio` | `http://localhost:1234/v1` | Local models |

Free Zen models include `deepseek-v4-flash-free`, `big-pickle`,
`mimo-v2.5-free`, `longcat-2.0-free`, `nemotron-3-ultra-free`,
`north-mini-code-free`, `laguna-s-2.1-free` and `ling-3.0-tiny-free`.

### API key required

| Provider | id | Env var |
|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `google` | `GEMINI_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Together AI | `together` | `TOGETHER_API_KEY` |
| xAI Grok | `xai` | `XAI_API_KEY` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` |

All of them speak the OpenAI chat-completions format, so one generic adapter
serves them all. OpenRouter lists its models at runtime (`dynamic`); the
others ship a curated starting list you can extend.

## Two ways to provide a key

### 1. Environment variable (recommended for scripts)

```bash
export GROQ_API_KEY="gsk_..."
soluna -p groq -m llama-3.3-70b-versatile
```

The environment **always wins** over a stored key, and keeps secrets out of
any file.

### 2. Stored key via the UI

```text
/setkey groq
```

Soluna asks for the key with a masked input and saves it to `config.json` under
`apiKeys`. No shell setup needed. Remove a stored key with:

```text
/setkey groq -
```

Or edit `~/.soluna/config.json` directly and delete the `apiKeys.groq` entry.

### Precedence summary

```
Environment variable  >  stored key (config.json)  >  no key
```

A provider with no key available is marked **needs a key** in the provider
list. Select it and Soluna jumps straight to the key form.

## Switching providers and models

```
/providers   -> pick a provider, or add a custom one
/models      -> pick a model, or add a custom one
```

Both save your choice to `config.json`, so next launch restores it. Flags
`-p`/`-m` override the saved choice for that run only.

## Local models (Ollama / LM Studio)

Both expose OpenAI-compatible endpoints locally:

- **Ollama**: start `ollama serve`, pull a model, then run
  `soluna -p ollama -m qwen2.5-coder`. Models are listed at runtime.
- **LM Studio**: enable the local server (default port 1234), then
  `soluna -p lmstudio`.

No key is needed; these are the cheapest way to try Soluna with a model you
control.

## Adding a custom provider

Any endpoint that implements `POST /chat/completions` (OpenAI shape) can be
added — no code, no restart:

```
/providers  ->  + Add a custom provider
```

The form asks for:

| Field | Required | Notes |
|---|---|---|
| ID | yes | A short identifier, e.g. `myllm` |
| Label | yes | Shown in the provider list |
| Base URL | yes | e.g. `http://localhost:8080/v1` |
| API key | optional | Either typed here (stored) or set via an env var |

You can also write it directly into `config.json`:

```json
{
  "customProviders": {
    "myllm": {
      "label": "My LLM",
      "baseUrl": "http://localhost:8080/v1",
      "apiKeyEnv": "MY_LLM_KEY",
      "models": [{ "id": "llama-3", "label": "Llama 3" }]
    }
  }
}
```

`apiKeyEnv` names the environment variable that holds the key; omit it (or
set `null`) when no key is needed. Streaming and tool calling are used
automatically when the endpoint supports them.

Custom providers override built-ins with the same id, so you can replace a
default endpoint with your own.

## Adding custom models

A model released after this version can be added without upgrading:

```
/models  ->  + Add a custom model
```

Or in `config.json`:

```json
{
  "customModels": {
    "openai": [{ "id": "gpt-5-preview", "label": "GPT-5 Preview" }]
  }
}
```

## Auto-detection

With no `-p` and no saved provider, Soluna picks a default from the
environment. It checks, in order: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`
and the others. If none is present it falls back to `zen`, which needs no
key. This is why Soluna works out of the box.

## Context limits

Soluna fetches real context windows from [models.dev](https://models.dev) and
caches them in `~/.soluna/models.json`. The status bar shows how much of the
window you are using, and compaction triggers at 80%. If models.dev is
unreachable, conservative built-in defaults are used. See
[compaction.md](compaction.md).
