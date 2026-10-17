const $ = (selector) => document.querySelector(selector);
const api = window.solunaFetch || ((path, options) => fetch(path, options));
const providerSelect = $("#provider-select");
const modelSelect = $("#model-select");
const settingsProvider = $("#settings-provider");
let catalog = [];
let configLoaded = false;
const providerModels = new Map();
let modelsRequestId = 0;

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
    select.appendChild(option(model.label || model.id, model.id));
  }
  if (current) {
    if (!models.some((item) => item.id === current)) select.appendChild(option(current, current));
    select.value = current;
  }
}

function availableModels(provider) {
  return providerModels.get(provider) || catalog.find((item) => item.id === provider)?.models || [];
}

function renderModelSearch(provider) {
  for (const id of ["#models-free", "#models-tools"]) {
    $(id).disabled = provider !== "openrouter";
    if (provider !== "openrouter") $(id).checked = false;
  }
  $("#models-refresh").disabled = provider !== "openrouter";
  const models = availableModels(provider);
  const term = $("#model-search").value.trim().toLocaleLowerCase();
  const matches = term
    ? models.filter((item) => `${item.label} ${item.id}`.toLocaleLowerCase().includes(term))
    : models;
  const filtered = matches.filter((item) => (!$("#models-free").checked || item.free)
    && (!$("#models-tools").checked || item.tools));
  const list = $("#settings-model");
  list.replaceChildren(...filtered.map((item) => option(`${item.free ? "Gratis · " : ""}${item.label} · ${item.id}`, item.id)));
  if (filtered.some((item) => item.id === modelSelect.value)) list.value = modelSelect.value;
  $("#model-count").textContent = `${filtered.length} de ${models.length} modelos`;
}

async function loadProviderModels(provider, current, refresh = false) {
  const requestId = ++modelsRequestId;
  if (provider !== "openrouter") {
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
    showNotice(`No se pudo cargar el catálogo completo de OpenRouter: ${error.message}`);
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
    catalog = data.providers || [];
    fillProviders(providerSelect, data.current?.provider, true);
    fillProviders(settingsProvider, data.current?.provider);
    fillModels(modelSelect, data.current?.provider, data.current?.model);
    renderModelSearch(data.current?.provider);
    if (data.current?.provider === "openrouter") loadProviderModels("openrouter", data.current?.model);
    configLoaded = true;
  } catch (error) {
    showNotice(`No se pudo cargar la lista de modelos: ${error.message}`);
  }
}

async function loadSessions() {
  try {
    const sessions = await request("/api/sessions");
    const list = $("#sessions-list");
    $("#session-count").textContent = String(sessions.length);
    if (!sessions.length) {
      list.innerHTML = '<div class="sessions-empty">Todavía no hay sesiones</div>';
      return;
    }
    list.replaceChildren();
    for (const session of sessions) {
      const button = document.createElement("button");
      button.className = "session-item";
      button.type = "button";
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
        try {
          await request("/api/sessions/load", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: session.id }) });
          document.querySelectorAll(".session-item").forEach((item) => item.classList.remove("active"));
          button.classList.add("active");
          $(".sidebar").classList.remove("open");
          $("#topbar-title").textContent = session.title || "Conversación";
          await loadConfig();
        } catch (error) { showNotice(error.message); }
      });
      list.appendChild(button);
    }
  } catch (error) { showNotice(`No se pudieron cargar las conversaciones: ${error.message}`); }
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
}

providerSelect.addEventListener("change", () => selectProvider(providerSelect.value));
settingsProvider.addEventListener("change", () => {
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
$("#settings-close").addEventListener("click", () => $("#settings-overlay").classList.remove("show"));
$("#settings-overlay").addEventListener("click", (event) => {
  if (event.target === $("#settings-overlay")) $("#settings-overlay").classList.remove("show");
});
$("#settings-save-key").addEventListener("click", async () => {
  const provider = settingsProvider.value;
  const key = $("#settings-key").value.trim();
  if (!provider || !key) { $("#settings-note").textContent = "Elegí un proveedor y pegá una clave."; return; }
  try {
    await request("/api/save-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, key }) });
    $("#settings-key").value = "";
    $("#settings-note").textContent = "Clave guardada en este espacio.";
    providerModels.delete(provider);
    await loadConfig();
    providerSelect.value = provider;
    await selectProvider(provider);
  } catch (error) { $("#settings-note").textContent = error.message; }
});
$("#btn-new").addEventListener("click", async () => {
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

loadConfig();
loadSessions();
loadWorkspaces();
