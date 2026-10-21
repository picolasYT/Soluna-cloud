import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { getSunModels } from "./sun-models.js";

/** Sun uses OpenAI completions and a separate public capability catalog. */
export class SunProvider extends OpenAICompatibleProvider {
  constructor(options = {}) {
    super({ id: "sun", label: "Sun", baseUrl: "https://sun.soymaycol.icu/v1", apiKeyEnv: "SUN_API_KEY", requiresKey: true, ...options });
  }

  async listModels() { return getSunModels(); }

  async prepare(options) {
    options.signal?.throwIfAborted();
    if (!options.tools?.length) return options;
    // A catalog outage must not prevent a valid completion request.
    const discovery = getSunModels().catch(() => []);
    let models;
    if (options.signal) {
      const signal = options.signal;
      let onAbort;
      const canceled = new Promise((_resolve, reject) => {
        onAbort = () => reject(signal.reason || new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try { models = await Promise.race([discovery, canceled]); }
      finally { signal.removeEventListener("abort", onAbort); }
    } else models = await discovery;
    options.signal?.throwIfAborted();
    const id = options.model || this.defaultModel;
    const model = models.find((item) => item.id === id || item.aliases.includes(id));
    return model?.tools === false ? { ...options, tools: [] } : options;
  }

  async chat(options) { return super.chat(await this.prepare(options)); }

  async stream(options) {
    const prepared = await this.prepare(options);
    // Sun's own playground uses JSON completions for tool calls. Keep that
    // contract so function arguments arrive complete and execute only once.
    if (prepared.tools?.length) {
      const result = await super.chat(prepared);
      if (result.content) options.onTextDelta?.(result.content, result.content);
      return result;
    }
    return super.stream(prepared);
  }
}
