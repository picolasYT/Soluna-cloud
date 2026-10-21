import { createHash } from "node:crypto";

// Update these notes with each user-visible release. Render's commit SHA makes
// every deployed update a new announcement, even when these notes are unchanged.
const notes = {
  title: "Sun llega a Soluna Cloud",
  summary: "Ya podés conectar tu cuenta de Models of the Sun desde Configuración.",
  changes: [
    "Agregá una o varias claves de Sun y elegí entre los modelos de su catálogo en vivo.",
    "Buscá modelos, actualizá la lista y filtrá los que admiten herramientas para trabajar con archivos.",
    "Los modelos que solo conversan se identifican como solo chat.",
  ],
};

export function currentRelease(env = process.env) {
  const build = env.SOLUNA_RELEASE_ID || env.RENDER_GIT_COMMIT;
  const id = createHash("sha256").update(build || JSON.stringify(notes)).digest("hex");
  return { id, ...notes };
}
