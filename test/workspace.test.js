import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace, isInside } from "../src/core/workspace.js";

async function makeSandbox() {
  const root = join(tmpdir(), `ws-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(join(root, "sub"), { recursive: true });
  return root;
}

test("isInside rejects traversal", () => {
  assert.ok(isInside("/a/b", "/a/b/c"));
  assert.ok(isInside("/a/b", "/a/b"));
  assert.ok(!isInside("/a/b", "/a/bc"));
  assert.ok(!isInside("/a/b", "/a/../etc"));
  assert.ok(!isInside("/a/b", "/etc"));
});

test("workspace resolves allowed paths", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    assert.equal(await ws.resolvePath("sub/file.txt"), join(root, "sub/file.txt"));
    assert.equal(await ws.resolvePath("./sub/deep/new.txt"), join(root, "sub/deep/new.txt"));
    assert.equal(await ws.resolvePath("."), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace blocks traversal and absolute escapes", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    for (const bad of ["../x", "../../../../etc/passwd", "/etc/passwd", "/tmp", ".."]) {
      await assert.rejects(() => ws.resolvePath(bad), (err) => err.code === "OUTSIDE_WORKSPACE");
    }
    await assert.rejects(() => ws.resolvePath(""), (err) => err.code === "OUTSIDE_WORKSPACE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace blocks symlink escape", async (t) => {
  const root = await makeSandbox();
  const outside = join(tmpdir(), `ws-out-${Date.now()}`);
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "secret");
  try {
    try {
      await symlink(outside, join(root, "evil-link"));
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("host does not permit creating symlinks");
        return;
      }
      throw err;
    }
    const ws = new Workspace(root);
    await assert.rejects(() => ws.resolvePath("evil-link/secret.txt"), (err) => err.code === "OUTSIDE_WORKSPACE");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workspace allows extra directories via allow list", async () => {
  const root = await makeSandbox();
  const extra = join(tmpdir(), `ws-extra-${Date.now()}`);
  await mkdir(extra, { recursive: true });
  try {
    const ws = new Workspace(root, { allow: [extra] });
    assert.equal(await ws.resolvePath(join(extra, "x.txt")), join(extra, "x.txt"));
    await assert.rejects(() => ws.resolvePath("/etc"), (err) => err.code === "OUTSIDE_WORKSPACE");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
  }
});

test("unsafe mode bypasses enforcement", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root, { unsafe: true });
    assert.equal(await ws.resolvePath("/etc/passwd"), resolve("/etc/passwd"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chdir only moves inside the workspace", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    assert.equal(ws.chdir(join(root, "sub")), join(root, "sub"));
    assert.equal(await ws.resolvePath("file.txt"), join(root, "sub/file.txt"));
    assert.throws(() => ws.chdir("/etc"), (err) => err.code === "OUTSIDE_WORKSPACE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolvePath validates input type", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    await assert.rejects(() => ws.resolvePath(null));
    await assert.rejects(() => ws.resolvePath(42));
    await assert.rejects(() => ws.resolvePath("   "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
