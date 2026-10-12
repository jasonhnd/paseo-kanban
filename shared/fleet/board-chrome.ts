import type { FontStep, PanelPrefs } from "./panel-prefs";
import type { PanelTab } from "./panel-tabs";
import { t } from "./i18n";

export const SNAPSHOT_MS = 10_000;
export const INSIGHTS_MS = 60_000;
export const USAGE_WARM_MS = 1_500;
/** The server answers board.snapshot from its cache; a snapshot older than this when it arrives is caught up on soon. */
export const SNAPSHOT_STALE_MS = 2 * SNAPSHOT_MS;
export const SNAPSHOT_CATCH_UP_MS = 2_000;

/**
 * When to ask for the snapshot again. The server hands back its last snapshot at once and builds the
 * next one in the background, so an old one (panel opened after a long pause) is followed up quickly.
 */
export function snapshotRefetchMs(generatedAt: string | undefined, now: number): number {
  const at = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (Number.isNaN(at)) return SNAPSHOT_MS;
  return now - at > SNAPSHOT_STALE_MS ? SNAPSHOT_CATCH_UP_MS : SNAPSHOT_MS;
}

/** Tabs drawn from the board snapshot; they are pre-mounted in this order and then kept alive. */
export const SNAPSHOT_TABS: readonly PanelTab[] = ["leader", "usage", "roles", "records", "overview"];

/** One-line hint under each tab's title; read at render time so it follows the panel language. */
export const TAB_HINT: Readonly<Record<PanelTab, string>> = {
  overview: "",
  get leader() { return t("board.tabHint.leader"); },
  get quota() { return t("board.tabHint.quota"); },
  get usage() { return t("board.tabHint.usage"); },
  get roles() { return t("board.tabHint.roles"); },
  get records() { return t("board.tabHint.records"); },
  get access() { return t("board.tabHint.access"); },
};

export const FONT_OPTIONS: ReadonlyArray<{ value: FontStep; readonly label: string }> = [
  { value: "sm", get label() { return t("board.font.sm"); } },
  { value: "md", get label() { return t("board.font.md"); } },
  { value: "lg", get label() { return t("board.font.lg"); } },
];

export function prefsSaveFailed(): string {
  return t("board.prefsSaveFailed");
}

export function boardWarnings(snap: readonly string[] | undefined, insights: readonly string[] | undefined): string[] {
  return [...(snap ?? []), ...(insights ?? [])];
}

export function splitPrefsPatch(patch: Partial<PanelPrefs>): {
  tab: PanelTab | undefined;
  appearance: Partial<Omit<PanelPrefs, "tab">>;
} {
  const { tab, ...appearance } = patch;
  return { tab, appearance };
}

export function appearanceDirty(appearance: object): boolean {
  return Object.keys(appearance).length > 0;
}

export function openChannel(platform: string): "desktop" | "phone" {
  return platform === "web" ? "desktop" : "phone";
}

export function desktopOpenNotice(ok: boolean, message: string): string | null {
  return ok ? null : message;
}

export function phoneLinkPlan(url: string | null | undefined, message: string): { notice: string | null; url: string | null } {
  if (!url) return { notice: message, url: null };
  return { notice: null, url };
}

export function phoneOpenError(error: unknown): string {
  return t("board.openFailed", { error: String(error) });
}

export function shouldWarmUsage(ready: boolean, warmed: boolean): boolean {
  return ready && !warmed;
}
