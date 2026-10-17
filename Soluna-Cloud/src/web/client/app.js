import { renderMarkdown } from "./markdown.js";

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
function apiFetch(path, options) { return fetch(apiUrl(path), options); }
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

/* ---------------- Bootstrap ---------------- */

function init() {
  bindComposer();
  bindSidebar();
  bindAsk();
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
    case "stream": appendStream(ev.content); break;
    case "stream-end": finalizeStream(ev.text); break;
    case "tool-live": upsertToolLive(ev); break;
    case "tool": addToolResult(ev.entry); break;
    case "system": addSystemLine(ev.text); break;
    case "error": addErrorLine(ev.text); break;
    case "state": applyState(ev); break;
    case "compacting": setCompacting(ev.message); break;
    case "compacting-end": setCompacting(""); break;
    case "ask": showAsk(ev.request); break;
    case "ask-done": break;
    case "clear": clearTranscript(); break;
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
    if (text === "/clear") { clearTranscript(); }
    apiFetch("/api/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return;
  }

  hideEmpty();
  state.streamText = "";
  state.streaming = true;
  setBusy(true);
  appendStreamEl();

  apiFetch("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch((e) => addErrorLine(e.message));
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
  $("#btn-new").addEventListener("click", () => { clearTranscript(); hideEmpty(); });
  $("#btn-save").addEventListener("click", () => addSystemLine("Session saves automatically on exit."));
  $("#btn-theme").addEventListener("click", toggleTheme);
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

function bindAsk() {
  $("#ask-cancel").addEventListener("click", () => {
    $("#ask-overlay").classList.remove("show");
    apiFetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: [] }) });
  });
}

function showAsk(request) {
  const overlay = $("#ask-overlay");
  const title = $("#ask-title");
  const body = $("#ask-body");

  title.textContent = request.questions?.[0]?.header || "Permission";
  body.innerHTML = "";

  const q = request.questions?.[0];
  if (!q) return;

  const custom = document.createElement("div");
  custom.style.marginTop = "4px";
  const options = q.options || [];

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "ask-option";
    btn.innerHTML = `<span><span class="opt-label">${escapeHtml(opt.label)}</span>${opt.description ? `<br><span class="opt-desc">${escapeHtml(opt.description)}</span>` : ""}</span>`;
    btn.addEventListener("click", () => {
      overlay.classList.remove("show");
      apiFetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: [opt.label] }) });
    });
    body.appendChild(custom);
    custom.appendChild(btn);
  });

  overlay.classList.add("show");
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
  if (typeof text === "string" && text) state.streamText = text;
  state.streaming = false;
  setBusy(false);

  // Move the finished bubble from the live region into the transcript.
  if (streamEl) {
    streamEl.classList.remove("msg-streaming");
    streamEl.querySelector(".cursor")?.remove();
    $("#transcript").appendChild(streamEl);
    streamEl = null;
  }
  $("#stream-output").classList.remove("show");
  $("#stream-output").innerHTML = "";
  scrollBottom();
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
  let card = document.querySelector(`.tool-card[data-id="${ev.id}"]`);
  if (!card) return; // created on "tool" event with full data
  const status = card.querySelector(".tool-status");
  if (ev.phase === "running") {
    status.innerHTML = '<span class="spinner"></span> running';
  } else if (ev.phase === "preparing") {
    status.textContent = "preparing";
  }
}

function addToolResult(entry) {
  hideEmpty();
  let card = document.querySelector(`.tool-card[data-id="${entry.id}"]`);
  if (!card) {
    card = el("div", "tool-entry");
    card.innerHTML = `<div class="tool-card" data-id="${entry.id}"></div>`;
    appendTranscript(card.firstChild);
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

  if (bodyHtml) {
    inner.querySelector(".tool-card-head").addEventListener("click", () => {
      inner.classList.toggle("open");
    });
  }
  scrollBottom();
}

function renderDiff(diff) {
  if (!diff) return "";
  const lines = [];
  for (const l of diff.lines || []) {
    if (l.type === "add") lines.push(`<div class="diff-add">+ ${escapeHtml(l.text)}</div>`);
    else if (l.type === "rem") lines.push(`<div class="diff-rem">- ${escapeHtml(l.text)}</div>`);
  }
  return `<div class="tool-diff">${lines.join("")}</div>`;
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
  if (s.usage) state.usage = s.usage;
  if (s.contextUsed != null) state.contextUsed = s.contextUsed;
  if (s.contextLimit != null) state.contextLimit = s.contextLimit;
  if (s.provider) state.provider = s.provider;
  if (s.model) state.model = s.model;
  if (s.currentRunId !== undefined) state.currentRunId = s.currentRunId;
  if (s.busy != null) setBusy(s.busy);

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

function setBusy(busy) {
  state.busy = busy;
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
