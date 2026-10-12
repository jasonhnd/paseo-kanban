import { type CouponKind, type CouponCompany, DAY_MS, type ResetCoupon, tokyoDateLabel } from "./reset-coupons-core";
import { parseBurnWeek, parseUnpauseProfiles } from "./reset-coupons-burn";
import { t, tAll } from "./i18n";

export function confirmAgeNote(confirmedAt: string | null, now: number, stale: boolean): string {
  if (!stale) return "";
  if (!confirmedAt) return t("coupons.cli.notConfirmed");
  const days = Math.max(0, Math.floor((now - Date.parse(confirmedAt)) / DAY_MS));
  return days <= 0 ? t("coupons.cli.confirmedToday") : t("coupons.cli.confirmedDaysAgo", { days });
}

/**
 * Hand-registered coupons, when this company's CLI cannot see a coupon or the switch is off.
 * `verifiedAt` is the plans.json date. No date is not invented.
 */
export function manualCouponNote(verifiedAt: string | null, closed: boolean): string {
  const parsed = verifiedAt ? Date.parse(verifiedAt) : NaN;
  const checked = Number.isNaN(parsed) ? t("coupons.cli.checkedUnknown") : t("coupons.cli.checkedOn", { date: tokyoDateLabel(verifiedAt ?? "") });
  const head = closed ? t("coupons.cli.manualClosed") : t("coupons.cli.manualUnseen");
  return `${head}${checked}`;
}

/** Only a literal false turns the read off. A missing field stays on. */
export function couponCliReadEnabled(value: unknown): boolean {
  return value !== false;
}

/**
 * Which non-interactive CLI can see reset coupons.
 * Claude, SuperGrok, and Cursor cannot. Cursor is never `cursor-agent`: that screen drops the local login, and Cursor has no coupon.
 */
export type CouponCliKind = "none" | "codex-rate-limits";

export function couponCliKind(company: CouponCompany): CouponCliKind {
  return company === "chatgpt" ? "codex-rate-limits" : "none";
}

/**
 * Companies whose CLI should be started, among the companies the plans define (the keys of `enabled`).
 * An off switch or a CLI that cannot see coupons yields nothing.
 */
export function couponCliTargets(enabled: Partial<Record<CouponCompany, boolean>>): CouponCompany[] {
  return Object.keys(enabled).filter((company) => couponCliKind(company) !== "none" && enabled[company] !== false);
}

/**
 * Non-interactive argv. Empty unless Codex coupon reading is on.
 * Never a browser, never `cursor-agent`, never login, logout, or a consume call.
 */
export function couponCliArgv(company: CouponCompany, enabled: boolean): readonly string[] {
  if (!enabled || couponCliKind(company) !== "codex-rate-limits") return [];
  return ["codex", "app-server", "--listen", "stdio://"];
}

/** Read-only Codex app-server method. The consume method is never built here. */
export const CODEX_RATE_LIMITS_METHOD = "account/rateLimits/read";

/**
 * True only for an explicit logged-out phrase.
 * A warning that merely contains "login" is not a failed read.
 */
export function codexStderrLooksLoggedOut(text: string): boolean {
  return /not logged in|please log in|login required/i.test(text);
}

export function codexRateLimitsRequest(id: number): { jsonrpc: "2.0"; id: number; method: string; params: Record<string, never> } {
  return { jsonrpc: "2.0", id, method: CODEX_RATE_LIMITS_METHOD, params: {} };
}

export function isCouponKind(value: unknown): value is CouponKind {
  return value === "weekly" || value === "session" || value === "full" || value === "unknown";
}

export function asResetCoupon(value: unknown): ResetCoupon | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.count !== "number" || !isCouponKind(row.kind)) return null;
  if (typeof row.shiftsWeeklyReset !== "boolean" || typeof row.where !== "string") return null;
  const burnWeek = parseBurnWeek(row.burnWeek);
  const unpauseProfiles = parseUnpauseProfiles(row.unpauseProfiles);
  return {
    count: row.count,
    kind: row.kind,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    shiftsWeeklyReset: row.shiftsWeeklyReset,
    where: row.where,
    source: typeof row.source === "string" ? row.source : "",
    verifiedAt: typeof row.verifiedAt === "string" ? row.verifiedAt : "",
    ...(burnWeek ? { burnWeek } : {}),
    ...(unpauseProfiles.length > 0 ? { unpauseProfiles } : {}),
  };
}

export type LimitResetChoice = "accept" | "decline" | "abort";

const LIMIT_LOGIN_RE = /sign(?:ing)?\s+in|\blog[\s-]?in\b|\blogin\b|not logged in/i;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a CLI screen asks to sign in (English, or the localized "please log in" in any catalog language). */
export function screenAsksLogin(text: string): boolean {
  if (LIMIT_LOGIN_RE.test(text)) return true;
  return new RegExp(tAll("coupons.cli.loginWord").map(escapeRegex).join("|"), "i").test(text);
}

/**
 * What to do with a `/limit-reset` frame.
 * Accept only when the caller asked for a weekly refill and the box says weekly.
 * Anything we cannot read, a login, or a timeout does not choose the yes option.
 */
export function chooseLimitReset(frame: string | null, opts: { confirmWeekly: boolean; timedOut: boolean }): { choice: LimitResetChoice; refill: string | null; reason: string } {
  if (opts.timedOut) return { choice: "abort", refill: null, reason: t("coupons.cli.reasonTimeout") };
  const text = (frame ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  if (screenAsksLogin(text)) return { choice: "abort", refill: null, reason: t("coupons.cli.reasonLogin") };
  if (!text.includes("Use your reset?") || !text.includes("Refills your")) {
    return { choice: "abort", refill: null, reason: t("coupons.cli.reasonUnreadable") };
  }
  const start = text.indexOf("Refills your");
  let refill = text.slice(start);
  const cut = refill.search(/\n|No, keep it/);
  if (cut > 0) refill = refill.slice(0, cut);
  refill = refill.replace(/\s+/g, " ").trim();
  if (!refill.startsWith("Refills your")) return { choice: "abort", refill: null, reason: t("coupons.cli.reasonUnreadable") };
  // The box always mentions the weekly reset day. A 5-hour refill is the free window, not the coupon.
  if (/5[\s-]*hour|session limit/i.test(refill)) return { choice: "decline", refill, reason: t("coupons.cli.reasonSession") };
  if (opts.confirmWeekly && /refills your weekly/i.test(refill)) return { choice: "accept", refill, reason: t("coupons.cli.reasonWeekly") };
  return { choice: "decline", refill, reason: opts.confirmWeekly ? t("coupons.cli.reasonNotWeekly") : t("coupons.cli.reasonLookOnly") };
}
