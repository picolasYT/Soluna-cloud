import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, toPowerShellCommand } from "../src/core/tools/bash.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { createWriteTool } from "../src/core/tools/write.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { Workspace } from "../src/core/workspace.js";
import { classifyCommand, findOutsideTargets } from "../src/core/permissions.js";
import { environmentNotes, isTermux, resolveShell, resetShellCache } from "../src/core/shell.js";
import { resolveMcpLaunch } from "../src/core/mcp.js";
import { truncateTailContent, detectLineEnding } from "../src/core/utils/file-utils.js";

const posix = process.platform !== "win32";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "soluna-compat-"));
}

/* --- PowerShell translation -------------------------------------------- */

test("PowerShell: env assignments, /dev/null and python3", () => {
  assert.match(toPowerShellCommand("export FOO=bar BAZ='a b'"), /\$env:FOO = 'bar'; \$env:BAZ = 'a b'/);
  assert.match(toPowerShellCommand("NODE_ENV=production npm run build"), /\$env:NODE_ENV = 'production'; npm run build/);
  assert.match(toPowerShellCommand("npm test > /dev/null 2>&1"), /npm test \*> \$null/);
  assert.match(toPowerShellCommand("npm test 2>/dev/null"), /npm test 2> \$null/);
  assert.match(toPowerShellCommand("python3 app.py"), /python app\.py/);
  assert.doesNotMatch(toPowerShellCommand("python3 app.py"), /python3/);
});

test("PowerShell: file commands", () => {
  assert.match(toPowerShellCommand("mkdir -p a b"), /@\('a','b'\)/);
  assert.match(toPowerShellCommand("cp -r src dist"), /Copy-Item -Recurse -Force -Path 'src' -Destination 'dist'/);
  assert.match(toPowerShellCommand("touch a.txt"), /New-Item -ItemType File/);
  assert.match(toPowerShellCommand("chmod +x run.sh"), /\$null/);
  assert.match(toPowerShellCommand("tail -n 20 log.txt"), /Get-Content -Tail 20 -Path 'log\.txt'/);
  assert.match(toPowerShellCommand("head -5 log.txt"), /Get-Content -TotalCount 5 -Path 'log\.txt'/);
  assert.match(toPowerShellCommand("ls -lah src"), /Get-ChildItem -Force -Path src/);
  assert.match(toPowerShellCommand("ls -R"), /Get-ChildItem -Force -Recurse/);
});

test("PowerShell: pipeline filters", () => {
  const g = toPowerShellCommand("npm ls | grep -i react");
  assert.match(g, /Select-String -Pattern 'react'/);
  assert.doesNotMatch(g, /-CaseSensitive/);
  assert.match(toPowerShellCommand("npm ls | grep react"), /-CaseSensitive/);
  assert.match(toPowerShellCommand("git log | tail -3"), /Select-Object -Last 3/);
  assert.match(toPowerShellCommand("git ls-files | wc -l"), /Measure-Object -Line/);
});

test("PowerShell: exit code is propagated and && inside quotes is kept", () => {
  const script = toPowerShellCommand('echo "a && b" && echo c');
  assert.match(script, /echo "a && b"/);
  assert.match(script, /\$LASTEXITCODE/);
  // Single quotes never escape, so a trailing backslash does not swallow the operator.
  const chain = toPowerShellCommand("cd 'C:\\work\\' && dir");
  assert.match(chain, /if \(\$__soluna_ok\)/);
});

/* --- Permission classifier ---------------------------------------------- */

test("permissions: harmless redirects and reads are not flagged", () => {
  const root = "/home/user/proj";
  for (const cmd of ["npm test 2>/dev/null", "npm test > /dev/null 2>&1", "cat /etc/hosts", "ls $PREFIX/bin", "build 2>&1 | tee out.log", "dir > nul"]) {
    assert.equal(classifyCommand(cmd, root).safe, true, cmd);
  }
});

test("permissions: real writes outside the workspace are still flagged", () => {
  const root = "/home/user/proj";
  assert.deepEqual(findOutsideTargets("echo x > ~/.bashrc", root), ["~/.bashrc"]);
  assert.deepEqual(findOutsideTargets("cp a /etc/b", root), ["/etc/b"]);
  assert.deepEqual(findOutsideTargets("echo x | tee /etc/x", root), ["/etc/x"]);
  assert.equal(classifyCommand("echo x > C:\\Windows\\x.txt", root).safe, posix ? false : classifyCommand("echo x > C:\\Windows\\x.txt", root).safe);
  assert.equal(classifyCommand("pkg uninstall nodejs", root).safe, false);
  assert.equal(classifyCommand("termux-reset", root).safe, false);
  assert.equal(classifyCommand("Stop-Computer", root).safe, false);
});

/* --- Termux / platform notes -------------------------------------------- */

test("Termux is detected and described", () => {
  const saved = process.env.TERMUX_VERSION;
  process.env.TERMUX_VERSION = "0.118";
  try {
    assert.equal(isTermux(), true);
    assert.match(environmentNotes().join("\n"), /pkg install/);
    assert.match(environmentNotes().join("\n"), /no \/tmp|no sudo/i);
  } finally {
    if (saved === undefined) delete process.env.TERMUX_VERSION;
    else process.env.TERMUX_VERSION = saved;
  }
});

test("SOLUNA_SHELL overrides shell discovery", { skip: !posix }, async () => {
  const saved = process.env.SOLUNA_SHELL;
  process.env.SOLUNA_SHELL = "/bin/sh";
  resetShellCache();
  try {
    const shell = await resolveShell();
    assert.equal(shell.command, "/bin/sh");
    assert.deepEqual(shell.args, ["-c"]);
  } finally {
    if (saved === undefined) delete process.env.SOLUNA_SHELL;
    else process.env.SOLUNA_SHELL = saved;
    resetShellCache();
  }
});

