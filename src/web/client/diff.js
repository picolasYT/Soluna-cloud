const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

/** Render the core's add/del/ctx format, including two lines of context. */
export function renderDiff(diff) {
  if (!diff) return "";
  const lines = diff.lines || [];
  const visible = new Set();
  lines.forEach((line, index) => {
    if (["add", "del", "rem"].includes(line.type)) {
      for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 2); i++) visible.add(i);
    }
  });
  let previous = -1;
  const rows = [];
  for (const index of [...visible].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) rows.push('<div class="diff-ctx">…</div>');
    const line = lines[index];
    const removed = line.type === "del" || line.type === "rem";
    const kind = removed ? "rem" : line.type === "add" ? "add" : "ctx";
    rows.push(`<div class="diff-line diff-${kind}"><span class="diff-line-number">${escape(line.oldNo)}</span><span class="diff-line-number">${escape(line.newNo)}</span><span class="diff-sign">${removed ? "-" : line.type === "add" ? "+" : " "}</span><span class="diff-text">${escape(line.text) || " "}</span></div>`);
    previous = index;
  }
  return `<div class="diff-summary">${escape(diff.path)} · +${escape(diff.added ?? 0)} / −${escape(diff.removed ?? 0)}</div><div class="tool-diff">${rows.join("") || "Sin cambios de contenido."}</div>`;
}
