import { canonicalPoolCounts } from "../shared/fleet/x-ultra";
/// <reference types="node" />
import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "./perf-fs";
import { dirname } from "node:path";
import { isProjectCode } from "../shared/card-code";
import { configuredOpsProject } from "../shared/fleet/ops-project";
import {
  CONFIG_PREV_FILE,
  ConfigFileError,
  configPath,
  kanbanLeaderFromCopies,
  priorConfigEvidence,
  readConfigFile,
  writeConfigAtomic,
  type ConfigFileRead,
} from "./config-file";
import { withConfigLock } from "./config-lock";
import { revokeLeaderMcpTokens } from "./tokens";
import { doctorSettings, type DoctorSettings } from "./config-doctor";
import { KanbanError } from "./errors";
import { dataDir } from "./paths";
import { parseProfileRuleOverrides, type ProfileRule } from "./profile-rules";
import { parseBanned, parseFamilies, type BannedProfiles, type FamilyRule } from "./fleet-rules";
import { isLanguageSetting, t, type LanguageSetting } from "../shared/i18n";
import { readExampleConfig } from "./config-example";
import { cloudSettingsSchema, parseCloudRunner, type CloudRunnerConfig, type CloudSettings } from "./cloud-config";
import { parseRunBudget, type RunBudgetLimits } from "./run-budget-config";
import { parseQuotaRouting, type QuotaRoutingConfig } from "./quota-routing";
import { parseQualification, type QualificationTable } from "../shared/fleet/executor-effort";

export interface ConcurrencyLimits {
  global: number;
  pools: Record<string, number>;
  roles: Record<string, number>;
}

export type WorkspaceMode = "dir" | "worktree";

/** Shown when a project file still says default worktree, and when someone tries to set it. */
export function retiredDefaultWorktree(): string {
  return t("config.retiredDefaultWorktree");
}

/** How a project's cards work when the creator does not pin a lane. The effective mode is always dir. */
export interface ProjectWorkspace {
  /** Replaces individual role/tier quality cells over the global defaults. */
  qualification?: QualificationTable;
  /** Per-project limits override the global run budget one key at a time. */
  runBudget?: Partial<RunBudgetLimits>;
  /** Maximum wall-clock background wait; absent uses three hours (project overrides global). */
  backgroundWaitMaxMs?: number;
  /** Opt-in disposable execution; other roles retain local placement. */
  cloudRunner?: CloudRunnerConfig;
  /** Project directory used for card scratch, independent of a card's temporary worktree. */
  workspacePath?: string;
  defaultWorkspace: WorkspaceMode;
  baseBranch: string;
  /** Additional local or remote-tracking branches whose ancestry proves card work has landed. */
  integrationBranches?: string[];
  /** How many long-lived lanes this project may use. Default 1. Changing the count does not open lanes. */
  worktreeLanes: number;
  /**
   * When false (the default), new cards cannot ask for a lane, and ready or waiting lane cards are held.
   * Turning this on can create a Paseo workspace. That needs the user's consent.
   */
  lanesEnabled: boolean;
  /**
   * When the main directory is already taken by a card that may change files, open a temporary
   * worktree instead of queueing. Absent or true means on. False queues, the old directory lock.
   */
  parallel?: boolean;
  /**
   * Keep the project's main workspace for its leader. New agents use temporary copies;
   * read-only roles inspect disposable snapshots and reviews borrow an existing temporary copy.
   * Absent or false means off. An explicit --force records a main-workspace exception.
   */
  alwaysTemp?: boolean;
  /** Wait for accepted parents' PRs to merge. Absent or true preserves the merge gate. */
  waitParentPr?: boolean;
  /** Short code in card numbers, e.g. CBL. Absent until migration or `project --code` sets it. */
  code?: string;
  /** Explicit host-approved data/document roots for this project's reader/decision cards. No default. */
  permissionReadRoots?: string[];
}

/** Shown when a project has not turned lanes on, and when a ready or waiting lane card is held. */
export function lanesDisabledMessage(): string {
  return t("config.lanesDisabled");
}

