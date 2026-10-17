/**
 * Per-tool status wording.
 *
 * Each tool moves through three phases:
 *   preparing -> arguments are still streaming in
 *   running   -> the tool is executing
 *   done      -> finished (success or failure)
 */

function shortenPath(p) {
  const s = String(p || "");
  if (!s) return "";
  if (s.length <= 48) return s;
  const parts = s.split("/");
  if (parts.length <= 2) return `…${s.slice(-45)}`;
  return `…/${parts.slice(-2).join("/")}`;
}

function firstLine(text, max = 52) {
  const s = String(text || "").split("\n")[0].trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const STATUS = {
  read: {
    preparing: (a) => (a.path ? `Preparing to read ${shortenPath(a.path)}` : "Preparing to read"),
    running: (a) => (a.path ? `Reading ${shortenPath(a.path)}` : "Reading file"),
    done: (a) => (a.path ? `Read ${shortenPath(a.path)}` : "Read file"),
  },
  write: {
    preparing: (a) => (a.path ? `Preparing to write in ${shortenPath(a.path)}` : "Preparing to write"),
    running: (a) => (a.path ? `Writing ${shortenPath(a.path)}` : "Writing file"),
    done: (a) => (a.path ? `Created the file ${shortenPath(a.path)}` : "Created file"),
  },
  edit: {
    preparing: (a) => (a.path ? `Preparing to edit ${shortenPath(a.path)}` : "Preparing to edit"),
    running: (a) => (a.path ? `Editing the file ${shortenPath(a.path)}` : "Editing file"),
    done: (a) => (a.path ? `Edited the file ${shortenPath(a.path)}` : "Edited file"),
  },
  bash: {
    preparing: (a) => (a.command ? `Preparing to run ${firstLine(a.command)}` : "Preparing to run a command"),
    running: (a) => (a.command ? `Running ${firstLine(a.command)}` : "Running command"),
    done: (a) => (a.command ? `Ran ${firstLine(a.command)}` : "Ran command"),
  },
  ask: {
    preparing: () => "Preparing a question",
    running: () => "Waiting for your answer",
    done: () => "Got your answer",
  },
  skill: {
    preparing: (a) => (a.name ? `Preparing to load skill ${a.name}` : "Preparing to load a skill"),
    running: (a) => (a.name ? `Loading skill ${a.name}` : "Loading skill"),
    done: (a) => (a.name ? `Loaded skill ${a.name}` : "Loaded skill"),
  },
};

/** Status for MCP tools, named mcp__<server>__<tool>. */
function mcpStatus(name, phase) {
  const parts = String(name).split("__");
  const server = parts[1] || "mcp";
  const tool = parts.slice(2).join("__") || name;
  if (phase === "preparing") return `Preparing ${tool} on ${server}`;
  if (phase === "running") return `Running ${tool} on ${server}`;
  return `Finished ${tool} on ${server}`;
}

const FALLBACK = {
  preparing: (a, name) => `Preparing ${name}`,
  running: (a, name) => `Running ${name}`,
  done: (a, name) => `Finished ${name}`,
};

/**
 * @param {string} name  tool name
 * @param {"preparing"|"running"|"done"} phase
 * @param {object} args  arguments, possibly partial
 */
export function toolStatus(name, phase, args = {}) {
  if (String(name).startsWith("mcp__")) return mcpStatus(name, phase);
  const entry = STATUS[name];
  const fn = entry?.[phase] || FALLBACK[phase];
  try {
    return fn(args || {}, name);
  } catch {
    return `${phase} ${name}`;
  }
}

/** Tools whose result is rendered as a diff. */
export const DIFF_TOOLS = new Set(["write", "edit"]);
