import { renderMarkdown } from "./markdown.js";
import { renderDiff } from "./diff.js";

/* ============================================================
   Soluna Web Client
   SSE-driven chat with Apple/Vercel-inspired UI.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const emptyStateEl = $("#empty-state");

// The cloud server can require a private access token. The first visit may
// carry it as ?token=...; keep it for this tab, then remove it from the URL.
const queryToken = new URLSearchParams(location.search).get("token");
if (queryToken) {
  try { sessionStorage.setItem("soluna-cloud-token", queryToken); } catch {}
  history.replaceState({}, "", location.pathname + location.hash);
}
function apiUrl(path) {
  const url = new URL(path, location.href);
  let token = "";
  try { token = sessionStorage.getItem("soluna-cloud-token") || ""; } catch {}
  if (token) url.searchParams.set("token", token);
  return url.pathname + url.search;
}
async function apiFetch(path, options) {
  const response = await fetch(apiUrl(path), options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Error ${response.status}`);
  }
  return response;
}
window.solunaApiUrl = apiUrl;
window.solunaFetch = apiFetch;

const state = {
  streaming: false,
  streamText: "",
  usage: { input: 0, output: 0, turns: 0, toolCalls: 0 },
  contextUsed: 0,
  contextLimit: 0,
  busy: false,
  provider: null,
  model: null,
  currentRunId: null,
};

let es = null;
let streamEl = null;
let retryEl = null;
let pendingMessage = "";

/* ---------------- Bootstrap ---------------- */

function init() {
  bindComposer();
  bindSidebar();
  bindAsk();
  bindFiles();
  bindSuggestions();
  connect();
  updateThemeIcon();
}

/* ---------------- SSE connection ---------------- */

function connect() {
  if (es) { es.close(); }
  es = new EventSource(apiUrl("/api/events"));

  es.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch {}
  };
  es.onerror = () => {
    setStatus("reconnecting", "reconnecting…");
    // EventSource auto-reconnects; just reflect state.
  };
}

function handleEvent(ev) {
  switch (ev.kind) {
    case "user": addUserMessage(ev.text); break;
    case "stream": setActivity("Escribiendo respuesta…"); appendStream(ev.content); break;
    case "stream-end": finalizeStream(ev.text); setActivity("Soluna está trabajando…"); break;
    case "tool-live":
      setActivity(["write", "edit"].includes(ev.name) ? "Modificando archivos…" : ev.name === "bash" ? "Ejecutando un comando…" : "Usando herramientas…");
      upsertToolLive(ev); break;
    case "tool": addToolResult(ev.entry); setActivity("Preparando respuesta…"); break;
    case "system": addSystemLine(ev.text); break;
    case "retry": setActivity("Reintentando conexión…"); setRetry(ev.message); break;
    case "retry-end": setRetry(""); break;
    case "error":
      addErrorLine(ev.text);
      if (ev.retryable && pendingMessage && !$("#composer-input").value.trim()) {
        $("#composer-input").value = ev.resume ? "Continuá la tarea pendiente desde los archivos y el avance que ya guardaste." : pendingMessage;
        $("#composer-input").dispatchEvent(new Event("input"));
      }
      break;
    case "state": applyState(ev); break;
    case "compacting": setActivity("Preparando contexto…"); setCompacting(ev.message); break;
    case "compacting-end": setCompacting(""); break;
    case "ask": setActivity("Esperando tu respuesta…"); showAsk(ev.request); break;
    case "ask-done":
      if (pendingAsk?.id === ev.id) { pendingAsk = null; $("#ask-overlay").classList.remove("show"); }
      break;
    case "clear": clearTranscript(); break;
    case "workspace-changed":
      activePreviewPath = "";
      projectFiles = [];
      $("#files-count").textContent = "0";
      $("#files-search").value = "";
      $("#file-preview").replaceChildren();
      loadProjectFiles();
      break;
    case "session-restored": restoreTranscript(ev.messages || []); break;
    case "run-queued": state.currentRunId = ev.id; break;
  }
}

/* ---------------- Composer ---------------- */

