import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../config/constants.js";
import { truncateTailContent } from "../utils/file-utils.js";
import { requiresConfirmation } from "../permissions.js";
import {
  buildChildEnv,
  environmentNotes,
  isTermux,
  isWindows,
  killProcessTree,
  resolveShell,
} from "../shell.js";

/** In-memory cap for captured output; the tail is what matters. */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
/** After SIGTERM, wait this long before SIGKILL. */
const KILL_GRACE_MS = 2000;
/** After the shell exits, wait this long for the output pipes to drain. */
const DRAIN_GRACE_MS = 400;
/** Windows limits a command line to 32767 chars; base64(UTF-16) is ~2.7x. */
const MAX_ENCODED_SCRIPT = 30000;

const POWERSHELL_PRELUDE =
  "$ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'; " +
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {} ";

/** Translate common Bash commands when Windows has no working Bash runtime. */
export function toPowerShellCommand(command) {
  const { commands, operators } = splitShellChain(command);
  const parts = commands.map((part) => translatePowerShellPart(part));

  // PowerShell 5.1 does not parse Bash's && / || operators. Preserve their
  // short-circuit behavior explicitly, recording each command's exit status.
  let script = `${POWERSHELL_PRELUDE}$__soluna_ok = $true; `;
  for (let i = 0; i < parts.length; i++) {
    const commandText = parts[i];
    if (i === 0) {
      script += `${commandText}; $__soluna_ok = $?; `;
      continue;
    }
    const condition = operators[i - 1] === "&&" ? "$__soluna_ok" : "-not $__soluna_ok";
    script += `if (${condition}) { ${commandText}; $__soluna_ok = $?; } `;
  }
  return `${script}if (-not $__soluna_ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`;
}

/** Pull `>/dev/null`-style redirections out so statement matching stays simple. */
function extractSilence(part) {
  let silence = null;
  const mark = (kind) => () => {
    silence = silence === "all" || (silence && silence !== kind) ? "all" : kind;
    return "";
  };
  let out = part;
  out = out.replace(/\s+(?:1?>|>>)\s*(?:\/dev\/null|nul)\s+2>&1(?=\s|$)/gi, mark("all"));
  out = out.replace(/\s+&>\s*(?:\/dev\/null|nul)(?=\s|$)/gi, mark("all"));
  out = out.replace(/\s+2>\s*(?:\/dev\/null|nul)(?=\s|$)/gi, mark("err"));
  out = out.replace(/\s+1?>\s*(?:\/dev\/null|nul)(?=\s|$)/gi, mark("out"));
  return { text: out, silence };
}

const SILENCE_SUFFIX = { err: " 2> $null", out: " > $null", all: " *> $null" };

function translatePowerShellPart(part) {
  const extracted = extractSilence(part.trim());
  const translated = translatePowerShellStatement(extracted.text.trim());
  return extracted.silence ? `${translated}${SILENCE_SUFFIX[extracted.silence]}` : translated;
}

