import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "soluna-files-"));
process.env.SOLUNA_HOME = join(root, "config");
const { startWebServer } = await import("../src/web/server.js");

test("workspace files can be listed, previewed and downloaded without escaping the project", async (t) => {
  const cwd = join(root, "project");
  await mkdir(join(cwd, "pages"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "hidden"), { recursive: true });
  await writeFile(join(cwd, "pages", "index.html"), "<!doctype html><h1>Hola Soluna</h1>");
  await writeFile(join(cwd, "app.js"), "const answer = 42;\n");
  await writeFile(join(cwd, "node_modules", "hidden", "ignored.js"), "ignored");
  const outside = join(root, "private.txt");
  await writeFile(outside, "private");
  await symlink(outside, join(cwd, "leak.txt"));

  const instance = await startWebServer({ cwd, host: "127.0.0.1", port: 0, noMcp: true, token: "files-test-token" });
  t.after(async () => {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const auth = { Authorization: "Bearer files-test-token" };
  assert.equal((await fetch(`${base}/api/files`)).status, 401);

  const listingResponse = await fetch(`${base}/api/files`, { headers: auth });
  assert.equal(listingResponse.status, 200);
  const files = (await listingResponse.json()).files;
  assert.ok(files.some((file) => file.path === "pages/index.html"));
  assert.ok(files.some((file) => file.path === "app.js"));
  assert.ok(!files.some((file) => file.path.includes("node_modules") || file.path === "leak.txt"));

  const preview = await fetch(`${base}/api/file?path=${encodeURIComponent("pages/index.html")}`, { headers: auth });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type"), /text\/html/);
  assert.match(preview.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await preview.text(), /Hola Soluna/);

  const download = await fetch(`${base}/api/file?path=app.js&download=1`, { headers: auth });
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.equal(await download.text(), "const answer = 42;\n");

  assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent("../private.txt")}`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/file?path=leak.txt`, { headers: auth })).status, 404);
});
