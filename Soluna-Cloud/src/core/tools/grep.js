import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const grepToolSystemPrompt = {
  snippet: "Search file contents",
  guidelines: ["Use grep to find code or text by content, not guess-and-check."],
};

/**
 * Create the grep tool definition.
 * `workspace` guards the search root.
 */
export function createGrepTool(workspace) {
  return {
    name: "grep",
    description:
      "Search file contents for a pattern. Returns file paths and line numbers with matching lines. Search a directory recursively (skipping .git and node_modules) or a single file. Case-insensitive by default.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: {
          type: "string",
          description: "File or directory to search. Relative to the workspace root. Defaults to the workspace root.",
        },
        include: { type: "string", description: "File name glob filter (e.g. '*.js', '*.{ts,tsx}')" },
        caseSensitive: { type: "boolean", description: "Match case exactly (default false)" },
        limit: { type: "number", description: "Maximum results (default 100)" },
      },
      required: ["pattern"],
    },
    async execute({ pattern, path, include, caseSensitive, limit }) {
      if (typeof pattern !== "string" || pattern.trim() === "") {
        throw new Error("grep requires a 'pattern' argument (string)");
      }
      let re;
      try {
        re = new RegExp(pattern, caseSensitive ? "" : "i");
      } catch (err) {
        throw new Error(`grep: invalid regular expression: ${err.message}`);
      }
      const cap = Math.min(Math.max(1, Number(limit) || 100), 500);

      const abs = await workspace.resolvePath(path || ".", { mustExist: true });
      const includeRe = include ? new RegExp(`^${include.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "[^/]")}$`) : null;

      const matches = [];
      await walk(abs, async (file) => {
        if (matches.length >= cap * 20) return;
        const rel = relative(workspace.root, file).split(sep).join("/");
        if (includeRe && !includeRe.test(file.split(/[\\/]/).pop())) return;
        let content;
        try {
          content = await readText(file);
        } catch {
          return;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= cap) break;
          if (re.test(lines[i])) {
            matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 240) });
          }
        }
      });

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${pattern}".` }], details: { count: 0 } };
      }

      const shown = matches.slice(0, cap);
      const linesOut = shown.map((m) => `${m.file}:${m.line}:${m.text}`);
      if (matches.length > cap) linesOut.push(`\n(${matches.length - cap} more matches — narrow the pattern or raise the limit)`);

      return {
        content: [{ type: "text", text: linesOut.join("\n") }],
        details: { count: matches.length },
      };
    },
  };
}

async function readText(file) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(file);
  // Cheap binary sniff: NUL bytes or many control chars.
  let controls = 0;
  for (let i = 0; i < Math.min(buf.length, 2048); i++) {
    const b = buf[i];
    if (b === 0) return "\n";
    if (b < 9 || (b > 13 && b < 32)) controls++;
  }
  if (controls / Math.min(buf.length, 2048) > 0.3) return "\n";
  return buf.toString("utf-8");
}

async function walk(dir, onFile) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}