export interface KanbanConfig {
  /** Default on for new agents; false restores the previous matrix/roster routing. */
  quotaRouting?: QuotaRoutingConfig;
  /** Model/depth quality admission, independent of pool order and live profile names. */
  qualification?: QualificationTable;
  /** Consecutive unknown background process checks before waking; defaults to five. */
  backgroundWaitUnknownLimit?: number;
  /** Board-wide machine admission and deletion confirmation budgets. */
  cloud?: CloudSettings;
  /** Optional external JSON contacts file, read anew for each QA signoff notification. */
  contactsFile?: string;
  /** Per-running-card resource brake; absent keys use conservative built-in limits. */
  runBudget?: Partial<RunBudgetLimits>;
  /** Maximum wall-clock background wait; absent uses three hours (project overrides global). */
  backgroundWaitMaxMs?: number;
  autoStart: Record<string, boolean>;
  /**
   * Interface and agent-text language: "en", "zh-CN" or "system" (the operating system's locale).
   * A config file written before this field existed reads as LEGACY_LANGUAGE; a fresh installation
   * starts with FRESH_LANGUAGE. Absent in an object built in code means the same as a legacy file.
   * See server/language.ts.
   */
  language?: LanguageSetting;
  /**
   * True only on the file a fresh installation just copied from the example.
   * The settings page clears it when the user saves. A board that already had a config never gains it.
   */
  setupPending?: boolean;
  /** Pools that may not receive new work. Missing means no local pool restriction. */
  disabledPools?: string[];
  /**
   * Last usage reading (percent) at which a pool stops while the quota snapshot is stale.
   * Missing uses DEFAULT_STALE_STOP_PCT; a pool not listed stops at 97.
   */
  staleStopPct?: Record<string, number>;
  /** Extra dispatch limits per model family. Missing uses DEFAULT_FAMILIES. */
  families?: Record<string, FamilyRule>;
  /** Profiles never dispatched. Missing uses DEFAULT_BANNED. */
  bannedProviders?: BannedProfiles;
  /**
   * Kanban supervisor (fallback). Not the default supervisor for every project.
   * Woken only when that project's own supervisor cannot be found.
   */
  supervisorAgentId: string | null;
  /** Explicit operations cleanup project. An invalid explicit value disables the capability. */
  opsProject?: string | null;
  /** Fixed loopback port for the board MCP server. Empty reuses data/mcp.port, then any free port. */
  mcpPort?: number | null;
  /** Project name → agent id of the supervisor registered for that project. */
  supervisors: Record<string, string>;
  concurrency: ConcurrencyLimits;
  /** One archive call gives up after this long. The underlying call may still be running. */
  archiveTimeoutMs?: number;
  /** How many cards may clean up at the same time. */
  cleanupConcurrency?: number;
  /** After an archive call returns, wait this long and check the agent is still archived. */
  archiveVerifyMs?: number;
  /** How often done and archived cards are checked for agents that came back. */
  reconcileIntervalMs?: number;
  /** How often running and reviewing cards are checked for an idle agent. */
  stallIntervalMs?: number;
  /** Idle this long, with the card still open, counts as stalled. */
  stallIdleMs?: number;
  /**
   * A turn that ends this soon after the agent is opened does not count as a missed finish.
   * The first round has not started, or has only just started.
   */
  nudgeGraceMs?: number;
  /**
   * After a first-turn login blip, wait this long before opening the same profile again.
   * Default sits between one and two minutes.
   */
  loginBlipRetryMs?: number;
  /**
   * First wait before a transient block is checked again. Later waits double, up to two hours.
   * Default 15 minutes.
   */
  transientRetryMinutes?: number;
  /**
   * How many times a transient block is handed back before the project leader is woken.
   * Default 4.
   */
  transientRetryLimit?: number;
  /**
   * Consecutive accept-time land conflicts allowed before the card stops for a person.
   * The next conflict after this number wakes the project leader. Default 3.
   */
  landConflictLimit?: number;
  /** Hours a rework card waits for its original executor before switching pools. Default 2. */
  reworkReassignHours?: number;
  /**
   * Progress comments skip a missed-finish nudge only for this long.
   * The clock starts at the earliest comment since the last nudge. After that, the old rule applies.
   */
  progressGraceMs?: number;
  /**
   * Two counted missed-finish nudges must be at least this far apart.
   * A turn that ends sooner does not increment the counter and does not send a nudge.
   */
  nudgeIntervalMs?: number;
  /** After a daemon restart, wait this long before treating a silent agent as interrupted. */
  restartStallGraceMs?: number;
  /** A done card turns archived this long after it finished, or after its PR merged. */
  autoArchiveAfterMs?: number;
  /** Agents a finished card opened must be archived within this long. */
  archiveDeadlineMs?: number;
  /** How often every agent's cwd is checked. Missing directories under Paseo worktrees or the checkouts root are replaced with a placeholder. */
  missingCwdPatrolMs?: number;
  /**
   * Per-project base branch, lane count, and whether lanes may open a workspace.
   * A stored defaultWorkspace of worktree is read as dir.
   * Missing projects stay on the directory, base main, one lane, lanes off.
   */
  projects?: Record<string, ProjectWorkspace>;
  /**
   * Profile scope rules by profile name (prefix match). Overrides the built-in rules key by key;
   * null drops a built-in rule. See DEFAULT_PROFILE_RULES in profile-rules.ts.
   */
  profileRules?: Record<string, ProfileRule | null>;
  /**
   * Thresholds for `bin/kanban doctor`. Absent keys use the defaults in code.
   * The file is not rewritten just to store these.
   */
  doctor?: DoctorSettings;
  /**
   * Card-work capacity brake. Present only when the file has a `capacity` object.
   * Non-positive numbers fall back to the defaults (10 GiB of card work, 50 GiB free).
   */
  capacity?: { maxWorkGiB: number; minFreeGiB: number };
}

/** Card-work total above this many GiB pauses a new card's first work start. */
export const DEFAULT_MAX_WORK_GIB = 10;
/** Disk free below this many GiB pauses a new card's first work start. */
export const DEFAULT_MIN_FREE_GIB = 50;

/** A config file without a `language` field predates the setting: that board has always been in Chinese. */
export const LEGACY_LANGUAGE: LanguageSetting = "zh-CN";
/** The language a fresh installation's first config file gets. */
export const FRESH_LANGUAGE: LanguageSetting = "system";

/** Missing means the file predates the setting (LEGACY_LANGUAGE). A value that is not a language falls back to English. */
export function parseLanguageSetting(value: unknown): LanguageSetting {
  if (value === undefined) return LEGACY_LANGUAGE;
  return isLanguageSetting(value) ? value : "en";
}

export const DEFAULT_ARCHIVE_TIMEOUT_MS = 30_000;
export const DEFAULT_CLEANUP_CONCURRENCY = 2;
export const DEFAULT_ARCHIVE_VERIFY_MS = 60_000;
export const DEFAULT_RECONCILE_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_STALL_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_STALL_IDLE_MS = 10 * 60_000;
export const DEFAULT_NUDGE_GRACE_MS = 60_000;
export const DEFAULT_LOGIN_BLIP_RETRY_MS = 90_000;
export const DEFAULT_TRANSIENT_RETRY_MINUTES = 15;
export const DEFAULT_TRANSIENT_RETRY_LIMIT = 4;
export const DEFAULT_LAND_CONFLICT_LIMIT = 3;
export const DEFAULT_REWORK_REASSIGN_HOURS = 2;
export const DEFAULT_PROGRESS_GRACE_MS = 3 * 60_000;
export const DEFAULT_NUDGE_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_RESTART_STALL_GRACE_MS = 120_000;
export const DEFAULT_AUTO_ARCHIVE_AFTER_MS = 24 * 60 * 60_000;
export const DEFAULT_ARCHIVE_DEADLINE_MS = 5 * 60_000;
export const DEFAULT_MISSING_CWD_PATROL_MS = 10 * 60_000;