function bindComposer() {
  const input = $("#composer-input");
  const send = $("#composer-send");

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  send.addEventListener("click", () => {
    if (state.busy) { cancelRun(); } else { sendMessage(); }
  });
}

function sendMessage() {
  if (state.busy) return;
  const input = $("#composer-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";

  if (text.startsWith("/")) {
    apiFetch("/api/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) })
      .catch((error) => { input.value = text; addErrorLine(error.message); });
    return;
  }

  hideEmpty();
  pendingMessage = text;
  state.streamText = "";
  state.streaming = true;
  setBusy(true);

  apiFetch("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch((e) => {
    input.value = text;
    state.streaming = false;
    setBusy(false);
    if (streamEl) { streamEl.remove(); streamEl = null; }
    addErrorLine(e.message);
  });
}

function cancelRun() {
  apiFetch("/api/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: state.currentRunId }) })
    .then(() => finalizeStream(state.streamText))
    .catch((error) => addErrorLine(error.message));
}

/* ---------------- Sidebar ---------------- */

function bindSidebar() {
  $("#sidebar-toggle").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  $("#sidebar-close").addEventListener("click", () => $(".sidebar").classList.remove("open"));
  $("#btn-save").addEventListener("click", () => addSystemLine("Session saves automatically on exit."));
  $("#btn-theme").addEventListener("click", toggleTheme);
}

let projectFiles = [];
let activePreviewPath = "";

function bindFiles() {
  const overlay = $("#files-overlay");
  $("#files-open").addEventListener("click", () => {
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
    loadProjectFiles();
    setTimeout(() => $("#files-search").focus(), 50);
  });
  const close = () => { overlay.classList.remove("show"); overlay.setAttribute("aria-hidden", "true"); };
  $("#files-close").addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  $("#files-refresh").addEventListener("click", loadProjectFiles);
  $("#files-search").addEventListener("input", renderProjectFiles);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && overlay.classList.contains("show")) close(); });
  loadProjectFiles();
}

async function loadProjectFiles() {
  const list = $("#files-list");
  list.innerHTML = '<div class="files-loading"><span class="spinner"></span> Cargando archivos…</div>';
  try {
    const response = await apiFetch("/api/files");
    const result = await response.json();
    projectFiles = result.files || [];
    $("#files-count").textContent = projectFiles.length;
    renderProjectFiles();
    if (activePreviewPath && projectFiles.some((file) => file.path === activePreviewPath)) previewProjectFile(activePreviewPath);
    if (result.truncated) list.insertAdjacentHTML("beforeend", '<div class="files-note">Se muestran los primeros 600 archivos.</div>');
  } catch (error) {
    list.textContent = error.message;
  }
}

function renderProjectFiles() {
  const list = $("#files-list");
  const query = $("#files-search").value.trim().toLowerCase();
  const matches = projectFiles.filter((file) => file.path.toLowerCase().includes(query));
  list.replaceChildren();
  if (!matches.length) {
    const empty = el("div", "files-loading");
    empty.textContent = projectFiles.length ? "No hay resultados." : "Todavía no hay archivos.";
    list.appendChild(empty);
    return;
  }
  for (const file of matches) {
    const row = el("div", `file-row${activePreviewPath === file.path ? " active" : ""}`);
    const open = el("button", "file-open");
    open.type = "button";
    open.innerHTML = `<span class="file-type-icon">${escapeHtml(fileIcon(file.type))}</span><span class="file-row-copy"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)} · ${formatBytes(file.size)}</small></span>`;
    open.addEventListener("click", () => previewProjectFile(file.path));
    const download = el("a", "file-download");
    download.href = apiUrl(`/api/file?path=${encodeURIComponent(file.path)}&download=1`);
    download.download = file.name;
    download.title = `Descargar ${file.name}`;
    download.setAttribute("aria-label", `Descargar ${file.name}`);
    download.textContent = "↓";
    row.append(open, download);
    list.appendChild(row);
  }
}

