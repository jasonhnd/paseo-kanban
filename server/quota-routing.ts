import { canonicalPoolId, X_ULTRA } from "../shared/fleet/x-ultra";
/// <reference types="node" />
import { parseDispatchPriority, type DispatchPriority } from "../shared/fleet/dispatch-priority";
import { rankingQuotaUnknown, type RankingPool } from "../shared/fleet/pool-ranking";
import type { CostQuery } from "../shared/fleet/run-cost";
import { costEstimate } from "./run-cost";

export interface QuotaRoutingConfig {
  enabled?: boolean;
  minSamples?: number;
  defaultCostPct?: number;
  safetyFactor?: number;
  reserves?: Record<string, number>;
  /** A new, explicit pin. Never inherits the pre-routing plans/matrix order. */
  dispatchPriority?: DispatchPriority | null;
}
export function parseQuotaRouting(raw: unknown): QuotaRoutingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("quotaRouting: expected object");
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some(k => !["enabled", "minSamples", "defaultCostPct", "safetyFactor", "reserves", "dispatchPriority"].includes(k))) throw new Error("quotaRouting: unknown key");
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new Error("quotaRouting.enabled: expected boolean");
  const valid = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (row.minSamples !== undefined && (!valid(row.minSamples, 1, 1000) || !Number.isInteger(row.minSamples))) throw new Error("quotaRouting.minSamples: expected positive integer");
  if (row.defaultCostPct !== undefined && !valid(row.defaultCostPct, 0.25, 100)) throw new Error("quotaRouting.defaultCostPct: expected percent");
  if (row.safetyFactor !== undefined && !valid(row.safetyFactor, 1, 10)) throw new Error("quotaRouting.safetyFactor: expected 1..10");
  if (row.reserves !== undefined && (!row.reserves || typeof row.reserves !== "object" || Array.isArray(row.reserves)
    || Object.values(row.reserves).some(n => !valid(n, 0, 100)))) throw new Error("quotaRouting.reserves: expected pool percentages");
  if (row.dispatchPriority != null && !parseDispatchPriority(row.dispatchPriority)) throw new Error("quotaRouting.dispatchPriority: invalid pin");
  return structuredClone(row) as QuotaRoutingConfig;
}
export function routingReserve(pool: string, row: RankingPool, settings: QuotaRoutingConfig): number {
  const configured = Object.entries(settings.reserves ?? {}).filter(([id]) => canonicalPoolId(id) === canonicalPoolId(pool)).map(([, value]) => value);
  const reserve = canonicalPoolId(pool) === X_ULTRA
    ? configured.length ? Math.max(...configured, row.reservePct ?? 0) : row.reservePct
    : settings.reserves?.[pool] ?? row.reservePct;
  if (reserve !== undefined) return reserve;
  return row.parent ? 0 : row.providers?.includes("codex") || row.adapter?.startsWith("codex-") || /^codex[-_]/.test(pool) ? 20
    : row.providers?.includes("claude") || row.adapter?.startsWith("claude-") || /^claude[-_]/.test(pool) ? 25 : 0;
}
export function routingCost(query: CostQuery, settings: QuotaRoutingConfig) {
  const estimate = costEstimate(query);
  const enough = estimate.quotaSamples >= (settings.minSamples ?? 3) && estimate.avgQuotaPct !== null;
  const measured = (estimate.avgQuotaPct ?? 0) * (settings.safetyFactor ?? 1.5);
  // Partial observations are lower bounds. Until enough quota samples exist, never shrink the default.
  const pct = Math.max(0.25, measured, enough ? 0 : settings.defaultCostPct ?? 5);
  return { pct, samples: estimate.quotaSamples, source: enough ? "observed" as const : "default" as const };
}
export function routingCostFits(pool: string, pools: Record<string, RankingPool>, pct: number, now: number,
  parentCost: (pool: string) => number = () => pct): boolean {
  const seen = new Set<string>();
  let id: string | null = pool;
  while (id) {
    if (seen.has(id)) return false;
    seen.add(id);
    const row: RankingPool | undefined = pools[id];
    if (!row) return false;
    const cost = id === pool ? pct : parentCost(id);
    if (!rankingQuotaUnknown(row, now) && 100 - row.usedPct! - (row.reservePct ?? 0) < cost) return false;
    id = row.parent ?? null;
  }
  return true;
}
