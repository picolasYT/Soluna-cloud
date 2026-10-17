import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, Static, useApp, useInput, useStdout } from "ink";
import { TextInput } from "./components/TextInput.js";
import { AskPanel } from "./components/AskPanel.js";
import { ToolActivity } from "./components/ToolActivity.js";
import { DiffView } from "./components/DiffView.js";
import { StatusBar } from "./components/StatusBar.js";
import { Markdown } from "./components/Markdown.js";
import { SelectOverlay, HelpOverlay, InfoOverlay } from "./components/Overlay.js";
import {
  FormOverlay,
  PROVIDER_FIELDS,
  MODEL_FIELDS,
  MCP_FIELDS,
  API_KEY_FIELDS,
  OPENROUTER_KEY_FIELDS,
} from "./components/FormOverlay.js";
import { SLASH_COMMANDS, matchCommands, parseCommand } from "./commands.js";
import { getTheme, THEME_NAMES, THEMES, SPINNER_FRAMES } from "./themes.js";
import {
  PROVIDER_CATALOG,
  buildCatalog,
  getProviderInfo,
  getDefaultModel,
  isProviderReady,
  keySource,
} from "../providers/catalog.js";
import { uiBridge } from "../core/ui-bridge.js";
import { compactConversation } from "../core/compaction.js";
import {
  Session,
  listSessions,
  loadSession,
  latestSession,
  loadConfig,
  saveConfig,
  saveCustomProvider,
  addCustomModel,
  saveMCPServer,
  removeMCPServer,
  saveApiKey,
  saveApiKeySet,
  loadMCPServers,
  SOLUNA_HOME,
  CONFIG_PATH,
  MCP_PATH,
  SKILLS_DIR,
} from "../core/session-store.js";
import { renderSkillsPrompt } from "../core/skills.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { createProvider } from "../providers/index.js";
import { toolStatus } from "../core/tool-status.js";
import {
  UsageTracker,
  getContextLimit,
  estimateMessagesTokens,
  formatTokens,
  loadModelLimits,
} from "../core/tokens.js";
import { APP_NAME, APP_VERSION } from "../config/constants.js";

const h = React.createElement;