/** Stale-snapshot stop lines when kanban.config.json has no `staleStopPct`. */
export const DEFAULT_STALE_STOP_PCT: Readonly<Record<string, number>> = {};

export const DEFAULT_CONCURRENCY: ConcurrencyLimits = {
  global: 5,
  pools: {},
  roles: {
    executor: 3,
    reviewer: 2,
    reader: 1,
    decision: 1,
    batch: 1,
    supervisor: 1,
  },
};

export { ConfigFileError } from "./config-file";
export { DEFAULT_DOCTOR, DEFAULT_DOCTOR_BLOCKED_HOURS, doctorSettings, type DoctorBlockedHours, type DoctorSettings } from "./config-doctor";

function stringMap(value: unknown): Record<string, string> {
  const next: Record<string, string> = {};
  if (!value || typeof value !== "object") return next;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.trim() && key.trim()) next[key] = item.trim();
  }
  return next;
}

function backgroundWaitLimit(value: unknown, key: "background.error.timeout" | "background.error.unknownLimit" = "background.error.timeout"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigFileError(t(key));
  }
  return value;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Undefined means the file has no capacity key. A present key always stores both limits. */
function readCapacity(value: unknown): { maxWorkGiB: number; minFreeGiB: number } {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    maxWorkGiB: positiveNumber(raw.maxWorkGiB, DEFAULT_MAX_WORK_GIB),
    minFreeGiB: positiveNumber(raw.minFreeGiB, DEFAULT_MIN_FREE_GIB),
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function poolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim()).filter(Boolean))];
}

function portNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
}

const BRANCH_NAME = /^[\w./-]+$/;

/** A base branch name: no spaces, no leading dash, no parent-directory segment. */
export function isBaseBranch(value: string): boolean {
  return BRANCH_NAME.test(value) && !value.startsWith("-") && !value.includes("..");
}

function branchNameOk(value: string): boolean {
  return isBaseBranch(value);
}

/** Git branch/ref syntax, without revision expressions, tags or other ref namespaces. */
function integrationBranchNameOk(value: string): boolean {
  let name = value;
  if (name.startsWith("refs/heads/")) name = name.slice("refs/heads/".length);
  else if (name.startsWith("refs/remotes/")) {
    name = name.slice("refs/remotes/".length);
    if (!name.includes("/")) return false;
  } else if (name.startsWith("refs/")) return false;
  return name.length > 0 && name !== "HEAD" && !name.startsWith("-") &&
    !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(name) && !name.includes("..") && !name.includes("@{") && !name.endsWith(".") &&
    name.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function integrationBranches(value: unknown, project: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !integrationBranchNameOk(name))) {
    throw new ConfigFileError(t("config.badIntegrationBranches", { field: `projects.${project}.integrationBranches` }));
  }
  return [...new Set(value as string[])];
}

function laneCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return Math.min(value, 32);
  return 1;
}

function lanesEnabledValue(value: unknown): boolean {
  return value === true;
}

function projectMap(value: unknown): Record<string, ProjectWorkspace> {
  const next: Record<string, ProjectWorkspace> = {};
  if (!value || typeof value !== "object") return next;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || !item || typeof item !== "object") continue;
    const row = item as {
      defaultWorkspace?: unknown;
      baseBranch?: unknown;
      integrationBranches?: unknown;
      worktreeLanes?: unknown;
      lanesEnabled?: unknown;
      parallel?: unknown;
      alwaysTemp?: unknown;
      waitParentPr?: unknown;
      code?: unknown;
      permissionReadRoots?: unknown;
      workspacePath?: unknown;
      workspace?: unknown;
      cloudRunner?: unknown;
      runBudget?: unknown;
      backgroundWaitMaxMs?: unknown;
      qualification?: unknown;
    };
    const integrations = integrationBranches(row.integrationBranches, key);
    const mode = row.defaultWorkspace === "worktree" || row.defaultWorkspace === "dir" ? row.defaultWorkspace :
      row.defaultWorkspace === undefined && (integrations !== undefined || row.qualification !== undefined) ? "dir" : null;
    if (!mode) continue;
    const base = typeof row.baseBranch === "string" ? row.baseBranch.trim() : "";
    const code = typeof row.code === "string" ? row.code.trim().toUpperCase() : "";
    const workspace = row.workspacePath ?? row.workspace;
    next[key] = {
      defaultWorkspace: mode,
      ...(row.backgroundWaitMaxMs !== undefined ? { backgroundWaitMaxMs: backgroundWaitLimit(row.backgroundWaitMaxMs) } : {}),
      ...(row.runBudget !== undefined ? { runBudget: parseRunBudget(row.runBudget) } : {}),
      ...(row.qualification !== undefined ? { qualification: readQualification(row.qualification) } : {}),
      baseBranch: branchNameOk(base) ? base : "main",
      ...(integrations !== undefined ? { integrationBranches: integrations } : {}),
      worktreeLanes: laneCount(row.worktreeLanes),
      lanesEnabled: lanesEnabledValue(row.lanesEnabled),
      parallel: row.parallel !== false,
      ...(row.cloudRunner !== undefined ? { cloudRunner: readCloudRunner(key, row.cloudRunner) } : {}),
      ...(row.alwaysTemp === true ? { alwaysTemp: true } : {}),
      ...(row.waitParentPr === false ? { waitParentPr: false } : {}),
      ...(code && isProjectCode(code) ? { code } : {}),
      ...(typeof workspace === "string" && workspace.trim() ? { workspacePath: workspace.trim() } : {}),
      ...(Array.isArray(row.permissionReadRoots) ? { permissionReadRoots: row.permissionReadRoots.filter((root): root is string => typeof root === "string" && root.startsWith("/")) } : {}),
    };
  }
  return next;
}

