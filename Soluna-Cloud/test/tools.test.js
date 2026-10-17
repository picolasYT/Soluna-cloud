import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/core/workspace.js";
import { createReadTool } from "../src/core/tools/read.js";
import { createWriteTool } from "../src/core/tools/write.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { createBashTool, toPowerShellCommand } from "../src/core/tools/bash.js";
import { createGlobTool, globToRegExp } from "../src/core/tools/glob.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { createLsTool } from "../src/core/tools/ls.js";

async function makeSandbox() {
  const root = join(tmpdir(), `tools-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "a.txt"), "hello world\nsecond line\n");
  await writeFile(join(root, "sub/app.js"), "const x = 1;\nconsole.log(x);\n");
  return root;
}

test("write creates files and reports a diff", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const res = await createWriteTool(ws).execute({ path: "new.txt", content: "a\nb\n" });
    assert.match(res.content[0].text, /Successfully wrote 4 bytes/);
    assert.equal(res.details.diff.isNew, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write refuses paths outside the workspace", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    await assert.rejects(
      () => createWriteTool(ws).execute({ path: "../../../outside.txt", content: "x" }),
      /outside the workspace/,
    );
    await assert.rejects(() => createWriteTool(ws).execute({ path: "/tmp/abs.txt", content: "x" }), /outside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read returns content and honors offset", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const r = await createReadTool(ws).execute({ path: "a.txt" });
    assert.match(r.content[0].text, /hello world/);
    const off = await createReadTool(ws).execute({ path: "a.txt", offset: 2 });
    assert.equal(off.content[0].text.trim(), "second line");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read validates arguments", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const tool = createReadTool(ws);
    await assert.rejects(() => tool.execute({}), /'path'/);
    await assert.rejects(() => tool.execute({ path: "a.txt", offset: "x" }), /'offset'/);
    await assert.rejects(() => tool.execute({ path: "a.txt", limit: 0 }), /'limit'/);
    await assert.rejects(() => tool.execute({ path: "missing.txt" }), /not found/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read refuses binary files", async () => {
  const root = await makeSandbox();
  try {
    await writeFile(join(root, "bin.dat"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
    const ws = new Workspace(root);
    await assert.rejects(() => createReadTool(ws).execute({ path: "bin.dat" }), /binary file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit replaces text and validates", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const e = await createEditTool(ws).execute({
      path: "sub/app.js",
      old_string: "const x = 1;",
      new_string: "const y = 2;",
    });
    assert.match(e.content[0].text, /1 replacement/);
    await assert.rejects(
      () => createEditTool(ws).execute({ path: "sub/app.js", old_string: "", new_string: "z" }),
      /old_string/,
    );
    await assert.rejects(
      () => createEditTool(ws).execute({ path: "sub/app.js", old_string: "nope", new_string: "z" }),
      /old_string not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("glob finds files and respects the workspace", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const g = await createGlobTool(ws).execute({ pattern: "**/*.js" });
    assert.match(g.content[0].text, /sub\/app\.js/);
    assert.doesNotMatch(g.content[0].text, /a\.txt/);
    const none = await createGlobTool(ws).execute({ pattern: "**/*.rs" });
    assert.match(none.content[0].text, /No files match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("globToRegExp handles recursive patterns and brace alternatives", () => {
  assert.ok(globToRegExp("src/**/*.js").test("src/a/b/c.js"));
  assert.ok(globToRegExp("*.js").test("app.js"));
  assert.ok(!globToRegExp("*.js").test("sub/app.js"));
  assert.ok(globToRegExp("*.{ts,tsx}").test("app.tsx"));
  assert.ok(!globToRegExp("*.{ts,tsx}").test("app.js"));
});

test("PowerShell fallback translates common Bash commands", () => {
  assert.match(toPowerShellCommand("pwd"), /\(Get-Location\)\.Path/);
  assert.match(toPowerShellCommand("mkdir -p gatos"), /New-Item -ItemType Directory -Force -Path gatos/);
  assert.match(toPowerShellCommand("ls -la"), /Get-ChildItem -Force/);
  assert.match(toPowerShellCommand("dir /b src/*.* main.*"), /Get-ChildItem -Name -Path @\('src\/\*\.\*','main\.\*'\)/);
  assert.match(toPowerShellCommand("rm -rf src/assets src/components"), /Remove-Item -Recurse -Force -Path 'src\/assets'/);
  assert.match(toPowerShellCommand("del src/assets/*.* /q 2>nul"), /Remove-Item -Force -Path 'src\/assets\/\*\.\*'/);
  const curlHead = toPowerShellCommand('curl -sI "https://images.example/test?a=1&b=2" | head -5');
  assert.match(curlHead, /curl\.exe -sI/);
  assert.match(curlHead, /\| Select-Object -First 5/);
  assert.match(curlHead, /https:\/\/images\.example\/test\?a=1&b=2/);
  assert.match(toPowerShellCommand("printf 'one\\ntwo\\n' | head -n 1"), /Select-Object -First 1/);
  assert.match(toPowerShellCommand("printf 'one\\ntwo\\n' | head -n1"), /Select-Object -First 1/);
  assert.match(toPowerShellCommand("Invoke-Request -Uri https://example.test"), /Invoke-WebRequest -Uri/);
  assert.match(toPowerShellCommand("which npm || which node"), /Get-Command npm \| Select-Object -ExpandProperty Source/);
  assert.match(toPowerShellCommand("cd /c/Users/nicol && pwd"), /Set-Location 'C:\\Users\\nicol'/);
  const chained = toPowerShellCommand('cd "C:\\work dir" && npm run build || npm run fix');
  assert.match(chained, /if \(\$__soluna_ok\) \{ npm run build/);
  assert.match(chained, /if \(-not \$__soluna_ok\) \{ npm run fix/);
  assert.match(chained, /Set-Location "C:\\work dir"/);
  assert.match(
    toPowerShellCommand("node .\\node_modules\\.bin\\tailwindcss.js init -p"),
    /& '\.\\node_modules\\\.bin\\tailwindcss\.cmd' init -p/,
  );
  assert.match(
    toPowerShellCommand("& 'C:\\work\\node_modules\\.bin\\tailwindcss' init -p"),
    /& 'C:\\work\\node_modules\\\.bin\\tailwindcss\.cmd' init -p/,
  );
  const fallback = toPowerShellCommand(
    'cd "C:\\work\\weather now" && node .\\node_modules\\.bin\\tailwindcss.js init -p 2>&1 || node .\\node_modules\\.bin\\tailwindcss init -p',
  );
  assert.equal((fallback.match(/tailwindcss\.cmd/g) || []).length, 2);
  assert.match(fallback, /if \(-not \$__soluna_ok\)/);
});

test("Windows shell short-circuits && and recovers through ||", { skip: process.platform !== "win32" }, async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const result = await createBashTool(ws).execute({
      command: "Write-Output first && __soluna_missing_executable__ || Write-Output recovered",
    });
    assert.match(result.content[0].text, /first/);
    assert.match(result.content[0].text, /recovered/);
    const pipeline = await createBashTool(ws).execute({ command: "Write-Output first; Write-Output second | head -1" });
    assert.match(pipeline.content[0].text, /second/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grep searches content and validates regex", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const g = await createGrepTool(ws).execute({ pattern: "console" });
    assert.match(g.content[0].text, /sub\/app\.js:2/);
    await assert.rejects(() => createGrepTool(ws).execute({ pattern: "(" }), /regular expression/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ls lists directories and files", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const l = await createLsTool(ws).execute({ path: "." });
    assert.match(l.content[0].text, /a\.txt/);
    assert.match(l.content[0].text, /sub\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash runs safe commands inside the workspace", async (t) => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    let b;
    try {
      b = await createBashTool(ws, { confirm: null }).execute({ command: "pwd" });
    } catch (err) {
      const message = err.message.replace(/\0/g, "");
      if (/E_ACCESSDENIED|Bash\/Service\/CreateInstance|Access denied/i.test(message)) {
        t.skip("host policy blocks launching the shell process");
        return;
      }
      throw err;
    }
    assert.ok(b.content[0].text.includes(root));
    const chained = await createBashTool(ws, { confirm: null }).execute({ command: "mkdir -p gatos && cd gatos && pwd" });
    assert.ok(chained.content[0].text.includes(join(root, "gatos")));
    assert.equal((await stat(join(root, "gatos"))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash refuses risky commands without confirmation", async () => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    const tool = createBashTool(ws, { confirm: null });
    await assert.rejects(() => tool.execute({ command: "rm -rf build" }), /flagged as risky/);
    await assert.rejects(() => tool.execute({ command: "echo x > /etc/hostname" }), /outside the workspace/);
    await assert.rejects(() => tool.execute({ command: "rm -rf build", permission: "deny" }), /denied/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash confirm callback gates risky commands", async (t) => {
  const root = await makeSandbox();
  try {
    const ws = new Workspace(root);
    let asked = null;
    const tool = createBashTool(ws, { confirm: async (d) => ((asked = d), true) });
    try {
      await tool.execute({ command: "rm -rf build" });
    } catch (err) {
      const message = err.message.replace(/\0/g, "");
      if (/E_ACCESSDENIED|Bash\/Service\/CreateInstance|Access denied/i.test(message)) {
        t.skip("host policy blocks launching the shell process after approval");
        return;
      }
      throw err;
    }
    assert.ok(asked && /recursive delete/.test(asked.reason));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
