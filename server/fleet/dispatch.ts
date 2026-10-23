import { canonicalPoolRows } from "../../shared/fleet/x-ultra";
/// <reference types="node" />
import { capturePolicyDigest, publishPolicySnapshot } from "../application/policy-snapshot";
import { buildPoolStatusExport, buildDispatchMatrixExport, producerVersion } from "./exports";
import { providerBanned } from "../../shared/fleet/provider-policy";
import { sameResetWindow } from "../../shared/fleet/reset-coupons";
import { readBannedProviders } from "./adapters/config";
// Rewrites dispatch-matrix.json and dispatch-stats.json after each pool-status.json write.
// Reads profiles, kanban runs, and the usage caches. Does not write kanban.db or config.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROLE_ORDER } from "../../shared/fleet/board";
import {
  type AttributableRun,
  assignUsage,
  bucketTokens,
  buildDispatchBundle,
  type ClaudeSessionInput,
  type ClaudeSpend,
  claudeWeekStart,
  classifyClaudeSpend,
  countRunsToday,
  type DispatchMatrix,
  type DispatchProfile,
  type DispatchStats,
  DAY_MS,
  type EffortRun,
  lineupForRoles,
  type PoolFlags,
  profilesFromConfig,
  publicPriceUsd,
  resolveEffort,
  STATS_WINDOW_DAYS,
  tokyoDayStart,
  type UsageHit,
} from "../../shared/fleet/dispatch";
import { activeDispatchPriority, type DispatchPriority, priorityView, resolveDispatchPriority, withPriorityIndex } from "../../shared/fleet/dispatch-priority";
import { CLAUDE_CLI, type PoolEntry, poolEntry, poolNames, poolOfAdapter } from "../../shared/fleet/quota-adapters";
import { readPoolCatalog } from "./adapters/plans";
import { preserveDispatchMatrix, publishDispatchMatrixExport } from "./exports";
import { afcPluginDir } from "./paths";
import { readDispatchRuns, readRunsSince } from "./kanban";
import { ledgerBuckets } from "./ledger";
import { periodBounds, POOL_STATUS, type PoolStatus } from "./pools";
import { priceFor } from "./prices";
import { QUOTA_HISTORY_FILE, runsInSpan, samplesInPeriod, spanOf, type HistorySample } from "./quota-history";
import { roleOf } from "./records";
import { CONFIG, type Json, logSwallowed, PASEO_DIR, readJson, STATE_DIR, writeJson } from "./util";
import type { RunCost } from "../../shared/fleet/run-cost";
import { t, tIn } from "../../shared/fleet/i18n";
import { loadDispatchSettings } from "./dispatch-settings";

export const DISPATCH_MATRIX = join(STATE_DIR, "dispatch-matrix.json");
export const DISPATCH_STATS = join(STATE_DIR, "dispatch-stats.json");
const SCAN_CACHE = join(STATE_DIR, "usage-scan-cache.json");
const PLANS_FILE = join(STATE_DIR, "plans.json");

interface ScanFile {
  provider?: string;
  sessionId?: string;
  b?: Record<string, number[]>;
}

const BASE_MATRIX_FILE = "shared/fleet/default-dispatch.example.json";

/** The base matrix ships with the plugin, so it lives in the install directory, not the data directory. */
export function baseMatrixPath(): string | null {
  const dir = afcPluginDir();
  return dir ? join(dir, BASE_MATRIX_FILE) : null;
}

/**
 * Read the shipped base matrix. Throws when it is missing or malformed: an empty matrix must never be
 * published in its place (callers log and keep the last matrix on disk).
 */
export async function loadBaseMatrix(path: string | null = baseMatrixPath()): Promise<DispatchMatrix> {
  if (!path) throw new Error(`${BASE_MATRIX_FILE}: plugin install directory unknown (no plugins.agent-fleet-cockpit.path in Paseo's config.json and no AFC_HOME)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${BASE_MATRIX_FILE} unreadable at ${path}: ${String(error).slice(0, 200)}`);
  }
  const matrix = parsed as Partial<DispatchMatrix> | null;
  if (!matrix || typeof matrix.roles !== "object" || matrix.roles === null || Object.keys(matrix.roles).length === 0) {
    throw new Error(`${BASE_MATRIX_FILE} at ${path} has no roles`);
  }
  return matrix as DispatchMatrix;
}

