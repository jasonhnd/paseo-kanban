import type { PluginTheme } from "@getpaseo/plugin";

export const LIGHT_THEME: PluginTheme = {
  colors: {
    surface0: "#faf8f4", surface1: "#f2ede5", surface2: "#e8dfd1", border: "#928372",
    foreground: "#23190f", foregroundMuted: "#665344", accent: "#6145aa", accentForeground: "#fff9e1",
    statusSuccess: "#22633c", statusWarning: "#815300", statusDanger: "#a62442",
  },
};
export const DARK_THEME: PluginTheme = {
  colors: {
    surface0: "#102329", surface1: "#19333b", surface2: "#234650", border: "#648b97",
    foreground: "#f0faff", foregroundMuted: "#b3d0dc", accent: "#65e4dc", accentForeground: "#082e2c",
    statusSuccess: "#9ce593", statusWarning: "#f1cd6a", statusDanger: "#ff9bb4",
  },
};
