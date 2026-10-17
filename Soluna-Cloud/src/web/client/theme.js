/* Soluna Web — themes (mirrors src/tui/themes.js) */

const THEMES = {
  soluna: {
    label: "Soluna",
    accent: "#a78bfa",
    text: "#f4f2ff",
    dim: "#b4b0ca",
    muted: "#77738f",
    border: "#34304b",
    user: "#7dd3fc",
    assistant: "#d8ccff",
    tool: "#a78bfa",
    error: "#fb7185",
    warn: "#fbbf24",
    ok: "#6ee7b7",
  },
  dark: {
    label: "Dark",
    accent: "#d4a054",
    text: "#ffffff",
    dim: "#9aa0a6",
    muted: "#6b7176",
    border: "#3a3f44",
    user: "#6699cc",
    assistant: "#6aab6a",
    tool: "#aa88cc",
    error: "#cc5555",
    warn: "#ccaa44",
    ok: "#6aab6a",
  },
  nord: {
    label: "Nord",
    accent: "#88c0d0",
    text: "#eceff4",
    dim: "#aeb6c2",
    muted: "#6c768a",
    border: "#4c566a",
    user: "#81a1c1",
    assistant: "#a3be8c",
    tool: "#b48ead",
    error: "#bf616a",
    warn: "#ebcb8b",
    ok: "#a3be8c",
  },
  dracula: {
    label: "Dracula",
    accent: "#ff79c6",
    text: "#f8f8f2",
    dim: "#cccac2",
    muted: "#6272a4",
    border: "#44475a",
    user: "#8be9fd",
    assistant: "#50fa7b",
    tool: "#bd93f9",
    error: "#ff5555",
    warn: "#f1fa8c",
    ok: "#50fa7b",
  },
  gruvbox: {
    label: "Gruvbox",
    accent: "#fe8019",
    text: "#ebdbb2",
    dim: "#bdae93",
    muted: "#928374",
    border: "#504945",
    user: "#83a598",
    assistant: "#b8bb26",
    tool: "#d3869b",
    error: "#fb4934",
    warn: "#fabd2f",
    ok: "#b8bb26",
  },
  tokyo: {
    label: "Tokyo Night",
    accent: "#ff9e64",
    text: "#c0caf5",
    dim: "#a9b1d6",
    muted: "#565f89",
    border: "#414868",
    user: "#7aa2f7",
    assistant: "#9ece6a",
    tool: "#bb9af7",
    error: "#f7768e",
    warn: "#e0af68",
    ok: "#9ece6a",
  },
  light: {
    label: "Light",
    accent: "#d35400",
    text: "#212529",
    dim: "#495057",
    muted: "#868e96",
    border: "#ced4da",
    user: "#0b7285",
    assistant: "#2b8a3e",
    tool: "#5f3dc4",
    error: "#c92a2a",
    warn: "#e67700",
    ok: "#2b8a3e",
  },
};

THEMES.dark = { ...THEMES.soluna, label: "Midnight" };

const THEME_NAMES = Object.keys(THEMES);

export function getTheme(name) {
  return THEMES[name] || THEMES.soluna;
}

export { THEMES, THEME_NAMES };

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/* Format a token count like the TUI: 1234 -> "1.2k" */
export function formatTokens(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  if (num < 1000000) return `${(num / 1000).toFixed(num < 10000 ? 1 : 0)}k`;
  return `${(num / 1000000).toFixed(1)}M`;
}
