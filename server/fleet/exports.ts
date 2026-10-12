/// <reference types="node" />
// fleet-quota/v1 exports for Paseo Kanban (server/contract). Files go to the cockpit's exports
// directory (`exportsDir("agent-fleet-cockpit")`: AFC_DATA_DIR or $PASEO_HOME/plugin-data/agent-fleet-cockpit),
// which is where the contract tells consumers to look.
//
// These files are written in addition to the legacy ones (pool-status.json, dispatch-matrix.json,
// decisions.json in the data directory), which older consumers may still read.
// A failed export is logged and never breaks the legacy write that triggered it.
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CockpitInfo,
  type Decisions,
  type DecisionsOpen,
  type PausedProjects,
  type DispatchMatrix as DispatchMatrixExport,
  envelopeFor,
  exportsDir,
  type OpenDecision,
  type PoolState,
  type PoolStatus as PoolStatusExport,
  writeExport,
} from "../contract";
import { excludeBannedMatrix, type DispatchMatrix, type DispatchProfile } from "../../shared/fleet/dispatch";
import { afcCli, afcPluginDir } from "./paths";
import { PAUSED_PROJECTS } from "./paused";
import { parsePausedProjects } from "../../shared/fleet/paused";
import { DECISIONS, readJson, STATE_DIR, writeJson } from "./util";

/** What the cockpit exports, announced in cockpit.json. */
export const EXPORT_FEATURES = ["quota", "dispatch-matrix", "decisions", "decisions-all", "paused-projects"] as const;

const COCKPIT_EVERY_MS = 10 * 60_000;
const DECISIONS_POLL_MS = 30_000;
/** Rewrite decisions-open.json at least this often, well inside its 600 s TTL. */
const DECISIONS_MAX_AGE_MS = 5 * 60_000;
const FALLBACK_VERSION = "0.0.0";

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** Any parseable timestamp as a canonical ISO string; null when missing or unparseable. */
export function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringsOrNull(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function percentOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

let versionMemo: string | null = null;

/** The plugin's package.json version, read once. */
export function producerVersion(): string {
  if (versionMemo !== null) return versionMemo;
  const dir = afcPluginDir();
  let version = FALLBACK_VERSION;
  if (dir) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version) version = parsed.version;
    } catch {
      version = FALLBACK_VERSION;
    }
  }
  versionMemo = version;
  return version;
}

// ---------------------------------------------------------------- pure builders

/** The matrix and pool-status files call the user's override "manual" and the quota order "quota". */
export function contractPriorityMode(mode: unknown): "user" | "auto" {
  return mode === "manual" ? "user" : "auto";
}

export function toPoolState(row: unknown): PoolState {
  const pool = isRecord(row) ? row : {};
  return {
    ...(pool.quotaProtection === "pause" || pool.quotaProtection === "none" ? { quotaProtection: pool.quotaProtection, readingExpiresAt: isoOrNull(pool.readingExpiresAt) } : {}),
    dispatchable: pool.dispatchable === true,
    deprioritize: pool.deprioritize === true,
    prefer: pool.prefer === true,
    usedPct: percentOrNull(pool.usedPct),
    resetsAt: isoOrNull(pool.resetsAt),
    onlyRoles: stringsOrNull(pool.onlyRoles),
    reason: textOrNull(pool.reason),
  };
}

/** pool-status.json export from the same pools and priority the legacy file was written with. */
export function buildPoolStatusExport(pools: unknown, priority: unknown, version: string, now: Date): PoolStatusExport {
  const rows = isRecord(pools) ? pools : {};
  const order = isRecord(priority) ? stringsOrNull(priority.order) : null;
  return {
    ...envelopeFor("poolStatus", version, now),
    producer: "agent-fleet-cockpit",
    pools: Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, toPoolState(row)])),
    priority: order && isRecord(priority) ? { order, mode: contractPriorityMode(priority.mode) } : null,
  };
}

/** dispatch-matrix.json export: the matrix as written, inside the envelope (keeps quota|manual). */
export function buildDispatchMatrixExport(matrix: DispatchMatrix, version: string, now: Date): DispatchMatrixExport {
  const until = matrix.priority ? isoOrNull(matrix.priority.until) : null;
  const priority = matrix.priority && until
    ? { order: [...matrix.priority.order], until, ...(matrix.priority.mode ? { mode: matrix.priority.mode } : {}) }
    : null;
  return {
    ...envelopeFor("dispatchMatrix", version, now),
    producer: "agent-fleet-cockpit",
    version: matrix.version,
    defaultTier: matrix.defaultTier,
    roles: matrix.roles as DispatchMatrixExport["roles"],
    downgradeWhenTight: [...matrix.downgradeWhenTight],
    priority,
  };
}

