#!/usr/bin/env node
/**
 * Soluna Web — launch the Soluna agent web UI.
 *
 * See `soluna web --help` for the full option list. This binary exists so the
 * web server can also be started directly:
 *
 *   node bin/soluna-web.js [--port 3456] [--host 0.0.0.0] [--cwd /path]
 */
import { main } from "../src/web/launcher.js";

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
