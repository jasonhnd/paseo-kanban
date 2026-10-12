/// <reference types="node" />
// Hard stops. These are not softened when a sibling pool is already down.
import { BURN_FRONT_STOP_PCT, couponInHand } from "../../shared/fleet/reset-coupons";
import { CODEX_CLI, handCopyOf, isLeaderPool, type PoolEntry } from "../../shared/fleet/quota-adapters";
import type { UsageWindow } from "../../shared/fleet/usage";
import { t } from "../../shared/fleet/i18n";
import { reviewerStopReason, type ReviewerException } from "./pools-reviewer";
import { EXHAUSTED, handCopyDispatch, SUPERVISOR_WEEKLY_RESERVE } from "./pools-windows";

/** plans.json `stopPct`, when it is a real percent. Missing or unusable means the pool's existing line. */
export function configuredStopPct(plan: { stopPct?: unknown }): number | null {
  const raw = plan.stopPct;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 100) return null;
  return raw;
}

function configuredStopReason(pool: PoolEntry, used: number, stopPct: number, keepReserve = true): string {
  const period = pool.period === "month" ? t("pools.hard.thisMonth") : t("pools.hard.thisWeek");
  const vars = { period, used: Math.round(used), stop: stopPct };
  if (!keepReserve) return t("pools.hard.planStopCoupon", vars);
  return t("pools.hard.planStop", vars);
}

function subPhaseHard(used: number | null, weeklyStop: number, atCapReason: string | null): string | null {
  if (used === null || used < weeklyStop) return null;
  if (atCapReason && weeklyStop >= BURN_FRONT_STOP_PCT) return atCapReason;
  return t("pools.hard.leaderReserve", { used: Math.round(used) });
}

function leaderWeekHard(
  used: number | null,
  sessionUsed: number | null,
  sessionPause: number,
  exception: ReviewerException | null,
  weeklyStop: number,
  atCapReason: string | null,
): string | null {
  if (sessionUsed !== null && sessionUsed >= sessionPause) return t("pools.hard.sessionPause", { used: Math.round(sessionUsed) });
  if (exception && used !== null && used >= exception.stopPct) return reviewerStopReason(used, exception);
  if (used === null || used < weeklyStop) return null;
  if (exception && used < exception.stopPct) return null;
  if (atCapReason && weeklyStop >= BURN_FRONT_STOP_PCT) return atCapReason;
  if (weeklyStop > SUPERVISOR_WEEKLY_RESERVE) return t("pools.hard.doubleWeekReserve", { used: Math.round(used), stop: weeklyStop });
  return t("pools.hard.leaderReserve", { used: Math.round(used) });
}

/** The adapter's hand-copy rule, when this window's source is one it covers. Undefined when it does not apply. */
function handCopyHard(pool: PoolEntry, w: UsageWindow | undefined): string | null | undefined {
  const rule = handCopyOf(pool);
  if (!rule || !w || !rule.sources.some((source) => source === w.source)) return undefined;
  const flags = handCopyDispatch(w, rule, pool.names.line ?? pool.id);
  return flags.dispatchable ? null : flags.reason;
}

function manualOrExhaustedHard(
  pool: PoolEntry,
  w: UsageWindow | undefined,
  used: number | null,
  planStop: number | null,
  atCapReason: string | null,
  keepReserve: boolean,
): string | null {
  const copied = handCopyHard(pool, w);
  if (copied !== undefined) return copied;
  // atCapReason reaches here only for a Codex pool with a coupon in hand.
  const codex = pool.adapter === CODEX_CLI;
  if (planStop !== null && used !== null && used >= planStop) {
    if (atCapReason && codex) return atCapReason;
    return configuredStopReason(pool, used, planStop, keepReserve);
  }
  if (atCapReason && codex && planStop !== null && used !== null && used < planStop) return null;
  return exhaustedHard(pool, used);
}

function exhaustedHard(pool: PoolEntry, used: number | null): string | null {
  if (used === null || used < EXHAUSTED) return null;
  if (pool.parent !== null) return t("pools.hard.subWeekSpent", { name: pool.names.line ?? pool.id });
  const rule = handCopyOf(pool);
  if (rule) return rule.spentText(used, EXHAUSTED, pool.names.line ?? pool.id);
  return t("pools.hard.weekSpent");
}

export function hardReason(
  pool: PoolEntry,
  w: UsageWindow | undefined,
  sessionUsed: number | null,
  weeklyStop: number,
  exception: ReviewerException | null,
  planStop: number | null,
  sessionPause: number,
  atCapReason: string | null,
  phaseLine: boolean,
  keepReserve: boolean,
): string | null {
  const used = w?.usedPct ?? null;
  if (pool.parent !== null && phaseLine) return subPhaseHard(used, weeklyStop, atCapReason);
  if (isLeaderPool(pool)) return leaderWeekHard(used, sessionUsed, sessionPause, exception, weeklyStop, atCapReason);
  return manualOrExhaustedHard(pool, w, used, planStop, atCapReason, keepReserve);
}

/**
 * True when a coupon count was actually read and the earliest coupon has not expired.
 * A missing count, a non-positive count, or a missing/invalid expiry is not a coupon in hand.
 */
export function codexCouponInHand(count: number | null | undefined, expiresAt: string | null | undefined, now: number): boolean {
  return couponInHand(count, expiresAt, now);
}

/** Reason on a pool with nothing to say: the hand-copy note when nothing was copied, else "can take work". */
export function idleReason(pool: PoolEntry, w: UsageWindow | undefined): string {
  const rule = handCopyOf(pool);
  if (rule && rule.sources.includes("none") && (w?.usedPct === null || w?.usedPct === undefined)) return rule.emptyText;
  return t("pools.pace.canDispatch");
}
