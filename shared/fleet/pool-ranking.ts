import { canonicalPoolId, canonicalPoolCounts, canonicalPoolRows, mergeXUltraPlans, X_ULTRA, xUltraReservePct, type XUltraReserve } from "./x-ultra";
// Quota routing step 2. Pure, side-effect free; admission/model eligibility belongs to the caller.
import { isPriorityActive, type DispatchPriority } from "./dispatch-priority";
import { t } from "./i18n";
import { baseAdapterOf, poolCatalog, type PlanSource } from "./quota-adapters";
import { quotaUnknown, unknownQuotaPolicy, unknownQuotaReason, type QuotaState } from "./unknown-quota";

export const POOL_TIERS = ["L1", "L2", "L3", "L4"] as const;
export type PoolTier = typeof POOL_TIERS[number];
export interface RankingPool extends QuotaState {
  dispatchable: boolean;
  /** False retains a parent as quota evidence without making it a model candidate. */
  eligible?: boolean;
  usedPct?: number | null;
  resetsAt?: string | null;
  projectedPct?: number | null;
  runsOutAt?: string | null;
  forecastConfidence?: "high" | "low" | "none";
  /** Supply catalog metadata for custom ids; conventional ids remain compatible. */
  adapter?: string;
  providers?: readonly string[];
  parent?: string | null;
  onlyRoles?: readonly string[] | null;
  /** Current per-pool reserve. Defaults: main Codex 20, ordinary main Claude 25, sub pools/others zero. */
  reservePct?: number;
  xUltraReserve?: XUltraReserve;
  /** Current occupancy across every profile/role, as counted by G1d. */
  activeRuns?: number;
}
export interface RankedPool { pool: string; score: number; reason: string; allowedTiers: PoolTier[] }

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const pct = (n: unknown): n is number => finite(n) && n >= 0 && n <= 100;
const stamp = (s: string | null | undefined) => s ? Date.parse(s) : NaN;
const family = (id: string, row: RankingPool, name: string) =>
  id.toLowerCase().split(/[-_]/)[0] === name || row.adapter?.startsWith(`${name}-`) === true
  || row.providers?.some(provider => provider.toLowerCase() === name) === true;

/** An old cycle is unknown, never a fresh full allowance. Numeric compatibility rows are still supported. */
export function rankingQuotaUnknown(row: RankingPool, now: number): boolean {
  return quotaUnknown(row, now) || !pct(row.usedPct) || finite(stamp(row.resetsAt)) && stamp(row.resetsAt) <= now;
}

/** G1c's recent forecast, only while its quota evidence and reset are still usable. */
export function poolWillRunOut(row: RankingPool, now: number): boolean {
  if (rankingQuotaUnknown(row, now) || !["high", "low"].includes(row.forecastConfidence ?? "")) return false;
  const reset = stamp(row.resetsAt);
  if (!finite(reset) || reset <= now) return false;
  return finite(row.projectedPct) && row.projectedPct > 100
    || finite(stamp(row.runsOutAt)) && stamp(row.runsOutAt) < reset;
}

export function poolAllowedTiers(row: RankingPool, now: number): PoolTier[] {
  if (!row.dispatchable) return [];
  if (rankingQuotaUnknown(row, now)) return unknownQuotaPolicy(row.unknownQuota).tiers;
  return poolWillRunOut(row, now) ? ["L3", "L4"] : [...POOL_TIERS];
}

function candidate(pool: string, row: RankingPool, now: number, tier: string, role: string): RankedPool | null {
  if (pool !== X_ULTRA && family(pool, row, "cursor") || !row.dispatchable || row.onlyRoles?.length && !row.onlyRoles.includes(role)) return null;
  const reservePending = pool === X_ULTRA && !pct(row.reservePct);
  if (reservePending) row = { ...row, state: "unknown", unknownQuota: { ...unknownQuotaPolicy(row.unknownQuota), maxConcurrent: Math.min(1, unknownQuotaPolicy(row.unknownQuota).maxConcurrent), tiers: unknownQuotaPolicy(row.unknownQuota).tiers.filter(t => t === "L1" || t === "L2") } };
  const allowedTiers = poolAllowedTiers(row, now);
  if (!(allowedTiers as string[]).includes(tier)) return null;
  if (rankingQuotaUnknown(row, now)) {
    const policy = unknownQuotaPolicy(row.unknownQuota);
    if ((row.activeRuns ?? 0) >= policy.maxConcurrent) return null;
    return { pool, score: 0, reason: unknownQuotaReason(policy), allowedTiers };
  }
  const defaultReserve = row.parent ? 0 : family(pool, row, "codex") ? 20 : family(pool, row, "claude") ? 25 : 0;
  const reserve = pct(row.reservePct) ? row.reservePct : defaultReserve;
  const remaining = 100 - row.usedPct!;
  const surplus = remaining - reserve;
  if (surplus <= 0) return null;
  const days = (stamp(row.resetsAt) - now) / 86_400_000;
  const urgency = finite(days) && days > 0 ? surplus / Math.max(days, 0.5) : 0;
  const limited = poolWillRunOut(row, now);
  // Separate score bands: known safe > forecast-limited > unknown; maximum urgency is 200 points/day.
  const score = limited ? urgency / 1000 : 1 + urgency;
  const reason = t("quota.ranking.surplus", { remaining: +remaining.toFixed(1), reserve, surplus: +surplus.toFixed(1),
    days: finite(days) ? +days.toFixed(2) : "?" });
  return { pool, score, reason: limited ? `${reason} ${t("quota.ranking.limited")}` : reason, allowedTiers };
}

