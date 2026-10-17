import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Cross-platform shell discovery and process helpers.
 *
 * Soluna runs on Linux, macOS, Windows (Git Bash / PowerShell) and Android
 * (Termux). Each one needs different handling:
 *
 *   - Termux has no /bin/bash, /bin/sh, /tmp or sudo. Everything lives under
 *     $PREFIX (/data/data/com.termux/files/usr). Node reports the platform as
 *     "android" there.
 *   - Windows may expose a `bash.exe` that is really WSL (System32\bash.exe),
 *     which runs inside a different filesystem. That one must NOT be used;
 *     Git Bash is fine, otherwise we fall back to PowerShell.
 */

const TERMUX_PREFIX = "/data/data/com.termux/files/usr";

export function isWindows() {
  return process.platform === "win32";
}

/** True when running inside Termux on Android. */
export function isTermux() {
  return (
    process.platform === "android" ||
    Boolean(process.env.TERMUX_VERSION) ||
    /com\.termux/.test(process.env.PREFIX || "") ||
    /com\.termux/.test(process.env.HOME || "")
  );
}

/** Short label of the platform for prompts and error messages. */
export function platformLabel() {
  if (isTermux()) return "Termux (Android)";
  if (isWindows()) return "Windows";
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}

/** Directory that holds binaries on Termux ($PREFIX/bin), if applicable. */
export function termuxBin() {
  const prefix = process.env.PREFIX || TERMUX_PREFIX;
  return join(prefix, "bin");
}

