import { TOKYO_OFFSET_MS } from "./dispatch";
import { t } from "./i18n";
import { anyLanguage, reasonSaysNoDispatch, reasonWaitsForWindow, replaceNumbers } from "./quota-reason";

/** The leader pool's week reserves the rest for the supervisor. Every other dispatch pool stops at 97%. */
export const CLAUDE_STOP_PCT = 75;
export const OTHER_STOP_PCT = 97;

export type QuotaTone = "green" | "yellow" | "red";

/** What a line needs to know about its pool (shared/quota-adapters.ts PoolEntry). */
export interface QuotaPoolTraits {
  /** The leader pool: its week stops at CLAUDE_STOP_PCT. */
  leader?: boolean;
  /** The adapter has a hand-copy rule, so a hand-copied percent stops at `manualStopPct`. */
  handCopy?: boolean;
}

export interface QuotaInput extends QuotaPoolTraits {
  key: string;
  /** Display name (PoolNames.line). Missing: the key. */
  name?: string;
  /** Monthly pool: the line says "this month" instead of "this week". */
  monthly?: boolean;
  dispatchable: boolean;
  prefer: boolean;
  reason: string;
  usedPct: number | null;
  pacePct: number | null;
  paceState?: string | null;
  elapsedPct?: number | null;
  resetsAt?: string | null;
  /** The live read failed and dispatch is using the hand-copied percentage. */
  usingManual?: boolean;
  /** `server/pools.ts` `MANUAL_STOP`. Used only when `usingManual` is set. */
  manualStopPct?: number;
  /** plans.json `stopPct` for this pool. When set, this is the red line. */
  stopPct?: number;
}

export interface QuotaLine {
  name: string;
  usedPct: number | null;
  pacePct: number | null;
  stopPct: number;
  text: string;
  tone: QuotaTone;
  hitsStopAt: string | null;
}

/**
 * The leader pool's week stops at 75%. A pool with a hand-copy rule on a hand-copied percentage stops at
 * `manualStopPct` (pools.ts MANUAL_STOP, 80%). Everyone else stops at 97%.
 */
export function stopPctFor(pool: QuotaPoolTraits, usingManual = false, manualStopPct = OTHER_STOP_PCT): number {
  if (pool.leader) return CLAUDE_STOP_PCT;
  if (pool.handCopy && usingManual) return manualStopPct;
  return OTHER_STOP_PCT;
}

export { reasonSaysNoDispatch, reasonWaitsForWindow };

export function showsOnHome(input: QuotaInput): boolean {
  if (input.paceState === "closed") return false;
  if (reasonSaysNoDispatch(input.reason)) return false;
  return true;
}

/**
 * When current usage, extended in a straight line, crosses the stop line.
 * Null when the line is not crossed before the pool resets.
 */
