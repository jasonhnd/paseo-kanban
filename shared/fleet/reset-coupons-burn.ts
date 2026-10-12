import { DAY_MS, DOUBLE_WEEK_STOP_PCT, NORMAL_CLAUDE_STOP_PCT, NORMAL_CLAUDE_SESSION_PCT, BURN_FRONT_STOP_PCT, BURN_FRONT_SESSION_PCT, BURN_FRONT_DAYS, BURN_BACK_TARGET_PCT, type WeekWindow, type DoubleWeekPlan, tokyoParts, tokyoClock, doubleWeekPlan, doubleWeekPhase, doubleWeekText } from "./reset-coupons-core";
import { type CouponAlert, type CouponClock, planCouponAlerts } from "./reset-coupons-alerts";
import { t } from "./i18n";

export function doubleWeekAnnounceText(): string {
  return t("coupons.burn.doubleWeekAnnounce");
}

/** Once per double-week window. `announcedStart` is the window start already sent. */
export function doubleWeekAnnounce(plan: DoubleWeekPlan | null, now: number, used: boolean, announcedStart: string | null): { key: string; text: string } | null {
  const phase = doubleWeekPhase(plan, now, used);
  if (!phase || !plan) return null;
  const key = phase === "planned" ? plan.planned.start : plan.fallback.start;
  if (announcedStart === key) return null;
  return { key, text: doubleWeekAnnounceText() };
}

/**
 * Progress-line percent during a double week, before the coupon is used.
 * The first half of the week aims at about 90% (twice a line that would otherwise
 * reach the raised stop at the end of the week). After the midpoint the line stays at 90
 * until the coupon is used; the second half then goes back to the normal 97% line.
 */
export function doubleWeekPacePct(elapsedRatio: number): number {
  if (!Number.isFinite(elapsedRatio) || elapsedRatio <= 0) return 0;
  return Math.min(DOUBLE_WEEK_STOP_PCT, elapsedRatio * DOUBLE_WEEK_STOP_PCT * 2);
}

