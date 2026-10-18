import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { createZip } from "../src/web/zip.js";
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
  assert.equal((await fetch(`${base}/api/files/zip`)).status, 401);

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

  await writeFile(join(cwd, "pages", "gato-ñ.txt"), "123456789");
  await writeFile(join(cwd, "empty.txt"), "");
  await writeFile(join(cwd, "image.bin"), Buffer.from([0, 255, 128, 12]));
  await mkdir(join(cwd, "dist"));
  await writeFile(join(cwd, "dist", "index.html"), "<h1>Built page</h1>");
  assert.ok((await (await fetch(`${base}/api/files`, { headers: auth })).json()).files.some((file) => file.path === "dist/index.html"));
  const archive = await fetch(`${base}/api/files/zip`, { headers: auth });
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get("content-type"), "application/zip");
  assert.match(archive.headers.get("content-disposition"), /attachment; filename="soluna-tarea-.*\.zip"/);
  const zip = Buffer.from(await archive.arrayBuffer());
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const centralOffset = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50);
  const unpacked = new Map();
  let offset = 0;
  while (offset < centralOffset) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    assert.equal(zip.readUInt16LE(offset + 6), 0x0800);
    assert.equal(zip.readUInt16LE(offset + 8), 8);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const dataOffset = offset + 30 + nameLength;
    const name = zip.subarray(offset + 30, dataOffset).toString("utf8");
    const bytes = inflateRawSync(zip.subarray(dataOffset, dataOffset + size));
    assert.equal(bytes.length, zip.readUInt32LE(offset + 22));
    if (name === "pages/gato-ñ.txt") assert.equal(zip.readUInt32LE(offset + 14), 0xcbf43926);
    unpacked.set(name, bytes);
    offset = dataOffset + size;
  }
  assert.equal(count, 6);
  assert.equal(unpacked.size, count);
  assert.equal(unpacked.get("pages/index.html").toString(), "<!doctype html><h1>Hola Soluna</h1>");
  assert.equal(unpacked.get("pages/gato-ñ.txt").toString(), "123456789");
  assert.equal(unpacked.get("empty.txt").length, 0);
  assert.equal(unpacked.get("dist/index.html").toString(), "<h1>Built page</h1>");
  assert.deepEqual(unpacked.get("image.bin"), Buffer.from([0, 255, 128, 12]));
  assert.ok(!unpacked.has("leak.txt"));
  await writeFile(join(cwd, "large.bin"), "");
  await truncate(join(cwd, "large.bin"), 51 * 1024 * 1024);
  assert.equal((await fetch(`${base}/api/files/zip`, { headers: auth })).status, 413);

  assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent("../private.txt")}`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/file?path=leak.txt`, { headers: auth })).status, 404);
});

test("ZIP rejects archive paths that could escape the extraction folder", async () => {
  for (const path of ["../outside.txt", "/absolute.txt", "C:/outside.txt", "folder/../../outside.txt", "folder\\outside.txt"]) {
    await assert.rejects(createZip([{ path, data: Buffer.from("test") }]), /Ruta inválida/);
  }
});
