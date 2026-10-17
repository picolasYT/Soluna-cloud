import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";
import { TextInput } from "./TextInput.js";

const h = React.createElement;

const CUSTOM_VALUE = "__custom__";

/**
 * The agent's question panel.
 * Supports multiple questions, multi-select, and free-form answers.
 */
export function AskPanel({ request, theme, onComplete, onCancel }) {
  const questions = request.questions;
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState("");

  const current = questions[index];

  const advance = useCallback(
    (answers) => {
      const entry = {
        header: current.header,
        question: current.question,
        answers,
      };
      const nextResults = [...results, entry];
      if (index + 1 >= questions.length) {
        onComplete(nextResults);
        return;
      }
      setResults(nextResults);
      setIndex(index + 1);
      setSelected([]);
      setCustomMode(false);
      setCustomText("");
    },
    [current, results, index, questions.length, onComplete],
  );

  const items = [
    ...current.options.map((opt) => ({
      label: opt.label,
      value: opt.label,
      hint: opt.description,
    })),
    ...(current.custom
      ? [{ label: "Write my own answer", value: CUSTOM_VALUE, hint: "free text" }]
      : []),
  ];

  const handleSubmit = useCallback(
    (item) => {
      if (!item) return;
      if (item.value === CUSTOM_VALUE) {
        setCustomMode(true);
        return;
      }
      if (current.multiple) {
        const picked = selected.length > 0 ? selected : [item.value];
        advance(picked);
        return;
      }
      advance([item.value]);
    },
    [current.multiple, selected, advance],
  );

  const handleToggle = useCallback((item) => {
    if (!item || item.value === CUSTOM_VALUE) return;
    setSelected((prev) =>
      prev.includes(item.value)
        ? prev.filter((v) => v !== item.value)
        : [...prev, item.value],
    );
  }, []);

  const handleCustomSubmit = useCallback(
    (text) => {
      const trimmed = String(text || "").trim();
      if (!trimmed) {
        setCustomMode(false);
        return;
      }
      advance(current.multiple ? [...selected, trimmed] : [trimmed]);
    },
    [advance, current.multiple, selected],
  );

  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.accent,
      paddingX: 1,
      marginY: 1,
    },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { color: theme.accent, bold: true }, `? ${current.header}`),
      questions.length > 1
        ? h(Text, { color: theme.muted }, `${index + 1}/${questions.length}`)
        : null,
    ),
    h(Text, { color: theme.text, wrap: "wrap" }, current.question),
    h(Box, { height: 1 }),
    customMode
      ? h(
          Box,
          { flexDirection: "column" },
          h(Text, { color: theme.dim }, "Your answer:"),
          h(TextInput, {
            value: customText,
            theme,
            isActive: true,
            placeholder: "type here...",
            onChange: setCustomText,
            onSubmit: handleCustomSubmit,
            onCancel: () => setCustomMode(false),
          }),
          h(Text, { color: theme.muted }, "enter confirm · esc back"),
        )
      : h(
          Box,
          { flexDirection: "column" },
          h(SelectList, {
            // The key forces React to mount a fresh list per question so the
            // cursor starts at 0 instead of inheriting the previous index.
            key: `q${index}`,
            items,
            theme,
            isActive: true,
            multiple: current.multiple,
            selected,
            windowSize: 8,
            onSubmit: handleSubmit,
            onToggle: handleToggle,
            onCancel,
          }),
          h(
            Text,
            { color: theme.muted },
            current.multiple
              ? "↑↓ move · space toggle · enter confirm · esc cancel"
              : "↑↓ move · enter select · esc cancel",
          ),
        ),
  );
}
