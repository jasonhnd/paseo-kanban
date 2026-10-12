/// <reference types="node" />
// Progress line: where usage should be by this point in the period, and whether that makes a pool
// preferred, steady, or held. Hard stops and the snapshot assembly live in pools-status.ts.
import {
  BURN_BACK_TARGET_PCT,
  BURN_FRONT_DAYS,
  BURN_FRONT_STOP_PCT,
  DAY_MS as RESET_DAY_MS,
  DOUBLE_WEEK_STOP_PCT,
  burnBackPacePct,
  burnFrontPacePct,
  doubleWeekPacePct,
} from "../../shared/fleet/reset-coupons";
import type { PoolPeriod } from "../../shared/fleet/quota-adapters";
import { t } from "../../shared/fleet/i18n";

/**
 * Progress line (docs/QUOTA-MANAGEMENT.md): target × share of the period already elapsed.
 * Every pool, including Claude's main week, aims at 97%. 75% is only the hard stop that
 * reserves the rest of that week for the supervisor. More than AHEAD points over the line:
 * stop dispatching, unless that plan sets pacePause to false. More than BEHIND points under
 * it: prefer, except pools marked neverPrefer (shared/quota-adapters.ts).
 */
export const PACE_TARGET = 97;
export const PACE_AHEAD = 5;
export const PACE_BEHIND = 10;
const DAY_MS = 24 * 60 * 60_000;

// Pools that can stand in for each other: shared/quota-adapters.ts paceSiblings (every other main pool).

/**
 * the configured quota policy "dispatch by quota", the old projection rule kept as a pure helper.
 * The snapshot itself now uses the progress line (`paceOf`), not this projection.
 */
const PREFER_BELOW = 60;
const PREFER_MIN_ELAPSED = 20;
// Plans may disable preference with `neverPrefer`; an explicit burn window can override it.

export type PaceState = "ahead" | "behind" | "steady" | "stopped" | "closed" | "unknown";

