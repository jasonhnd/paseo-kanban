import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Old or incomplete hosts may omit theme altogether. This single neutral grayscale
 * keeps the panel readable in that case only; a supplied PluginTheme always wins.
 * Do not add a second palette or any category/status hues here.
 */
export const NEUTRAL_THEME: PluginTheme = {
  colors: {
    surface0: "#181818",
    surface1: "#202020",
    surface2: "#303030",
    border: "#505050",
    foreground: "#f0f0f0",
    foregroundMuted: "#b0b0b0",
    accent: "#d0d0d0",
    accentForeground: "#181818",
    statusSuccess: "#d0d0d0",
    statusWarning: "#d0d0d0",
    statusDanger: "#d0d0d0",
  },
};
