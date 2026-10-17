import React from "react";
import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";

const h = React.createElement;

/** Generic floating window container. */
export function OverlayFrame({ title, footer, theme, children }) {
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.accent,
      paddingX: 1,
      marginY: 1,
    },
    h(Text, { color: theme.accent, bold: true }, title),
    h(Box, { flexDirection: "column", marginTop: 1 }, children),
    footer ? h(Text, { color: theme.muted }, footer) : null,
  );
}

/** Reusable selection window. */
export function SelectOverlay({ title, items, theme, footer, onSubmit, onCancel }) {
  return h(
    OverlayFrame,
    { title, theme, footer: footer || "↑↓ move · enter select · esc close" },
    h(SelectList, {
      items,
      theme,
      isActive: true,
      windowSize: 10,
      onSubmit,
      onCancel,
    }),
  );
}

/** Help window listing the commands. */
export function HelpOverlay({ commands, theme, onCancel }) {
  return h(
    OverlayFrame,
    { title: "Commands", theme, footer: "esc close" },
    ...commands.map((c) =>
      h(
        Box,
        { key: c.name },
        h(Text, { color: theme.accent }, `/${c.name}`.padEnd(14)),
        h(Text, { color: theme.dim }, c.description),
      ),
    ),
  );
}

/** Read-only informational window. */
export function InfoOverlay({ title, rows, theme }) {
  return h(
    OverlayFrame,
    { title, theme, footer: "esc close" },
    ...rows.map((row, i) =>
      h(
        Box,
        { key: i },
        h(Text, { color: theme.dim }, `${row.label}`.padEnd(18)),
        h(Text, { color: theme.text }, String(row.value)),
      ),
    ),
  );
}
