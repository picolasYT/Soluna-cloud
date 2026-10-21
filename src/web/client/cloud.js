const $ = (selector) => document.querySelector(selector);
const api = window.solunaFetch || ((path, options) => fetch(path, options));
const providerSelect = $("#provider-select");
const modelSelect = $("#model-select");
const settingsProvider = $("#settings-provider");
let catalog = [];
let configLoaded = false;
const providerModels = new Map();
const liveModelProviders = new Set(["openrouter", "sun"]);
let modelsRequestId = 0;
let agentBusy = false;
let deletingSession = false;
let currentSessionId = null;
let sessionsRequestId = 0;
let keysRequestId = 0;

async function request(path, options) {
  const response = await api(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const reason = typeof body?.error === "string" ? body.error : "";
    throw new Error(response.status === 401
      ? "Sesión no autorizada. Volvé a iniciar sesión."
      : reason || `Error ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

function option(label, value, disabled = false) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  item.disabled = disabled;
  return item;
}

function fillModels(select, provider, current) {
  const models = availableModels(provider);
  select.replaceChildren(option(provider ? "Elegir modelo" : "Elegí proveedor", ""));
  for (const model of models) {
    select.appendChild(option(modelLabel(model, provider), model.id, model.available === false));
  }
  if (current) {
    if (!models.some((item) => item.id === current)) select.appendChild(option(current, current));
    select.value = current;
  }
}

function modelLabel(model, provider) {
  const state = model.available === false ? " · no disponible"
    : provider === "sun" && model.tools === false ? " · solo chat" : "";
  return `${model.label || model.id}${state}`;
}

function availableModels(provider) {
  return providerModels.get(provider) || catalog.find((item) => item.id === provider)?.models || [];
}

function renderModelSearch(provider) {
  $("#models-free").disabled = provider !== "openrouter";
  if (provider !== "openrouter") $("#models-free").checked = false;
  $("#models-tools").disabled = !liveModelProviders.has(provider);
  if (!liveModelProviders.has(provider)) $("#models-tools").checked = false;
  $("#models-refresh").disabled = !liveModelProviders.has(provider);
  const models = availableModels(provider);
  const term = $("#model-search").value.trim().toLocaleLowerCase();
  const matches = term
    ? models.filter((item) => `${item.label} ${item.id}`.toLocaleLowerCase().includes(term))
    : models;
  const filtered = matches.filter((item) => (!$("#models-free").checked || item.free)
    && (!$("#models-tools").checked || item.tools));
  const list = $("#settings-model");
  list.replaceChildren(...filtered.map((item) => option(`${item.free ? "Gratis · " : ""}${modelLabel(item, provider)} · ${item.id}`, item.id, item.available === false)));
  if (filtered.some((item) => item.id === modelSelect.value)) list.value = modelSelect.value;
  $("#model-count").textContent = `${filtered.length} de ${models.length} modelos`;
  const capabilityNote = $("#model-capability-note");
  const chosen = models.find((item) => item.id === modelSelect.value);
  if (capabilityNote) {
    capabilityNote.hidden = provider !== "sun";
    capabilityNote.textContent = chosen?.tools === false
      ? "Este modelo de Sun solo conversa. Para crear o editar archivos, elegí uno con herramientas."
      : "El filtro Con herramientas muestra los modelos que Sun confirma para crear y editar archivos. El catálogo no informa precios; no se marcan como gratuitos.";
  }
}

async function loadProviderModels(provider, current, refresh = false) {
  const requestId = ++modelsRequestId;
  if (!liveModelProviders.has(provider)) {
    renderModelSearch(provider);
    return;
  }
  $("#model-count").textContent = "Cargando catálogo…";
  try {
    const result = await request(`/api/models?provider=${encodeURIComponent(provider)}${refresh ? "&refresh=1" : ""}`);
    if (requestId !== modelsRequestId || providerSelect.value !== provider) return;
    providerModels.set(provider, result.models);
    fillModels(modelSelect, provider, current || modelSelect.value);
    renderModelSearch(provider);
  } catch (error) {
    if (requestId !== modelsRequestId || providerSelect.value !== provider) return;
    renderModelSearch(provider);
    $("#model-count").textContent += " · lista parcial";
    const label = catalog.find((item) => item.id === provider)?.label || provider;
    showNotice(`No se pudo cargar el catálogo completo de ${label}: ${error.message}`);
  }
}

function fillProviders(select, selected, disableUnready = false) {
  select.replaceChildren(option("Elegir proveedor", ""));
  for (const item of catalog) {
    const suffix = item.ready ? "" : " · falta API key";
    select.appendChild(option(`${item.label}${suffix}`, item.id, disableUnready && item.requiresKey && !item.ready));
  }
  if (selected) select.value = selected;
}

async function loadConfig() {
  try {
    const data = await request("/api/config");
    $("#settings-auto-approve").checked = data.autoApprove === true;
    $(".auto-approve-setting").hidden = data.restrictedUser === true;
    catalog = data.providers || [];
    fillProviders(providerSelect, data.current?.provider, true);
    fillProviders(settingsProvider, data.current?.provider);
    loadProviderKeys(settingsProvider.value);
    fillModels(modelSelect, data.current?.provider, data.current?.model);
    renderModelSearch(data.current?.provider);
    if (liveModelProviders.has(data.current?.provider)) loadProviderModels(data.current.provider, data.current?.model);
    configLoaded = true;
  } catch (error) {
    showNotice(`No se pudo cargar la lista de modelos: ${error.message}`);
  }
}

async function loadSessions() {
  const requestId = ++sessionsRequestId;
  try {
    const sessions = await request("/api/sessions");
    if (requestId !== sessionsRequestId) return;
    const list = $("#sessions-list");
    $("#session-count").textContent = String(sessions.length);
    if (!sessions.length) {
      list.innerHTML = '<div class="sessions-empty">Todavía no hay sesiones</div>';
      return;
    }
    list.replaceChildren();
    for (const session of sessions) {
      const button = document.createElement("button");
      const row = document.createElement("div");
      row.className = "session-row";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "session-delete";
      remove.title = "Eliminar chat";
      remove.setAttribute("aria-label", `Eliminar chat: ${session.title || "Nueva conversación"}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
      remove.addEventListener("click", () => deleteChat(session));
      button.className = "session-item";
      button.dataset.id = session.id;
      button.classList.toggle("active", session.id === currentSessionId);
      button.type = "button";
      button.disabled = agentBusy || deletingSession;
      remove.disabled = agentBusy || deletingSession;
      button.title = session.title || "Conversación";
      const title = document.createElement("span");
      title.className = "session-title";
      title.textContent = session.title || "Nueva conversación";
      const stamp = document.createElement("span");
      stamp.className = "session-date";
      stamp.textContent = session.updatedAt ? new Date(session.updatedAt).toLocaleDateString("es-AR", { day: "2-digit", month: "short" }) : "";
      const icon = document.createElement("span");
      icon.className = "session-icon";
      icon.textContent = "◌";
      button.append(icon, title, stamp);
      button.addEventListener("click", async () => {
        if (agentBusy || deletingSession) return;
        try {
          await request("/api/sessions/load", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: session.id }) });
          document.querySelectorAll(".session-item").forEach((item) => item.classList.remove("active"));
          button.classList.add("active");
          $(".sidebar").classList.remove("open");
          $("#topbar-title").textContent = session.title || "Conversación";
          await loadConfig();
        } catch (error) { showNotice(error.message); }
      });
      row.append(button, remove);
      list.appendChild(row);
    }
  } catch (error) {
    if (requestId === sessionsRequestId) showNotice(`No se pudieron cargar las conversaciones: ${error.message}`);
  }
}

