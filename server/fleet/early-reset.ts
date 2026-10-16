/// <reference types="node" />
// Official early reset (DEMO_0124): file I/O around shared/early-reset.ts.
// trackEarlyResets runs with every pool-status write (files only, safe on the panel path).
// deliverEarlyResetNotices runs `paseo send`, so only the pool refresh timer calls it, never the panel path.
import { join } from "node:path";
import {
  type CouponFacts,
  type EarlyResetState,
  earlyResetLines,
  earlyResetNotice,
  type LastReading,
  parseEarlyResetState,
  pendingEarlyResetNotices,
  type PoolReading,
  stepEarlyResets,
} from "../../shared/fleet/early-reset";
import { poolCatalog, poolNames, resetShiftingCoupons } from "../../shared/fleet/quota-adapters";
import { plansOf } from "./adapters/plans";
import type { PoolStatus } from "./pools-types";
import { QUOTA_HISTORY_FILE } from "./quota-history";
import { KANBAN_CONFIG, PLANS, RESET_COUPON_STATE } from "./reset-coupons-types";
import { type Json, readJson, STATE_DIR, writeJson } from "./util";
import { readOpsProject } from "./adapters/config";
import { readSupervisorTable, supervisorIdFor } from "../../shared/fleet/decisions";

export const EARLY_RESET_FILE = join(STATE_DIR, "early-resets.json");

type Notify = (agentId: string, text: string) => Promise<void>;
let notifyRef: Notify | null = null;
/** Event keys whose send has not finished, so two rounds never send the same notice twice. */
const inflight = new Set<string>();

export function setEarlyResetNotify(notify: Notify | null): void {
  notifyRef = notify;
}

const keyOf = (event: { pool: string; afterResetsAt: string }) => `${event.pool}|${event.afterResetsAt}`;

function readingsOf(pools: Record<string, PoolStatus>): Record<string, PoolReading> {
  return Object.fromEntries(Object.entries(pools).map(([key, row]) => [key, { usedPct: row.usedPct, resetsAt: row.resetsAt }]));
}

/** plans.json resetCoupons count per pool, used as the baseline the first time the file is created. */
function planCouponCounts(plans: Json): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const list = Array.isArray(plans.plans) ? (plans.plans as Json[]) : [];
  for (const pool of Object.keys(resetShiftingCoupons(plansOf(plans)))) {
    const coupons = list.find((plan) => plan.id === pool)?.resetCoupons;
    out[pool] = Array.isArray(coupons) ? (coupons as Json[]).reduce((sum, row) => sum + (typeof row.count === "number" ? row.count : 0), 0) : null;
  }
  return out;
}

/**
 * Coupon count and its read time from the last CLI read in reset-coupons.json (null unless really read), and
 * afc-use-coupon marks, for each pool whose coupon moves the reset (`shifting`: pool → coupon company).
 */
function couponFactsOf(coupons: Json, shifting: Readonly<Record<string, string>>): CouponFacts {
  const companies = (coupons.companies ?? {}) as Record<string, Json>;
  const yes = (coupons.afcYesAt ?? {}) as Record<string, unknown>;
  const count: Record<string, number | null> = {};
  const countAt: Record<string, string | null> = {};
  const afcYesAt: Record<string, string | null> = {};
  for (const [pool, company] of Object.entries(shifting)) {
    const row = companies[company];
    const read = row && row.status === "ok" && typeof row.count === "number";
    count[pool] = read ? (row.count as number) : null;
    countAt[pool] = read && typeof row.confirmedAt === "string" ? row.confirmedAt : null;
    const mark = yes[company === "chatgpt" ? "codex" : company];
    afcYesAt[pool] = typeof mark === "string" ? mark : null;
  }
  return { count, countAt, afcYesAt };
}

