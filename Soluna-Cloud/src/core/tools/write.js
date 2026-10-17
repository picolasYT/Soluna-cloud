import { writeFileContent, fileExists, readFileAsText, detectLineEnding, normalizeLineEndings } from "../utils/file-utils.js";
import { diffLines } from "../diff.js";

/**
 * System prompt contribution for the write tool
 */
export const writeToolSystemPrompt = {
  snippet: "Create or overwrite files",
  guidelines: ["Use write only for new files or complete rewrites."],
};

/**
 * Create the write tool definition.
 * `workspace` guards the path so the agent cannot write outside its sandbox.
 */
export function createWriteTool(workspace) {
  return {
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write (relative or absolute)" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    async execute({ path, content: input }, signal) {
      let content = input;
      if (typeof path !== "string" || path.trim() === "") {
        throw new Error("write requires a 'path' argument (string)");
      }
      if (typeof content !== "string") {
        throw new Error(`write: 'content' must be a string, got ${typeof content}`);
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const absolutePath = await workspace.resolvePath(path);

      // Capture the previous state so we can render a diff.
      const existed = await fileExists(absolutePath);
      const before = existed ? await readFileAsText(absolutePath) : "";

      // Overwriting a CRLF file with LF text would rewrite every line in git.
      if (existed && before.includes("\r\n") && !content.includes("\r\n") && detectLineEnding(before) === "\r\n") {
        content = normalizeLineEndings(content, "\r\n");
      }

      await writeFileContent(absolutePath, content);

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const diff = diffLines(before, content);

      return {
        content: [
          {
            type: "text",
            text: `Successfully wrote ${content.length} bytes to ${path} (+${diff.added} -${diff.removed})`,
          },
        ],
        details: {
          diff: {
            path,
            added: diff.added,
            removed: diff.removed,
            lines: diff.lines,
            isNew: !existed,
          },
        },
      };
    },
  };
}
