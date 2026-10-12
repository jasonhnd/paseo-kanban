/// <reference types="node" />
// Shapes and file paths for the reset-coupon round. No behavior here.
import { join } from "node:path";
import { kanbanConfigPath } from "./paths";
import { STATE_DIR } from "./util";
import type { ClaudeBurnClock, CouponCompany, CouponKind } from "../../shared/fleet/reset-coupons";

export const RESET_COUPON_STATE = join(STATE_DIR, "reset-coupons.json");
/** Credits balance from the same read-only rate-limits call. Not in git. */
export const CODEX_CREDITS_FILE = join(STATE_DIR, "codex-credits.json");
export const PLANS = join(STATE_DIR, "plans.json");
export const KANBAN_CONFIG = kanbanConfigPath();

export interface CompanyLive {
  count: number;
  kind: CouponKind;
  expiresAt: string | null;
  excerpt: string;
  confirmedAt: string;
  via: "paseo" | "cli" | "plans";
  /** ok: this read worked. unreadable: the CLI that can see coupons failed, previous numbers kept. manual: the CLI cannot see coupons. off: the switch is off. */
  status: "ok" | "unreadable" | "manual" | "off";
  /** Titles and expiries from a read. Credit ids are not kept. */
  items?: { title: string; expiresAt: string | null }[];
  typeText?: string | null;
}

export interface CouponNotice {
  key: string;
  who: "afc" | "all";
  text: string;
  /** Keys to treat as sent. Defaults to this notice's own key. A surplus broadcast marks every slot it covers. */
  mark?: string[];
}

export interface CouponHomeNote {
  kind: string;
  text: string;
  at: string;
}

export interface ResetCouponState {
  attemptedAt: string | null;
  companies: Partial<Record<CouponCompany, CompanyLive>>;
  claudeUsedAt: string | null;
  lastWeeklyUsedPct: number | null;
  /** resetsAt of the weekly reading stored with lastWeeklyUsedPct. A change means the week rolled. */
  lastWeeklyResetsAt: string | null;
  lastClaudeCount: number | null;
  lastUseNotifyAt: string | null;
  announcedWeekStart: string | null;
  /** Weekly percent at the moment the coupon was seen as used. The back-half pace line starts here. */
  claudeBurnBaselinePct: number | null;
  /** Set by bin/afc-use-coupon after the user agreed and the command chose yes. The plugin never sets this itself. */
  afcYesAt?: { claude?: string | null; codex?: string | null } | null;
  /** Claude confirmation-box sentence. Absent until `/limit-reset` has been read. */
  claudeRefillText?: string | null;
  lastCodexUsedPct?: number | null;
  lastCodexResetsAt?: string | null;
  /** Keep the observed refill time after its one-use confirmation mark is consumed. */
  codexQuotaResetAt?: string | null;
  /** Coupon count observed with lastCodexUsedPct. Later reads of the count alone do not move this. */
  codexCountAtLastUsage?: number | null;
  sentNoticeKeys?: string[];
  pendingNotices?: CouponNotice[];
  homeNotes?: CouponHomeNote[];
  /** Bumped when an episode ends, so the next hit can notify once more. */
  noticeGen?: Partial<Record<string, number>>;
}

export interface CouponBurnView extends ClaudeBurnClock {
  baselinePct: number;
  usedAtMs: number;
}

export interface CouponBoardView {
  claudeDoubleWeek: boolean;
  claudeStopPct: number;
  /** Set during a named burn week. Dispatch uses this instead of the computed double week. */
  claudeBurn: CouponBurnView | null;
  /** Home-page sentence while the named week is running. Null otherwise. */
  banner: string | null;
  lines: Partial<Record<CouponCompany, { line: string; plan: string | null }>>;
  /** Shown ChatGPT coupon count. Above zero moves the stop line to 97%. */
  codexCouponCount: number;
  /** Earliest shown ChatGPT coupon expiry. Null when the count was not paired with a date. */
  codexCouponExpiresAt: string | null;
  /** User-authorised ChatGPT burn week from plans.json. Null keeps DEMO_0070 (never prefer the Codex pool). */
  codexBurnWeek: { start: string; end: string } | null;
  /** Null keeps plans.json stopPct (80% when that file still says so). */
  codexStopPct: number | null;
}

export const EMPTY_STATE: ResetCouponState = {
  attemptedAt: null,
  companies: {},
  claudeUsedAt: null,
  lastWeeklyUsedPct: null,
  lastWeeklyResetsAt: null,
  lastClaudeCount: null,
  lastUseNotifyAt: null,
  announcedWeekStart: null,
  claudeBurnBaselinePct: null,
};
