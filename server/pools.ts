/// <reference types="node" />
import { readPolicy } from "./application/policy-snapshot";
import { classifyFreshness, envelopeAgeSeconds } from "./contract";
import { t } from "../shared/i18n";
import { readFileSync, statSync } from "./perf-fs";
import { roleLabel } from "../shared/labels";
import { DEFAULT_STALE_STOP_PCT, loadConfig } from "./config";
import { cockpitStateFile, readContractSync } from "./afc-sources";

/** Age limit for the legacy snapshot file (by mtime). A contract file uses its own ttlSeconds * 3. */
export const STALE_MS = 30 * 60 * 1000;
/** A snapshot this old wakes the Kanban supervisor once. */
export const STALE_WAKE_MS = 6 * 60 * 60 * 1000;
/** On a stale snapshot, a pool without its own stop line stops at this last reading (percent used). */
export const STALE_DEFAULT_STOP_PCT = 97;

export interface PoolEntry {
  /**
   * pause: stale snapshots and expired protected readings stop this pool, even without usedPct.
   * none: stale snapshots stay open. Missing: retain the legacy stale stop lines.
   */
  quotaProtection?: "pause" | "none";
  /** Null or missing on a protected pool counts as expired. */
  readingExpiresAt?: string | null;
  dispatchable: boolean;
  /** Whether Fleet explicitly supplied dispatchable=true, rather than the legacy open fallback. */
  dispatchableExplicit?: boolean;
  deprioritize: boolean;
  /** At the current pace this pool will clearly go unused before it resets. Missing means false. */
  prefer: boolean;
  resetsAt: string | null;
  reason: string | null;
  /**
   * Percent used in the snapshot, when AFC wrote a number.
   * Only a stale snapshot routes on it (the stop lines above).
   */
  usedPct?: number | null;
  /**
   * Roles allowed to take new work from this pool.
   * Null means no extra limit: the field was missing, not an array, or an empty array.
   * `dispatchable` stays the pool-wide flag and does not look at this list.
   */
  onlyRoles: string[] | null;
}

export interface PoolSnapshot {
  /** Immutable admission revision; absent only on explicitly injected compatibility snapshots. */
  policy?: Readonly<{ revision: number; digest: string }>;
  /**
   * stale: older than three contract TTLs (or STALE_MS for legacy files). Default policy keeps
   * existing pool stops and matrix pauses; explicit compatibility snapshots retain legacy fallback.
   * Both drop prefer/deprioritize, stop protected pools and enforce legacy usedPct stop lines.
   * missing: absent or invalid policy closes default admission; explicit compatibility stays open.
   * A family configured with requirePoolSeen refuses a missing pool or a stale
   * snapshot without a usage reading.
   */
  state: "fresh" | "missing" | "stale";
  message: string;
  generatedAt: string | null;
  /** When the file was last written (mtime). Null when there is no file. */
  updatedAt?: string | null;
  /** How long ago the file was last written. Null when there is no file. */
  ageMs?: number | null;
  /**
   * Why `state` is missing. Absent means the file is not there (the cockpit is not installed).
   * Invalid means the contract export failed its schema; it is logged once and handled like absent.
   * Unreadable means a legacy file could not be read or parsed.
   */
  failure?: "absent" | "invalid" | "unreadable";
  dispatchable(pool: string | null): boolean;
  entry(pool: string | null): PoolEntry;
  /**
   * True when this pool key is in the snapshot file.
   * Missing on a hand-built snapshot: requirePoolSeen treats the pool as unseen.
   */
  hasPool?(pool: string | null): boolean;
}

const OPEN_ENTRY: PoolEntry = {
  dispatchable: true,
  deprioritize: false,
  prefer: false,
  resetsAt: null,
  reason: null,
  usedPct: null,
  onlyRoles: null,
};

export function openEntry(): PoolEntry {
  return { ...OPEN_ENTRY };
}

/**
 * Where the snapshot comes from. KANBAN_POOL_STATUS names a legacy-format file (tests).
 * Otherwise the contract export, then the cockpit's legacy pool-status.json, then nothing.
 */
type PoolSource =
  | { kind: "legacy"; path: string }
  | { kind: "contract"; path: string; read: ReturnType<typeof readContractSync<"poolStatus">> }
  | { kind: "none"; invalid: string | null };

function poolSource(now: number): PoolSource {
  const override = process.env.KANBAN_POOL_STATUS;
  if (override !== undefined) return { kind: "legacy", path: override };
  const read = readContractSync("poolStatus", { now: new Date(now) });
  if (read.state === "fresh" || read.state === "stale") return { kind: "contract", path: read.path, read };
  const legacy = cockpitStateFile("pool-status.json");
  if (legacy) return { kind: "legacy", path: legacy };
  return { kind: "none", invalid: read.state === "invalid" ? read.reason : null };
}