/** null when config cannot be read. Publishers then preserve existing matrices. */
export async function loadProfiles(): Promise<DispatchProfile[] | null> {
  try {
    return profilesFromConfig(JSON.parse(await readFile(CONFIG, "utf8")));
  } catch (error) {
    logSwallowed("dispatch read paseo config", error);
    return null;
  }
}

function onlyRolesOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const roles = raw.filter((item): item is string => typeof item === "string" && item.length > 0);
  return roles.length > 0 ? roles : undefined;
}

function unpauseOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw.filter((item): item is string => typeof item === "string" && item.length > 0);
  return names.length > 0 ? names : undefined;
}

/** pool-status.json `priorityIndex`, kept only while its `priorityUntil` is still ahead (DEMO_0123, DEMO_0124). */
function priorityIndexFromJson(pool: Json, now: number): number | null {
  if (typeof pool.priorityIndex !== "number" || !Number.isInteger(pool.priorityIndex) || pool.priorityIndex < 0) return null;
  const until = typeof pool.priorityUntil === "string" ? Date.parse(pool.priorityUntil) : Number.NaN;
  return !Number.isNaN(until) && now < until ? pool.priorityIndex : null;
}

export function poolFlagsFromJson(pools: Record<string, Json> | null | undefined, now = Date.now()): Record<string, PoolFlags> {
  const out: Record<string, PoolFlags> = {};
  for (const [key, pool] of Object.entries(pools ?? {})) {
    if (!pool || typeof pool !== "object") continue;
    const onlyRoles = onlyRolesOf(pool.onlyRoles);
    const unpauseProfiles = unpauseOf(pool.unpauseProfiles);
    const priorityIndex = priorityIndexFromJson(pool, now);
    out[key] = {
      dispatchable: Boolean(pool.dispatchable),
      prefer: Boolean(pool.prefer),
      deprioritize: Boolean(pool.deprioritize),
      reason: typeof pool.reason === "string" ? pool.reason : "",
      dailyPct: typeof pool.dailyPct === "number" ? pool.dailyPct : null,
      perRunPct: typeof pool.perRunPct === "number" ? pool.perRunPct : null,
      usedPct: typeof pool.usedPct === "number" ? pool.usedPct : null,
      projectedPct: typeof pool.projectedPct === "number" ? pool.projectedPct : null,
      elapsedPct: typeof pool.elapsedPct === "number" ? pool.elapsedPct : null,
      daysLeft: typeof pool.daysLeft === "number" ? pool.daysLeft : null,
      resetsAt: typeof pool.resetsAt === "string" ? pool.resetsAt : null,
      wasteRisk: typeof pool.wasteRisk === "number" ? pool.wasteRisk : null,
      needPerDay: typeof pool.needPerDay === "number" ? pool.needPerDay : null,
      ...(priorityIndex !== null ? { priorityIndex } : {}),
      ...(onlyRoles ? { onlyRoles } : {}),
      ...(unpauseProfiles ? { unpauseProfiles } : {}),
    };
  }
  return out;
}

function flagsFromStatus(pools: Record<string, PoolStatus>): Record<string, PoolFlags> {
  const out: Record<string, PoolFlags> = {};
  for (const [key, pool] of Object.entries(pools)) {
    if (!pool || typeof pool !== "object") continue;
    const onlyRoles = onlyRolesOf(pool.onlyRoles);
    const unpauseProfiles = unpauseOf(pool.unpauseProfiles);
    out[key] = {
      dispatchable: pool.dispatchable,
      prefer: pool.prefer,
      deprioritize: pool.deprioritize,
      reason: pool.reason,
      dailyPct: pool.dailyPct,
      perRunPct: pool.perRunPct,
      usedPct: pool.usedPct,
      projectedPct: pool.projectedPct,
      elapsedPct: pool.elapsedPct,
      daysLeft: pool.daysLeft,
      resetsAt: pool.resetsAt,
      wasteRisk: pool.wasteRisk ?? null,
      needPerDay: pool.needPerDay ?? null,
      ...(onlyRoles ? { onlyRoles } : {}),
      ...(unpauseProfiles ? { unpauseProfiles } : {}),
    };
  }
  return out;
}

