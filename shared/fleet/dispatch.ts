import { providerBanned } from "./provider-policy";
// Dispatch matrix, per-profile cost, and lineup order.
// Thresholds live here. The functions are pure: callers pass data in and get data out.
import { ROLE_ORDER } from "./board";
import { PROFILE_SLOTS, resolveProfileToken } from "./dispatch-slots";
import { mergeDispatchOverrides, validDispatchOverrides, type ThinkingCatalog, type DispatchWarning } from "./dispatch-overrides";
import { isLeaderTitle } from "./leader-title";
import { actualModel, differentReviewModels } from "./review-model";
import { t, tAll, type MessageKey } from "./i18n";

/** Fewer runs than this: show "not enough data", and do not estimate a per-run percent. */
export const MIN_SAMPLES = 3;
/** Profile × effort averages use this many days of kanban runs. */
export const STATS_WINDOW_DAYS = 7;
/** Reset target. Same number as the progress line (pools.ts PACE_TARGET). */
export const PACE_TARGET_PCT = 97;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Japan has no daylight saving. */
export const TOKYO_OFFSET_MS = 9 * HOUR_MS;
export const DEFAULT_TIER = "L2";
export const EXECUTOR_TIERS = ["L1", "L2", "L3", "L4"] as const;
export const CLAUDE_WEEK_MS = 7 * DAY_MS;

/** Role key → catalog key of its display label. */
const ROLE_LABEL_KEY: Readonly<Record<string, MessageKey>> = {
  supervisor: "dispatch.role.supervisor",
  executor: "dispatch.role.executor",
  reviewer: "dispatch.role.reviewer",
  reader: "dispatch.role.reader",
  decision: "dispatch.role.decision",
  batch: "dispatch.role.batch",
  ops_vercel: "dispatch.role.opsVercel",
  ops_cloudflare: "dispatch.role.opsCloudflare",
  ops_github: "dispatch.role.opsGithub",
  ops_notion: "dispatch.role.opsNotion",
};

/** Display label of a role key in the current language; undefined for a role this table does not know. */
export function roleLabel(roleKey: string): string | undefined {
  const key = ROLE_LABEL_KEY[roleKey];
  return key ? t(key) : undefined;
}

/** Spend buckets for Claude usage, in display order. The label is `dispatch.spend.<kind>`. */
export const CLAUDE_SPEND_KINDS = [
  "supervisor",
  "reviewer",
  "executor",
  "reader",
  "decision",
  "batch",
  "ops",
  "personal",
  "outside",
] as const;

export type ClaudeSpendKind = (typeof CLAUDE_SPEND_KINDS)[number];
/** The shown label of a spend bucket (current language). */
export type ClaudeSpendCategory = string;

export function claudeSpendLabel(kind: ClaudeSpendKind): ClaudeSpendCategory {
  return t(`dispatch.spend.${kind}`);
}

export interface MatrixEntry {
  profile: string;
  effort: string | null;
  paused?: boolean;
  /** Explicit per-slot order from data overrides; takes precedence over quota ordering. */
  order?: number;
}

export interface DispatchMatrix {
  version: number;
  generatedAt?: string;
  defaultTier: string;
  roles: Record<string, unknown>;
  downgradeWhenTight: string[];
  /**
   * Pool order in force until `until` (at most 30 minutes after it was written): by quota (needPerDay, DEMO_0124)
   * or the user's plans.json override. Kanban ranks prefer like a plain pool while it lasts.
   */
  priority?: { order: string[]; until: string; mode?: "quota" | "manual" };
}

export interface DispatchProfile {
  name: string;
  role?: string;
  candidateFor?: string | null;
  pausedCandidateFor?: string | null;
  pool?: string | null;
  family?: string | null;
  provider?: string;
  model?: string | null;
  thinkingOptionId?: string | null;
  notes?: string;
  /** Stable matrix id. Wins over a name or model marker when both could match a slot. */
  dispatchId?: string;
}

export interface PoolFlags {
  dispatchable: boolean;
  prefer: boolean;
  deprioritize?: boolean;
  reason?: string;
  dailyPct?: number | null;
  perRunPct?: number | null;
  usedPct?: number | null;
  projectedPct?: number | null;
  elapsedPct?: number | null;
  daysLeft?: number | null;
  resetsAt?: string | null;
  /** Points per day needed to avoid waste at reset (waste-risk.ts). Display only since DEMO_0124. */
  wasteRisk?: number | null;
  /** Points per day still to use before reset (waste-risk.ts needPerDayOf). What the pool order is built from. */
  needPerDay?: number | null;
  /**
   * Place in the pool order in force (dispatch-priority.ts, 0 first): by needPerDay, or the user's override.
   * Null or absent when no order is in force or the pool is not listed. Only reorders dispatchable ranks 0 and 1.
   */
  priorityIndex?: number | null;
  /** When set, only a profile whose role or candidateFor is listed may take work from this pool. */
  onlyRoles?: string[];
  /**
   * During a named burn week, these profiles ignore a pause mark in their notes.
   * A pool that cannot take work still pauses them. Absent outside that week.
   */
  unpauseProfiles?: string[];
}

/** Missing or empty onlyRoles does not restrict. A listed role or candidateFor is enough. */
function allowedByOnlyRoles(profile: DispatchProfile, onlyRoles: string[] | undefined): boolean {
  if (!onlyRoles || onlyRoles.length === 0) return true;
  if (profile.role && onlyRoles.includes(profile.role)) return true;
  if (profile.candidateFor && onlyRoles.includes(profile.candidateFor)) return true;
  return false;
}

