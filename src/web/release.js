import { createHash } from "node:crypto";

// Update these notes with each user-visible release. Render's commit SHA makes
// every deployed update a new announcement, even when these notes are unchanged.
const notes = {
  title: "Un chat más cómodo, novedades al día",
  summary: "Actualizamos Soluna Cloud para que trabajar con tu agente sea más claro.",
  changes: [
    "Las respuestas largas se desplazan dentro del chat, sin tapar el cuadro de escritura.",
    "Mejoramos las listas, los bloques de código y el formato de las respuestas.",
    "Cada actualización tiene un comunicado que aparece una sola vez por cuenta.",
  ],
};

export function currentRelease(env = process.env) {
  const build = env.SOLUNA_RELEASE_ID || env.RENDER_GIT_COMMIT;
  const id = createHash("sha256").update(build || JSON.stringify(notes)).digest("hex");
  return { id, ...notes };
}
