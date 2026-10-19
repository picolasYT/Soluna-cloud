import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { buildCatalog } from "../providers/catalog.js";

const readJSON = async (path) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; } };

export async function importLegacyOwner(home, admin, store) {
  const destination = join(home, "accounts", admin.id);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const config = await readJSON(join(home, "config.json"));
  const existing = await store.keySets(admin.id);
  for (const provider of buildCatalog(config)) {
    if (Object.hasOwn(existing, provider.id)) continue;
    const keys = [...new Set([provider.envKey ? process.env[provider.envKey] : null, config.apiKeys?.[provider.id], ...(config.apiKeyPools?.[provider.id] || [])].filter(Boolean))];
    if (keys.length) await store.saveKeys(admin.id, provider.id, keys);
  }
  try { await readFile(join(destination, ".legacy-imported")); return; } catch {}
  for (const directory of ["chat-workspaces", "workspaces"]) {
    try { await cp(join(home, directory), join(destination, directory), { recursive: true, force: false, errorOnExist: false }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await mkdir(join(destination, "sessions"), { recursive: true });
  const sessions = await readdir(join(home, "sessions")).catch(() => []);
  for (const name of sessions.filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name))) {
    const session = await readJSON(join(home, "sessions", name));
    const directory = resolve(session.cwd || "/");
    const source = ["chat-workspaces", "workspaces"].map((part) => resolve(home, part)).find((part) => directory.startsWith(part + sep));
    if (!source) continue;
    session.cwd = join(destination, source.split(sep).at(-1), directory.slice(source.length + 1));
    await writeFile(join(destination, "sessions", name), JSON.stringify(session), { mode: 0o600 });
  }
  const { apiKeys, apiKeyPools, ...settings } = config;
  await writeFile(join(destination, "config.json"), JSON.stringify(settings), { mode: 0o600 });
  await writeFile(join(destination, ".legacy-imported"), "1", { mode: 0o600 });
}

export function accountRuntimes({ home, store, maxWorkers = 4 }) {
  const entries = new Map();
  let queue = Promise.resolve();
  let closing = false;
  const stop = async (id) => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (!entry.child) { try { await entry.ready; } catch {} }
    if (!entry.child || entry.child.exitCode !== null || entry.child.signalCode) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { entry.child.kill("SIGKILL"); resolve(); }, 8000);
      entry.child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (entry.child.connected) entry.child.send({ kind: "stop" }); else { clearTimeout(timer); resolve(); }
    });
  };
  const acquireOne = async (user) => {
    if (closing) throw Object.assign(new Error("El servidor se está reiniciando."), { status: 503 });
    let entry = entries.get(user.id);
    if (entry) { entry.lastAccess = Date.now(); return entry.ready; }
    if (entries.size >= maxWorkers) {
      const idle = [...entries.values()].filter((item) => !item.busy && !item.requests && item.initialized).sort((a, b) => a.lastAccess - b.lastAccess)[0];
      if (!idle) throw Object.assign(new Error("El servidor está ocupado. Volvé a intentar en unos momentos."), { status: 503 });
      await stop(idle.userId);
    }
    // Reserve the slot before asynchronous setup, avoiding duplicate starts.
    entry = { userId: user.id, lastAccess: Date.now(), busy: false, initialized: false };
    entries.set(user.id, entry);
    entry.ready = (async () => {
      const directory = join(home, "accounts", user.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const config = await readJSON(join(directory, "config.json"));
      const keySets = await store.keySets(user.id);
      config.apiKeys = {};
      config.apiKeyPools = {};
      for (const [provider, keys] of Object.entries(keySets)) {
        if (keys.length) config.apiKeys[provider] = keys[0];
        if (keys.length > 1) config.apiKeyPools[provider] = keys.slice(1);
      }
      await writeFile(join(directory, "config.json"), JSON.stringify(config), { mode: 0o600 });
      const env = {};
      for (const name of ["PATH", "SystemRoot", "ComSpec", "LANG", "LC_ALL", "TZ", "TMPDIR", "TMP", "TEMP", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) if (process.env[name]) env[name] = process.env[name];
      entry.token = randomBytes(32).toString("hex");
      Object.assign(env, { NODE_ENV: "production", HOME: directory, USERPROFILE: directory, SOLUNA_HOME: directory, SOLUNA_INTERNAL_TOKEN: entry.token, SOLUNA_ACCOUNT_ADMIN: user.isAdmin ? "1" : "0" });
      const child = fork(new URL("./account-worker.js", import.meta.url), [], { env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      entry.child = child;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error("No se pudo iniciar el espacio de la cuenta.")); }, 20000);
        child.on("message", async (message) => {
          if (message.kind === "ready") { clearTimeout(timer); entry.port = message.port; entry.initialized = true; resolve(entry); }
          if (message.kind === "busy") entry.busy = message.busy;
          if (message.kind === "keys") {
            try {
              await store.saveKeys(user.id, message.provider, message.keys);
              if (child.connected) child.send({ kind: "persisted", id: message.id, ok: true });
            } catch { if (child.connected) child.send({ kind: "persisted", id: message.id, ok: false }); }
          }
        });
        child.once("error", () => { clearTimeout(timer); reject(new Error("No se pudo iniciar el espacio de la cuenta.")); });
        child.once("exit", () => { clearTimeout(timer); if (entries.get(user.id) === entry) entries.delete(user.id); reject(new Error("El espacio de la cuenta se detuvo.")); });
      });
    })().catch((error) => { if (entries.get(user.id) === entry) entries.delete(user.id); throw error; });
    return entry.ready;
  };
  const timer = setInterval(() => {
    for (const entry of entries.values()) if (entry.initialized && !entry.busy && !entry.requests && Date.now() - entry.lastAccess > 10 * 60 * 1000) stop(entry.userId).catch(() => {});
  }, 60000);
  timer.unref();
  return { acquire(user, { hold = false } = {}) {
    const result = queue.then(async () => {
      const entry = await acquireOne(user);
      if (hold) entry.requests = (entry.requests || 0) + 1;
      return entry;
    });
    queue = result.catch(() => {});
    return result;
  }, release(entry) { entry.requests = Math.max(0, (entry.requests || 0) - 1); entry.lastAccess = Date.now(); }, stop, async close() { closing = true; clearInterval(timer); await queue; await Promise.all([...entries.keys()].map(stop)); } };
}
