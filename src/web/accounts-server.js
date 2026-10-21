import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { clientBase } from "./events.js";
import { join } from "node:path";
import { createAccountsStore } from "./accounts-store.js";
import { accountRuntimes, importLegacyOwner } from "./account-runtimes.js";
import { SOLUNA_HOME } from "../core/session-store.js";
import { currentRelease } from "./release.js";

const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const sessionCookie = (req) => {
  const value = (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith("soluna_session="))?.slice(15);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
};
async function bodyJSON(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw fail(415, "Enviá los datos como JSON.");
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 65536) throw fail(413, "La solicitud es demasiado grande.");
    parts.push(part);
  }
  try { const body = JSON.parse(Buffer.concat(parts).toString()); if (!body || Array.isArray(body) || typeof body !== "object") throw new Error(); return body; }
  catch { throw fail(400, "Los datos enviados no son válidos."); }
}

export async function startAccountsServer({ host = "localhost", port = 3456, home = SOLUNA_HOME,
  databaseUrl = process.env.DATABASE_URL, encryptionKey = process.env.SOLUNA_ENCRYPTION_KEY,
  adminPassword = process.env.SOLUNA_ADMIN_PASSWORD || process.env.SOLUNA_WEB_TOKEN,
  store: suppliedStore, runtimes: suppliedRuntimes, migrate = true,
  allowRegistration = process.env.SOLUNA_ALLOW_REGISTRATION !== "false",
  publicUrl = process.env.RENDER_EXTERNAL_URL, release = currentRelease() } = {}) {
  const store = suppliedStore || await createAccountsStore({ databaseUrl, encryptionKey });
  let runtimes;
  try {
    const admin = await store.ensureAdmin(adminPassword);
    if (migrate) await importLegacyOwner(home, admin, store);
    runtimes = suppliedRuntimes || accountRuntimes({ home, store, maxWorkers: Math.max(1, Math.min(16, Number(process.env.SOLUNA_MAX_WORKERS) || 4)) });
  } catch (error) { if (!suppliedStore) await store.close(); throw error; }
  const attempts = new Map();
  const streams = new Map();
  const rateLimit = (req) => {
    const ip = process.env.RENDER ? String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",").at(-1).trim() : req.socket.remoteAddress;
    const now = Date.now();
    if (attempts.size > 10000) for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
    const state = attempts.get(ip);
    if (!state && attempts.size >= 10000) throw fail(429, "El acceso está ocupado. Volvé a intentar en unos minutos.");
    if (state && state.until > now && state.count >= 15) throw fail(429, "Demasiados intentos. Esperá 15 minutos antes de volver a intentar.");
    attempts.set(ip, state && state.until > now ? { ...state, count: state.count + 1 } : { count: 1, until: now + 900000 });
  };
  const setCookie = (req, res, value, maxAge = 604800) => {
    const secure = publicUrl?.startsWith("https:") || req.socket.encrypted || (process.env.RENDER && req.headers["x-forwarded-proto"] === "https");
    res.setHeader("Set-Cookie", `soluna_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
  };
  const redirect = (res, path) => { res.writeHead(303, { Location: path, "Cache-Control": "no-store" }); res.end(); };
  const asset = async (res, filename) => {
    const type = filename.endsWith(".css") ? "text/css" : filename.endsWith(".js") ? "text/javascript" : "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-cache" });
    res.end(await readFile(join(clientBase(), filename)));
  };
  async function proxy(req, res, user, token) {
    const url = new URL(req.url, "http://localhost");
    const held = url.pathname !== "/api/events";
    const runtime = await runtimes.acquire(user, { hold: held });
    url.searchParams.delete("token");
    // Never forward browser credentials or allow a client to choose its worker.
    const headers = { authorization: `Bearer ${runtime.token}`, host: "127.0.0.1" };
    for (const name of ["content-type", "content-length", "last-event-id"]) if (req.headers[name]) headers[name] = req.headers[name];
    const upstream = http.request({ host: "127.0.0.1", port: runtime.port, path: url.pathname + url.search, method: req.method, headers }, (response) => {
      const responseHeaders = { ...response.headers };
      delete responseHeaders["set-cookie"];
      res.writeHead(response.statusCode, responseHeaders);
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    let expiry;
    if (url.pathname === "/api/events") {
      if (!streams.has(token)) streams.set(token, new Set());
      streams.get(token).add(upstream);
      // Bound a stream's authentication lifetime; EventSource reconnects.
      expiry = setTimeout(() => { upstream.destroy(); res.end(); }, 5 * 60 * 1000);
      expiry.unref();
    }
    const cleanup = () => { if (held) runtimes.release(runtime); clearTimeout(expiry); streams.get(token)?.delete(upstream); if (!streams.get(token)?.size) streams.delete(token); upstream.destroy(); };
    res.once("close", cleanup);
    upstream.on("error", () => { if (!res.headersSent) json(res, 503, { error: "El espacio se está reiniciando. Volvé a intentar." }); else res.end(); });
    req.pipe(upstream);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true, accounts: true });
      if (!["GET", "HEAD"].includes(req.method)) {
        const expected = publicUrl ? new URL(publicUrl).origin : `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
        if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== expected)) throw fail(403, "La solicitud debe hacerse desde Soluna.");
      }
      if (req.method === "GET" && ["/", "/welcome.html"].includes(path)) return asset(res, "welcome.html");
      const publicAssets = ["account.css", "account.js", "welcome.js", "chat-account.js", "style.css", "app.js", "cloud.js", "markdown.js", "diff.js"];
      if (req.method === "GET" && publicAssets.includes(path.slice(1))) return asset(res, path.slice(1));
      if (req.method === "GET" && ["/login", "/register"].includes(path)) return asset(res, "account.html");
      if (req.method === "POST" && ["/api/account/login", "/api/account/register"].includes(path)) {
        rateLimit(req);
        const body = await bodyJSON(req);
        if (path.endsWith("register") && !allowRegistration) throw fail(403, "El registro está deshabilitado por el administrador.");
        const user = path.endsWith("register") ? await store.register(body.username, body.password) : await store.login(body.username, body.password);
        const token = await store.createLogin(user.id);
        setCookie(req, res, token);
        return json(res, 200, { user });
      }
      const token = sessionCookie(req);
      const user = await store.authenticate(token);
      if (req.method === "GET" && path === "/api/account/me") return json(res, 200, { user, registration: allowRegistration });
      if (!user) {
        if (req.method === "GET" && ["/app", "/index.html", "/admin"].includes(path)) return redirect(res, "/login");
        throw fail(401, "Iniciá sesión para continuar.");
      }
      if (req.method === "POST" && path === "/api/account/logout") {
        await bodyJSON(req);
        await store.logout(token);
        for (const stream of streams.get(token) || []) stream.destroy();
        streams.delete(token);
        setCookie(req, res, "", 0);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/account/announcement") {
        await bodyJSON(req);
        // One atomic claim across tabs, devices, logins and server restarts.
        const firstView = await store.claimRelease(user.id, release.id);
        return json(res, 200, { announcement: firstView ? release : null });
      }
      if (path === "/admin" || path.startsWith("/api/admin/")) {
        if (!user.isAdmin || user.username !== "picolas") throw fail(403, "Este panel está disponible solo para picolas.");
        if (req.method === "GET" && path === "/admin") return asset(res, "admin.html");
        if (req.method === "GET" && path === "/api/admin/overview") return json(res, 200, { users: await store.users(), keys: await store.allKeys() });
        if (req.method !== "POST") throw fail(404, "Ruta no encontrada.");
        const body = await bodyJSON(req);
        if (!/^[a-f0-9-]{36}$/i.test(String(body.userId || ""))) throw fail(400, "La cuenta no es válida.");
        const target = await store.user(body.userId);
        if (!target) throw fail(404, "La cuenta no existe.");
        if (path === "/api/admin/user") {
          if (typeof body.disabled !== "boolean") throw fail(400, "La opción no es válida.");
          await store.disable(target.id, body.disabled);
          await store.audit(user.id, target.id, body.disabled ? "disable-user" : "enable-user");
          if (body.disabled) await runtimes.stop(target.id);
          return json(res, 200, { ok: true });
        }
        if (path === "/api/admin/keys/reveal") {
          const key = await store.revealKey(target.id, body.provider, body.id);
          await store.audit(user.id, target.id, "reveal-key", body.provider);
          return json(res, 200, { key });
        }
        if (path === "/api/admin/keys") {
          const runtime = await runtimes.acquire(target, { hold: true });
          const removing = body.action === "remove";
          try {
            const response = await fetch(`http://127.0.0.1:${runtime.port}/api/keys`, { method: removing ? "DELETE" : "POST", headers: { authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" }, body: JSON.stringify(removing ? { provider: body.provider, id: body.id } : { provider: body.provider, keys: body.keys }), signal: AbortSignal.timeout(20000) });
            if (!response.ok) { const problem = await response.json(); throw fail(response.status, problem.error || "No se pudo actualizar la clave."); }
            await response.arrayBuffer();
          } finally { runtimes.release(runtime); }
          await store.audit(user.id, target.id, removing ? "remove-key" : "add-key", body.provider);
          return json(res, 200, { ok: true });
        }
        throw fail(404, "Ruta no encontrada.");
      }
      if (req.method === "GET" && ["/app", "/index.html"].includes(path)) return asset(res, "index.html");
      if (path.startsWith("/api/")) {
        if (["/api/auth"].includes(path)) throw fail(404, "Usá el inicio de sesión de tu cuenta.");
        return await proxy(req, res, user, token);
      }
      throw fail(404, "Página no encontrada.");
    } catch (error) {
      if (res.headersSent) return res.end();
      const requestId = randomUUID().slice(0, 8);
      if (!error.status) console.error(`Accounts request ${requestId} failed (${error.code || error.name || "error"}).`);
      json(res, error.status || 500, { error: error.status ? error.message : `No se pudo completar la solicitud. Intentá de nuevo. (${requestId})` });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return { server, port: server.address().port, host, accounts: true, async close() {
    for (const group of streams.values()) for (const stream of group) stream.destroy();
    await runtimes.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (!suppliedStore) await store.close();
  } };
}
