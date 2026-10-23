// One seat, one weekly first-party pool. Legacy ids are read aliases, never additive quota.
import { t } from "./i18n";
import { QUOTA_SAMPLE_MS } from "./quota-time";

export const X_ULTRA = "x-ultra";
export const X_ULTRA_ALIASES = [X_ULTRA, "supergrok", "cursor"] as const;
export function canonicalPoolId<T extends string | null | undefined>(id: T): T | string {
  return (X_ULTRA_ALIASES as readonly unknown[]).includes(id) ? X_ULTRA : id;
}
export interface XUltraReserve { botPct?: number | null; userPct?: number | null }
const pct = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
export function xUltraReservePct(value?: XUltraReserve | null): number | null {
  return pct(value?.botPct) && pct(value?.userPct) && value.botPct + value.userPct <= 100 ? value.botPct + value.userPct : null;
}

/** In-memory migration. An explicit new plan wins; old Cursor monthly/Auto data is discarded. */
export function mergeXUltraPlans<T extends { id: string }>(plans: readonly T[]): T[] {
  const shared = plans.filter(p => canonicalPoolId(p.id) === X_ULTRA);
  if (!shared.length) return [...plans];
  const primary = shared.find(p => p.id === X_ULTRA) ?? shared.find(p => p.id === "supergrok") ?? shared[0];
  const row = { ...primary } as T & Record<string, unknown>;
  if (primary.id !== X_ULTRA) {
    delete row.cycleDay;
    delete row.manual;
    delete row.manualOverride;
    delete row.quotaCycle;
    delete row.quotaProtection;
    delete row.includes;
    Object.assign(row, { priceUsdMonthly: 200 });
  }
  Object.assign(row, { screenRead: (primary as Record<string, unknown>).screenRead ?? (shared.find(p => p.id === "cursor") as Record<string, unknown> | undefined)?.screenRead ?? false });
  Object.assign(row, { id: X_ULTRA, name: "X Ultra", adapter: "grok-cli", usageProvider: "grok", providers: ["grok", "cursor"] });
  const first = plans.findIndex(p => canonicalPoolId(p.id) === X_ULTRA);
  return plans.flatMap((p, i) => i === first ? [row] : canonicalPoolId(p.id) === X_ULTRA ? [] : [p]);
}

export interface XUltraReading { usedPct: number | null; resetsAt: string | null; observedAt: string | null }
export interface XUltraChoice extends XUltraReading { state: "known" | "unknown"; reason: string | null }
/** Compare source clocks, allowing one point of rounding in newer same-cycle readings. */
export function resolveXUltraReading(sources: readonly XUltraReading[], now: number, maxAgeMs = 2 * QUOTA_SAMPLE_MS): XUltraChoice {
  const unknown = (reason: string): XUltraChoice => ({ usedPct: null, resetsAt: null, observedAt: null, state: "unknown", reason });
  const valid = sources.filter(s => pct(s.usedPct) && Number.isFinite(Date.parse(s.observedAt ?? ""))
    && Date.parse(s.observedAt!) <= now && Date.parse(s.resetsAt ?? "") > now)
    .sort((a, b) => Date.parse(a.observedAt!) - Date.parse(b.observedAt!));
  const fresh = valid.filter(s => now - Date.parse(s.observedAt!) < maxAgeMs);
  const newest = fresh.at(-1);
  if (!newest) return unknown(t("quota.xUltra.sourceMissing"));
  for (const prior of valid) {
    const sameCycle = Math.abs(Date.parse(prior.resetsAt!) - Date.parse(newest.resetsAt!)) <= 60_000;
    if (fresh.includes(prior) && !sameCycle || sameCycle && (prior.usedPct! - newest.usedPct! > 1
      || Date.parse(prior.observedAt!) === Date.parse(newest.observedAt!) && prior.usedPct !== newest.usedPct)) return unknown(t("quota.xUltra.sourceConflict"));
  }
  return { ...newest, state: "known", reason: null };
}

/** Old status files also collapse to one row. Cursor Auto/monthly rows are never weekly evidence. */
export function canonicalPoolRows<T extends { usedPct?: number | null; resetsAt?: string | null; observedAt?: string | null }>(
  rows: Readonly<Record<string, T>>,
): Record<string, T> {
  const out = Object.fromEntries(Object.entries(rows).filter(([id]) => canonicalPoolId(id) !== X_ULTRA));
  const shared = X_ULTRA_ALIASES.flatMap(id => rows[id] ? [{ id, row: rows[id] }] : []);
  if (!shared.length) return out;
  // New snapshots already contain the reconciled weekly reading. Never re-age it here.
  if (rows[X_ULTRA]) return { ...out, [X_ULTRA]: rows[X_ULTRA] };
  const grok = shared.find(s => s.id === "supergrok");
  // Old Cursor snapshots describe Auto, so only legacy Grok is quota evidence.
  const primary = grok?.row ?? shared[0].row;
  const row = grok ? primary : { ...primary, state: "unknown", usedPct: null, projectedPct: null, runsOutAt: null };
  out[X_ULTRA] = row as T;
  return out;
}

/** Canonical occupancy sums channels; limits use the smallest explicit value. */
export function canonicalPoolCounts(values: Readonly<Record<string, number>>, limits = false): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(values)) {
    const key = canonicalPoolId(id)!;
    out[key] = out[key] === undefined ? value : limits ? Math.min(out[key], value) : out[key] + value;
  }
  return out;
}