function readCloudRunner(project: string, value: unknown): CloudRunnerConfig {
  try { return parseCloudRunner(project, value); }
  catch (error) { throw new ConfigFileError(`projects.${project}.cloudRunner: ${error instanceof Error ? error.message : String(error)}`); }
}

function readQualification(value: unknown): QualificationTable {
  try { return parseQualification(value); }
  catch (error) { throw new ConfigFileError(error instanceof Error ? error.message : String(error)); }
}

function readCloudSettings(value: unknown): CloudSettings {
  try { return cloudSettingsSchema.parse(value === undefined ? {} : value); }
  catch (error) { throw new ConfigFileError(`cloud: ${error instanceof Error ? error.message : String(error)}`); }
}

function readDoctor(value: unknown): DoctorSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return doctorSettings(null);
  return doctorSettings({ doctor: value as DoctorSettings });
}

/** A pool → percent map. Missing or not an object keeps the fallback; a present object replaces it. */
function percentMap(value: unknown, fallback: Readonly<Record<string, number>>): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const next: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() && typeof item === "number" && item >= 0 && item <= 100) next[key.trim()] = item;
  }
  return next;
}

function numberMap(value: unknown, fallback: Record<string, number>): Record<string, number> {
  const next = { ...fallback };
  if (!value || typeof value !== "object") return next;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "number" && item >= 0) next[key] = item;
  }
  return next;
}

/** Parsed config keyed by file identity. A file changed within the last CONFIG_FRESH_MS is always read again. */
let configCache: { path: string; mtimeMs: number; size: number; value: KanbanConfig } | null = null;
const CONFIG_FRESH_MS = 2_000;

/** The last config parsed from the file. The running plugin keeps going on it when the file goes missing or breaks. */
let lastGood: { path: string; value: KanbanConfig; at: string } | null = null;
/** Off in the command line: a CLI process has no copy worth trusting and must stop instead. */
let memoryFallback = false;
/** Data directories already known to have had a config. A directory never becomes fresh again. */
const knownConfigured = new Map<string, string>();

/** The plugin's scheduler turns this on. Missing or broken files are then served from the last good copy. */
export function useConfigMemoryFallback(on: boolean): void {
  memoryFallback = on;
}

/**
 * 76 call sites read the config, some once per card. Reading and validating the file each
 * time cost a fifth of a board build, so an unchanged file is served from memory. Every caller
 * gets its own copy, so one that edits the result cannot change what the next one sees.
 *
 * A missing file means defaults only on a fresh installation (no config copy, no card). Otherwise a
 * missing or broken file is never read as defaults (DEMO_0001): the plugin keeps the last good copy,
 * anything else gets ConfigFileError.
 */
export function loadConfig(): KanbanConfig {
  return readConfig(memoryFallback);
}

/**
 * The file, or defaults on a fresh installation; never the memory copy. Every read-modify-write uses this,
 * so a copy kept in memory is never written back over a file someone has just restored.
 */
function loadConfigForWrite(): KanbanConfig {
  return readConfig(false);
}

function readConfig(allowMemory: boolean): KanbanConfig {
  const path = configPath();
  let stat: { mtimeMs: number; size: number } | null = null;
  try {
    stat = statSync(path);
  } catch {
    stat = null;
  }
  if (stat && configCache && configCache.path === path && configCache.mtimeMs === stat.mtimeMs && configCache.size === stat.size && Date.now() - stat.mtimeMs > CONFIG_FRESH_MS) {
    return structuredClone(configCache.value);
  }
  const read = readConfigFile(path);
  if (read.state === "ok") {
    const config = parseConfig(read.raw);
    // Neither holder hands this object out, only clones of it, so the two can share one snapshot.
    const snapshot = structuredClone(config);
    configCache = stat ? { path, mtimeMs: stat.mtimeMs, size: stat.size, value: snapshot } : null;
    lastGood = { path, value: snapshot, at: new Date().toISOString() };
    return config;
  }
  configCache = null;
  if (read.state === "missing" && !configuredBefore(path)) return defaultConfig();
  if (allowMemory && lastGood?.path === path) return structuredClone(lastGood.value);
  throw new ConfigFileError(describeProblem(path, read).message);
}

/** Why this config path has had a file before, or null on a fresh installation. */
function configuredBefore(path: string, db?: DatabaseSync): string | null {
  if (lastGood?.path === path) return t("config.evidence.thisProcess");
  const dir = dirname(path);
  const known = knownConfigured.get(dir);
  if (known) return known;
  const evidence = priorConfigEvidence(dir, db);
  if (evidence?.lasting) knownConfigured.set(dir, evidence.text);
  return evidence?.text ?? null;
}

/** A config file the board must not run on and must not replace. */
export interface ConfigProblem {
  state: "missing" | "broken";
  /** The parse error, or what shows the board has had a config. */
  detail: string;
  /** One line for logs, errors, wakes and doctor. */
  message: string;
  /** When the copy the plugin keeps running on was read. Null when there is none in this process. */
  memoryAt: string | null;
}

function describeProblem(path: string, read: Exclude<ConfigFileRead, { state: "ok" }>): ConfigProblem {
  const memoryAt = lastGood?.path === path ? lastGood.at : null;
  const restore = t("config.restoreHint", { path: `${dirname(path)}/${CONFIG_PREV_FILE}` });
  if (read.state === "broken") {
    return {
      state: "broken",
      detail: read.detail,
      message: t("config.broken", { detail: read.detail, restore }),
      memoryAt,
    };
  }
  const detail = configuredBefore(path) ?? t("config.evidence.usedBefore");
  return {
    state: "missing",
    detail,
    message: t("config.missing", { detail, restore }),
    memoryAt,
  };
}

