import { fileExists, readFileAsText, writeFileContent, detectLineEnding, normalizeLineEndings } from "../utils/file-utils.js";
import { diffLines } from "../diff.js";

/**
 * System prompt contribution for the edit tool
 */
export const editToolSystemPrompt = {
  snippet: "Edit files using search and replace",
  guidelines: [
    "Use edit to make targeted changes to existing files.",
    "Always provide enough context in old_string to uniquely identify the location.",
  ],
};

/**
 * Create the edit tool definition.
 * `workspace` guards the path so the agent cannot edit outside its sandbox.
 */
export function createEditTool(workspace) {
  return {
    name: "edit",
    description:
      "Edit a file by replacing occurrences of old_string with new_string. Use this for targeted changes. old_string must match exactly (including whitespace).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        old_string: { type: "string", description: "String to find and replace (must match exactly)" },
        new_string: { type: "string", description: "String to replace with" },
        replace_all: { type: "boolean", description: "Replace all occurrences (default: false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute({ path, old_string, new_string, replace_all }, signal) {
      if (typeof path !== "string" || path.trim() === "") {
        throw new Error("edit requires a 'path' argument (string)");
      }
      if (typeof old_string !== "string" || old_string === "") {
        throw new Error("edit: 'old_string' must be a non-empty string");
      }
      if (typeof new_string !== "string") {
        throw new Error(`edit: 'new_string' must be a string, got ${typeof new_string}`);
      }

      const absolutePath = await workspace.resolvePath(path, { mustExist: true });

      if (!(await fileExists(absolutePath))) {
        throw new Error(`File not found: ${path}`);
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const content = await readFileAsText(absolutePath);

      // The model writes "\n"; a file saved on Windows uses "\r\n". When the
      // exact text is missing, retry with the file's own line endings and
      // keep them in the replacement so the file is not left half-converted.
      let needle = old_string;
      let replacement = new_string;
      if (!content.includes(needle)) {
        const eol = detectLineEnding(content);
        const adapted = normalizeLineEndings(old_string, eol);
        if (eol === "\r\n" && adapted !== old_string && content.includes(adapted)) {
          needle = adapted;
          replacement = normalizeLineEndings(new_string, eol);
        } else if (content.charCodeAt(0) === 0xfeff && content.slice(1).includes(old_string)) {
          // old_string was copied without the invisible byte-order mark.
          needle = old_string;
        } else {
          throw new Error(`old_string not found in ${path}`);
        }
      }

      // Perform the replacement
      let newContent;
      if (replace_all) {
        newContent = content.split(needle).join(replacement);
      } else {
        // Replace only the first occurrence
        const index = content.indexOf(needle);
        newContent = content.substring(0, index) + replacement + content.substring(index + needle.length);
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      await writeFileContent(absolutePath, newContent);

      const replacements = replace_all ? content.split(needle).length - 1 : 1;
      const diff = diffLines(content, newContent);

      return {
        content: [
          {
            type: "text",
            text: `Successfully applied ${replacements} replacement(s) to ${path} (+${diff.added} -${diff.removed})`,
          },
        ],
        details: {
          diff: {
            path,
            added: diff.added,
            removed: diff.removed,
            lines: diff.lines,
            isNew: false,
          },
        },
      };
    },
  };
}