function updateSessionControls() {
  const disabled = agentBusy || deletingSession;
  $("#btn-new").disabled = disabled;
  document.querySelectorAll(".session-item,.session-delete").forEach((button) => { button.disabled = disabled; });
}

async function deleteChat(session) {
  if (agentBusy || deletingSession) return;
  const title = session.title || "Nueva conversación";
  if (!window.confirm(`¿Eliminar el chat "${title}"?\n\nSe borrará la conversación del historial. Los archivos del proyecto se conservan. Esta acción no se puede deshacer.`)) return;
  deletingSession = true;
  updateSessionControls();
  try {
    // Read the server's active id rather than relying on a possibly stale tab.
    const current = await request("/api/state");
    if (current.busy || current.queued) throw new Error("Esperá a que termine la tarea antes de eliminar chats.");
    if (current.sessionId === session.id) {
      // The new-session endpoint drains pending saves before switching chats.
      const next = await request("/api/sessions/new", { method: "POST" });
      currentSessionId = next.id;
      $("#topbar-title").textContent = "Nueva tarea";
    }
    const result = await request("/api/sessions/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id }),
    });
    if (!result.ok) throw new Error("No se pudo eliminar el chat. Volvé a intentar.");
    document.querySelectorAll(".session-item").forEach((button) => {
      if (button.dataset.id === session.id) button.closest(".session-row")?.remove();
    });
    await loadSessions();
  } catch (error) { showNotice(error.message); }
  finally { deletingSession = false; updateSessionControls(); }
}