/**
 * True when this burn week lists the profile.
 * A listed profile ignores a pause mark in its notes and a paused stand-in mark (`pausedCandidateFor`).
 * A pool that cannot take work, or an onlyRoles limit, still pauses it.
 */
function burnUnpaused(profile: DispatchProfile, pool: PoolFlags | undefined): boolean {
  return pool?.unpauseProfiles?.includes(profile.name) === true;
}

/** A profile is paused when its pool cannot take work, its role is outside onlyRoles, its notes carry the pause mark, or it is a paused stand-in. */
export function profilePaused(profile: DispatchProfile, pool: PoolFlags | undefined): boolean {
  if (pool && pool.dispatchable === false) return true;
  if (pool && !allowedByOnlyRoles(profile, pool.onlyRoles)) return true;
  if (burnUnpaused(profile, pool)) return false;
  if (pauseMarkAt(profile.notes).index >= 0) return true;
  return profile.role === "personal" && Boolean(profile.pausedCandidateFor);
}

/**
 * 0 prefer, 1 dispatchable, 2 deprioritized (still dispatchable), 3 paused.
 * While a pool order is in force, ranks 0 and 1 sort by it first (needPerDay or the user's override, DEMO_0124).
 * Otherwise stable, so the base matrix order is kept until a pool flag moves it.
 */
export function dispatchRank(profile: DispatchProfile, pool: PoolFlags | undefined): number {
  if (profilePaused(profile, pool)) return 3;
  if (pool?.prefer) return 0;
  if (pool?.deprioritize) return 2;
  return 1;
}

interface RankedRow {
  index: number;
  rank: number;
  priority: number;
}

/** Sorts after every listed pool. With no order in force every row gets this, so the old order holds. */
const UNLISTED_PRIORITY = Number.MAX_SAFE_INTEGER;

/** Prefer and plain dispatchable share one band, so the pool order can move a plain pool above a preferred one. */
function rankBand(rank: number): number {
  return rank <= 1 ? 0 : rank;
}

/** The pool order applies only to dispatchable ranks 0 and 1; deprioritized and paused rows keep their place. */
function priorityKey(rank: number, pool: PoolFlags | undefined): number {
  if (rank > 1) return 0;
  const index = pool?.priorityIndex;
  return typeof index === "number" && Number.isFinite(index) ? index : UNLISTED_PRIORITY;
}

/** Band → pool order (needPerDay or override, DEMO_0124) → rank → base order. Waste risk no longer sorts. */
function byRankThenOrder(a: RankedRow, b: RankedRow): number {
  return rankBand(a.rank) - rankBand(b.rank) || a.priority - b.priority || a.rank - b.rank || a.index - b.index;
}

export function orderProfiles<T extends DispatchProfile>(profiles: T[], pools: Record<string, PoolFlags>): T[] {
  return profiles
    .map((profile, index) => {
      const pool = profile.pool ? pools[profile.pool] : undefined;
      const rank = dispatchRank(profile, pool);
      return { profile, index, rank, priority: priorityKey(rank, pool) };
    })
    .sort(byRankThenOrder)
    .map((row) => row.profile);
}

export function profilesForRole(roleKey: string, profiles: DispatchProfile[], bannedProviders: readonly string[] = []): DispatchProfile[] {
  const seen = new Set<string>();
  const found: DispatchProfile[] = [];
  for (const profile of profiles) {
    if (seen.has(profile.name)) continue;
    if (providerBanned(profile, bannedProviders)) continue;
    const serves =
      profile.role === roleKey || profile.candidateFor === roleKey || profile.pausedCandidateFor === roleKey;
    if (!serves) continue;
    seen.add(profile.name);
    found.push(profile);
  }
  return found;
}

/** Profile names may carry a stand-in tag, full-width or ASCII parentheses, in any language. */
export function displayProfileName(name: string): string {
  const tags = tAll("dispatch.candidateTag").flatMap((tag) => [tag, tag.normalize("NFKC")]);
  const stripped = tags.reduce((text, tag) => text.split(tag).join(""), name);
  return stripped.replace(/\s+/g, " ").trim();
}

/** `labels`: pool id → display name (shared/quota-adapters.ts poolNames(catalog, "label")). Unknown pools show their id. */
export function poolLabel(pool: string | null | undefined, labels: Readonly<Record<string, string>> = {}): string {
  if (!pool) return t("dispatch.noPool");
  return labels[pool] ?? pool;
}

/** First pause mark (dispatch.pauseMark, any language) in profile notes; index -1 when there is none. */
function pauseMarkAt(notes: string | undefined): { index: number; mark: string } {
  const text = notes ?? "";
  const hits = tAll("dispatch.pauseMark")
    .map((mark) => ({ index: text.indexOf(mark), mark }))
    .filter((hit) => hit.index >= 0)
    .sort((a, b) => a.index - b.index);
  return hits[0] ?? { index: -1, mark: "" };
}

