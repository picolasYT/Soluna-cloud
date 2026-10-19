import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat as statP } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";

import { Workspace, WorkspaceError, isInside } from "../core/workspace.js";
import { createReadTool } from "../core/tools/read.js";
import { createWriteTool } from "../core/tools/write.js";
import { createEditTool } from "../core/tools/edit.js";
import { createBashTool } from "../core/tools/bash.js";
import { createAskTool } from "../core/tools/ask.js";
import { createGlobTool } from "../core/tools/glob.js";
import { createGrepTool } from "../core/tools/grep.js";
import { createLsTool } from "../core/tools/ls.js";
import { createSkillTool } from "../core/skills.js";
import { connectMCPServers } from "../core/mcp.js";
import { discoverSkills } from "../core/skills.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { compactConversation } from "../core/compaction.js";
import { createProvider } from "../providers/index.js";
import { buildCatalog, getProviderInfo, getDefaultModel, isProviderReady } from "../providers/catalog.js";
import {
  loadConfig,
  saveConfig,
  saveApiKeySet,
  resolveApiKey,
  resolveApiKeys,
  loadMCPServers,
  saveMCPServer,
  removeMCPServer,
  saveCustomProvider,
  addCustomModel,
  Session,
  SOLUNA_HOME,
  listSessions,
  loadSession,
  deleteSession,
  pruneSessions,
  CONFIG_PATH,
} from "../core/session-store.js";
import { loadModelLimits, getContextLimit } from "../core/tokens.js";
import { renderSkillsPrompt } from "../core/skills.js";
import { uiBridge } from "../core/ui-bridge.js";
import { indexHtml, loginHtml, newRunId, clientBase } from "./events.js";
import { Jobs } from "./jobs.js";
import { fetchOpenRouterModels } from "./openrouter-models.js";
import { createZip } from "./zip.js";

const execFileAsync = promisify(execFile);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Single-user web server for Soluna.
 *
 * Reuses the exact same core as the TUI — workspace sandbox, tools, provider
 * adapters, session store, retries and compaction — but drives it through a
 * small HTTP/SSE layer instead of Ink. Risky commands await browser approval
 * unless the operator explicitly enables --unsafe.
 */
