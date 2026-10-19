// Each account gets a separate process: globals, queues and approval bridges
// must not be shared between simultaneous conversations from different users.
const { startWebServer } = await import("./server.js");
let sequence = 0;
const pending = new Map();
const persistKeys = (provider, keys) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error("No se pudo guardar la clave en la base de datos.")); }, 15000);
  pending.set(id, { resolve, reject, timer });
  process.send({ kind: "keys", id, provider, keys });
});
const instance = await startWebServer({
  host: "127.0.0.1", port: 0, cleanWorkspace: true,
  noMcp: true, restrictedUser: process.env.SOLUNA_ACCOUNT_ADMIN !== "1",
  token: process.env.SOLUNA_INTERNAL_TOKEN, persistKeys,
});
const sendBusy = () => process.send?.({ kind: "busy", busy: Boolean(instance.jobs.running || instance.jobs.queuedCount) });
instance.jobs.on("started", sendBusy);
instance.jobs.on("idle", sendBusy);
instance.jobs.on("failed", sendBusy);
// Resume the account's last task after an idle process was recycled.
await fetch(`http://127.0.0.1:${instance.server.address().port}/api/sessions/load`, {
  method: "POST", headers: { Authorization: `Bearer ${process.env.SOLUNA_INTERNAL_TOKEN}`, "Content-Type": "application/json" }, body: "{}",
}).catch(() => {});
process.send({ kind: "ready", port: instance.server.address().port });
process.on("message", async (message) => {
  if (message.kind === "persisted") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(); else request.reject(new Error("No se pudo guardar la clave en PostgreSQL."));
  } else if (message.kind === "stop") {
    await instance.close();
    process.exit(0);
  }
});
process.on("disconnect", () => process.exit(0));
