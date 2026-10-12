import { Platform } from "react-native";

export type { Palette } from "../../shared/fleet/palette";
export { paletteFromTheme } from "../../shared/fleet/palette";
export type { FontSizes, FontStep } from "../../shared/fleet/panel-prefs";
export { FONT_SCALE, fontSizes } from "../../shared/fleet/panel-prefs";

export const SANS = Platform.select({
  web: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  default: undefined,
});

export const MONO = Platform.select({
  web: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});