export async function startWebServer(options = {}) {
  const {
    cwd = process.cwd(),
    host = "localhost",
    port = Number(process.env.SOLUNA_WEB_PORT || process.env.ZYN_WEB_PORT) || 3456,
    addDir = [],
    unsafe = false,
    noMcp = false,
    initialProvider = null,
    initialModel = null,
    initialPrompt = null,
    token = null,
    modelFetch = fetch,
    cleanWorkspace = false,
    restrictedUser = false,
    persistKeys = null,
  } = options;

  // Real context limits (local cache, network optional).
  await loadModelLimits({ timeoutMs: 3000 });

  const chatWorkspacesDir = join(SOLUNA_HOME, "chat-workspaces");
  async function createChatWorkspace() {
    await mkdir(chatWorkspacesDir, { recursive: true });
    return mkdtemp(join(chatWorkspacesDir, "chat-"));
  }
  const workspace = new Workspace(cleanWorkspace ? await createChatWorkspace() : cwd, { allow: addDir, unsafe });

  const config = await loadConfig();
  let autoApprove = config.webAutoApprove === true;
  let runHasProgress = false;
  const catalog = buildCatalog(config);
  let providerId = initialProvider || config.provider || null;
  let model = initialModel || config.model || getDefaultModel(providerId, catalog);

  let session = new Session({ cwd: workspace.root, provider: providerId, model });
  const workspacesDir = join(SOLUNA_HOME, "workspaces");
  let openRouterModelCache = null;
  let openRouterModelPending = null;
  let keyUpdates = Promise.resolve();
  const jobs = new Jobs();
  jobs.on("idle", () => broadcastState());
  jobs.on("failed", ({ error }) => {
    if (/\b429\b/.test(error)) {
      const daily = /free-models-per-day|openrouter_free_tier_daily|daily quota/i.test(error);
      append("error", {
        text: (daily ? "Se agotó la cuota diaria gratuita de OpenRouter. Esperá al reinicio de la cuota o elegí un modelo de pago."
          : "El proveedor limitó temporalmente este modelo. Esperá un poco o elegí otro modelo para continuar.")
          + (runHasProgress ? " Los archivos y el avance de la tarea quedaron guardados." : ""),
        retryable: true,
        resume: runHasProgress,
      });
    } else if (/\b503\b/.test(error) && /overload|temporarily|upstream|provider/i.test(error)) {
      append("error", {
        text: "El modelo seleccionado está saturado temporalmente. Elegí otro modelo en la barra superior o reenviá tu mensaje dentro de unos minutos.",
        retryable: true,
        resume: runHasProgress,
      });
    } else if (/\b(aborted|abortada|cancelled|canceled)\b/i.test(error)) {
      pushError("La solicitud fue cancelada.");
    } else pushError(error);
  });
  const clients = new Set();
  const usage = { input: 0, output: 0, turns: 0, toolCalls: 0 };
  let activeController = null;

  // Latest events per client id, so a reconnecting tab can catch up.
  const journal = [];
  const journalCap = 400;

  // Pending `ask` request awaiting the browser's answer.
  let askRequest = null;
  let askResolver = null;
  let askCleanup = null;

  /* ------------------------------ publishing ------------------------- */

  function broadcast(payload) {
    journal.push(payload);
    if (journal.length > journalCap) journal.splice(0, journal.length - journalCap);
    for (const client of clients) {
      client.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  }

  function append(kind, payload = {}) {
    broadcast({ ...payload, kind });
  }

  function pushSystem(text) {
    append("system", { text });
  }

  function pushError(text) {
    append("error", { text });
  }

  /* ------------------------------ tools --------------------------------- */

  const confirm = async ({ command, reason }) => {
    if (unsafe || autoApprove) return true;
    const answers = await uiBridge.ask({
      signal: activeController?.signal,
      purpose: "command-permission",
      questions: [{
        header: "Permitir acción",
        question: `Soluna necesita tu permiso para ejecutar este comando:\n\n${command}\n\nMotivo: ${reason}`,
        custom: false,
        multiple: false,
        options: [
          { label: "Permitir una vez", description: "Ejecutar únicamente este comando" },
          { label: "Rechazar", description: "Continuar sin ejecutarlo" },
        ],
      }],
    });
    return answers?.[0]?.answers?.includes("Permitir una vez") === true;
  };

  const tools = [
    createReadTool(workspace),
    createWriteTool(workspace),
    createEditTool(workspace),
    ...(!restrictedUser ? [createBashTool(workspace, { confirm })] : []),
    createLsTool(workspace),
    createGlobTool(workspace),
    createGrepTool(workspace),
    createAskTool(),
  ];

  const skills = await discoverSkills(workspace.root);
  if (skills.length > 0) tools.push(createSkillTool(skills));

  let mcpStatus = [];
  let mcpErrors = [];
  if (!noMcp && !restrictedUser) {
    const mcps = await connectMCPServers({ onStatus: (s) => mcpStatus.push(s) });
    tools.push(...(mcps.tools || []));
    mcpErrors = mcps.errors || [];
    const seen = new Map();
    for (const s of mcpStatus) seen.set(s.name, s);
    mcpStatus = [...seen.values()];
  }

  /* --------------------------- ask bridge ------------------------------- */

  // `ask` requests from tools surface as a web request; the browser answers.
  uiBridge.connect(
    ({ signal, ...request }) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve([]);
        askRequest = request;
        askResolver = resolve;
        const onAbort = () => finishAsk([]);
        signal?.addEventListener("abort", onAbort, { once: true });
        askCleanup = () => signal?.removeEventListener("abort", onAbort);
        append("ask", { request });
      }),
  );

  /** Resolve an ask request from the browser. */
  function finishAsk(answers) {
    const resolver = askResolver;
    const request = askRequest;
    askCleanup?.();
    askCleanup = null;
    askResolver = null;
    askRequest = null;
    append("ask-done", { id: request?.id, answers: answers ?? [] });
    resolver?.(answers ?? []);
  }

  /* --------------------------- turns / runs ----------------------------- */

  function currentState() {
    return {
      provider: providerId,
      autoApprove,
      model,
      cwd: workspace.root,
      skills: skills.length,
      mcp: mcpStatus.filter((s) => s.phase === "ready").length,
      contextUsed: estimateSessionTokens(session.messages),
      contextLimit: getContextLimit(model),
      usage: { ...usage },
      queued: jobs.queuedCount,
      busy: Boolean(jobs.running),
      currentRunId: jobs.running?.id || null,
      askRequest,
    };
  }

  function broadcastState() {
    append("state", currentState());
  }

  /** Estimate tokens for the current session messages. */
  function estimateSessionTokens(messages) {
    let total = 0;
    for (const msg of messages || []) {
      total += 4;
      if (typeof msg.content === "string") total += Math.ceil(msg.content.length / 4);
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === "text") total += Math.ceil(part.text.length / 4);
        }
      }
      for (const tc of msg.tool_calls || []) {
        total += Math.ceil((tc.function?.name || "").length / 4);
        total += Math.ceil(
          (typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})).length / 4,
        );
      }
    }
    return total;
  }

  /**
   * Build a provider from saved config. Returns null (with a system note)
   * when the provider is not configured.
   */
  function buildProvider(id) {
    const info = getProviderInfo(id, catalog);
    if (!info) {
      pushError(`Unknown provider "${id}". Use the /providers UI to add it.`);
      return null;
    }
    if (info.requiresKey && !isProviderReady(id, catalog, config)) {
      pushError(
        `Provider "${info.label}" needs an API key. Set the ${info.envKey} environment variable or save it from the UI.`,
      );
      return null;
    }
    return createProvider(id, { model, catalog, config, onKeyRotation: ({ nextKey, keyCount }) => {
      pushSystem(`Cambiando a la clave ${nextKey} de ${keyCount} de ${info.label}.`);
    } });
  }

  /** Push a tool entry into the transcript with the same shape as the TUI. */
  function pushToolResult(entry) {
    append("tool", { entry });
    usage.toolCalls += 1;
  }

  /** Run a conversation turn. Returns the updated message list. */
  async function runTurn(text) {
    runHasProgress = false;
    const userMessage = { role: "user", content: text };
    session.messages.push(userMessage);

    append("user", { text });

    let provider = buildProvider(providerId);
    if (!provider) {
      session.messages.pop();
      return;
    }

    const controller = new AbortController();
    activeController = controller;

    const upsert = (id, patch) => {
      append("tool-live", { id, ...patch });
    };

    try {
      const result = await runAgentLoop({
      messages: session.messages,
      tools,
      provider,
      model,
      cwd: workspace.root,
      signal: controller.signal,
      systemExtra: renderSkillsPrompt(skills),
      previousSummary: session.summary || null,

      onMessage: ({ content }) => append("stream", { content }),
      onMessageFinal: (text) => {
        append("stream-end", { text });
      },

      onToolPrepare: ({ id, name, args, complete }) => {
        if (!name) return;
        upsert(id, { name, phase: "preparing", args, complete });
      },
      onToolCall: ({ id, name, args }) => {
        upsert(id, { name, phase: "running", args });
      },
      onToolResult: ({ id, name, args, result: res, error }) => {
        const entry = {
          id,
          name,
          phase: error ? "error" : "done",
          args: args || {},
          filePath: ["write", "edit"].includes(name) && args?.path ? relPath(args.path) : null,
          label: toolLabel(name, args || {}),
          duration: "",
          diff: res?.details?.diff || null,
          error: error ? error.message : null,
          output: null,
        };
        if (!entry.diff && !error) {
          const out = (res?.content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
          if (out && name !== "ask") entry.output = out;
        }
        pushToolResult(entry);
      },
      onCheckpoint: ({ messages, summary }) => {
        session.messages = messages.filter((message) => message.role !== "system");
        session.summary = summary || session.summary;
        runHasProgress = true;
        session.scheduleSave();
      },
      onUsage: (u) => {
        const input = u.prompt_tokens ?? u.input_tokens ?? 0;
        const output = u.completion_tokens ?? u.output_tokens ?? 0;
        usage.input += input;
        usage.output += output;
        broadcastState();
      },
      onCompaction: (e) => {
        if (e.phase === "start") {
          append("compacting", { message: "Context full — compacting…" });
        } else if (e.phase === "done") {
          append("compacting-end", { message: "" });
          pushSystem(
            `Compacted ${e.compactedCount} messages · ${formatTokens(e.before)} → ${formatTokens(e.after)} tokens`,
          );
        } else if (e.phase === "failed") {
          append("compacting-end", { message: "" });
          pushError(`Compaction failed: ${e.error}`);
        }
      },
      onRetryResolved: () => append("retry-end"),
      onRetry: ({ attempt, attempts, delay, error }) => {
        append("retry", {
          message: `El proveedor está ${/\b429\b/.test(error.message) ? "limitando las solicitudes" : "temporalmente ocupado"}. Reintento ${attempt}/${attempts - 1} en ${Math.ceil(delay / 1000)}s…`,
        });
      },
      });

      session.messages = result.messages.filter((m) => m.role !== "system");
      session.summary = result.summary || session.summary;
      usage.turns += 1;
      session.usage = { ...usage };
      session.scheduleSave();
    } catch (error) {
      // A failed generation must not leave an unanswered user message in the
      // model context; otherwise retrying would send the prompt twice.
      if (session.messages.at(-1) === userMessage) session.messages.pop();
      if (runHasProgress) await session.flush();
      throw error;
    } finally {
      append("retry-end");
      if (activeController === controller) activeController = null;
      broadcastState();
    }
  }

  function toolLabel(name, args) {
    const a = args || {};
    switch (name) {
      case "read":
        return `Read ${relPath(a.path)}`;
      case "write":
        return `Write ${relPath(a.path)}${a.isNew ? " (new file)" : ""}`;
      case "edit":
        return `Edit ${relPath(a.path)}`;
      case "bash":
        return `Ran ${String(a.command || "").slice(0, 80)}`;
      case "glob":
        return `Glob ${a.pattern}`;
      case "grep":
        return `Grep ${a.pattern}`;
      case "ls":
        return `List ${relPath(a.path || ".")}`;
      case "skill":
        return `Skill ${a.name}`;
      default:
        return name;
    }
  }

  function relPath(p) {
    if (!p) return "";
    try {
      const abs = resolve(workspace.root, p);
      const rel = abs.startsWith(workspace.root) ? abs.slice(workspace.root.length + 1) : abs;
      return rel || ".";
    } catch {
      return String(p);
    }
  }

  async function resolveWorkspaceFile(pathname, directory = workspace.root) {
    const root = await realpath(directory);
    const requested = resolve(root, String(pathname || ""));
    if (requested === root || !requested.startsWith(root + sep)) throw new Error("La ruta del archivo no es válida.");
    const actual = await realpath(requested);
    if (!actual.startsWith(root + sep)) throw new Error("El archivo está fuera del proyecto.");
    const info = await statP(actual);
    if (!info.isFile()) throw new Error("La ruta seleccionada no es un archivo.");
    return { actual, info, path: relative(root, actual).split(sep).join("/") };
  }

  async function listWorkspaceFiles({ directory = workspace.root, limit = 600, archive = false } = {}) {
    const root = await realpath(directory);
    const files = [];
    const ignored = new Set([".git", "node_modules", ".soluna"]);
    async function walk(directory, depth = 0) {
      if (depth > (archive ? 100 : 12)) {
        if (archive) throw new Error("Hay demasiados niveles de carpetas para exportar.");
        return;
      }
      if (files.length >= limit) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (archive) throw error; return; }
      for (const entry of entries) {
        if (files.length >= limit) break;
        if (entry.name.startsWith(".") && [".git", ".soluna"].includes(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name)) await walk(absolute, depth + 1);
        } else if (entry.isFile()) {
          try {
            const info = await statP(absolute);
            const path = relative(root, absolute).split(sep).join("/");
            files.push({ path, name: entry.name, size: info.size, modified: info.mtime.toISOString(), type: extname(entry.name).slice(1).toLowerCase() || "archivo" });
          } catch (error) { if (archive) throw error; }
        }
      }
    }
    await walk(root);
    return files.sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit);
  }

  /* ------------------------------ actions ------------------------------- */

  /** A queued action: message, compact, clear, /cwd, ... */
  function enqueue(kind, payload, run) {
    return jobs.push({
      id: newRunId(),
      kind,
      label: payload?.label || "",
      run: async (drain) => {
        try {
          const result = await run(drain);
          return result;
        } finally {
          broadcastState();
        }
      },
    });
  }

  function handleMessage(text) {
    if (!text || !String(text).trim()) return;
    const clean = String(text).trim();

    if (clean.startsWith("/")) {
      enqueue("command", { label: clean }, () => handleCommand(clean));
      return;
    }

    const id = enqueue("message", { label: clean.slice(0, 60) }, async () => {
      await runTurn(clean);
    });
    append("run-queued", { id });
  }

  async function handleCommand(raw) {
    const text = String(raw || "").trim();
    const spaceAt = text.indexOf(" ");
    const name = (spaceAt === -1 ? text.slice(1) : text.slice(1, spaceAt)).toLowerCase();
    const args = spaceAt === -1 ? "" : text.slice(spaceAt + 1).trim();

    pushSystem(`/${name} ${args}`.trim());

    switch (name) {
      case "clear":
        session.messages = [];
        session.summary = null;
        session.scheduleSave();
        append("clear", {});
        pushSystem("Conversation cleared.");
        break;
      case "compact":
        enqueue("compact", {}, async () => {
          await compactNow();
        });
        break;
      case "save":
        session.flush().then((ok) =>
          pushSystem(ok ? `Session saved: ${session.id}` : "Could not save session."),
        );
        break;
      case "resume":
        {
          const data = await latestAccessibleSession();
          if (!data) return pushSystem("No previous session for this directory.");
          await session.flush();
          await activateSessionWorkspace(data);
          applySession(data);
        }
        break;
      case "cwd": {
        if (!args) return pushSystem(`Working directory: ${workspace.root}`);
        try {
          const next = workspace.chdir(args);
          session.cwd = next;
          pushSystem(`Working directory: ${next}`);
          broadcastState();
        } catch (err) {
          pushError(err.message);
        }
        break;
      }
      default:
        pushSystem(`Unknown command: /${name}. Try /help`);
    }
  }

  async function compactNow() {
    if (session.messages.length < 3) {
      pushSystem("Nothing to compact yet.");
      return;
    }
    let provider = buildProvider(providerId);
    if (!provider) return;

    append("compacting", { message: "Writing handoff document…" });
    try {
      const result = await compactConversation({
        messages: session.messages,
        provider,
        model,
        cwd: workspace.root,
        previousSummary: session.summary || null,
        keepRecent: 4,
      });
      append("compacting-end", { message: "" });
      if (result.skipped) {
        pushSystem("Nothing to compact yet.");
      } else {
        session.messages = result.messages;
        session.summary = result.summary || session.summary;
        session.scheduleSave();
        pushSystem(
          `Compacted ${result.compactedCount} messages · ${formatTokens(result.before)} → ${formatTokens(result.after)} tokens`,
        );
      }
    } catch (err) {
      append("compacting-end", { message: "" });
      pushError(`Compaction failed: ${err.message}`);
    }
    broadcastState();
  }

  function applySession(data) {
    session = Session.fromJSON(data);
    providerId = session.provider || providerId;
    model = session.model || model;
    Object.assign(usage, session.usage);
    const restored = session;
    append("session-restored", {
      id: restored.id,
      messages: restored.messages,
    });
    pushSystem(
      `Resumed session ${restored.id} · ${restored.messages.length} messages${restored.summary ? " · has handoff document" : ""}`,
    );
    broadcastState();
  }

  function sessionAccessible(data) {
    if (!data?.cwd) return false;
    const path = resolve(data.cwd);
    if (!cleanWorkspace) return path === workspace.root;
    return (path !== resolve(chatWorkspacesDir) && isInside(resolve(chatWorkspacesDir), path))
      || (path !== resolve(workspacesDir) && isInside(resolve(workspacesDir), path));
  }

  async function accessibleSessions() {
    const entries = await listSessions({ cwd: cleanWorkspace ? undefined : workspace.root, limit: Number.MAX_SAFE_INTEGER });
    return entries.filter(sessionAccessible).slice(0, 30);
  }

  async function latestAccessibleSession() {
    const [latest] = await accessibleSessions();
    return latest ? loadSession(latest.id) : null;
  }

  async function activateSessionWorkspace(data) {
    if (!cleanWorkspace) return;
    const actual = await realpath(data.cwd);
    if (!sessionAccessible({ cwd: actual })) throw new Error("Session workspace is unavailable");
    workspace.resetRoot(actual, { allow: addDir });
    append("workspace-changed", { cwd: actual });
  }

  async function workspaceList() {
    await mkdir(workspacesDir, { recursive: true });
    const entries = await readdir(workspacesDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => ({
      id: entry.name,
      name: entry.name.replace(/__/g, "/"),
      path: join(workspacesDir, entry.name),
      active: resolve(workspacesDir, entry.name) === workspace.root,
    }));
  }

  async function switchWorkspace(path) {
    const destination = resolve(workspacesDir, path);
    if (!destination.startsWith(workspacesDir + sep)) throw new Error("Workspace path is invalid");
    const info = await statP(destination);
    if (!info.isDirectory()) throw new Error("Workspace does not exist");
    await session.flush();
    workspace.resetRoot(await realpath(destination), { allow: addDir });
    session = new Session({ cwd: destination, provider: providerId, model });
    Object.assign(usage, session.usage);
    append("clear", {});
    append("workspace-changed", { cwd: destination });
    broadcastState();
    return destination;
  }

  function formatTokens(n) {
    const num = Number(n) || 0;
    if (num < 1000) return String(num);
    if (num < 1000000) return `${(num / 1000).toFixed(num < 10000 ? 1 : 0)}k`;
    return `${(num / 1000000).toFixed(1)}M`;
  }

  /* ------------------------------ provider UI --------------------------- */

  async function getCatalogInfo() {
    const configNow = await loadConfig();
    return {
      providers: catalog.map((p) => ({
        id: p.id,
        label: p.label,
        hint: p.hint,
        requiresKey: p.requiresKey,
        ready: isProviderReady(p.id, catalog, configNow),
        keySource: keySourceOf(p.id, catalog, configNow),
        keyCount: resolveApiKeys(p.id, p.envKey, configNow).length,
        models: p.models,
      })),
      current: { provider: providerId, model },
      autoApprove,
      apiKeys: Object.keys(configNow.apiKeys || {}),
      restrictedUser,
    };
  }

  function keySourceOf(id, cat, cfg) {
    const info = getProviderInfo(id, cat);
    if (!info?.requiresKey) return "not needed";
    if (info.envKey && process.env[info.envKey]) return `from ${info.envKey}`;
    if (cfg?.apiKeys?.[id]) return "saved in config";
    return null;
  }

  async function handleSetProvider(id) {
    const info = getProviderInfo(id, catalog);
    if (!info) throw Object.assign(new Error("Proveedor desconocido."), { status: 400 });
    if (info.requiresKey && !isProviderReady(id, catalog, config)) {
      throw Object.assign(new Error(`Guardá una clave API para ${info.label}.`), { status: 400 });
    }
    providerId = id;
    model = getDefaultModel(id, catalog) || model;
    session.provider = providerId;
    session.model = model;
    session.scheduleSave();
    saveConfig({ provider: providerId, model }).catch(() => {});
    pushSystem(`Provider: ${info.label}`);
    broadcastState();
  }

  async function handleSetModel(id) {
    if (typeof id !== "string" || !id.trim() || id.length > 256) {
      throw Object.assign(new Error("Ingresá un ID de modelo válido."), { status: 400 });
    }
    model = id.trim();
    session.model = model;
    session.scheduleSave();
    saveConfig({ provider: providerId, model }).catch(() => {});
    pushSystem(`Model: ${id}`);
    broadcastState();
  }

  async function handleSaveKey(provider, key) {
    if (!getProviderInfo(provider, catalog)) {
      throw Object.assign(new Error("Elegí un proveedor válido antes de guardar la clave."), { status: 400 });
    }
    if (typeof key !== "string" || !key.trim()) {
      throw Object.assign(new Error("Ingresá una clave API antes de guardarla."), { status: 400 });
    }
    return addProviderKeys(provider, [key]);
  }

  function savedKeys(provider, cfg) {
    return [...new Set([cfg.apiKeys?.[provider], ...(cfg.apiKeyPools?.[provider] || [])].filter(Boolean))];
  }

  function keyId(provider, key) {
    return createHash("sha256").update(`${provider}\0${key}`).digest("hex");
  }

  function keyMetadata(provider, cfg) {
    const info = getProviderInfo(provider, catalog);
    if (!info) throw Object.assign(new Error("Proveedor desconocido."), { status: 400 });
    return {
      provider,
      keys: savedKeys(provider, cfg).map((key, index) => ({ id: keyId(provider, key), label: `Clave ${index + 1}`, masked: key.length > 8 ? `•••• ${key.slice(-4)}` : "••••" })),
      environmentKey: Boolean(info.envKey && process.env[info.envKey]),
      count: resolveApiKeys(provider, info.envKey, cfg).length,
    };
  }

  async function mutateProviderKeys(provider, update) {
    if (!getProviderInfo(provider, catalog)) throw Object.assign(new Error("Proveedor desconocido."), { status: 400 });
    const operation = keyUpdates.then(async () => {
      const cfg = await loadConfig();
      const next = [...new Set(update(savedKeys(provider, cfg)))];
      if (next.length > 50) throw Object.assign(new Error("Podés guardar hasta 50 claves por proveedor."), { status: 400 });
      if (persistKeys) await persistKeys(provider, next);
      await saveApiKeySet(provider, next);
      Object.assign(config, await loadConfig());
      if (provider === "openrouter") { openRouterModelCache = null; openRouterModelPending = null; }
      broadcastState();
      return keyMetadata(provider, config);
    });
    keyUpdates = operation.catch(() => {});
    return operation;
  }

  function addProviderKeys(provider, keys) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 50 || keys.some((key) => typeof key !== "string" || !key.trim() || key.length > 8192 || /\s/.test(key.trim()))) {
      throw Object.assign(new Error("Ingresá claves API válidas, sin espacios ni saltos de línea."), { status: 400 });
    }
    return mutateProviderKeys(provider, (current) => [...current, ...keys.map((key) => key.trim())]);
  }

  /* ------------------------------ HTTP ---------------------------------- */

  function sendJSON(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(payload);
  }

  function sendError(res, status, message) {
    sendJSON(res, status, { error: message });
  }

  function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error("Solicitud demasiado grande."), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  async function readJSONBody(req) {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw Object.assign(new Error("La solicitud debe ser un objeto JSON."), { status: 400 });
    }
    return body;
  }

  function authOk(req) {
    if (!token) return true;
    const header = req.headers.authorization || "";
    const q = new URL(req.url, "http://localhost");
    const cookie = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("soluna_access="));
    let cookieToken = "";
    try { cookieToken = cookie ? decodeURIComponent(cookie.slice("soluna_access=".length)) : ""; } catch {}
    return secureEqual(header.replace(/^Bearer\s+/i, ""), token)
      || secureEqual(q.searchParams.get("token") || "", token)
      || secureEqual(cookieToken, token);
  }

  function secureEqual(candidate, expected) {
    const left = Buffer.from(String(candidate));
    const right = Buffer.from(String(expected));
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async function handleApi(req, res, path, query) {
    if (req.method === "POST" && path === "/api/auth") {
      if (!token) return sendError(res, 400, "Cloud access token is not configured");
      const body = await readJSONBody(req);
      if (!secureEqual(body.token || "", token)) return sendError(res, 401, "Invalid access token");
      const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
      res.setHeader("Set-Cookie", `soluna_access=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/api/events") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`retry: 2000\n\n`);

      const client = {
        id: newRunId(),
        res,
        write: (chunk) => {
          try {
            res.write(chunk);
          } catch {
            // Socket closed; the close handler cleans up.
          }
        },
      };
      clients.add(client);

      // Send the journal so a (re)connecting tab catches up.
      for (const evt of journal) {
        if (evt.kind === "ask" || evt.kind === "ask-done") continue;
        client.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      // Always send a fresh snapshot of the current state.
      client.write(`data: ${JSON.stringify({ kind: "state", ...currentState() })}\n\n`);

      req.on("close", () => {
        clients.delete(client);
        try {
          res.end();
        } catch {}
      });
      return;
    }

    if (req.method === "GET" && path === "/api/state") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, currentState());
    }

    if (req.method === "GET" && path === "/api/files") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const files = await listWorkspaceFiles();
      return sendJSON(res, 200, { files, truncated: files.length >= 600 });
    }

    if (req.method === "GET" && path === "/api/files/zip") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const directory = workspace.root;
      const id = session.id;
      const files = await listWorkspaceFiles({ directory, limit: 10001, archive: true });
      if (!files.length) return sendError(res, 400, "Todavía no hay archivos para descargar.");
      if (files.length > 10000) return sendError(res, 413, "La tarea supera el límite de 10.000 archivos por ZIP.");
      const limit = 50 * 1024 * 1024;
      if (files.reduce((sum, file) => sum + file.size, 0) > limit) return sendError(res, 413, "Los archivos superan el límite de 50 MB por ZIP.");
      const entries = [];
      let bytes = 0;
      for (const item of files) {
        const file = await resolveWorkspaceFile(item.path, directory);
        if (bytes + file.info.size > limit) return sendError(res, 413, "Los archivos superan el límite de 50 MB por ZIP.");
        const data = await readFile(file.actual);
        bytes += data.length;
        if (bytes > limit) return sendError(res, 413, "Los archivos superan el límite de 50 MB por ZIP.");
        entries.push({ path: item.path, data });
      }
      const zip = await createZip(entries);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="soluna-tarea-${id}.zip"`,
        "Content-Length": zip.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(zip);
    }

    if (req.method === "GET" && path === "/api/file") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      try {
        const file = await resolveWorkspaceFile(query.get("path"));
        const ext = extname(file.path).toLowerCase();
        const contentType = MIME[ext] || "application/octet-stream";
        const download = query.get("download") === "1";
        if (file.info.size > (download ? 50 : 2) * 1024 * 1024) return sendError(res, 413, download ? "El archivo supera el límite de descarga de 50 MB." : "El archivo supera el límite de vista previa de 2 MB. Podés descargarlo.");
        const safeName = file.path.split("/").at(-1).replace(/[\r\n"\\]/g, "_");
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https:; font-src data: https:; connect-src https:;",
        });
        return res.end(await readFile(file.actual));
      } catch (error) {
        return sendError(res, 404, error.message || "No se encontró el archivo.");
      }
    }

    if (req.method === "GET" && path === "/api/config") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, await getCatalogInfo());
    }

    if (req.method === "POST" && path === "/api/settings/auto-approve") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      if (restrictedUser) return sendError(res, 403, "Los comandos del servidor están disponibles solo para el administrador.");
      const body = await readJSONBody(req);
      if (typeof body.enabled !== "boolean") return sendError(res, 400, "La opción debe ser verdadera o falsa.");
      await saveConfig({ webAutoApprove: body.enabled });
      autoApprove = body.enabled;
      if (autoApprove && askRequest?.purpose === "command-permission") {
        finishAsk([{ answers: ["Permitir una vez"] }]);
      }
      broadcastState();
      return sendJSON(res, 200, { autoApprove });
    }

    if (req.method === "GET" && path === "/api/models") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const provider = query.get("provider");
      const info = getProviderInfo(provider, catalog);
      if (!info) return sendError(res, 400, "Proveedor desconocido.");
      if (provider !== "openrouter") return sendJSON(res, 200, { models: info.models || [], source: "built-in" });

      const cfg = await loadConfig();
      const apiKey = resolveApiKey("openrouter", info.envKey, cfg);
      if (!apiKey) return sendError(res, 400, "Guardá tu clave de OpenRouter para cargar todos los modelos.");
      if (query.get("refresh") !== "1" && openRouterModelCache?.expires > Date.now() && openRouterModelCache.key === apiKey) {
        return sendJSON(res, 200, { models: openRouterModelCache.models, source: "openrouter" });
      }
      try {
        if (openRouterModelPending?.key !== apiKey) {
          const pending = fetchOpenRouterModels(apiKey, modelFetch).then((models) => {
            openRouterModelCache = { key: apiKey, models, expires: Date.now() + 10 * 60 * 1000 };
            return models;
          }).finally(() => {
            if (openRouterModelPending?.promise === pending) openRouterModelPending = null;
          });
          openRouterModelPending = { key: apiKey, promise: pending };
        }
        const models = await openRouterModelPending.promise;
        return sendJSON(res, 200, { models, source: "openrouter" });
      } catch (error) {
        return sendError(res, 502, error.message || "No se pudo consultar OpenRouter.");
      }
    }

    if (req.method === "GET" && path === "/api/workspaces") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, { current: workspace.root, workspaces: await workspaceList() });
    }

    if (req.method === "POST" && path === "/api/workspaces/import") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      if (jobs.running || jobs.queuedCount) return sendError(res, 409, "Wait for the active task to finish before changing projects");
      const body = await readJSONBody(req);
      let repoUrl;
      try { repoUrl = new URL(String(body.url || "")); } catch { return sendError(res, 400, "Enter a valid public GitHub repository URL"); }
      const parts = repoUrl.pathname.split("/").filter(Boolean);
      if (repoUrl.protocol !== "https:" || repoUrl.hostname !== "github.com" || parts.length < 2) {
        return sendError(res, 400, "Only public GitHub HTTPS repository URLs are supported");
      }
      const owner = parts[0];
      const repository = parts[1].replace(/\.git$/i, "");
      if (![owner, repository].every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
        return sendError(res, 400, "Repository URL contains unsupported characters");
      }
      const id = `${owner}__${repository}`;
      const destination = join(workspacesDir, id);
      await mkdir(workspacesDir, { recursive: true });
      try {
        await statP(destination);
      } catch {
        try {
          await execFileAsync("git", ["clone", "--depth=1", `https://github.com/${owner}/${repository}.git`, destination], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
        } catch (error) {
          return sendError(res, 400, `Could not import repository: ${(error.stderr || error.message || "git clone failed").toString().trim().slice(0, 500)}`);
        }
      }
      try { await switchWorkspace(id); } catch (error) { return sendError(res, 400, error.message); }
      return sendJSON(res, 200, { ok: true, id, cwd: workspace.root });
    }

    if (req.method === "POST" && path === "/api/workspaces/switch") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      if (jobs.running || jobs.queuedCount) return sendError(res, 409, "Wait for the active task to finish before changing projects");
      const body = await readJSONBody(req);
      if (!/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/.test(String(body.id || ""))) return sendError(res, 400, "Workspace id is invalid");
      try {
        const cwd = await switchWorkspace(body.id);
        return sendJSON(res, 200, { ok: true, cwd });
      } catch (error) { return sendError(res, 404, error.message); }
    }

    if (req.method === "POST" && path === "/api/sessions/new") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      if (jobs.running || jobs.queuedCount) return sendError(res, 409, "Wait for the active task to finish before starting a new session");
      await session.flush();
      if (cleanWorkspace) {
        workspace.resetRoot(await createChatWorkspace(), { allow: addDir });
        append("workspace-changed", { cwd: workspace.root });
      }
      session = new Session({ cwd: workspace.root, provider: providerId, model });
      Object.assign(usage, session.usage);
      append("clear", {});
      broadcastState();
      return sendJSON(res, 200, { ok: true, id: session.id });
    }

    if (req.method === "POST" && path === "/api/message") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      if (typeof body.text !== "string" || !body.text.trim()) return sendError(res, 400, "Ingresá un mensaje de texto.");
      handleMessage(body.text);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/ask") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      if (!askRequest || body.id !== askRequest.id) return sendError(res, 409, "Esta decisión ya no está pendiente.");
      if (!Array.isArray(body.answers) || body.answers.some((answer, index) => {
        const question = askRequest.questions[index];
        return !question || !Array.isArray(answer?.answers) || answer.answers.some((value) =>
          typeof value !== "string" || (question.custom === false && !question.options.some((option) => option.label === value))
        ) || (!question.multiple && answer.answers.length > 1);
      }) || (body.answers.length !== 0 && body.answers.length !== askRequest.questions.length)) {
        return sendError(res, 400, "La respuesta no es válida.");
      }
      finishAsk(body.answers);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/cancel") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      const running = jobs.running?.id === body.id;
      if (running) { activeController?.abort(); if (askRequest) finishAsk([]); }
      const ok = running || jobs.cancel(body.id);
      return sendJSON(res, 200, { ok });
    }

    if (req.method === "POST" && path === "/api/set-provider") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      if (jobs.running || jobs.queuedCount) return sendError(res, 409, "Esperá a que termine la tarea para cambiar el proveedor.");
      await handleSetProvider(body.provider);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/set-model") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      if (jobs.running || jobs.queuedCount) return sendError(res, 409, "Esperá a que termine la tarea para cambiar el modelo.");
      await handleSetModel(body.model);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/api/keys") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, keyMetadata(query.get("provider"), await loadConfig()));
    }

    if (req.method === "POST" && path === "/api/keys") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      return sendJSON(res, 200, await addProviderKeys(body.provider, body.keys));
    }

    if (req.method === "DELETE" && path === "/api/keys") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      if (typeof body.id !== "string" || !/^[a-f0-9]{64}$/.test(body.id)) return sendError(res, 400, "Identificador de clave inválido.");
      const result = await mutateProviderKeys(body.provider, (keys) => {
        if (!keys.some((key) => keyId(body.provider, key) === body.id)) throw Object.assign(new Error("La clave ya no existe."), { status: 404 });
        return keys.filter((key) => keyId(body.provider, key) !== body.id);
      });
      return sendJSON(res, 200, result);
    }

    if (req.method === "POST" && path === "/api/save-key") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      await handleSaveKey(body.provider, body.key);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/api/sessions/export") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      res.setHeader("Content-Disposition", `attachment; filename="soluna-${session.id}.json"`);
      return sendJSON(res, 200, { ...session.toJSON(), usage: { ...usage } });
    }

    if (req.method === "GET" && path === "/api/sessions") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, await accessibleSessions());
    }

    if (req.method === "GET" && path === "/api/sessions/latest") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, (await latestAccessibleSession()) || null);
    }

    if (req.method === "POST" && path === "/api/sessions/load") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      if (jobs.running || jobs.queuedCount) return sendError(res, 409, "Esperá a que termine la tarea para retomar otra sesión.");
      if (body.id != null && (typeof body.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.id))) return sendError(res, 400, "ID de sesión inválido.");
      const data = body.id ? await loadSession(body.id) : await latestAccessibleSession();
      if (!sessionAccessible(data)) return sendError(res, 404, "Session not found");
      await session.flush();
      await activateSessionWorkspace(data);
      applySession(data);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/sessions/delete") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = await readJSONBody(req);
      if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.id)) return sendError(res, 400, "ID de sesión inválido.");
      const data = await loadSession(body.id);
      if (!sessionAccessible(data)) return sendError(res, 404, "Session not found");
      if (body.id === session.id) return sendError(res, 409, "No se puede eliminar la sesión activa.");
      const ok = await deleteSession(body.id);
      return sendJSON(res, 200, { ok });
    }

    return sendError(res, 404, "Not found");
  }

  async function serveStatic(req, res, pathname) {
    if (pathname === "/" || pathname === "/index.html" || pathname === "/app") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(indexHtml());
    }
    const base = clientBase();
    const filePath = normalize(join(base, pathname));
    if (!filePath.startsWith(base + sep) && filePath !== base) {
      return sendError(res, 403, "Forbidden");
    }
    try {
      await statP(filePath);
    } catch {
      return sendError(res, 404, "Not found");
    }
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    createReadStream(filePath).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") return sendJSON(res, 200, { ok: true, name: "Soluna" });

      if (path.startsWith("/api/")) {
        return await handleApi(req, res, path, url.searchParams);
      }
      if (!authOk(req)) {
        if (req.method === "GET" && (path === "/" || path === "/index.html")) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(loginHtml());
        }
        return sendError(res, 401, "Unauthorized");
      }
      if (token && url.searchParams.get("token") && secureEqual(url.searchParams.get("token"), token)) {
        const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
        res.setHeader("Set-Cookie", `soluna_access=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`);
      }
      return await serveStatic(req, res, path);
    } catch (err) {
      const storageError = ["EACCES", "EPERM", "EROFS", "ENOSPC"].includes(err.code);
      const message = storageError
        ? `No se pudo guardar la clave en ${SOLUNA_HOME}: ${err.code}. Revisá el disco y los permisos de escritura del servicio en Render.`
        : err.message || "Internal error";
      sendError(res, err.status || (err instanceof SyntaxError ? 400 : 500), message);
    }
  });

  // Graceful shutdown.
  server.on("close", () => {
    uiBridge.connect(null);
    for (const client of clients) {
      try {
        client.res.end();
      } catch {}
    }
  });

  // Bind, falling back to the next free ports when the default is busy
  // (a previous run, or another app on Termux/Windows). Other failures get a
  // readable message instead of an unhandled 'error' event.
  let boundPort = port;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(boundPort, host);
      });
      break;
    } catch (err) {
      if (err.code === "EADDRINUSE" && attempt < 10 && !process.env.SOLUNA_WEB_PORT_STRICT) {
        boundPort += 1;
        continue;
      }
      if (err.code === "EADDRINUSE") throw new Error(`Port ${boundPort} is already in use. Pick another with --port.`);
      if (err.code === "EACCES") throw new Error(`No permission to listen on ${host}:${boundPort}. Use a port above 1024.`);
      if (err.code === "EADDRNOTAVAIL") throw new Error(`Cannot bind to "${host}". Use --host localhost or --host 0.0.0.0.`);
      throw err;
    }
  }

  const started = new Date().toLocaleString();
  pushSystem(
    `${APP_DISPLAY_NAME} web server started · ${workspace.root} · ${providerId || "no provider"}/${model || "default"}`,
  );

  return {
    server,
    port: boundPort,
    host,
    cwd: workspace.root,
    providerId,
    model,
    tokens: token ? [token] : [],
    jobs,
    async close() {
      activeController?.abort();
      if (askRequest) finishAsk([]);
      for (const client of clients) client.res.end();
      await jobs.waitIdle();
      await session.flush();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Resolve `latestSession` lazily to avoid a circular import at module load. */
async function latestSession(cwd) {
  const { latestSession: fn } = await import("../core/session-store.js");
  return fn(cwd);
}

import { APP_DISPLAY_NAME } from "../config/constants.js";
void APP_DISPLAY_NAME; // silence unused import lint (used above via closure)
