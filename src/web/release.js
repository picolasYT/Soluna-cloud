import { createHash } from "node:crypto";

// Update these notes with each user-visible release. Render's commit SHA makes
// every deployed update a new announcement, even when these notes are unchanged.
const notes = {
  title: "Organizá tus conversaciones",
  summary: "Ahora podés eliminar los chats que ya no necesitás desde la barra lateral.",
  changes: [
    "Cada chat tiene un botón para eliminarlo, disponible también desde el celular.",
    "Una confirmación te permite revisar qué conversación vas a borrar.",
    "Si eliminás el chat abierto, Soluna abre uno nuevo. Los archivos del proyecto se conservan.",
  ],
};

export function currentRelease(env = process.env) {
  const build = env.SOLUNA_RELEASE_ID || env.RENDER_GIT_COMMIT;
  const id = createHash("sha256").update(build || JSON.stringify(notes)).digest("hex");
  return { id, ...notes };
}
