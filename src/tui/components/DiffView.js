import React from "react";
import { Box, Text } from "ink";
import { toHunks } from "../../core/diff.js";

const h = React.createElement;

const MAX_LINES_COLLAPSED = 12;

function truncate(text, width) {
  const s = String(text ?? "").replace(/\t/g, "  ");
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

/**
 * Render a diff with + and - lines.
 */
export function DiffView({ diff, theme, expanded = false, width = 80 }) {
  if (!diff) return null;

  const { added, removed, lines, isNew } = diff;

  if (added === 0 && removed === 0) {
    return h(Text, { color: theme.muted }, "    no changes");
  }

  const hunks = toHunks(lines, expanded ? 3 : 1);
  const flat = [];
  hunks.forEach((hunk, i) => {
    if (i > 0) flat.push({ type: "sep" });
    flat.push(...hunk);
  });

  const shown = expanded ? flat : flat.slice(0, MAX_LINES_COLLAPSED);
  const hidden = flat.length - shown.length;
  const colWidth = Math.max(20, width - 10);

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      null,
      h(Text, { color: theme.muted }, "    "),
      h(Text, { color: theme.ok }, `+${added}`),
      h(Text, { color: theme.muted }, " "),
      h(Text, { color: theme.error }, `-${removed}`),
      isNew ? h(Text, { color: theme.muted }, "  (new file)") : null,
    ),
    ...shown.map((line, i) => {
      if (line.type === "sep") {
        return h(Text, { key: `s${i}`, color: theme.muted }, "    ⋯");
      }
      const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
      const color =
        line.type === "add" ? theme.ok : line.type === "del" ? theme.error : theme.muted;
      return h(
        Text,
        { key: `d${i}`, color },
        `    ${sign} ${truncate(line.text, colWidth)}`,
      );
    }),
    hidden > 0
      ? h(Text, { color: theme.muted }, `    ⋯ ${hidden} more lines`)
      : null,
  );
}
