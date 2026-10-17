import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Directory that holds the web UI static files (HTML/CSS/JS). */
export function webDir() {
  return join(__dirname, "client");
}

/** Directory that holds the client-side assets (HTML/CSS/JS). */
export function clientBase() {
  return join(__dirname, "client");
}

/** Resolve a static asset path under the client dir. */
export function clientResolve(...parts) {
  return join(clientBase(), ...parts);
}

let cachedIndex = null;
/** The index page. Loaded once and cached. */
export function indexHtml() {
  if (cachedIndex) return cachedIndex;
  try {
    cachedIndex = readFileSync(join(webDir(), "index.html"), "utf-8");
  } catch {
    cachedIndex =
      "<!doctype html><meta charset=utf-8><title>Soluna Web</title>" +
      "<pre>The web UI could not be found. Run <code>soluna web</code> from the project root.</pre>";
  }
  return cachedIndex;
}

let cachedLogin = null;
/** Small self-contained sign-in page used when cloud access is protected. */
export function loginHtml() {
  if (cachedLogin) return cachedLogin;
  try {
    cachedLogin = readFileSync(join(webDir(), "login.html"), "utf-8");
  } catch {
    cachedLogin = "<!doctype html><meta charset=utf-8><title>Soluna Cloud</title><p>Soluna sign-in page unavailable.</p>";
  }
  return cachedLogin;
}

/** Unique id for a run / request. */
export function newRunId() {
  return randomUUID().slice(0, 8);
}