/** Text after the pause mark, first clause, short enough for one line. */
export function pauseNote(notes: string | undefined): string | null {
  const text = notes ?? "";
  const { index, mark } = pauseMarkAt(text);
  if (index < 0) return null;
  const matched = /^\s*([^。\n]+)/.exec(text.slice(index + mark.length));
  if (!matched) return null;
  const clause = splitFirst(matched[1], tAll("dispatch.clauseSeparator")).trim();
  if (!clause) return null;
  return clause.length > 42 ? `${clause.slice(0, 42)}…` : clause;
}

/** Text before the first of `separators`; the whole text when none occurs. */
function splitFirst(text: string, separators: readonly string[]): string {
  const cut = separators.map((sep) => text.indexOf(sep)).filter((at) => at >= 0);
  return cut.length > 0 ? text.slice(0, Math.min(...cut)) : text;
}

/** Pool pause keeps the snapshot reason. A resume time in that reason becomes "paused until". */
export function pauseStatusText(reason: string): string {
  const expected = tAll("pools.pace.expectedToken").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const when = new RegExp(`(?:${expected})\\s+(\\d{1,2}\\/\\d{1,2}\\s+\\d{1,2}:\\d{2})`).exec(reason);
  const head = splitFirst(reason, tAll("dispatch.reasonSeparator")).trim() || t("dispatch.status.paused");
  if (when) return t("dispatch.status.pausedUntil", { when: when[1], head });
  return t("dispatch.status.pausedBecause", { reason });
}

export function statusOf(
  profile: DispatchProfile,
  pool: PoolFlags | undefined,
): { status: "prefer" | "ready" | "paused"; text: string } {
  const listed = burnUnpaused(profile, pool);
  const note = listed ? null : pauseNote(profile.notes);
  const notePaused = !listed && (Boolean(note) || (profile.role === "personal" && Boolean(profile.pausedCandidateFor)));
  if (pool && pool.dispatchable === false) {
    return { status: "paused", text: pool.reason ? pauseStatusText(pool.reason) : t("dispatch.status.paused") };
  }
  if (pool && !allowedByOnlyRoles(profile, pool.onlyRoles)) {
    return { status: "paused", text: t("dispatch.status.reviewOnly") };
  }
  if (notePaused) return { status: "paused", text: note ? t("dispatch.status.pausedBecause", { reason: note }) : t("dispatch.status.paused") };
  if (pool?.prefer) return { status: "prefer", text: t("dispatch.status.prefer") };
  if (pool?.deprioritize) return { status: "ready", text: t("dispatch.status.readyLater") };
  return { status: "ready", text: t("dispatch.status.ready") };
}

export interface LineupItem {
  name: string;
  rawName?: string;
  family: string | null;
  model: string;
  effort: string | null;
  pool: string | null;
  poolLabel: string;
  status: "prefer" | "ready" | "paused";
  statusText: string;
  todayRuns: number;
}

export function buildLineup(
  roleKey: string,
  profiles: DispatchProfile[],
  pools: Record<string, PoolFlags>,
  todayRuns: Record<string, number>,
  labels: Readonly<Record<string, string>> = {},
): LineupItem[] {
  return orderProfiles(profilesForRole(roleKey, profiles), pools).map((profile) => {
    const pool = profile.pool ? pools[profile.pool] : undefined;
    const status = statusOf(profile, pool);
    return {
      name: roleKey === "supervisor" ? "<leader>" : displayProfileName(profile.name),
      rawName: profile.name,
      family: profile.family ?? null,
      model: profile.model ?? "?",
      effort: profile.thinkingOptionId ?? null,
      pool: profile.pool ?? null,
      poolLabel: poolLabel(profile.pool, labels),
      status: status.status,
      statusText: status.text,
      todayRuns: todayRuns[profile.name] ?? 0,
    };
  });
}

export function formatLineupItem(item: LineupItem): string {
  const effort = item.effort ?? t("dispatch.effortDefault");
  const family = item.family ?? "?";
  return t("dispatch.lineupItem", { name: item.name, family, model: item.model, effort, pool: item.poolLabel, status: item.statusText, runs: item.todayRuns });
}

export function formatRoleLine(roleKey: string, items: LineupItem[]): string {
  const label = roleLabel(roleKey) ?? roleKey;
  if (items.length === 0) return t("dispatch.roleLineEmpty", { label });
  return t("dispatch.roleLine", { label, items: items.map(formatLineupItem).join(" → ") });
}

export function tokyoDayStart(now: number): number {
  const shifted = new Date(now + TOKYO_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TOKYO_OFFSET_MS;
}

/** Start of the Claude week: the plan's reset minus 7 days, or the previous Thursday 22:00 in Tokyo. */
export function claudeWeekStart(resetsAt: string | null, now: number): number {
  if (resetsAt) {
    const end = Date.parse(resetsAt);
    if (!Number.isNaN(end)) return end - CLAUDE_WEEK_MS;
  }
  const tokyo = new Date(now + TOKYO_OFFSET_MS);
  const weekday = tokyo.getUTCDay();
  const minutes = tokyo.getUTCHours() * 60 + tokyo.getUTCMinutes();
  let daysBack = (weekday - 4 + 7) % 7;
  if (daysBack === 0 && minutes < 22 * 60) daysBack = 7;
  const clock = Date.UTC(tokyo.getUTCFullYear(), tokyo.getUTCMonth(), tokyo.getUTCDate(), 22, 0, 0) - daysBack * DAY_MS;
  return clock - TOKYO_OFFSET_MS;
}

export function countRunsToday(runs: Array<{ profile: string; at: string }>, now: number): Record<string, number> {
  const start = tokyoDayStart(now);
  const counts: Record<string, number> = {};
  for (const run of runs) {
    const t = Date.parse(run.at);
    if (!run.profile || Number.isNaN(t) || t < start || t > now) continue;
    counts[run.profile] = (counts[run.profile] ?? 0) + 1;
  }
  return counts;
}

function isEntry(value: unknown): value is MatrixEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as { profile?: unknown };
  return typeof row.profile === "string";
}

