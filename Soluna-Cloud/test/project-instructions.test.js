import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectInstructions, renderProjectInstructions } from "../src/core/project-instructions.js";
import { isBinaryBuffer } from "../src/core/utils/file-utils.js";

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "zyn-proj-"));
  process.env.ZYN_HOME = home;
});

after(async () => {
  delete process.env.ZYN_HOME;
  await rm(home, { recursive: true, force: true });
});

test("AGENTS.md is loaded from the workspace root", async () => {
  await writeFile(join(home, "AGENTS.md"), "Always run: npm test\n");
  const inst = await loadProjectInstructions(home);
  assert.ok(inst);
  assert.match(inst.file, /AGENTS\.md$/);
  assert.match(inst.content, /npm test/);
  const rendered = renderProjectInstructions(inst);
  assert.match(rendered, /Project Instructions/);
  assert.match(rendered, /npm test/);
});

test("CLAUDE.md is used as a fallback", async () => {
  const dir = join(home, "only-claude");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "CLAUDE.md"), "Use tabs\n");
  const inst = await loadProjectInstructions(dir);
  assert.match(inst.file, /CLAUDE\.md$/);
});

test("AGENTS.md takes precedence over CLAUDE.md", async () => {
  const dir = join(home, "both");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "agents wins\n");
  await writeFile(join(dir, "CLAUDE.md"), "claude loses\n");
  const inst = await loadProjectInstructions(dir);
  assert.match(inst.file, /AGENTS\.md$/);
});

test("no instructions -> null", async () => {
  const dir = join(home, "empty-dir");
  await mkdir(dir, { recursive: true });
  assert.equal(await loadProjectInstructions(dir), null);
});

test("isBinaryBuffer detects binary vs text", async () => {
  assert.equal(isBinaryBuffer(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])), true);
  assert.equal(isBinaryBuffer(Buffer.from("hello world, plain text")), false);
});
