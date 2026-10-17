/**
 * Slash command registry for the TUI.
 *
 * Each command returns an action the app interprets:
 *   { type: "overlay", overlay, props }  -> opens a window
 *   { type: "message", text, tone }      -> prints into the transcript
 *   { type: "exit" }                     -> quits the app
 *   { type: "clear" }                    -> clears the transcript
 *   { type: "noop" }
 */
export const SLASH_COMMANDS = [
  {
    name: "help",
    description: "Show available commands",
    run: () => ({ type: "overlay", overlay: "help" }),
  },
  {
    name: "providers",
    description: "Switch provider, or add a custom one",
    run: () => ({ type: "overlay", overlay: "providers" }),
  },
  {
    name: "setkey",
    description: "Set the API key for a provider",
    run: (args) => ({ type: "overlay", overlay: "setkey", args: args.trim() }),
  },
  {
    name: "openrouter-keys",
    description: "Manage OpenRouter keys and automatic failover",
    run: () => ({ type: "overlay", overlay: "openrouterKeys" }),
  },
  {
    name: "models",
    description: "Switch model, or add a custom one",
    run: () => ({ type: "overlay", overlay: "models" }),
  },
  {
    name: "theme",
    description: "Change the color theme",
    run: () => ({ type: "overlay", overlay: "theme" }),
  },
  {
    name: "tools",
    description: "List the tools available to the agent",
    run: () => ({ type: "overlay", overlay: "tools" }),
  },
  {
    name: "sessions",
    description: "Browse and resume past sessions",
    run: () => ({ type: "overlay", overlay: "sessions" }),
  },
  {
    name: "status",
    description: "Show session info and token usage",
    run: () => ({ type: "overlay", overlay: "session" }),
  },
  {
    name: "skills",
    description: "List available skills",
    run: () => ({ type: "overlay", overlay: "skills" }),
  },
  {
    name: "mcp",
    description: "Manage MCP servers",
    run: () => ({ type: "overlay", overlay: "mcp" }),
  },
  {
    name: "config",
    description: "Show config file locations and settings",
    run: () => ({ type: "overlay", overlay: "config" }),
  },
  {
    name: "resume",
    description: "Resume the most recent session for this project",
    run: () => ({ type: "resume" }),
  },
  {
    name: "save",
    description: "Save the current session now",
    run: () => ({ type: "save" }),
  },
  {
    name: "cwd",
    description: "Show or change the working directory",
    run: (args) =>
      args.trim()
        ? { type: "cwd", value: args.trim() }
        : { type: "overlay", overlay: "cwd" },
  },
  {
    name: "compact",
    description: "Summarize the conversation to free up context",
    run: () => ({ type: "compact" }),
  },
  {
    name: "clear",
    description: "Clear the conversation",
    run: () => ({ type: "clear" }),
  },
  {
    name: "exit",
    description: "Quit Soluna",
    run: () => ({ type: "exit" }),
  },
];

export function findCommand(name) {
  const key = String(name || "").toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name === key) || null;
}

export function matchCommands(input) {
  const raw = String(input || "");
  if (!raw.startsWith("/")) return [];
  const query = raw.slice(1).split(" ")[0].toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
}

export function parseCommand(input) {
  const raw = String(input || "").trim();
  if (!raw.startsWith("/")) return null;
  const body = raw.slice(1);
  const spaceAt = body.indexOf(" ");
  const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
  const args = spaceAt === -1 ? "" : body.slice(spaceAt + 1);
  const command = findCommand(name);
  if (!command) return { unknown: name };
  return { command, args };
}