function timeAgo(ts) {
  const diff = Date.now() - (ts || 0);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

let lineId = 0;
const nextLineId = () => `l${++lineId}`;

/* ------------------------------------------------------------------ */
/* Transcript                                                           */
/* ------------------------------------------------------------------ */

function HistoryLine({ line, theme, width }) {
  switch (line.kind) {
    case "user":
      return h(
        Box,
        null,
        h(Text, { color: theme.user, bold: true }, "❯ "),
        h(Text, { color: theme.text, wrap: "wrap" }, line.text),
      );
    case "assistant":
      return h(Markdown, { text: line.text, theme, width });
    case "tool":
      return h(ToolActivity, { entry: line.entry, theme, width, live: false });
    case "error":
      return h(Text, { color: theme.error, wrap: "wrap" }, `  ✗ ${line.text}`);
    case "system":
      return h(Text, { color: theme.warn, wrap: "wrap" }, line.text);
    default:
      return h(Text, { color: theme.dim, wrap: "wrap" }, line.text);
  }
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export function App({
  initialProvider,
  initialModel,
  initialConfig = null,
  cwd,
  tools,
  initialPrompt,
  skills = [],
  mcpStatus = [],
  resumeSession = null,
  // Provider injection for tests. In production it is resolved by name.
  providerOverride,
  workspace = null,
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [themeName, setThemeName] = useState("soluna");
  const theme = getTheme(themeName);
  const width = stdout?.columns || 80;

  const [history, setHistory] = useState([]);
  const [providerId, setProviderId] = useState(initialProvider);
  const [model, setModel] = useState(initialModel || getDefaultModel(initialProvider));
  const [workDir, setWorkDir] = useState(cwd);
  const [draft, setDraft] = useState("");
  const [overlay, setOverlay] = useState(null);
  const [askRequest, setAskRequest] = useState(null);

  // Estado en vivo del turno actual.
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [activeTools, setActiveTools] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [queued, setQueued] = useState([]);
  const [compacting, setCompacting] = useState(null);
  const [inputEpoch, setInputEpoch] = useState(0);

  // Contadores.
  const [usage, setUsage] = useState({ input: 0, output: 0, turns: 0, toolCalls: 0 });
  const [contextUsed, setContextUsed] = useState(0);

  const messagesRef = useRef([]);
  const usageRef = useRef(new UsageTracker());
  const askResolverRef = useRef(null);
  const inputHistoryRef = useRef([]);
  const shutdownRef = useRef(false);
  const configLoadedRef = useRef(Boolean(initialConfig));

  /* --- Graceful shutdown --------------------------------------- */
  // Flush the session to disk before exiting, so killing the process is
  // never lossy. Guards against double-invocation.
  const shutdown = useCallback(async () => {
    if (shutdownRef.current) return;
    shutdownRef.current = true;
    const s = sessionRef.current;
    if (s) {
      s.messages = messagesRef.current;
      s.summary = summaryRef.current;
      s.provider = providerId;
      s.model = model;
      s.cwd = workDir;
      s.usage = usageRef.current.snapshot();
      try {
        await s.flush();
      } catch {
        // A save failure must never block exit.
      }
    }
    exit();
  }, [exit, providerId, model, workDir]);

  // Catch SIGTERM / SIGHUP (kill, terminal closed) — the Ink Ctrl+C
  // handler above does not run for those, so without this the session
  // would be lost every time the terminal is closed.
  useEffect(() => {
    const onSignal = () => {
      void shutdown();
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    return () => {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGHUP", onSignal);
    };
  }, [shutdown]);
  const histIdxRef = useRef(-1);
  const abortRef = useRef(null);
  const queueRef = useRef([]);
  const busyRef = useRef(false);
  const startedAtRef = useRef(0);
  const toolStartRef = useRef(new Map());
  const summaryRef = useRef(null);
  const sessionRef = useRef(null);
  const [sessionList, setSessionList] = useState(null);
  const [catalog, setCatalog] = useState(() => initialConfig ? buildCatalog(initialConfig) : PROVIDER_CATALOG);
  const [mcpServers, setMcpServers] = useState({});
  const [storedConfig, setStoredConfig] = useState(initialConfig || {});
  const [pendingKeyProvider, setPendingKeyProvider] = useState(null);

  const push = useCallback((line) => {
    setHistory((prev) => [...prev, { id: nextLineId(), ...line }]);
  }, []);

  const pushText = useCallback(
    (kind, text) => {
      if (!text) return;
      push({ kind, text: String(text) });
    },
    [push],
  );

  const refreshContext = useCallback(() => {
    setContextUsed(estimateMessagesTokens(messagesRef.current));
  }, []);

  /* --- Bridge to the ask tool ------------------------------- */
  useEffect(() => {
    return uiBridge.connect(
      (request) =>
        new Promise((resolve) => {
          askResolverRef.current = resolve;
          setAskRequest(request);
        }),
    );
  }, []);

  const finishAsk = useCallback((answers) => {
    const resolve = askResolverRef.current;
    askResolverRef.current = null;
    setAskRequest(null);
    resolve?.(answers);
  }, []);

  /* --- Config-backed catalog ----------------------------------------- */
  const refreshCatalog = useCallback(async () => {
    const config = await loadConfig();
    setThemeName(config.theme || "soluna");
    configLoadedRef.current = true;
    setStoredConfig(config);
    setCatalog(buildCatalog(config));
    setMcpServers(await loadMCPServers());
    return config;
  }, []);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  /* --- Persistent session -------------------------------------------- */
  useEffect(() => {
    if (sessionRef.current) return;
    if (resumeSession) {
      const restored = Session.fromJSON(resumeSession);
      sessionRef.current = restored;
      messagesRef.current = restored.messages;
      summaryRef.current = restored.summary;
      usageRef.current.input = restored.usage?.input || 0;
      usageRef.current.output = restored.usage?.output || 0;
      usageRef.current.turns = restored.usage?.turns || 0;
      usageRef.current.toolCalls = restored.usage?.toolCalls || 0;
      setUsage(usageRef.current.snapshot());
      setContextUsed(estimateMessagesTokens(restored.messages));
      pushText("system", `Resumed session · ${restored.messages.length} messages`);
    } else {
      sessionRef.current = new Session({ cwd: workDir, provider: providerId, model });
    }
    // Set terminal window title to "Soluna - <session>".
    const s = sessionRef.current;
    const sessionLabel = s.title || s.id.slice(0, 16);
    process.stdout.write(`\x1b]0;Soluna - ${sessionLabel}\x07`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist preferences whenever they change.
  useEffect(() => {
    if (!configLoadedRef.current) return;
    saveConfig({ provider: providerId, model, theme: themeName }).catch(() => {});
  }, [providerId, model, themeName]);

  /** Copy current turn state into the session and schedule a save. */
  const persist = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    s.messages = messagesRef.current;
    s.summary = summaryRef.current;
    s.provider = providerId;
    s.model = model;
    s.cwd = workDir;
    s.usage = usageRef.current.snapshot();
    s.scheduleSave();
  }, [providerId, model, workDir]);

  /* --- Dynamic models (providers that expose /models) ---------------------------- */
  const [dynamicModels, setDynamicModels] = useState(null);
  useEffect(() => {
    const info = getProviderInfo(providerId);
    if (!info?.dynamic) {
      setDynamicModels(null);
      return;
    }
    let alive = true;
    setDynamicModels("loading");
    (async () => {
      try {
        const instance =
          providerOverride || createProvider(providerId, { model, catalog, config: storedConfig, allowNoKey: true });
        const list = await instance.listModels();
        if (alive) setDynamicModels(list);
      } catch (err) {
        if (alive) setDynamicModels({ error: err.message });
      }
    })();
    return () => {
      alive = false;
    };
    // Depends only on the provider: reload when it changes.
  }, [providerId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Real model limits ------------------------------------ */
  const [limitsVersion, setLimitsVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    loadModelLimits().then(() => {
      if (alive) setLimitsVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* --- Turn stopwatch ---------------------------------------- */
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  /* --- Running a turn --------------------------------------- */
  const runTurn = useCallback(
    async (text) => {
      let providerInstance = providerOverride;
      if (!providerInstance) {
        try {
          providerInstance = createProvider(providerId, {
            model,
            catalog,
            config: storedConfig,
            onKeyRotation: ({ failedKey, nextKey, keyCount, status }) =>
              pushText("system", `OpenRouter key ${failedKey}/${keyCount} hit HTTP ${status}; retrying with key ${nextKey}/${keyCount}.`),
          });
        } catch (err) {
          pushText("error", err.message);
          return;
        }
      }

      messagesRef.current.push({ role: "user", content: text });
      refreshContext();

      busyRef.current = true;
      setBusy(true);
      setStreamText("");
      setActiveTools([]);
      setElapsed(0);
      startedAtRef.current = Date.now();
      toolStartRef.current.clear();

      const controller = new AbortController();
      abortRef.current = controller;

      // Update a tool entry by id, creating it when absent.
      const upsertTool = (id, patch) => {
        setActiveTools((prev) => {
          const idx = prev.findIndex((t) => t.id === id);
          if (idx === -1) return [...prev, { id, ...patch }];
          const next = [...prev];
          next[idx] = { ...next[idx], ...patch };
          return next;
        });
      };

      try {
        const result = await runAgentLoop({
          messages: messagesRef.current,
          tools,
          provider: providerInstance,
          model,
          cwd: workDir,
          signal: controller.signal,
          systemExtra: renderSkillsPrompt(skills),

          // In-flight text: ephemeral, drawn under the transcript.
          onMessage: ({ content }) => setStreamText(content || ""),

          // Closed text: pinned to the transcript BEFORE that iteration's tools
          // run, preserving the real order.
          onMessageFinal: (text) => {
            setStreamText("");
            pushText("assistant", text);
          },

          onToolPrepare: ({ id, name, args }) => {
            if (!name) return;
            upsertTool(id, {
              name,
              phase: "preparing",
              label: toolStatus(name, "preparing", args),
            });
          },

          onToolCall: ({ id, name, args }) => {
            toolStartRef.current.set(id, Date.now());
            upsertTool(id, {
              name,
              phase: "running",
              label: toolStatus(name, "running", args),
            });
          },

          onToolResult: ({ id, name, args, result, error }) => {
            const startedAt = toolStartRef.current.get(id);
            const ms = startedAt ? Date.now() - startedAt : 0;
            const duration = ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : ms ? `${ms}ms` : "";

            const entry = {
              id,
              name,
              phase: error ? "error" : "done",
              label: toolStatus(name, "done", args || {}),
              duration,
              diff: result?.details?.diff || null,
              error: error ? error.message : null,
              output: null,
            };

            // For tools without a diff, show an excerpt of the output.
            if (!entry.diff && !error) {
              const out = (result?.content || [])
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n")
                .trim();
              if (out && name !== "ask") entry.output = out;
            }

            usageRef.current.toolCalls++;
            setActiveTools((prev) => prev.filter((t) => t.id !== id));
            push({ kind: "tool", entry });
          },

          onUsage: (u) => {
            usageRef.current.record(u);
            setUsage(usageRef.current.snapshot());
          },

          previousSummary: summaryRef.current,

          onRetry: ({ attempt, attempts, delay, error }) => {
            // Reuse the turn's status indicator.
            setCompacting(`Provider failed — retrying ${attempt}/${attempts - 1}…`);
            pushText(
              "system",
              `Provider failed: ${String(error.message).slice(0, 90)} — retry ${attempt}/${attempts - 1} in ${Math.round(delay / 100) / 10}s`,
            );
          },

          onRetryResolved: ({ attempt }) => {
            // The provider recovered: clear the stale "retrying…" indicator
            // and confirm it in the transcript.
            setCompacting(null);
            pushText("system", `Provider recovered on retry ${attempt}.`);
          },

          onCompaction: (e) => {
            if (e.phase === "start") {
              setCompacting(
                e.reason === "overflow"
                  ? "Context full — compacting the conversation…"
                  : "Context nearly full — compacting…",
              );
            } else if (e.phase === "summarizing") {
              setCompacting(`Writing handoff document (${e.messages} messages)…`);
            } else if (e.phase === "rebuilding") {
              setCompacting("Rebuilding context…");
            } else if (e.phase === "done") {
              setCompacting(null);
              pushText(
                "system",
                `Compacted ${e.compactedCount} messages · ${formatTokens(e.before)} → ${formatTokens(e.after)} tokens (saved ${formatTokens(e.saved)})`,
              );
            } else if (e.phase === "failed") {
              setCompacting(null);
              pushText("error", `Compaction failed: ${e.error}`);
            }
          },
        });

        // onMessageFinal already pinned the text; just clear the buffer.
        setStreamText("");

        messagesRef.current = result.messages.filter((m) => m.role !== "system");
        if (result.summary) summaryRef.current = result.summary;
        usageRef.current.turns++;
        persist();
        setUsage(usageRef.current.snapshot());
        refreshContext();
      } catch (err) {
        setStreamText((current) => {
          if (current) pushText("assistant", current);
          return "";
        });
        if (/abort/i.test(err.message) || err.name === "AbortError") {
          pushText("system", "Cancelled.");
        } else {
          pushText("error", err.message);
        }
      } finally {
        abortRef.current = null;
        setActiveTools([]);
        setCompacting(null);
        busyRef.current = false;
        setBusy(false);
      }

      // Send the next message queued while the task was running.
      const nextQueued = queueRef.current.shift();
      if (nextQueued) {
        setQueued([...queueRef.current]);
        push({ kind: "user", text: nextQueued });
        await runTurn(nextQueued);
      }
    },
    [providerId, model, tools, workDir, push, pushText, refreshContext, providerOverride, persist],
  );

  /* --- Manual compaction ------------------------------------------- */
  const runCompactNow = useCallback(async () => {
    if (busyRef.current) {
      pushText("error", "Cannot compact while a task is running.");
      return;
    }
    if (messagesRef.current.length < 3) {
      pushText("system", "Nothing to compact yet.");
      return;
    }

    let providerInstance = providerOverride;
    if (!providerInstance) {
      try {
        providerInstance = createProvider(providerId, { model, catalog, config: storedConfig });
      } catch (err) {
        pushText("error", err.message);
        return;
      }
    }

    busyRef.current = true;
    setBusy(true);
    setCompacting("Writing handoff document…");

    try {
      const result = await compactConversation({
        messages: messagesRef.current,
        provider: providerInstance,
        model,
        cwd: workDir,
        previousSummary: summaryRef.current,
        keepRecent: 4,
      });

      if (result.skipped) {
        pushText("system", "Nothing to compact yet.");
      } else {
        messagesRef.current = result.messages;
        summaryRef.current = result.summary;
        refreshContext();
        pushText(
          "system",
          `Compacted ${result.compactedCount} messages · ${formatTokens(result.before)} → ${formatTokens(result.after)} tokens (saved ${formatTokens(result.saved)})`,
        );
      }
    } catch (err) {
      pushText("error", `Compaction failed: ${err.message}`);
    } finally {
      setCompacting(null);
      busyRef.current = false;
      setBusy(false);
    }
  }, [providerId, model, workDir, providerOverride, pushText, refreshContext]);

  /** Restore the most recent session for this directory. */
  const resumeLatest = useCallback(async () => {
    const data = await latestSession(workDir);
    if (!data) {
      pushText("system", "No previous session for this directory.");
      return;
    }
    applySession(data);
  }, [workDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const applySession = useCallback(
    (data) => {
      const restored = Session.fromJSON(data);
      sessionRef.current = restored;
      messagesRef.current = restored.messages;
      summaryRef.current = restored.summary;
      if (restored.provider) setProviderId(restored.provider);
      if (restored.model) setModel(restored.model);
      usageRef.current.input = restored.usage?.input || 0;
      usageRef.current.output = restored.usage?.output || 0;
      usageRef.current.turns = restored.usage?.turns || 0;
      usageRef.current.toolCalls = restored.usage?.toolCalls || 0;
      setUsage(usageRef.current.snapshot());
      refreshContext();
      setHistory([]);
      pushText(
        "system",
        `Resumed session ${restored.id} · ${restored.messages.length} messages${restored.summary ? " · has handoff document" : ""}`,
      );
    },
    [pushText, refreshContext],
  );

  /* --- Commands ----------------------------------------------------- */
  const applyAction = useCallback(
    (action) => {
      switch (action?.type) {
        case "overlay":
          if (action.overlay === "setkey") {
            setPendingKeyProvider(action.args || providerId);
          }
          setOverlay(action.overlay);
          break;
        case "message":
          pushText(action.tone || "system", action.text);
          break;
        case "compact":
          runCompactNow();
          break;
        case "resume":
          resumeLatest();
          break;
        case "save":
          sessionRef.current?.flush().then((ok) =>
            pushText("system", ok ? `Session saved: ${sessionRef.current.id}` : "Could not save session"),
          );
          break;
        case "clear":
          setHistory([]);
          messagesRef.current = [];
          summaryRef.current = null;
          setContextUsed(0);
          pushText("system", "Conversation cleared.");
          break;
        case "cwd":
          try {
            const nextDir = workspace?.chdir ? workspace.chdir(action.value) : action.value;
            setWorkDir(nextDir);
            pushText("system", `Working directory: ${nextDir}`);
          } catch (err) {
            pushText("system", `Cannot change directory: ${err.message}`);
          }
          break;
        case "exit":
          void shutdown();
          break;
        default:
          break;
      }
    },
    [pushText, exit, shutdown, runCompactNow, resumeLatest, providerId],
  );

  const handleSubmit = useCallback(
    (raw) => {
      const text = String(raw || "").trim();
      if (!text) return;

      inputHistoryRef.current.unshift(text);
      if (inputHistoryRef.current.length > 100) inputHistoryRef.current.pop();
      histIdxRef.current = -1;
      setDraft("");
      setInputEpoch((n) => n + 1);

      // Commands run immediately, even while a task is in flight.
      if (text.startsWith("/")) {
        const parsed = parseCommand(text);
        if (!parsed || parsed.unknown) {
          pushText("error", `Unknown command: /${parsed?.unknown || ""}. Try /help`);
          return;
        }
        push({ kind: "user", text });
        applyAction(parsed.command.run(parsed.args));
        return;
      }

      // While busy, the message is queued.
      if (busyRef.current) {
        queueRef.current.push(text);
        setQueued([...queueRef.current]);
        push({ kind: "user", text });
        return;
      }

      push({ kind: "user", text });
      runTurn(text);
    },
    [push, pushText, applyAction, runTurn],
  );

  /* --- Global keys ---------------------------------------------- */
  const overlayOpen = Boolean(overlay) || Boolean(askRequest);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        if (busyRef.current && abortRef.current) {
          abortRef.current.abort();
          return;
        }
        void shutdown();
        return;
      }
      if (key.escape && busyRef.current && abortRef.current) {
        abortRef.current.abort();
      }
    },
    { isActive: !overlayOpen },
  );

  /* --- Initial prompt ------------------------------------------------ */
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !initialPrompt) return;
    started.current = true;
    push({ kind: "user", text: initialPrompt });
    runTurn(initialPrompt);
  }, [initialPrompt, push, runTurn]);

  /* --- Overlays ------------------------------------------------------ */
  const closeOverlay = useCallback(() => setOverlay(null), []);

  useInput(
    (input, key) => {
      if (key.escape) closeOverlay();
    },
    {
      isActive:
        // Informational overlays close on esc. Selection overlays handle esc
        // themselves inside SelectList.
        Boolean(overlay) &&
        ["help", "tools", "session", "cwd", "skills", "config"].includes(overlay),
    },
  );

  useEffect(() => {
    if (overlay !== "sessions") return;
    let alive = true;
    setSessionList("loading");
    listSessions({ cwd: workDir, limit: 20 }).then((list) => {
      if (alive) setSessionList(list);
    });
    return () => {
      alive = false;
    };
  }, [overlay, workDir]);

  const renderOverlay = () => {
    switch (overlay) {
      case "help":
        return h(HelpOverlay, { commands: SLASH_COMMANDS, theme, onCancel: closeOverlay });

      case "providers":
        return h(SelectOverlay, {
          title: `Select provider (${catalog.length})`,
          theme,
          footer: "up/down move · enter select · esc close",
          items: [
            ...catalog.map((p) => {
              const ready = isProviderReady(p.id, catalog, storedConfig);
              const source = keySource(p.id, catalog, storedConfig);
              return {
                label: p.label,
                value: p.id,
                hint: !ready
                  ? `needs a key — enter to set it`
                  : p.id === providerId
                    ? `current${source && source !== "not needed" ? ` · ${source}` : ""}`
                    : p.hint,
              };
            }),
            { label: "+ Add a custom provider", value: "__add_provider__", hint: "any OpenAI-compatible endpoint" },
          ],
          onSubmit: (item) => {
            if (item.value === "__add_provider__") {
              setOverlay("addProvider");
              return;
            }
            // Selecting a provider with no key jumps straight to entering
            // one, instead of switching to something that cannot run.
            if (!isProviderReady(item.value, catalog, storedConfig)) {
              setPendingKeyProvider(item.value);
              setOverlay("setkey");
              return;
            }
            setProviderId(item.value);
            setModel(getDefaultModel(item.value, catalog));
            pushText("system", `Provider: ${item.label}`);
            closeOverlay();
          },
          onCancel: closeOverlay,
        });

      case "setkey": {
        const targetId = pendingKeyProvider || providerId;
        const info = getProviderInfo(targetId, catalog);
        return h(FormOverlay, {
          title: `API key for ${info?.label || targetId}`,
          fields: [
            {
              ...API_KEY_FIELDS[0],
              hint: info?.envKey
                ? `saved to ~/.soluna/config.json · or export ${info.envKey} instead`
                : API_KEY_FIELDS[0].hint,
            },
          ],
          theme,
          onCancel: () => {
            setPendingKeyProvider(null);
            setOverlay("providers");
          },
          onSubmit: async (values) => {
            const key = values.apiKey?.trim();
            await saveApiKey(targetId, key || null);
            if (!key && targetId === "openrouter") await saveApiKeySet("openrouter", []);
            const config = await refreshCatalog();
            setPendingKeyProvider(null);
            closeOverlay();

            if (!key) {
              pushText("system", `Removed the saved key for ${info?.label || targetId}.`);
              return;
            }

            // Switch to it now that it can actually run.
            setProviderId(targetId);
            setModel(getDefaultModel(targetId, buildCatalog(config)));
            pushText("system", `Saved the API key for ${info?.label || targetId}. Now using it.`);
          },
        });
      }

      case "openrouterKeys": {
        const keys = storedConfig.apiKeyPools?.openrouter || [];
        const primary = storedConfig.apiKeys?.openrouter;
        const allKeys = [...new Set([primary, ...keys].filter(Boolean))];
        return h(SelectOverlay, {
          title: `OpenRouter keys (${allKeys.length})`,
          theme,
          footer: "enter: acción · esc: cerrar · keys stored locally",
          items: [
            { label: "+ Agregar clave", value: "__add__", hint: "rotación automática en errores 402/429" },
            ...allKeys.map((key, index) => ({
              label: `Clave ${index + 1} · ••••${key.slice(-4)}`,
              value: `__remove_${index}__`,
              hint: "seleccionar para quitar",
            })),
          ],
          onSubmit: async (item) => {
            if (item.value === "__add__") { setOverlay("addOpenRouterKey"); return; }
            const index = Number(item.value.match(/^__remove_(\d+)__$/)?.[1]);
            if (Number.isInteger(index)) {
              const config = await loadConfig();
              const current = [...new Set([
                config.apiKeys?.openrouter,
                ...(config.apiKeyPools?.openrouter || []),
              ].filter(Boolean))];
              const next = current.filter((_, i) => i !== index);
              await saveApiKeySet("openrouter", next);
              const saved = await refreshCatalog();
              const savedCount = [saved.apiKeys?.openrouter, ...(saved.apiKeyPools?.openrouter || [])].filter(Boolean).length;
              if (savedCount !== next.length) throw new Error(`Only ${savedCount} of ${next.length} keys were saved`);
              pushText("system", `Clave OpenRouter eliminada. Quedan ${next.length}.`);
            }
          },
          onCancel: closeOverlay,
        });
      }

      case "addOpenRouterKey":
        return h(FormOverlay, {
          title: "Agregar clave de OpenRouter",
          fields: OPENROUTER_KEY_FIELDS,
          theme,
          onCancel: () => setOverlay("openrouterKeys"),
          onSubmit: async ({ apiKey }) => {
            const config = await loadConfig();
            const existing = [...new Set([
              config.apiKeys?.openrouter,
              ...(config.apiKeyPools?.openrouter || []),
            ].filter(Boolean))];
            if (!existing.includes(apiKey)) existing.push(apiKey);
            await saveApiKeySet("openrouter", existing);
            const saved = await refreshCatalog();
            const savedCount = [saved.apiKeys?.openrouter, ...(saved.apiKeyPools?.openrouter || [])].filter(Boolean).length;
            if (savedCount !== existing.length) throw new Error(`Only ${savedCount} of ${existing.length} keys were saved`);
            pushText("system", `Clave guardada y verificada en ${CONFIG_PATH}. OpenRouter tiene ${savedCount} clave(s) para failover.`);
            setOverlay("openrouterKeys");
          },
        });

      case "addProvider":
        return h(FormOverlay, {
          title: "Add a custom provider",
          fields: PROVIDER_FIELDS,
          theme,
          onCancel: () => setOverlay("providers"),
          onSubmit: async (values) => {
            await saveCustomProvider(values.id, {
              label: values.label,
              baseUrl: values.baseUrl,
              apiKeyEnv: values.apiKeyEnv || null,
              models: [{ id: values.model, label: values.model }],
            });
            if (values.apiKey) await saveApiKey(values.id, values.apiKey);

            await refreshCatalog();
            setProviderId(values.id);
            setModel(values.model);
            closeOverlay();
            pushText(
              "system",
              `Added provider "${values.label}" (${values.id}). Saved to ${CONFIG_PATH}`,
            );
            if (!values.apiKey && values.apiKeyEnv && !process.env[values.apiKeyEnv]) {
              pushText(
                "system",
                `No key yet — export ${values.apiKeyEnv} or run /setkey ${values.id}.`,
              );
            }
          },
        });

      case "models": {
        const info = getProviderInfo(providerId, catalog);

        const curated = info?.models || [];
        let source = curated;
        let note = null;
        if (Array.isArray(dynamicModels)) {
          // Keep the curated entries visible even if OpenRouter's live catalog
          // omits a popular id or returns an incomplete page.
          const byId = new Map(curated.map((entry) => [entry.id, entry]));
          for (const entry of dynamicModels) byId.set(entry.id, { ...byId.get(entry.id), ...entry });
          source = [...byId.values()];
        } else if (dynamicModels === "loading") {
          note = "Loading models from the server…";
        } else if (dynamicModels?.error) {
          note = `Live catalog unavailable: ${dynamicModels.error}`;
        }

        if (note && source.length === 0) {
          return h(InfoOverlay, {
            title: `Models · ${info?.label || providerId}`,
            theme,
            rows: [{ label: "status", value: note }],
          });
        }

        return h(SelectOverlay, {
          title: `Models · ${info?.label || providerId}${Array.isArray(dynamicModels) ? ` (${dynamicModels.length} live)` : note ? " (cached)" : ""}`,
          footer: note || "↑/↓ move · enter select · esc close",
          theme,
          items: [
            ...source.map((m) => ({
              label: m.label,
              value: m.id,
              hint:
                m.id === model
                  ? "current"
                  : m.hint || (m.context ? `${Math.round(m.context / 1000)}k` : ""),
            })),
            { label: "+ Add a custom model", value: "__add_model__", hint: "any model id" },
          ],
          onSubmit: (item) => {
            if (item.value === "__add_model__") {
              setOverlay("addModel");
              return;
            }
            setModel(item.value);
            pushText("system", `Model: ${item.label}`);
            closeOverlay();
          },
          onCancel: closeOverlay,
        });
      }

      case "addModel":
        return h(FormOverlay, {
          title: `Add a model to ${getProviderInfo(providerId, catalog)?.label || providerId}`,
          fields: MODEL_FIELDS,
          theme,
          onCancel: () => setOverlay("models"),
          onSubmit: async (values) => {
            await addCustomModel(providerId, {
              id: values.id,
              label: values.label || values.id,
            });
            await refreshCatalog();
            setModel(values.id);
            closeOverlay();
            pushText("system", `Added model "${values.id}" to ${providerId}`);
          },
        });

      case "theme":
        return h(SelectOverlay, {
          title: "Theme",
          theme,
          items: THEME_NAMES.map((n) => ({
            label: THEMES[n].label,
            value: n,
            hint: n === themeName ? "current" : "",
          })),
          onSubmit: (item) => {
            setThemeName(item.value);
            closeOverlay();
          },
          onCancel: closeOverlay,
        });

      case "tools":
        return h(InfoOverlay, {
          title: "Tools",
          theme,
          rows: tools.map((t) => ({ label: t.name, value: t.description.slice(0, 56) })),
        });

      case "session":
        return h(InfoOverlay, {
          title: "Session",
          theme,
          rows: [
            { label: "provider", value: providerId },
            { label: "model", value: model || "default" },
            { label: "cwd", value: workDir },
            { label: "context", value: `${formatTokens(contextUsed)} / ${formatTokens(getContextLimit(model))}` },
            { label: "input tokens", value: formatTokens(usage.input) },
            { label: "output tokens", value: formatTokens(usage.output) },
            { label: "turns", value: usage.turns },
            { label: "tool calls", value: usage.toolCalls },
            { label: "messages", value: messagesRef.current.length },
            { label: "theme", value: themeName },
          ],
        });

      case "sessions": {
        if (sessionList === "loading" || sessionList === null) {
          return h(InfoOverlay, { title: "Sessions", theme, rows: [{ label: "status", value: "Loading…" }] });
        }
        if (sessionList.length === 0) {
          return h(InfoOverlay, {
            title: "Sessions",
            theme,
            rows: [{ label: "status", value: "No saved sessions for this directory yet." }],
          });
        }
        return h(SelectOverlay, {
          title: `Sessions · ${workDir}`,
          theme,
          items: sessionList.map((s) => ({
            label: s.title,
            value: s.id,
            hint: `${s.messageCount} msgs · ${timeAgo(s.updatedAt)}`,
          })),
          onSubmit: async (item) => {
            closeOverlay();
            const data = await loadSession(item.value);
            if (data) applySession(data);
            else pushText("error", "Could not load that session.");
          },
          onCancel: closeOverlay,
        });
      }

      case "skills":
        return skills.length === 0
          ? h(InfoOverlay, {
              title: "Skills",
              theme,
              rows: [
                { label: "status", value: "No skills installed." },
                { label: "user dir", value: "~/.soluna/skills/<name>/SKILL.md" },
                { label: "project dir", value: ".soluna/skills/<name>/SKILL.md" },
              ],
            })
          : h(InfoOverlay, {
              title: `Skills (${skills.length})`,
              theme,
              rows: skills.map((s) => ({
                label: s.name,
                value: `${s.description.slice(0, 48)} [${s.source}]`,
              })),
            });

      case "mcp": {
        const names = Object.keys(mcpServers);
        const statusOf = (name) => {
          const s = mcpStatus.find((x) => x.name === name);
          if (!s) return "configured (restart to load)";
          return s.phase === "ready" ? `${s.count} tools loaded` : s.error || s.phase;
        };
        return h(SelectOverlay, {
          title: `MCP servers (${names.length})`,
          theme,
          footer: "enter to remove · esc close",
          items: [
            ...names.map((n) => ({ label: n, value: n, hint: statusOf(n) })),
            { label: "+ Add an MCP server", value: "__add_mcp__", hint: "stdio JSON-RPC" },
          ],
          onSubmit: async (item) => {
            if (item.value === "__add_mcp__") {
              setOverlay("addMcp");
              return;
            }
            await removeMCPServer(item.value);
            await refreshCatalog();
            closeOverlay();
            pushText("system", `Removed MCP server "${item.value}". Restart Soluna to apply.`);
          },
          onCancel: closeOverlay,
        });
      }

      case "addMcp":
        return h(FormOverlay, {
          title: "Add an MCP server",
          fields: MCP_FIELDS,
          theme,
          onCancel: () => setOverlay("mcp"),
          onSubmit: async (values) => {
            await saveMCPServer(values.name, {
              command: values.command,
              args: values.args ? values.args.split(/\s+/).filter(Boolean) : [],
              env: {},
            });
            await refreshCatalog();
            closeOverlay();
            pushText(
              "system",
              `Added MCP server "${values.name}". Restart Soluna to load its tools.`,
            );
          },
        });

      case "config":
        return h(InfoOverlay, {
          title: "Configuration",
          theme,
          rows: [
            { label: "home", value: SOLUNA_HOME },
            { label: "config", value: CONFIG_PATH },
            { label: "mcp", value: MCP_PATH },
            { label: "skills", value: SKILLS_DIR },
            { label: "providers", value: `${catalog.length} available` },
            { label: "mcp servers", value: `${Object.keys(mcpServers).length} configured` },
            {
              label: "saved keys",
              value: `${Object.keys(storedConfig.apiKeys || {}).length} (use /setkey)`,
            },
            { label: "skills loaded", value: String(skills.length) },
            { label: "theme", value: themeName },
            { label: "auto-compact", value: "on at 80% context" },
          ],
        });

      case "cwd":
        return h(InfoOverlay, {
          title: "Working directory",
          theme,
          rows: [
            { label: "current", value: workDir },
            { label: "change", value: "/cwd <path>" },
          ],
        });

      default:
        return null;
    }
  };

  const suggestions =
    draft.startsWith("/") && !draft.includes(" ") ? matchCommands(draft) : [];

  /* --- Render -------------------------------------------------------- */
  return h(
    Box,
    { flexDirection: "column" },

    // Transcript ya finalizado: Ink no lo vuelve a pintar.
    h(Static, { items: history }, (line) =>
      h(
        Box,
        { key: line.id, marginBottom: line.kind === "assistant" ? 1 : 0 },
        h(HistoryLine, { line, theme, width }),
      ),
    ),

    // Assistant text still being generated.
    streamText
      ? h(Box, { marginBottom: 1 }, h(Markdown, { text: streamText, theme, width }))
      : null,

    // Compaction in progress.
    compacting
      ? h(
          Box,
          { marginY: 1 },
          h(Text, { color: theme.warn }, "⟳ "),
          h(Text, { color: theme.warn }, compacting),
        )
      : null,

    // Tools currently running.
    ...activeTools.map((entry) =>
      h(ToolActivity, { key: entry.id, entry, theme, width, live: true }),
    ),

    askRequest
      ? h(AskPanel, {
          request: askRequest,
          theme,
          onComplete: finishAsk,
          onCancel: () => finishAsk([]),
        })
      : null,

    overlay ? renderOverlay() : null,

    // Input stays available during a task so messages can be queued.
    !overlayOpen
      ? h(
          Box,
          { flexDirection: "column", marginTop: 1 },
          h(
            Box,
            {
              borderStyle: "round",
              borderColor: busy ? theme.accent : theme.border,
              paddingX: 1,
            },
            h(Text, { color: busy ? theme.warn : theme.accent }, busy ? "⏵ " : "❯ "),
            h(TextInput, {
              value: draft,
              resetToken: inputEpoch,
              theme,
              isActive: true,
              placeholder: busy
                ? "Type to queue a message while the task runs…"
                : "Ask anything · / for commands",
              onChange: setDraft,
              onSubmit: handleSubmit,
              onTab: () => {
                if (suggestions.length > 0) setDraft(`/${suggestions[0].name} `);
              },
              onHistoryPrev: () => {
                const hist = inputHistoryRef.current;
                if (hist.length === 0) return;
                histIdxRef.current = Math.min(histIdxRef.current + 1, hist.length - 1);
                setDraft(hist[histIdxRef.current]);
              },
              onHistoryNext: () => {
                if (histIdxRef.current <= 0) {
                  histIdxRef.current = -1;
                  setDraft("");
                  return;
                }
                histIdxRef.current -= 1;
                setDraft(inputHistoryRef.current[histIdxRef.current]);
              },
            }),
          ),

          suggestions.length > 0
            ? h(
                Box,
                { flexDirection: "column" },
                ...suggestions.slice(0, 16).map((c, i) =>
                  h(
                    Box,
                    { key: c.name },
                    h(
                      Text,
                      { color: i === 0 ? theme.accent : theme.dim, bold: i === 0 },
                      `${i === 0 ? " ›" : "  "} /${c.name}`.padEnd(16),
                    ),
                    h(Text, { color: theme.muted }, c.description),
                  ),
                ),
                suggestions.length > 16
                  ? h(Text, { color: theme.muted }, `  … ${suggestions.length - 16} more`)
                  : null,
                h(Text, { color: theme.muted }, "  tab complete · enter run"),
              )
            : h(StatusBar, {
                theme,
                provider: providerId,
                model,
                cwd: workDir,
                skills: skills.length,
                mcp: mcpStatus.filter((s) => s.phase === "ready").length,
                contextUsed,
                contextLimit: getContextLimit(model),
                usage,
                elapsed: busy ? elapsed : 0,
                queued: queued.length,
                width,
              }),
        )
      : null,
  );
}

export function Banner({ theme, providerId, model, cwd }) {
  return h(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    h(Text, { color: theme.accent, bold: true }, `${APP_NAME} v${APP_VERSION}`),
    h(Text, { color: theme.muted }, `${providerId}/${model || "default"} · ${cwd}`),
  );
}