interface AgentHit {
  role: string | null;
  title: string;
  archived: boolean;
  ids: string[];
}

interface AgentFileHit extends AgentHit {
  agentId: string;
}

function parseAgentFile(data: Json, names: Map<string, string>): AgentFileHit | null {
  if (!data || typeof data !== "object" || typeof data.id !== "string" || !data.id) return null;
  const title = String(data.title ?? "");
  const labelsRaw = data.labels;
  const labels: Record<string, string> = {};
  if (labelsRaw && typeof labelsRaw === "object" && !Array.isArray(labelsRaw)) {
    for (const [key, value] of Object.entries(labelsRaw as Record<string, unknown>)) {
      if (typeof value === "string") labels[key] = value;
    }
  }
  const persistence = data.persistence && typeof data.persistence === "object" ? (data.persistence as Json) : {};
  const runtime = data.runtimeInfo && typeof data.runtimeInfo === "object" ? (data.runtimeInfo as Json) : {};
  const ids = [data.id, persistence.sessionId, persistence.nativeHandle, runtime.sessionId].filter((id): id is string => typeof id === "string" && id.length > 0);
  return { agentId: data.id, role: roleOf(title, labels, names), title, archived: Boolean(data.archivedAt), ids: [...new Set(ids)] };
}

async function readAgentFiles(root: string, names: Map<string, string>): Promise<AgentFileHit[]> {
  const hits: AgentFileHit[] = [];
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith(".json")) paths.push(join(root, entry.name));
    if (!entry.isDirectory()) continue;
    for (const file of await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => [])) {
      if (file.isFile() && file.name.endsWith(".json")) paths.push(join(root, entry.name, file.name));
    }
  }
  for (const path of paths) {
    let data: Json;
    try {
      data = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      logSwallowed("dispatch skip agent record", error);
      continue;
    }
    const hit = parseAgentFile(data, names);
    if (hit) hits.push(hit);
  }
  return hits;
}

async function readAgents(profiles: DispatchProfile[]): Promise<{ bySession: Record<string, { role: string | null; title: string }>; sessionsByAgent: Map<string, string[]> }> {
  const names = new Map<string, string>();
  for (const profile of profiles) {
    if (profile.role && (ROLE_ORDER as readonly string[]).includes(profile.role)) names.set(profile.name, profile.role);
  }
  const root = join(PASEO_DIR, "agents");
  const chosen = new Map<string, { role: string | null; title: string; archived: boolean }>();
  const sessionsByAgent = new Map<string, string[]>();
  for (const hit of await readAgentFiles(root, names)) {
    sessionsByAgent.set(hit.agentId, hit.ids);
    for (const id of hit.ids) {
      const prev = chosen.get(id);
      if (!prev || (prev.archived && !hit.archived)) chosen.set(id, { role: hit.role, title: hit.title, archived: hit.archived });
    }
  }
  const bySession: Record<string, { role: string | null; title: string }> = {};
  for (const [id, hit] of chosen) bySession[id] = { role: hit.role, title: hit.title };
  return { bySession, sessionsByAgent };
}

/** plans.json `dispatchPriority` override still in force at `now`. Null when missing, invalid, past, or unreadable. */
export async function readDispatchPriority(now: number): Promise<DispatchPriority | null> {
  return activeDispatchPriority(await readJson<Json>(PLANS_FILE, {}), now);
}