function isEntryList(value: unknown): value is MatrixEntry[] {
  return Array.isArray(value) && value.length > 0 && value.every(isEntry);
}

export function orderMatrixEntries(
  entries: MatrixEntry[],
  profiles: DispatchProfile[],
  pools: Record<string, PoolFlags> | null,
  knownNames: Set<string> | null,
  onUnresolvedSlot?: (slot: string) => void,
  bannedProviders: readonly string[] = [],
): MatrixEntry[] {
  // Never publish an unresolved slot, even when config could not be read.
  const list = entries.flatMap((entry) => {
    const resolved = resolveProfileToken(entry.profile, profiles);
    const name = resolved?.name ?? entry.profile;
    if (Object.hasOwn(PROFILE_SLOTS, entry.profile) && (!resolved || (knownNames && !knownNames.has(name)))) {
      onUnresolvedSlot?.(entry.profile);
      return [];
    }
    if (knownNames && !knownNames.has(name)) return [];
    if (providerBanned(resolved ?? profiles.find((profile) => profile.name === name) ?? name, bannedProviders)) return [];
    return [{ profile: name, effort: entry.effort ?? null, ...(entry.paused === true ? { paused: true } : {}), ...(entry.order !== undefined ? { order: entry.order } : {}) }];
  });
  if (!pools) return list;
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  return list
    .map((entry, index) => {
      const profile = byName.get(entry.profile);
      const pool = profile?.pool ? pools[profile.pool] : undefined;
      const paused = entry.paused === true || (profile ? profilePaused(profile, pool) : false);
      const rank = profile ? dispatchRank(profile, pool) : 1;
      return { entry, index, rank, paused, priority: priorityKey(rank, pool) };
    })
    .sort((a, b) => {
      const aOrder = a.entry.order;
      const bOrder = b.entry.order;
      if (aOrder !== undefined || bOrder !== undefined) {
        if (aOrder === undefined) return 1;
        if (bOrder === undefined) return -1;
        return aOrder - bOrder || a.index - b.index;
      }
      return byRankThenOrder(a, b);
    })
    .map(({ entry, paused }) => (paused ? { ...entry, paused: true } : entry));
}

function mapLists(node: unknown, fn: (list: MatrixEntry[]) => MatrixEntry[]): unknown {
  if (isEntryList(node)) return fn(node);
  if (Array.isArray(node)) return node.map((item) => mapLists(item, fn));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = mapLists(value, fn);
    return out;
  }
  return node;
}

export interface ReviewerModelMatrix {
  byExecutorModel: Record<string, Record<string, MatrixEntry[]>>;
}

const recordNode = (node: unknown): Record<string, unknown> | null =>
  node && typeof node === "object" && !Array.isArray(node) ? node as Record<string, unknown> : null;
const entryArray = (node: unknown): MatrixEntry[] => Array.isArray(node) && node.every(isEntry) ? node : [];

/** Legacy input only: merge tier candidates, never exclude by family. First occurrence keeps its settings. */
export function legacyReviewerTiers(node: unknown): Record<string, MatrixEntry[]> {
  const families = recordNode(recordNode(node)?.byExecutorFamily);
  const tiers: Record<string, MatrixEntry[]> = {};
  for (const branch of Object.values(families ?? {})) for (const [tier, value] of Object.entries(recordNode(branch) ?? {})) {
    const list = tiers[tier] ??= [];
    for (const entry of entryArray(value)) if (!list.some(row => row.profile === entry.profile)) list.push({ ...entry });
  }
  return tiers;
}

/** A model branch, including an empty/invalid one, is authoritative; it cannot borrow another branch. */
export function reviewerTier(matrix: Pick<DispatchMatrix, "roles">, executorModel: unknown, tier: string): MatrixEntry[] {
  const model = actualModel(executorModel);
  const node = recordNode(matrix.roles.reviewer);
  if (!model || !node) return [];
  if (Object.hasOwn(node, "byExecutorModel")) {
    const branches = recordNode(node.byExecutorModel);
    const tiers = recordNode(branches && Object.hasOwn(branches, model) ? branches[model] : null);
    return entryArray(tiers?.[tier] ?? tiers?.["*"]);
  }
  const tiers = Object.hasOwn(node, "byExecutorFamily") ? legacyReviewerTiers(node) : node;
  return entryArray(tiers[tier] ?? tiers["*"]);
}

