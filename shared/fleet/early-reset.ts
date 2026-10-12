// Official early reset (DEMO_0124): a pool's usage falls hard and its reset time moves, well before the old reset,
// with no coupon spent. 10-07 OpenAI reset ChatGPT 78% → 0% (next reset 10-14) and it was first taken for a coupon.
// Pure functions: the server reads the files, these decide.
import { USED_DROP_POINTS } from "./reset-coupons-core";
import { sameResetWindow } from "./reset-coupons-usage";
import { t } from "./i18n";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TOKYO_OFFSET_MS = 9 * HOUR_MS;

/** A drop this close to the old reset time is the natural reset, not an early one. */
export const EARLY_RESET_MARGIN_MS = HOUR_MS;
/** The quota page shows the line this long after the reset. */
export const EARLY_RESET_SHOW_MS = 7 * DAY_MS;
/** While the coupon count after a drop is not read yet, the old reading is kept at most this long. */
export const COUNT_WAIT_MS = DAY_MS;
/** Older events are dropped from the file. */
const KEEP_MS = 30 * DAY_MS;
const MAX_EVENTS = 50;

export interface PoolReading {
  usedPct: number | null;
  resetsAt: string | null;
}

export interface LastReading {
  usedPct: number;
  resetsAt: string;
  at: string;
  /** Coupon count seen with this reading, for pools whose coupon moves the reset (CouponFacts). Null when not known. */
  couponCount?: number | null;
}

export interface EarlyResetEvent {
  pool: string;
  /** Best guess of when it happened: start of the new weekly period, inside the gap between the two readings. */
  at: string;
  detectedAt: string;
  beforePct: number;
  afterPct: number;
  beforeResetsAt: string;
  afterResetsAt: string;
  /** Coupon count after the reset, for pools whose coupon could have caused it. */
  couponCount: number | null;
  /** Set once the AFC leader got the notice. */
  notifiedAt: string | null;
}

export interface EarlyResetState {
  last: Record<string, LastReading>;
  events: EarlyResetEvent[];
}

/**
 * Coupon facts at this moment, per pool whose coupon moves the reset time (so a coupon could look like an early
 * reset; shared/quota-adapters.ts resetShiftingCoupons): `count` from the last real CLI read and when that read was
 * (`countAt`), and the bin/afc-use-coupon mark (`afcYesAt`). `count` has a key for exactly those pools.
 */
export interface CouponFacts {
  count: Record<string, number | null>;
  countAt: Record<string, string | null>;
  afcYesAt: Record<string, string | null>;
}

/** no: no coupon could explain it. coupon: one did (or may have). unread: the count was not read since the drop. */
type CouponCheck = "no" | "coupon" | "unread";

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** True when this pool's coupon moves the reset time (CouponFacts lists exactly those). */
function shiftsReset(pool: string, facts: CouponFacts): boolean {
  return Object.prototype.hasOwnProperty.call(facts.count, pool);
}

/**
 * Weekly pools: the new period started 7 days before the new reset. Clamped into (previous reading, now].
 * Monthly pools (`monthly`) have no such guess: the time is when the drop was seen.
 */
function guessAt(monthly: boolean, last: LastReading, afterResetsAt: string, now: number): string {
  const start = monthly ? Number.NaN : ms(afterResetsAt) - 7 * DAY_MS;
  const from = ms(last.at);
  if (Number.isFinite(start) && (!Number.isFinite(from) || start > from) && start <= now) return new Date(start).toISOString();
  return new Date(now).toISOString();
}

/** Fewer coupons or an afc-use-coupon mark since the last reading means a coupon; a count not read since then is unread. */
function couponCheck(pool: string, last: LastReading, facts: CouponFacts): CouponCheck {
  if (!shiftsReset(pool, facts)) return "no";
  const yes = ms(facts.afcYesAt[pool]);
  if (Number.isFinite(yes) && yes >= ms(last.at) - EARLY_RESET_MARGIN_MS) return "coupon";
  const before = last.couponCount;
  const after = facts.count[pool];
  if (!isNum(before)) return "coupon";
  if (!isNum(after) || !(ms(facts.countAt[pool]) >= ms(last.at))) return "unread";
  return after < before ? "coupon" : "no";
}

type Verdict = { event: EarlyResetEvent | null; hold: boolean };

/**
 * One pool, previous reading → this one. `event` only for an official early reset. `hold` keeps the previous
 * reading for the next round when the coupon count after the drop has not been read yet (up to COUNT_WAIT_MS).
 */
/** `monthly`: pools with a calendar-month period (shared/quota-adapters.ts PoolEntry.period). */
export function judgeEarlyReset(pool: string, last: LastReading | undefined, next: PoolReading, now: number, facts: CouponFacts, monthly: readonly string[] = []): Verdict {
  const none = { event: null, hold: false };
  if (!last || !isNum(next.usedPct) || !next.resetsAt) return none;
  if (!(last.usedPct - next.usedPct >= USED_DROP_POINTS)) return none;
  if (sameResetWindow(last.resetsAt, next.resetsAt)) return none;
  const oldReset = ms(last.resetsAt);
  if (!Number.isFinite(oldReset) || now >= oldReset - EARLY_RESET_MARGIN_MS) return none;
  const coupon = couponCheck(pool, last, facts);
  if (coupon === "unread") return { event: null, hold: now - ms(last.at) < COUNT_WAIT_MS };
  if (coupon === "coupon") return none;
  return { hold: false, event: {
    pool,
    at: guessAt(monthly.includes(pool), last, next.resetsAt, now),
    detectedAt: new Date(now).toISOString(),
    beforePct: last.usedPct,
    afterPct: next.usedPct,
    beforeResetsAt: last.resetsAt,
    afterResetsAt: next.resetsAt,
    couponCount: shiftsReset(pool, facts) ? facts.count[pool] ?? null : null,
    notifiedAt: null,
  } };
}

