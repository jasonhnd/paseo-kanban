import { canonicalPoolId, canonicalPoolRows } from "../../shared/fleet/x-ultra";
// Recent, source-timed quota readings. This series is separate from daily per-run accounting.
import type { HistorySample } from "./quota-history";

const HOUR = 3_600_000;
const LOOKBACK = 6 * HOUR;
const MAX_GAP = 2 * HOUR;
const MAX_AGE = HOUR / 2;
const MIN_SPAN = HOUR / 4;
const MAX_SAMPLES = 2016;

export interface PoolForecast {
  burnRatePctPerHour: number | null;
  projectedPct: number | null;
  runsOutAt: string | null;
  forecastConfidence: "high" | "low" | "none";
}

interface Reading {
  usedPct: number | null;
  resetsAt: string | null;
  periodDays: number | null;
  observedAt?: string | null;
}

export function unknownForecast(): PoolForecast {
  return { burnRatePctPerHour: null, projectedPct: null, runsOutAt: null, forecastConfidence: "none" };
}

function validPct(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Sample at most every five minutes, but never count a cached source timestamp twice. */
export function recentReadings(samples: HistorySample[], pools: Record<string, Reading>, now: number): HistorySample[] {
  const recent = samples.filter(s => Date.parse(s.at) >= now - 7 * 24 * HOUR && Date.parse(s.at) <= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = recent.at(-1);
  if (last && now - Date.parse(last.at) < HOUR / 12) return recent.slice(-MAX_SAMPLES);
  const rows = Object.fromEntries(Object.entries(pools).map(([key, p]) => [key, {
    usedPct: p.usedPct, resetsAt: p.resetsAt, observedAt: p.observedAt === undefined ? new Date(now).toISOString() : p.observedAt,
  }]));
  const changed = Object.entries(rows).some(([key, row]) => {
    const prior = last?.pools[key];
    return !prior || prior.observedAt !== row.observedAt || prior.usedPct !== row.usedPct || prior.resetsAt !== row.resetsAt;
  });
  return (changed ? [...recent, { at: new Date(now).toISOString(), pools: rows }] : recent).slice(-MAX_SAMPLES);
}

/** Endpoint slope over up to six recent hours, with gaps/resets breaking the series. */
export function forecastPool(pool: Reading, samples: HistorySample[], key: string, now: number): PoolForecast {
  const unknown = unknownForecast();
  const end = Date.parse(pool.resetsAt ?? "");
  const start = pool.periodDays !== null && pool.periodDays > 0 ? end - pool.periodDays * 24 * HOUR : NaN;
  const observed = pool.observedAt === undefined ? now : Date.parse(pool.observedAt ?? "");
  if (!validPct(pool.usedPct) || !Number.isFinite(start) || end <= now || !Number.isFinite(observed) || observed > now || now - observed > MAX_AGE) return unknown;
  // Include the fresh reading without waiting for the next persisted five-minute slot.
  const current: HistorySample = { at: new Date(now).toISOString(), pools: { [key]: {
    usedPct: pool.usedPct, resetsAt: pool.resetsAt, observedAt: new Date(observed).toISOString(),
  } } };
  const ordered = [...samples, current].map(s => {
    const row = canonicalPoolRows(s.pools)[canonicalPoolId(key)!];
    const at = Date.parse(row?.observedAt === undefined ? s.at : row.observedAt ?? "");
    // A failed source clock is a gap, not an observation to silently bridge.
    return Number.isFinite(at) ? { row, at } : { row: undefined, at: Date.parse(s.at) };
  }).filter(s => Number.isFinite(s.at) && s.at >= Math.max(start, now - LOOKBACK) && s.at <= observed)
    .sort((a, b) => a.at - b.at);
  let points: Array<{ at: number; used: number }> = [];
  for (const { row, at } of ordered) {
    if (!row || row.resetsAt !== pool.resetsAt || !validPct(row.usedPct)) { points = []; continue; }
    const previous = points.at(-1);
    if (previous && (at - previous.at > MAX_GAP || row.usedPct < previous.used)) points = [];
    if (previous?.at === at) {
      if (previous.used !== row.usedPct) points = [];
      continue;
    }
    points.push({ at, used: row.usedPct });
  }
  const first = points[0];
  const last = points.at(-1);
  if (points.length < 2 || !first || !last || observed - last.at > MAX_AGE || now - last.at > MAX_AGE || last.used !== pool.usedPct || last.at - first.at < MIN_SPAN) return unknown;
  const rate = (last.used - first.used) * HOUR / (last.at - first.at);
  const projected = last.used + rate * (end - last.at) / HOUR;
  const exhaustion = rate > 0 ? last.at + Math.max(0, 100 - last.used) / rate * HOUR : Infinity;
  const rates = points.slice(1).map((point, i) => (point.used - points[i].used) * HOUR / (point.at - points[i].at));
  const stable = rates.every(r => Math.abs(r - rate) <= Math.max(0.5, rate * 0.5));
  return {
    burnRatePctPerHour: rate,
    projectedPct: projected,
    runsOutAt: exhaustion < end ? new Date(exhaustion).toISOString() : null,
    forecastConfidence: points.length >= 3 && last.at - first.at >= HOUR && stable ? "high" : "low",
  };
}