/** All decision statuses and the fields consumed by the board, without private bookkeeping. */
export function buildDecisionsExport(items: unknown, version: string, now: Date): Decisions {
  const rows = Array.isArray(items) ? items.filter(isRecord) : [];
  return {
    ...envelopeFor("decisions", version, now), producer: "agent-fleet-cockpit",
    items: rows.filter((item) => typeof item.id === "string" && typeof item.status === "string" && item.status.trim()).map((item) => ({
      id: String(item.id), status: String(item.status),
      project: typeof item.project === "string" ? item.project : "",
      title: typeof item.title === "string" ? item.title : "",
      detail: typeof item.detail === "string" ? item.detail : "",
      blocking: item.blocking === true, agentId: textOrNull(item.agentId),
      createdAt: isoOrNull(item.createdAt) ?? now.toISOString(),
      ...(typeof item.owner === "string" || item.owner === null ? { owner: item.owner } : {}),
      ...(Array.isArray(item.userComments) ? { userComments: item.userComments.filter(isRecord).flatMap((comment) => {
        const at = isoOrNull(comment.at);
        return at && typeof comment.note === "string" ? [{ at, note: comment.note }] : [];
      }) } : {}),
    })),
  };
}

/** Open rows retain owner and later notes in v1.1. */
export function openDecisions(items: unknown, now: Date): OpenDecision[] {
  return buildDecisionsExport(items, FALLBACK_VERSION, now).items.filter((item) => item.status === "open").map(({ status, ...item }) => item);
}

export function buildPausedProjectsExport(items: unknown, version: string, now: Date): PausedProjects {
  return {
    ...envelopeFor("pausedProjects", version, now), producer: "agent-fleet-cockpit",
    projects: parsePausedProjects(items).map((item) => ({ ...item, since: isoOrNull(item.since) })),
  };
}

/**
 * Open decisions minus those with an empty project: Kanban before DEMO_0303 rejects the whole file when one
 * item has an empty project, so such items are left out and counted in `skipped`.
 */
export function exportableDecisions(items: unknown, now: Date): { items: OpenDecision[]; skipped: number } {
  const open = openDecisions(items, now);
  const kept = open.filter((item) => item.project.trim() !== "");
  return { items: kept, skipped: open.length - kept.length };
}

/** `onSkipped` receives how many open items were left out for an empty project (also when 0). */
export function buildDecisionsOpenExport(items: unknown, version: string, now: Date, onSkipped?: (count: number) => void): DecisionsOpen {
  const { items: kept, skipped } = exportableDecisions(items, now);
  onSkipped?.(skipped);
  return { ...envelopeFor("decisionsOpen", version, now), producer: "agent-fleet-cockpit", items: kept };
}

export function buildCockpitInfo(input: { dataDir: string; cli: string | null }, version: string, now: Date): CockpitInfo {
  return {
    ...envelopeFor("cockpit", version, now),
    producer: "agent-fleet-cockpit",
    dataDir: input.dataDir,
    cli: input.cli,
    features: [...EXPORT_FEATURES],
  };
}

// ---------------------------------------------------------------- writers (never throw)

async function guarded(kind: string, write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    console.error(`[afc] contract export ${kind}:`, String(error).slice(0, 300));
    return false;
  }
}

export function publishPoolStatusExport(pools: unknown, priority: unknown, now = Date.now()): Promise<boolean> {
  return guarded("pool-status", async () => {
    const document = await readJson<{ schemaVersion?: number }>(join(STATE_DIR, "plans.json"), {});
    const payload = buildPoolStatusExport(pools, priority, producerVersion(), new Date(now));
    if (document.schemaVersion === 2) payload.quotaConfigured = true;
    await writeExport("poolStatus", payload);
  });
}