/**
 * Rank the caller's eligible pools for this role/tier. Absent rows mean no candidate.
 * Post-rollout user pins reorder safe candidates; G2c must pass null for the pre-routing fixed order.
 * G2c supplies eligible pool metadata and pool-wide occupancy, then records `reason` on the card.
 */
export function rankPools({ pools, now, tier, role, dispatchPriority = null }: {
  pools: Readonly<Record<string, RankingPool>>; now: number; tier: string; role: string;
  dispatchPriority?: DispatchPriority | null;
}): RankedPool[] {
  if (!finite(now) || !(POOL_TIERS as readonly string[]).includes(tier)) return [];
  pools = canonicalPoolRows(pools);
  let rows = Object.entries(pools).flatMap(([pool, row]) => {
    if (row.eligible === false) return [];
    const ranked = candidate(pool, row, now, tier, role);
    if (!ranked) return [];
    // A sub pool spends the parent too; it cannot bypass its reserve, hard stop or tier/role limit.
    if (row.parent) {
      const parent = pools[row.parent] && candidate(row.parent, pools[row.parent], now, tier, role);
      if (!parent) return [];
      ranked.allowedTiers = ranked.allowedTiers.filter(t => parent.allowedTiers.includes(t));
      ranked.score = Math.min(ranked.score, parent.score);
      ranked.reason = `${ranked.reason} ${t("quota.ranking.parent", { pool: row.parent, reason: parent.reason })}`;
    }
    return [ranked];
  });
  const isClaude = (pool: string) => family(pool, pools[pool], "claude")
    || !!pools[pool].parent && family(pools[pool].parent!, pools[pools[pool].parent!]!, "claude");
  if (rows.some(row => !isClaude(row.pool))) rows = rows.filter(row => !isClaude(row.pool));
  else rows = rows.map(row => ({ ...row, reason: `${row.reason} ${t("quota.ranking.fallback")}` }));
  const manual = isPriorityActive(dispatchPriority, now) ? { ...dispatchPriority, order: [...new Set(dispatchPriority.order.map(id => canonicalPoolId(id)!))] } : null;
  const place = (pool: string) => { const i = manual?.order.indexOf(pool) ?? -1; return i < 0 ? Infinity : i; };
  rows.sort((a, b) => (place(a.pool) - place(b.pool) || b.score - a.score || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0)));
  return rows.map(row => manual?.order.includes(row.pool) ? { ...row, reason: `${row.reason} ${t("quota.ranking.manual", { until: manual.until })}` } : row);
}

/** Attach catalog metadata; computed row reserves win, and plan reserves apply only to main pools. */
export function withPoolRankingMetadata(pools: Readonly<Record<string, RankingPool>>,
  plans: readonly (PlanSource & { reservePct?: number; xUltraReserve?: XUltraReserve })[], activeRuns: Readonly<Record<string, number>> = {}): Record<string, RankingPool> {
  plans = mergeXUltraPlans(plans);
  pools = canonicalPoolRows(pools);
  activeRuns = canonicalPoolCounts(activeRuns);
  const catalog = new Map(poolCatalog(plans).map(pool => [pool.id, pool]));
  const byId = new Map(plans.map(plan => [plan.id, plan]));
  return Object.fromEntries(Object.entries(pools).map(([id, row]) => {
    const entry = catalog.get(id);
    const plan = byId.get(entry?.planId ?? id);
    const parent = entry ? entry.parent : row.parent;
    const planReserve = id === X_ULTRA ? xUltraReservePct(plan?.xUltraReserve) : plan?.reservePct;
    const reserve = id === X_ULTRA ? pct(planReserve) ? { reservePct: Math.max(planReserve, pct(row.reservePct) ? row.reservePct : 0) } : { reservePct: undefined }
      : !parent && !pct(row.reservePct) && pct(planReserve) ? { reservePct: planReserve } : {};
    return [id, { ...row, ...(entry ? { parent: entry.parent } : {}),
      ...(plan ? { adapter: baseAdapterOf(plan), providers: plan.providers } : {}), ...reserve,
      activeRuns: activeRuns[id] ?? row.activeRuns ?? 0 }];
  }));
}
