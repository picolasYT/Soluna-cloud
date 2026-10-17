import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { MCP_PATH } from "./session-store.js";
import { buildChildEnv, isWindows, which } from "./shell.js";

/**
 * MCP (Model Context Protocol) client over stdio.
 *
 * Speaks JSON-RPC 2.0 over the server's stdin/stdout with newline framing,
 * which is the transport CLI-based MCP servers use.
 *
 * Configured in ~/.soluna/mcp.json, same format as Claude Code:
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *         "env": {}
 *       }
 *     }
 *   }
 */

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT = 30000;

/**
 * Windows cannot spawn npm's `npx`/`npm`/`pnpm`/`yarn` directly: they are
 * `.cmd` shims, which need a shell (and a recent Node refuses to run them
 * without one). Quote carefully for cmd.exe when that happens.
 */
export function resolveMcpLaunch(command, args = [], env = process.env) {
  if (!isWindows()) return { command, args, shell: false };

  const resolved = which(command, env) || command;
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { command: resolved, args, shell: false };

  const quote = (value) => {
    const text = String(value);
    return /[\s"&|<>^()%!]/.test(text) ? `"${text.replace(/"/g, '""').replace(/%/g, "%%")}"` : text;
  };
  return { command: quote(resolved), args: args.map(quote), shell: true };
}

export class MCPClient {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.child = null;
    this.tools = [];
    this.ready = false;
    this._nextId = 1;
    this._pending = new Map();
    this._buffer = "";
  }

  async connect({ timeoutMs = 15000 } = {}) {
    const { command, args = [], env = {} } = this.config;
    if (!command) throw new Error(`MCP server "${this.name}" has no command`);

    const env2 = buildChildEnv({ ...process.env, ...env });
    const launch = resolveMcpLaunch(command, args, env2);
    this.child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env2,
      windowsHide: true,
      shell: launch.shell,
    });

    this.child.on("error", (err) => {
      const hint = err.code === "ENOENT"
        ? ` ("${command}" was not found on PATH — install it or use its full path in mcp.json)`
        : "";
      this._failAll(new Error(`MCP "${this.name}": ${err.message}${hint}`));
    });
    this.child.on("exit", (code) =>
      this._failAll(new Error(`MCP "${this.name}" exited with code ${code}`)),
    );

    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    // stderr is usually server logging: drop it so the UI stays clean.
    this.child.stderr.on("data", () => {});

    await this._request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: "soluna", version: "1.0.0" },
      },
      timeoutMs,
    );

    this._notify("notifications/initialized");

    const result = await this._request("tools/list", {}, timeoutMs);
    this.tools = result?.tools || [];
    this.ready = true;
    return this.tools;
  }

  _onData(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // log line, not JSON-RPC
      }

      const pending = this._pending.get(msg.id);
      if (!pending) continue;
      this._pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) pending.reject(new Error(msg.error.message || "MCP error"));
      else pending.resolve(msg.result);
    }
  }

  _request(method, params, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP "${this.name}" timed out on ${method}`));
      }, timeoutMs);
      timer.unref?.();

      this._pending.set(id, { resolve, reject, timer });

      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _notify(method, params = {}) {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // The server already died.
    }
  }

  _failAll(error) {
    this.ready = false;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this._pending.clear();
  }

  async callTool(toolName, args, timeoutMs = 60000) {
    return this._request("tools/call", { name: toolName, arguments: args || {} }, timeoutMs);
  }

  close() {
    this._failAll(new Error("closed"));
    try {
      if (isWindows() && this.child?.pid) {
        // With shell:true the child is cmd.exe; kill the whole tree.
        spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
      } else {
        this.child?.kill();
      }
    } catch {
      // already dead
    }
  }
}

/** Read the MCP server configuration. */
export async function loadMCPConfig() {
  try {
    const raw = JSON.parse(await readFile(MCP_PATH, "utf-8"));
    return raw.mcpServers || raw.servers || {};
  } catch {
    return {};
  }
}

/**
 * Start every configured server and return their tools adapted to the
 * agent's format. A failing server never blocks the others.
 */
export async function connectMCPServers({ onStatus } = {}) {
  const config = await loadMCPConfig();
  const names = Object.keys(config);
  if (names.length === 0) return { clients: [], tools: [], errors: [] };

  const clients = [];
  const tools = [];
  const errors = [];

  await Promise.all(
    names.map(async (name) => {
      const client = new MCPClient(name, config[name]);
      onStatus?.({ name, phase: "connecting" });
      try {
        const list = await client.connect();
        clients.push(client);
        for (const t of list) tools.push(wrapMCPTool(client, t));
        onStatus?.({ name, phase: "ready", count: list.length });
      } catch (err) {
        errors.push({ name, error: err.message });
        onStatus?.({ name, phase: "failed", error: err.message });
        client.close();
      }
    }),
  );

  return { clients, tools, errors };
}

/** Adapt an MCP tool to the agent's tool interface. */
export function wrapMCPTool(client, mcpTool) {
  // Prefixed to avoid clashing with built-in tools.
  const name = `mcp__${client.name}__${mcpTool.name}`;

  return {
    name,
    description: mcpTool.description || `${mcpTool.name} (via ${client.name})`,
    parameters: mcpTool.inputSchema || { type: "object", properties: {} },
    mcp: { server: client.name, tool: mcpTool.name },
    async execute(args, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const result = await client.callTool(mcpTool.name, args);

      // MCP content already arrives as [{type:"text"|"image", ...}]
      const content = (result?.content || []).map((c) => {
        if (c.type === "text") return { type: "text", text: c.text };
        if (c.type === "image") return { type: "image", data: c.data, mimeType: c.mimeType };
        return { type: "text", text: JSON.stringify(c) };
      });

      if (result?.isError) {
        const text = content.map((c) => c.text).join("\n") || "MCP tool failed";
        throw new Error(text);
      }

      return {
        content: content.length ? content : [{ type: "text", text: "(no output)" }],
        details: { mcp: true, server: client.name },
      };
    },
  };
}