/** First run: the last quota-history sample is the previous reading, with plans.json coupon counts as its baseline. */
async function bootstrap(): Promise<EarlyResetState> {
  const [history, plans] = await Promise.all([
    readJson<{ samples?: Array<{ at?: unknown; pools?: Record<string, { usedPct?: unknown; resetsAt?: unknown }> }> }>(QUOTA_HISTORY_FILE, { samples: [] }),
    readJson<Json>(PLANS, {}),
  ]);
  const samples = Array.isArray(history.samples) ? history.samples : [];
  const sample = samples[samples.length - 1];
  const counts = planCouponCounts(plans);
  const last: Record<string, LastReading> = {};
  if (sample && typeof sample.at === "string") {
    for (const [pool, row] of Object.entries(sample.pools ?? {})) {
      if (typeof row?.usedPct !== "number" || typeof row.resetsAt !== "string") continue;
      last[pool] = { usedPct: row.usedPct, resetsAt: row.resetsAt, at: sample.at, ...(pool in counts ? { couponCount: counts[pool] } : {}) };
    }
  }
  return { last, events: [] };
}

async function readState(): Promise<EarlyResetState | null> {
  return parseEarlyResetState(await readJson<unknown>(EARLY_RESET_FILE, null));
}

/** Compare this round's pools with the last reading and store the result. Carried percents must already be nulled. */
export async function trackEarlyResets(pools: Record<string, PoolStatus>, now: number): Promise<EarlyResetState> {
  const [stored, coupons, plansFile] = await Promise.all([readState(), readJson<Json>(RESET_COUPON_STATE, {}), readJson<Json>(PLANS, {})]);
  const plans = plansOf(plansFile);
  const monthly = poolCatalog(plans).filter((pool) => pool.period === "month").map((pool) => pool.id);
  const state = stored ?? (await bootstrap());
  const next = stepEarlyResets(state, readingsOf(pools), now, couponFactsOf(coupons, resetShiftingCoupons(plans)), monthly);
  await writeJson(EARLY_RESET_FILE, next);
  return next;
}

/** Quota page lines per pool, still inside their 7 days. File read only. */
export async function readEarlyResetLines(now: number): Promise<Record<string, string>> {
  const state = await readState();
  return state ? earlyResetLines(state.events, now) : {};
}

async function afcLeader(): Promise<string | null> {
  const raw = await readJson<Json>(KANBAN_CONFIG, {});
  const id = supervisorIdFor(readOpsProject(), readSupervisorTable(raw));
  return typeof id === "string" && id.length >= 8 ? id : null;
}

/** Send each pending notice to the AFC leader once. Marked only after the send succeeds; a miss retries next round. */
export async function deliverEarlyResetNotices(now: number): Promise<number> {
  const notify = notifyRef;
  const state = await readState();
  if (!notify || !state) return 0;
  const due = pendingEarlyResetNotices(state.events, now).filter((event) => !inflight.has(keyOf(event)));
  if (due.length === 0) return 0;
  const leader = await afcLeader();
  if (!leader) {
    console.error("[afc] early reset: kanban.config.json has no Kanban <leader>; the early-reset notice waits for the next round");
    return 0;
  }
  const plans = plansOf(await readJson<Json>(PLANS, {}));
  const shortNames = poolNames(poolCatalog(plans), "short");
  const shifting = resetShiftingCoupons(plans);
  const sent: string[] = [];
  for (const event of due) {
    inflight.add(keyOf(event));
    try {
      await notify(leader, earlyResetNotice(event, shortNames, shifting));
      sent.push(keyOf(event));
    } catch (error) {
      console.error("[afc] early reset: notify failed", String(error).slice(0, 160));
    } finally {
      inflight.delete(keyOf(event));
    }
  }
  if (sent.length === 0) return 0;
  const latest = (await readState()) ?? state;
  const at = new Date(now).toISOString();
  await writeJson(EARLY_RESET_FILE, { ...latest, events: latest.events.map((event) => (sent.includes(keyOf(event)) ? { ...event, notifiedAt: at } : event)) });
  return sent.length;
}
