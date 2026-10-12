/// <reference types="node" />
import { providerBanned } from "../../shared/fleet/provider-policy";
import { readBannedProviders } from "./adapters/config";
// Home-page figures from files already on disk: the quota snapshot, the usage scan cache,
// the Cursor ledger, and a read-only pass over the Kanban database. No provider calls.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoardSnapshot } from "../../shared/fleet/board";
import { tAll } from "../../shared/fleet/i18n";
import { claudeCategory, DAY_MS } from "../../shared/fleet/dispatch";
import type { HomeView } from "../../shared/fleet/home-view";
import { companyCardSchema, refreshCompanyTime, type CompanyCard } from "../../shared/fleet/quota-companies";
import { buildRoleCards, type RoleSource } from "../../shared/fleet/role-plain";
import { poolOfProvider, shareByRole, stackDays, tokenMap, tokensOf } from "../../shared/fleet/token-chart";
import { readRoleWork } from "./kanban";
import { ledgerBuckets } from "./ledger";
import { readAgentRecords } from "./records";
import { QUOTA_COMPANIES } from "./usage";
import { cached, type Json, readJson, STATE_DIR } from "./util";

const SCAN = join(STATE_DIR, "usage-scan-cache.json");

interface Hit {
  at: number;
  provider: string;
  sessionId: string;
  tokens: number;
}

export async function readCompanies(now: number): Promise<CompanyCard[]> {
  const raw = await readJson<{ companies?: unknown; generatedAt?: unknown }>(QUOTA_COMPANIES, {});
  const parsed = companyCardSchema.array().safeParse(raw.companies);
  if (!parsed.success) return [];
  const banned = readBannedProviders();
  return parsed.data.filter((card) => !providerBanned(card, banned)).map((card) => refreshCompanyTime({
    ...card,
    windows: card.windows.map((row) => ({
      ...row,
      // Role names in the quota cache may still use the old supervisor name; show <leader> instead.
      who: tAll("snapshot.legacyLeaderName").reduce((who, old) => who.replaceAll(old, "<leader>"), row.who),
    })),
  }, now, typeof raw.generatedAt === "string" ? raw.generatedAt : null));
}

function hitsFromBuckets(
  buckets: Record<string, number[]>,
  sessionId: string,
  fallbackProvider: string,
  sinceMs: number,
): Hit[] {
  const hits: Hit[] = [];
  const banned = readBannedProviders();
  for (const [key, bucket] of Object.entries(buckets)) {
    if (!Array.isArray(bucket)) continue;
    const [hour, provider, model] = key.split("|");
    if (providerBanned({ provider: provider || fallbackProvider, model }, banned)) continue;
    const at = Date.parse(`${hour}:00:00.000Z`);
    if (!hour || Number.isNaN(at) || at < sinceMs) continue;
    const tokens = tokensOf(bucket);
    if (tokens <= 0) continue;
    hits.push({ at, provider: provider || fallbackProvider, sessionId, tokens });
  }
  return hits;
}

async function localHits(sinceMs: number): Promise<Hit[]> {
  const hits: Hit[] = [];
  const banned = readBannedProviders();
  const text = await readFile(SCAN, "utf8").catch(() => "");
  if (text) {
    try {
      const parsed = JSON.parse(text) as { files?: Record<string, { provider?: string; sessionId?: string; b?: Record<string, number[]> }> };
      for (const file of Object.values(parsed.files ?? {})) {
        if (!file?.b || !file.sessionId) continue;
        if (providerBanned(file, banned)) continue;
        hits.push(...hitsFromBuckets(file.b, file.sessionId, file.provider ?? "", sinceMs));
      }
    } catch {
      // A broken cache leaves the chart empty for this round.
    }
  }
  for (const row of await ledgerBuckets().catch(() => [])) {
    hits.push(...hitsFromBuckets(row.b, row.sessionId, row.provider, sinceMs));
  }
  return hits;
}

async function usageCharts(now: number): Promise<Pick<HomeView, "days" | "roleShares">> {
  const since = now - 8 * DAY_MS;
  const hits = await localHits(since);
  const records = await readAgentRecords().catch(() => []);
  const byId = new Map(records.map((rec) => [rec.id, rec]));
  const bySession = new Map(records.flatMap((rec) => (rec.sessionId ? [[rec.sessionId, rec] as const] : [])));
  const weekStart = now - 7 * DAY_MS;
  const counted = hits.filter((hit) => poolOfProvider(hit.provider));
  const categorized = counted.filter((hit) => hit.at >= weekStart).map((hit) => {
    const rec = bySession.get(hit.sessionId) ?? byId.get(hit.sessionId);
    return { category: claudeCategory(rec ? { role: rec.role, title: rec.title } : null), tokens: hit.tokens };
  });
  return { days: stackDays(counted, now), roleShares: shareByRole(categorized) };
}

export async function buildHomeView(input: {
  now: number;
  pools: Record<string, Json>;
  roles: BoardSnapshot["roles"];
  /** Snapshot `cursorRead.usingManual`: `/usage` failed and Cursor is on the hand-copied percentage. */
  cursorUsingManual?: boolean;
  /** Top-of-home sentence during a named Claude burn week. */
  banner?: string | null;
  /** Pool id → how the work is paid for (shared/quota-adapters.ts poolNames(catalog, "via")). */
  via?: Readonly<Record<string, string>>;
}): Promise<HomeView> {
  const companies = await readCompanies(input.now);
  const policyKey = readBannedProviders().join("|");
  const charts = await cached(`home-usage:${policyKey}:${new Date(input.now).toISOString().slice(0, 13)}`, 60_000, () => usageCharts(input.now)).catch(() => ({
    days: stackDays([], input.now),
    roleShares: [],
  }));
  const work = readRoleWork(new Date(input.now - 7 * DAY_MS).toISOString());
  const sources: RoleSource[] = input.roles.map((role) => ({
    key: role.key,
    lineup: role.lineup.map((item) => ({
      model: item.model,
      pool: item.pool,
      status: item.status,
      poolState: item.poolState ? { dispatchable: item.poolState.dispatchable, reason: item.poolState.reason } : null,
    })),
  }));
  const tokens = charts.roleShares.length > 0 ? tokenMap(charts.roleShares) : null;
  return {
    companies,
    days: charts.days,
    roleShares: charts.roleShares,
    roleCards: buildRoleCards(sources, work, tokens, input.via ?? {}),
    ...(input.banner ? { banner: input.banner } : {}),
  };
}