/** Recheck live profiles at use time: a candidate may have changed model since matrix publication. */
export function eligibleReviewers(matrix: Pick<DispatchMatrix, "roles">, executorModel: unknown, tier: string,
  profiles: readonly DispatchProfile[], pools: Record<string, PoolFlags> | null, bannedProviders: readonly string[] = []): MatrixEntry[] {
  const byName = new Map(profiles.map(profile => [profile.name, profile]));
  return reviewerTier(matrix, executorModel, tier).flatMap(entry => {
    const profile = byName.get(entry.profile);
    if (!profile || !(profile.role === "reviewer" || (profile.role === "candidate" && profile.candidateFor === "reviewer") ||
      (profile.role === "personal" && profile.pausedCandidateFor === "reviewer")) ||
      !differentReviewModels(executorModel, profile.model) || providerBanned(profile, bannedProviders)) return [];
    const paused = entry.paused === true || profilePaused(profile, profile.pool ? pools?.[profile.pool] : undefined);
    return [{ ...entry, ...(paused ? { paused: true } : {}) }];
  });
}

function reviewerModelMatrix(matrix: DispatchMatrix, profiles: DispatchProfile[], pools: Record<string, PoolFlags> | null,
  knownNames: Set<string> | null, bannedProviders: readonly string[]): ReviewerModelMatrix {
  const models = [...new Set(profiles.filter(profile => !knownNames || knownNames.has(profile.name)).flatMap(profile => {
    const model = actualModel(profile.model);
    return model ? [model] : [];
  }))];
  const node = recordNode(matrix.roles.reviewer);
  const byExecutorModel = Object.fromEntries(models.map(model => {
    const source = node && Object.hasOwn(node, "byExecutorModel")
      ? recordNode(recordNode(node.byExecutorModel)?.[model]) : node;
    const tiers = Object.keys(source ?? {}).filter(tier => /^L[1-4]$/.test(tier) || tier === "*");
    return [model, Object.fromEntries(tiers.map(tier => [tier,
      eligibleReviewers(matrix, model, tier, profiles.filter(profile => !knownNames || knownNames.has(profile.name)), pools, bannedProviders)]))];
  }));
  return { byExecutorModel };
}

/**
 * Drop unknown profiles, put explicit orders first, then rank the remaining candidates by quota.
 * Unresolved slots are dropped and reported so publishers can preserve the last usable file.
 */
export function applyDispatchMatrix(
  base: DispatchMatrix,
  options: {
    knownNames: Set<string> | null;
    profiles: DispatchProfile[];
    pools: Record<string, PoolFlags> | null;
    generatedAt: string;
    priority?: DispatchMatrix["priority"];
    onUnresolvedSlot?: (slot: string) => void;
    bannedProviders?: readonly string[];
    dispatchOverrides?: unknown;
    thinkingCatalog?: ThinkingCatalog;
    onOverrideWarning?: DispatchWarning;
  },
): DispatchMatrix {
  const warn = options.onOverrideWarning ?? (() => {});
  const overrides = validDispatchOverrides(options.dispatchOverrides, options.profiles, options.thinkingCatalog ?? {}, warn);
  // Convert only legacy reviewer input before applying overrides. Other roles remain byte-for-byte inputs.
  const reviewer = recordNode(base.roles.reviewer);
  const normalized = reviewer && !Object.hasOwn(reviewer, "byExecutorModel") && Object.hasOwn(reviewer, "byExecutorFamily")
    ? { ...base, roles: { ...base.roles, reviewer: legacyReviewerTiers(reviewer) } } : base;
  const copy = mergeDispatchOverrides(normalized, overrides, warn);
  copy.generatedAt = options.generatedAt;
  delete copy.priority;
  if (options.priority) {
    const { order, until, mode } = options.priority;
    copy.priority = { order: [...order], until, ...(mode ? { mode } : {}) };
  }
  copy.roles = mapLists(copy.roles, (list) => orderMatrixEntries(list, options.profiles, options.pools, options.knownNames, options.onUnresolvedSlot, options.bannedProviders)) as DispatchMatrix["roles"];
  if (Object.hasOwn(copy.roles, "reviewer")) copy.roles.reviewer = reviewerModelMatrix(copy, options.profiles, options.pools, options.knownNames, options.bannedProviders ?? []);
  return copy;
}

/** Remove only explicitly banned rows from an existing matrix without changing its order or timestamps. */
export function excludeBannedMatrix<T extends { roles: unknown }>(matrix: T, profiles: readonly DispatchProfile[], terms: readonly string[]): T {
  if (terms.length === 0) return matrix;
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  return { ...matrix, roles: mapLists(matrix.roles, (list) => list.filter((entry) =>
    !providerBanned(byName.get(entry.profile) ?? entry.profile, terms))) };
}

export function executorTier(matrix: DispatchMatrix, tier: string): MatrixEntry[] {
  const roles = matrix.roles?.executor;
  if (!roles || typeof roles !== "object") return [];
  const list = (roles as Record<string, unknown>)[tier];
  return isEntryList(list) || (Array.isArray(list) && list.every(isEntry)) ? (list as MatrixEntry[]) : [];
}

export function firstDispatchable(entries: MatrixEntry[]): MatrixEntry | null {
  return entries.find((entry) => !entry.paused) ?? null;
}

/** Missing effort on a run means the profile's own depth. */
export function resolveEffort(runEffort: string | null | undefined, profileEffort: string | null | undefined): string {
  const run = runEffort?.trim();
  if (run) return run;
  const own = profileEffort?.trim();
  return own || t("dispatch.effortDefault");
}

export interface UsageHit {
  sessionId: string;
  hour: number;
  tokens: number;
  usd: number | null;
}

export interface AttributableRun {
  id: string;
  profile: string;
  effort: string;
  start: number;
  end: number;
  sessionIds: string[];
}

