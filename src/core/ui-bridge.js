import { EventEmitter } from "node:events";

/**
 * Bridge between the agent and the user interface.
 *
 * The `ask` tool publishes requests here and the UI resolves them.
 * With no UI attached we fall back to a plain readline prompt.
 */
class UIBridge extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this._handler = null;
    this._seq = 0;
  }

  /** Register the UI handler. Returns a disconnect function. */
  connect(handler) {
    this._handler = handler;
    return () => {
      if (this._handler === handler) this._handler = null;
    };
  }

  get connected() {
    return typeof this._handler === "function";
  }

  nextId() {
    this._seq += 1;
    return `req_${Date.now().toString(36)}_${this._seq}`;
  }

  /**
   * Ask the user one or more questions.
   * @param {{questions: Array}} payload
   * @returns {Promise<Array<{header:string, question:string, answers:string[]}>>}
   */
  async ask(payload) {
    if (this._handler) {
      return this._handler({ id: this.nextId(), ...payload });
    }
    return fallbackAsk(payload);
  }

  /**
   * Ask the user to approve a risky command.
   * @param {{command: string, reason: string}} payload
   * @returns {Promise<boolean>} true when the user allows the command
   */
  async confirm(payload) {
    const answers = await this.ask({
      questions: [
        {
          header: "Permission",
          question: `Soluna wants to run a command flagged as risky.\n\nCommand:\n  ${String(payload.command).slice(0, 400)}\n\nReason: ${payload.reason}`,
          custom: false,
          multiple: false,
          options: [
            { label: "Allow this command", description: "Run it once, now" },
            { label: "Deny", description: "Refuse without running it" },
          ],
        },
      ],
    });
    const picked = answers?.[0]?.answers || [];
    return picked.some((a) => a.toLowerCase().startsWith("allow"));
  }
}

export const uiBridge = new UIBridge();

/** Fallback without Ink: plain readline prompts. */
async function fallbackAsk({ questions }) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const results = [];
  try {
    for (const q of questions) {
      console.log(`\n${q.header ? `[${q.header}] ` : ""}${q.question}`);
      const options = q.options || [];
      options.forEach((opt, i) => {
        console.log(`  ${i + 1}) ${opt.label}${opt.description ? ` - ${opt.description}` : ""}`);
      });
      if (q.custom !== false) {
        console.log(`  ${options.length + 1}) Write my own answer`);
      }
      const hint = q.multiple ? "(comma-separated for multiple)" : "";
      const raw = (await rl.question(`Choose ${hint}: `)).trim();
      const picked = [];
      for (const token of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = Number(token) - 1;
        if (Number.isInteger(idx) && options[idx]) {
          picked.push(options[idx].label);
        } else if (idx === options.length && q.custom !== false) {
          const custom = (await rl.question("Your answer: ")).trim();
          if (custom) picked.push(custom);
        } else if (token) {
          picked.push(token);
        }
      }
      results.push({ header: q.header, question: q.question, answers: picked });
    }
  } finally {
    rl.close();
  }
  return results;
}
