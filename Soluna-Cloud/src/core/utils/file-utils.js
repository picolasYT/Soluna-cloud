import { readFile, writeFile, mkdir, access, constants } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { IMAGE_MIME_TYPES, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../config/constants.js";

/**
 * Resolve a path relative to the working directory
 */
export function resolveToCwd(path, cwd) {
  if (isAbsolute(path)) return resolve(path);
  return resolve(cwd, path);
}

/**
 * Check whether a file is readable
 */
export async function fileExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect an image MIME type from the file extension
 */
export function detectImageMimeType(filePath) {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  return ext ? IMAGE_MIME_TYPES[ext] || null : null;
}

/**
 * Read a file as UTF-8 text
 */
export async function readFileAsText(path) {
  const buffer = await readFile(path);
  return buffer.toString("utf-8");
}

/**
 * Read a file as a Buffer
 */
export async function readFileAsBuffer(path) {
  return readFile(path);
}

/**
 * Detect whether a buffer is binary (contains NUL bytes or an excess of
 * control characters). Used to avoid dumping binary garbage into the model.
 */
export function isBinaryBuffer(buffer, { sampleBytes = 2048 } = {}) {
  const sample = buffer.length > sampleBytes ? buffer.subarray(0, sampleBytes) : buffer;
  if (sample.includes(0)) return true;

  let controls = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b < 9 || (b > 13 && b < 32) || b === 127) controls++;
  }
  return controls / sample.length > 0.3;
}

/**
 * Write content to a file, creating parent directories
 */
export async function writeFileContent(path, content) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(path, content, "utf-8");
}

/**
 * Truncate content that exceeds the line or byte limit
 */
export function truncateContent(content, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES) {
  const lines = content.split("\n");
  let truncated = false;
  let truncatedBy = null;

  let selectedLines = lines;
  if (lines.length > maxLines) {
    selectedLines = lines.slice(0, maxLines);
    truncated = true;
    truncatedBy = "lines";
  }

  let output = selectedLines.join("\n");
  if (Buffer.byteLength(output, "utf-8") > maxBytes) {
    // Truncate by bytes
    const buffer = Buffer.from(output, "utf-8");
    output = buffer.subarray(0, maxBytes).toString("utf-8");
    truncated = true;
    truncatedBy = truncatedBy || "bytes";
  }

  return {
    content: output,
    truncated,
    truncatedBy,
    totalLines: lines.length,
    outputLines: selectedLines.length,
  };
}

/**
 * Keep the END of the content when it exceeds the line or byte limit.
 * Command output carries its important part (errors, test summaries) at the
 * end, so the bash tool keeps the tail instead of the head.
 */
export function truncateTailContent(content, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES) {
  const lines = content.split("\n");
  let truncated = false;
  let truncatedBy = null;

  let selectedLines = lines;
  if (lines.length > maxLines) {
    selectedLines = lines.slice(lines.length - maxLines);
    truncated = true;
    truncatedBy = "lines";
  }

  let output = selectedLines.join("\n");
  if (Buffer.byteLength(output, "utf-8") > maxBytes) {
    const buffer = Buffer.from(output, "utf-8");
    output = buffer.subarray(buffer.length - maxBytes).toString("utf-8").replace(/^\uFFFD+/, "");
    truncated = true;
    truncatedBy = truncatedBy || "bytes";
  }

  return {
    content: output,
    truncated,
    truncatedBy,
    totalLines: lines.length,
    outputLines: output.split("\n").length,
  };
}

/**
 * Detect the dominant line ending of a text. Returns "\r\n" or "\n".
 */
export function detectLineEnding(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  if (crlf === 0) return "\n";
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf >= lf ? "\r\n" : "\n";
}

/** Convert every line ending in `text` to `eol`. */
export function normalizeLineEndings(text, eol) {
  return text.replace(/\r\n|\n/g, eol);
}

/**
 * Infer the programming language from a file extension
 */
export function getLanguageFromPath(path) {
  const ext = path.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  const langMap = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    css: "css",
    html: "html",
    json: "json",
    md: "markdown",
    sh: "bash",
    bash: "bash",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sql: "sql",
    graphql: "graphql",
    xml: "xml",
  };
  return langMap[ext] || null;
}
