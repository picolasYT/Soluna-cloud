#!/usr/bin/env node

import { resolve } from "node:path";
import { createReadTool } from "../src/core/tools/read.js";
import { createWriteTool } from "../src/core/tools/write.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { createBashTool } from "../src/core/tools/bash.js";
import { createAskTool } from "../src/core/tools/ask.js";
import { createGlobTool } from "../src/core/tools/glob.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { Workspace } from "../src/core/workspace.js";
import { canAutoAcceptCommand } from "../src/core/permissions.js";
import { uiBridge } from "../src/core/ui-bridge.js";
import { runAgentLoop } from "../src/core/agent-loop.js";
import { createProvider, detectProvider } from "../src/providers/index.js";
import { getDefaultModel, buildCatalog } from "../src/providers/catalog.js";
import { discoverSkills, createSkillTool, renderSkillsPrompt } from "../src/core/skills.js";
import { connectMCPServers } from "../src/core/mcp.js";
import { loadConfig, latestSession, listSessions } from "../src/core/session-store.js";
import { APP_DISPLAY_NAME, APP_VERSION, APP_REPO } from "../src/config/constants.js";
import { toolStatus } from "../src/core/tool-status.js";
import { formatTokens, loadModelLimits } from "../src/core/tokens.js";
import { logger, setDebug } from "../src/core/logger.js";

/* --- Crash handling ------------------------------------------------ */
// These keep a stack trace in ~/.soluna/logs so a crash is diagnosable
// instead of a silent exit. The agent still dies — but on purpose.

process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", { error: err.stack || String(err) });
  logger.flush().finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", {
    error: reason instanceof Error ? reason.stack || reason.message : String(reason),
  });
});

process.on("SIGTERM", () => {
  logger.info("terminated by SIGTERM");
  logger.flush().finally(() => process.exit(0));
});

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    provider: null,
    model: null,
    prompt: null,
    cwd: process.cwd(),
    tui: true,
    verbose: false,
    resume: false,
    listSessions: false,
    noMcp: false,
    addDir: [],
    unsafe: false,
    autoAccept: false,
    web: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider":
      case "-p":
        options.provider = args[++i];
        break;
      case "--model":
      case "-m":
        options.model = args[++i];
        break;
      case "--cwd":
      case "-d":
        options.cwd = resolve(args[++i]);
        break;
      case "--add-dir":
        options.addDir.push(resolve(args[++i]));
        break;
      case "--unsafe":
        options.unsafe = true;
        break;
      case "--auto-accept":
        options.autoAccept = true;
        break;
      case "--print":
      case "--no-tui":
        options.tui = false;
        break;
      case "--prompt":
        options.prompt = args[++i];
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--continue":
      case "-c":
        options.resume = true;
        break;
      case "--sessions":
        options.listSessions = true;
        break;
      case "--no-mcp":
        options.noMcp = true;
        break;
      case "--web":
      case "-w":
        options.web = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (!args[i].startsWith("-")) options.prompt = args[i];
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
${APP_DISPLAY_NAME} v${APP_VERSION} — a minimal, extensible AI coding agent
Based on: ${APP_REPO}

Usage:
  soluna [options] [prompt]

