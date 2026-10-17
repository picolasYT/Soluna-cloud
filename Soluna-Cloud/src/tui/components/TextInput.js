import React, { useState, useRef, useEffect } from "react";
import { Text, useInput } from "ink";

const h = React.createElement;

/**
 * Text input driven internally by refs.
 *
 * A known failure mode in this pattern is state and ref drifting apart, which
 * drops characters when typing fast. Here the ref is always the source of
 * truth and state only triggers a repaint.
 */
export function TextInput({
  value: controlledValue,
  resetToken,
  placeholder = "",
  theme,
  isActive = true,
  mask = false,
  onChange,
  onSubmit,
  onCancel,
  onHistoryPrev,
  onHistoryNext,
  onTab,
}) {
  const [value, setValue] = useState(controlledValue || "");
  const [cursor, setCursor] = useState((controlledValue || "").length);
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  valueRef.current = value;
  cursorRef.current = cursor;

  // Sync external changes (autocomplete, history, clearing).
  //
  // Comparing `controlledValue` to the internal value is not enough: on
  // submit the parent goes from "text" to "" while the internal value is
  // still "text", and if the parent returns to "" the effect does not re-run
  // and stale text sticks. `resetToken` forces the sync.
  useEffect(() => {
    if (controlledValue === undefined) return;
    const next = controlledValue || "";
    if (next === valueRef.current) return;
    valueRef.current = next;
    cursorRef.current = next.length;
    setValue(next);
    setCursor(next.length);
  }, [controlledValue, resetToken]);

  const commit = (next, nextCursor = next.length) => {
    const safeCursor = Math.max(0, Math.min(nextCursor, next.length));
    valueRef.current = next;
    cursorRef.current = safeCursor;
    setValue(next);
    setCursor(safeCursor);
    onChange?.(next);
  };

  useInput(
    (input, key) => {
      const cur = valueRef.current;
      const pos = cursorRef.current;

      if (key.return) {
        onSubmit?.(cur);
        return;
      }
      if (key.escape) {
        // With text typed, esc discards it (shell behaviour).
        if (cur.length > 0) {
          commit("", 0);
          return;
        }
        onCancel?.();
        return;
      }
      if (key.tab) {
        onTab?.(cur);
        return;
      }
      if (key.backspace || key.delete) {
        if (pos > 0) commit(cur.slice(0, pos - 1) + cur.slice(pos), pos - 1);
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(0, pos - 1));
        cursorRef.current = Math.max(0, pos - 1);
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(cur.length, pos + 1));
        cursorRef.current = Math.min(cur.length, pos + 1);
        return;
      }
      if (key.upArrow) {
        onHistoryPrev?.();
        return;
      }
      if (key.downArrow) {
        onHistoryNext?.();
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        cursorRef.current = 0;
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(cur.length);
        cursorRef.current = cur.length;
        return;
      }
      if (key.ctrl && input === "u") {
        commit("", 0);
        return;
      }
      // Regular text, including multi-character pastes.
      if (input && !key.ctrl && !key.meta) {
        // A paste may contain embedded newlines. The first newline acts as
        // Enter: insert what precedes it and submit the line.
        const newlineAt = input.search(/[\r\n]/);
        if (newlineAt !== -1) {
          const head = input.slice(0, newlineAt);
          const tail = input.slice(newlineAt).replace(/[\r\n]+/g, " ").trim();
          const line = cur.slice(0, pos) + head + cur.slice(pos);
          if (tail) {
            // Multiple pasted lines collapse into a single entry.
            commit(`${line} ${tail}`.trim());
            return;
          }
          commit(line, line.length);
          onSubmit?.(line);
          return;
        }
        commit(cur.slice(0, pos) + input + cur.slice(pos), pos + input.length);
      }
    },
    { isActive },
  );

  const shown = mask ? "*".repeat(value.length) : value;

  if (!shown) {
    return h(
      Text,
      null,
      h(Text, { color: theme.accent }, "▏"),
      h(Text, { color: theme.muted }, placeholder),
    );
  }

  const before = shown.slice(0, cursor);
  const at = shown.slice(cursor, cursor + 1) || " ";
  const after = shown.slice(cursor + 1);

  return h(
    Text,
    null,
    h(Text, { color: theme.text }, before),
    h(Text, { color: theme.accent, inverse: isActive }, at),
    h(Text, { color: theme.text }, after),
  );
}
