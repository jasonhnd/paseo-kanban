// Waste risk: how much of a pool is on course to expire unused at reset, and how urgent that is.
// wastePct / wasteRisk are display only since DEMO_0124; needPerDay orders dispatchable pools. Pure functions.

/** Reset target. Same number as the progress line (pools-pace.ts PACE_TARGET). */
export const WASTE_TARGET_PCT = 97;
/** Days-left floor, so a pool a few minutes from reset does not get an unbounded score. */
export const WASTE_MIN_DAYS_LEFT = 0.5;

export interface WasteInput {
  projectedPct?: number | null;
  daysLeft?: number | null;
}

export interface WasteRisk {
  /** Points of the target projected to expire unused at reset: max(0, 97 − projectedPct). Null when unknown. */
  wastePct: number | null;
  /** wastePct ÷ days left (floor 0.5): extra points per day needed to avoid that waste. Null when unknown. */
  wasteRisk: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function wasteRiskOf(input: WasteInput): WasteRisk {
  const projected = input.projectedPct;
  if (typeof projected !== "number" || !Number.isFinite(projected)) return { wastePct: null, wasteRisk: null };
  const wastePct = Math.max(0, WASTE_TARGET_PCT - projected);
  const days = input.daysLeft;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return { wastePct: round1(wastePct), wasteRisk: null };
  return { wastePct: round1(wastePct), wasteRisk: round1(wastePct / Math.max(days, WASTE_MIN_DAYS_LEFT)) };
}

/** Which stop line a pool's need is measured against (shared/quota-adapters.ts): the leader pool, a sub pool, or any other. */
export type NeedKind = "leader" | "sub" | "pool";

/**
 * The stop line a pool is really dispatched up to, which is what "still to use" is measured against (DEMO_0124).
 * Same lines as pools-hard.ts hardReason:
 * - leader: the weekly stop in force (75% normally, so the leader keeps 25%; a burn or double week raises it).
 * - sub (Claude's Fable week): its own line, 97% in a normal week; during a burn week (`phaseLine`) the phase line
 *   (weeklyStop). Its needPerDay is then capped at its main pool's (capSubNeed), the target is not.
 * - every other pool: its own stop (plans.json stopPct, or 100% with a codex coupon in hand), never above 97%.
 */
export function needTargetPct(kind: NeedKind, weeklyStop: number, planStop: number | null, phaseLine = false): number {
  if (kind === "leader") return weeklyStop;
  if (kind === "sub" && phaseLine) return weeklyStop;
  return Math.min(WASTE_TARGET_PCT, planStop ?? WASTE_TARGET_PCT);
}

/**
 * Points per day still to use before reset: max(0, target − usedPct) ÷ max(daysLeft, 0.5). Null when the
 * percent or the days left is unknown. The bigger it is, the earlier the pool comes in the dispatch order.
 */
export function needPerDayOf(usedPct: number | null | undefined, daysLeft: number | null | undefined, targetPct: number): number | null {
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) return null;
  if (typeof daysLeft !== "number" || !Number.isFinite(daysLeft) || daysLeft < 0) return null;
  return round1(Math.max(0, targetPct - usedPct) / Math.max(daysLeft, WASTE_MIN_DAYS_LEFT));
}

export interface CappedNeed {
  needPerDay: number | null;
  /** The main pool's id when the cap lowered the value. */
  needCappedBy?: string;
}

/**
 * A sub pool (Fable) is a limit inside its main week: every job on it also spends the main pool, faster. So its need
 * is min(its own line's need, the main pool's need); room left in its own window does not make the main pool more urgent.
 */
export function capSubNeed(sub: number | null, main: number | null, mainId: string): CappedNeed {
  if (sub === null || main === null || main >= sub) return { needPerDay: sub };
  return { needPerDay: main, needCappedBy: mainId };
}
