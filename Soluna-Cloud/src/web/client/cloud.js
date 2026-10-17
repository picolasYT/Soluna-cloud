const $ = (selector) => document.querySelector(selector);
const api = window.solunaFetch || ((path, options) => fetch(path, options));
const providerSelect = $("#provider-select");
const modelSelect = $("#model-select");
const settingsProvider = $("#settings-provider");
let catalog = [];
let configLoaded = false;

async function request(path, options) {
  const response = await api(path, options);
  if (!response.ok) throw new Error(response.status === 401 ? "Sesión no autorizada. Volvé a iniciar sesión." : `Error ${response.status}`);
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
  const info = catalog.find((item) => item.id === provider);
  select.replaceChildren(option("Elegir modelo", ""));
  for (const model of info?.models || []) {
    select.appendChild(option(model.label || model.id, model.id));
  }
  if (current && [...select.options].some((item) => item.value === current)) select.value = current;
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
    configLoaded = true;
  } catch (error) {
    const label = $("#settings-note");
    if (label) label.textContent = error.message;
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
        } catch (error) { showNotice(error.message); }
      });
      list.appendChild(button);
    }
  } catch {}
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
  } catch {}
}

async function selectProvider(provider) {
  if (!provider) return;
  try {
    await request("/api/set-provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
    const item = catalog.find((entry) => entry.id === provider);
    fillModels(modelSelect, provider, item?.models?.[0]?.id);
    settingsProvider.value = provider;
    $("#model-hint").textContent = item?.models?.[0]?.id || provider;
  } catch (error) { showNotice(error.message); }
}

async function selectModel(model) {
  if (!model) return;
  try {
    await request("/api/set-model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    $("#model-hint").textContent = model;
  } catch (error) { showNotice(error.message); }
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
}

providerSelect.addEventListener("change", () => selectProvider(providerSelect.value));
settingsProvider.addEventListener("change", () => {
  const item = catalog.find((entry) => entry.id === settingsProvider.value);
  if (item?.ready || !item?.requiresKey) {
    providerSelect.value = settingsProvider.value;
    selectProvider(settingsProvider.value);
  } else {
    $("#settings-note").textContent = `Guardá una clave API para activar ${item.label}.`;
  }
});
modelSelect.addEventListener("change", () => selectModel(modelSelect.value));
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
    await loadConfig();
    providerSelect.value = provider;
    await selectProvider(provider);
  } catch (error) { $("#settings-note").textContent = error.message; }
});
$("#btn-new").addEventListener("click", () => {
  $("#topbar-title").textContent = "Nueva tarea";
  document.querySelectorAll(".session-item").forEach((item) => item.classList.remove("active"));
  request("/api/sessions/new", { method: "POST" }).catch((error) => showNotice(error.message));
  loadSessions();
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
