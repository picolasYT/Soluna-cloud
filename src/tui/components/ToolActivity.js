import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { DiffView } from "./DiffView.js";
import { SPINNER_FRAMES } from "../themes.js";

const h = React.createElement;

/** Status glyph for the current phase. */
function PhaseIcon({ phase, theme, frame }) {
  if (phase === "preparing") return h(Text, { color: theme.muted }, "◌ ");
  if (phase === "running") return h(Text, { color: theme.accent }, `${SPINNER_FRAMES[frame]} `);
  if (phase === "error") return h(Text, { color: theme.error }, "✗ ");
  return h(Text, { color: theme.ok }, "✓ ");
}

/**
 * Live tool activity.
 * Shows the phase text and, once finished, the diff or output.
 */
export function ToolActivity({ entry, theme, width = 80, live = false }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!live || (entry.phase !== "running" && entry.phase !== "preparing")) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(timer);
  }, [live, entry.phase]);

  const labelColor =
    entry.phase === "error"
      ? theme.error
      : entry.phase === "done"
        ? theme.dim
        : entry.phase === "preparing"
          ? theme.muted
          : theme.text;

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      null,
      h(Text, null, "  "),
      h(PhaseIcon, { phase: entry.phase, theme, frame }),
      h(Text, { color: labelColor, wrap: "truncate-end" }, entry.label),
      entry.duration
        ? h(Text, { color: theme.muted }, ` ${entry.duration}`)
        : null,
    ),

    entry.diff
      ? h(DiffView, { diff: entry.diff, theme, width, expanded: false })
      : null,

    entry.output
      ? h(
          Box,
          { flexDirection: "column" },
          ...entry.output.split("\n").slice(0, 6).map((l, i) =>
            h(
              Text,
              { key: i, color: theme.muted, wrap: "truncate-end" },
              `      ${l}`,
            ),
          ),
        )
      : null,

    entry.error
      ? h(Text, { color: theme.error, wrap: "wrap" }, `      ${entry.error}`)
      : null,
  );
}