async function pricedHits(files: Record<string, ScanFile>, sinceMs: number): Promise<{ hits: UsageHit[]; claude: ClaudeSessionInput[]; priceOf: (provider: string, model: string) => ReturnType<typeof priceFor> }> {
  const plans = await readJson<{ prices?: Record<string, Json> }>(PLANS_FILE, {});
  const overrides = plans.prices ?? {};
  const memo = new Map<string, Awaited<ReturnType<typeof priceFor>>>();
  const priceOf = async (provider: string, model: string) => {
    const key = `${provider}|${model}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const price = await priceFor(provider, model, overrides).catch((error) => {
      logSwallowed(`dispatch price ${key}`, error);
      return null;
    });
    memo.set(key, price);
    return price;
  };
  const hits: UsageHit[] = [];
  const banned = readBannedProviders();
  const claude: ClaudeSessionInput[] = [];
  const consume = async (sessionId: string, buckets: Record<string, number[]>, path: string | null) => {
    const hours: ClaudeSessionInput["hours"] = [];
    for (const [key, bucket] of Object.entries(buckets)) {
      if (!Array.isArray(bucket)) continue;
      const [hour, provider, model, long] = key.split("|");
      if (providerBanned({ provider, model }, banned)) continue;
      const ms = Date.parse(`${hour}:00:00.000Z`);
      if (!hour || Number.isNaN(ms) || ms < sinceMs) continue;
      const price = await priceOf(provider, model);
      const rates = price
        ? { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite, long: price.long }
        : null;
      const usd = publicPriceUsd(bucket, long === "1", rates);
      hits.push({ sessionId, hour: ms, tokens: bucketTokens(bucket), usd });
      if (path && provider === "claude" && usd !== null) hours.push({ hour: ms, usd });
    }
    if (path) claude.push({ sessionId, path, hours });
  };
  for (const [path, file] of Object.entries(files)) {
    if (!file?.sessionId || !file.b) continue;
    if (providerBanned(file, banned)) continue;
    await consume(file.sessionId, file.b, file.provider === "claude" ? path : null);
  }
  for (const row of await ledgerBuckets()) await consume(row.sessionId, row.b, null);
  return { hits, claude, priceOf };
}

function poolDeltas(pools: Record<string, PoolFlags>, samples: HistorySample[], runs: Array<{ profile: string; at: string }>, profiles: DispatchProfile[], catalog: readonly PoolEntry[], now: number): Array<{ pool: string; deltaPct: number | null; runs: number }> {
  const linked = profiles.flatMap((profile) => (profile.pool ? [{ name: profile.name, pool: profile.pool }] : []));
  const out: Array<{ pool: string; deltaPct: number | null; runs: number }> = [];
  for (const [key, pool] of Object.entries(pools)) {
    // A pool the plans no longer define keeps the 7-days-before-reset period.
    const bounds = periodBounds(poolEntry(catalog, key)?.period ?? "window", pool.resetsAt ?? null, null)
      ?? (!pool.resetsAt ? { start: now - STATS_WINDOW_DAYS * DAY_MS, end: now } : null);
    if (!bounds) {
      out.push({ pool: key, deltaPct: null, runs: 0 });
      continue;
    }
    const mine = samplesInPeriod(samples, key, pool.resetsAt ?? null, bounds.start, Math.min(bounds.end, now));
    const sorted = [...mine].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const resets = new Map(samples.map((sample) => {
      const row = canonicalPoolRows(sample.pools ?? {})[key];
      return [row && "observedAt" in row ? row.observedAt : sample.at, row?.resetsAt ?? null];
    }));
    let first = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = resets.get(sorted[i - 1].at) ?? null;
      const next = resets.get(sorted[i].at) ?? null;
      if (sorted[i].usedPct < sorted[i - 1].usedPct || (prev !== next && !(prev && next && sameResetWindow(prev, next)))) first = i;
    }
    const stable = sorted.slice(first);
    const span = spanOf(stable);
    if (!span) {
      out.push({ pool: key, deltaPct: null, runs: 0 });
      continue;
    }
    const delta = stable[stable.length - 1].usedPct - stable[0].usedPct;
    const runsN = runsInSpan(runs, linked, key, Date.parse(span.from), Date.parse(span.to));
    out.push({ pool: key, deltaPct: delta, runs: runsN });
  }
  return out;
}

export async function writeDispatchFiles(matrixPath: string, statsPath: string, matrix: DispatchMatrix, stats: DispatchStats, unresolvedSlots: readonly string[] = [], policy?: { profiles: readonly DispatchProfile[]; bannedProviders: readonly string[] }): Promise<void> {
  if (unresolvedSlots.length > 0) console.warn(tIn("en", "dispatch.unresolvedSlotsWarning", { slots: unresolvedSlots.join(", ") }));
  if (!(await preserveDispatchMatrix(matrixPath, unresolvedSlots, policy))) await writeJson(matrixPath, matrix);
  await writeJson(statsPath, stats);
}

/** Rebuild the matrix from the snapshot already on disk. Used at plugin load, before the next quota refresh. */
export async function publishFromSnapshotFile(now = Date.now()): Promise<DispatchStats | null> {
  const file = await readJson<Json>(POOL_STATUS, {});
  const raw = file.pools;
  const sampledAt = typeof file.generatedAt === "string" ? Date.parse(file.generatedAt) : NaN;
  if (!raw || typeof raw !== "object" || !Number.isFinite(sampledAt)) return null;
  // Rebuild compatibility projections without re-dating quota or authorizing admission.
  // Only a collector with captured policy inputs may publish the immutable policy revision.
  return publishDispatch(raw as Record<string, PoolStatus>, sampledAt, undefined, null, true);
}

/** Build and write the matrix and the stats. Failures are the caller's to log; the pool snapshot is already on disk. */
export async function publishDispatch(pools: Record<string, PoolStatus>, now = Date.now(), poolDefs?: PoolEntry[], capturedDigest: string | null = capturePolicyDigest(), compatibilityOnly = false): Promise<DispatchStats> {
  pools = canonicalPoolRows(pools);
  const [base, profiles, override, catalog] = await Promise.all([loadBaseMatrix(), loadProfiles(), readDispatchPriority(now), poolDefs ?? readPoolCatalog()]);
  const dispatchSettings = await loadDispatchSettings(profiles ?? []);
  // Claude's spend classification follows the Claude main pool, whatever plans.json calls it.
  const claudeId = poolOfAdapter(catalog, CLAUDE_CLI)?.id;
  // One resolved order (needPerDay, or the override) for both the row order and the matrix `priority` field.
  const judged = flagsFromStatus(pools);
  const priority = resolveDispatchPriority(judged, override, now);
  const flags = withPriorityIndex(judged, priority);
  const since = now - Math.max(STATS_WINDOW_DAYS, 40) * DAY_MS;
  const runRows = readDispatchRuns(new Date(since).toISOString());
  const history = await readJson<{ samples?: HistorySample[] }>(QUOTA_HISTORY_FILE, { samples: [] });
  const samples = Array.isArray(history.samples) ? history.samples : [];
  const scan = await readJson<{ files?: Record<string, ScanFile> }>(SCAN_CACHE, { files: {} });
  const weekStart = claudeWeekStart((claudeId ? flags[claudeId]?.resetsAt : null) ?? null, now);
  const { hits, claude, priceOf } = await pricedHits(scan.files ?? {}, Math.min(since, weekStart) - 2 * 60 * 60 * 1000);
  const agents = profiles ? await readAgents(profiles) : { bySession: {}, sessionsByAgent: new Map<string, string[]>() };
  const windowStart = now - STATS_WINDOW_DAYS * DAY_MS;
  const attributable: AttributableRun[] = [];
  for (const run of runRows) {
    const start = Date.parse(run.startedAt);
    if (Number.isNaN(start) || start < windowStart) continue;
    if (providerBanned(profiles?.find((profile) => profile.name === run.profile) ?? run.profile, readBannedProviders())) continue;
    const endRaw = run.endedAt ? Date.parse(run.endedAt) : now;
    const end = Number.isNaN(endRaw) ? now : endRaw;
    const own = profiles?.find((profile) => profile.name === run.profile)?.thinkingOptionId ?? null;
    const sessionIds = new Set<string>();
    if (run.agentId) {
      sessionIds.add(run.agentId);
      for (const id of agents.sessionsByAgent.get(run.agentId) ?? []) sessionIds.add(id);
    }
    attributable.push({
      id: run.id,
      profile: run.profile,
      effort: resolveEffort(run.effort, own),
      start,
      end,
      sessionIds: [...sessionIds],
    });
  }
  const usage = assignUsage(attributable, hits);
  // Durable end-of-run observations survive cleanup of the agent/session metadata.
  // A record without usable tokens still needs the transcript fallback.
  const costs = await readJson<{ records?: RunCost[] }>(join(STATE_DIR, "run-costs.json"), {});
  const durable = new Map((Array.isArray(costs.records) ? costs.records : []).map(row => [String(row.runId), row]));
  const effortRuns: EffortRun[] = [];
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  for (const run of attributable) {
    const cost = durable.get(run.id);
    let measured = usage.get(run.id) ?? { tokens: null, usd: null };
    if (cost && valid(cost.tokensIn) && valid(cost.tokensOut) && Number.isFinite(cost.tokensIn + cost.tokensOut)) {
      const profile = profiles?.find(p => p.name === run.profile);
      const price = await priceOf(cost.provider ?? profile?.provider ?? "", cost.model ?? profile?.model ?? "");
      const cached = valid(cost.tokensCached) && cost.tokensCached <= cost.tokensIn ? cost.tokensCached : 0;
      // Run totals include cached input but do not identify per-call long-context tiers.
      const usd = publicPriceUsd([cost.tokensIn - cached, cached, 0, 0, cost.tokensOut], false, price);
      measured = { tokens: cost.tokensIn + cost.tokensOut, usd };
    }
    effortRuns.push({ profile: run.profile, effort: run.effort, ...measured });
  }
  const runPoints = runRows.flatMap((run) => (run.profile && run.startedAt ? [{ profile: run.profile, at: run.startedAt }] : []));
  const claudePace = claudeId ? flags[claudeId] : undefined;
  const claudeSpend: ClaudeSpend | null = claudePace
    ? classifyClaudeSpend(claude, agents.bySession, { dayStart: tokyoDayStart(now), weekStart, now }, {
        usedPct: claudePace.usedPct ?? null,
        elapsedPct: claudePace.elapsedPct ?? null,
        dailyPct: claudePace.dailyPct ?? null,
        projectedPct: claudePace.projectedPct ?? null,
        resetsAt: claudePace.resetsAt ?? null,
      })
    : null;
  const { matrix, stats, unresolvedSlots } = buildDispatchBundle({
    base,
    ...dispatchSettings,
    bannedProviders: readBannedProviders(),
    profiles,
    pools: flags,
    generatedAt: new Date(now).toISOString(),
    priority: priorityView(priority),
    effortRuns,
    poolDeltas: poolDeltas(flags, samples, runPoints, profiles ?? [], catalog, now),
    claude: claudeSpend,
  });
  const policy = { profiles: profiles ?? [], bannedProviders: readBannedProviders() };
  await writeDispatchFiles(DISPATCH_MATRIX, DISPATCH_STATS, matrix, stats, unresolvedSlots, policy);
  // The fleet-quota/v1 copy for Kanban; logs and carries on if it fails.
  await publishDispatchMatrixExport(matrix, now, unresolvedSlots, policy);
  if (compatibilityOnly) return stats;
  // Unresolved profiles never publish a fresh empty or partially preserved policy.
  if (!capturedDigest || !profiles || unresolvedSlots.length) throw new Error("Policy slots are unresolved");
  const poolExport = buildPoolStatusExport(pools, matrix.priority, producerVersion(), new Date(now));
  poolExport.quotaConfigured = (await readJson<Json>(PLANS_FILE, {})).schemaVersion === 2;
  publishPolicySnapshot({ policyDigest: capturedDigest, pools: poolExport, matrix: buildDispatchMatrixExport(matrix, producerVersion(), new Date(now)) }, capturedDigest);
  return stats;
}

export async function currentRoleLines(now = Date.now()): Promise<string[]> {
  const profiles = await loadProfiles();
  if (!profiles) return [t("dispatch.noProfiles")];
  const file = await readJson<Json>(POOL_STATUS, {});
  const pools = poolFlagsFromJson((file.pools ?? {}) as Record<string, Json>, now);
  const today = countRunsToday(readRunsSince(new Date(tokyoDayStart(now)).toISOString()), now);
  return lineupForRoles(profiles.filter((profile) => !providerBanned(profile, readBannedProviders())), pools, today, poolNames(await readPoolCatalog(), "label")).map((row) => row.line);
}
