/**
 * Shared launcher for the web server.
 *
 * Used by both `soluna web` and the standalone `bin/soluna-web.js` entry point.
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/session-store.js";
import { buildCatalog } from "../providers/catalog.js";
import { startWebServer } from "./server.js";
import { APP_DISPLAY_NAME, APP_VERSION, APP_REPO } from "../config/constants.js";
import { logger, setDebug } from "../core/logger.js";

process.on("uncaughtException", (err) => {
  console.error(`Fatal error: ${err.message}`);
  logger.flush().finally(() => process.exit(1));
});

function parseArgs(args) {
  const options = {
    host: process.env.SOLUNA_WEB_HOST || "localhost",
    port: Number(process.env.SOLUNA_WEB_PORT || process.env.PORT || process.env.ZYN_WEB_PORT) || 3456,
    cwd: process.cwd(),
    unsafe: true,
    noMcp: false,
    token: process.env.SOLUNA_WEB_TOKEN || null,
    provider: null,
    model: null,
    verbose: false,
    addDir: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--host":
        options.host = args[++i];
        break;
      case "--port":
      case "-p":
        options.port = Number(args[++i]);
        break;
      case "--cwd":
      case "-d":
        options.cwd = resolve(args[++i]);
        break;
      case "--add-dir":
        options.addDir.push(resolve(args[++i]));
        break;
      case "--token":
        options.token = args[++i];
        break;
      case "--no-unsafe":
        options.unsafe = false;
        break;
      case "--no-mcp":
        options.noMcp = true;
        break;
      case "--provider":
        options.provider = args[++i];
        break;
      case "--model":
        options.model = args[++i];
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        console.log(`${APP_DISPLAY_NAME} v${APP_VERSION} — web UI\nBased on: ${APP_REPO}\n
Usage:
  soluna web [options]

Options:
  --host <addr>     Interface to bind (default localhost)
  -p, --port <n>    Port (default ${options.port})
  -d, --cwd <path>  Working directory (default cwd)
  --add-dir <path>  Allow an extra directory
  --token <secret>  Require this token (URL query or Bearer header)
  --no-unsafe       Keep sandbox + command approval ON
  --no-mcp          Skip loading MCP servers
  --provider <id>   Provider to use
  --model <id>      Model to use
  -v, --verbose     Verbose output
  -h, --help        Show this help
`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  return options;
}

export async function runWeb(args = []) {
  const options = parseArgs(args);
  setDebug(options.verbose || Boolean(process.env.SOLUNA_DEBUG || process.env.ZYN_DEBUG));
  const { token: _token, ...safeOptions } = options;
  logger.info("web server starting", { ...safeOptions, tokenConfigured: Boolean(_token) });

  const config = await loadConfig();
  const catalog = buildCatalog(config);
  const provider = options.provider || config.provider || null;
  const model = options.model || config.model || null;

  const instance = await startWebServer({
    cwd: options.cwd,
    host: options.host,
    port: options.port,
    addDir: options.addDir,
    unsafe: options.unsafe,
    noMcp: options.noMcp,
    token: options.token,
    initialProvider: provider,
    initialModel: model,
  });

  const url = `http://${options.host === "0.0.0.0" ? "localhost" : options.host}:${instance.port}`;
  const access = process.env.RENDER_EXTERNAL_URL || url;

  console.log(`
${APP_DISPLAY_NAME} v${APP_VERSION} — web UI
  Open:        ${access}
  Sign-in:     ${options.token ? "access token configured" : "no token required"}
  Working dir: ${instance.cwd}
  Provider:    ${instance.providerId || "not set (pick one in the UI)"}
  Model:       ${instance.model || "default"}
  Guardrails:  ${options.unsafe ? "OFF (shell commands run without prompting)" : "ON (risky commands need your approval in the browser)"}
  Ctrl-C to stop
`);
}

/** Used by bin/soluna-web.js to run directly. */
export async function main() {
  await runWeb(process.argv.slice(2));
  // The server keeps the process alive; this line is only reached on close.
}
