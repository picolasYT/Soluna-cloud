/**
 * Parsing of incomplete JSON.
 *
 * While the model streams a tool's arguments we receive fragments such as
 * `{"path": "src/ap`. We need to read `path` before the stream finishes so
 * we can show "Preparing to write in src/app.js".
 *
 * The strategy is to close open structures and retry JSON.parse.
 */

/** Parse complete or partial JSON. Returns null when nothing is usable. */
export function parsePartialJSON(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to the repair path.
  }

  const repaired = repair(raw);
  if (repaired === null) return null;

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

/**
 * Close open strings, arrays and objects to produce valid JSON.
 * Drops a trailing key that has no value yet.
 */
function repair(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let result = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    result += ch;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // A dangling backslash would invalidate the string.
  if (escaped) result = result.slice(0, -1);

  if (inString) {
    // If the open string is a half-typed KEY (its ":" has not arrived yet)
    // it must be dropped entirely. Closing it would produce `{"a":1,"b"}`,
    // which is invalid JSON and would lose the fields already complete.
    const lastQuote = result.lastIndexOf('"');
    const beforeQuote = result.slice(0, lastQuote);
    const isDanglingKey = /[{,]\s*$/.test(beforeQuote);
    if (isDanglingKey) {
      result = beforeQuote.replace(/[,\s]*$/, "");
    } else {
      result += '"';
    }
  }

  // Trim value-less leftovers. Covers both intermediate states:
  //   `{"a":1,"b"`   key closed, no ":" yet
  //   `{"a":1,"b":`  key with ":", no value yet
  result = result.replace(/,\s*$/, "");
  result = result.replace(/[{,]\s*"(?:[^"\\]|\\.)*"\s*(?::\s*)?$/, (m) => (m[0] === "{" ? "{" : ""));
  result = result.replace(/[{[]\s*,/, (m) => m[0]);
  result = result.replace(/,\s*$/, "");

  for (let i = stack.length - 1; i >= 0; i--) {
    result += stack[i] === "{" ? "}" : "]";
  }

  // An empty `{}` after trimming carries no data but is valid JSON.
  return result;
}

/**
 * Read a string key from possibly incomplete JSON, even while its value
 * is still streaming.
 */
export function peekString(text, key) {
  const parsed = parsePartialJSON(text);
  if (parsed && typeof parsed[key] === "string") return parsed[key];

  // The value may be mid-stream and have been dropped by the repair.
  const raw = String(text || "");
  const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "");
  const match = raw.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}
