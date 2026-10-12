/// <reference types="node" />
// Per-window dispatch stops that are not the progress line: hand-copied percentages, a fresh
// Cursor logout, and the shared percent caps the status assembly applies.
import { NORMAL_CLAUDE_SESSION_PCT } from "../../shared/fleet/reset-coupons";
import { cursorLogoutIsFresh, normalizeCursorLoginState } from "../../shared/fleet/cursor-login";
import { adapterSpec, CURSOR_API, GROK_CLI, type HandCopy } from "../../shared/fleet/quota-adapters";
import type { UsageWindow } from "../../shared/fleet/usage";
import { t } from "../../shared/fleet/i18n";
import { tokyoLabel } from "./pools-pace";

/** the configured quota policy: keep 25% of the supervisor pool's week for the supervisor; pause new work at 70% of its 5-hour window. */
export const SUPERVISOR_WEEKLY_RESERVE = 75;
export const SUPERVISOR_SESSION_PAUSE = NORMAL_CLAUDE_SESSION_PCT;
/**
 * the configured quota policy: a percentage copied by hand stops taking work at 80%.
 * A cursor-api plan falls back to its plans.json `manual.usedPct` only when `/usage` could not be read.
 * Paseo's listUsage balance is total spend across both blocks and is shown for reference only;
 * `overageBilling` is display only. Neither decides dispatch.
 */
export const MANUAL_STOP = 80;
/** Written on the cursor-api pools while a fresh `cursor-agent status` says logged out. */
export function cursorLogoutHoldReason(): string {
  return t("pools.windows.cursorLogoutHold");
}
/** At or above this percent the period is spent. */
export const EXHAUSTED = 97;

export interface SuperGrokWindow {
  usedPct: number | null;
  verdict: UsageWindow["verdict"];
  resetsAt: string | null;
}

export interface SuperGrokDispatch {
  dispatchable: boolean;
  deprioritize: boolean;
  reason: string;
}

/**
 * Kept so the previous short-window helper stays available to its tests.
 * The snapshot no longer calls it: a pool that is merely ahead of the progress line
 * pauses until the line catches up, instead of staying paused for the whole week.
 */
export function supergrokDispatch(weekly: SuperGrokWindow | undefined, cursorDispatchable: boolean): SuperGrokDispatch {
  const used = weekly?.usedPct ?? 0;
  if (used >= EXHAUSTED) return { dispatchable: false, deprioritize: false, reason: t("pools.hard.weekSpent") };
  if (weekly?.verdict === "short") return shortSuperGrok(weekly, cursorDispatchable);
  return { dispatchable: true, deprioritize: false, reason: t("pools.pace.canDispatch") };
}

function shortSuperGrok(weekly: SuperGrokWindow, cursorDispatchable: boolean): SuperGrokDispatch {
  if (!cursorDispatchable) {
    return { dispatchable: true, deprioritize: true, reason: t("pools.windows.cursorDownUseGrok") };
  }
  const when = tokyoLabel(weekly.resetsAt);
  const until = when === t("pools.pace.reset") ? t("pools.windows.beforeReset") : t("pools.windows.beforeWhen", { when });
  return {
    dispatchable: false,
    deprioritize: true,
    reason: t("pools.windows.shortGrok", { until }),
  };
}

export interface CursorWindow {
  usedPct: number | null;
}

export interface CursorDispatch {
  dispatchable: boolean;
  reason: string;
}

/**
 * Stop the cursor-api pools only when login is "out" and checkedAt is at most 15 minutes old.
 * in, unknown, a missing file, and a stale reading do not stop dispatch.
 */
export function cursorLogoutBlocksDispatch(raw: unknown, now: number): boolean {
  const state = normalizeCursorLoginState(raw);
  return cursorLogoutIsFresh(state.login, state.checkedAt, now);
}

/** A hand-copied percent under an adapter's rule: stop at MANUAL_STOP. No percentage counts as dispatchable. */
export function handCopyDispatch(w: CursorWindow | undefined, rule: HandCopy, name: string): CursorDispatch {
  const used = w?.usedPct;
  if (used === null || used === undefined) return { dispatchable: true, reason: rule.emptyText };
  if (used < MANUAL_STOP) return { dispatchable: true, reason: t("pools.pace.canDispatch") };
  return { dispatchable: false, reason: rule.stopText(used, MANUAL_STOP, name) };
}

function adapterHandCopy(adapter: typeof CURSOR_API | typeof GROK_CLI): HandCopy {
  const rule = adapterSpec(adapter).handCopy;
  if (!rule) throw new Error(`${adapter} has no hand-copy rule`);
  return rule;
}

/**
 * Hand-copied Cursor percentage: stop at MANUAL_STOP. No percentage counts as dispatchable.
 * A live `/usage` reading does not use this stop; it uses the progress line and the 97% cap.
 */
export function cursorDispatch(w: CursorWindow | undefined): CursorDispatch {
  return handCopyDispatch(w, adapterHandCopy(CURSOR_API), "");
}

/**
 * Hand-copied SuperGrok percentage: stop at MANUAL_STOP.
 * A live Paseo or grok `/usage show` reading does not use this stop.
 * No percentage counts as dispatchable.
 */
export function supergrokManualDispatch(w: CursorWindow | undefined): CursorDispatch {
  return handCopyDispatch(w, adapterHandCopy(GROK_CLI), "");
}