/** Shown when there is no usable snapshot at all: base order; configured family and local pool restrictions still apply. */
export function poolsAbsentMessage(): string {
  return t("pools.absent");
}

/** Label for a profile without a pool. */
export function unmarkedPool(): string {
  return t("pools.unmarked");
}

export function poolsInvalidMessage(reason: string): string {
  return `pool-status export is invalid (${reason}); handled as absent: base order`;
}

function openSnapshot(message: string, failure: NonNullable<PoolSnapshot["failure"]>): PoolSnapshot {
  return {
    state: "missing",
    failure,
    message,
    generatedAt: null,
    updatedAt: null,
    ageMs: null,
    dispatchable: () => true,
    entry: () => openEntry(),
    hasPool: () => false,
  };
}

type RawPool = {
  quotaProtection?: unknown;
  readingExpiresAt?: unknown;
  dispatchable?: unknown;
  deprioritize?: unknown;
  prefer?: unknown;
  resetsAt?: unknown;
  reason?: unknown;
  usedPct?: unknown;
  onlyRoles?: unknown;
};

function parseUsedPct(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A string array of role keys. Missing, a non-array, or an array with no role names means no limit.
 * An empty array is treated as no limit. Non-strings in the array are dropped.
 */
export function parseOnlyRoles(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const roles: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const role = item.trim();
    if (!role || roles.includes(role)) continue;
    roles.push(role);
  }
  return roles.length > 0 ? roles : null;
}

function toEntry(raw: RawPool | undefined): PoolEntry {
  if (!raw || typeof raw !== "object") return openEntry();
  return {
    ...(raw.quotaProtection === "pause" || raw.quotaProtection === "none"
      ? { quotaProtection: raw.quotaProtection, readingExpiresAt: typeof raw.readingExpiresAt === "string" ? raw.readingExpiresAt : null }
      : {}),
    dispatchable: raw.dispatchable !== false,
    dispatchableExplicit: raw.dispatchable === true,
    deprioritize: raw.deprioritize === true,
    prefer: raw.prefer === true,
    resetsAt: typeof raw.resetsAt === "string" && raw.resetsAt ? raw.resetsAt : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
    usedPct: parseUsedPct(raw.usedPct),
    onlyRoles: parseOnlyRoles(raw.onlyRoles),
  };
}

/** Small record of the snapshot the scheduler just read. Never throws. A missing snapshot leaves the fields null. */
export interface QuotaBrief {
  generatedAt: string | null;
  state: PoolSnapshot["state"] | null;
  pool: string | null;
  dispatchable: boolean | null;
  usedPct: number | null;
  onlyRoles: string[] | null;
  matrixGeneratedAt: string | null;
}

export function quotaBrief(input: {
  snapshot?: PoolSnapshot | null;
  pool?: string | null;
  matrixGeneratedAt?: string | null;
}): QuotaBrief {
  const snapshot = input.snapshot ?? null;
  const pool = input.pool ?? null;
  const matrixGeneratedAt = input.matrixGeneratedAt ?? null;
  if (!snapshot || snapshot.state === "missing") {
    return {
      generatedAt: null,
      state: null,
      pool,
      dispatchable: null,
      usedPct: null,
      onlyRoles: null,
      matrixGeneratedAt,
    };
  }
  const entry = pool ? snapshot.entry(pool) : null;
  return {
    generatedAt: snapshot.generatedAt,
    state: snapshot.state,
    pool,
    dispatchable: entry ? entry.dispatchable : null,
    usedPct: entry?.usedPct ?? null,
    onlyRoles: entry?.onlyRoles ?? null,
    matrixGeneratedAt,
  };
}

/** Readable sentence when this role may not use the pool. Null when the pool has no role limit or the role is listed. */
export function onlyRolesBlock(entry: PoolEntry, pool: string | null, role: string | null): string | null {
  const allowed = entry.onlyRoles;
  if (!allowed || allowed.length === 0) return null;
  if (role && allowed.includes(role)) return null;
  const names = allowed.map((item) => roleLabel(item)).join(t("common.listSep"));
  return t("pools.onlyFor", { pool: pool ?? unmarkedPool(), roles: names });
}