async function previewProjectFile(path) {
  activePreviewPath = path;
  renderProjectFiles();
  const file = projectFiles.find((item) => item.path === path);
  const preview = $("#file-preview");
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const fileUrl = apiUrl(`/api/file?path=${encodeURIComponent(path)}`);
  const downloadUrl = apiUrl(`/api/file?path=${encodeURIComponent(path)}&download=1`);
  const supportedPreview = ["html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "pdf"].includes(ext);
  preview.replaceChildren();
  const head = el("div", "preview-head");
  const name = el("div", "preview-name");
  name.innerHTML = `<strong>${escapeHtml(file?.name || path)}</strong><small>${escapeHtml(path)}</small>`;
  const download = el("a", "btn btn-primary preview-download");
  download.href = downloadUrl;
  download.download = file?.name || "archivo";
  download.textContent = "Descargar ↓";
  head.append(name, download);
  preview.appendChild(head);
  if (supportedPreview) {
    const frame = el("iframe", "preview-frame");
    frame.title = `Vista previa de ${file?.name || path}`;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.referrerPolicy = "no-referrer";
    preview.appendChild(frame);
    if (["html", "htm"].includes(ext)) {
      try {
        const response = await apiFetch(fileUrl);
        const html = await response.text();
        const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: https:; style-src \'unsafe-inline\' https:; script-src \'unsafe-inline\'; font-src data: https:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'">';
        frame.srcdoc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${policy}`) : `${policy}${html}`;
      } catch (error) {
        frame.remove();
        const message = el("div", "files-loading");
        message.textContent = error.message;
        preview.appendChild(message);
      }
    } else frame.src = fileUrl;
    return;
  }
  try {
    const response = await apiFetch(fileUrl);
    const text = await response.text();
    const code = el("pre", "preview-code");
    code.textContent = text;
    preview.appendChild(code);
  } catch (error) {
    const message = el("div", "files-loading");
    message.textContent = error.message;
    preview.appendChild(message);
  }
}

function fileIcon(type) {
  if (["html", "htm"].includes(type)) return "◉";
  if (["js", "ts", "jsx", "tsx", "py", "json", "css"].includes(type)) return "⌘";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(type)) return "▧";
  return "▤";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toggleTheme() {
  const cur = document.body.dataset.theme;
  const next = cur === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  try { localStorage.setItem("soluna-theme", next); } catch {}
  updateThemeIcon();
}

function updateThemeIcon() {
  const isDark = document.body.dataset.theme === "dark";
  $("#btn-theme").innerHTML = isDark
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
}

/* ---------------- Ask modal ---------------- */

let pendingAsk = null;
let askAnswers = [];
let askIndex = 0;
let askSubmitting = false;

function bindAsk() {
  $("#ask-cancel").addEventListener("click", () => submitAsk([]));
}

async function submitAsk(answers) {
  if (!pendingAsk || askSubmitting) return;
  const id = pendingAsk.id;
  askSubmitting = true;
  $$("#ask-modal button").forEach((button) => { button.disabled = true; });
  try {
    await apiFetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, answers }) });
    if (pendingAsk?.id === id) {
      pendingAsk = null;
      $("#ask-overlay").classList.remove("show");
    }
  } catch (error) {
    addErrorLine(error.message);
    // Keep the decision visible so a failed request can be retried.
    if (pendingAsk?.id === id) renderAskQuestion();
  } finally {
    askSubmitting = false;
    $$("#ask-modal button").forEach((button) => { button.disabled = false; });
  }
}

function showAsk(request) {
  if (!request?.questions?.length || pendingAsk?.id === request.id) return;
  pendingAsk = request;
  askAnswers = [];
  askIndex = 0;
  renderAskQuestion();
}

function renderAskQuestion() {
  const q = pendingAsk.questions[askIndex];
  $("#ask-title").textContent = q.header || "Soluna necesita una decisión";
  const body = $("#ask-body");
  body.innerHTML = "";
  const question = el("div", "ask-question");
  question.textContent = q.question;
  body.appendChild(question);
  const selected = new Set();
  const choose = (values) => {
    const answer = { header: q.header, question: q.question, answers: values };
    const answers = [...askAnswers.slice(0, askIndex), answer];
    if (askIndex + 1 < pendingAsk.questions.length) {
      askAnswers = answers;
      askIndex++;
      renderAskQuestion();
    } else submitAsk(answers);
  };
  (q.options || []).forEach((opt) => {
    const btn = el("button", "ask-option");
    btn.innerHTML = `<span class="opt-label">${escapeHtml(opt.label)}</span>${opt.description ? `<br><span class="opt-desc">${escapeHtml(opt.description)}</span>` : ""}`;
    if (q.multiple) btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      if (!q.multiple) return choose([opt.label]);
      if (selected.has(opt.label)) selected.delete(opt.label); else selected.add(opt.label);
      btn.setAttribute("aria-pressed", String(selected.has(opt.label)));
    });
    body.appendChild(btn);
  });
  let custom;
  if (q.custom !== false) {
    custom = el("textarea", "ask-custom");
    custom.placeholder = "Escribí tu respuesta…";
    custom.setAttribute("aria-label", "Respuesta personalizada");
    body.appendChild(custom);
  }
  if (q.multiple || custom) {
    const next = el("button", "btn btn-primary");
    next.textContent = askIndex + 1 < pendingAsk.questions.length ? "Siguiente" : "Enviar respuesta";
    next.addEventListener("click", () => {
      const values = [...selected];
      if (custom?.value.trim()) values.push(custom.value.trim());
      if (values.length) choose(values);
    });
    body.appendChild(next);
  }
  $("#ask-overlay").classList.add("show");
  body.querySelector("button, textarea")?.focus();
}

/* ---------------- Suggestions ---------------- */

function bindSuggestions() {
  $$(".suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      const msg = btn.dataset.msg;
      $("#composer-input").value = msg;
      sendMessage();
    });
  });
}

/* ---------------- Rendering ---------------- */

function hideEmpty() { $("#empty-state")?.style.setProperty("display", "none"); }
function showEmpty() { $("#empty-state")?.style.setProperty("display", "flex"); }

function clearTranscript() {
  setActivity("");
  retryEl = null;
  streamEl = null;
  $("#transcript").replaceChildren(emptyStateEl);
  showEmpty();
  state.streamText = "";
  state.streaming = false;
  $("#stream-output").classList.remove("show");
  $("#stream-output").innerHTML = "";
}

function restoreTranscript(messages) {
  clearTranscript();
  for (const message of messages) {
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
        : "";
    if (!content.trim()) continue;
    if (message.role === "user") addUserMessage(content);
    else if (message.role === "assistant") {
      hideEmpty();
      const wrap = el("div", "msg msg-assistant");
      wrap.innerHTML = `<div class="msg-avatar">☾</div><div class="msg-body"><div class="msg-bubble">${renderMarkdown(content)}</div></div>`;
      appendTranscript(wrap);
    }
  }
  if (messages.length) hideEmpty();
}

function addUserMessage(text) {
  hideEmpty();
  const wrap = el("div", "msg msg-user");
  wrap.innerHTML = `
    <div class="msg-body"><div class="msg-bubble">${escapeHtml(text)}</div></div>
    <div class="msg-avatar">❯</div>`;
  appendTranscript(wrap);
}

function appendStreamEl() {
  if (streamEl) return;
  const live = $("#stream-output");
  streamEl = el("div", "msg msg-assistant msg-streaming");
  streamEl.innerHTML = `
    <div class="msg-avatar">⚡</div>
    <div class="msg-body"><div class="msg-bubble"><span class="stream-text"></span><span class="cursor"></span></div></div>`;
  live.appendChild(streamEl);
  live.classList.add("show");
  scrollBottom();
}

function appendStream(content) {
  if (!streamEl) appendStreamEl();
  if (typeof content === "string") state.streamText = content;
  const span = streamEl.querySelector(".stream-text");
  span.innerHTML = renderMarkdown(state.streamText);
  scrollBottom();
}

function finalizeStream(text) {
  // A final response may differ from the last chunk, or arrive without chunks.
  if (typeof text === "string") state.streamText = text;
  if (state.streamText) {
    if (!streamEl) appendStreamEl();
    streamEl.querySelector(".stream-text").innerHTML = renderMarkdown(state.streamText);
  }
  state.streaming = false;
  if (streamEl) {
    streamEl.classList.remove("msg-streaming");
    streamEl.querySelector(".cursor")?.remove();
    if (state.streamText) $("#transcript").appendChild(streamEl);
    else streamEl.remove();
    streamEl = null;
  }
  state.streamText = "";
  $("#stream-output").classList.remove("show");
  $("#stream-output").innerHTML = "";
  scrollBottom();
}

function setRetry(text) {
  if (!text) { retryEl?.remove(); retryEl = null; return; }
  if (!retryEl) {
    retryEl = el("div", "line-system");
    retryEl.setAttribute("role", "status");
    appendTranscript(retryEl);
  }
  retryEl.textContent = text;
}

function addSystemLine(text) {
  hideEmpty();
  const line = el("div", "line-system");
  line.textContent = text;
  appendTranscript(line);
}

function addErrorLine(text) {
  hideEmpty();
  const line = el("div", "line-error");
  line.textContent = text;
  appendTranscript(line);
}

function setCompacting(msg) {
  const banner = $("#compacting-banner");
  $("#compacting-text").textContent = msg || "Compacting…";
  banner.classList.toggle("show", Boolean(msg));
}

function upsertToolLive(ev) {
  hideEmpty();
  let card = Array.from(document.querySelectorAll(".tool-card")).find((node) => node.dataset.id === ev.id);
  if (!card) {
    addToolResult({ id: ev.id, name: ev.name, phase: ev.phase, label: ev.args?.path || ev.args?.command || ev.name });
    card = Array.from(document.querySelectorAll(".tool-card")).find((node) => node.dataset.id === ev.id);
  }
  const status = card.querySelector(".tool-status");
  if (ev.phase === "running") {
    status.innerHTML = '<span class="spinner"></span> running';
  } else if (ev.phase === "preparing") {
    status.textContent = "preparing";
  }
}

function addToolResult(entry) {
  hideEmpty();
  let card = Array.from(document.querySelectorAll(".tool-card")).find((node) => node.dataset.id === entry.id);
  if (!card) {
    card = el("div", "tool-card");
    card.dataset.id = entry.id;
    appendTranscript(card);
  }
  const inner = card.classList.contains("tool-card") ? card : card.querySelector(".tool-card");

  const isError = entry.phase === "error";
  let bodyHtml = "";
  if (isError) {
    bodyHtml = `<div class="tool-output tool-error">${escapeHtml(entry.error || "Unknown error")}</div>`;
  } else if (entry.diff) {
    bodyHtml = renderDiff(entry.diff);
  } else if (entry.output) {
    bodyHtml = `<div class="tool-output">${escapeHtml(entry.output)}</div>`;
  }

  const label = entry.label || entry.name || "tool";
  inner.innerHTML = `
    <div class="tool-card-head">
      <span class="tool-icon">${isError ? "✗" : entry.phase === "done" ? "✓" : "⟳"}</span>
      <span class="tool-name">${escapeHtml(entry.name || "")}</span>
      <span class="tool-label">${escapeHtml(label)}</span>
      <span class="tool-status">${isError ? "error" : entry.phase === "done" ? "done" : ""}</span>
      ${bodyHtml ? '<span class="tool-chevron">▾</span>' : ""}
    </div>
    ${bodyHtml ? `<div class="tool-card-body">${bodyHtml}</div>` : ""}`;

  if (entry.diff || isError) inner.classList.add("open");
  if (bodyHtml) {
    inner.querySelector(".tool-card-head").addEventListener("click", () => {
      inner.classList.toggle("open");
    });
  }
  if (!isError && ["write", "edit"].includes(entry.name) && entry.filePath) {
    const actions = el("div", "tool-file-actions");
    const previewButton = el("button", "btn btn-ghost");
    previewButton.type = "button";
    previewButton.textContent = "Ver archivo";
    previewButton.addEventListener("click", () => {
      $("#files-overlay").classList.add("show");
      $("#files-overlay").setAttribute("aria-hidden", "false");
      $("#files-search").value = "";
      loadProjectFiles().then(() => previewProjectFile(entry.filePath));
    });
    const download = el("a", "btn btn-ghost");
    download.href = apiUrl(`/api/file?path=${encodeURIComponent(entry.filePath)}&download=1`);
    download.download = entry.filePath.split("/").pop();
    download.textContent = "Descargar ↓";
    actions.append(previewButton, download);
    inner.querySelector(".tool-card-body")?.appendChild(actions);
    if (!inner.querySelector(".tool-card-body")) inner.appendChild(actions);
    loadProjectFiles();
  }
  scrollBottom();
}


function appendTranscript(node) {
  $("#transcript").appendChild(node);
  scrollBottom();
}

function scrollBottom() {
  const t = $("#transcript");
  t.scrollTop = t.scrollHeight;
}

/* ---------------- State ---------------- */

function applyState(s) {
  const wasBusy = state.busy;
  if (s.askRequest) showAsk(s.askRequest);
  else if (s.askRequest === null) { pendingAsk = null; $("#ask-overlay").classList.remove("show"); }
  window.dispatchEvent(new CustomEvent("soluna-state", { detail: s }));
  if (s.usage) state.usage = s.usage;
  if (s.contextUsed != null) state.contextUsed = s.contextUsed;
  if (s.contextLimit != null) state.contextLimit = s.contextLimit;
  if (s.provider) state.provider = s.provider;
  if (s.model) state.model = s.model;
  if (s.currentRunId !== undefined) state.currentRunId = s.currentRunId;
  if (s.busy === false && streamEl) finalizeStream(state.streamText);
  if (s.busy != null) setBusy(s.busy);
  if (wasBusy && s.busy === false) loadProjectFiles();
  if (s.busy === false) pendingMessage = "";
  if (s.askRequest) setActivity("Esperando tu respuesta…");

  if ($("#provider-name")) $("#provider-name").textContent = s.provider || "—";
  if ($("#provider-model")) $("#provider-model").textContent = s.model || "";
  $("#model-hint").textContent = s.model || s.provider || "zen";
  if (s.cwd) {
    const parts = s.cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    $("#workspace-label").textContent = parts[parts.length - 1] || s.cwd;
    $("#workspace-path").textContent = s.cwd;
    $("#topbar-title").textContent = parts[parts.length - 1] || "Workspace";
  }

  $("#usage-input").textContent = formatTokens(s.usage?.input || 0);
  $("#usage-output").textContent = formatTokens(s.usage?.output || 0);
  $("#usage-turns").textContent = s.usage?.turns || 0;
  $("#usage-tools").textContent = s.usage?.toolCalls || 0;

  const used = s.contextUsed || 0;
  const limit = s.contextLimit || 1;
  const pct = Math.min(100, (used / limit) * 100);
  const fill = $("#context-fill");
  fill.style.width = pct + "%";
  fill.classList.toggle("warn", pct >= 70 && pct < 85);
  fill.classList.toggle("danger", pct >= 85);
  $("#context-used").textContent = formatTokens(used) + " tok";
  $("#context-limit").textContent = formatTokens(limit);
}

function setActivity(text) {
  const activity = $("#chat-activity");
  if (!activity) return;
  activity.hidden = !state.busy || !text;
  $("#chat-activity-text").textContent = text || "";
}

function setBusy(busy) {
  state.busy = busy;
  setActivity(busy ? "Soluna está trabajando…" : "");
  const send = $("#composer-send");
  $("#status-pill").classList.toggle("busy", busy);
  $("#status-text").textContent = busy ? "trabajando…" : "en línea";

  if (busy) {
    send.classList.add("stop");
    $("#send-icon").style.display = "none";
    $("#stop-icon").style.display = "block";
  } else {
    send.classList.remove("stop");
    $("#send-icon").style.display = "block";
    $("#stop-icon").style.display = "none";
  }
}

function setStatus(kind, text) {
  const pill = $("#status-pill");
  pill.classList.remove("busy", "error");
  if (kind === "busy") pill.classList.add("busy");
  if (kind === "error") pill.classList.add("error");
  $("#status-text").textContent = text;
}

/* ---------------- Helpers ---------------- */

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTokens(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/* ---------------- Boot ---------------- */

try {
  document.body.dataset.theme = localStorage.getItem("soluna-theme") || localStorage.getItem("zyn-theme") || "dark";
} catch {}
init();
