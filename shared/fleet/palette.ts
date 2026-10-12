import type { PluginTheme } from "@getpaseo/plugin";
import { paletteFromTheme as basePalette, mixColors } from "../palette";
import { NEUTRAL_THEME } from "../theme-fallback";
import type { Palette as BoardPalette } from "../palette";
import type { TokenPoolKey } from "./token-block";
export { mixColors, isDarkSurface, withOpacity } from "../palette";

export interface Palette extends BoardPalette {
  green: string; greenBg: string; amber: string; amberBg: string;
  red: string; redBg: string; blue: string; blueBg: string;
  link: string; transparent: string;
  poolColors: Record<TokenPoolKey, string>; shareColors: readonly string[];
}
/** Fleet's historic tone names adapt the same host-props palette. */
export function paletteFromTheme(theme: PluginTheme | null | undefined): Palette {
  const p = basePalette(theme), c = (theme ?? NEUTRAL_THEME).colors;
  return { ...p, green: p.success, greenBg: p.successBg, amber: p.warning, amberBg: p.warningBg,
    red: p.danger, redBg: p.dangerBg, blue: c.accent, blueBg: p.accentBg, link: p.accent, transparent: p.clear,
    poolColors: { claude: c.accent, cursor: mixColors(c.accent, c.surface0, 0.3), grok: mixColors(c.accent, c.surface0, 0.6) },
    shareColors: Array.from({ length: 16 }, (_, index) => mixColors(c.accent, c.surface0, 0.65 * index / 15)) };
}
