/**
 * Single-user job queue for the web server.
 *
 * The web UI issues requests (messages / tools / confirmations) and a
 * lightweight queue dispatches them one at a time against a single session,
 * emitting granular events like runAgentLoop does. This mirrors the TUI:
 * exactly one turn runs at a time, extra messages queue up, and the UI is
 * updated via pushed events.
 */

import { EventEmitter } from "node:events";

export class Jobs extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.pending = [];
    this.running = null;
  }

  /** Enqueue a request. Returns a summary id the client can display now. */
  push(entry) {
    this.pending.push(entry);
    this.emit("queued", {
      id: entry.id,
      kind: entry.kind,
      label: entry.label || "",
      at: Date.now(),
      running: this.running,
    });
    this.#drain();
    return entry.id;
  }

  get queuedCount() {
    return this.pending.length;
  }

  /** Cancel a pending request (turns cannot be cancelled once started). */
  cancel(id) {
    const at = this.pending.findIndex((e) => e.id === id);
    if (at === -1) return false;
    this.pending.splice(at, 1);
    this.emit("cancelled", { id });
    return true;
  }

  async #drain() {
    if (this.running) return;
    const entry = this.pending.shift();
    if (!entry) return;

    this.running = entry;
    this.emit("started", { id: entry.id, kind: entry.kind });

    try {
      const result = await entry.run(() => this.#drain());
      this.emit("finished", { id: entry.id, kind: entry.kind, result });
    } catch (err) {
      this.emit("failed", {
        id: entry.id,
        kind: entry.kind,
        error: err && err.message ? err.message : String(err),
      });
    } finally {
      this.running = null;
      // Any request queued while this one ran gets its turn now.
      if (this.pending.length > 0) this.#drain();
    }
  }

  async waitIdle() {
    while (this.running) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}