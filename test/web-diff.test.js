import test from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../src/core/diff.js";
import { renderDiff } from "../src/web/client/diff.js";

test("browser diff shows deleted and added code with context and escapes HTML", () => {
  const diff = diffLines("before\nconst oldValue = 1;\nafter", "before\nconst newValue = '<script>';\nafter");
  const html = renderDiff({ path: "example.js", ...diff });
  assert.match(html, /diff-rem/);
  assert.match(html, /const oldValue = 1;/);
  assert.match(html, /diff-add/);
  assert.match(html, /const newValue/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /before/);
  assert.match(html, /after/);
  assert.match(html, /diff-line-number/);
});

test("pure deletion and empty files remain visible", () => {
  assert.match(renderDiff(diffLines("removed text", "")), /removed text/);
  assert.match(renderDiff(diffLines("", "")), /Sin cambios/);
});
