/// <reference types="node" />
// Reading the saved coupon state and plans.json, plus the lock that serializes rounds.
import { asResetCoupon, couponCliReadEnabled, tokyoParts, type CouponCompany, type ResetCoupon } from "../../shared/fleet/reset-coupons";
import { companyCatalog } from "../../shared/fleet/quota-adapters";
import { plansOf } from "./adapters/plans";
import { readJson } from "./util";
import { EMPTY_STATE, PLANS, RESET_COUPON_STATE, type CouponHomeNote, type CouponNotice, type ResetCouponState } from "./reset-coupons-types";

let tail: Promise<void> = Promise.resolve();

export function lock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

export function emptyState(): ResetCouponState {
  return { ...EMPTY_STATE, companies: {} };
}

export async function readState(): Promise<ResetCouponState> {
  const raw = await readJson<Partial<ResetCouponState> | null>(RESET_COUPON_STATE, null);
  if (!raw || typeof raw !== "object") return emptyState();
  return {
    attemptedAt: typeof raw.attemptedAt === "string" ? raw.attemptedAt : null,
    companies: raw.companies && typeof raw.companies === "object" ? raw.companies : {},
    claudeUsedAt: typeof raw.claudeUsedAt === "string" ? raw.claudeUsedAt : null,
    lastWeeklyUsedPct: typeof raw.lastWeeklyUsedPct === "number" ? raw.lastWeeklyUsedPct : null,
    lastWeeklyResetsAt: typeof raw.lastWeeklyResetsAt === "string" ? raw.lastWeeklyResetsAt : null,
    lastClaudeCount: typeof raw.lastClaudeCount === "number" ? raw.lastClaudeCount : null,
    lastUseNotifyAt: typeof raw.lastUseNotifyAt === "string" ? raw.lastUseNotifyAt : null,
    announcedWeekStart: typeof raw.announcedWeekStart === "string" ? raw.announcedWeekStart : null,
    claudeBurnBaselinePct: typeof raw.claudeBurnBaselinePct === "number" ? raw.claudeBurnBaselinePct : null,
    afcYesAt: raw.afcYesAt && typeof raw.afcYesAt === "object" ? raw.afcYesAt : null,
    claudeRefillText: typeof raw.claudeRefillText === "string" ? raw.claudeRefillText : null,
    lastCodexUsedPct: typeof raw.lastCodexUsedPct === "number" ? raw.lastCodexUsedPct : null,
    lastCodexResetsAt: typeof raw.lastCodexResetsAt === "string" ? raw.lastCodexResetsAt : null,
    codexQuotaResetAt: typeof raw.codexQuotaResetAt === "string" ? raw.codexQuotaResetAt : null,
    codexCountAtLastUsage: typeof raw.codexCountAtLastUsage === "number" ? raw.codexCountAtLastUsage : null,
    sentNoticeKeys: Array.isArray(raw.sentNoticeKeys) ? raw.sentNoticeKeys.filter((key): key is string => typeof key === "string") : [],
    pendingNotices: Array.isArray(raw.pendingNotices) ? raw.pendingNotices.filter(isNotice) : [],
    homeNotes: Array.isArray(raw.homeNotes) ? raw.homeNotes.filter(isHomeNote) : [],
    noticeGen: raw.noticeGen && typeof raw.noticeGen === "object" ? raw.noticeGen : {},
  };
}

function isNotice(value: unknown): value is CouponNotice {
  if (!value || typeof value !== "object") return false;
  const row = value as CouponNotice;
  return typeof row.key === "string" && (row.who === "afc" || row.who === "all") && typeof row.text === "string";
}

function isHomeNote(value: unknown): value is CouponHomeNote {
  if (!value || typeof value !== "object") return false;
  const row = value as CouponHomeNote;
  return typeof row.kind === "string" && typeof row.text === "string" && typeof row.at === "string";
}

/** Coupon companies of plans.json, one per plan, in plans.json order (the order of the coupon lines). */
export interface CouponPlans {
  seeds: Record<CouponCompany, ResetCoupon | null>;
  /** Missing `couponCliRead` stays on. Only a literal false is off. */
  cliRead: Record<CouponCompany, boolean>;
  /** Company → name on the coupon lines. */
  names: Record<CouponCompany, string>;
  /** Paseo provider → company whose coupon field Paseo's usage payload may carry. */
  providerCompany: Record<string, CouponCompany>;
}

/** Pure part of readPlans, from plans.json as read. */
export function couponPlansOf(raw: unknown): CouponPlans {
  const seeds: Record<CouponCompany, ResetCoupon | null> = {};
  const cliRead: Record<CouponCompany, boolean> = {};
  const names: Record<CouponCompany, string> = {};
  const providerCompany: Record<string, CouponCompany> = {};
  const plans = plansOf(raw) as Array<{ id: string; resetCoupons?: unknown; couponCliRead?: unknown; quotaCycle?: unknown; manualOverride?: unknown }>;
  const companies = companyCatalog(plansOf(raw));
  companies.forEach((entry, index) => {
    const plan = plans[index];
    const company = entry.key;
    const coupons = (Array.isArray(plan.resetCoupons) ? plan.resetCoupons : []).map(asResetCoupon).filter((row): row is ResetCoupon => row !== null);
    // Using Claude's last coupon leaves count 0, but its named burn week still
    // supplies the back-half clock until week end. Keep it as a fallback only;
    // available coupons retain their existing selection priority.
    seeds[company] = coupons.find((row) => row.count > 0)
      ?? (company === "claude" ? coupons.find((row) => row.count === 0 && row.burnWeek) : undefined)
      ?? null;
    const configured = plan.quotaCycle !== undefined || plan.manualOverride !== undefined;
    cliRead[company] = configured && plan.couponCliRead === undefined ? false : couponCliReadEnabled(plan.couponCliRead);
    names[company] = entry.couponName;
    if (!configured || cliRead[company]) for (const provider of entry.providers) providerCompany[provider] ??= company;
  });
  return { seeds, cliRead, names, providerCompany };
}

export async function readPlans(): Promise<CouponPlans> {
  return couponPlansOf(await readJson<unknown>(PLANS, null));
}

export function sameTokyoDay(iso: string | null, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const a = tokyoParts(t);
  const b = tokyoParts(now);
  return a.y === b.y && a.m === b.m && a.d === b.d;
}
