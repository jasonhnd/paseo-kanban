import { TOKYO_OFFSET_MS, CLAUDE_RESET_WEEKDAY, CLAUDE_RESET_HOUR, DAY_MS, WEEK_MS, AFC_YES_MS, USED_DROP_FROM, USED_DROP_TO, USED_DROP_POINTS, RESET_WINDOW_MS } from "./reset-coupons-core";

/**
 * True when both readings belong to the same quota period.
 * Providers may report reset instants differently; differences up to ten minutes
 * are the same period (quota periods are at least five hours).
 */
export function sameResetWindow(prevResetsAt: string | null, resetsAt: string | null): boolean {
  if (!prevResetsAt || !resetsAt) return false;
  const prev = Date.parse(prevResetsAt);
  const next = Date.parse(resetsAt);
  if (Number.isNaN(prev) || Number.isNaN(next)) return false;
  return Math.abs(prev - next) <= 10 * 60_000;
}

/**
 * True when weekly usage falls hard inside the same weekly window, away from the natural reset.
 * A different `resetsAt` is the week turning over, not the coupon.
 */
export function usageLooksUsed(prev: number | null, next: number | null, now: number, resetsAt: string | null, prevResetsAt: string | null): boolean {
  if (prev === null || next === null) return false;
  if (!sameResetWindow(prevResetsAt, resetsAt)) return false;
  if (nearNaturalReset(now, resetsAt)) return false;
  return prev >= USED_DROP_FROM && next <= USED_DROP_TO && prev - next >= USED_DROP_POINTS;
}

export function nearNaturalReset(now: number, resetsAt: string | null, windowMs = RESET_WINDOW_MS): boolean {
  if (!resetsAt) return false;
  const end = Date.parse(resetsAt);
  if (Number.isNaN(end)) return false;
  return Math.abs(now - end) <= windowMs || Math.abs(now - (end - WEEK_MS)) <= windowMs;
}

/**
 * Start of the Claude week that contains `now`.
 * A future `resetsAt` is the end of that week, so the start is seven days earlier.
 * A `resetsAt` that has already passed means the next week has begun at that instant
 * (or later, if more than a week went by). With no reset time, use the previous Thursday 22:00 in Tokyo.
 */
export function claudeCouponWeekStart(now: number, resetsAt: string | null): number {
  if (resetsAt) {
    const end = Date.parse(resetsAt);
    if (!Number.isNaN(end)) {
      if (now < end) return end - WEEK_MS;
      if (now < end + WEEK_MS) return end;
    }
  }
  const tokyo = new Date(now + TOKYO_OFFSET_MS);
  const weekday = tokyo.getUTCDay();
  const minutes = tokyo.getUTCHours() * 60 + tokyo.getUTCMinutes();
  let daysBack = (weekday - CLAUDE_RESET_WEEKDAY + 7) % 7;
  if (daysBack === 0 && minutes < CLAUDE_RESET_HOUR * 60) daysBack = 7;
  const clock = Date.UTC(tokyo.getUTCFullYear(), tokyo.getUTCMonth(), tokyo.getUTCDate(), CLAUDE_RESET_HOUR, 0, 0) - daysBack * DAY_MS;
  return clock - TOKYO_OFFSET_MS;
}

/**
 * Drop a stored "used" mark.
 * Claude's CLI cannot read a coupon count, so a mark earlier than the current weekly window
 * (the week already reset) is void on its own.
 * When a count is available, a same-window confirm that still shows the coupon (count above zero,
 * and not lower than before) and is newer than the mark also clears it. That is the denial:
 * the coupon is still there. A lower count keeps the mark. Another reading that is still zero
 * keeps it too: running out of coupons is the use, not proof the coupon remains.
 */
