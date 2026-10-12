import type { PluginTheme } from "@getpaseo/plugin";

/** Every key differs within and between fixtures, including colored surfaces. */
export const LIGHT_THEME: PluginTheme = { colors: {
  surface0: "#f8f6f2", surface1: "#f0ede7", surface2: "#e6e1d8", border: "#b8b1a4",
  foreground: "#241d13", foregroundMuted: "#5e5040", accent: "#774010", accentForeground: "#fff9ed",
  statusSuccess: "#226330", statusWarning: "#815300", statusDanger: "#9c252d",
} };
export const DARK_THEME: PluginTheme = { colors: {
  surface0: "#111d2c", surface1: "#19283a", surface2: "#23364b", border: "#526c88",
  foreground: "#eaf2fb", foregroundMuted: "#b0c5de", accent: "#73b6f1", accentForeground: "#091f36",
  statusSuccess: "#7dde9b", statusWarning: "#f1c477", statusDanger: "#f690a8",
} };
