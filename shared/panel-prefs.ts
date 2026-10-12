import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Body size for S / M / L. Other sizes scale from the S column in AFC UI-DESIGN. */
export const FONT_STEPS = ["sm", "md", "lg"] as const;
export type FontStep = (typeof FONT_STEPS)[number];

export interface PanelPrefs {
  fontStep: FontStep;
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = { fontStep: "md" };

export interface FontSizes {
  title: number;
  h2: number;
  metric: number;
  body: number;
  small: number;
  tab: number;
}

/**
 * Desktop and phone tables from AFC UI-DESIGN. Phone is `layout.compact`.
 * small and tab stay at least 13. Body is 16 / 18 / 20 on both.
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

/** A non-object, or a field outside the three choices, falls back to M for that field. */
export function parsePanelPrefs(raw: unknown): PanelPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PANEL_PREFS };
  const obj = raw as Record<string, unknown>;
  return {
    fontStep: isFontStep(obj.fontStep) ? obj.fontStep : DEFAULT_PANEL_PREFS.fontStep,
  };
}

export const panelPrefsRpc = defineRpc({
  name: "kanban.panel-prefs",
  input: z.object({
    fontStep: z.enum(FONT_STEPS).optional(),
  }),
  output: z.object({
    fontStep: z.enum(FONT_STEPS),
    /** Set when a save left a broken file in place. Null on a normal read or save. */
    notice: z.string().nullable(),
  }),
});

/** Tabs of the board. The choice is saved in the board's own file, not in the shared panel-prefs.json. */
export const BOARD_TABS = ["overview", "attention", "decisions", "projects", "settings"] as const;
export type BoardTab = (typeof BOARD_TABS)[number];
export const DEFAULT_BOARD_TAB: BoardTab = "overview";

export function isBoardTab(value: unknown): value is BoardTab {
  return (BOARD_TABS as readonly unknown[]).includes(value);
}

export const boardTabRpc = defineRpc({
  name: "kanban.board-tab",
  input: z.object({ tab: z.enum(BOARD_TABS).optional() }),
  output: z.object({ tab: z.enum(BOARD_TABS) }),
});