export function shouldClearClaudeUsed(input: {
  usedAt: string | null;
  previousCount: number | null;
  liveCount: number | null;
  confirmedAt: string | null;
  /** Absent when the mark was saved before weekly windows were stored. */
  prevResetsAt: string | null;
  /** Start of the Claude week that contains now. A mark earlier than this is stale. */
  weekStartMs?: number | null;
}): boolean {
  if (!input.usedAt) return false;
  const used = Date.parse(input.usedAt);
  if (Number.isNaN(used)) return false;
  if (typeof input.weekStartMs === "number" && Number.isFinite(input.weekStartMs) && used < input.weekStartMs) return true;
  if (input.previousCount === null || input.liveCount === null) return false;
  if (input.liveCount <= 0) return false;
  if (input.liveCount < input.previousCount) return false;
  if (!input.prevResetsAt) return true;
  const confirmed = input.confirmedAt ? Date.parse(input.confirmedAt) : Number.NaN;
  if (Number.isNaN(confirmed)) return false;
  return confirmed > used;
}

export function countDropped(previous: number | null, next: number | null): boolean {
  if (previous === null || next === null) return false;
  return previous > 0 && next < previous;
}

export function afcJustUsed(at: string | null | undefined, now: number, windowMs = AFC_YES_MS): boolean {
  if (!at) return false;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  return now >= t && now - t <= windowMs;
}

/**
 * Points lost inside one weekly window, away from the natural reset.
 * Null when this reading is not a sudden drop.
 */
export function pointsDropped(prev: number | null, next: number | null, now: number, resetsAt: string | null, prevResetsAt: string | null): number | null {
  if (prev === null || next === null) return null;
  if (!sameResetWindow(prevResetsAt, resetsAt)) return null;
  if (nearNaturalReset(now, resetsAt)) return null;
  const points = prev - next;
  if (!(points >= USED_DROP_POINTS)) return null;
  return points;
}

export type DropClass = "coupon" | "official" | "suspected";

/**
 * A drop of at least 30 points in one window.
 * Fewer coupons means the coupon was used. Claude without that, and without a command we just ran, is only a suspicion.
 * ChatGPT with the same coupon count is an official reset. An unknown count is not called either.
 */
export function classifyUsageDrop(input: {
  company: "claude" | "codex";
  prevPct: number | null;
  nextPct: number | null;
  now: number;
  resetsAt: string | null;
  prevResetsAt: string | null;
  prevCount: number | null;
  nextCount: number | null;
  afcYesAt: string | null | undefined;
}): { kind: DropClass; points: number } | null {
  if (input.prevPct === null || input.nextPct === null) return null;
  const points = input.prevPct - input.nextPct;
  if (!(points >= USED_DROP_POINTS)) return null;
  const countsKnown = input.prevCount !== null && input.nextCount !== null;
  const countDown = countsKnown && input.nextCount! < input.prevCount!;
  const confirmed = afcJustUsed(input.afcYesAt, input.now);
  // ChatGPT needs the count from this same reading. Without it the drop stays unclassified.
  // A coupon moves the weekly reset forward, so fewer coupons is that shift even when the window changed.
  // A natural reset changes the window without spending a coupon.
  if (input.company === "codex" && !countsKnown) return null;
  if (input.company === "codex" && (countDown || confirmed)) return { kind: "coupon", points };
  if (!sameResetWindow(input.prevResetsAt, input.resetsAt)) return null;
  if (nearNaturalReset(input.now, input.resetsAt)) return null;
  if (countDown) return { kind: "coupon", points };
  if (confirmed) return { kind: "coupon", points };
  if (input.company === "claude") return { kind: "suspected", points };
  if (input.prevCount !== null && input.nextCount !== null && input.nextCount >= input.prevCount) return { kind: "official", points };
  return null;
}

/** True when this usage sample needs a ChatGPT coupon count read from the same moment. A stale confirm is not that count. */
export function codexCountReadNeeded(prevPct: number | null, nextPct: number | null, anchoredCount: number | null): boolean {
  if (typeof nextPct !== "number") return false;
  if (anchoredCount === null) return true;
  return typeof prevPct === "number" && prevPct - nextPct >= USED_DROP_POINTS;
}
