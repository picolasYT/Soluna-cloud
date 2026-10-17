import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = await mkdtemp(join(tmpdir(), "soluna-cloud-test-"));
process.env.SOLUNA_HOME = join(tempRoot, ".soluna");
const { startWebServer } = await import("../src/web/server.js");

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("cloud web entry requires login and accepts a private token cookie", async (t) => {
  const cwd = await mkdtemp(join(tempRoot, "workspace-"));
  const instance = await startWebServer({ cwd, host: "127.0.0.1", port: await freePort(), noMcp: true, token: "local-test-token" });
  t.after(async () => {
    await instance.close();
    await rm(tempRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${instance.port}`;

  const login = await fetch(`${base}/`);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Ingresá la contraseña de acceso/);

  const privateState = await fetch(`${base}/api/state`);
  assert.equal(privateState.status, 401);

  const rejected = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "wrong" }),
  });
  assert.equal(rejected.status, 401);

  const authenticated = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "local-test-token" }),
  });
  assert.equal(authenticated.status, 200);
  const cookie = authenticated.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const state = await fetch(`${base}/api/state`, { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).cwd, cwd);

  const app = await fetch(`${base}/`, { headers: { Cookie: cookie.split(";")[0] } });
  assert.match(await app.text(), /¿Qué hacemos/);
  const client = await fetch(`${base}/cloud.js`, { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(client.status, 200);
  assert.match(await client.text(), /workspaces\/import/);

  const workspaces = await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie.split(";")[0] } });
  assert.deepEqual((await workspaces.json()).workspaces, []);
  const newSession = await fetch(`${base}/api/sessions/new`, {
    method: "POST",
    headers: { Cookie: cookie.split(";")[0] },
  });
  assert.equal(newSession.status, 200);

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
});