/** Null unless it is an official early reset. */
export function detectEarlyReset(pool: string, last: LastReading | undefined, next: PoolReading, now: number, facts: CouponFacts, monthly: readonly string[] = []): EarlyResetEvent | null {
  return judgeEarlyReset(pool, last, next, now, facts, monthly).event;
}

/**
 * Compare every pool with its last reading, append new events (one per pool and new reset), and remember this
 * reading. A pool with no percent or no reset time this round, or one waiting for its coupon count, keeps the old one.
 */
export function stepEarlyResets(state: EarlyResetState, readings: Record<string, PoolReading>, now: number, facts: CouponFacts, monthly: readonly string[] = []): EarlyResetState {
  const last: Record<string, LastReading> = { ...state.last };
  const found: EarlyResetEvent[] = [];
  for (const [pool, next] of Object.entries(readings)) {
    const { event, hold } = judgeEarlyReset(pool, state.last[pool], next, now, facts, monthly);
    const known = event && state.events.some((row) => row.pool === pool && sameResetWindow(row.afterResetsAt, event.afterResetsAt));
    if (event && !known) found.push(event);
    if (hold || !isNum(next.usedPct) || !next.resetsAt) continue;
    const count = shiftsReset(pool, facts) ? { couponCount: facts.count[pool] ?? null } : {};
    last[pool] = { usedPct: next.usedPct, resetsAt: next.resetsAt, at: new Date(now).toISOString(), ...count };
  }
  const events = [...state.events, ...found].filter((row) => now - ms(row.at) < KEEP_MS).slice(-MAX_EVENTS);
  return { last, events };
}

/** Reads a stored file. Anything unusable becomes empty, never an error. */
export function parseEarlyResetState(raw: unknown): EarlyResetState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as { last?: unknown; events?: unknown };
  const last: Record<string, LastReading> = {};
  if (row.last && typeof row.last === "object") {
    for (const [pool, value] of Object.entries(row.last as Record<string, Partial<LastReading>>)) {
      if (!value || !isNum(value.usedPct) || typeof value.resetsAt !== "string" || typeof value.at !== "string") continue;
      last[pool] = { usedPct: value.usedPct, resetsAt: value.resetsAt, at: value.at, ...(value.couponCount !== undefined ? { couponCount: isNum(value.couponCount) ? value.couponCount : null } : {}) };
    }
  }
  const events = Array.isArray(row.events)
    ? (row.events as Partial<EarlyResetEvent>[]).filter(
      (e): e is EarlyResetEvent => typeof e?.pool === "string" && typeof e.at === "string" && isNum(e.beforePct) && isNum(e.afterPct)
        && typeof e.beforeResetsAt === "string" && typeof e.afterResetsAt === "string",
    ).map((e) => ({ ...e, couponCount: isNum(e.couponCount) ? e.couponCount : null, notifiedAt: typeof e.notifiedAt === "string" ? e.notifiedAt : null, detectedAt: typeof e.detectedAt === "string" ? e.detectedAt : e.at }))
    : [];
  return { last, events };
}

function tokyo(iso: string, withTime: boolean): string {
  const d = new Date(ms(iso) + TOKYO_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return withTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

/** "10/7 official early reset (not a coupon)" for 7 days after the reset; null after that. */
export function earlyResetLine(event: EarlyResetEvent, now: number): string | null {
  const at = ms(event.at);
  if (!Number.isFinite(at) || now - at >= EARLY_RESET_SHOW_MS || now < at) return null;
  return t("earlyReset.line", { date: tokyo(event.at, false) });
}

/** Latest line per pool still inside its 7 days. */
export function earlyResetLines(events: EarlyResetEvent[], now: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const event of events) {
    const line = earlyResetLine(event, now);
    if (line) out[event.pool] = line;
  }
  return out;
}

/**
 * The one notice to the AFC leader. `shortNames`: pool id → short name (shared/quota-adapters.ts poolNames(catalog,
 * "short")); `shifting`: pools whose coupon moves the reset (resetShiftingCoupons).
 */
export function earlyResetNotice(event: EarlyResetEvent, shortNames: Readonly<Record<string, string>> = {}, shifting: Readonly<Record<string, string>> = {}): string {
  const name = shortNames[event.pool] ?? event.pool;
  const coupon = Object.prototype.hasOwnProperty.call(shifting, event.pool)
    ? t("earlyReset.couponShifting", { count: event.couponCount ?? "?" })
    : t("earlyReset.couponNone");
  return t("earlyReset.notice", {
    name,
    at: tokyo(event.at, true),
    before: Math.round(event.beforePct),
    after: Math.round(event.afterPct),
    beforeReset: tokyo(event.beforeResetsAt, true),
    afterReset: tokyo(event.afterResetsAt, true),
    coupon,
  });
}

/** Events that still need the notice: not sent yet and still inside the 7 days. */
export function pendingEarlyResetNotices(events: EarlyResetEvent[], now: number): EarlyResetEvent[] {
  return events.filter((event) => !event.notifiedAt && earlyResetLine(event, now) !== null);
}
