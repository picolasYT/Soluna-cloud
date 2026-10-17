import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileExists } from "./utils/file-utils.js";

/**
 * Project instructions.
 *
 * Following the convention shared by Claude Code, Codex and opencode, an
 * AGENTS.md at the workspace root (or, failing that, a CLAUDE.md) is loaded
 * into the system prompt so the agent follows the project's own rules:
 * build/test commands, conventions, do-not-touch areas, etc.
 */

const CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

/**
 * Read the project instruction file, if any.
 * @param {string} cwd
 * @returns {Promise<{file: string, content: string} | null>}
 */
export async function loadProjectInstructions(cwd) {
  for (const name of CANDIDATES) {
    const file = join(cwd, name);
    if (await fileExists(file)) {
      try {
        const content = await readFile(file, "utf-8");
        if (content.trim()) return { file, content };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Render project instructions as a system-prompt block. */
export function renderProjectInstructions(instructions) {
  if (!instructions) return "";
  return `
# Project Instructions (from ${instructions.file})

Follow these project-specific rules. They take precedence over generic habits
when they conflict.

<project_instructions>
${instructions.content.trim()}
</project_instructions>`;
}