function restrictionNote(pools: Record<string, PoolEntry>): string {
  const notes: string[] = [];
  for (const [name, entry] of Object.entries(pools)) {
    if (!entry.onlyRoles || entry.onlyRoles.length === 0) continue;
    const names = entry.onlyRoles.map((role) => roleLabel(role)).join(t("common.listSep"));
    notes.push(t("pools.onlyFor", { pool: name, roles: names }));
  }
  return notes.length > 0 ? `${t("common.semicolon")}${notes.join(t("common.semicolon"))}` : "";
}

export function staleMinutes(ageMs: number): number {
  return Math.floor(ageMs / 60_000);
}

export function staleStopPct(pool: string, stops: Readonly<Record<string, number>> = DEFAULT_STALE_STOP_PCT): number {
  return stops[pool] ?? STALE_DEFAULT_STOP_PCT;
}

/**
 * A stale protected pool stops even without usedPct; an explicitly unprotected pool stays open.
 * Legacy entries drop old pauses, prefer and deprioritize, retaining only the usedPct stop line.
 */
export function staleEntry(pool: string, entry: PoolEntry, stops: Readonly<Record<string, number>> = DEFAULT_STALE_STOP_PCT): PoolEntry {
  if (entry.quotaProtection === "pause") return expiredEntry(entry);
  if (entry.quotaProtection === "none") return { ...entry, dispatchable: true, prefer: false, deprioritize: false };
  const stop = staleStopPct(pool, stops);
  const used = entry.usedPct ?? null;
  const stopped = used != null && used >= stop;
  return {
    ...entry,
    dispatchable: !stopped,
    prefer: false,
    deprioritize: false,
    reason: stopped ? t("pools.staleStopped", { used: String(used), stop }) : null,
  };
}

interface SnapshotInput {
  /** Configured quota bindings close any named pool missing from the contract export. */
  quotaConfigured?: boolean;
  /** Immutable policy expiry may narrow admission, but cannot reopen a producer stop. */
  preserveStops?: boolean;
  now: number;
  pools: Record<string, RawPool>;
  generatedAt: string | null;
  updatedAt: string;
  ageMs: number;
  stale: boolean;
  stops: Readonly<Record<string, number>>;
}

function buildSnapshot(input: SnapshotInput): PoolSnapshot {
  const parsed: Record<string, PoolEntry> = {};
  for (const [name, value] of Object.entries(input.pools)) {
    const entry = toEntry(value);
    const expiry = entry.readingExpiresAt ? Date.parse(entry.readingExpiresAt) : Number.NaN;
    const protectedReadingExpired = entry.quotaProtection === "pause" && (!Number.isFinite(expiry) || input.now >= expiry);
    // Fresh snapshots follow dispatchable unless a protected reading has expired.
    const effective = input.stale ? staleEntry(name, entry, input.stops) : protectedReadingExpired ? expiredEntry(entry) : entry;
    parsed[name] = input.stale && input.preserveStops && !entry.dispatchable
      ? { ...effective, dispatchable: false, reason: entry.reason ?? effective.reason }
      : effective;
  }
  const known = new Set(Object.keys(parsed));
  const entryOf = (pool: string | null): PoolEntry => (
    pool && parsed[pool]
      ? parsed[pool]
      : pool && input.quotaConfigured
        ? { ...openEntry(), dispatchable: false, reason: t("pools.notConfigured") }
        : openEntry()
  );
  const note = restrictionNote(parsed);
  return {
    state: input.stale ? "stale" : "fresh",
    message: `${input.stale ? t(input.preserveStops ? "pools.stalePolicyMessage" : "pools.staleMessage", { minutes: staleMinutes(input.ageMs) }) : t("pools.freshMessage")}${note}`,
    generatedAt: input.generatedAt,
    updatedAt: input.updatedAt,
    ageMs: input.ageMs,
    // Pool-wide flag only. Callers that assign a role also check onlyRoles via onlyRolesBlock.
    dispatchable: (pool) => entryOf(pool).dispatchable,
    entry: entryOf,
    hasPool: (pool) => Boolean(pool && known.has(pool)),
  };
}

/** A legacy pool-status.json: stale when its mtime is older than STALE_MS. */
function readLegacySnapshot(path: string, now: number, stops: Readonly<Record<string, number>>): PoolSnapshot {
  let text: string;
  let mtime = 0;
  try {
    text = readFileSync(path, "utf8");
    mtime = statSync(path).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return openSnapshot(poolsAbsentMessage(), "absent");
    return openSnapshot(t("pools.unreadable"), "unreadable");
  }
  let raw: { generatedAt?: unknown; pools?: unknown };
  try {
    raw = JSON.parse(text) as { generatedAt?: unknown; pools?: unknown };
  } catch {
    return openSnapshot(t("pools.unreadable"), "unreadable");
  }
  if (!raw || typeof raw !== "object") return openSnapshot(t("pools.unreadable"), "unreadable");
  const ageMs = Math.max(0, now - mtime);
  return buildSnapshot({
    now,
    pools: raw.pools && typeof raw.pools === "object" ? (raw.pools as Record<string, RawPool>) : {},
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null,
    updatedAt: new Date(mtime).toISOString(),
    ageMs,
    stale: ageMs > STALE_MS,
    stops,
  });
}

