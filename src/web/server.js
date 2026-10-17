import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, createReadStream } from "node:fs";
import { mkdir, readdir, stat as statP } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import { Workspace, WorkspaceError } from "../core/workspace.js";
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
  saveApiKey,
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
};

/**
 * Single-user web server for Soluna.
 *
 * Reuses the exact same core as the TUI — workspace sandbox, tools, provider
 * adapters, session store, retries and compaction — but drives it through a
 * small HTTP/SSE layer instead of Ink. `confirm` is auto-approved so the
 * experience matches `--unsafe` (the server binds to localhost by default).
 */
export async function startWebServer(options = {}) {
  const {
    cwd = process.cwd(),
    host = "localhost",
    port = Number(process.env.SOLUNA_WEB_PORT || process.env.ZYN_WEB_PORT) || 3456,
    addDir = [],
    unsafe = true, // web = local server → match `--unsafe` by default
    noMcp = false,
    initialProvider = null,
    initialModel = null,
    initialPrompt = null,
    token = null,
  } = options;

  // Real context limits (local cache, network optional).
  await loadModelLimits({ timeoutMs: 3000 });

  const workspace = new Workspace(cwd, { allow: addDir, unsafe });

  const config = await loadConfig();
  const catalog = buildCatalog(config);
  const providerId = initialProvider || config.provider || null;
  const model = initialModel || config.model || getDefaultModel(providerId, catalog);

  let session = new Session({ cwd, provider: providerId, model });
  const workspacesDir = join(SOLUNA_HOME, "workspaces");
  const jobs = new Jobs();
  const clients = new Set();
  const usage = { input: 0, output: 0, turns: 0, toolCalls: 0 };
  let activeController = null;

  // Latest events per client id, so a reconnecting tab can catch up.
  const journal = [];
  const journalCap = 400;

  // Pending `ask` request awaiting the browser's answer.
  let askRequest = null;
  let askResolver = null;

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

  const confirm = async () => true; // auto-approve: equivalent to --unsafe

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
  let mcpErrors = [];
  if (!noMcp) {
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
    (request) =>
      new Promise((resolve) => {
        askRequest = request;
        askResolver = resolve;
        append("ask", { request });
      }),
  );

  /** Resolve an ask request from the browser. */
  function finishAsk(answers) {
    const resolver = askResolver;
    const request = askRequest;
    askResolver = null;
    askRequest = null;
    append("ask-done", { id: request?.id, answers: answers ?? [] });
    resolver?.(answers ?? []);
  }

  /* --------------------------- turns / runs ----------------------------- */

  function currentState() {
    return {
      provider: providerId,
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
    return createProvider(id, { model, catalog, config });
  }

  /** Push a tool entry into the transcript with the same shape as the TUI. */
  function pushToolResult(entry) {
    append("tool", { entry });
    usage.toolCalls += 1;
  }

  /** Run a conversation turn. Returns the updated message list. */
  async function runTurn(text) {
    session.messages.push({ role: "user", content: text });

    append("user", { text });

    let provider = buildProvider(providerId);
    if (!provider) return;

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
      onRetry: ({ attempt, attempts, delay, error }) => {
        pushSystem(
          `Provider failed: ${String(error.message).slice(0, 90)} — retry ${attempt}/${attempts - 1} in ${Math.round(delay / 100) / 10}s`,
        );
      },
      });

      session.messages = result.messages.filter((m) => m.role !== "system");
      session.summary = result.summary || session.summary;
      usage.turns += 1;
      session.scheduleSave();
    } finally {
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
      handleCommand(clean);
      return;
    }

    const id = enqueue("message", { label: clean.slice(0, 60) }, async () => {
      await runTurn(clean);
    });
    append("run-queued", { id });
  }

  function handleCommand(raw) {
    const text = String(raw || "").trim();
    const spaceAt = text.indexOf(" ");
    const name = (spaceAt === -1 ? text.slice(0) : text.slice(0, spaceAt)).toLowerCase();
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
        latestSession(workspace.root).then((data) => {
          if (!data) return pushSystem("No previous session for this directory.");
          applySession(data);
        });
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
    const restored = Session.fromJSON(data);
    session.messages = restored.messages;
    session.summary = restored.summary;
    session.provider = restored.provider || session.provider;
    session.model = restored.model || session.model;
    session.id = restored.id;
    session.title = restored.title;
    usage.input = restored.usage?.input || 0;
    usage.output = restored.usage?.output || 0;
    usage.turns = restored.usage?.turns || 0;
    usage.toolCalls = restored.usage?.toolCalls || 0;
    session.scheduleSave();
    append("session-restored", {
      id: restored.id,
      messages: restored.messages,
    });
    pushSystem(
      `Resumed session ${restored.id} · ${restored.messages.length} messages${restored.summary ? " · has handoff document" : ""}`,
    );
    broadcastState();
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
    workspace.allowDirectory(destination);
    workspace.chdir(destination);
    session = new Session({ cwd: destination, provider: providerId, model });
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
        models: p.models,
      })),
      current: { provider: providerId, model },
      apiKeys: Object.keys(configNow.apiKeys || {}),
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
    if (!info) return pushError(`Unknown provider "${id}".`);
    if (info.requiresKey && !isProviderReady(id, catalog, config)) {
      return pushSystem(`Provider "${info.label}" needs an API key first.`);
    }
    providerId = id;
    model = initialModel || getDefaultModel(id, catalog) || model;
    session.provider = providerId;
    session.model = model;
    session.scheduleSave();
    saveConfig({ provider: providerId, model }).catch(() => {});
    pushSystem(`Provider: ${info.label}`);
    broadcastState();
  }

  async function handleSetModel(id) {
    if (!id) return;
    model = id;
    session.model = model;
    session.scheduleSave();
    saveConfig({ provider: providerId, model }).catch(() => {});
    pushSystem(`Model: ${id}`);
    broadcastState();
  }

  async function handleSaveKey(provider, key) {
    await saveApiKey(provider, key || null);
    const cfg = await loadConfig();
    Object.assign(config, cfg);
    pushSystem(
      key
        ? `Saved the API key for ${getProviderInfo(provider, catalog)?.label || provider}.`
        : `Removed the saved key for ${getProviderInfo(provider, catalog)?.label || provider}.`,
    );
    broadcastState();
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
          reject(new Error("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  function authOk(req) {
    if (!token) return true;
    const header = req.headers.authorization || "";
    const q = new URL(req.url, "http://localhost");
    const cookie = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("soluna_access="));
    const cookieToken = cookie ? decodeURIComponent(cookie.slice("soluna_access=".length)) : "";
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
      const body = JSON.parse((await readBody(req)) || "{}");
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

    if (req.method === "GET" && path === "/api/config") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, await getCatalogInfo());
    }

    if (req.method === "GET" && path === "/api/workspaces") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, { current: workspace.root, workspaces: await workspaceList() });
    }

    if (req.method === "POST" && path === "/api/workspaces/import") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      if (jobs.running || jobs.queuedCount) return sendError(res, 409, "Wait for the active task to finish before changing projects");
      const body = JSON.parse((await readBody(req)) || "{}");
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
      const body = JSON.parse((await readBody(req)) || "{}");
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
      session = new Session({ cwd: workspace.root, provider: providerId, model });
      append("clear", {});
      broadcastState();
      return sendJSON(res, 200, { ok: true, id: session.id });
    }

    if (req.method === "POST" && path === "/api/message") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.text) return sendError(res, 400, "text is required");
      handleMessage(body.text);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/ask") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = JSON.parse((await readBody(req)) || "{}");
      finishAsk(Array.isArray(body.answers) ? body.answers : []);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/cancel") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = JSON.parse((await readBody(req)) || "{}");
      const running = jobs.running?.id === body.id;
      if (running) activeController?.abort();
      const ok = running || jobs.cancel(body.id);
      return sendJSON(res, 200, { ok });
    }

    if (req.method === "POST" && path === "/api/set-provider") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = JSON.parse((await readBody(req)) || "{}");
      await handleSetProvider(body.provider);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/set-model") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = JSON.parse((await readBody(req)) || "{}");
      await handleSetModel(body.model);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/save-key") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = JSON.parse((await readBody(req)) || "{}");
      await handleSaveKey(body.provider, body.key);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/api/sessions") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, await listSessions({ cwd: workspace.root, limit: 30 }));
    }

    if (req.method === "GET" && path === "/api/sessions/latest") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      return sendJSON(res, 200, (await latestSession(workspace.root)) || null);
    }

    if (req.method === "POST" && path === "/api/sessions/load") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = JSON.parse((await readBody(req)) || "{}");
      const data = body.id ? await loadSession(body.id) : await latestSession(workspace.root);
      if (!data) return sendError(res, 404, "Session not found");
      applySession(data);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/sessions/delete") {
      if (!authOk(req)) return sendError(res, 401, "Unauthorized");
      const body = JSON.parse((await readBody(req)) || "{}");
      const ok = await deleteSession(body.id);
      return sendJSON(res, 200, { ok });
    }

    return sendError(res, 404, "Not found");
  }

  async function serveStatic(req, res, pathname) {
    if (pathname === "/" || pathname === "/index.html") {
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
      sendError(res, 500, err.message || "Internal error");
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
