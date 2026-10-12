import { Platform } from "react-native";

export type { Palette } from "../shared/palette";
export { paletteFromTheme } from "../shared/palette";
export type { FontSizes, FontStep } from "../shared/panel-prefs";
export { FONT_SCALE, fontSizes } from "../shared/panel-prefs";

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
