import { homedir } from "node:os";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { isInside } from "./workspace.js";

/**
 * Command permission checks.
 *
 * The bash tool is the one way an agent can do irreversible damage (delete
 * files, push to a remote, wipe a disk). The model is asked to self-classify
 * commands as safe or not, but that is a request, not a guarantee — so we
 * also run the command text through a static risk classifier. Anything it
 * flags must be confirmed by the user before it runs.
 *
 * The classifier is deliberately conservative: false positives only cost a
 * confirmation click, false negatives can cost a file system.
 */

const DANGEROUS_PATTERNS = [
  // Destructive deletion
  [/\brm\s+-r[f]?\b/, "recursive delete (rm -r)"],
  [/\brm\s+-\S*f\b/, "force delete (rm -f)"],
  [/\b(?:del|erase)\b/i, "delete files (del/erase)"],
  [/\b(?:rd|rmdir)\b/i, "delete a directory (rd/rmdir)"],
  [/\bRemove-Item\b/i, "delete files (Remove-Item)"],
  [/\brm\s+(-|\w)*\S*\s+["']?\//, "delete from filesystem root"],
  // Repo history rewrites and destructive git
  [/\bgit\s+reset\s+--hard/, "git reset --hard"],
  [/\bgit\s+clean\s+-(f|d|x|n)*/, "git clean"],
  [/\bgit\s+rm\s+(-r\s+)?--cached/, "git rm --cached"],
  [/\bgit\s+filter-branch/, "git filter-branch"],
  [/\bgit\s+push\s+(-f|--force)/, "force push"],
  [/\bgit\s+remote\s+rm\b/, "remove git remote"],
  // Disk / system destruction
  [/\bmkfs(\.\w+)?\b/, "format a filesystem (mkfs)"],
  [/\bdd\s+if=.*of=/, "raw block copy (dd)"],
  [/\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, "shut down or reboot the machine"],
  [/\bkill\s+-9\b|\bpkill\s+-9\b/, "kill -9"],
  // Root escalation
  [/\bsudo\b|\bsu\s+/, "run as root"],
  // Remote pipe-to-shell (curl/wget | bash|sh|zsh)
  [/\b(curl|wget)\b[^|&;]*\|[^|&;]*\b(bash|sh|zsh)\b/, "pipe a remote script straight into a shell"],
  [/\b(curl|wget)\b[^|&;]*\b-o\s+\/etc\//, "write a downloaded file into /etc"],
  // Uploading secrets / data exfiltration
  [/\b(gh|gitlab|glab|hub)\s+\w*\s*(create|delete)\b/, "create or delete a remote resource"],
  [/\bcurl\b[^|&;]*\s(-X\s*(PUT|POST|PATCH)\b)/, "write to a remote endpoint"],
  // Broad permission changes
  [/\bchmod\s+-\w*R/, "recursive chmod"],
  [/\bchown\s+-\w*R/, "recursive chown"],
  [/\bchmod\s+777\b/, "chmod 777"],
  [/\bchown\b[^|&;]*\b\S+[:.]\S+/, "change file ownership"],
  // Windows / PowerShell equivalents
  [/\b(?:Stop|Restart)-Computer\b/i, "shut down or reboot the machine"],
  [/\bformat(?:\.com)?\s+[a-z]:/i, "format a drive"],
  [/\bdel\s+(?:\/[a-z]\s+)*\/[sf]\b/i, "recursive/forced delete (del /s /f)"],
  [/\btaskkill\b[^|&;]*\/f\b/i, "force-kill a process (taskkill /f)"],
  [/\breg(?:\.exe)?\s+(?:delete|add)\b/i, "modify the Windows registry"],
  [/\b(?:iex|Invoke-Expression)\b/i, "evaluate a string as code (Invoke-Expression)"],
  [/\bSet-ExecutionPolicy\b/i, "change the PowerShell execution policy"],
  // Termux: wipes or breaks the whole environment
  [/\btermux-reset\b/, "reset Termux (deletes everything)"],
  [/\bpkg\s+(?:uninstall|remove|autoclean)\b|\bapt(?:-get)?\s+(?:remove|purge|autoremove)\b/, "remove packages"],
];

/** Pseudo-files every shell can write to; they never touch the disk. */
const HARMLESS_TARGETS = /^(?:\/dev\/(?:null|stdout|stderr|tty|zero)|nul|\$null|&\d)$/i;

function userHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/** True for absolute POSIX (`/x`) and Windows (`C:\x`, `\\server\x`) paths, and `~/x`. */
function looksAbsolute(target) {
  return target.startsWith("/") || target.startsWith("~") || win32.isAbsolute(target) || isAbsolute(target);
}

/**
 * Extract shell redirection / argument targets that point outside a
 * workspace. e.g. `echo x > /etc/hosts` or `tee ~/.bashrc`.
 */
export function findOutsideTargets(command, workspaceRoot) {
  const candidates = [];

  // Redirects: > file, >> file, 2> file, &> file (but not 2>&1 or <).
  const redirectRe = /(?:^|[^<>\d&])(?:\d*|&)>{1,2}\s*["']?([^"'\s;&|<>]+)["']?/g;
  let m;
  while ((m = redirectRe.exec(command)) !== null) candidates.push(m[1]);

  // Commands whose last argument (or every argument, for tee) is written to.
  for (const segment of command.split(/[;&|]+/)) {
    const words = (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(['"])(.*)\1$/, "$2"));
    const head = (words[0] || "").toLowerCase();
    const args = words.slice(1).filter((w) => !w.startsWith("-"));
    if (head === "tee") candidates.push(...args);
    else if (["cp", "mv", "ln", "install", "rsync", "scp", "copy", "move", "copy-item", "move-item"].includes(head) && args.length >= 2) {
      candidates.push(args[args.length - 1]);
    }
  }

  const targets = [];
  for (const raw of candidates) {
    if (HARMLESS_TARGETS.test(raw)) continue;
    const target = raw.replace(/^~(?=$|[\\/])/, userHomeDir());
    if (!looksAbsolute(raw) && !looksAbsolute(target)) continue;
    // A Windows drive path can never be inside a POSIX workspace.
    if (win32.isAbsolute(target) && !isAbsolute(target)) {
      targets.push(raw);
      continue;
    }
    const abs = resolve(workspaceRoot, target);
    if (!isInside(workspaceRoot, abs)) targets.push(raw);
  }
  return [...new Set(targets)];
}

/**
 * Classify a command. Returns `{ safe: true }` or
 * `{ safe: false, reasons: string[] }`.
 */
export function classifyCommand(command, workspaceRoot) {
  const reasons = [];

  for (const [re, label] of DANGEROUS_PATTERNS) {
    if (re.test(command)) reasons.push(label);
  }

  const outside = findOutsideTargets(command, workspaceRoot);
  for (const target of outside) {
    reasons.push(`writes outside the workspace (${target})`);
  }

  return reasons.length > 0 ? { safe: false, reasons } : { safe: true };
}

/**
 * Merge the model's own classification with ours: if the model said "safe"
 * but the classifier flags it, the command still needs confirmation.
 */
export function requiresConfirmation({ modelSafe, modelReason, command, workspaceRoot }) {
  if (modelSafe === false) {
    return modelReason || "the model marked the command as needing approval";
  }
  const { safe, reasons } = classifyCommand(command, workspaceRoot);
  if (!safe) return reasons.join("; ");
  return null;
}

/** Decide whether --auto-accept may approve a statically flagged command. */
export function canAutoAcceptCommand({ command, reason, workspaceRoot, unsafe = false }) {
  if (unsafe) return true;
  if (/outside the workspace/i.test(reason)) return false;

  // Auto-accept is deliberately limited to local file/repository maintenance;
  // network, system, permission, and remote-repository actions still need a person.
  if (!/^(?:recursive delete|force delete|git reset --hard|git clean|recursive chmod|recursive chown|chmod 777)/i.test(reason)) {
    return false;
  }

  const words = command.match(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)/g) || [];
  const unquote = (value) => value.replace(/^['"]|['"]$/g, "");
  const isWithin = (target) => {
    if (!target || target.startsWith("-")) return true;
    const resolved = resolve(workspaceRoot, target);
    return isInside(resolve(workspaceRoot), resolved);
  };

  const head = (words[0] || "").toLowerCase();
  if (["rm", "del", "erase", "rd", "rmdir", "remove-item"].includes(head)) {
    for (const raw of words.slice(1)) {
      const target = unquote(raw);
      if (/^(?:-[a-z]+|\/(?:[a-z]+))$/i.test(target)) continue;
      if (!isWithin(target)) return false;
    }
  }
  for (let i = 0; i < words.length; i++) {
    if (["-c", "--directory"].includes(words[i].toLowerCase()) && words[i + 1] && !isWithin(unquote(words[i + 1]))) {
      return false;
    }
  }
  return true;
}