/** Give each hourly bucket to the run of that session with the greatest overlap. */
export function assignUsage(runs: AttributableRun[], hits: UsageHit[]): Map<string, { tokens: number; usd: number | null }> {
  // An absent entry means no matching usage, not an observed zero.
  const out = new Map<string, { tokens: number; usd: number | null }>();
  const bySession = new Map<string, AttributableRun[]>();
  for (const run of runs) {
    for (const id of run.sessionIds) {
      const list = bySession.get(id) ?? [];
      list.push(run);
      bySession.set(id, list);
    }
  }
  for (const hit of hits) {
    const list = bySession.get(hit.sessionId);
    if (!list) continue;
    const hourEnd = hit.hour + HOUR_MS;
    let best: { id: string; overlap: number; start: number } | null = null;
    for (const run of list) {
      const overlap = Math.min(hourEnd, run.end) - Math.max(hit.hour, run.start);
      if (overlap <= 0) continue;
      if (!best || overlap > best.overlap || (overlap === best.overlap && run.start < best.start)) {
        best = { id: run.id, overlap, start: run.start };
      }
    }
    if (!best) continue;
    const row = out.get(best.id) ?? { tokens: 0, usd: 0 };
    row.tokens += hit.tokens;
    row.usd = row.usd === null || hit.usd === null ? null : row.usd + hit.usd;
    out.set(best.id, row);
  }
  return out;
}

export interface EffortStat {
  profile: string;
  effort: string;
  runs: number;
  usageSamples: number;
  pricedSamples: number;
  avgTokens: number | null;
  avgUsd: number | null;
}

export interface EffortRun {
  profile: string;
  effort: string;
  tokens: number | null;
  usd: number | null;
}

export function summarizeEfforts(
  runs: EffortRun[],
  minSamples = MIN_SAMPLES,
): EffortStat[] {
  const groups = new Map<string, { profile: string; effort: string; runs: number; tokens: number; usd: number; usageSamples: number; pricedSamples: number }>();
  for (const run of runs) {
    const key = `${run.profile}\0${run.effort}`;
    const group = groups.get(key) ?? { profile: run.profile, effort: run.effort, runs: 0, tokens: 0, usd: 0, usageSamples: 0, pricedSamples: 0 };
    group.runs += 1;
    if (run.tokens !== null && Number.isFinite(run.tokens) && run.tokens >= 0) {
      group.tokens += run.tokens;
      group.usageSamples += 1;
      if (run.usd !== null && Number.isFinite(run.usd) && run.usd >= 0) {
        group.usd += run.usd;
        group.pricedSamples += 1;
      }
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.runs - a.runs || a.profile.localeCompare(b.profile) || a.effort.localeCompare(b.effort))
    .map((group) => {
      return {
        profile: group.profile,
        effort: group.effort,
        runs: group.runs,
        usageSamples: group.usageSamples,
        pricedSamples: group.pricedSamples,
        avgTokens: group.usageSamples >= minSamples ? Math.round(group.tokens / group.usageSamples) : null,
        avgUsd: group.pricedSamples >= minSamples ? Math.round((group.usd / group.pricedSamples) * 10_000) / 10_000 : null,
      };
    });
}

export interface PoolCost {
  pool: string;
  runs: number;
  perRunPct: number | null;
  /** Runs between the quota readings, used only as the perRunPct denominator. */
  sampleRuns?: number;
}

/** Reading delta ÷ runs in that same span. Under MIN_SAMPLES the percent stays unknown. */
export function poolRunCost(pool: string, deltaPct: number | null, runs: number, minSamples = MIN_SAMPLES): PoolCost {
  if (runs < minSamples || deltaPct === null || !(deltaPct > 0)) return { pool, runs, perRunPct: null };
  return { pool, runs, perRunPct: Math.round((deltaPct / runs) * 10_000) / 10_000 };
}

export interface TierCard {
  tier: string;
  profile: string | null;
  pool: string | null;
  cards: number | null;
}

/** Remaining daily percent ÷ percent per run, for the first profile in the tier that is not paused. */
export function tierCards(
  tier: string,
  entries: MatrixEntry[],
  profiles: DispatchProfile[],
  pools: Record<string, PoolFlags>,
  costs: PoolCost[],
): TierCard {
  const chosen = firstDispatchable(entries);
  if (!chosen) return { tier, profile: null, pool: null, cards: null };
  const profile = profiles.find((item) => item.name === chosen.profile);
  const pool = profile?.pool ?? null;
  const cost = pool ? costs.find((item) => item.pool === pool) : undefined;
  const daily = pool ? pools[pool]?.dailyPct : null;
  if (!pool || !cost || cost.perRunPct === null || daily === null || daily === undefined || !(cost.perRunPct > 0)) {
    return { tier, profile: chosen.profile, pool, cards: null };
  }
  return { tier, profile: chosen.profile, pool, cards: Math.round((daily / cost.perRunPct) * 10) / 10 };
}

export interface PriceRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  long: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

/** Public list price for one bucket. A one-hour cache write is twice the input price. */
export function publicPriceUsd(bucket: number[], long: boolean, price: PriceRates | null): number | null {
  if (!price || bucket.length < 5) return null;
  const rate = long && price.long ? price.long : price;
  return (bucket[0] * rate.input + bucket[1] * rate.cacheRead + bucket[2] * rate.cacheWrite + bucket[3] * rate.input * 2 + bucket[4] * rate.output) / 1e6;
}

export function bucketTokens(bucket: number[]): number {
  return (bucket[0] ?? 0) + (bucket[1] ?? 0) + (bucket[2] ?? 0) + (bucket[3] ?? 0) + (bucket[4] ?? 0);
}

/** Roles an agent title can name in its leading 【...】 tag; matched against the role label in every language. */
const TITLE_ROLES = ["executor", "reviewer", "reader", "decision", "batch"] as const;

function roleFromTitle(title: string): string | null {
  const titleRole = /^【([^】]+)】/.exec(title)?.[1] ?? "";
  const head = titleRole.split("·")[0]?.trim() ?? "";
  const named = TITLE_ROLES.find((role) => tAll(ROLE_LABEL_KEY[role]).includes(head));
  if (named) return named;
  if (isLeaderTitle(title)) return "supervisor";
  const opsHeads = [...tAll("dispatch.title.ops"), ...tAll("dispatch.title.docs")];
  return opsHeads.some((word) => head.startsWith(word)) ? "ops" : null;
}

/** Spend bucket of one Claude session's agent (no record: outside Paseo). */
export function claudeSpendKind(agent: { role: string | null; title: string } | null): ClaudeSpendKind {
  if (!agent) return "outside";
  const role = agent.role && agent.role !== "candidate" && agent.role !== "personal" ? agent.role : roleFromTitle(agent.title);
  if (role === "supervisor" || role === "reviewer" || role === "executor" || role === "reader" || role === "decision" || role === "batch") return role;
  if (role === "ops" || (role ?? "").startsWith("ops_")) return "ops";
  return "personal";
}

export function claudeCategory(agent: { role: string | null; title: string } | null): ClaudeSpendCategory {
  return claudeSpendLabel(claudeSpendKind(agent));
}

export interface ClaudeSessionInput {
  sessionId: string;
  path: string;
  hours: Array<{ hour: number; usd: number }>;
}

export interface ClaudeCategoryRow {
  category: ClaudeSpendCategory;
  usd: number;
  sharePct: number;
}

export interface ClaudeSpend {
  today: ClaudeCategoryRow[];
  week: ClaudeCategoryRow[];
  unmatchedDirs: string[];
  projectedPct: number | null;
  dailyCapPct: number | null;
  resetsAt: string | null;
}

function sumBetween(hours: Array<{ hour: number; usd: number }>, from: number, to: number): number {
  let usd = 0;
  for (const row of hours) if (row.hour >= from && row.hour < to) usd += row.usd;
  return usd;
}

function withShares(amounts: Map<ClaudeSpendKind, number>): ClaudeCategoryRow[] {
  const total = [...amounts.values()].reduce((sum, usd) => sum + usd, 0);
  return CLAUDE_SPEND_KINDS.map((kind) => {
    const usd = Math.round((amounts.get(kind) ?? 0) * 100) / 100;
    const share = total > 0 ? ((amounts.get(kind) ?? 0) / total) * 100 : 0;
    return { category: claudeSpendLabel(kind), usd, sharePct: Math.round(share * 10) / 10 };
  });
}

function dirName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? path);
}