async function loadWorkspaces() {
  try {
    const data = await request("/api/workspaces");
    const list = $("#workspace-list");
    list.replaceChildren();
    const active = document.createElement("div");
    active.className = "workspace-current";
    active.textContent = `Actual: ${data.current || "workspace"}`;
    list.appendChild(active);
    for (const workspace of data.workspaces || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `workspace-option${workspace.active ? " active" : ""}`;
      const icon = document.createElement("span");
      icon.className = "workspace-option-icon";
      icon.textContent = "◈";
      const copy = document.createElement("span");
      copy.className = "workspace-option-copy";
      const name = document.createElement("strong");
      name.textContent = workspace.name;
      const path = document.createElement("small");
      path.textContent = workspace.path;
      copy.append(name, path);
      button.append(icon, copy);
      button.addEventListener("click", async () => {
        try {
          await request("/api/workspaces/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: workspace.id }) });
          $("#workspace-overlay").classList.remove("show");
          $("#topbar-title").textContent = workspace.name;
          await loadSessions();
        } catch (error) { $("#workspace-note").textContent = error.message; }
      });
      list.appendChild(button);
    }
  } catch (error) { $("#workspace-note").textContent = error.message; }
}

async function selectProvider(provider) {
  if (!provider) return;
  try {
    await request("/api/set-provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
    const item = catalog.find((entry) => entry.id === provider);
    fillModels(modelSelect, provider, item?.models?.[0]?.id);
    settingsProvider.value = provider;
    $("#model-hint").textContent = item?.models?.[0]?.id || provider;
    await loadProviderModels(provider, modelSelect.value);
  } catch (error) { showNotice(error.message); await loadConfig(); }
}

async function selectModel(model) {
  if (!model) return;
  try {
    await request("/api/set-model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    $("#model-hint").textContent = model;
    modelSelect.value = model;
    $("#settings-model").value = model;
    renderModelSearch(settingsProvider.value);
    if (providerSelect.value === "sun" && availableModels("sun").find((item) => item.id === model)?.tools === false) {
      showNotice("Este modelo de Sun solo conversa. Elegí uno con herramientas para crear o editar archivos.");
    }
  } catch (error) { showNotice(error.message); await loadConfig(); }
}

function showNotice(message) {
  const note = $("#settings-note");
  if (note) note.textContent = message;
  const line = document.createElement("div");
  line.className = "line-system";
  line.textContent = message;
  $("#transcript").appendChild(line);
}

function openSettings() {
  $("#settings-overlay").classList.add("show");
  if (!configLoaded) loadConfig();
  else renderModelSearch(settingsProvider.value);
  loadProviderKeys(settingsProvider.value);
}

async function loadProviderKeys(provider) {
  const requestId = ++keysRequestId;
  const list = $("#provider-keys");
  $("#settings-key").placeholder = provider === "sun" ? "sun_live_…" : "Pegá una nueva clave API";
  list.replaceChildren();
  $("#provider-keys-count").textContent = provider ? "Cargando claves…" : "Elegí un proveedor";
  if (!provider) return;
  try {
    const data = await request(`/api/keys?provider=${encodeURIComponent(provider)}`);
    if (requestId !== keysRequestId || settingsProvider.value !== provider) return;
    $("#provider-keys-count").textContent = `${data.count} ${data.count === 1 ? "clave disponible" : "claves disponibles"}${data.environmentKey ? " · incluye clave del servidor" : ""}`;
    if (!data.keys.length) {
      const empty = document.createElement("small");
      empty.textContent = "Todavía no hay claves guardadas para este proveedor.";
      list.appendChild(empty);
    }
    for (const key of data.keys) {
      const row = document.createElement("div");
      row.className = "provider-key-row";
      const label = document.createElement("span");
      label.textContent = `${key.label} · ${key.masked}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-ghost";
      remove.textContent = "Quitar";
      remove.setAttribute("aria-label", `Quitar ${key.label}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await request("/api/keys", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, id: key.id }) });
          const selected = settingsProvider.value;
          await loadConfig();
          settingsProvider.value = selected;
          await loadProviderKeys(selected);
          $("#settings-note").textContent = "Clave quitada. Los cambios se usan en la próxima tarea o mensaje.";
        } catch (error) {
          $("#settings-note").textContent = error.message;
          remove.disabled = false;
        }
      });
      row.append(label, remove);
      list.appendChild(row);
    }
    $("#provider-keys-note").textContent = provider === "openrouter"
      ? "Soluna prueba otra clave si una falla o alcanza su límite. Varias claves de la misma cuenta comparten la cuota de OpenRouter."
      : "Soluna prueba otra clave si una es inválida, se queda sin saldo o alcanza su límite. Las claves del servidor se administran desde sus variables de entorno.";
  } catch (error) {
    if (requestId === keysRequestId) $("#provider-keys-count").textContent = error.message;
  }
}