Options:
  -p, --provider <id>    Provider to use (see /providers for the full list)
  -m, --model <id>       Model to use
  -d, --cwd <path>       Working directory
  -c, --continue         Resume the most recent session here
  --print, --no-tui      Plain output, no interactive UI
  -w, --web              Start the web UI server (http://localhost:3456)
  --prompt <text>        Initial prompt
  --add-dir <path>       Allow read/write access to an extra directory
  --sessions             List saved sessions and exit
  --no-mcp               Skip loading MCP servers
  --auto-accept          Auto-approve risky commands inside the workspace only
  --unsafe               Disable the workspace sandbox and command approval
  -v, --verbose          Verbose output
  -h, --help             Show this help

Slash commands (inside the TUI):
  /help        List all commands          /skills      Installed skills
  /providers   Switch or add a provider   /mcp         Manage MCP servers
  /models      Switch or add a model      /config      Config paths and settings
  /theme       Change colour theme        /sessions    Browse past sessions
  /tools       Tools available            /resume      Resume latest session
  /status      Tokens and context         /save        Save session now
  /cwd <path>  Change directory           /compact     Summarise to free context
  /clear       Clear conversation         /exit        Quit

Providers with no API key required:
  zen        OpenCode Zen free models (default)
  ollama     Local models via Ollama
  lmstudio   Local models via LM Studio

Providers needing a key (set the env var, then pick with /providers):
  openai OPENAI_API_KEY            anthropic ANTHROPIC_API_KEY
  google GEMINI_API_KEY            groq      GROQ_API_KEY
  deepseek DEEPSEEK_API_KEY        mistral   MISTRAL_API_KEY
  openrouter OPENROUTER_API_KEY    together  TOGETHER_API_KEY
  xai XAI_API_KEY                  cerebras  CEREBRAS_API_KEY

Add any other OpenAI-compatible endpoint from the TUI:
  /providers -> "+ Add a custom provider"

Configuration lives in ~/.soluna/:
  config.json              Preferences, custom providers and models
  mcp.json                 MCP server definitions
  skills/<name>/SKILL.md   Your skills
  sessions/                Saved conversations

Examples:
  soluna                                  Start the interactive UI
  soluna "add tests for user.js"          Run a single task
  soluna -p groq -m llama-3.3-70b-versatile
  soluna --continue                       Pick up where you left off
  soluna --print "list the files here"    Plain output, no UI
`);
}

async function buildTools(workspace, { noMcp = false, confirm = null } = {}) {
  const tools = [
    createReadTool(workspace),
    createWriteTool(workspace),
    createEditTool(workspace),
    createBashTool(workspace, { confirm }),
    createLsTool(workspace),
    createGlobTool(workspace),
    createGrepTool(workspace),
    createAskTool(),
  ];

  const skills = await discoverSkills(workspace.root);
  if (skills.length > 0) tools.push(createSkillTool(skills));

  let mcpStatus = [];
  if (!noMcp) {
    const { tools: mcpTools, errors } = await connectMCPServers({
      onStatus: (s) => mcpStatus.push(s),
    });
    tools.push(...mcpTools);
    // Keep only the final status per server.
    const seen = new Map();
    for (const s of mcpStatus) seen.set(s.name, s);
    mcpStatus = [...seen.values()];
    for (const e of errors) {
      if (process.env.SOLUNA_DEBUG || process.env.ZYN_DEBUG) console.error(`MCP ${e.name}: ${e.error}`);
    }
  }

  return { tools, skills, mcpStatus };
}

function renderDiff(diff) {
  if (!diff) return "";
  const out = [`    +${diff.added} -${diff.removed}${diff.isNew ? "  (new file)" : ""}`];
  const shown = diff.lines.filter((l) => l.type !== "ctx").slice(0, 10);
  for (const l of shown) {
    out.push(`    ${l.type === "add" ? "+" : "-"} ${l.text.slice(0, 70)}`);
  }
  const hidden = diff.lines.filter((l) => l.type !== "ctx").length - shown.length;
  if (hidden > 0) out.push(`    ... ${hidden} more lines`);
  return out.join("\n");
}

function formatToolResult(res) {
  if (res.error) return `  ✗ ${res.error.message}`;
  const head = `  ✓ ${toolStatus(res.name, "done", res.args || {})}`;
  const diff = res.result?.details?.diff;
  if (diff) return `${head}\n${renderDiff(diff)}`;
  const text = (res.result?.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!text) return head;
  const lines = text.split("\n");
  return lines.length > 5
    ? `${head}\n${lines.slice(0, 5).map((l) => `      ${l}`).join("\n")}\n      ... (${lines.length - 5} more lines)`
    : `${head}\n${lines.map((l) => `      ${l}`).join("\n")}`;
}

async function printMode(options) {
  const catalog = options.catalog;
  const config = options.config;
  const providerName = options.provider || detectProvider();
  const model = options.model || getDefaultModel(providerName, catalog);
  const provider = createProvider(providerName, {
    model,
    catalog,
    config,
    onKeyRotation: ({ failedKey, nextKey, keyCount, status }) =>
      console.log(`OpenRouter key ${failedKey}/${keyCount} hit HTTP ${status}; retrying with key ${nextKey}/${keyCount}.`),
  });
  const workspace = new Workspace(options.cwd, { allow: options.addDir, unsafe: options.unsafe });
  // Headless mode refuses risky commands unless the user explicitly opted in.
  const confirm = options.autoAccept
    ? async ({ command, reason }) => canAutoAcceptCommand({ command, reason, workspaceRoot: workspace.root, unsafe: options.unsafe })
    : null;
  const { tools, skills } = await buildTools(workspace, { noMcp: options.noMcp, confirm });

  if (!options.prompt) {
    console.error("Error: --print requires a prompt.");
    process.exit(1);
  }

  console.log(`\n${APP_DISPLAY_NAME} v${APP_VERSION}`);
  console.log(`Provider: ${providerName} | Model: ${model || "default"}`);
  console.log(`Prompt: ${options.prompt}\n`);

  let finalText = "";
  let totalIn = 0;
  let totalOut = 0;

  const result = await runAgentLoop({
    messages: [{ role: "user", content: options.prompt }],
    tools,
    provider,
    model,
    cwd: options.cwd,
    systemExtra: renderSkillsPrompt(skills),
    onMessage: (msg) => {
      finalText = msg.content || "";
    },
    onRetry: ({ attempt, attempts, delay, error }) =>
      console.log(
        `  ↻ ${String(error.message).slice(0, 70)} — retry ${attempt}/${attempts - 1} in ${Math.round(delay / 100) / 10}s`,
      ),
    onToolCall: (call) => console.log(`  ⏵ ${toolStatus(call.name, "running", call.args)}`),
    onToolResult: (res) => console.log(formatToolResult(res)),
    onUsage: (u) => {
      totalIn += u.prompt_tokens ?? u.input_tokens ?? 0;
      totalOut += u.completion_tokens ?? u.output_tokens ?? 0;
    },
  });

  if (finalText) console.log(`\n${finalText}`);
  console.log(
    `\nDone · ${result.iterations} iteration(s) · ↑${formatTokens(totalIn)} ↓${formatTokens(totalOut)} tokens`,
  );
}

async function main() {
  const options = parseArgs();

  // `soluna web` starts the shared web server launcher.
  if (options.web) {
    const { runWeb } = await import("../src/web/launcher.js");
    return runWeb(process.argv.slice(2).filter((a) => a !== "--web" && a !== "-w"));
  }

  setDebug(options.verbose || Boolean(process.env.SOLUNA_DEBUG || process.env.ZYN_DEBUG));

  logger.info("starting", {
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    tui: Boolean(options.tui),
    unsafe: options.unsafe,
    autoAccept: options.autoAccept,
    addDirs: options.addDir,
  });

  // Real context limits (local cache, network optional).
  await loadModelLimits({ timeoutMs: 3000 });

  // `--sessions` is headless: list and exit.
  if (options.listSessions) {
    const sessions = await listSessions({ cwd: options.cwd, limit: 50 });
    if (sessions.length === 0) {
      console.log(`No saved sessions in ${options.cwd}`);
    } else {
      console.log(`Saved sessions in ${options.cwd}:`);
      for (const s of sessions) {
        const when = new Date(s.updatedAt).toISOString();
        const preview = (s.title || "").replace(/\s+/g, " ").slice(0, 70);
        console.log(`  ${s.id}  ${when}  ${preview}`);
      }
    }
    return;
  }

  // Saved preferences and custom providers. Flags take precedence.
  const config = await loadConfig();
  const catalog = buildCatalog(config);
  const providerName = options.provider || config.provider || detectProvider();
  const model = options.model || config.model || getDefaultModel(providerName, catalog);

  if (!options.tui || !process.stdin.isTTY) {
    await printMode({ ...options, provider: providerName, model, catalog, config });
    return;
  }

  const workspace = new Workspace(options.cwd, { allow: options.addDir, unsafe: options.unsafe });

  const { tools, skills, mcpStatus } = await buildTools(workspace, {
    noMcp: options.noMcp,
    confirm: options.autoAccept
      ? async ({ command, reason }) => canAutoAcceptCommand({ command, reason, workspaceRoot: workspace.root, unsafe: options.unsafe })
      : async ({ command, reason }) => uiBridge.confirm({ command, reason }),
  });
  const resumeSession = options.resume ? await latestSession(options.cwd) : null;

  const { startTUI } = await import("../src/tui/index.js");
  await startTUI({
    initialProvider: providerName,
    initialModel: model,
    initialConfig: config,
    cwd: options.cwd,
    workspace,
    tools,
    skills,
    mcpStatus,
    resumeSession,
    initialPrompt: options.prompt,
  });
}

main().catch((err) => {
  logger.error("fatal startup error", { error: err.stack || String(err) });
  console.error(`Fatal error: ${err.message}`);
  logger.flush().finally(() => process.exit(1));
});