export function classifyClaudeSpend(
  sessions: ClaudeSessionInput[],
  agents: Record<string, { role: string | null; title: string }>,
  range: { dayStart: number; weekStart: number; now: number },
  pace: { usedPct: number | null; elapsedPct: number | null; dailyPct: number | null; projectedPct: number | null; resetsAt: string | null },
): ClaudeSpend {
  const today = new Map<ClaudeSpendKind, number>();
  const week = new Map<ClaudeSpendKind, number>();
  const dirs = new Map<string, number>();
  for (const session of sessions) {
    const agent = agents[session.sessionId] ?? null;
    const category = claudeSpendKind(agent);
    const dayUsd = sumBetween(session.hours, range.dayStart, range.now + 1);
    const weekUsd = sumBetween(session.hours, range.weekStart, range.now + HOUR_MS);
    today.set(category, (today.get(category) ?? 0) + dayUsd);
    week.set(category, (week.get(category) ?? 0) + weekUsd);
    if (category === "outside" && weekUsd > 0) {
      const name = dirName(session.path);
      dirs.set(name, (dirs.get(name) ?? 0) + weekUsd);
    }
  }
  const elapsed = pace.elapsedPct !== null && pace.elapsedPct > 0 ? pace.elapsedPct / 100 : null;
  const projected =
    pace.projectedPct !== null
      ? pace.projectedPct
      : pace.usedPct !== null && elapsed
        ? pace.usedPct / elapsed
        : null;
  return {
    today: withShares(today),
    week: withShares(week),
    unmatchedDirs: [...dirs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name]) => name),
    projectedPct: projected === null ? null : Math.round(projected * 10) / 10,
    dailyCapPct: pace.dailyPct === null || pace.dailyPct === undefined ? null : Math.round(pace.dailyPct * 10) / 10,
    resetsAt: pace.resetsAt,
  };
}

/**
 * Project only agentProfiles from the top-level public RPC configuration. Callers must provide a safe source.
 * This lossy dispatch projection must not reconstruct complete profiles for configuration patches.
 */
export function profilesFromRpcConfig(raw: unknown, bannedProviders: readonly string[] = []): DispatchProfile[] | null {
  if (!raw || typeof raw !== "object") return null;
  return profilesFromConfig({ daemon: { agentProfiles: (raw as { agentProfiles?: unknown }).agentProfiles } }, bannedProviders);
}