/** Tokyo month/day and clock, zero-padded, for the burn-week sentence. */
export function tokyoStamp(iso: string): string {
  const p = tokyoParts(Date.parse(iso));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.m)}/${pad(p.d)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function parseBurnWeek(value: unknown): WeekWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  // `from`/`to` are accepted as aliases of `start`/`end` (the ChatGPT burn week is written that way).
  const row = value as { start?: unknown; end?: unknown; from?: unknown; to?: unknown };
  const rawStart = row.start ?? row.from;
  const rawEnd = row.end ?? row.to;
  if (typeof rawStart !== "string" || typeof rawEnd !== "string") return undefined;
  const start = Date.parse(rawStart);
  const end = Date.parse(rawEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return undefined;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function parseUnpauseProfiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/**
 * Front half: inside the named week, coupon not yet used. Aims at 100% in 3.5 days.
 * Back half: coupon already used, until the week ends. The aggressive cap is over.
 * Outside the week, or with no burnWeek, this is null and the old double week may apply.
 */
export function burnWeekPhase(window: WeekWindow | null | undefined, now: number, used: boolean): "front" | "back" | null {
  if (!window) return null;
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (Number.isNaN(start) || Number.isNaN(end) || now < start || now >= end) return null;
  return used ? "back" : "front";
}

/** One sentence for the top of the home page, including which half of the week this is. */
export function burnWeekBanner(window: WeekWindow, phase: "front" | "back"): string {
  const where = phase === "front" ? t("coupons.burn.front") : t("coupons.burn.back");
  return t("coupons.burn.banner", { start: tokyoStamp(window.start), end: tokyoStamp(window.end), where });
}

/**
 * A coupon count was read and the earliest coupon has not expired.
 * A missing count, a non-positive count, or a missing/invalid expiry is not a coupon in hand.
 */
export function couponInHand(count: number | null | undefined, expiresAt: string | null | undefined, now: number): boolean {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return false;
  if (typeof expiresAt !== "string" || expiresAt.length === 0) return false;
  const ms = Date.parse(expiresAt);
  return !Number.isNaN(ms) && ms > now;
}

/** Home-page sentence while ChatGPT still holds an unexpired reset coupon. */
export function chatgptBurnBanner(count: number, expiresAt: string): string {
  return t("coupons.burn.chatgptBanner", { count, clock: tokyoClock(expiresAt) });
}

/** Progress line for the front half: 100% spread across 3.5 days from the burn start, then held at 100. */
export function burnFrontPacePct(now: number, burnStartMs: number, days = BURN_FRONT_DAYS): number {
  const elapsedDays = (now - burnStartMs) / DAY_MS;
  if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return 0;
  return Math.min(BURN_FRONT_STOP_PCT, (elapsedDays / days) * BURN_FRONT_STOP_PCT);
}

/**
 * Progress line for the back half.
 * Starts at the reading taken when the coupon was seen as used, and reaches about 97% at the week's end.
 */
export function burnBackPacePct(now: number, usedAtMs: number, burnEndMs: number, baselinePct: number, target = BURN_BACK_TARGET_PCT): number {
  const base = Number.isFinite(baselinePct) ? Math.min(target, Math.max(0, baselinePct)) : 0;
  if (!Number.isFinite(usedAtMs) || !Number.isFinite(burnEndMs) || burnEndMs <= usedAtMs) return target;
  if (now <= usedAtMs) return base;
  const ratio = Math.min(1, (now - usedAtMs) / (burnEndMs - usedAtMs));
  return base + (target - base) * ratio;
}

export interface ClaudeBurnClock {
  phase: "front" | "back";
  startMs: number;
  endMs: number;
  unpauseProfiles: string[];
}

export interface ClaudeWeekMode {
  kind: "normal" | "double" | "burn-front" | "burn-back";
  stopPct: number;
  sessionPause: number;
  planText: string | null;
  banner: string | null;
  burn: ClaudeBurnClock | null;
}

function normalWeekMode(): ClaudeWeekMode {
  return {
    kind: "normal",
    stopPct: NORMAL_CLAUDE_STOP_PCT,
    sessionPause: NORMAL_CLAUDE_SESSION_PCT,
    planText: null,
    banner: null,
    burn: null,
  };
}

/**
 * Which Claude week rules apply.
 * A usable `burnWeek` replaces the computed double week entirely, including after that week ends.
 * Without one, the second-to-last complete week before expiry is unchanged.
 * Using the coupon ends the front half; the back half runs until `burnWeek.end`.
 * The back half stays up even when a trusted reading says the coupon count is now 0.
 */
export function claudeWeekMode(input: {
  now: number;
  used: boolean;
  shiftsWeeklyReset: boolean;
  count: number;
  expiresAt: string | null;
  burnWeek?: WeekWindow | null;
  unpauseProfiles?: string[];
}): ClaudeWeekMode {
  const burn = input.burnWeek ? parseBurnWeek(input.burnWeek) : undefined;
  if (burn) {
    const phase = burnWeekPhase(burn, input.now, input.used);
    const active = phase === "back" || (phase === "front" && input.count > 0);
    if (phase && active) {
      const banner = burnWeekBanner(burn, phase);
      const names = input.unpauseProfiles ?? [];
      return {
        kind: phase === "front" ? "burn-front" : "burn-back",
        stopPct: phase === "front" ? BURN_FRONT_STOP_PCT : NORMAL_CLAUDE_STOP_PCT,
        sessionPause: phase === "front" ? BURN_FRONT_SESSION_PCT : NORMAL_CLAUDE_SESSION_PCT,
        planText: banner,
        banner,
        burn: {
          phase,
          startMs: Date.parse(burn.start),
          endMs: Date.parse(burn.end),
          unpauseProfiles: names,
        },
      };
    }
    return normalWeekMode();
  }
  const plan = !input.shiftsWeeklyReset && input.count > 0 && input.expiresAt ? doubleWeekPlan(input.expiresAt) : null;
  const phase = doubleWeekPhase(plan, input.now, input.used);
  if (!plan || !phase) return normalWeekMode();
  return {
    kind: "double",
    stopPct: DOUBLE_WEEK_STOP_PCT,
    sessionPause: NORMAL_CLAUDE_SESSION_PCT,
    planText: doubleWeekText(plan, phase, input.used),
    banner: null,
    burn: null,
  };
}

/** Home alerts and the background reminder. A burn week's front half waits until usage hits the cap. */
export function couponAlertsForMode(mode: Pick<ClaudeWeekMode, "kind">, input: Omit<CouponClock, "burnFront">): CouponAlert[] {
  return planCouponAlerts({ ...input, burnFront: mode.kind === "burn-front" });
}
