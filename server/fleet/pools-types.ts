/// <reference types="node" />
// Snapshot row and the options writePoolStatus / poolStatus take. Behavior lives in the other pools-* modules.
import type { PoolEntry } from "../../shared/fleet/quota-adapters";
import type { ClaudeBurnClock, CodexCreditsInput } from "../../shared/fleet/reset-coupons";
import type { UsageWindow } from "../../shared/fleet/usage";
import type { PaceState } from "./pools-pace";
import type { ClaudeUsedReading } from "./pools-unread";

import type { QuotaState, UnknownQuotaOptions } from "../../shared/fleet/unknown-quota";

export interface PoolStatus extends QuotaState {
  adapter?: string;
  providers?: string[];
  parent?: string | null;
  reservePct?: number;
  /** Source/batch or AFC sample clock on private snapshots, independent of publication. */
  observedAt?: string | null;
  quotaProtection?: "pause" | "none";
  readingExpiresAt?: string | null;
  plan: string;
  window: string | null;
  usedPct: number | null;
  resetsAt: string | null;
  projectedPct: number | null;
  runsOutAt: string | null;
  burnRatePctPerHour?: number | null;
  forecastConfidence?: "high" | "low" | "none";
  verdict: UsageWindow["verdict"];
  /** False: do not start new work on this pool. */
  dispatchable: boolean;
  /**
   * True: usable, but another pool for the same role comes first.
   * A pace hold also sets this while dispatchable is false, so a busy alternative queues instead of falling back.
   */
  deprioritize: boolean;
  /** True: dispatchable and behind the progress line — use this pool first. */
  prefer: boolean;
  /** Share of the period already passed. */
  elapsedPct: number | null;
  /** Where usage should be if it tracked the target evenly. Null when the period is unknown. */
  pacePct: number | null;
  /** Days until reset. */
  daysLeft: number | null;
  /** Length of the period in days. */
  periodDays: number | null;
  /** (target − used) / days left. How much of the period can still be spent per day. */
  dailyPct: number | null;
  /** Reading delta in the period ÷ runs on this pool over the same span. Null until two readings exist. */
  perRunPct: number | null;
  /** dailyPct / perRunPct. Null when either side is unknown. */
  dailyRuns: number | null;
  paceState: PaceState;
  reason: string;
  /**
   * Points of the 97% target projected to expire unused at reset: max(0, 97 − projectedPct).
   * Null when the projection is unknown (for example right after reset). DEMO_0122.
   */
  wastePct?: number | null;
  /**
   * wastePct ÷ days left (floor 0.5 day): extra points per day this pool needs to avoid waste.
   * Display only since DEMO_0124 (needPerDay orders the pools). Null when unknown.
   */
  wasteRisk?: number | null;
  /** The stop line needPerDay aims at (waste-risk.ts needTargetPct). DEMO_0124. */
  needTargetPct?: number;
  /**
   * Points per day still to use before reset: max(0, needTargetPct − usedPct) ÷ max(daysLeft, 0.5).
   * Dispatchable pools are ordered by it, biggest first. Null when the percent or the days left is unknown. DEMO_0124.
   */
  needPerDay?: number | null;
  /** Sub pools (Claude's Fable week) only: the main pool's id when its needPerDay was capped at the main week's (DEMO_0124). */
  needCappedBy?: string;
  /**
   * Place in the dispatch pool order in force (0 first): the needPerDay order, or plans.json dispatchPriority
   * while that override lasts. Null when the pool is not in the order. Dispatchable pools sort by it first.
   */
  priorityIndex?: number | null;
  /** The order's `until` (at most 30 minutes ahead), on listed rows only, so a stale snapshot drops its index. */
  priorityUntil?: string;
  /**
   * When set, only profiles whose `role` or `candidateFor` is listed may take new work.
   * Absent or empty means every role on a dispatchable pool may take work.
   * Explicit plan limits persist; limits from a dated reviewer exception end with that exception.
   */
  onlyRoles?: string[];
  /**
   * During a named burn week, these profiles ignore a pause mark in notes and a paused stand-in mark.
   * A pool that cannot take work still pauses them. Omitted outside that week.
   */
  unpauseProfiles?: string[];
}