/**
 * Default admission validates immutable policy and closes on absent/invalid policy.
 * The explicit legacy compatibility reader retains four transport states:
 *  - fresh: as written;
 *  - stale: no longer carries its pauses, prefer or deprioritize: work goes in the base matrix
 *    order. Protected pools stop, unprotected pools stay open, and legacy entries keep the
 *    last usedPct stop line (see staleEntry). `message` says so.
 *    The contract file is stale past ttlSeconds * 3 from generatedAt; the legacy file past STALE_MS by mtime;
 *  - invalid: the export fails its schema. Logged once, then handled like absent;
 *  - absent: the cockpit is not installed. Every pool is open in the base order.
 * A configured requirePoolSeen family is the exception: absent, invalid, unlisted, or stale
 * file without a reading for its pool are not dispatchable. kanban.config.json disabledPools
 * applies on top of all four (readPoolSnapshot).
 */
function readAfcPoolSnapshot(now: number, stops: Readonly<Record<string, number>>, compatibility = false): PoolSnapshot {
  if (!compatibility) {
    const policy = readPolicy(now);
    if (policy.state !== "ok") {
      const snapshot = openSnapshot(policy.reason, policy.state === "absent" ? "absent" : "invalid");
      const closed = () => ({ ...openEntry(), dispatchable: false, reason: policy.reason });
      return { ...snapshot, dispatchable: () => false, entry: closed };
    }
    const value = policy.snapshot.pools;
    return { ...buildSnapshot({ now, quotaConfigured: true, preserveStops: true, pools: value.pools, generatedAt: value.generatedAt, updatedAt: value.generatedAt, ageMs: envelopeAgeSeconds(value, new Date(now))*1000, stale: classifyFreshness(value,new Date(now)) === "stale", stops }),
      policy: Object.freeze({ revision: policy.snapshot.revision, digest: policy.snapshot.policyDigest }) };
  }
  const source = poolSource(now);
  if (source.kind === "none") {
    return source.invalid != null ? openSnapshot(poolsInvalidMessage(source.invalid), "invalid") : openSnapshot(poolsAbsentMessage(), "absent");
  }
  if (source.kind === "legacy") return readLegacySnapshot(source.path, now, stops);
  const { read } = source;
  if (read.state !== "fresh" && read.state !== "stale") return openSnapshot(poolsAbsentMessage(), "absent");
  return buildSnapshot({
    now,
    quotaConfigured: read.value.quotaConfigured,
    pools: read.value.pools,
    generatedAt: read.value.generatedAt,
    updatedAt: read.value.generatedAt,
    ageMs: Math.round(read.ageSeconds * 1000),
    stale: read.state === "stale",
    stops,
  });
}

function expiredEntry(entry: PoolEntry): PoolEntry {
  return { ...entry, dispatchable: false, prefer: false, deprioritize: false, usedPct: null, reason: t("pools.readingExpired") };
}

/** Local stop switches override AFC, including its missing/unreadable fallback. New work only. */
export function readPoolSnapshot(now = Date.now()): PoolSnapshot { return readSnapshot(now, false); }
/** Explicit protocol compatibility reader; never used by scheduler admission. */
export function readCompatibilityPoolSnapshot(now = Date.now()): PoolSnapshot { return readSnapshot(now, true); }
function readSnapshot(now: number, compatibility: boolean): PoolSnapshot {
  const config = loadConfig();
  const snapshot = readAfcPoolSnapshot(now, config.staleStopPct ?? DEFAULT_STALE_STOP_PCT, compatibility);
  const disabled = new Set(config.disabledPools ?? []);
  if (disabled.size === 0) return snapshot;
  const entry = (pool: string | null): PoolEntry => {
    const original = snapshot.entry(pool);
    return pool && disabled.has(pool)
      ? { ...original, dispatchable: false, reason: t("pools.disabledByConfig", { pool }) }
      : original;
  };
  return {
    ...snapshot,
    message: `${snapshot.message}${t("common.semicolon")}${[...disabled].map((pool) => t("pools.disabledByConfig", { pool })).join(t("common.semicolon"))}`,
    entry,
    dispatchable: (pool) => entry(pool).dispatchable,
  };
}