/**
 * The file as it is now: null when it parses, or when it is missing on a fresh installation.
 * Reads the file itself, so it reports a problem even while the plugin runs on its memory copy.
 */
export function configFileProblem(): ConfigProblem | null {
  const path = configPath();
  const read = readConfigFile(path);
  if (read.state === "ok") {
    try {
      parseConfig(read.raw);
      return null;
    } catch (err) {
      if (!(err instanceof ConfigFileError)) throw err;
      return describeProblem(path, { state: "broken", detail: err.message });
    }
  }
  if (read.state === "missing" && !configuredBefore(path)) return null;
  return describeProblem(path, read);
}

export function parseConfig(source: Record<string, unknown>): KanbanConfig {
  const raw = source as Partial<KanbanConfig> & {
    concurrency?: Partial<ConcurrencyLimits>;
  };
  const autoStart: Record<string, boolean> = {};
  if (raw.autoStart && typeof raw.autoStart === "object") {
    for (const [key, value] of Object.entries(raw.autoStart)) autoStart[key] = value !== false;
  }
  return {
    autoStart,
    ...(raw.backgroundWaitUnknownLimit !== undefined ? { backgroundWaitUnknownLimit: backgroundWaitLimit(raw.backgroundWaitUnknownLimit, "background.error.unknownLimit") } : {}),
    cloud: readCloudSettings(raw.cloud),
    ...(typeof raw.contactsFile === "string" && raw.contactsFile.trim() ? { contactsFile: raw.contactsFile.trim() } : {}),
    ...(raw.backgroundWaitMaxMs !== undefined ? { backgroundWaitMaxMs: backgroundWaitLimit(raw.backgroundWaitMaxMs) } : {}),
    ...(raw.runBudget !== undefined ? { runBudget: parseRunBudget(raw.runBudget) } : {}),
    ...(raw.quotaRouting !== undefined ? { quotaRouting: parseQuotaRouting(raw.quotaRouting) } : {}),
    ...(raw.qualification !== undefined ? { qualification: readQualification(raw.qualification) } : {}),
    language: parseLanguageSetting(raw.language),
    ...(raw.setupPending === true ? { setupPending: true } : {}),
    disabledPools: poolNames(raw.disabledPools),
    staleStopPct: percentMap(raw.staleStopPct, DEFAULT_STALE_STOP_PCT),
    families: parseFamilies(raw.families),
    bannedProviders: parseBanned(raw.bannedProviders),
    supervisorAgentId: typeof raw.supervisorAgentId === "string" && raw.supervisorAgentId.trim() ? raw.supervisorAgentId.trim() : null,
    ...(Object.hasOwn(source, "opsProject") ? { opsProject: configuredOpsProject(source) } : {}),
    mcpPort: portNumber(raw.mcpPort),
    supervisors: stringMap(raw.supervisors),
    concurrency: {
      global: typeof raw.concurrency?.global === "number" ? raw.concurrency.global : DEFAULT_CONCURRENCY.global,
      pools: canonicalPoolCounts(numberMap(raw.concurrency?.pools, DEFAULT_CONCURRENCY.pools), true),
      roles: numberMap(raw.concurrency?.roles, DEFAULT_CONCURRENCY.roles),
    },
    archiveTimeoutMs: positiveNumber(raw.archiveTimeoutMs, DEFAULT_ARCHIVE_TIMEOUT_MS),
    cleanupConcurrency: positiveNumber(raw.cleanupConcurrency, DEFAULT_CLEANUP_CONCURRENCY),
    archiveVerifyMs: positiveNumber(raw.archiveVerifyMs, DEFAULT_ARCHIVE_VERIFY_MS),
    reconcileIntervalMs: positiveNumber(raw.reconcileIntervalMs, DEFAULT_RECONCILE_INTERVAL_MS),
    stallIntervalMs: positiveNumber(raw.stallIntervalMs, DEFAULT_STALL_INTERVAL_MS),
    stallIdleMs: positiveNumber(raw.stallIdleMs, DEFAULT_STALL_IDLE_MS),
    nudgeGraceMs: positiveNumber(raw.nudgeGraceMs, DEFAULT_NUDGE_GRACE_MS),
    loginBlipRetryMs: positiveNumber(raw.loginBlipRetryMs, DEFAULT_LOGIN_BLIP_RETRY_MS),
    transientRetryMinutes: positiveNumber(raw.transientRetryMinutes, DEFAULT_TRANSIENT_RETRY_MINUTES),
    transientRetryLimit: positiveInt(raw.transientRetryLimit, DEFAULT_TRANSIENT_RETRY_LIMIT),
    landConflictLimit: positiveInt(raw.landConflictLimit, DEFAULT_LAND_CONFLICT_LIMIT),
    reworkReassignHours: positiveNumber(raw.reworkReassignHours, DEFAULT_REWORK_REASSIGN_HOURS),
    progressGraceMs: positiveNumber(raw.progressGraceMs, DEFAULT_PROGRESS_GRACE_MS),
    nudgeIntervalMs: positiveNumber(raw.nudgeIntervalMs, DEFAULT_NUDGE_INTERVAL_MS),
    restartStallGraceMs: positiveNumber(raw.restartStallGraceMs, DEFAULT_RESTART_STALL_GRACE_MS),
    autoArchiveAfterMs: positiveNumber(raw.autoArchiveAfterMs, DEFAULT_AUTO_ARCHIVE_AFTER_MS),
    archiveDeadlineMs: positiveNumber(raw.archiveDeadlineMs, DEFAULT_ARCHIVE_DEADLINE_MS),
    missingCwdPatrolMs: positiveNumber(raw.missingCwdPatrolMs, DEFAULT_MISSING_CWD_PATROL_MS),
    doctor: readDoctor(raw.doctor),
    projects: projectMap(raw.projects),
    ...(raw.profileRules !== undefined ? { profileRules: parseProfileRuleOverrides(raw.profileRules) ?? {} } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, "capacity") ? { capacity: readCapacity(source.capacity) } : {}),
  };
}

