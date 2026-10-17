import React, { useState, useMemo, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";

const h = React.createElement;

/**
 * Selectable list with a scrolling window.
 * Avoids the classic bug of rendering hundreds of rows: only `windowSize` is drawn.
 */
export function SelectList({
  items,
  theme,
  isActive = true,
  multiple = false,
  selected = [],
  initialIndex = 0,
  windowSize = 8,
  emptyText = "No items",
  onSubmit,
  onToggle,
  onCancel,
}) {
  const total = items.length;
  const [cursor, setCursor] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, total - 1)),
  );
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // If the list resizes, keep the cursor within range.
  useEffect(() => {
    if (cursor > total - 1) setCursor(Math.max(0, total - 1));
  }, [total, cursor]);

  const offset = useMemo(() => {
    if (total <= windowSize) return 0;
    const half = Math.floor(windowSize / 2);
    return Math.min(Math.max(0, cursor - half), total - windowSize);
  }, [cursor, total, windowSize]);

  useInput(
    (input, key) => {
      if (total === 0) {
        if (key.escape) onCancel?.();
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((c) => (c - 1 + total) % total);
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor((c) => (c + 1) % total);
        return;
      }
      if (key.pageUp) {
        setCursor((c) => Math.max(0, c - windowSize));
        return;
      }
      if (key.pageDown) {
        setCursor((c) => Math.min(total - 1, c + windowSize));
        return;
      }
      if (input === " " && multiple) {
        onToggle?.(items[cursorRef.current], cursorRef.current);
        return;
      }
      if (key.return) {
        onSubmit?.(items[cursorRef.current], cursorRef.current);
        return;
      }
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (/^[1-9]$/.test(input)) {
        const idx = Number(input) - 1;
        if (idx < total) setCursor(idx);
      }
    },
    { isActive },
  );

  if (total === 0) {
    return h(Text, { color: theme.muted }, `  ${emptyText}`);
  }

  const visible = items.slice(offset, offset + windowSize);

  return h(
    Box,
    { flexDirection: "column" },
    offset > 0
      ? h(Text, { key: "up", color: theme.muted }, `  ↑ ${offset} more`)
      : null,
    ...visible.map((item, i) => {
      const index = offset + i;
      const active = index === cursor;
      const checked = multiple && selected.includes(item.value ?? item.label);
      const marker = multiple ? (checked ? "[x]" : "[ ]") : active ? "›" : " ";
      return h(
        Box,
        { key: `${index}-${item.label}` },
        h(
          Text,
          { color: active ? theme.accent : theme.dim, bold: active },
          `${active ? "›" : " "} ${multiple ? `${marker} ` : ""}${item.label}`,
        ),
        item.hint
          ? h(Text, { color: theme.muted }, `  ${item.hint}`)
          : null,
      );
    }),
    offset + windowSize < total
      ? h(
          Text,
          { key: "down", color: theme.muted },
          `  ↓ ${total - offset - windowSize} more`,
        )
      : null,
  );
}