export function profilesFromConfig(raw: unknown, bannedProviders: readonly string[] = []): DispatchProfile[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { daemon?: { agentProfiles?: unknown } }).daemon?.agentProfiles;
  if (!Array.isArray(list)) return null;
  const out: DispatchProfile[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) continue;
    if (providerBanned(record, bannedProviders)) continue;
    out.push({
      name,
      role: typeof record.role === "string" ? record.role : undefined,
      candidateFor: typeof record.candidateFor === "string" ? record.candidateFor : null,
      pausedCandidateFor: typeof record.pausedCandidateFor === "string" ? record.pausedCandidateFor : null,
      pool: typeof record.pool === "string" ? record.pool : null,
      family: typeof record.family === "string" ? record.family : null,
      provider: typeof record.provider === "string" ? record.provider : "",
      model: typeof record.model === "string" ? record.model : null,
      thinkingOptionId: typeof record.thinkingOptionId === "string" ? record.thinkingOptionId : null,
      notes: typeof record.notes === "string" ? record.notes : "",
      ...(typeof record.dispatchId === "string" && record.dispatchId ? { dispatchId: record.dispatchId } : {}),
    });
  }
  return out;
}

export interface DispatchStats {
  generatedAt: string;
  windowDays: number;
  minSamples: number;
  byProfileEffort: EffortStat[];
  byPool: PoolCost[];
  tiers: TierCard[];
  claude: ClaudeSpend | null;
}

export function buildDispatchBundle(input: {
  base: DispatchMatrix;
  dispatchOverrides?: unknown;
  thinkingCatalog?: ThinkingCatalog;
  onOverrideWarning?: DispatchWarning;
  bannedProviders?: readonly string[];
  profiles: DispatchProfile[] | null;
  pools: Record<string, PoolFlags>;
  generatedAt: string;
  priority?: DispatchMatrix["priority"];
  effortRuns: EffortRun[];
  poolDeltas: Array<{ pool: string; deltaPct: number | null; runs: number }>;
  claude: ClaudeSpend | null;
}): { matrix: DispatchMatrix; stats: DispatchStats; unresolvedSlots: string[] } {
  const profiles = (input.profiles ?? []).filter((profile) => !providerBanned(profile, input.bannedProviders));
  const bannedPools = new Set((input.profiles ?? []).filter((profile) => providerBanned(profile, input.bannedProviders))
    .flatMap((profile) => profile.pool ? [profile.pool] : []));
  // A transport pool shared with an allowed profile remains usable.
  for (const profile of profiles) if (profile.pool) bannedPools.delete(profile.pool);
  const poolAllowed = (pool: string) => !bannedPools.has(pool) && !providerBanned(pool, input.bannedProviders);
  const knownNames = input.profiles ? new Set(input.profiles.map((profile) => profile.name)) : null;
  const unresolvedSlots = new Set<string>();
  const matrix = applyDispatchMatrix(input.base, {
    knownNames,
    profiles: input.profiles ?? [],
    bannedProviders: input.bannedProviders,
    pools: input.profiles ? input.pools : null,
    generatedAt: input.generatedAt,
    priority: input.priority ? { ...input.priority, order: input.priority.order.filter(poolAllowed) } : undefined,
    onUnresolvedSlot: (slot) => unresolvedSlots.add(slot),
    dispatchOverrides: input.dispatchOverrides,
    thinkingCatalog: input.thinkingCatalog,
    onOverrideWarning: input.onOverrideWarning,
  });
  const effortRuns = input.effortRuns.filter((run) => !providerBanned(input.profiles?.find((profile) => profile.name === run.profile) ?? run.profile, input.bannedProviders));
  const profilePools = new Map(profiles.map((profile) => [profile.name, profile.pool]));
  const runsByPool = new Map<string, number>();
  for (const run of effortRuns) {
    const pool = profilePools.get(run.profile);
    if (pool) runsByPool.set(pool, (runsByPool.get(pool) ?? 0) + 1);
  }
  const byPool = input.poolDeltas.filter((row) => poolAllowed(row.pool)).map((row) => ({
    ...poolRunCost(row.pool, row.deltaPct, row.runs),
    runs: runsByPool.get(row.pool) ?? 0,
    sampleRuns: row.runs,
  }));
  const tiers = EXECUTOR_TIERS.map((tier) => tierCards(tier, executorTier(matrix, tier), profiles, input.pools, byPool));
  const stats: DispatchStats = {
    generatedAt: input.generatedAt,
    windowDays: STATS_WINDOW_DAYS,
    minSamples: MIN_SAMPLES,
    byProfileEffort: summarizeEfforts(effortRuns),
    byPool,
    tiers,
    claude: input.claude,
  };
  return { matrix, stats, unresolvedSlots: [...unresolvedSlots] };
}

export function lineupForRoles(
  profiles: DispatchProfile[],
  pools: Record<string, PoolFlags>,
  todayRuns: Record<string, number>,
  labels: Readonly<Record<string, string>> = {},
): Array<{ key: string; items: LineupItem[]; line: string }> {
  return ROLE_ORDER.map((key) => {
    const items = buildLineup(key, profiles, pools, todayRuns, labels);
    return { key, items, line: formatRoleLine(key, items) };
  });
}
