import assert from "node:assert/strict";
import { test } from "node:test";
import { isDarkSurface, mixColors, paletteFromTheme, withOpacity } from "../../../shared/fleet/palette";
import { NEUTRAL_THEME } from "../../../shared/fleet/theme-fallback";
import { LIGHT_THEME, DARK_THEME } from "./fixtures/themes";

test("palette follows shared Kanban recipes and derives category shades from the host", () => {
  for (const theme of [LIGHT_THEME, DARK_THEME]) {
    const p = paletteFromTheme(theme), c = theme.colors;
    assert.equal(p.bg, c.surface0);
    assert.equal(p.card, c.surface1);
    assert.equal(p.raised, c.surface2);
    assert.equal(p.border, c.border);
    assert.equal(p.text, c.foreground);
    for (const bg of [c.surface0, c.surface1, c.surface2]) assert.ok(contrast(p.hint, bg) >= 4.5);
    assert.equal(p.primaryBg, c.accent);
    assert.equal(p.primaryFg, c.accentForeground);
    for (const [ink, bg] of [[p.success, p.successBg], [p.warning, p.warningBg], [p.danger, p.dangerBg], [p.accent, p.accentBg]]) {
      for (const surface of [c.surface0, c.surface1, bg]) assert.ok(contrast(ink, surface) >= 4.5);
    }
    assert.equal(p.faint, mixColors(c.border, c.foregroundMuted, 0.5));
    assert.equal(p.link, p.accent);
    assert.equal(p.clear, withOpacity(c.surface0, 0));
    assert.equal(p.backdrop, withOpacity(c.surface0, 0.65));
    assert.deepEqual(Object.values(p.poolColors), [c.accent, mixColors(c.accent, c.surface0, 0.3), mixColors(c.accent, c.surface0, 0.6)]);
    assert.equal(p.shareColors.length, 16);
    assert.equal(p.shareColors[15], mixColors(c.accent, c.surface0, 0.65));
    assert.equal(p.blueBg, mixColors(c.surface1, c.accent, 0.1));
  }
  assert.deepEqual(paletteFromTheme(undefined), paletteFromTheme(NEUTRAL_THEME));
  assert.deepEqual(paletteFromTheme(null), paletteFromTheme(NEUTRAL_THEME));
  for (const value of Object.values(NEUTRAL_THEME.colors)) {
    assert.match(value, /^#([\da-f]{2})\1\1$/i);
  }
});

test("mix and alpha output native-compatible hex, clamp ratios and preserve unfamiliar host syntax", () => {
  assert.equal(mixColors("#000", "#fff", 0.25), "#404040");
  assert.equal(mixColors("#0000", "#ffffffff", 0.5), "#80808080");
  assert.equal(mixColors("rgb(10, 20, 30)", "rgba(20, 40, 60, 0.5)", 0.5), "#0f1e2dbf");
  assert.equal(withOpacity("#abc8", 0.5), "#aabbcc44");
  assert.equal(withOpacity("rgb(100% 0% 0% / 50%)", 0.5), "#ff000040");
  assert.equal(mixColors("#000", "#fff", 2), "#ffffff");
  assert.equal(withOpacity("#abc", -1), "#aabbcc00");
  assert.equal(mixColors("var(--host-accent)", "var(--host-surface)", 0.1), "var(--host-accent)");
  assert.equal(withOpacity("var(--host-accent)", 0.5), "var(--host-accent)");
});

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const linear = [1, 3, 5].map(index => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("low-contrast ink moves toward host foreground in .05 steps while primary and selected colors remain exact", () => {
  const theme = { colors: { ...LIGHT_THEME.colors, surface0: "#ffffff", surface1: "#fafafa", surface2: "#f0f0f0",
    foreground: "#111111", foregroundMuted: "#cccccc", statusSuccess: "#bbddbb", statusWarning: "#ddddaa", statusDanger: "#ddbbbb", accent: "#eeccdd" } };
  const p = paletteFromTheme(theme), c = theme.colors;
  for (const [raw, ink, backgrounds] of [
    [c.foregroundMuted, p.hint, [c.surface0, c.surface1, c.surface2]],
    [c.statusSuccess, p.success, [c.surface0, c.surface1, p.successBg]],
    [c.statusWarning, p.warning, [c.surface0, c.surface1, p.warningBg]],
    [c.statusDanger, p.danger, [c.surface0, c.surface1, p.dangerBg]],
    [c.accent, p.accent, [c.surface0, c.surface1, p.accentBg]],
  ] as const) {
    assert.notEqual(ink, raw);
    for (const background of backgrounds) assert.ok(contrast(ink, background) >= 4.5, `${ink} on ${background}`);
  }
  const uniform = { colors: { ...c, surface1: c.surface0, surface2: c.surface0 } };
  const steps = Array.from({ length: 21 }, (_, i) => i === 0 ? c.foregroundMuted : mixColors(c.foregroundMuted, c.foreground, i / 20));
  const first = steps.findIndex(ink => contrast(ink, c.surface0) >= 4.5);
  assert.ok(first > 0 && contrast(steps[first - 1], c.surface0) < 4.5);
  assert.equal(paletteFromTheme(uniform).hint, steps[first]);
  assert.equal(p.primaryBg, c.accent);
  assert.equal(p.primaryFg, c.accentForeground);
});

test("every host token participates, and light/dark classification uses surface0 alone", () => {
  const original = paletteFromTheme(LIGHT_THEME);
  for (const key of Object.keys(LIGHT_THEME.colors) as (keyof typeof LIGHT_THEME.colors)[]) {
    assert.notDeepEqual(paletteFromTheme({ colors: { ...LIGHT_THEME.colors, [key]: DARK_THEME.colors[key] } }), original, key);
  }
  assert.equal(isDarkSurface(LIGHT_THEME.colors.surface0), false);
  assert.equal(isDarkSurface(DARK_THEME.colors.surface0), true);
});