test("MCP launch is untouched on POSIX", { skip: !posix }, () => {
  assert.deepEqual(resolveMcpLaunch("npx", ["-y", "pkg"]), { command: "npx", args: ["-y", "pkg"], shell: false });
});

/* --- Bash tool behaviour -------------------------------------------------- */

test("bash: a program that ignores SIGTERM is still killed on timeout", { skip: !posix }, async () => {
  const root = await sandbox();
  try {
    const bash = createBashTool(new Workspace(root));
    const started = Date.now();
    await assert.rejects(
      () => bash.execute({ command: "trap '' TERM; while true; do sleep 1; done", timeout: 1 }),
      /timed out after 1 seconds/,
    );
    assert.ok(Date.now() - started < 8000, "timeout must not hang");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash: a background job holding the pipes does not hang the tool", { skip: !posix }, async () => {
  const root = await sandbox();
  try {
    const bash = createBashTool(new Workspace(root));
    const started = Date.now();
    const result = await bash.execute({ command: "(sleep 5 &) ; echo started" });
    assert.match(result.content[0].text, /started/);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash: death by signal is reported as a failure", { skip: !posix }, async () => {
  const root = await sandbox();
  try {
    const bash = createBashTool(new Workspace(root));
    await assert.rejects(() => bash.execute({ command: "kill -KILL $$" }), /terminated by signal SIGKILL|exited with code/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash: /dev/null redirects run without an approval prompt", { skip: !posix }, async () => {
  const root = await sandbox();
  try {
    const bash = createBashTool(new Workspace(root), { confirm: null });
    const result = await bash.execute({ command: "ls /nonexistent-soluna-dir 2>/dev/null; echo done" });
    assert.match(result.content[0].text, /done/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash: keeps UTF-8 intact and truncates from the head, keeping the tail", { skip: !posix }, async () => {
  const root = await sandbox();
  try {
    const bash = createBashTool(new Workspace(root));
    const utf = await bash.execute({ command: "printf 'ñandú ✓ 日本語\\n'" });
    assert.match(utf.content[0].text, /ñandú ✓ 日本語/);
    const big = await bash.execute({ command: "i=1; while [ $i -le 4500 ]; do echo line$i; i=$((i+1)); done" });
    assert.match(big.content[0].text, /line4500/);
    assert.doesNotMatch(big.content[0].text, /\bline1\n/);
    assert.match(big.content[0].text, /Showing lines/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash: failing command carries a recovery hint", { skip: !posix }, async () => {
  const root = await sandbox();
  try {
    const bash = createBashTool(new Workspace(root));
    await assert.rejects(() => bash.execute({ command: "definitely_not_installed_cmd" }), /Suggested recovery/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncateTailContent keeps the last lines", () => {
  const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
  const t = truncateTailContent(text, 3);
  assert.equal(t.content, "l8\nl9\nl10");
  assert.equal(t.truncated, true);
});

/* --- CRLF files (Windows) ------------------------------------------------- */

test("edit matches LF text against a CRLF file and keeps CRLF", async () => {
  const root = await sandbox();
  try {
    const ws = new Workspace(root);
    await writeFile(join(root, "a.txt"), "one\r\ntwo\r\nthree\r\n");
    await createEditTool(ws).execute({ path: "a.txt", old_string: "one\ntwo", new_string: "uno\ndos" });
    assert.equal(await readFile(join(root, "a.txt"), "utf-8"), "uno\r\ndos\r\nthree\r\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit still reports a missing string", async () => {
  const root = await sandbox();
  try {
    await writeFile(join(root, "a.txt"), "hello\r\n");
    await assert.rejects(() => createEditTool(new Workspace(root)).execute({ path: "a.txt", old_string: "nope", new_string: "x" }), /not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write keeps the CRLF endings of the file it replaces; new files stay LF", async () => {
  const root = await sandbox();
  try {
    const ws = new Workspace(root);
    await writeFile(join(root, "w.txt"), "a\r\nb\r\n");
    await createWriteTool(ws).execute({ path: "w.txt", content: "x\ny\n" });
    assert.equal(await readFile(join(root, "w.txt"), "utf-8"), "x\r\ny\r\n");
    await createWriteTool(ws).execute({ path: "new.txt", content: "x\ny\n" });
    assert.equal(await readFile(join(root, "new.txt"), "utf-8"), "x\ny\n");
    assert.equal(detectLineEnding("a\nb\nc\r\n"), "\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grep anchors work on CRLF files", async () => {
  const root = await sandbox();
  try {
    await writeFile(join(root, "c.txt"), "alpha\r\nbeta\r\n");
    const out = await createGrepTool(new Workspace(root)).execute({ pattern: "alpha$" });
    assert.match(out.content[0].text, /c\.txt:1:alpha/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* --- Workspace through a symlinked root ------------------------------------ */

test("a workspace root reached through a symlink still accepts its own files", { skip: !posix }, async () => {
  const real = await sandbox();
  const holder = await sandbox();
  const link = join(holder, "link");
  try {
    await mkdir(join(real, "sub"));
    await writeFile(join(real, "sub", "f.txt"), "x");
    await symlink(real, link);
    const ws = new Workspace(link);
    assert.equal(await ws.resolvePath("sub/f.txt", { mustExist: true }), join(link, "sub", "f.txt"));
  } finally {
    await rm(real, { recursive: true, force: true });
    await rm(holder, { recursive: true, force: true });
  }
});
