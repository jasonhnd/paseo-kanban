import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { LANGUAGES } from "./i18n";
import { isPanelTab, PANEL_TAB_IDS, type PanelTab } from "./panel-tabs";

/** Body size for S / M / L. Other sizes scale from the S column. */
export const FONT_STEPS = ["sm", "md", "lg"] as const;
export type FontStep = (typeof FONT_STEPS)[number];

export interface PanelPrefs {
  fontStep: FontStep;
  tab: PanelTab;
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = { fontStep: "md", tab: "overview" };

export interface FontSizes {
  title: number;
  h2: number;
  metric: number;
  body: number;
  small: number;
  tab: number;
}

/**
 * S is the previous single table, except phone body is 16 so S means body 16 on both.
 * M and L multiply the S column by 18/16 and 20/16 and round, then body is set to 18 and 20.
 * small and tab stay at least 13, and they step up with M and L.
 */
export const FONT_SCALE: { desktop: Record<FontStep, FontSizes>; compact: Record<FontStep, FontSizes> } = {
  desktop: {
    sm: { title: 32, h2: 20, metric: 32, body: 16, small: 14, tab: 14 },
    md: { title: 36, h2: 23, metric: 36, body: 18, small: 16, tab: 16 },
    lg: { title: 40, h2: 25, metric: 40, body: 20, small: 18, tab: 18 },
  },
  compact: {
    sm: { title: 30, h2: 18, metric: 28, body: 16, small: 13, tab: 13 },
    md: { title: 34, h2: 20, metric: 32, body: 18, small: 15, tab: 15 },
    lg: { title: 38, h2: 23, metric: 35, body: 20, small: 16, tab: 16 },
  },
};

export function fontSizes(step: FontStep, compact: boolean): FontSizes {
  const table = compact ? FONT_SCALE.compact : FONT_SCALE.desktop;
  return table[step] ?? table.md;
}

export function isFontStep(value: unknown): value is FontStep {
  return value === "sm" || value === "md" || value === "lg";
}

/** Invalid font/tab values use defaults. Retired appearance fields are ignored. */
export function parsePanelPrefs(raw: unknown): PanelPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PANEL_PREFS };
  const obj = raw as Record<string, unknown>;
  return {
    fontStep: isFontStep(obj.fontStep) ? obj.fontStep : DEFAULT_PANEL_PREFS.fontStep,
    tab: isPanelTab(obj.tab) ? obj.tab : DEFAULT_PANEL_PREFS.tab,
  };
}

export const panelPrefsRpc = defineRpc({
  name: "board.panel-prefs",
  input: z.object({
    fontStep: z.enum(FONT_STEPS).optional(),
    tab: z.enum(PANEL_TAB_IDS).optional(),
  }),
  output: z.object({
    fontStep: z.enum(FONT_STEPS),
    tab: z.enum(PANEL_TAB_IDS),
    /** The server's language (afc.config.json); the panel shows the same. Optional for an older server. */
    language: z.enum(LANGUAGES).optional(),
  }),
});
