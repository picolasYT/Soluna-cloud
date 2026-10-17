import { readdir } from "node:fs/promises";

export const lsToolSystemPrompt = {
  snippet: "List files and directories",
  guidelines: ["Use ls to inspect a directory before navigating or reading."],
};

/**
 * Create the ls tool definition.
 * `workspace` guards the listed directory.
 */
export function createLsTool(workspace) {
  return {
    name: "ls",
    description:
      "List the contents of a directory. Returns directories and files, sorted, with types. Handy for orienting yourself before reading or editing.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to list, relative to the workspace root. Defaults to the workspace root.",
        },
        limit: { type: "number", description: "Maximum entries to return (default 200)" },
      },
      required: [],
    },
    async execute({ path, limit }) {
      const cap = Math.min(Math.max(1, Number(limit) || 200), 1000);
      const abs = await workspace.resolvePath(path || ".", { mustExist: true });

      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch (err) {
        throw new Error(`ls: cannot read "${path || "."}": ${err.message}`);
      }

      const dirs = [];
      const files = [];
      for (const e of entries) {
        if (e.name.startsWith(".git")) continue;
        (e.isDirectory() ? dirs : files).push(e.name);
      }
      dirs.sort((a, b) => a.localeCompare(b));
      files.sort((a, b) => a.localeCompare(b));

      const all = [...dirs.map((d) => `${d}/`), ...files];
      const shown = all.slice(0, cap);
      const header = shown.length === 0 ? "(empty directory)" : `${dirs.length} dir(s), ${files.length} file(s)`;
      const text = shown.length === 0 ? header : `${header}\n${shown.join("\n")}${all.length > cap ? `\n... (${all.length - cap} more)` : ""}`;

      return {
        content: [{ type: "text", text }],
        details: { dirs: dirs.length, files: files.length },
      };
    },
  };
}
