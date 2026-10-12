/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDarkSurface, mixColors, paletteFromTheme, withOpacity } from "../shared/palette";
import { NEUTRAL_THEME } from "../shared/theme-fallback";
import { parsePanelPrefs, panelPrefsRpc } from "../shared/panel-prefs";
import { DARK_THEME, LIGHT_THEME } from "./helpers/theme-fixture";

describe("host theme palette", () => {
  for (const theme of [LIGHT_THEME, DARK_THEME]) {
    it(`maps all eleven host tokens, including the ${isDarkSurface(theme.colors.surface0) ? "dark" : "light"} colored surfaces`, () => {
      const c = theme.colors, p = paletteFromTheme(theme);
      assert.equal(new Set(Object.values(c)).size, 11);
      assert.deepEqual([p.bg, p.card, p.raised, p.border, p.text, p.textSecondary, p.primaryBg, p.primaryFg],
        [c.surface0, c.surface1, c.surface2, c.border, c.foreground, c.foregroundMuted, c.accent, c.accentForeground]);
      assert.equal(p.column, mixColors(c.surface0, c.surface1, 0.5));
      for (const [token, source] of [["success", "statusSuccess"], ["warning", "statusWarning"], ["danger", "statusDanger"], ["accent", "accent"]] as const) {
        assert.equal(p[`${token}Bg`], mixColors(c.surface1, c[source], 0.1));
        assert.ok(Array.from({ length: 21 }, (_, step) => step ? mixColors(c[source], c.foreground, step / 20) : c[source]).includes(p[token]), "status text retains its theme hue or a foreground mix");
      }
      assert.equal(p.clear, withOpacity(c.surface0, 0));
      assert.equal(p.backdrop, withOpacity(c.surface0, 0.65));
      assert.deepEqual(paletteFromTheme(theme), p, "deterministic");
    });
  }
  it("updates every rendered token when the host changes theme", () => {
    const light = paletteFromTheme(LIGHT_THEME), dark = paletteFromTheme(DARK_THEME);
    for (const key of Object.keys(light) as Array<keyof typeof light>) assert.notEqual(light[key], dark[key], key);
    for (const key of Object.keys(LIGHT_THEME.colors) as Array<keyof typeof LIGHT_THEME.colors>) {
      const changed = paletteFromTheme({ colors: { ...LIGHT_THEME.colors, [key]: DARK_THEME.colors[key] } });
      assert.notDeepEqual(changed, light, `${key} participates in the palette`);
    }
  });
  it("keeps secondary text readable on a host's slightly darker raised surface", () => {
    const theme = { colors: { ...LIGHT_THEME.colors, surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", foreground: "#18181b", foregroundMuted: "#71717a" } };
    const p = paletteFromTheme(theme);
    assert.notEqual(p.textSecondary, theme.colors.foregroundMuted, "the unadjusted host pair is only 4.40:1");
    assert.equal(p.textSecondary, mixColors(theme.colors.foregroundMuted, theme.colors.foreground, 0.05));
    assert.equal(p.textTertiary, p.textSecondary);
    assert.equal(p.hint, p.textSecondary);
  });
  it("has a single grayscale fallback only when theme is absent", () => {
    assert.deepEqual(paletteFromTheme(undefined), paletteFromTheme(NEUTRAL_THEME));
    assert.deepEqual(paletteFromTheme(null), paletteFromTheme(NEUTRAL_THEME));
    for (const color of Object.values(NEUTRAL_THEME.colors)) assert.equal(color.slice(1, 3), color.slice(3, 5));
    assert.equal(paletteFromTheme(LIGHT_THEME).bg, LIGHT_THEME.colors.surface0);
  });
  it("uses only surface luminance and handles host channel/alpha formats", () => {
    assert.equal(isDarkSurface(LIGHT_THEME.colors.surface0), false);
    assert.equal(isDarkSurface(DARK_THEME.colors.surface0), true);
    assert.equal(isDarkSurface("#fff"), false);
    assert.equal(isDarkSurface("rgb(20, 30, 40)"), true);
    assert.equal(isDarkSurface("not-a-color"), true);
    assert.equal(mixColors("#000", "#fff", 0.5), "#808080");
    assert.equal(mixColors("rgb(0, 0, 0)", "rgb(100% 100% 100%)", 0.5), "#808080");
    assert.equal(withOpacity("#12345680", 0.5), "#12345640");
    assert.equal(withOpacity("rgba(10,20,30,0.5)", 0), "#0a141e00");
    assert.equal(mixColors("unrecognized", "#fff", 0.2), "unrecognized");
  });
  it("ignores legacy colorMode in preferences and RPC without throwing", () => {
    for (const colorMode of ["light", "dark", "paseo", "bad", null, { old: true }]) {
      assert.deepEqual(parsePanelPrefs({ fontStep: "lg", colorMode }), { fontStep: "lg" });
      assert.deepEqual(panelPrefsRpc.input.parse({ fontStep: "sm", colorMode }), { fontStep: "sm" });
    }
  });
});