function defaultConfig(): KanbanConfig {
  return {
    autoStart: {},
    cloud: readCloudSettings(undefined),
    language: FRESH_LANGUAGE,
    disabledPools: [],
    staleStopPct: { ...DEFAULT_STALE_STOP_PCT },
    families: parseFamilies(undefined),
    bannedProviders: parseBanned(undefined),
    supervisorAgentId: null,
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
    archiveTimeoutMs: DEFAULT_ARCHIVE_TIMEOUT_MS,
    cleanupConcurrency: DEFAULT_CLEANUP_CONCURRENCY,
    archiveVerifyMs: DEFAULT_ARCHIVE_VERIFY_MS,
    reconcileIntervalMs: DEFAULT_RECONCILE_INTERVAL_MS,
    stallIntervalMs: DEFAULT_STALL_INTERVAL_MS,
    stallIdleMs: DEFAULT_STALL_IDLE_MS,
    nudgeGraceMs: DEFAULT_NUDGE_GRACE_MS,
    loginBlipRetryMs: DEFAULT_LOGIN_BLIP_RETRY_MS,
    transientRetryMinutes: DEFAULT_TRANSIENT_RETRY_MINUTES,
    transientRetryLimit: DEFAULT_TRANSIENT_RETRY_LIMIT,
    landConflictLimit: DEFAULT_LAND_CONFLICT_LIMIT,
    reworkReassignHours: DEFAULT_REWORK_REASSIGN_HOURS,
    progressGraceMs: DEFAULT_PROGRESS_GRACE_MS,
    nudgeIntervalMs: DEFAULT_NUDGE_INTERVAL_MS,
    restartStallGraceMs: DEFAULT_RESTART_STALL_GRACE_MS,
    autoArchiveAfterMs: DEFAULT_AUTO_ARCHIVE_AFTER_MS,
    archiveDeadlineMs: DEFAULT_ARCHIVE_DEADLINE_MS,
    missingCwdPatrolMs: DEFAULT_MISSING_CWD_PATROL_MS,
    doctor: doctorSettings(null),
    projects: {},
  };
}

/**
 * Parsed config object for a writer.
 * A missing file is an empty object only on a fresh installation, so its first write can create it.
 * A file that cannot be read, is not JSON or is not an object, or is missing on a board that has had
 * a config, is left untouched: ConfigFileError.
 */
function readConfigRaw(): Record<string, unknown> {
  const path = configPath();
  const read = readConfigFile(path);
  if (read.state === "ok") return read.raw;
  // A fresh installation's first file records its language, so it is not read back as a legacy file.
  if (read.state === "missing" && !configuredBefore(path)) return { language: FRESH_LANGUAGE };
  throw new ConfigFileError(describeProblem(path, read).message);
}

/**
 * Throws ConfigFileError when the file is broken, or missing on a board that has had one.
 * The command line calls this before anything else, and callers about to refuse because a project or a
 * registration is missing call it first, so a lost file is reported as such.
 */
export function assertConfigReadable(): void {
  const problem = configFileProblem();
  if (problem) throw new ConfigFileError(problem.message);
}

/**
 * For read-only reports (doctor, card numbers): the file, else the copy in memory, else defaults.
 * Never throws because of the file. Must not be used to decide anything that is written or dispatched.
 */
export function loadConfigForReport(): KanbanConfig {
  return loadConfigOrMemory() ?? defaultConfig();
}

/**
 * The file, else the copy in memory, else null: what the board actually knows. Card numbers use this,
 * because defaults have no project codes and would print numbers no one can look up.
 */
export function loadConfigOrMemory(): KanbanConfig | null {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigFileError)) throw err;
  }
  const path = configPath();
  return lastGood?.path === path ? structuredClone(lastGood.value) : null;
}

/**
 * The Kanban <leader> to wake about a board problem. When the file is missing or broken: the copy in memory,
 * then kanban.config.json.prev or the newest backup. Never throws because of the file.
 */
export function kanbanLeaderForAlarm(): string | null {
  try {
    return loadConfig().supervisorAgentId;
  } catch (err) {
    if (!(err instanceof ConfigFileError)) throw err;
  }
  const path = configPath();
  if (lastGood?.path === path) return lastGood.value.supervisorAgentId;
  return kanbanLeaderFromCopies(dirname(path));
}

/**
 * A fresh installation's first config file, from `seed`. False, without writing, when the file is there.
 * Throws ConfigFileError when the file is broken, or missing on a board that has had a config.
 * `db` is the handle being migrated, so its cards count as history.
 */
export function createConfigIfFresh(seed: () => Record<string, unknown>, db?: DatabaseSync): boolean {
  if (readConfigFile().state === "ok") return false;
  return withConfigLock(() => {
    const path = configPath();
    const read = readConfigFile(path);
    if (read.state === "ok") return false;
    if (read.state === "broken" || configuredBefore(path, db)) throw new ConfigFileError(describeProblem(path, read).message);
    mkdirSync(dataDir(), { recursive: true });
    // The example supplies the public defaults. seed() wins on keys it sets. setupPending asks the
    // settings page to confirm projects. An installation that already has a file never reaches here.
    const example = readExampleConfig() ?? {};
    const body = { ...example, language: FRESH_LANGUAGE, ...seed(), setupPending: true };
    writeConfigAtomic(`${JSON.stringify(body, null, 2)}\n`);
    return true;
  });
}