export interface CursorReadMeta {
  ok: boolean;
  readAt: string | null;
  usingManual: boolean;
  manualAt: string | null;
  error: string | null;
  /** True when `cursor-agent` is sitting on the login screen or status says Not logged in. */
  loggedOut?: boolean;
  /** True when AFC's own Cursor refresh was rejected. */
  linkBroken?: boolean;
  /** Homepage sentence for a token-file problem. Shown even when the usage numbers themselves are ok. */
  alarm?: string | null;
  /** False when the cursor-agent screen is turned off on purpose. Missing means on. */
  screenRead?: boolean;
}

export interface SuperGrokReadMeta {
  unreadSince: string | null;
  /** Yellow sentence once the live percent has been missing for an hour. */
  alarm: string | null;
  loginLost: boolean;
  loginAlarm: string | null;
  via: "provider" | "screen" | "manual" | "none";
  /** Quota-page source sentence for the SuperGrok card. */
  sourceText?: string | null;
  providerStuck?: boolean;
}

export interface PoolStatusOptions {
  unknownQuota?: UnknownQuotaOptions;
  now?: number;
  /** Pools the plans define (shared/quota-adapters.ts). Omitted: built from the plans passed in. */
  catalog?: PoolEntry[];
  /** Pools that stand in for each other. Omitted: every other main pool of the catalog. */
  siblings?: Record<string, string[]>;
  /**
   * Claude's main week is inside an unused-coupon double week.
   * The hard stop rises from 75% to 90%, the progress line aims at ~90% by mid-week,
   * being ahead does not pause the pool, and the snapshot marks it prefer.
   * Ignored for Claude when `claudeBurn` is set.
   */
  claudeDoubleWeek?: boolean;
  /**
   * Named burn week for the Claude pools (the main week and its Fable week).
   * Front: stop at 100%, 5-hour pause at 90%, pace hits 100% in 3.5 days, always prefer.
   * Back: stop returns to 75%, 5-hour pause to 70%, pace runs from the post-use reading to ~97% at the week's end, and the pool still prefers so Claude stays ahead of other families.
   */
  claudeBurn?: (ClaudeBurnClock & { baselinePct?: number; usedAtMs?: number }) | null;
  /**
   * Last successful usedPct of the Claude main pool. Used only when this refresh did not read one.
   * `null` means there is no previous reading. Omit it for the same result.
   */
  priorClaude?: ClaudeUsedReading | null;
  /** Last successful usedPct of the Codex pool. Same 30-minute rule; a miss with nothing fresh enough stops the pool. */
  priorCodex?: ClaudeUsedReading | null;
  /**
   * ChatGPT coupons still in hand. An unexpired coupon spends the reserve:
   * the progress line aims at 100% in 3.5 days, and dispatch stops at 100% to wait for the coupon.
   * The ask-to-use reminder is a separate line and starts at 97%.
   * A missing expiry is not a coupon in hand.
   */
  codexCouponCount?: number;
  /**
   * Earliest ChatGPT coupon expiry already read with `codexCouponCount`.
   * Burn mode and prefer apply only when the count is above zero and this instant is still in the future.
   */
  codexCouponExpiresAt?: string | null;
  /**
   * User-authorised ChatGPT burn week (`burnWeek` on the codex coupon in plans.json).
   * Inside it, with a coupon in hand, the Codex pool is exempt from neverPrefer: the pace line is unchanged (3.5 days from the quota
   * week start to 100%), it is preferred whenever dispatchable even when ahead, and the stop line is 100%. Absent or outside the window,
   * DEMO_0070 applies unchanged. Remove `burnWeek` from plans.json to turn it off.
   */
  codexBurnWeek?: { start: string; end: string } | null;
  /**
   * ChatGPT credits for the third layer. Omitted or null leaves a spent week on the weekly stop.
   * The layer itself stays quiet before its start date.
   */
  codexCredits?: CodexCreditsInput | null;
  /**
   * Case-insensitive substrings from afc.config.json `bannedProviders`.
   * A plan whose id, name, or providers contain one gets no pool. Omitted or empty excludes nothing.
   */
  bannedProviders?: readonly string[];
}
