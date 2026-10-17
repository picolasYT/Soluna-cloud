/**
 * Markdown minimo para terminal.
 *
 * Convierte texto en una lista de nodos que la UI pinta con Ink.
 * No es un parser completo: cubre lo que un agente de codigo emite
 * (bloques de codigo, listas, encabezados, negrita, `inline code`).
 */

/**
 * @returns {Array<{type:string, ...}>}
 *   heading  { level, text }
 *   code     { lang, lines }
 *   list     { ordered, marker, spans, indent }
 *   quote    { spans }
 *   rule     {}
 *   para     { spans }
 *   blank    {}
 */
export function parseMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Bloque de codigo cercado.
    const fence = line.match(/^\s*```+\s*(\S*)/);
    if (fence) {
      const lang = fence[1] || "";
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume el cierre (o EOF)
      blocks.push({ type: "code", lang, lines: body });
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // Regla horizontal.
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    // Encabezado.
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2].replace(/\s*#+\s*$/, "").trim(),
      });
      i++;
      continue;
    }

    // Cita.
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: "quote", spans: parseInline(quote[1]) });
      i++;
      continue;
    }

    // Lista sin ordenar.
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({
        type: "list",
        ordered: false,
        marker: "•",
        indent: Math.floor(bullet[1].length / 2),
        spans: parseInline(bullet[2]),
      });
      i++;
      continue;
    }

    // Lista ordenada.
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push({
        type: "list",
        ordered: true,
        marker: `${numbered[2]}.`,
        indent: Math.floor(numbered[1].length / 2),
        spans: parseInline(numbered[3]),
      });
      i++;
      continue;
    }

    blocks.push({ type: "para", spans: parseInline(line) });
    i++;
  }

  // Colapsa lineas en blanco consecutivas y quita las de los extremos.
  const cleaned = [];
  for (const b of blocks) {
    if (b.type === "blank" && cleaned[cleaned.length - 1]?.type === "blank") continue;
    cleaned.push(b);
  }
  while (cleaned[0]?.type === "blank") cleaned.shift();
  while (cleaned[cleaned.length - 1]?.type === "blank") cleaned.pop();

  return cleaned;
}

/**
 * Parsea marcas dentro de una linea.
 * @returns {Array<{text:string, code?:boolean, bold?:boolean, italic?:boolean, strike?:boolean, link?:boolean}>}
 */
export function parseInline(text) {
  const src = String(text ?? "");
  const spans = [];
  let buffer = "";

  const flush = () => {
    if (buffer) {
      spans.push({ text: buffer });
      buffer = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    // `codigo` — tiene prioridad: dentro no se interpreta nada mas.
    const code = rest.match(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
    if (code) {
      flush();
      spans.push({ text: code[2], code: true });
      i += code[0].length;
      continue;
    }

    // **negrita** o __negrita__
    const bold = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/);
    if (bold) {
      flush();
      for (const s of parseInline(bold[2])) spans.push({ ...s, bold: true });
      i += bold[0].length;
      continue;
    }

    // *cursiva* o _cursiva_
    const italic = rest.match(/^(\*|_)(?=\S)([\s\S]*?\S)\1/);
    if (italic) {
      flush();
      for (const s of parseInline(italic[2])) spans.push({ ...s, italic: true });
      i += italic[0].length;
      continue;
    }

    // ~~tachado~~
    const strike = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/);
    if (strike) {
      flush();
      for (const s of parseInline(strike[1])) spans.push({ ...s, strike: true });
      i += strike[0].length;
      continue;
    }

    // [texto](url) -> se muestra el texto y la url atenuada
    const link = rest.match(/^\[([^\]]*)\]\(([^)\s]+)[^)]*\)/);
    if (link) {
      flush();
      for (const s of parseInline(link[1])) spans.push({ ...s, link: true });
      spans.push({ text: ` (${link[2]})`, dim: true });
      i += link[0].length;
      continue;
    }

    // Escape: \*
    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_~[\]()#]/.test(rest[1])) {
      buffer += rest[1];
      i += 2;
      continue;
    }

    buffer += src[i];
    i++;
  }

  flush();
  return spans.length > 0 ? spans : [{ text: "" }];
}
