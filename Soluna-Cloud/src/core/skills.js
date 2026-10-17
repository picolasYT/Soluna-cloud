import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILLS_DIR } from "./session-store.js";

/**
 * Skills: specialised instructions the agent loads on demand.
 *
 * Uses the same layout as Claude Code and Codex:
 *
 *   <dir>/<nombre>/SKILL.md
 *   ---
 *   name: pdf-processing
 *   description: Use when the user needs to extract text from PDFs
 *   ---
 *   # instrucciones en markdown...
 *
 * Two locations are searched:
 *   ~/.soluna/skills/     user-wide
 *   <cwd>/.soluna/skills/ project-local (takes precedence)
 *
 * Only `description` goes into the prompt. The body loads when the agent
 * calls the `skill` tool, so unused workflows cost no context.
 */

/** Parse the minimal YAML frontmatter (key: value). */
export function parseFrontmatter(text) {
  const src = String(text || "");
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: src.trim() };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: match[2].trim() };
}

async function readSkillsFrom(dir, source) {
  const skills = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    try {
      await stat(skillPath);
    } catch {
      continue;
    }

    try {
      const raw = await readFile(skillPath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      const name = meta.name || entry.name;
      const description = meta.description || "";
      if (!description) continue; // without a description the model cannot know when to use it
      skills.push({ name, description, body, path: skillPath, source });
    } catch {
      // Unreadable skill: skip it rather than break startup.
    }
  }
  return skills;
}

/**
 * Discover available skills.
 * Project skills override user skills with the same name.
 */
export async function discoverSkills(cwd) {
  const global = await readSkillsFrom(SKILLS_DIR, "user");
  const project = cwd
    ? [
        ...(await readSkillsFrom(join(cwd, ".soluna", "skills"), "project")),
        ...(await readSkillsFrom(join(cwd, ".zyn", "skills"), "project")),
      ]
    : [];

  const byName = new Map();
  for (const s of global) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Skills index for the system prompt.
 *
 * Only name, description and location: the minimum for the model to know a
 * skill exists and when it applies. The body loads through the `skill`
 * tool so unused workflows cost no context.
 *
 * XML-style, like Claude Code and Codex: it delimits the block so the model
 * does not mistake it for user instructions.
 */
export function renderSkillsPrompt(skills) {
  if (!skills || skills.length === 0) return "";

  const entries = skills
    .map(
      (s) =>
        `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.path}</location>\n  </skill>`,
    )
    .join("\n");

  return `
Skills provide specialized instructions and workflows for specific tasks.
Use the \`skill\` tool to load one when the task matches its description.
Only the index is preloaded; the full instructions load on demand.

<available_skills>
${entries}
</available_skills>`;
}

/** Tool that loads a skill's full instructions. */
export function createSkillTool(skills) {
  const byName = new Map((skills || []).map((s) => [s.name, s]));

  return {
    name: "skill",
    description:
      "Load a specialized skill when the task matches one of the available skills. Returns detailed instructions to follow.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the skill to load",
          enum: [...byName.keys()],
        },
      },
      required: ["name"],
    },
    async execute({ name }) {
      const skill = byName.get(name);
      if (!skill) {
        const available = [...byName.keys()].join(", ") || "(none)";
        throw new Error(`Skill "${name}" not found. Available: ${available}`);
      }
      return {
        content: [
          {
            type: "text",
            text: `# Skill: ${skill.name}\n\n${skill.body}`,
          },
        ],
        details: { skill: skill.name, source: skill.source },
      };
    },
  };
}
