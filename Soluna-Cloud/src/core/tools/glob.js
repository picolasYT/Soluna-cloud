import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const globToolSystemPrompt = {
  snippet: "Find files and directories by glob pattern",
  guidelines: ["Use glob to locate files by name or pattern instead of guess-and-check."],
};

/**
 * Convert a glob pattern to a RegExp. Supports `**`, `*`, and `?`.
 * Paths are matched on both absolute and workspace-relative forms.
 */
export function globToRegExp(pattern) {
  function toSource(glob) {
    let source = "";
    for (let i = 0; i < glob.length; i++) {
      const char = glob[i];
      if (glob.startsWith("**/", i)) {
        source += "(?:.*/)?";
        i += 2;
      } else if (glob.startsWith("**", i)) {
        source += ".*";
        i++;
      } else if (char === "*") {
        source += "[^/]*";
      } else if (char === "?") {
        source += "[^/]";
      } else if (char === "{") {
        const end = glob.indexOf("}", i + 1);
        if (end !== -1) {
          const choices = glob.slice(i + 1, end).split(",");
          if (choices.length > 1) {
            source += `(?:${choices.map(toSource).join("|")})`;
            i = end;
          } else {
            source += "\\{";
          }
        } else {
          source += "\\{";
        }
      } else if (".+^$()|[]\\}".includes(char)) {
        source += `\\${char}`;
      } else {
        source += char;
      }
    }
    return source;
  }

  return new RegExp(`^${toSource(pattern)}$`);
}

async function walk(dir, depth = 0, maxDepth = 32) {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(full, depth + 1, maxDepth)));
    } else if (entry.isSymbolicLink()) {
      continue; // never follow symlinks when globbing
    }
    results.push(full);
  }
  return results;
}

/**
 * Create the glob tool definition.
 * `workspace` guards the search root.
 */
export function createGlobTool(workspace) {
  return {
    name: "glob",
    description:
      "Fast file search by glob pattern (e.g. `**/*.js`, `src/**/*.test.*`, `*.{ts,tsx}`). Searches the workspace from the current directory. Results are capped; use a more specific pattern if the list is large. Never follows symlinks, skips .git and node_modules.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match against file paths" },
        path: {
          type: "string",
          description: "Directory to search within (relative to the workspace root). Defaults to the workspace root.",
        },
        limit: { type: "number", description: "Maximum number of results to return (default 200, max 1000)" },
      },
      required: ["pattern"],
    },
    async execute({ pattern, path, limit }) {
      if (typeof pattern !== "string" || pattern.trim() === "") {
        throw new Error("glob requires a 'pattern' argument (string)");
      }
      const cap = Math.min(Math.max(1, Number(limit) || 200), 1000);

      const base = await workspace.resolvePath(path || ".", { mustExist: true });
      const re = globToRegExp(pattern.replace(/\\/g, "/"));

      const all = await walk(base);
      const matches = all
        .map((f) => relative(workspace.root, f).replace(/\\/g, "/"))
        .filter((rel) => rel !== "" && rel !== ".." && !rel.startsWith("../") && re.test(rel))
        .sort();

      const shown = matches.slice(0, cap);
      const text = shown.length === 0
        ? `No files match "${pattern}".`
        : shown.join("\n") + (matches.length > cap ? `\n\n(${matches.length - cap} more matches — narrow the pattern)` : "");

      return {
        content: [{ type: "text", text }],
        details: { count: matches.length },
      };
    },
  };
}