function isExecutable(file) {
  try {
    accessSync(file, isWindows() ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on PATH (honours PATHEXT on Windows). */
export function which(name, env = process.env) {
  const pathVar = env.PATH || env.Path || env.path || "";
  const dirs = pathVar.split(delimiter).filter(Boolean);
  const exts = isWindows()
    ? ["", ...(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ""), name + ext);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Environment for child processes, with a usable PATH on every platform. */
export function buildChildEnv(base = process.env) {
  const env = { ...base };
  if (isTermux()) {
    const bin = termuxBin();
    const parts = (env.PATH || "").split(delimiter).filter(Boolean);
    if (existsSync(bin) && !parts.includes(bin)) env.PATH = [bin, ...parts].join(delimiter);
    env.PREFIX ||= process.env.PREFIX || TERMUX_PREFIX;
    const tmp = join(env.PREFIX, "tmp");
    if (!env.TMPDIR && existsSync(tmp)) env.TMPDIR = tmp;
  }
  return env;
}

/**
 * Locations where a POSIX shell can live, best first. The PATH lookup comes
 * first so a user-installed bash wins; the hard-coded paths cover minimal
 * environments (no PATH, Termux launched from an app, Android system sh).
 */
function posixShellCandidates(env) {
  const prefix = env.PREFIX || TERMUX_PREFIX;
  return [
    ["bash", which("bash", env)],
    ["bash", join(prefix, "bin", "bash")],
    ["bash", "/bin/bash"],
    ["bash", "/usr/bin/bash"],
    ["bash", "/usr/local/bin/bash"],
    ["bash", "/opt/homebrew/bin/bash"],
    ["sh", which("sh", env)],
    ["sh", join(prefix, "bin", "sh")],
    ["sh", "/bin/sh"],
    ["sh", "/usr/bin/sh"],
    ["sh", "/system/bin/sh"],
  ];
}

function findPosixShell(env) {
  const override = process.env.SOLUNA_SHELL;
  if (override && existsSync(override)) {
    return { kind: /bash|zsh/i.test(override) ? "bash" : "sh", command: override, args: ["-c"] };
  }
  for (const [kind, path] of posixShellCandidates(env)) {
    if (path && existsSync(path) && isExecutable(path)) return { kind, command: path, args: ["-c"] };
  }
  return null;
}

/** A bash.exe that belongs to WSL or the Windows Store stub, not Git/MSYS. */
function isWslBash(path) {
  return /[\\/](?:system32|syswow64|sysnative|windowsapps)[\\/]/i.test(path);
}

/** Candidate Git Bash / MSYS bash locations on Windows. */
function windowsBashCandidates(env) {
  const out = [];
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"];
  for (const root of roots.filter(Boolean)) {
    out.push(join(root, "Git", "bin", "bash.exe"), join(root, "Git", "usr", "bin", "bash.exe"));
  }
  if (env.LOCALAPPDATA) {
    out.push(join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  // git.exe lives in <Git>\cmd or <Git>\mingw64\bin, so bash is next to it.
  const git = which("git", env);
  if (git) {
    const gitRoot = resolve(dirname(git), "..");
    out.push(join(gitRoot, "bin", "bash.exe"), join(gitRoot, "..", "bin", "bash.exe"));
  }
  const pathBash = which("bash", env);
  if (pathBash && !isWslBash(pathBash)) out.push(pathBash);
  return [...new Set(out)];
}

function probe(command, args, timeoutMs = 3000) {
  return new Promise((done) => {
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(ok);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    } catch {
      return done(false);
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, timeoutMs);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function findWindowsShell(env) {
  const override = process.env.SOLUNA_SHELL;
  if (override && existsSync(override)) {
    if (/powershell|pwsh/i.test(override)) return powershellShell(override);
    return { kind: "bash", command: override, args: ["-c"] };
  }

  for (const candidate of windowsBashCandidates(env)) {
    if (existsSync(candidate) && (await probe(candidate, ["-c", "exit 0"]))) {
      return { kind: "bash", command: candidate, args: ["-c"] };
    }
  }

  const ps = which("powershell.exe", env) || which("pwsh.exe", env);
  if (ps) return powershellShell(ps);

  const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
  const legacy = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(legacy)) return powershellShell(legacy);

  return null;
}

function powershellShell(command) {
  return {
    kind: "powershell",
    command,
    // ExecutionPolicy Bypass lets npm/npx .ps1 shims run on locked-down setups
    // ("running scripts is disabled on this system").
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"],
  };
}

let shellPromise;

/**
 * Resolve the shell used by the bash tool. Cached after the first call.
 * Returns `{ kind: "bash" | "sh" | "powershell", command, args }`.
 */
export function resolveShell() {
  shellPromise ??= (async () => {
    const env = buildChildEnv();
    const shell = isWindows() ? await findWindowsShell(env) : findPosixShell(env);
    if (shell) return shell;
    throw new Error(
      isWindows()
        ? "No usable shell found. Install Git for Windows (Git Bash) or make sure powershell.exe is available, " +
            "or set SOLUNA_SHELL to the full path of a shell."
        : isTermux()
          ? "No shell found. In Termux run: pkg install bash"
          : "No shell found (looked for bash and sh). Set SOLUNA_SHELL to the full path of a shell.",
    );
  })();
  // Do not cache failures forever: let the next call retry.
  shellPromise.catch(() => {
    shellPromise = undefined;
  });
  return shellPromise;
}

/** Forget the cached shell (used by tests). */
export function resetShellCache() {
  shellPromise = undefined;
}

/**
 * Kill a child and everything it started.
 * Windows has no process groups for this, so taskkill walks the tree.
 */
export function killProcessTree(child, signal = "SIGTERM") {
  if (!child || child.pid === undefined) return;
  if (isWindows()) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {}
      });
    } catch {
      try {
        child.kill();
      } catch {}
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Not a group leader (or already gone): fall back to the child itself.
  }
  try {
    child.kill(signal);
  } catch {}
}

/** Short description of the runtime for the system prompt / tool description. */
export function environmentNotes() {
  if (isTermux()) {
    return [
      "Platform: Termux on Android. Commands run in bash.",
      "Termux has no sudo/root, no /tmp, no /bin/sh and no systemd. Install software with `pkg install <name>` (not apt-get/sudo apt).",
      "Use $PREFIX (/data/data/com.termux/files/usr) for system paths and $TMPDIR for temporary files; shared storage is ~/storage after `termux-setup-storage`.",
      "Prefer `python` and `pip` (python3 also works). Native npm modules may need `pkg install build-essential python`.",
    ];
  }
  if (isWindows()) {
    return [
      "Platform: Windows. Commands run in Git Bash when it is installed, otherwise in PowerShell (common Bash commands are translated).",
      "Use forward slashes or quoted paths; avoid Bash-only heredocs when running in PowerShell. Use `python` (not `python3`).",
    ];
  }
  return [`Platform: ${platformLabel()}. Commands run in bash (or sh when bash is missing).`];
}
