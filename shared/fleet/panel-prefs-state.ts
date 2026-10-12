import { DEFAULT_PANEL_PREFS, isFontStep, type PanelPrefs } from "./panel-prefs";
import { isPanelTab, type PanelTab } from "./panel-tabs";

/**
 * Local view state for the panel. The tab the user clicked lives here and is never
 * replaced by an RPC reply or a snapshot refresh; only the saved file seeds it.
 */
export interface PrefsView {
  tab: PanelTab | null;
  appearance: Pick<PanelPrefs, "fontStep"> | null;
}

export type PrefsAction =
  | { type: "select-tab"; tab: PanelTab }
  | { type: "set-appearance"; patch: Partial<Pick<PanelPrefs, "fontStep">>; base: PanelPrefs }
  | { type: "saved"; saved: unknown }
  | { type: "save-failed"; loaded: PanelPrefs | undefined };

export const INITIAL_PREFS_VIEW: PrefsView = { tab: null, appearance: null };

export function prefsReducer(state: PrefsView, action: PrefsAction): PrefsView {
  switch (action.type) {
    case "select-tab":
      return { ...state, tab: action.tab };
    case "set-appearance":
      return { ...state, appearance: { fontStep: action.base.fontStep, ...state.appearance, ...action.patch } };
    case "saved": {
      // A server older than the client may drop or omit fields; keep only valid ones, never the tab.
      const raw = (action.saved && typeof action.saved === "object" ? action.saved : {}) as Record<string, unknown>;
      const current = state.appearance;
      if (!current) return state;
      return {
        ...state,
        appearance: {
          fontStep: isFontStep(raw.fontStep) ? raw.fontStep : current.fontStep,
        },
      };
    }
    case "save-failed": {
      const base = action.loaded ?? DEFAULT_PANEL_PREFS;
      return { ...state, appearance: { fontStep: base.fontStep } };
    }
  }
}

export function resolvePrefs(view: PrefsView, loaded: PanelPrefs | undefined): PanelPrefs {
  const base = loaded ?? DEFAULT_PANEL_PREFS;
  return {
    fontStep: view.appearance?.fontStep ?? base.fontStep,
    tab: view.tab ?? (isPanelTab(base.tab) ? base.tab : DEFAULT_PANEL_PREFS.tab),
  };
}
