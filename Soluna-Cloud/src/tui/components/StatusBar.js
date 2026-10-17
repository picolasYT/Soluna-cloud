import React from "react";
import { Box, Text } from "ink";
import { formatTokens, contextBar } from "../../core/tokens.js";

const h = React.createElement;

function barColor(ratio, theme) {
  if (ratio >= 0.9) return theme.error;
  if (ratio >= 0.7) return theme.warn;
  return theme.ok;
}

/**
 * Bottom status bar: provider, model, context, tokens and state.
 */
export function StatusBar({
  theme,
  provider,
  model,
  cwd,
  contextUsed,
  contextLimit,
  usage,
  elapsed,
  queued,
  skills = 0,
  mcp = 0,
  width = 80,
}) {
  const { bar, percent, ratio } = contextBar(contextUsed, contextLimit, 8);
  const color = barColor(ratio, theme);
  const compact = width < 88;

  const dot = h(Text, { color: theme.muted }, " · ");

  return h(
    Box,
    { flexDirection: "column" },

    h(
      Box,
      null,
      h(Text, { color: theme.accent }, `${provider}/${model || "default"}`),
      dot,
      h(Text, { color }, bar),
      h(Text, { color: theme.muted }, ` ${percent}%`),
      dot,
      h(Text, { color: theme.dim }, `${formatTokens(contextUsed)}/${formatTokens(contextLimit)}`),
      compact
        ? null
        : h(
            Text,
            null,
            dot,
            h(Text, { color: theme.muted }, "↑"),
            h(Text, { color: theme.dim }, formatTokens(usage.input)),
            h(Text, { color: theme.muted }, " ↓"),
            h(Text, { color: theme.dim }, formatTokens(usage.output)),
          ),
      usage.turns > 0
        ? h(Text, null, dot, h(Text, { color: theme.dim }, `${usage.turns} turns`))
        : null,
      elapsed
        ? h(Text, null, dot, h(Text, { color: theme.dim }, `${elapsed}s`))
        : null,
      skills > 0 && !compact
        ? h(Text, null, dot, h(Text, { color: theme.tool }, `${skills} skills`))
        : null,
      mcp > 0 && !compact
        ? h(Text, null, dot, h(Text, { color: theme.tool }, `${mcp} mcp`))
        : null,
    ),

    queued > 0
      ? h(
          Text,
          { color: theme.warn },
          `${queued} message${queued > 1 ? "s" : ""} queued · will send after this task`,
        )
      : null,
  );
}