providerSelect.addEventListener("change", () => selectProvider(providerSelect.value));
settingsProvider.addEventListener("change", () => {
  $("#settings-key").value = "";
  loadProviderKeys(settingsProvider.value);
  const item = catalog.find((entry) => entry.id === settingsProvider.value);
  if (item?.ready || !item?.requiresKey) {
    providerSelect.value = settingsProvider.value;
    selectProvider(settingsProvider.value);
  } else {
    $("#settings-note").textContent = `Guardá una clave API para activar ${item.label}.`;
    renderModelSearch(settingsProvider.value);
  }
});
modelSelect.addEventListener("change", () => selectModel(modelSelect.value));
$("#model-search").addEventListener("input", () => renderModelSearch(settingsProvider.value));
$("#settings-model").addEventListener("change", () => selectModel($("#settings-model").value));
$("#settings-open").addEventListener("click", openSettings);
$("#settings-auto-approve").addEventListener("change", async (event) => {
  const toggle = event.target;
  const enabled = toggle.checked;
  toggle.disabled = true;
  try {
    await request("/api/settings/auto-approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    $("#auto-approve-note").textContent = enabled ? "Activo: Soluna autoriza los comandos automáticamente." : "Desactivado: los comandos que requieren permiso te preguntarán antes de ejecutarse.";
  } catch (error) {
    toggle.checked = !enabled;
    $("#auto-approve-note").textContent = error.message;
  } finally { toggle.disabled = false; }
});
$("#settings-close").addEventListener("click", () => $("#settings-overlay").classList.remove("show"));
$("#settings-overlay").addEventListener("click", (event) => {
  if (event.target === $("#settings-overlay")) $("#settings-overlay").classList.remove("show");
});
$("#settings-save-key").addEventListener("click", async () => {
  const provider = settingsProvider.value;
  const key = $("#settings-key").value.trim();
  if (!provider || !key) { $("#settings-note").textContent = "Elegí un proveedor y pegá una clave."; return; }
  const button = $("#settings-save-key");
  button.disabled = true;
  try {
    await request("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, keys: [key] }) });
    $("#settings-key").value = "";
    $("#settings-note").textContent = "Clave agregada. Las anteriores siguen guardadas.";
    providerModels.delete(provider);
    await loadConfig();
    if (providerSelect.value !== provider) await selectProvider(provider);
    else settingsProvider.value = provider;
    await loadProviderKeys(provider);
  } catch (error) { $("#settings-note").textContent = error.message; }
  finally { button.disabled = false; }
});
$("#btn-new").addEventListener("click", async () => {
  if (agentBusy || deletingSession) return;
  try {
    await request("/api/sessions/new", { method: "POST" });
    $("#topbar-title").textContent = "Nueva tarea";
    document.querySelectorAll(".session-item").forEach((item) => item.classList.remove("active"));
    await loadSessions();
  } catch (error) { showNotice(error.message); }
});
$("#models-free").addEventListener("change", () => renderModelSearch(settingsProvider.value));
$("#models-tools").addEventListener("change", () => renderModelSearch(settingsProvider.value));
$("#models-refresh").addEventListener("click", async () => {
  const button = $("#models-refresh");
  button.disabled = true;
  try { await loadProviderModels(settingsProvider.value, modelSelect.value, true); }
  finally { button.disabled = false; }
});
$("#session-export").addEventListener("click", async () => {
  try {
    const data = await request("/api/sessions/export");
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `soluna-${data.id}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showNotice(error.message); }
});
window.addEventListener("soluna-state", (event) => {
  const state = event.detail;
  const wasBusy = agentBusy;
  agentBusy = Boolean(state.busy || state.queued);
  if (state.sessionId) currentSessionId = state.sessionId;
  updateSessionControls();
  document.querySelectorAll(".session-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.id === currentSessionId);
  });
  if (typeof state.autoApprove === "boolean") $("#settings-auto-approve").checked = state.autoApprove;
  if (wasBusy && !agentBusy) loadSessions();
  if (state.provider && (providerSelect.value !== state.provider || modelSelect.value !== state.model)) {
    providerSelect.value = state.provider;
    settingsProvider.value = state.provider;
    fillModels(modelSelect, state.provider, state.model);
    renderModelSearch(state.provider);
  }
});
$("#sidebar-toggle-mobile").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#composer-send").addEventListener("click", () => setTimeout(loadSessions, 1300));
$("#composer-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) setTimeout(loadSessions, 1300);
});

function openWorkspacePicker() {
  $("#workspace-overlay").classList.add("show");
  $("#workspace-note").textContent = "Los repositorios públicos se guardan en el almacenamiento persistente de esta instancia.";
  loadWorkspaces();
}
$("#workspace-open").addEventListener("click", openWorkspacePicker);
$("#workspace-open-hero").addEventListener("click", openWorkspacePicker);
$("#workspace-close").addEventListener("click", () => $("#workspace-overlay").classList.remove("show"));
$("#workspace-overlay").addEventListener("click", (event) => {
  if (event.target === $("#workspace-overlay")) $("#workspace-overlay").classList.remove("show");
});
$("#workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#workspace-import");
  button.disabled = true;
  button.textContent = "Importando…";
  $("#workspace-note").textContent = "Clonando repositorio. Puede tardar un momento…";
  try {
    const result = await request("/api/workspaces/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: $("#workspace-url").value.trim() }) });
    $("#workspace-url").value = "";
    $("#workspace-overlay").classList.remove("show");
    $("#topbar-title").textContent = result.id.replace(/__/g, "/");
    await loadSessions();
  } catch (error) {
    $("#workspace-note").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Importar";
  }
});

window.addEventListener("soluna-sessions-changed", loadSessions);
loadConfig();
loadSessions();
loadWorkspaces();
