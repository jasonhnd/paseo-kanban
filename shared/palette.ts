import type { PluginTheme } from "@getpaseo/plugin";
import { NEUTRAL_THEME } from "./theme-fallback";

export interface Palette {
  bg: string;
  card: string;
  raised: string;
  column: string;
  border: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  hint: string;
  faint: string;
  track: string;
  primaryBg: string;
  primaryFg: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  accent: string;
  accentBg: string;
  clear: string;
  backdrop: string;
}

type Channels = [number, number, number, number];

/** Host colors are hex or CSS channel functions; no system appearance is consulted. */
function channels(input: string | undefined): Channels | null {
  if (!input) return null;
  const hex = input.trim().match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16), h.length === 8 ? Number.parseInt(h.slice(6), 16) / 255 : 1];
  }
  const fn = input.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const values = parts.map((part, i) => part.endsWith("%") ? Number.parseFloat(part) / 100 * (i < 3 ? 255 : 1) : Number.parseFloat(part));
  if (values.some((value) => !Number.isFinite(value))) return null;
  return [values[0], values[1], values[2], values[3] ?? 1];
}

function encode(parts: Channels): string {
  const byte = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return "#" + parts.slice(0, 3).map(byte).join("") + (parts[3] < 1 ? byte(parts[3] * 255) : "");
}

/** Mix in channel space. Unknown host formats retain a host color, never a fixed hue. */
export function mixColors(base: string, tint: string, amount: number): string {
  const a = channels(base), b = channels(tint);
  if (!a || !b) return amount >= 0.5 ? tint : base;
  const t = Math.max(0, Math.min(1, amount));
  return encode(a.map((value, i) => value * (1 - t) + b[i] * t) as Channels);
}

/** Alpha comes from a host color, including the fully clear borders and backgrounds. */
export function withOpacity(color: string, opacity: number): string {
  const parts = channels(color);
  if (!parts) return color;
  return encode([parts[0], parts[1], parts[2], parts[3] * Math.max(0, Math.min(1, opacity))]);
}

function luminance(color: string | undefined): number | null {
  const parts = channels(color);
  if (!parts) return null;
  const linear = parts.slice(0, 3).map((part) => {
    const v = part / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Dark/light decisions use only the relative luminance of surface0. */
export function isDarkSurface(surface0: string | undefined): boolean {
  return (luminance(surface0) ?? 0) < 0.179;
}

/** Preserve the host hue, moving toward its foreground only when small text needs contrast. */
function readable(ink: string, background: string, foreground: string): string {
  const bg = luminance(background);
  if (bg === null) return ink;
  for (let step = 0; step <= 20; step++) {
    const candidate = step === 0 ? ink : mixColors(ink, foreground, step / 20);
    const fg = luminance(candidate);
    if (fg === null || (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) >= 4.5) return candidate;
  }
  return foreground;
}

/** Pure PluginTheme -> Kanban tokens. Called on every host-props render, on web and native. */
export function paletteFromTheme(theme: PluginTheme | null | undefined): Palette {
  const c = (theme ?? NEUTRAL_THEME).colors;
  const successBg = mixColors(c.surface1, c.statusSuccess, 0.1);
  const warningBg = mixColors(c.surface1, c.statusWarning, 0.1);
  const dangerBg = mixColors(c.surface1, c.statusDanger, 0.1);
  const accentBg = mixColors(c.surface1, c.accent, 0.1);
  // Status/link ink is also shown on plain cards and on the page, not just badges.
  const ink = (color: string, tinted: string) => [c.surface0, c.surface1, tinted].reduce((value, bg) => readable(value, bg, c.foreground), color);
  const secondary = [c.surface0, c.surface1, c.surface2].reduce((value, bg) => readable(value, bg, c.foreground), c.foregroundMuted);
  return {
    bg: c.surface0, card: c.surface1, raised: c.surface2,
    column: mixColors(c.surface0, c.surface1, 0.5), border: c.border,
    text: c.foreground, textSecondary: secondary, textTertiary: secondary,
    hint: secondary, faint: mixColors(c.border, c.foregroundMuted, 0.5), track: c.surface2,
    primaryBg: c.accent, primaryFg: c.accentForeground,
    success: ink(c.statusSuccess, successBg), successBg,
    warning: ink(c.statusWarning, warningBg), warningBg,
    danger: ink(c.statusDanger, dangerBg), dangerBg,
    accent: ink(c.accent, accentBg), accentBg,
    clear: withOpacity(c.surface0, 0), backdrop: withOpacity(c.surface0, 0.65),
  };
}
