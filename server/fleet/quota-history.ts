import { canonicalPoolId, canonicalPoolRows } from "../../shared/fleet/x-ultra";
/// <reference types="node" />
import { providerBanned } from "../../shared/fleet/provider-policy";
import { readBannedProviders } from "./adapters/config";
// Daily samples of each pool's used percent, kept next to cursor-usage.json.
// "Each run costs about" = change in the reading over the period ÷ runs on that pool in the same span.
import { join } from "node:path";
import { sameResetWindow } from "../../shared/fleet/reset-coupons";
import { readRunsSince } from "./kanban";
import type { PoolStatus } from "./pools";
import { CONFIG, type Json, readJson, STATE_DIR, writeJson } from "./util";

export const QUOTA_HISTORY_FILE = join(STATE_DIR, "quota-history.json");
/** A new sample is stored at most once a day. */
export const SAMPLE_INTERVAL_MS = 20 * 60 * 60_000;
const MAX_SAMPLES = 60;

export interface HistorySample {
  at: string;
  pools: Record<string, { usedPct: number | null; resetsAt: string | null; observedAt?: string | null }>;
}

interface HistoryFile {
  samples: HistorySample[];
}

export function shouldSample(lastAt: string | null, now: number): boolean {
  if (!lastAt) return true;
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return true;
  return now - t >= SAMPLE_INTERVAL_MS;
}

/**
 * Percent of the period spent per run, from the first and last sample inside the span.
 * One sample, a flat reading, or no runs means we don't know yet.
 */
export function perRunPct(samples: Array<{ at: string; usedPct: number }>, runCount: number): number | null {
  const sorted = samples
    .filter((s) => Number.isFinite(Date.parse(s.at)) && Number.isFinite(s.usedPct))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (sorted.length < 2 || runCount <= 0) return null;
  const delta = sorted[sorted.length - 1].usedPct - sorted[0].usedPct;
  if (!(delta > 0)) return null;
  return delta / runCount;
}

export function spanOf(samples: Array<{ at: string }>): { from: string; to: string } | null {
  const times = samples.map((s) => Date.parse(s.at)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  if (times.length < 2) return null;
  return { from: new Date(times[0]).toISOString(), to: new Date(times[times.length - 1]).toISOString() };
}

function sampleFrom(pools: Record<string, PoolStatus>, at: string): HistorySample {
  const out: HistorySample["pools"] = {};
  for (const [key, pool] of Object.entries(pools)) {
    out[key] = { usedPct: pool.usedPct, resetsAt: pool.resetsAt, ...(pool.observedAt !== undefined ? { observedAt: pool.observedAt } : {}) };
  }
  return { at, pools: out };
}

/** Append today's sample when the last one is old enough. Returns the file's samples. */
export async function recordSample(pools: Record<string, PoolStatus>, now = Date.now()): Promise<HistorySample[]> {
  const file = await readJson<HistoryFile>(QUOTA_HISTORY_FILE, { samples: [] });
  const samples = Array.isArray(file.samples) ? file.samples : [];
  const last = samples.length ? samples[samples.length - 1] : null;
  if (!shouldSample(last?.at ?? null, now)) return samples;
  const next = [...samples, sampleFrom(pools, new Date(now).toISOString())].slice(-MAX_SAMPLES);
  await writeJson(QUOTA_HISTORY_FILE, { samples: next });
  return next;
}

/** Samples for one pool whose reset matches the current window and whose time falls inside it. */
export function samplesInPeriod(samples: HistorySample[], pool: string, resetsAt: string | null, startMs: number, endMs: number): Array<{ at: string; usedPct: number }> {
  const out: Array<{ at: string; usedPct: number }> = [];
  for (const sample of samples) {
    const row = canonicalPoolRows(sample.pools ?? {})[canonicalPoolId(pool)!];
    const at = row && "observedAt" in row ? row.observedAt : sample.at;
    if (!at) continue;
    const t = Date.parse(at);
    if (Number.isNaN(t) || t < startMs || t > endMs) continue;
    if (!row || typeof row.usedPct !== "number") continue;
    if (resetsAt && row.resetsAt && row.resetsAt !== resetsAt && !sameResetWindow(row.resetsAt, resetsAt)) continue;
    out.push({ at, usedPct: row.usedPct });
  }
  return out;
}

export interface ProfilePool {
  name: string;
  pool: string;
}

/** Runs whose profile spends this pool, between the two readings (inclusive). */
export function runsInSpan(runs: Array<{ profile: string; at: string }>, profiles: ProfilePool[], pool: string, fromMs: number, toMs: number): number {
  const names = new Set(profiles.filter((p) => canonicalPoolId(p.pool) === canonicalPoolId(pool)).map((p) => p.name));
  let n = 0;
  for (const run of runs) {
    if (!names.has(run.profile)) continue;
    const t = Date.parse(run.at);
    if (Number.isNaN(t) || t < fromMs || t > toMs) continue;
    n += 1;
  }
  return n;
}

const DAY_MS = 24 * 60 * 60_000;

export async function profilePools(): Promise<ProfilePool[]> {
  const cfg = await readJson<Json>(CONFIG, {});
  const raw = cfg?.daemon?.agentProfiles;
  if (!Array.isArray(raw)) return [];
  const out: ProfilePool[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const name = typeof row.name === "string" ? row.name : "";
    const pool = typeof row.pool === "string" ? row.pool : "";
    if (!name || !pool) continue;
    if (providerBanned(row, readBannedProviders())) continue;
    out.push({ name, pool });
  }
  return out;
}

/** Fill perRunPct and dailyRuns from the history file and the kanban runs table. */
export async function attachConsumption(pools: Record<string, PoolStatus>, samples: HistorySample[]): Promise<Record<string, PoolStatus>> {
  const profiles = await profilePools();
  let earliest = Date.now() - 40 * DAY_MS;
  for (const sample of samples) {
    const t = Date.parse(sample.at);
    if (!Number.isNaN(t)) earliest = Math.min(earliest, t);
  }
  const runs = readRunsSince(new Date(earliest).toISOString());
  const out: Record<string, PoolStatus> = {};
  for (const [key, pool] of Object.entries(pools)) {
    const end = pool.resetsAt ? Date.parse(pool.resetsAt) : Number.NaN;
    const start = pool.periodDays !== null && !Number.isNaN(end) ? end - pool.periodDays * DAY_MS : Number.NaN;
    if (Number.isNaN(start)) {
      out[key] = pool;
      continue;
    }
    const mine = samplesInPeriod(samples, key, pool.resetsAt, start, end);
    const span = spanOf(mine);
    const per = span ? perRunPct(mine, runsInSpan(runs, profiles, key, Date.parse(span.from), Date.parse(span.to))) : null;
    const dailyRuns = per !== null && pool.dailyPct !== null && per > 0 ? pool.dailyPct / per : null;
    out[key] = { ...pool, perRunPct: per, dailyRuns };
  }
  return out;
}
