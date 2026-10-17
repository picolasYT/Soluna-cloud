import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "zyn-log-"));
  process.env.ZYN_HOME = home;
});

after(async () => {
  delete process.env.ZYN_HOME;
  await rm(home, { recursive: true, force: true });
});

test("logger writes error entries and redacts secrets", async () => {
  const { logger } = await import("../src/core/logger.js");
  logger.error("boom", { key: "sk-abcdef1234567890ghijkl" });
  await logger.flush();

  const files = await readdir(join(home, "logs"));
  assert.ok(files.length > 0);
  const content = await readFile(join(home, "logs", files[0]), "utf-8");
  const lines = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const entry = lines.find((l) => l.level === "error" && l.message === "boom");
  assert.ok(entry, "error entry present");
  assert.ok(!content.includes("sk-abcdef1234567890ghijkl"), "secret redacted");
});

test("debug entries are skipped unless ZYN_DEBUG is set", async () => {
  const { logger, setDebug } = await import("../src/core/logger.js");
  setDebug(false);
  logger.debug("spam");
  await logger.flush();
  const files = await readdir(join(home, "logs"));
  const content = await readFile(join(home, "logs", files[0]), "utf-8");
  assert.ok(!content.includes('"spam"'), "debug skipped");
  setDebug(true);
  logger.debug("visible");
  await logger.flush();
  const after_ = await readFile(join(home, "logs", files[0]), "utf-8");
  assert.ok(after_.includes('"visible"'), "debug visible after enable");
  setDebug(false);
});