/** Japan has no daylight saving; snapshot reasons show instants in Tokyo time. */
export function tokyoLabel(iso: string | null): string {
  if (!iso) return t("pools.pace.reset");
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return t("pools.pace.reset");
  const tokyo = new Date(ms + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${tokyo.getUTCMonth() + 1}/${tokyo.getUTCDate()} ${pad(tokyo.getUTCHours())}:${pad(tokyo.getUTCMinutes())}`;
  return t("pools.pace.tokyoTime", { date });
}

export interface PreferInput {
  dispatchable: boolean;
  deprioritize: boolean;
  projectedPct: number | null;
  elapsedPct: number | null;
}

/** Old projection helper. The snapshot uses `paceOf` instead. */
export function preferPool(neverPrefer: boolean, s: PreferInput): boolean {
  if (neverPrefer || !s.dispatchable || s.deprioritize) return false;
  if (s.projectedPct === null || s.elapsedPct === null) return false;
  return s.projectedPct < PREFER_BELOW && s.elapsedPct >= PREFER_MIN_ELAPSED;
}

/** Same day and time one calendar month earlier, clamped to the last day of a shorter month. */
export function oneMonthBefore(d: Date): Date {
  const year = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const month = (d.getUTCMonth() + 11) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/** Progress-line target. Claude's 75% reserve is a hard stop in `hardReason`, not this target. */
export function paceTarget(_pool: string): number {
  return PACE_TARGET;
}

/**
 * Period start and end, by the pool's period (shared/quota-adapters.ts). month: one calendar month before reset
 * (Cursor, monthly hand copies). week: 7 days before reset (SuperGrok, ChatGPT). window: the window the provider
 * reported (Claude main and Fable: the Thursday 22:00 Tokyo week), else 7 days before reset.
 */
export function periodBounds(period: PoolPeriod, resetsAt: string | null, startsAt: string | null): { start: number; end: number } | null {
  const end = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (Number.isNaN(end)) return null;
  if (period === "month") return { start: oneMonthBefore(new Date(end)).getTime(), end };
  if (period === "week") return { start: end - 7 * DAY_MS, end };
  const start = startsAt ? Date.parse(startsAt) : Number.NaN;
  if (!Number.isNaN(start) && start < end) return { start, end };
  return { start: end - 7 * DAY_MS, end };
}

export interface Pace {
  elapsedRatio: number | null;
  pacePct: number | null;
  daysLeft: number | null;
  periodDays: number | null;
  dailyPct: number | null;
  /** used − pace. Positive means ahead of the line. Null when it cannot be judged. */
  gapPct: number | null;
  /** When the line reaches the current usage, if that instant is still inside the period. */
  catchUpAt: string | null;
}

const NO_PACE: Pace = {
  elapsedRatio: null,
  pacePct: null,
  daysLeft: null,
  periodDays: null,
  dailyPct: null,
  gapPct: null,
  catchUpAt: null,
};

export interface BurnPaceClock {
  startMs: number;
  endMs: number;
  baselinePct?: number;
  usedAtMs?: number;
}

/** Progress line at `now`. A period that has already ended is not judged (gap stays null). */
export function paceOf(
  pool: string,
  usedPct: number | null,
  bounds: { start: number; end: number } | null,
  now: number,
  mode: "normal" | "double" | "burn-front" | "burn-back" = "normal",
  burn?: BurnPaceClock,
): Pace {
  if (!bounds || bounds.end <= bounds.start) return NO_PACE;
  const length = bounds.end - bounds.start;
  const periodDays = length / DAY_MS;
  const target = paceTarget(pool);
  if (now >= bounds.end) {
    return { elapsedRatio: 1, pacePct: target, daysLeft: 0, periodDays, dailyPct: null, gapPct: null, catchUpAt: null };
  }
  const elapsed = Math.min(1, Math.max(0, (now - bounds.start) / length));
  const line = paceLine(mode, elapsed, target, now, burn);
  const daysLeft = (bounds.end - now) / DAY_MS;
  const dailyPct = usedPct === null || daysLeft <= 0 ? null : Math.max(0, (line.target - usedPct) / daysLeft);
  const gapPct = usedPct === null ? null : usedPct - line.pacePct;
  const catchUpAt = catchUpInstant(mode, usedPct, line.target, bounds, now, burn);
  return { elapsedRatio: elapsed, pacePct: line.pacePct, daysLeft, periodDays, dailyPct, gapPct, catchUpAt };
}

function paceLine(
  mode: "normal" | "double" | "burn-front" | "burn-back",
  elapsed: number,
  target: number,
  now: number,
  burn: BurnPaceClock | undefined,
): { pacePct: number; target: number } {
  if (mode === "double") return { pacePct: doubleWeekPacePct(elapsed), target: DOUBLE_WEEK_STOP_PCT };
  if (mode === "burn-front" && burn) return { pacePct: burnFrontPacePct(now, burn.startMs), target: BURN_FRONT_STOP_PCT };
  if (mode === "burn-back" && burn) {
    return {
      pacePct: burnBackPacePct(now, burn.usedAtMs ?? burn.startMs, burn.endMs, burn.baselinePct ?? 0),
      target: BURN_BACK_TARGET_PCT,
    };
  }
  return { pacePct: target * elapsed, target };
}

function catchUpInstant(
  mode: "normal" | "double" | "burn-front" | "burn-back",
  usedPct: number | null,
  lineTarget: number,
  bounds: { start: number; end: number },
  now: number,
  burn: BurnPaceClock | undefined,
): string | null {
  if (usedPct === null || usedPct <= 0 || usedPct >= lineTarget) return null;
  const length = bounds.end - bounds.start;
  const t = mode === "burn-front" && burn
    ? burn.startMs + (usedPct / lineTarget) * BURN_FRONT_DAYS * RESET_DAY_MS
    : bounds.start + (usedPct / lineTarget) * length;
  const end = mode === "burn-front" && burn ? burn.endMs : bounds.end;
  if (t > now && t <= end) return new Date(t).toISOString();
  return null;
}

export interface PaceFlags {
  dispatchable: boolean;
  deprioritize: boolean;
  prefer: boolean;
  paceState: PaceState;
  paceHold: boolean;
  hard: boolean;
  reason: string;
}

function aheadReason(used: number, pace: number, catchUpAt: string | null): string {
  const tail = catchUpAt ? t("pools.pace.catchUpAt", { when: tokyoLabel(catchUpAt) }) : t("pools.pace.noCatchUp");
  return t("pools.pace.ahead", { used: Math.round(used), pace: Math.round(pace), tail });
}

/**
 * First pass, before the sibling exception.
 * Hard stops (97%, hand-copied 80%, Claude's 75% reserve, the 5-hour 70% pause, "do not dispatch")
 * are passed in and are not softened later. `pacePause` defaults to true; false skips only the
 * ahead hold (the pool stays ahead, and still dispatchable, without prefer).
 */
export function judgePace(
  neverPrefer: boolean,
  usedPct: number | null,
  pace: Pace,
  hardReason: string | null,
  idleReason: string,
  pacePause = true,
  allowPrefer = false,
): PaceFlags {
  if (hardReason) return stoppedFlags(hardReason);
  if (usedPct === null || pace.gapPct === null || pace.pacePct === null) return unknownFlags(idleReason);
  if (pace.gapPct > PACE_AHEAD) return aheadFlags(usedPct, pace, pacePause);
  if (-pace.gapPct > PACE_BEHIND && (allowPrefer || !neverPrefer)) return behindFlags();
  return steadyFlags();
}

function stoppedFlags(reason: string): PaceFlags {
  return { dispatchable: false, deprioritize: false, prefer: false, paceState: "stopped", paceHold: false, hard: true, reason };
}

function unknownFlags(reason: string): PaceFlags {
  return { dispatchable: true, deprioritize: false, prefer: false, paceState: "unknown", paceHold: false, hard: false, reason };
}

function aheadFlags(usedPct: number, pace: Pace, pacePause: boolean): PaceFlags {
  if (!pacePause) {
    return {
      dispatchable: true,
      deprioritize: false,
      prefer: false,
      paceState: "ahead",
      paceHold: false,
      hard: false,
      reason: t("pools.pace.aheadNoPause", { used: Math.round(usedPct), pace: Math.round(pace.pacePct ?? 0) }),
    };
  }
  return {
    dispatchable: false,
    deprioritize: true,
    prefer: false,
    paceState: "ahead",
    paceHold: true,
    hard: false,
    reason: aheadReason(usedPct, pace.pacePct ?? 0, pace.catchUpAt),
  };
}

function behindFlags(): PaceFlags {
  return { dispatchable: true, deprioritize: false, prefer: true, paceState: "behind", paceHold: false, hard: false, reason: t("pools.pace.behind") };
}

function steadyFlags(): PaceFlags {
  return { dispatchable: true, deprioritize: false, prefer: false, paceState: "steady", paceHold: false, hard: false, reason: t("pools.pace.canDispatch") };
}

/** Pace-hold exception: keep the pool dispatchable, but behind every sibling, when those siblings are all stopped. */
export function softenPaceHold(flags: PaceFlags, usedPct: number | null, pacePct: number | null, hasSibling: boolean, siblingsAllDown: boolean): PaceFlags {
  if (!flags.paceHold || flags.hard || !hasSibling || !siblingsAllDown) return flags;
  const used = usedPct === null ? "?" : String(Math.round(usedPct));
  const line = pacePct === null ? "?" : String(Math.round(pacePct));
  return {
    ...flags,
    dispatchable: true,
    deprioritize: true,
    prefer: false,
    reason: t("pools.pace.aheadSoftened", { used, line }),
  };
}