export function projectStopAt(input: {
  usedPct: number | null;
  elapsedPct: number | null;
  resetsAt: string | null | undefined;
  stopPct: number;
  now: number;
}): string | null {
  const { usedPct, elapsedPct, resetsAt, stopPct, now } = input;
  if (usedPct === null || elapsedPct === null || !resetsAt) return null;
  if (!(usedPct > 0) || !(elapsedPct > 0) || elapsedPct >= 100) return null;
  const end = Date.parse(resetsAt);
  if (Number.isNaN(end) || !(end > now)) return null;
  const elapsed = elapsedPct / 100;
  const start = (now - elapsed * end) / (1 - elapsed);
  if (!Number.isFinite(start)) return null;
  if (usedPct >= stopPct) return new Date(now).toISOString();
  const projected = usedPct / elapsed;
  if (!(projected > stopPct)) return null;
  const hit = start + (stopPct / projected) * (end - start);
  if (!Number.isFinite(hit) || hit <= now || hit >= end) return null;
  return new Date(hit).toISOString();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function tokyoWhen(iso: string): { date: string; part: string; clock: string } {
  const local = new Date(Date.parse(iso) + TOKYO_OFFSET_MS);
  const h = local.getUTCHours();
  const part = t(h < 5 || h >= 23 ? "quota.line.part.lateNight" : h < 11 ? "quota.line.part.morning" : h < 13 ? "quota.line.part.noon" : h < 18 ? "quota.line.part.afternoon" : "quota.line.part.evening");
  const date = `${local.getUTCMonth() + 1}/${local.getUTCDate()}`;
  return { date, part, clock: `${date} ${pad(h)}:${pad(local.getUTCMinutes())}` };
}

function pauseClock(reason: string): string | null {
  return /(\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/.exec(reason)?.[1] ?? null;
}

function usedBit(monthly: boolean, used: number | null): string {
  if (used === null) return t(monthly ? "quota.line.monthUnread" : "quota.line.weekUnread");
  return t(monthly ? "quota.line.monthUsed" : "quota.line.weekUsed", { pct: Math.round(used) });
}

function joined(head: string, tail: string): string {
  return t("quota.line.joined", { head, tail });
}

export function quotaLine(input: QuotaInput, now: number): QuotaLine | null {
  if (!showsOnHome(input)) return null;
  const name = input.name ?? input.key;
  const stopPct = input.stopPct ?? stopPctFor(input, input.usingManual === true, input.manualStopPct);
  const hitsStopAt = projectStopAt({
    usedPct: input.usedPct,
    elapsedPct: input.elapsedPct ?? null,
    resetsAt: input.resetsAt,
    stopPct,
    now,
  });
  const head = t("quota.line.head", { name, used: usedBit(input.monthly === true, input.usedPct) });
  const base = { name, usedPct: input.usedPct, pacePct: input.pacePct, stopPct, hitsStopAt };
  if (!input.dispatchable) {
    const clock = pauseClock(input.reason);
    const tail = clock
      ? t("quota.line.pausedUntil", { clock })
      : reasonWaitsForWindow(input.reason) ? t("quota.line.pausedUntilWindow") : t("quota.line.stopped");
    return { ...base, text: joined(head, tail), tone: "red" };
  }
  if (input.prefer || input.paceState === "behind") {
    return { ...base, text: joined(head, t("quota.line.behindPrefer")), tone: "green" };
  }
  if (hitsStopAt) {
    const when = tokyoWhen(hitsStopAt);
    return {
      ...base,
      text: joined(head, t("quota.line.hitsStop", { date: when.date, part: when.part })),
      tone: input.paceState === "ahead" ? "yellow" : "red",
    };
  }
  if (input.paceState === "ahead") {
    return { ...base, text: joined(head, t("quota.line.ahead")), tone: "yellow" };
  }
  return { ...base, text: joined(head, t("quota.line.enough")), tone: "green" };
}

/** Lines in the order given (pass pools in catalog order, shared/quota-adapters.ts poolCatalog). */
export function quotaLines(pools: QuotaInput[], now: number): QuotaLine[] {
  return pools.flatMap((row) => {
    const line = quotaLine(row, now);
    return line ? [line] : [];
  });
}

/**
 * Display-only remaining voice for the quota page.
 * `quotaLine` above stays on the used voice (the home one-liner and its harness).
 * Rounding matches the page today: Math.round(100 − used), not 100 − Math.round(used).
 */
export function remainingRounded(usedPct: number): number {
  return Math.round(100 - usedPct);
}

export function remainingText(usedPct: number | null | undefined): string {
  if (usedPct === null || usedPct === undefined || !Number.isFinite(usedPct)) return t("quota.line.remainingUnknown");
  return t("quota.line.remaining", { pct: remainingRounded(usedPct) });
}

export function paceShouldRemainText(pacePct: number | null | undefined): string {
  if (pacePct === null || pacePct === undefined || !Number.isFinite(pacePct)) return t("quota.line.paceRemainingUnknown");
  return t("quota.line.paceRemaining", { pct: remainingRounded(pacePct) });
}

/** Stop percents in the data are used-percents (Claude 75 → "stops at 25% left"). */
export function stopRemainText(stopUsedPct: number): string {
  return t("quota.line.stopRemain", { pct: remainingRounded(stopUsedPct) });
}

export function paceGapText(usedPct: number | null | undefined, pacePct: number | null | undefined): string {
  if (usedPct === null || usedPct === undefined || pacePct === null || pacePct === undefined) return "—";
  if (!Number.isFinite(usedPct) || !Number.isFinite(pacePct)) return "—";
  const gap = usedPct - pacePct;
  if (gap > 0) return t("quota.line.gapFast", { points: Math.round(gap) });
  if (gap < 0) return t("quota.line.gapSlow", { points: Math.round(-gap) });
  return t("quota.line.gapEven");
}

/** "40% left · pace says 45% left · 5 pts fast" */
export function paceProgressText(usedPct: number | null | undefined, pacePct: number | null | undefined): string {
  return `${remainingText(usedPct)} · ${paceShouldRemainText(pacePct)} · ${paceGapText(usedPct, pacePct)}`;
}

/** Waste verdict: projected used-at-reset becomes how much would be left unused. */
export function untilResetRemainText(projectedUsedPct: number): string {
  const left = remainingRounded(projectedUsedPct);
  if (left <= 0) return t("quota.line.untilResetUsedUp");
  return t("quota.line.untilResetLeft", { pct: left });
}

/** Bar fill on the remaining axis. Raw, same as the old used fill was raw. */
export function remainingFill(usedPct: number): number {
  return Math.max(0, Math.min(100, 100 - usedPct));
}

/** Pace, stop, and elapsed markers drawn on a remaining bar. */
export function remainingMarker(usedAxisPct: number): number {
  return Math.max(0, Math.min(100, 100 - usedAxisPct));
}

/** Rewrite pool-reason and coupon sentences for the quota page. Does not change stored text. Reads any language. */
export function quotaPageReason(reason: string): string {
  const num = (n: string) => Number(n);
  let text = reason;
  text = text.replace(anyLanguage("quota.reason.usedUp", "g"), () => t("quota.pageReason.usedUp"));
  text = text.replace(anyLanguage("quota.reason.usedPercent", "g"), () => t("quota.pageReason.cliPercent"));
  text = replaceNumbers(text, "quota.reason.usedN", (n) => remainingText(num(n)));
  text = replaceNumbers(text, "quota.reason.spentN", (n) => remainingText(num(n)));
  text = replaceNumbers(text, "quota.reason.paceAtN", (n) => paceShouldRemainText(num(n)));
  text = replaceNumbers(text, "quota.reason.tempStopLineN", (n) => stopRemainText(num(n)));
  text = replaceNumbers(text, "quota.reason.offLineN", (n) => stopRemainText(num(n)));
  text = replaceNumbers(text, "quota.reason.doubleWeekStopN", (n) => t("quota.pageReason.doubleWeek", { stop: stopRemainText(num(n)) }));
  text = replaceNumbers(text, "quota.reason.stopRestoredN", (n) => t("quota.pageReason.stopRestored", { stop: stopRemainText(num(n)) }));
  text = replaceNumbers(text, "quota.reason.stopLineN", (n) => stopRemainText(num(n)));
  text = replaceNumbers(text, "quota.reason.stopAtN", (n) => stopRemainText(num(n)), "quota.reason.stopAtLookbehind");
  return text;
}
