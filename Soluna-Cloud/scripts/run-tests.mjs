#!/usr/bin/env node
/**
 * Test runner.
 *
 * Uses Node's built-in test runner (node:test) so there are no extra
 * dependencies. Discovers every test file under test/ and reports a
 * summary. Pass --watch to rerun on changes.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "test");

const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join(testDir, f))
  .sort();

if (files.length === 0) {
  console.error("No test files found in test/");
  process.exit(1);
}

const watch = process.argv.includes("--watch");
const args = [
  "--test",
  "--test-reporter=spec",
  ...(watch ? ["--watch"] : []),
  ...files,
];

const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });

const envTests = process.env.SOLUNA_TEST_WORKERS || process.env.ZYN_TEST_WORKERS;
if (!envTests) {
  console.log(`\n${files.length} test file(s) run with SOLUNA_TEST_WORKERS=${envTests || "1"} (set it to parallelise)`);
}

process.exit(result.status ?? 1);