/** Preserve an existing matrix on unresolved slots; explicit provider bans still remove matching rows. */
export async function preserveDispatchMatrix(path: string, unresolvedSlots: readonly string[], policy?: { profiles: readonly DispatchProfile[]; bannedProviders: readonly string[] }): Promise<boolean> {
  if (unresolvedSlots.length === 0) return false;
  try {
    await stat(path);
    if (policy?.bannedProviders.length) {
      const old = await readJson<{ roles?: unknown }>(path, {});
      if (old.roles) {
        const filtered = excludeBannedMatrix({ ...old, roles: old.roles }, policy.profiles, policy.bannedProviders);
        if (JSON.stringify(filtered.roles) !== JSON.stringify(old.roles)) await writeJson(path, filtered);
      }
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function publishDispatchMatrixExport(matrix: DispatchMatrix, now = Date.now(), unresolvedSlots: readonly string[] = [], policy?: { profiles: readonly DispatchProfile[]; bannedProviders: readonly string[] }): Promise<boolean> {
  return guarded("dispatch-matrix", async () => {
    if (await preserveDispatchMatrix(join(exportsDir("agent-fleet-cockpit"), "dispatch-matrix.json"), unresolvedSlots, policy)) return;
    await writeExport("dispatchMatrix", buildDispatchMatrixExport(matrix, producerVersion(), new Date(now)));
  });
}

let loggedSkipped = 0;

/** Log the number of skipped empty-project items once, and again only when that number changes. */
function logSkippedDecisions(count: number): void {
  if (count === loggedSkipped) return;
  loggedSkipped = count;
  if (count > 0) console.log(`[afc] contract export decisions-open: skipped ${count} open item(s) with an empty project`);
}

/** Missing state means an empty list; corrupt state must not overwrite a valid export. */
async function readStateRows(path: string): Promise<unknown[]> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("state is not an array");
  return rows;
}

export function publishDecisionsOpenExport(decisionsPath = DECISIONS, now = Date.now()): Promise<boolean> {
  return guarded("decisions", async () => {
    const items = await readStateRows(decisionsPath);
    const version = producerVersion();
    await writeExport("decisions", buildDecisionsExport(items, version, new Date(now)));
    await writeExport("decisionsOpen", buildDecisionsOpenExport(items, version, new Date(now), logSkippedDecisions));
  });
}

export function publishPausedProjectsExport(path = PAUSED_PROJECTS, now = Date.now()): Promise<boolean> {
  return guarded("paused-projects", async () => {
    await writeExport("pausedProjects", buildPausedProjectsExport(await readStateRows(path), producerVersion(), new Date(now)));
  });
}

export function publishCockpitInfo(now = Date.now()): Promise<boolean> {
  return guarded("cockpit", () => writeExport("cockpit", buildCockpitInfo({ dataDir: STATE_DIR, cli: afcCli() }, producerVersion(), new Date(now))));
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * cockpit.json is written at startup and every 10 minutes; decision and pause exports are written
 * at startup, on state changes polled every 30 seconds, and at least every 5 minutes.
 * pool-status and dispatch-matrix exports are written next to their legacy files.
 */
export function startContractExports(): () => void {
  let lastMtime: number | null | undefined;
  let lastWrite = 0;
  const decisionsTick = async () => {
    const mtime = await mtimeOf(DECISIONS);
    const now = Date.now();
    if (mtime === lastMtime && now - lastWrite < DECISIONS_MAX_AGE_MS) return;
    if (await publishDecisionsOpenExport(DECISIONS, now)) {
      lastMtime = mtime;
      lastWrite = now;
    }
  };
  let lastPausedMtime: number | null | undefined;
  let lastPausedWrite = 0;
  const pausedTick = async () => {
    const mtime = await mtimeOf(PAUSED_PROJECTS);
    const now = Date.now();
    if (mtime === lastPausedMtime && now - lastPausedWrite < DECISIONS_MAX_AGE_MS) return;
    if (await publishPausedProjectsExport(PAUSED_PROJECTS, now)) {
      lastPausedMtime = mtime;
      lastPausedWrite = now;
    }
  };
  void publishCockpitInfo();
  void decisionsTick();
  void pausedTick();
  const cockpitTimer = setInterval(() => void publishCockpitInfo(), COCKPIT_EVERY_MS);
  const decisionsTimer = setInterval(() => void decisionsTick(), DECISIONS_POLL_MS);
  const pausedTimer = setInterval(() => void pausedTick(), DECISIONS_POLL_MS);
  return () => {
    clearInterval(cockpitTimer);
    clearInterval(decisionsTimer);
    clearInterval(pausedTimer);
  };
}