function translatePowerShellStatement(input) {
  let trimmed = input;

  // In Windows PowerShell, `curl` is an alias for Invoke-WebRequest. Call
  // the actual curl executable so Bash-style flags such as -sI still work.
  trimmed = trimmed.replace(/(^|[\s|;&(])curl(?=\s)/gi, "$1curl.exe");
  // The Microsoft Store "python3" alias is a stub that opens the Store.
  trimmed = trimmed.replace(/(^|[\s|;&(])python3(?=\s|$)/gi, "$1python");
  trimmed = trimmed.replace(/(^|[\s|;&(])pip3(?=\s|$)/gi, "$1pip");

  // Pipeline filters. `head`/`tail`/`grep`/`wc` are not PowerShell commands.
  trimmed = trimmed.replace(
    /\bhead(?:\s+-n\s+(\d+)|\s+-n(\d+)|\s+-(\d+))?(?=\s*(?:\||$))/gi,
    (_match, countN, countNCompact, countShort) =>
      `Select-Object -First ${countN || countNCompact || countShort || 10}`,
  );
  trimmed = trimmed.replace(
    /\|\s*tail(?:\s+-n\s+(\d+)|\s+-n(\d+)|\s+-(\d+))?(?=\s*(?:\||$))/gi,
    (_match, countN, countNCompact, countShort) =>
      `| Select-Object -Last ${countN || countNCompact || countShort || 10}`,
  );
  trimmed = trimmed.replace(/\|\s*wc\s+-l(?=\s*(?:\||$))/gi, "| Measure-Object -Line | ForEach-Object { $_.Lines }");
  trimmed = trimmed.replace(
    /\|\s*grep\s+((?:-[a-zA-Z]+\s+)*)('[^']*'|"[^"]*"|[^\s|]+)(?=\s*(?:\||$))/g,
    (_match, flags, pattern) => {
      const f = flags || "";
      const literal = /-[a-zA-Z]*F/.test(f);
      const insensitive = /-[a-zA-Z]*i/.test(f);
      const invert = /-[a-zA-Z]*v/.test(f);
      const raw = pattern.replace(/^(['"])(.*)\1$/, "$2");
      return (
        `| Select-String -Pattern ${quotePowerShell(raw)}` +
        `${literal ? " -SimpleMatch" : ""}${insensitive ? "" : " -CaseSensitive"}${invert ? " -NotMatch" : ""}` +
        " | ForEach-Object { $_.Line }"
      );
    },
  );

  trimmed = trimmed.replace(/\bInvoke-Request\b/gi, "Invoke-WebRequest");
  // npm creates Windows command shims as *.cmd files. A Bash-style direct
  // path (or `node path.js`) does not resolve those shims in PowerShell.
  trimmed = trimmed.replace(
    /\bnode\s+(['"]?)([^'"\s]*node_modules[\\/]\.bin[\\/][\w.-]+)(?:\.js)?\1/gi,
    (_match, _quote, path) => `& '${path.replace(/\.(?:js|cmd|ps1|bat)$/i, "")}.cmd'`,
  );
  trimmed = trimmed.replace(
    /&\s*(['"]?)([^'"\s]*node_modules[\\/]\.bin[\\/][\w.-]+)(?:\.js)?\1/gi,
    (_match, _quote, path) => `& '${path.replace(/\.(?:js|cmd|ps1|bat)$/i, "")}.cmd'`,
  );

  // `export A=b`, `unset A` and inline `A=b command` environment assignments.
  const exportMatch = trimmed.match(/^export\s+(.+)$/i);
  if (exportMatch) {
    const assigns = [...exportMatch[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)];
    if (assigns.length) return assigns.map((a) => envAssignment(a[1], a[2])).join("; ");
  }
  const unsetMatch = trimmed.match(/^unset\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (unsetMatch) return `Remove-Item -Path 'Env:${unsetMatch[1]}' -ErrorAction SilentlyContinue`;
  const inlineEnv = trimmed.match(/^((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+)(.+)$/);
  if (inlineEnv) {
    const assigns = [...inlineEnv[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)];
    return `${assigns.map((a) => envAssignment(a[1], a[2])).join("; ")}; ${translatePowerShellStatement(inlineEnv[2])}`;
  }
  const onlyEnv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)$/);
  if (onlyEnv) return envAssignment(onlyEnv[1], onlyEnv[2]);

  const mkdirMatch = trimmed.match(/^mkdir\s+-p\s+(.+)$/i);
  if (mkdirMatch) {
    const targets = splitShellWords(mkdirMatch[1]);
    if (targets.length === 1 && !/['"]/.test(mkdirMatch[1])) {
      return `New-Item -ItemType Directory -Force -Path ${mkdirMatch[1]} | Out-Null`;
    }
    return `New-Item -ItemType Directory -Force -Path @(${targets.map(quotePowerShell).join(",")}) | Out-Null`;
  }

  const rmMatch = trimmed.match(/^rm\s+(-rf|-fr|-r|-f)\s+(.+)$/i);
  if (rmMatch) {
    const flags = rmMatch[1].toLowerCase();
    const targets = splitShellWords(rmMatch[2]);
    return targets.map((target) => {
      const path = quotePowerShell(target);
      const remove = `Remove-Item${flags.includes("r") ? " -Recurse" : ""}${flags.includes("f") ? " -Force" : ""} -Path ${path}`;
      return flags.includes("f") ? `if (Test-Path -Path ${path}) { ${remove} }` : remove;
    }).join("; ");
  }
  const delMatch = trimmed.match(/^(?:del|erase)\s+(.+)$/i);
  if (delMatch) {
    const targets = splitShellWords(delMatch[1]).filter((arg) => !/^\/(?:q|f)$/i.test(arg));
    return targets.map((target) => {
      const path = quotePowerShell(target);
      return `if (Test-Path -Path ${path}) { Remove-Item -Force -Path ${path} }`;
    }).join("; ");
  }
  const rmdirMatch = trimmed.match(/^(?:rd|rmdir)\s+(.+)$/i);
  if (rmdirMatch) {
    const args = splitShellWords(rmdirMatch[1]);
    const recursive = args.some((arg) => /^\/(?:s|q)$/i.test(arg));
    const targets = args.filter((arg) => !/^\/(?:s|q)$/i.test(arg));
    return targets.map((target) => {
      const path = quotePowerShell(target);
      const remove = `Remove-Item${recursive ? " -Recurse" : ""}${recursive ? " -Force" : ""} -Path ${path}`;
      return `if (Test-Path -Path ${path}) { ${remove} }`;
    }).join("; ");
  }

  // cp -r / mv -f / touch / chmod
  const cpMatch = trimmed.match(/^cp\s+-([a-zA-Z]+)\s+(.+)$/);
  if (cpMatch && /r/i.test(cpMatch[1])) {
    const args = splitShellWords(cpMatch[2]);
    if (args.length === 2) {
      return `Copy-Item -Recurse -Force -Path ${quotePowerShell(args[0])} -Destination ${quotePowerShell(args[1])}`;
    }
  }
  const mvMatch = trimmed.match(/^mv\s+-[fi]+\s+(.+)$/);
  if (mvMatch) {
    const args = splitShellWords(mvMatch[1]);
    if (args.length === 2) {
      return `Move-Item -Force -Path ${quotePowerShell(args[0])} -Destination ${quotePowerShell(args[1])}`;
    }
  }
  const touchMatch = trimmed.match(/^touch\s+(.+)$/);
  if (touchMatch) {
    const targets = splitShellWords(touchMatch[1]).filter((arg) => !arg.startsWith("-"));
    if (targets.length) {
      return (
        `foreach ($__f in @(${targets.map(quotePowerShell).join(",")})) { ` +
        "if (Test-Path -LiteralPath $__f) { (Get-Item -LiteralPath $__f).LastWriteTime = Get-Date } " +
        "else { New-Item -ItemType File -Path $__f | Out-Null } }"
      );
    }
  }
  if (/^chmod\s/.test(trimmed)) return "$null"; // permission bits do not exist on Windows

  // head/tail on a file (the pipeline forms were translated above).
  const headFile = trimmed.match(/^head(?:\s+-n\s*(\d+)|\s+-(\d+))?\s+([^\s|<>]+)$/);
  if (headFile) {
    return `Get-Content -TotalCount ${headFile[1] || headFile[2] || 10} -Path ${quotePowerShell(headFile[3].replace(/^(['"])(.*)\1$/, "$2"))}`;
  }
  const tailFile = trimmed.match(/^tail(?:\s+-n\s*(\d+)|\s+-(\d+))?\s+([^\s|<>]+)$/);
  if (tailFile) {
    return `Get-Content -Tail ${tailFile[1] || tailFile[2] || 10} -Path ${quotePowerShell(tailFile[3].replace(/^(['"])(.*)\1$/, "$2"))}`;
  }

  const lsFlags = trimmed.match(/^ls\s+-([a-zA-Z1]+)(?:\s+(.+))?$/);
  if (lsFlags) {
    const flags = lsFlags[1];
    const recurse = /R/.test(flags) ? " -Recurse" : "";
    const names = flags === "1" ? " -Name" : "";
    return `Get-ChildItem -Force${recurse}${names}${lsFlags[2] ? ` -Path ${lsFlags[2]}` : ""}`;
  }
  const dirBrief = trimmed.match(/^dir\s+\/b(?:\s+(.+))?$/i);
  if (dirBrief) {
    const paths = dirBrief[1] ? splitShellWords(dirBrief[1]) : ["."];
    return `Get-ChildItem -Name -Path @(${paths.map(quotePowerShell).join(",")})`;
  }
  if (/^pwd$/i.test(trimmed)) return "(Get-Location).Path";
  if (/^cd\s+~$/i.test(trimmed)) return "Set-Location $HOME";
  const cdMatch = trimmed.match(/^cd\s+(.+)$/i);
  if (cdMatch) {
    const target = cdMatch[1].trim();
    const gitBashPath = target.match(/^(['"]?)\/([a-z])(?:\/([^'"].*))?\1$/i);
    if (gitBashPath) {
      const [, , drive, rest = ""] = gitBashPath;
      const windowsPath = `${drive.toUpperCase()}:\\${rest.replaceAll("/", "\\")}`;
      return `Set-Location '${windowsPath.replaceAll("'", "''")}'`;
    }
    return `Set-Location ${target}`;
  }
  const whichMatch = trimmed.match(/^(?:which|command\s+-v)\s+(.+)$/i);
  if (whichMatch) {
    const target = whichMatch[1].trim();
    return `Get-Command ${target} | Select-Object -ExpandProperty Source`;
  }
  return trimmed;
}

function envAssignment(name, rawValue) {
  const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  return `$env:${name} = ${quotePowerShell(value)}`;
}

/** Split shell logical chains without treating operators inside quotes as syntax. */
function splitShellChain(input) {
  const commands = [];
  const operators = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      // Inside single quotes nothing is escaped; inside double quotes a
      // backslash escapes a following quote or backslash.
      if (char === "\\" && quote === '"' && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const op = input.slice(i, i + 2);
    if (op === "&&" || op === "||") {
      commands.push(input.slice(start, i));
      operators.push(op);
      i++;
      start = i + 1;
    }
  }
  commands.push(input.slice(start));
  return { commands, operators };
}

function splitShellWords(input) {
  const words = [];
  let word = "";
  let quote = null;
  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (word) words.push(word), (word = "");
    } else word += char;
  }
  if (word) words.push(word);
  return words;
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}


/** Remove PowerShell CLIXML noise that leaks into redirected output. */
function stripClixml(text) {
  if (!text.includes("#< CLIXML") && !text.includes("<Objs ")) return text;
  return text
    .replace(/#< CLIXML\r?\n?/g, "")
    .replace(/<Objs[^>]*>[\s\S]*?<\/Objs>/g, "")
    .replace(/^\s+$/gm, (m) => (m.includes("\n") ? "" : m));
}

function executionHint(command, output) {
  if (/operation cancelled/i.test(output) && /create-vite|npm create vite/i.test(command)) {
    return "The scaffolding target is not empty. Inspect and preserve existing files; choose a new empty directory or integrate without overwriting.";
  }
  if (/unknown option\s+--template/i.test(output)) {
    return "--template was passed to the Vite CLI instead of create-vite. Use: npm create vite@latest <new-empty-folder> -- --template react-ts";
  }
  if (/A parameter cannot be found that matches parameter name ['\"]?la/i.test(output)) {
    return "This is PowerShell syntax: use Get-ChildItem -Force (or ls -Force), not the Bash-only ls -la flags.";
  }
  if (/positional parameter cannot be found|A positional parameter cannot be found/i.test(output) && /Test-Path/i.test(output)) {
    return "Test-Path accepts one path at a time. Check each path separately or pipe paths to ForEach-Object -Process { Test-Path -LiteralPath $_ }.";
  }
  if (/not recognized as the name of a cmdlet|CommandNotFoundException/i.test(output) && /node_modules[\\/]\.bin/i.test(command)) {
    return "PowerShell does not execute Bash-style node_modules/.bin paths directly. Invoke the matching .cmd shim, for example: & '.\\node_modules\\.bin\\tailwindcss.cmd'.";
  }
  if (/head.*not recognized|CommandNotFoundException/i.test(output) && /\bhead\b/i.test(command)) {
    return "PowerShell has no head command. In a pipeline use Select-Object -First 5 (or the required count); Soluna translates common `head -N` forms.";
  }
  if (/Invoke-Request.*not recognized|CommandNotFoundException/i.test(output) && /Invoke-Request/i.test(command)) {
    return "Invoke-Request is not a PowerShell cmdlet. Use Invoke-WebRequest for HTTP responses, Invoke-RestMethod for parsed API data, or curl.exe with its command-line flags.";
  }
  if (/curl\.exe.*not recognized|CommandNotFoundException/i.test(output) && /\bcurl\b/i.test(command)) {
    return "curl.exe is unavailable in this PowerShell environment. Use Invoke-WebRequest -Uri <url> -Method Head (or Get for a body) and inspect its StatusCode/Headers.";
  }
  if (/cannot be loaded because running scripts is disabled/i.test(output)) {
    return "PowerShell blocked a .ps1 script. Call the .cmd shim instead (npm.cmd, npx.cmd) or run inside Git Bash.";
  }
  if (/Python was not found|python3?(\.exe)? is not recognized/i.test(output) && isWindows()) {
    return "Python is not installed or not on PATH. Try `python --version` or `py -3 --version`, or install it from python.org (tick 'Add to PATH').";
  }
  if (isTermux()) {
    if (/sudo: (?:command )?not found|sudo: No such file/i.test(output) || /\bsudo\b/.test(command)) {
      return "Termux has no sudo/root. Run the command without sudo; install packages with `pkg install <name>`.";
    }
    if (/\/tmp\b/.test(output) && /(No such file|Permission denied|ENOENT|EACCES)/i.test(output)) {
      return "Termux has no /tmp. Use $TMPDIR (or $PREFIX/tmp), or a folder inside the project.";
    }
    if (/(apt|apt-get|dpkg)\b.*(Permission denied|lock|is not recognized|not found)/i.test(output) || /\bapt(-get)?\s+install\b/.test(command)) {
      return "In Termux install packages with `pkg install <name>` (and `pkg update` first if the package is not found).";
    }
    if (/\/bin\/(?:bash|sh)|bad interpreter|No such file or directory/i.test(output) && /#!\/(?:usr\/)?bin\//.test(output + command)) {
      return "Termux has no /bin or /usr/bin. Use `#!/usr/bin/env bash` (or `$PREFIX/bin/bash`) in shebangs, or run the script as `bash script.sh`.";
    }
    if (/EACCES|Permission denied/i.test(output) && /(storage|\/sdcard|\/storage\/)/i.test(output + command)) {
      return "Shared storage needs `termux-setup-storage` and cannot hold executables or symlinks. Keep projects under $HOME.";
    }
    if (/gyp ERR|node-gyp|make: not found|g\+\+: not found|cc: not found/i.test(output)) {
      return "Native build tools are missing. In Termux run: pkg install build-essential python make";
    }
  }
  if (/: command not found|not found$/im.test(output) && !isWindows()) {
    const name = output.match(/(?:bash|sh): (?:line \d+: )?([\w.+-]+): (?:command )?not found/)?.[1];
    if (name) {
      return isTermux()
        ? `\`${name}\` is not installed. Try: pkg install ${name} (or search with: pkg search ${name}).`
        : `\`${name}\` is not installed or not on PATH. Install it or use an alternative.`;
    }
  }
  return "Read the complete error above, correct the command for the active shell/environment, then rerun a narrow verification.";
}

/**
 * System prompt contribution for the bash tool
 */
export const bashToolSystemPrompt = {
  snippet: "Execute shell commands (ls, grep, find, etc.)",
  guidelines: [
    "You can inspect SOLUNA_* environment variables for current model and session details.",
    "When a command exits non-zero, read its error output, fix the underlying issue when it is within the workspace, then rerun the failing command (or the narrowest relevant check) and verify it succeeds. Do not report a failed command as completed.",
    "On Windows PowerShell fallback, npm package executables in node_modules/.bin should be invoked through their .cmd shims; Bash-style && and || chains are supported.",
    ...environmentNotes(),
  ],
};

function hasHeredoc(command) {
  return /<<-?\s*['"]?[A-Za-z_][\w-]*['"]?/.test(command);
}

/** Build the argument list for the resolved shell. */
function buildShellArgs(shell, command) {
  if (shell.kind !== "powershell") return [...shell.args, command];

  if (hasHeredoc(command)) {
    throw new Error(
      "Heredocs (<<EOF) are not supported in PowerShell. Use the write tool to create the file, " +
        "or install Git for Windows so commands run in Git Bash.",
    );
  }
  const script = toPowerShellCommand(command);
  // -EncodedCommand sidesteps every quoting and non-ASCII problem of passing a
  // script through the Windows command line.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  if (encoded.length <= MAX_ENCODED_SCRIPT) {
    return [...shell.args, "-OutputFormat", "Text", "-EncodedCommand", encoded];
  }
  return [...shell.args, "-Command", script];
}

/**
 * Execute a shell command
 */
async function execCommand(command, cwd, options = {}) {
  const { onData, signal, timeout, env = process.env } = options;
  const shell = await resolveShell();
  const args = buildShellArgs(shell, command);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(shell.command, args, {
        cwd,
        env: buildChildEnv(env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWindows(),
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`Could not start ${shell.command}: ${err.message}`));
      return;
    }

    // Decoders keep multi-byte characters intact across chunk boundaries.
    const decoder = new StringDecoder("utf8");
    let output = "";
    let capped = false;
    let killed = false;
    let settled = false;
    let timeoutHandle;
    let killTimer;
    let drainTimer;

    const append = (data) => {
      output += decoder.write(data);
      if (output.length > MAX_CAPTURE_BYTES) {
        output = output.slice(output.length - MAX_CAPTURE_BYTES / 2);
        capped = true;
      }
      onData?.(data);
    };

    const stop = () => {
      killProcessTree(child, "SIGTERM");
      if (!isWindows()) {
        // Escalate: some programs ignore SIGTERM and would hang us forever.
        killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", append);
      child.stderr?.removeListener("data", append);
      child.stdout?.destroy();
      child.stderr?.destroy();
      fn();
    };

    const onAbort = () => {
      killed = true;
      stop();
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeout) {
      timeoutHandle = setTimeout(() => {
        killed = true;
        stop();
        // If the process refuses to die, do not hang the agent.
        drainTimer = setTimeout(() => finish(() => reject(new Error(`timeout:${timeout}`))), KILL_GRACE_MS + 1000);
      }, timeout * 1000);
    }

    const complete = (code, termSignal) => {
      finish(() => {
        output += decoder.end();
        if (killed && !signal?.aborted) {
          reject(new Error(`timeout:${timeout}`));
          return;
        }
        let text = stripClixml(output).replace(/\r\n/g, "\n");
        if (capped) text = `[earlier output dropped]\n${text}`;
        if (code === null && termSignal) {
          // Killed from outside (OOM killer, Android's phantom-process killer on
          // Termux, kill -9). That is a failure, not a clean exit.
          const hint = termSignal === "SIGKILL" && isTermux()
            ? " (Android may have killed it for using too much memory; run `termux-wake-lock` or reduce parallelism)"
            : "";
          text = `${text}${text && !text.endsWith("\n") ? "\n" : ""}Process terminated by signal ${termSignal}${hint}`;
          resolve({ exitCode: 128, output: text });
          return;
        }
        resolve({ exitCode: code, output: text });
      });
    };

    child.on("close", complete);
    // A background job (`server &`) can keep the pipes open after the shell
    // exits. Wait briefly for the output to drain, then stop waiting.
    child.on("exit", (code, termSignal) => {
      drainTimer = setTimeout(() => complete(code, termSignal), DRAIN_GRACE_MS);
    });

    child.on("error", (err) => {
      finish(() => reject(err));
    });
  });
}

/**
 * Create the shell tool definition.
 *
 * `workspace` provides the working directory and sandbox root.
 * `confirm` is an async `(details) => boolean` gate for risky commands. When
 * the model does not self-classify and no `confirm` callback is wired up
 * (headless/print mode), risky commands are refused outright.
 */
export function createBashTool(workspace, { confirm = null, allowSelfClassified = true } = {}) {
  return {
    name: "bash",
    description:
      `Execute a shell command in the current working directory. ${environmentNotes().join(" ")} ` +
      `Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional)" },
        permission: {
          type: "string",
          enum: ["safe", "ask", "deny"],
          description:
            "Your self-classification: 'safe' (read-only or clearly harmless), 'ask' (destructive/risky — user must approve), or 'deny' (refuse without asking). Default: 'safe'.",
        },
      },
      required: ["command"],
    },
    async execute({ command, timeout, permission }, signal) {
      if (typeof command !== "string" || command.trim() === "") {
        throw new Error("bash requires a 'command' argument (string)");
      }
      if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)) {
        throw new Error(`bash: 'timeout' must be a non-negative number, got ${JSON.stringify(timeout)}`);
      }
      if (permission !== undefined && !["safe", "ask", "deny"].includes(permission)) {
        throw new Error(`bash: 'permission' must be one of safe, ask, deny`);
      }

      const cwd = workspace.root;

      // Verify the working directory exists
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      // Permission gate.
      if (permission === "deny") {
        throw new Error(`Command denied by the model: ${command.slice(0, 120)}`);
      }

      const modelSafe = permission !== "ask" && permission !== "deny";
      const reason = requiresConfirmation({
        modelSafe,
        modelReason: null,
        command,
        workspaceRoot: cwd,
      });

      if (reason) {
        if (!confirm) {
          throw new Error(
            `Refusing to run a command flagged as risky without approval: ${reason}\n` +
              `Command: ${command.slice(0, 300)}`,
          );
        }
        const allowed = await confirm({ command, reason });
        if (!allowed) {
          throw new Error(`Command rejected by the user: ${reason}`);
        }
      }

      const env = { ...process.env };
      delete env.SOLUNA_SESSION_ID;
      delete env.SOLUNA_SESSION_FILE;
      delete env.SOLUNA_PROVIDER;
      delete env.SOLUNA_MODEL;
      delete env.ZYN_SESSION_ID;
      delete env.ZYN_SESSION_FILE;
      delete env.ZYN_PROVIDER;
      delete env.ZYN_MODEL;

      try {
        const result = await execCommand(command, cwd, {
          signal,
          timeout,
          env,
        });

        if (signal?.aborted) {
          throw new Error("aborted");
        }

        let output = result.output || "(no output)";

        // Keep the END of long output: that is where errors and summaries are.
        const truncation = truncateTailContent(output);
        if (truncation.truncated) {
          output = truncation.content;
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          output = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}]\n${output}`;
        }

        if (result.exitCode !== 0 && result.exitCode !== null) {
          throw new Error(`${output}\n\nCommand exited with code ${result.exitCode}\nSuggested recovery: ${executionHint(command, output)}`);
        }

        return {
          content: [{ type: "text", text: output }],
          details: { truncation },
        };
      } catch (err) {
        if (err.message === "aborted") {
          throw new Error("Command aborted");
        }
        if (err.message?.startsWith("timeout:")) {
          const timeoutSecs = err.message.split(":")[1];
          throw new Error(`Command timed out after ${timeoutSecs} seconds`);
        }
        if (err.code === "ENOENT") {
          throw new Error(`Shell not found (${err.path || "bash"}). ${environmentNotes().join(" ")} Set SOLUNA_SHELL to a valid shell path.`);
        }
        throw err;
      }
    },
  };
}
