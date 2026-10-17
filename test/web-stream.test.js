import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { renderMarkdown } from "../src/web/client/markdown.js";

// Exercise the actual client rendering functions with a minimal DOM surface.
const app = await readFile(new URL("../src/web/client/app.js", import.meta.url), "utf8");
const rendering = app.slice(app.indexOf("function appendStreamEl()"), app.indexOf("function addSystemLine"));

class Node {
  constructor() {
    this.children = [];
    this.classes = new Set();
    this.classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name) };
    this.parts = new Map();
  }
  set innerHTML(html) { this.html = html; this.children = []; }
  get innerHTML() { return this.html || ""; }
  appendChild(node) {
    node.remove();
    this.children.push(node);
    node.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  querySelector(selector) {
    if (!this.parts.has(selector)) this.parts.set(selector, new Node());
    return this.parts.get(selector);
  }
}

function client() {
  const transcript = new Node();
  const live = new Node();
  const sandbox = {
    state: { streamText: "", streaming: true, busy: true }, streamEl: null,
    $: (selector) => selector === "#transcript" ? transcript : live,
    el: () => new Node(), renderMarkdown, scrollBottom() {},
  };
  runInNewContext(rendering, sandbox);
  return { sandbox, transcript, live };
}

test("final-only assistant responses are rendered instead of an empty bubble", () => {
  const { sandbox, transcript } = client();
  sandbox.finalizeStream("Texto final completo");
  assert.equal(transcript.children.length, 1);
  assert.match(transcript.children[0].querySelector(".stream-text").innerHTML, /Texto final completo/);
  assert.equal(sandbox.state.streamText, "");
  assert.equal(sandbox.state.busy, true); // Only the server may mark a turn idle.
});

test("final response replaces partial chunks and the next tool block starts clean", () => {
  const { sandbox, transcript, live } = client();
  sandbox.appendStream("Respuesta parcial");
  sandbox.finalizeStream("Respuesta completa y corregida");
  assert.match(transcript.children[0].querySelector(".stream-text").innerHTML, /completa y corregida/);
  sandbox.appendStream("Segundo mensaje después de modificar archivos");
  sandbox.finalizeStream("Segundo mensaje después de modificar archivos");
  assert.equal(transcript.children.length, 2);
  assert.equal(live.children.length, 0);
  assert.ok(!transcript.children[1].querySelector(".stream-text").innerHTML.includes("parcial"));
});
