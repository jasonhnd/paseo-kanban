/// <reference types="node" />
// Pools that are behind their progress line, for the burn-week "send more work" broadcast.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DAY_MS, WEEK_MS, SURPLUS_ROLES, type SurplusPool, type SurplusRole } from "../../shared/fleet/reset-coupons";
import { CODEX_CLI, poolEntry, poolOfAdapter } from "../../shared/fleet/quota-adapters";
import { readPoolCatalog } from "./adapters/plans";
import { POOL_STATUS } from "./pools";
import { kanbanDeepDb, kanbanSource } from "./kanban-source";
import { CONFIG, type Json, readJson } from "./util";
import type { CouponSignalExtra } from "./reset-coupons-signals";

function surplusRole(value: unknown): SurplusRole | undefined {
  return SURPLUS_ROLES.find((role) => role === value);
}

/** Fallback confidence count: distinct dispatched cards, so retries cannot inflate the sample. */
export function surplusCardCounts(
  profiles: Array<{ name: string; pool: string }>,
  now = Date.now(),
  dbPath: string | null = kanbanDeepDb(),
): Map<string, number> {
  const counts = new Map<string, number>();
  // A week of runs is a deep query; without Kanban (or its database) the count stays unknown.
  if (dbPath === null || !existsSync(dbPath)) return counts;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT DISTINCT task_id, profile_name FROM runs WHERE started_at >= ? AND started_at <= ?")
      .all(new Date(now - WEEK_MS).toISOString(), new Date(now).toISOString()) as Array<{ task_id: number | null; profile_name: string }>;
    const pools = new Map(profiles.map((profile) => [profile.name, profile.pool]));
    const cards = new Map<string, Set<number>>();
    for (const row of rows) {
      const pool = pools.get(row.profile_name);
      if (!pool || row.task_id === null) continue;
      const set = cards.get(pool) ?? new Set<number>();
      set.add(row.task_id);
      cards.set(pool, set);
    }
    for (const [pool, ids] of cards) counts.set(pool, ids.size);
  } catch (error) {
    // An unreadable or old-schema database means confidence is unknown, never a numeric claim.
    console.error("[afc] reset coupons: kanban.db read failed; per-card usage stays unknown", String(error).slice(0, 160));
  } finally {
    try { db?.close(); } catch { /* A failed read must keep the estimate unknown. */ }
  }
  return counts;
}

export async function signalExtra(
  codex: { usedPct: number | null; resetsAt: string | null } | undefined,
  anchorCodexCount: boolean,
  codexCountNow?: number | null,
): Promise<CouponSignalExtra> {
  const now = Date.now();
  const [pools, cfg, catalog] = await Promise.all([
    readJson<{ pools?: Record<string, { usedPct?: unknown; pacePct?: unknown; dailyPct?: unknown; perRunPct?: unknown; resetsAt?: unknown; periodDays?: unknown }> }>(POOL_STATUS, {}),
    readJson<Json>(CONFIG, {}),
    readPoolCatalog(),
  ]);
  const roles = new Map<string, Set<SurplusRole>>();
  const profilePools: Array<{ name: string; pool: string }> = [];
  const profiles = cfg?.daemon?.agentProfiles;
  if (Array.isArray(profiles)) {
    for (const row of profiles) {
      if (!row || typeof row !== "object") continue;
      const record = row as { name?: unknown; pool?: unknown; role?: unknown; candidateFor?: unknown };
      const pool = typeof record.pool === "string" ? record.pool : "";
      if (pool && typeof record.name === "string") profilePools.push({ name: record.name, pool });
      const word = surplusRole(record.role) ?? surplusRole(record.candidateFor);
      if (!pool || !word) continue;
      const set = roles.get(pool) ?? new Set<SurplusRole>();
      set.add(word);
      roles.set(pool, set);
    }
  }
  const sampleCards = surplusCardCounts(profilePools, now);
  // Sub pools (Claude's Fable week) spend their main pool; they are not offered on their own.
  const surplusPools: SurplusPool[] = Object.entries(pools.pools ?? {}).filter(([id]) => !poolEntry(catalog, id)?.parent).map(([id, row]) => ({
    id,
    name: poolEntry(catalog, id)?.names.surplus ?? id,
    usedPct: typeof row.usedPct === "number" ? row.usedPct : null,
    pacePct: typeof row.pacePct === "number" ? row.pacePct : null,
    dailyPct: typeof row.dailyPct === "number" ? row.dailyPct : null,
    perRunPct: typeof row.perRunPct === "number" ? row.perRunPct : null,
    sampleCards: sampleCards.get(id) ?? 0,
    resetAt: typeof row.resetsAt === "string" && Number.isFinite(Date.parse(row.resetsAt))
      && typeof row.periodDays === "number" && Number.isFinite(row.periodDays) && row.periodDays > 0
      ? new Date(Date.parse(row.resetsAt) - row.periodDays * DAY_MS).toISOString() : null,
    roles: [...(roles.get(id) ?? [])],
  }));
  const codexPoolId = poolOfAdapter(catalog, CODEX_CLI)?.id;
  const codexPool = codexPoolId ? pools.pools?.[codexPoolId] : undefined;
  return {
    ...(codexPoolId ? { codexPoolId } : {}),
    codexUsedPct: codex ? codex.usedPct : (typeof codexPool?.usedPct === "number" ? codexPool.usedPct : null),
    codexResetsAt: codex ? codex.resetsAt : (typeof codexPool?.resetsAt === "string" ? codexPool.resetsAt : null),
    anchorCodexCount,
    ...(codexCountNow !== undefined ? { codexCountNow } : {}),
    surplusPools,
    surplusOff: kanbanSource().presence === "absent",
  };
}
