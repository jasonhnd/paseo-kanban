import { type CouponKind, BURN_FRONT_STOP_PCT, USE_AT_PCT, USE_RESET_GAP_MS, CODEX_USE_AT_PCT, CODEX_RESET_QUIET_MS, CODEX_EXPIRY_SOON_DAYS, CODEX_EXPIRY_USE_AT_PCT, claudeCapKind, codexCapKind, codexExpiryKind, waitingConfirm, askLead, NOTIFY_GAP_MS, daysUntil, doubleWeekPlan, doubleWeekPhase, kindPhrase } from "./reset-coupons-core";
import { t } from "./i18n";

export interface CouponAlert {
  level: "red" | "yellow";
  kind: string;
  text: string;
  /** Send to the AFC supervisor. Home text still shows when this is false because of the 30 minute gap. */
  notifyUse: boolean;
  /**
   * When set, the cockpit sends this once per episode instead of every 30 minutes.
   * A failed send leaves the episode unmarked so the next round tries again.
   */
  once?: string;
}

export interface CouponClock {
  now: number;
  claudeCount: number;
  claudeKind: CouponKind;
  claudeExpiresAt: string | null;
  claudeShifts: boolean;
  claudeWhere: string;
  claudeUsed: boolean;
  claudeUsedPct: number | null;
  claudeResetsAt: string | null;
  lastUseNotifyAt: string | null;
  codexCount: number;
  codexExpiresAt: string | null;
  codexUsed: boolean;
  /** Front half of a named burn week: the coupon cannot be used until weekly usage hits the cap. */
  burnFront?: boolean;
  /** ChatGPT weekly percent. Absent means this clock is not deciding the 97% coupon line. */
  codexUsedPct?: number | null;
  codexResetsAt?: string | null;
  codexKind?: CouponKind;
  /** Claude confirmation-box sentence, when `/limit-reset` has been read. */
  claudeTypeText?: string | null;
  /** ChatGPT credit title from the read, when there is one. */
  codexTypeText?: string | null;
  /** Pool reason already says the burn week hit the cap, even if the percent is still rounding. */
  atCap?: boolean;
}

export function shouldNotify(lastAt: string | null, now: number, gapMs = NOTIFY_GAP_MS): boolean {
  if (!lastAt) return true;
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return true;
  return now - t >= gapMs;
}

/** "Waiting for you to confirm. <ask sentence>" */
function waitingText(ask: string): string {
  return t("coupons.alerts.waitingText", { waiting: waitingConfirm(), ask });
}

function howTo(where: string): string {
  return where || t("coupons.alerts.howTo");
}

function claudeAlerts(input: CouponClock): CouponAlert[] {
  const alerts: CouponAlert[] = [];
  const claudeUsable = input.claudeCount > 0 && !input.claudeUsed && !input.claudeShifts && input.claudeExpiresAt !== null && daysUntil(input.claudeExpiresAt, input.now) >= 0;
  if (!claudeUsable || !input.claudeExpiresAt) return alerts;
  const plan = doubleWeekPlan(input.claudeExpiresAt);
  const phase = doubleWeekPhase(plan, input.now, false);
  const resetAt = input.claudeResetsAt ? Date.parse(input.claudeResetsAt) : Number.NaN;
  const farFromReset = !Number.isNaN(resetAt) && resetAt - input.now > USE_RESET_GAP_MS;
  const used = input.claudeUsedPct;
  const hitCap = input.burnFront === true && ((used !== null && used >= BURN_FRONT_STOP_PCT) || input.atCap === true);
  if (hitCap) {
    alerts.push({
      level: "red",
      kind: claudeCapKind(),
      text: waitingText(askCouponSentence({
        company: "Claude",
        index: 1,
        total: input.claudeCount,
        typeText: input.claudeTypeText ?? null,
        usedPct: used,
        now: input.now,
        resetsAt: input.claudeResetsAt,
      })),
      notifyUse: true,
      once: "claude-cap",
    });
  } else if (input.burnFront !== true && used !== null && used >= USE_AT_PCT && farFromReset) {
    alerts.push({
      level: "red",
      kind: t("coupons.alerts.claudeUseNowKind"),
      text: howTo(input.claudeWhere),
      notifyUse: shouldNotify(input.lastUseNotifyAt, input.now),
    });
  }
  if (phase === "fallback") {
    const days = daysUntil(input.claudeExpiresAt, input.now);
    alerts.push({
      level: "yellow",
      kind: t("coupons.alerts.claudeExpiringKind"),
      text: t("coupons.alerts.claudeExpiringText", { days }),
      notifyUse: false,
    });
  }
  return alerts;
}

