const cursors = new Map();

export function shouldRotateKey(status, message = "") {
  return [401, 402, 429].includes(status)
    || ([400, 403].includes(status) && /insufficient_quota|quota.*exceed|credit.*(?:low|insufficient|exhaust)|balance.*(?:low|insufficient)/i.test(message));
}

/** Add failover to dedicated adapters without replaying emitted output or tools. */
export function withKeyFailover(provider, { id, keys, onKeyRotation }) {
  provider.apiKeys = keys;
  provider.keyIndex = keys.length ? (cursors.get(id) || 0) % keys.length : 0;
  if (keys.length < 2) return provider;
  for (const method of ["chat", "stream"]) {
    if (typeof provider[method] !== "function") continue;
    const original = provider[method].bind(provider);
    provider[method] = async (options) => {
      for (let attempt = 0; attempt < keys.length; attempt++) {
        if (options.signal?.aborted) throw new Error("aborted");
        provider.apiKey = keys[provider.keyIndex];
        let emitted = false;
        const wrapped = { ...options };
        for (const callback of ["onTextDelta", "onToolDelta", "executeTool"]) {
          if (typeof options[callback] === "function") wrapped[callback] = (...args) => {
            emitted = true;
            return options[callback](...args);
          };
        }
        try {
          return await original(wrapped);
        } catch (error) {
          const status = error.status || Number(error.message?.match(/API error:?\s*(\d{3})/i)?.[1])
            || (/free but requires auth/i.test(error.message) ? 401 : 0);
          if (emitted || options.signal?.aborted || !shouldRotateKey(status, error.message) || attempt + 1 >= keys.length) throw error;
          const failedKey = provider.keyIndex + 1;
          provider.keyIndex = (provider.keyIndex + 1) % keys.length;
          cursors.set(id, provider.keyIndex);
          onKeyRotation?.({ failedKey, nextKey: provider.keyIndex + 1, keyCount: keys.length, status });
        }
      }
    };
  }
  return provider;
}
