import { WEEK_MS, tokyoParts } from "./reset-coupons-core";
import { sameResetWindow } from "./reset-coupons-usage";
import { t } from "./i18n";

/**
 * Spendable ChatGPT credits stay above this balance.
 * At or under it, dispatch does not cross from the weekly quota into credits.
 */
export const CODEX_CREDITS_FLOOR = 10_000;
/** A credits balance older than this is not a reading dispatch may use. */
export const CODEX_CREDITS_MAX_AGE_MS = 60 * 60 * 1000;

export interface CodexCreditsInput {
  startAt: string;
  expireAt: string;
  /** Null when this hour's read did not produce a balance. */
  balance: number | null;
  /**
   * Credits spent since the weekly window's first reading.
   * Null means that drop was not measured; a known balance then counts as none spent yet.
   */
  usedThisWeek: number | null;
}

export interface CodexCreditsDecision {
  /** False before `startAt`: the weekly stop stays, and credits are not a quota. */
  applies: boolean;
  dispatchable: boolean;
  reason: string;
  /** Credits that may be spent this week, above the floor. Null when the layer is not budgeting. */
  weeklyBudget: number | null;
}

/**
 * Third layer, after the weekly quota is already spent.
 * Before `startAt`, this does not apply. After it, a missing balance, a balance at or under the floor,
 * or spending past this week's share of (balance − floor) until `expireAt` cannot take work.
 */
export function codexCreditsLayer(now: number, input: CodexCreditsInput): CodexCreditsDecision {
  const start = Date.parse(input.startAt);
  const expire = Date.parse(input.expireAt);
  const closed = { applies: true, dispatchable: false, weeklyBudget: null as number | null };
  if (Number.isNaN(start) || Number.isNaN(expire) || expire <= start) {
    return { ...closed, reason: t("coupons.credits.datesUnread") };
  }
  if (now < start) return { applies: false, dispatchable: false, reason: "", weeklyBudget: null };
  if (now >= expire) return { ...closed, reason: t("coupons.credits.expired") };
  if (input.balance === null || !Number.isFinite(input.balance)) {
    return { ...closed, reason: t("coupons.credits.unread") };
  }
  if (input.balance <= CODEX_CREDITS_FLOOR) {
    return { ...closed, reason: t("coupons.credits.floor", { balance: Math.round(input.balance), floor: CODEX_CREDITS_FLOOR }) };
  }
  const weeks = (expire - now) / WEEK_MS;
  if (!(weeks > 0)) return { ...closed, reason: t("coupons.credits.expired") };
  const weeklyBudget = (input.balance - CODEX_CREDITS_FLOOR) / weeks;
  if (input.usedThisWeek === null || !Number.isFinite(input.usedThisWeek)) {
    return { ...closed, weeklyBudget, reason: t("coupons.credits.weekUnknown") };
  }
  const used = Math.max(0, input.usedThisWeek);
  if (used > weeklyBudget) {
    return {
      applies: true,
      dispatchable: false,
      weeklyBudget,
      reason: t("coupons.credits.overBudget", { used: Math.round(used), budget: Math.round(weeklyBudget) }),
    };
  }
  return {
    applies: true,
    dispatchable: true,
    weeklyBudget,
    reason: t("coupons.credits.using", { balance: Math.round(input.balance), budget: Math.round(weeklyBudget), used: Math.round(used) }),
  };
}

export interface CodexCreditsFile {
  balance: number | null;
  readAt: string | null;
  /** Balance at the first reading of the current weekly window. */
  weekBalance: number | null;
  weekResetsAt: string | null;
  /** False when the latest attempt did not return a balance. */
  readable: boolean;
}

/**
 * Fold one read into the credits file. A failed read keeps the last balance but is not readable.
 * A new weekly baseline is stored only when this read names a reset instant and that instant
 * is not the one already on file. A later read that omits the instant keeps the baseline.
 * With no instant and no baseline, the week total stays unknown instead of starting at zero.
 */
export function nextCodexCreditsState(
  prev: CodexCreditsFile | null,
  reading: { balance: number | null; at: number; resetsAt: string | null },
): CodexCreditsFile {
  const readAt = new Date(reading.at).toISOString();
  if (reading.balance === null || !Number.isFinite(reading.balance)) {
    return {
      balance: prev?.balance ?? null,
      readAt,
      weekBalance: prev?.weekBalance ?? null,
      weekResetsAt: prev?.weekResetsAt ?? null,
      readable: false,
    };
  }
  const resetsAt = typeof reading.resetsAt === "string" && reading.resetsAt.length > 0 ? reading.resetsAt : null;
  const prevWeek = typeof prev?.weekBalance === "number" && Number.isFinite(prev.weekBalance) ? prev.weekBalance : null;
  const prevResets = prev?.weekResetsAt ?? null;
  const samePeriod = resetsAt === prevResets || sameResetWindow(prevResets, resetsAt);
  const periodChanged = Boolean(resetsAt && prevResets && !samePeriod);
  // A missing instant keeps the last named week. An instant that was never stored does not.
  const keepBaseline = prevWeek !== null && !periodChanged && (resetsAt === null || samePeriod);
  return {
    balance: reading.balance,
    readAt,
    weekBalance: keepBaseline ? prevWeek : resetsAt ? reading.balance : null,
    weekResetsAt: periodChanged || (resetsAt && !keepBaseline) ? resetsAt : (prevResets ?? resetsAt),
    readable: true,
  };
}

/** Credits spent since the first reading of this weekly window. Null when the week cannot be confirmed. */
export function creditsUsedThisWeek(state: CodexCreditsFile | null): number | null {
  if (!state?.readable || state.balance === null || state.weekBalance === null || !state.weekResetsAt) return null;
  return Math.max(0, state.weekBalance - state.balance);
}

/** True when the stored reading is missing or at least an hour old, so another read is due. */
export function creditsReadDue(readAt: string | null | undefined, now: number): boolean {
  if (!readAt) return true;
  const at = Date.parse(readAt);
  if (Number.isNaN(at)) return true;
  return now - at >= CODEX_CREDITS_MAX_AGE_MS;
}

/**
 * Balance dispatch may use. A failed or hour-old reading is null, which the credits layer refuses.
 */
export function creditsBalanceForDispatch(state: CodexCreditsFile | null, now: number): { balance: number | null; usedThisWeek: number | null } {
  if (!state?.readable || state.balance === null || creditsReadDue(state.readAt, now)) {
    return { balance: null, usedThisWeek: null };
  }
  return { balance: state.balance, usedThisWeek: creditsUsedThisWeek(state) };
}

function tokyoMonthDay(iso: string): string {
  const p = tokyoParts(Date.parse(iso));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.m)}/${pad(p.d)}`;
}

/** Quota-card sentence. Dates are Tokyo calendar days. A missing balance says so. */
export function codexCreditsCardLine(input: {
  balance: number | null;
  fresh: boolean;
  startAt: string;
  expireAt: string;
}): string {
  const when = t("coupons.credits.when", { start: tokyoMonthDay(input.startAt), end: tokyoMonthDay(input.expireAt) });
  if (input.balance === null || !Number.isFinite(input.balance)) return t("coupons.credits.lineUnread", { when });
  const n = Math.round(input.balance).toLocaleString("en-US");
  const stale = input.fresh ? "" : t("coupons.credits.stale");
  return t("coupons.credits.line", { balance: n, stale, when });
}
