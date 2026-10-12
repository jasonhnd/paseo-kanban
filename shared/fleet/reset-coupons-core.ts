/** Reset coupons: what each plan holds, when a double week runs, and when to ask the user to tap. */
import { t } from "./i18n";

export const COUPON_KINDS = ["weekly", "session", "full", "unknown"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

/**
 * Vendor account a coupon belongs to: the company key of a plan (shared/quota-adapters.ts companyKeyOf), so
 * `claude` (claude-cli), `chatgpt` (codex-cli), otherwise the plan id. The coupon state file is keyed by it.
 */
export type CouponCompany = string;

/** Thursday 22:00 Asia/Tokyo. Japan has no daylight saving. */
export const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
export const CLAUDE_RESET_WEEKDAY = 4;
export const CLAUDE_RESET_HOUR = 22;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** During an unused double week the hard stop moves from 75% to 90%. The last 10% stays with the supervisor. */
export const DOUBLE_WEEK_STOP_PCT = 90;
export const NORMAL_CLAUDE_STOP_PCT = 75;
/** Ordinary 5-hour pause. A burn week's front half raises this; the back half uses it again. */
export const NORMAL_CLAUDE_SESSION_PCT = 70;
/**
 * Named burn week, before the coupon is used.
 * The week runs until the cap (no supervisor reserve). The 5-hour window loosens so the short window does not stall the burn.
 * The progress line reaches 100% in about 3.5 days.
 */
export const BURN_FRONT_STOP_PCT = 100;
export const BURN_FRONT_SESSION_PCT = 90;
export const BURN_FRONT_DAYS = 3.5;
/** After the coupon is used, the rest of the named week aims at the ordinary progress target. */
export const BURN_BACK_TARGET_PCT = 97;
/** Shown when the front half has hit the cap and dispatch waits for the coupon. */
export function burnCapReason(): string {
  return t("coupons.core.burnCapReason");
}
/** Ask the user to use the coupon once weekly usage is this high and the natural reset is still far. */
export const USE_AT_PCT = 85;
export const USE_RESET_GAP_MS = 2 * DAY_MS;
/**
 * Older name for the 97% ChatGPT line. Burn-mode dispatch does not use it.
 * The ask-to-use reminder is `CODEX_USE_AT_PCT`. The in-hand dispatch stop is `CODEX_BURN_STOP_PCT`.
 */
export const CODEX_COUPON_STOP_PCT = 97;
/** Ask to use a ChatGPT coupon once weekly usage reaches this and the natural reset is still far. Not the dispatch stop. */
export const CODEX_USE_AT_PCT = 97;
/**
 * Dispatch stop while an unexpired ChatGPT coupon is in hand.
 * The progress line reaches this in 3.5 days. The reminder starts earlier, at `CODEX_USE_AT_PCT`.
 */
export const CODEX_BURN_STOP_PCT = BURN_FRONT_STOP_PCT;
/** The manual command refuses to use a ChatGPT coupon below this. */
export const CODEX_CONSUME_MIN_PCT = 90;
/** At or under this gap before the natural reset, wait. Do not ask to use the coupon. */
export const CODEX_RESET_QUIET_MS = DAY_MS;
/** A coupon this close to expiring is asked about earlier, so it is not thrown away. */
export const CODEX_EXPIRY_SOON_DAYS = 3;
export const CODEX_EXPIRY_USE_AT_PCT = 70;
/** A pool this far under its progress line has room to take more work today. */
export const SURPLUS_BEHIND_PCT = 5;
export const SURPLUS_RESET_QUIET_MS = 2 * 60 * 60 * 1000;
export const CARD_ESTIMATE_MIN_SAMPLES = 5;
export const CARD_ESTIMATE_MAX = 200;
export function cardEstimateUnknown(): string {
  return t("coupons.core.cardEstimateUnknown");
}
/** A coupon the manual command just used still explains a drop inside this window. */
export const AFC_YES_MS = 6 * 60 * 60 * 1000;
export function claudeCapKind(): string {
  return t("coupons.core.claudeCapKind");
}
export function codexCapKind(): string {
  return t("coupons.core.codexCapKind");
}
export function codexExpiryKind(): string {
  return t("coupons.core.codexExpiryKind");
}
export function waitingConfirm(): string {
  return t("coupons.core.waitingConfirm");
}
export function askLead(): string {
  return t("coupons.core.askLead");
}
/** The fallback week becomes a double week when this much remains before its natural reset. */
export const FALLBACK_LEAD_MS = 3 * DAY_MS;
export const NOTIFY_GAP_MS = 30 * 60 * 1000;

/** A sudden drop at least this large, down to a low reading, and not at the natural reset, counts as the coupon being used. */
export const USED_DROP_FROM = 40;
export const USED_DROP_TO = 15;
export const USED_DROP_POINTS = 30;
/** Usage that falls inside this window around the natural reset is the reset itself, not a coupon. */
export const RESET_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface ResetCoupon {
  count: number;
  kind: CouponKind;
  /** End of the expiry calendar day in Tokyo, as an ISO instant. Null when the page gave no date. */
  expiresAt: string | null;
  /** True when using the coupon moves the weekly reset day. Those coupons are shown only; they do not schedule a double week. */
  shiftsWeeklyReset: boolean;
  /** One sentence telling the user where to tap. The cockpit never taps it. */
  where: string;
  source: string;
  verifiedAt: string;
  /**
   * Named week that replaces the computed second-to-last week.
   * Absent means the old double-week plan. Invalid dates are dropped.
   */
  burnWeek?: WeekWindow;
  /** Profile names whose notes "paused" marker is ignored while this burn week is running. */
  unpauseProfiles?: string[];
}

export interface WeekWindow {
  start: string;
  end: string;
}

export interface DoubleWeekPlan {
  planned: WeekWindow;
  fallback: WeekWindow;
}

export interface TokyoParts {
  y: number;
  m: number;
  d: number;
  weekday: number;
  hour: number;
  minute: number;
}

export function tokyoParts(ms: number): TokyoParts {
  const t = new Date(ms + TOKYO_OFFSET_MS);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    weekday: t.getUTCDay(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
  };
}

/** Tokyo local date and hour, as a UTC instant. */
export function tokyoInstant(y: number, m: number, d: number, hour: number, minute = 0, second = 0): number {
  return Date.UTC(y, m - 1, d, hour, minute, second) - TOKYO_OFFSET_MS;
}

export function tokyoDateLabel(iso: string): string {
  const p = tokyoParts(Date.parse(iso));
  return t("coupons.core.dateLabel", { m: p.m, d: p.d });
}

export function tokyoClock(iso: string): string {
  const p = tokyoParts(Date.parse(iso));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.m}/${p.d} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Whole Tokyo calendar days from `now` until the expiry date. Negative after that date. */
export function daysUntil(expiresAt: string, now: number): number {
  const end = tokyoParts(Date.parse(expiresAt));
  const start = tokyoParts(now);
  const a = Date.UTC(start.y, start.m - 1, start.d);
  const b = Date.UTC(end.y, end.m - 1, end.d);
  return Math.round((b - a) / DAY_MS);
}

/**
 * Latest Tokyo weekday-at-hour strictly before `beforeMs`.
 * Weeks for Claude end on Thursday 22:00.
 */
export function lastSlotBefore(beforeMs: number, weekday: number, hour: number): number {
  const p = tokyoParts(beforeMs);
  let slot = tokyoInstant(p.y, p.m, p.d, hour);
  if (slot >= beforeMs) {
    const prev = tokyoParts(beforeMs - DAY_MS);
    slot = tokyoInstant(prev.y, prev.m, prev.d, hour);
  }
  while (tokyoParts(slot).weekday !== weekday) {
    const prev = tokyoParts(slot - DAY_MS);
    slot = tokyoInstant(prev.y, prev.m, prev.d, hour);
  }
  return slot;
}

/**
 * Last complete natural week that ends before `expiresAt` is the fallback week.
 * The week before that is the planned double week.
 * For a coupon expiring 2026-10-23 and a Thursday 22:00 reset, that is
 * planned 10/8 22:00–10/15 22:00 and fallback 10/15 22:00–10/22 22:00 (Tokyo).
 */
export function doubleWeekPlan(expiresAt: string, weekday = CLAUDE_RESET_WEEKDAY, hour = CLAUDE_RESET_HOUR): DoubleWeekPlan | null {
  const endMs = Date.parse(expiresAt);
  if (Number.isNaN(endMs)) return null;
  const fallbackEnd = lastSlotBefore(endMs, weekday, hour);
  const fallbackStart = fallbackEnd - WEEK_MS;
  const plannedStart = fallbackStart - WEEK_MS;
  return {
    planned: { start: new Date(plannedStart).toISOString(), end: new Date(fallbackStart).toISOString() },
    fallback: { start: new Date(fallbackStart).toISOString(), end: new Date(fallbackEnd).toISOString() },
  };
}

/** Which double-week rules apply at `now`. A used coupon turns both off. */
export function doubleWeekPhase(plan: DoubleWeekPlan | null, now: number, used: boolean): "planned" | "fallback" | null {
  if (!plan || used) return null;
  const plannedStart = Date.parse(plan.planned.start);
  const plannedEnd = Date.parse(plan.planned.end);
  const fallbackEnd = Date.parse(plan.fallback.end);
  if (now >= plannedStart && now < plannedEnd) return "planned";
  if (now >= fallbackEnd - FALLBACK_LEAD_MS && now < fallbackEnd) return "fallback";
  return null;
}

export function kindPhrase(kind: CouponKind): string {
  if (kind === "weekly") return t("coupons.kind.weekly");
  if (kind === "session") return t("coupons.kind.session");
  if (kind === "full") return t("coupons.kind.full");
  return t("coupons.kind.unknown");
}

export interface ShownCoupon {
  count: number;
  kind: CouponKind;
  expiresAt: string | null;
  shiftsWeeklyReset: boolean;
  where: string;
  /** Empty when the latest read succeeded. Otherwise a stale-confirm note or the hand-entry note. */
  confirmNote: string;
  used: boolean;
  /** Confirmation-box sentence, once `/limit-reset` has been read. Absent until then. */
  typeText?: string | null;
  /** One line per coupon, earliest expiry first. Ids are never stored. */
  pieces?: { title: string; expiresAt: string | null }[];
}

function noteBit(note: string | undefined): string {
  return note ? t("coupons.line.note", { note }) : "";
}

function noCouponLine(note: string | undefined): string {
  return t("coupons.line.none", { note: noteBit(note) });
}

function expiryDate(expiresAt: string | null): string {
  return expiresAt ? t("coupons.line.expiresOn", { date: tokyoDateLabel(expiresAt) }) : t("coupons.line.expiryUnknown");
}

function daysLeftText(daysLeft: number | null): string {
  if (daysLeft === null) return "";
  if (daysLeft < 0) return t("coupons.line.expired");
  if (daysLeft === 0) return t("coupons.line.expiresToday");
  return t("coupons.line.daysLeft", { days: daysLeft });
}

function piecesText(pieces: ShownCoupon["pieces"]): string {
  if (!pieces || pieces.length === 0) return "";
  const list = pieces.map((piece, index) => {
    const when = piece.expiresAt ? t("coupons.line.pieceExpires", { clock: tokyoClock(piece.expiresAt) }) : t("coupons.line.expiryUnknown");
    return t("coupons.line.piece", { n: index + 1, title: piece.title, when });
  }).join(t("coupons.line.piecesJoin"));
  return t("coupons.line.pieces", { pieces: list });
}

/** `now` is passed in so the remaining days do not depend on a hidden clock. */
export function couponLineAt(shown: ShownCoupon, daysLeft: number | null, when?: string): string {
  if (shown.count <= 0) return noCouponLine(shown.confirmNote);
  const leftText = daysLeftText(daysLeft);
  return t("coupons.line.full", {
    count: shown.count,
    kind: kindPhrase(shown.kind),
    typeBit: shown.typeText ? t("coupons.line.typeBit", { type: shown.typeText }) : "",
    date: when ?? expiryDate(shown.expiresAt),
    tail: leftText ? t("coupons.line.tail", { left: leftText }) : "",
    where: shown.where ? t("coupons.line.where", { where: shown.where }) : "",
    used: shown.used ? t("coupons.line.used") : "",
    note: noteBit(shown.confirmNote),
    pieces: piecesText(shown.pieces),
  });
}

export function formatCouponLine(shown: ShownCoupon | null, now: number): string {
  if (!shown || shown.count <= 0) return noCouponLine(shown?.confirmNote);
  const days = shown.expiresAt ? daysUntil(shown.expiresAt, now) : null;
  return couponLineAt(shown, days, expiryDate(shown.expiresAt));
}

export function doubleWeekText(plan: DoubleWeekPlan, phase: "planned" | "fallback" | null, used: boolean): string {
  const start = tokyoClock(plan.planned.start);
  const mid = tokyoClock(plan.planned.end);
  const end = tokyoClock(plan.fallback.end);
  const head = t("coupons.doubleWeek.head", { start, mid, end });
  if (used) return t("coupons.doubleWeek.used", { head });
  if (phase === "planned") return t("coupons.doubleWeek.planned", { head });
  if (phase === "fallback") return t("coupons.doubleWeek.fallback", { head });
  return head;
}
