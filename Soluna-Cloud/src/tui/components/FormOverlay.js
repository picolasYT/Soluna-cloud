import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { TextInput } from "./TextInput.js";

const h = React.createElement;

/**
 * Multi-field form rendered one field at a time.
 *
 * Used to add custom providers, models and MCP servers without leaving the
 * TUI. Fields are asked sequentially so the layout never overflows a narrow
 * terminal, and each answer is validated before moving on.
 *
 * @param {object[]} fields  [{ key, label, placeholder, required, hint, validate }]
 */
export function FormOverlay({ title, fields, theme, onSubmit, onCancel }) {
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const field = fields[index];

  const advance = useCallback(
    (raw) => {
      const value = String(raw ?? "").trim();

      // On a rejection, clear the box so the next attempt starts clean.
      // Leaving the bad text in place makes the following keystrokes append
      // to it, which silently corrupts every later field.
      const reject = (message) => {
        setError(message);
        setDraft("");
        setEpoch((n) => n + 1);
      };

      if (field.required && !value) {
        reject(`${field.label} is required`);
        return;
      }
      if (value && field.validate) {
        const problem = field.validate(value);
        if (problem) {
          reject(problem);
          return;
        }
      }

      const next = { ...values, [field.key]: value };
      setValues(next);
      setError(null);
      setDraft("");
      setEpoch((n) => n + 1);

      if (index + 1 >= fields.length) {
        setSubmitting(true);
        Promise.resolve()
          .then(() => onSubmit(next))
          .catch((err) => {
            setError(`Could not save: ${err?.message || err}`);
            setDraft(value);
            setEpoch((n) => n + 1);
          })
          .finally(() => setSubmitting(false));
      } else setIndex(index + 1);
    },
    [field, values, index, fields.length, onSubmit],
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
      h(Text, { color: theme.accent, bold: true }, title),
      h(Text, { color: theme.muted }, `${index + 1}/${fields.length}`),
    ),

    // Previously answered fields, for context.
    ...fields.slice(0, index).map((f) =>
      h(
        Box,
        { key: f.key },
        h(Text, { color: theme.muted }, `  ${f.label}: `),
        h(
          Text,
          { color: theme.dim },
          f.secret && values[f.key] ? "•".repeat(8) : values[f.key] || "(skipped)",
        ),
      ),
    ),

    h(Box, { marginTop: index > 0 ? 1 : 0 }, h(Text, { color: theme.text }, field.label)),
    field.hint ? h(Text, { color: theme.muted }, `  ${field.hint}`) : null,

    h(
      Box,
      { marginTop: 0 },
      h(Text, { color: theme.accent }, "  > "),
      h(TextInput, {
        value: draft,
        resetToken: epoch,
        theme,
        isActive: !submitting,
        mask: field.secret,
        placeholder: field.placeholder || (field.required ? "required" : "optional, enter to skip"),
        onChange: setDraft,
        onSubmit: advance,
        onCancel,
      }),
    ),

    error ? h(Text, { color: theme.error }, `  ${error}`) : null,
    h(Text, { color: theme.muted }, submitting ? "  Saving…" : "  enter next · esc cancel"),
  );
}

/** Field definitions for adding a custom provider. */
export const PROVIDER_FIELDS = [
  {
    key: "id",
    label: "Provider id",
    hint: "lowercase, no spaces — used with -p <id>",
    required: true,
    validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "Use lowercase letters, digits and dashes"),
  },
  { key: "label", label: "Display name", hint: "shown in /providers", required: true },
  {
    key: "baseUrl",
    label: "Base URL",
    hint: "OpenAI-compatible endpoint, e.g. http://localhost:8080/v1",
    required: true,
    validate: (v) => (/^https?:\/\/.+/.test(v) ? null : "Must start with http:// or https://"),
  },
  {
    key: "apiKeyEnv",
    label: "API key env var",
    hint: "leave empty if the endpoint needs no key",
    required: false,
    validate: (v) => (/^[A-Z0-9_]+$/.test(v) ? null : "Use uppercase letters, digits and underscores"),
  },
  {
    key: "apiKey",
    label: "API key",
    hint: "paste it here to save it, or leave empty to use the env var",
    required: false,
    secret: true,
  },
  {
    key: "model",
    label: "Default model id",
    hint: "exact id the endpoint expects",
    required: true,
  },
];

/** Single-field form for entering a provider's API key. */
export const API_KEY_FIELDS = [
  {
    key: "apiKey",
    label: "API key",
    hint: "stored in ~/.soluna/config.json — leave empty to remove it",
    required: false,
    secret: true,
  },
];

export const OPENROUTER_KEY_FIELDS = [
  { key: "apiKey", label: "OpenRouter API key", hint: "Se guarda localmente y se oculta al escribir", required: true, secret: true },
];

/** Field definitions for adding a model to an existing provider. */
export const MODEL_FIELDS = [
  { key: "id", label: "Model id", hint: "exact id the provider expects", required: true },
  { key: "label", label: "Display name", hint: "shown in /models", required: false },
];

/** Field definitions for adding an MCP server. */
export const MCP_FIELDS = [
  {
    key: "name",
    label: "Server name",
    hint: "used to namespace its tools: mcp__<name>__<tool>",
    required: true,
    validate: (v) => (/^[a-z0-9][a-z0-9_-]*$/.test(v) ? null : "Use lowercase letters, digits, dashes"),
  },
  { key: "command", label: "Command", hint: "e.g. npx", required: true },
  {
    key: "args",
    label: "Arguments",
    hint: "space-separated, e.g. -y @modelcontextprotocol/server-filesystem /tmp",
    required: false,
  },
];