export function saveConfig(config: KanbanConfig): void {
  mkdirSync(dataDir(), { recursive: true });
  // A fresh installation's file can be created. One that is present but unreadable, or that went missing, must not be replaced.
  readConfigRaw();
  writeConfigAtomic(`${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Read the config file as JSON and write it back only when `mutate` returns true.
 * Keeps keys this parser does not model.
 * Throws ConfigFileError, without writing, when the file cannot be read or parsed, or went missing.
 */
export function updateConfigFile(mutate: (raw: Record<string, unknown>) => boolean): void {
  withConfigLock(() => {
    mkdirSync(dataDir(), { recursive: true });
    const raw = readConfigRaw();
    if (!mutate(raw)) return;
    writeConfigAtomic(`${JSON.stringify(raw, null, 2)}\n`);
  });
}

/** Missing project key means on. Decision B replaced the old default-off. */
export function projectAutoStart(project: string, config = loadConfig()): boolean {
  if (Object.prototype.hasOwnProperty.call(config.autoStart, project)) return config.autoStart[project] !== false;
  return true;
}

export function setProjectAutoStart(project: string, enabled: boolean): KanbanConfig {
  return withConfigLock(() => {
    const config = loadConfigForWrite();
    config.autoStart[project] = enabled;
    saveConfig(config);
    return config;
  });
}

export function setSupervisorAgentId(agentId: string | null): KanbanConfig {
  return withConfigLock(() => {
    const config = loadConfigForWrite();
    const next = agentId?.trim() || null;
    if (config.supervisorAgentId !== next) revokeLeaderMcpTokens(config.supervisorAgentId);
    config.supervisorAgentId = next;
    saveConfig(config);
    return config;
  });
}

export function projectSupervisor(project: string, config = loadConfig()): string | null {
  const id = config.supervisors[project];
  return id?.trim() ? id.trim() : null;
}

const DIR_DEFAULT: ProjectWorkspace = {
  defaultWorkspace: "dir",
  baseBranch: "main",
  worktreeLanes: 1,
  lanesEnabled: false,
  parallel: true,
};

/**
 * Effective project settings. A stored default of worktree is dir: new cards stay in the
 * directory unless the card itself says lane. The file value is left in place so the
 * project command and the startup log can still warn.
 */
export function projectWorkspace(project: string, config = loadConfig()): ProjectWorkspace {
  const stored = config.projects?.[project] ?? DIR_DEFAULT;
  return {
    ...(stored.backgroundWaitMaxMs !== undefined ? { backgroundWaitMaxMs: stored.backgroundWaitMaxMs } : {}),
    defaultWorkspace: stored.defaultWorkspace === "worktree" ? "dir" : stored.defaultWorkspace,
    baseBranch: stored.baseBranch,
    ...(stored.integrationBranches !== undefined ? { integrationBranches: [...stored.integrationBranches] } : {}),
    worktreeLanes: stored.worktreeLanes,
    lanesEnabled: stored.lanesEnabled === true,
    parallel: stored.parallel !== false,
    ...(stored.cloudRunner ? { cloudRunner: structuredClone(stored.cloudRunner) } : {}),
    ...(stored.qualification ? { qualification: structuredClone(stored.qualification) } : {}),
    ...(stored.alwaysTemp === true ? { alwaysTemp: true } : {}),
    ...(stored.waitParentPr === false ? { waitParentPr: false } : {}),
    ...(stored.code ? { code: stored.code } : {}),
  };
}

/** True unless this project has turned temporary worktrees off. Missing projects stay on. */
export function projectParallel(project: string, config = loadConfig()): boolean {
  return projectWorkspace(project, config).parallel !== false;
}

/** True only when this project always sends file-changing cards to a temporary worktree. Default off. */
export function projectAlwaysTemp(project: string, config = loadConfig()): boolean {
  return projectWorkspace(project, config).alwaysTemp === true;
}

/** Stored short code, or null when this project has not been given one yet. */
export function projectCode(project: string, config = loadConfig()): string | null {
  return config.projects?.[project]?.code ?? null;
}

/** Projects whose file still asks for a default worktree. Startup and `project` warn about these. */
export function retiredDefaultWorktreeProjects(config = loadConfig()): string[] {
  return Object.entries(config.projects ?? {})
    .filter(([, row]) => row.defaultWorkspace === "worktree")
    .map(([name]) => name)
    .sort();
}

/** Runs at plugin startup, so a lost config file must not stop the plugin from loading (DEMO_0001). */
export function logRetiredDefaultWorktrees(write: (line: string) => void = (line) => console.log(line), config = loadConfigForReport()): string[] {
  const names = retiredDefaultWorktreeProjects(config);
  for (const name of names) write(`[paseo-kanban] ${name}${t("common.colon")}${retiredDefaultWorktree()}`);
  return names;
}

export function listProjectWorkspaces(config = loadConfig()): Record<string, ProjectWorkspace> {
  return { ...(config.projects ?? {}) };
}

export function setProjectWorkspace(
  project: string,
  patch: {
    defaultWorkspace?: WorkspaceMode;
    baseBranch?: string;
    integrationBranches?: string[];
    worktreeLanes?: number;
    lanesEnabled?: boolean;
    parallel?: boolean;
    alwaysTemp?: boolean;
    waitParentPr?: boolean;
  },
): KanbanConfig {
  return withConfigLock(() => {
    const name = project.trim();
    if (!name) throw new KanbanError("invalid", t("config.emptyProject"));
    if (patch.defaultWorkspace === "worktree") throw new KanbanError("invalid", retiredDefaultWorktree());
    const config = loadConfigForWrite();
    const stored = config.projects?.[name];
    const current = projectWorkspace(name, config);
    const mode = patch.defaultWorkspace ?? stored?.defaultWorkspace ?? "dir";
    if (mode !== "dir" && mode !== "worktree") throw new KanbanError("invalid", t("config.workspaceOnlyDir"));
    const base = (patch.baseBranch ?? current.baseBranch).trim();
    if (!branchNameOk(base)) throw new KanbanError("invalid", t("config.badBaseBranch"));
    const integrations = integrationBranches(patch.integrationBranches === undefined ? current.integrationBranches : patch.integrationBranches, name);
    const lanes = patch.worktreeLanes ?? current.worktreeLanes;
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 32) throw new KanbanError("invalid", t("config.badLaneCount"));
    const lanesEnabled = patch.lanesEnabled ?? current.lanesEnabled;
    const parallel = patch.parallel ?? current.parallel !== false;
    const alwaysTemp = patch.alwaysTemp ?? current.alwaysTemp === true;
    const next: ProjectWorkspace = { defaultWorkspace: mode, baseBranch: base, worktreeLanes: lanes, lanesEnabled, parallel };
    if (integrations !== undefined) next.integrationBranches = integrations;
    if (stored?.code) next.code = stored.code;
    if (stored?.workspacePath) next.workspacePath = stored.workspacePath;
    if (stored?.backgroundWaitMaxMs !== undefined) next.backgroundWaitMaxMs = stored.backgroundWaitMaxMs;
    if (stored?.cloudRunner) next.cloudRunner = structuredClone(stored.cloudRunner);
    if (stored?.qualification) next.qualification = structuredClone(stored.qualification);
    if (alwaysTemp) next.alwaysTemp = true;
    if ((patch.waitParentPr ?? current.waitParentPr) === false) next.waitParentPr = false;
    config.projects = {
      ...(config.projects ?? {}),
      [name]: next,
    };
    saveConfig(config);
    return config;
  });
}

/** Change the short code people see. Sequence numbers stay put. The code cannot belong to another project. */
export function setProjectCode(project: string, code: string): KanbanConfig {
  return withConfigLock(() => {
    const name = project.trim();
    if (!name) throw new KanbanError("invalid", t("config.emptyProject"));
    const normalized = code.trim().toUpperCase();
    if (!isProjectCode(normalized)) throw new KanbanError("invalid", t("config.badCode"));
    const config = loadConfigForWrite();
    for (const [other, row] of Object.entries(config.projects ?? {})) {
      if (other !== name && row.code === normalized) throw new KanbanError("conflict", t("config.codeTaken", { code: normalized, project: other }));
    }
    const stored = config.projects?.[name];
    const current = projectWorkspace(name, config);
    config.projects = {
      ...(config.projects ?? {}),
      [name]: {
        defaultWorkspace: stored?.defaultWorkspace ?? "dir",
        ...(stored?.backgroundWaitMaxMs !== undefined ? { backgroundWaitMaxMs: stored.backgroundWaitMaxMs } : {}),
        ...(stored?.workspacePath ? { workspacePath: stored.workspacePath } : {}),
        ...(stored?.cloudRunner ? { cloudRunner: structuredClone(stored.cloudRunner) } : {}),
        baseBranch: current.baseBranch,
        ...(current.integrationBranches !== undefined ? { integrationBranches: [...current.integrationBranches] } : {}),
        worktreeLanes: current.worktreeLanes,
        lanesEnabled: current.lanesEnabled,
        parallel: current.parallel !== false,
        ...(current.alwaysTemp === true ? { alwaysTemp: true } : {}),
        ...(current.waitParentPr === false ? { waitParentPr: false } : {}),
        code: normalized,
      },
    };
    saveConfig(config);
    return config;
  });
}

/** A configured project's full name, from its full name or its short code (any case). Null when it is not configured. */
export function findConfiguredProject(project: string, config: KanbanConfig = loadConfig()): string | null {
  const name = project.trim();
  if (!name) return null;
  const projects = config.projects ?? {};
  if (Object.hasOwn(projects, name)) return name;
  const match = Object.entries(projects).find(([, row]) => row.code?.toUpperCase() === name.toUpperCase());
  return match ? match[0] : null;
}

function availableProjects(config: KanbanConfig): string {
  const available = Object.entries(config.projects ?? {}).map(([fullName, row]) => row.code ? `${fullName}${t("common.paren", { text: row.code })}` : fullName);
  return available.join(t("common.listSep")) || t("config.noProjects");
}

/** Supervisor registration only accepts configured project names or their short codes. */
export function resolveSupervisorProject(project: string, config: KanbanConfig = loadConfig()): string {
  const name = project.trim();
  if (!name) throw new KanbanError("invalid", t("config.emptyProject"));
  const found = findConfiguredProject(name, config);
  if (found) return found;
  assertConfigReadable();
  throw new KanbanError("invalid", t("config.unknownProject", { name, available: availableProjects(config) }));
}

/** Creating or backfilling a card needs a configured project, so a typo cannot open a new project. */
export function resolveConfiguredProject(project: string, action: string, config: KanbanConfig = loadConfig()): string {
  const name = project.trim();
  if (!name) throw new KanbanError("invalid", t("config.emptyProject"));
  const found = findConfiguredProject(name, config);
  if (found) return found;
  assertConfigReadable();
  throw new KanbanError(
    "invalid",
    t("config.unconfiguredProject", { name, action, available: availableProjects(config) }),
  );
}

export function setProjectSupervisor(project: string, agentId: string | null): KanbanConfig {
  return withConfigLock(() => {
    const config = loadConfigForWrite();
    const name = resolveSupervisorProject(project, config);
    const previous = projectSupervisor(name, config);
    const next = agentId?.trim() || null;
    if (previous !== next) revokeLeaderMcpTokens(previous);
    if (!next) delete config.supervisors[name];
    else config.supervisors[name] = next;
    saveConfig(config);
    return config;
  });
}

/** Family and ban rules for routing. Defaults when the board has no readable config (unit tests, a broken file with no copy in memory). */
export function fleetRules(): { families: Record<string, FamilyRule>; banned: BannedProfiles } {
  let config: KanbanConfig | null = null;
  try {
    config = loadConfigOrMemory();
  } catch {
    // No isolated data directory (a unit test) reads like no config: the defaults.
    config = null;
  }
  return { families: config?.families ?? parseFamilies(undefined), banned: config?.bannedProviders ?? parseBanned(undefined) };
}

export function roleLimit(limits: ConcurrencyLimits, role: string): number {
  return limits.roles[role] ?? 1;
}
