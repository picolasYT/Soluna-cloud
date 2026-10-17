import { readFileAsBuffer, readFileAsText, detectImageMimeType, truncateContent, isBinaryBuffer, fileExists } from "../utils/file-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../config/constants.js";

/**
 * System prompt contribution for the read tool
 */
export const readToolSystemPrompt = {
  snippet: "Read file contents",
  guidelines: ["Use read to examine files instead of cat or sed."],
};

/**
 * Create the read tool definition.
 * `workspace` guards the path so the agent cannot read outside its sandbox.
 */
export function createReadTool(workspace) {
  return {
    name: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    async execute({ path, offset, limit }, signal) {
      if (typeof path !== "string" || path.trim() === "") {
        throw new Error("read requires a 'path' argument (string)");
      }
      if (offset !== undefined && (typeof offset !== "number" || !Number.isFinite(offset) || offset < 1)) {
        throw new Error(`read: 'offset' must be a positive number, got ${JSON.stringify(offset)}`);
      }
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1)) {
        throw new Error(`read: 'limit' must be a positive number, got ${JSON.stringify(limit)}`);
      }

      if (signal?.aborted) throw new Error("Operation aborted");

      const absolutePath = await workspace.resolvePath(path, { mustExist: true });

      if (!(await fileExists(absolutePath))) {
        throw new Error(`File not found: ${path}`);
      }

      // Check whether this is an image
      const mimeType = detectImageMimeType(absolutePath);
      if (mimeType) {
        const buffer = await readFileAsBuffer(absolutePath);
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", data: buffer.toString("base64"), mimeType },
          ],
        };
      }

      // Read as text
      const buffer = await readFileAsBuffer(absolutePath);
      if (isBinaryBuffer(buffer)) {
        throw new Error(
          `Refusing to read "${path}": it appears to be a binary file. ` +
            `Use bash (e.g. 'file ${path}' or 'strings') to inspect it instead.`,
        );
      }

      const textContent = buffer.toString("utf-8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
      const allLines = textContent.split("\n");
      const totalFileLines = allLines.length;

      // Apply the offset
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
      }

      let selectedContent;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      // Truncate when needed
      const truncation = truncateContent(selectedContent);
      let outputText = truncation.content;

      if (truncation.truncated) {
        const startLineDisplay = startLine + 1;
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
      }

      return {
        content: [{ type: "text", text: outputText }],
        details: { truncation },
      };
    },
  };
}
