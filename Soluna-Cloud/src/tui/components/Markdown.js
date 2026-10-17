import React from "react";
import { Box, Text } from "ink";
import { parseMarkdown } from "../markdown.js";

const h = React.createElement;

/** Pinta los spans de una linea. */
function Spans({ spans, theme, baseColor }) {
  return spans.map((s, i) =>
    h(
      Text,
      {
        key: i,
        color: s.code ? theme.tool : s.dim ? theme.muted : s.link ? theme.user : baseColor,
        bold: s.bold,
        italic: s.italic,
        strikethrough: s.strike,
        underline: s.link,
      },
      s.code ? ` ${s.text} ` : s.text,
    ),
  );
}

/** Bloque de codigo con barra lateral. */
function CodeBlock({ block, theme, width }) {
  const inner = Math.max(20, width - 6);
  return h(
    Box,
    { flexDirection: "column", marginY: 0 },
    block.lang
      ? h(Text, { color: theme.muted }, `  ┌─ ${block.lang}`)
      : h(Text, { color: theme.muted }, "  ┌─"),
    ...block.lines.map((l, i) =>
      h(
        Box,
        { key: i },
        h(Text, { color: theme.muted }, "  │ "),
        h(Text, { color: theme.tool }, l.replace(/\t/g, "  ").slice(0, inner)),
      ),
    ),
    h(Text, { color: theme.muted }, "  └─"),
  );
}

// Stable key for a block: content-based so React reconciles correctly when
// the parse structure shifts during streaming (e.g. a line that was a
// paragraph becomes a heading). Array-index keys would remount nodes and can
// flicker or momentarily duplicate content.
function blockKey(block, i) {
  switch (block.type) {
    case "heading":
      return `h:${block.level}:${block.text}`;
    case "code":
      return `c:${block.lang}:${block.lines[0] ?? ""}`;
    case "list":
      return `l:${block.ordered}:${block.marker}:${JSON.stringify(block.spans)}`;
    case "quote":
    case "para":
      return `${block.type[0]}:${JSON.stringify(block.spans)}`;
    default:
      return `${block.type}:${i}`;
  }
}

/**
 * Renderiza Markdown en la terminal.
 */
export function Markdown({ text, theme, width = 80 }) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return null;

  return h(
    Box,
    { flexDirection: "column" },
    ...blocks.map((block, i) => {
      const key = blockKey(block, i);
      switch (block.type) {
        case "heading":
          return h(
            Text,
            {
              key,
              color: block.level <= 2 ? theme.accent : theme.text,
              bold: true,
            },
            block.level <= 2 ? block.text : `${"#".repeat(block.level)} ${block.text}`,
          );

        case "code":
          return h(CodeBlock, { key, block, theme, width });

        case "list":
          return h(
            Box,
            { key },
            h(Text, { color: theme.accent }, `${"  ".repeat(block.indent)}${block.marker} `),
            h(Text, { wrap: "wrap" }, h(Spans, { spans: block.spans, theme, baseColor: theme.text })),
          );

        case "quote":
          return h(
            Box,
            { key },
            h(Text, { color: theme.muted }, "│ "),
            h(Text, { wrap: "wrap" }, h(Spans, { spans: block.spans, theme, baseColor: theme.dim })),
          );

        case "rule":
          return h(Text, { key, color: theme.border }, "─".repeat(Math.min(width - 2, 40)));

        case "blank":
          return h(Box, { key, height: 1 });

        default:
          return h(
            Text,
            { key, wrap: "wrap" },
            h(Spans, { spans: block.spans, theme, baseColor: theme.text }),
          );
      }
    }),
  );
}