function codexExpiryAlerts(input: CouponClock): CouponAlert[] {
  if (!(input.codexCount > 0 && !input.codexUsed && input.codexExpiresAt && daysUntil(input.codexExpiresAt, input.now) >= 0)) return [];
  const days = daysUntil(input.codexExpiresAt, input.now);
  if (days !== 7 && days !== 2) return [];
  return [{
    level: "yellow",
    kind: t("coupons.alerts.codexKind"),
    text: t("coupons.alerts.codexExpiringText", { days }),
    notifyUse: false,
  }];
}

/**
 * Home reminders. Claude's red line also sets `notifyUse` when the 30 minute gap has passed.
 * ChatGPT coupons stay a reminder only: the home line appears on the Tokyo calendar day that is 7 days out,
 * and again on the day that is 2 days out. Other days in between stay quiet. Dispatch itself follows the Codex pool.
 */
export function planCouponAlerts(input: CouponClock): CouponAlert[] {
  const codex = codexCouponReminder(input);
  return [...claudeAlerts(input), ...codexExpiryAlerts(input), ...(codex ? [codex] : [])];
}

export function resetGapPhrase(now: number, resetsAt: string | null): string {
  if (!resetsAt) return t("coupons.alerts.resetGapUnknown");
  const end = Date.parse(resetsAt);
  if (Number.isNaN(end)) return t("coupons.alerts.resetGapUnknown");
  const ms = end - now;
  if (ms <= 0) return t("coupons.alerts.resetReached");
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (days > 0) return t("coupons.alerts.resetInDays", { days, hours: rest });
  if (hours > 0) return t("coupons.alerts.resetInHours", { hours });
  return t("coupons.alerts.resetUnderHour");
}

/** The sentence the supervisor reads to the user before anyone uses a coupon. */
export function askCouponSentence(input: {
  company: string;
  index: number;
  total: number;
  typeText: string | null;
  usedPct: number | null;
  now: number;
  resetsAt: string | null;
}): string {
  const type = input.typeText ? t("coupons.alerts.typeKnown", { type: input.typeText }) : t("coupons.alerts.typeUnknown");
  const used = input.usedPct === null ? t("coupons.alerts.usedUnknown") : t("coupons.alerts.usedNow", { pct: Math.round(input.usedPct) });
  const extra = input.usedPct === null ? t("coupons.alerts.gainUnknown") : t("coupons.alerts.gain", { pct: Math.round(input.usedPct) });
  return t("coupons.alerts.ask", {
    lead: askLead(),
    company: input.company,
    index: input.index,
    total: input.total,
    type,
    used,
    gap: resetGapPhrase(input.now, input.resetsAt),
    extra,
  });
}

function codexTypeLabel(kind: CouponKind | undefined, typeText: string | null | undefined): string | null {
  if (typeText) return typeText;
  if (kind === "full") return kindPhrase("full");
  if (kind === "weekly" || kind === "session") return kindPhrase(kind);
  return null;
}

/** Red reminder when ChatGPT still has a coupon. Null keeps the ordinary 80% stop's silence. */
export function codexCouponReminder(input: CouponClock): CouponAlert | null {
  if (input.codexCount <= 0 || input.codexUsed || input.codexUsedPct === null || input.codexUsedPct === undefined) return null;
  const days = input.codexExpiresAt ? daysUntil(input.codexExpiresAt, input.now) : null;
  const expirySoon = days !== null && days >= 0 && days <= CODEX_EXPIRY_SOON_DAYS;
  const resetMs = input.codexResetsAt ? Date.parse(input.codexResetsAt) - input.now : Number.NaN;
  const resetFar = !Number.isNaN(resetMs) && resetMs > CODEX_RESET_QUIET_MS;
  const ask = askCouponSentence({
    company: "ChatGPT",
    index: 1,
    total: input.codexCount,
    typeText: codexTypeLabel(input.codexKind, input.codexTypeText),
    usedPct: input.codexUsedPct,
    now: input.now,
    resetsAt: input.codexResetsAt ?? null,
  });
  if (expirySoon && input.codexUsedPct >= CODEX_EXPIRY_USE_AT_PCT) {
    return { level: "red", kind: codexExpiryKind(), text: waitingText(ask), notifyUse: true, once: "codex-expiry" };
  }
  if (input.codexUsedPct >= CODEX_USE_AT_PCT && resetFar) {
    return { level: "red", kind: codexCapKind(), text: waitingText(ask), notifyUse: true, once: "codex-use" };
  }
  return null;
}
