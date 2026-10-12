/// <reference types="node" />
// Settings page read/write. The file is kanban.config.json. A write is refused when the caller's
// revision is stale, when the file is broken, or when the document is not a valid edit. Unknown
// top-level keys are kept. A fresh data directory is seeded once, from the example, on read.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isProjectCode } from "../shared/card-code";
import { t } from "../shared/i18n";
import {
  thresholdLabel,
  INTEGER_THRESHOLD_KEYS,
  THRESHOLD_KEYS,
  type BannedSettings,
  type ProjectSettings,
  type SettingsDocument,
  type SettingsRead,
  type SettingsWrite,
  type ThresholdKey,
  type Thresholds,
} from "../shared/settings";
import {
  ConfigFileError,
  createConfigIfFresh,
  parseConfig,
  DEFAULT_ARCHIVE_DEADLINE_MS,
  DEFAULT_ARCHIVE_TIMEOUT_MS,
  DEFAULT_ARCHIVE_VERIFY_MS,
  DEFAULT_AUTO_ARCHIVE_AFTER_MS,
  DEFAULT_CLEANUP_CONCURRENCY,
  DEFAULT_LAND_CONFLICT_LIMIT,
  DEFAULT_LOGIN_BLIP_RETRY_MS,
  DEFAULT_MISSING_CWD_PATROL_MS,
  DEFAULT_NUDGE_GRACE_MS,
  DEFAULT_NUDGE_INTERVAL_MS,
  DEFAULT_PROGRESS_GRACE_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  DEFAULT_RESTART_STALL_GRACE_MS,
  DEFAULT_REWORK_REASSIGN_HOURS,
  DEFAULT_STALL_IDLE_MS,
  DEFAULT_STALL_INTERVAL_MS,
  DEFAULT_TRANSIENT_RETRY_LIMIT,
  DEFAULT_TRANSIENT_RETRY_MINUTES,
  isBaseBranch,
  LEGACY_LANGUAGE,
  configFileProblem,
  loadConfigForReport,
  type KanbanConfig,
  type ProjectWorkspace,
} from "./config";
import { configPath, writeConfigAtomic } from "./config-file";
import { withConfigLock } from "./config-lock";
import { applyServerLanguage, languageSetting } from "./language";
import { isProjectMain, type ListedWorkspace } from "./placement";

export type WorkspaceList = () => Promise<ListedWorkspace[]>;

const INTEGER_THRESHOLDS = new Set<ThresholdKey>(INTEGER_THRESHOLD_KEYS);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface ConfigSnapshot {
  raw: Record<string, unknown>;
  config: KanbanConfig;
  /** sha256 of the exact file bytes `config` was parsed from. */
  revision: string;
}

/**
 * The document and its revision from one read. A later read is a different pair: the revision is never
 * taken from a newer file than the document, so a save of this pair cannot overwrite that newer file.
 */
function readSnapshot(): ConfigSnapshot | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(configPath());
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  return { raw: parsed, config: parseConfig(parsed), revision: createHash("sha256").update(bytes).digest("hex") };
}

/** Paseo project workspaces that this board does not configure yet. Worktrees and archived rows are skipped. */
export function candidateProjects(listed: readonly ListedWorkspace[], configured: ReadonlySet<string>): Array<{ name: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; path: string }> = [];
  for (const entry of listed) {
    if (!isProjectMain(entry)) continue;
    const root = entry.projectRoot?.trim() ?? "";
    const name = basename(root);
    if (!name || name === "." || name === ".." || seen.has(name) || configured.has(name)) continue;
    seen.add(name);
    out.push({ name, path: root });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function thresholdsOf(config: KanbanConfig): Thresholds {
  return {
    archiveTimeoutMs: config.archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS,
    cleanupConcurrency: config.cleanupConcurrency ?? DEFAULT_CLEANUP_CONCURRENCY,
    archiveVerifyMs: config.archiveVerifyMs ?? DEFAULT_ARCHIVE_VERIFY_MS,
    reconcileIntervalMs: config.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    stallIntervalMs: config.stallIntervalMs ?? DEFAULT_STALL_INTERVAL_MS,
    stallIdleMs: config.stallIdleMs ?? DEFAULT_STALL_IDLE_MS,
    nudgeGraceMs: config.nudgeGraceMs ?? DEFAULT_NUDGE_GRACE_MS,
    loginBlipRetryMs: config.loginBlipRetryMs ?? DEFAULT_LOGIN_BLIP_RETRY_MS,
    transientRetryMinutes: config.transientRetryMinutes ?? DEFAULT_TRANSIENT_RETRY_MINUTES,
    transientRetryLimit: config.transientRetryLimit ?? DEFAULT_TRANSIENT_RETRY_LIMIT,
    landConflictLimit: config.landConflictLimit ?? DEFAULT_LAND_CONFLICT_LIMIT,
    reworkReassignHours: config.reworkReassignHours ?? DEFAULT_REWORK_REASSIGN_HOURS,
    progressGraceMs: config.progressGraceMs ?? DEFAULT_PROGRESS_GRACE_MS,
    nudgeIntervalMs: config.nudgeIntervalMs ?? DEFAULT_NUDGE_INTERVAL_MS,
    restartStallGraceMs: config.restartStallGraceMs ?? DEFAULT_RESTART_STALL_GRACE_MS,
    autoArchiveAfterMs: config.autoArchiveAfterMs ?? DEFAULT_AUTO_ARCHIVE_AFTER_MS,
    archiveDeadlineMs: config.archiveDeadlineMs ?? DEFAULT_ARCHIVE_DEADLINE_MS,
    missingCwdPatrolMs: config.missingCwdPatrolMs ?? DEFAULT_MISSING_CWD_PATROL_MS,
  };
}

function projectRow(name: string, row: ProjectWorkspace, config: KanbanConfig): ProjectSettings {
  return {
    code: row.code ?? "",
    baseBranch: row.baseBranch,
    defaultWorkspace: row.defaultWorkspace,
    worktreeLanes: row.worktreeLanes,
    lanesEnabled: row.lanesEnabled === true,
    parallel: row.parallel !== false,
    alwaysTemp: row.alwaysTemp === true,
    waitParentPr: row.waitParentPr !== false,
    autoStart: config.autoStart[name] !== false,
  };
}

function toDocument(config: KanbanConfig): SettingsDocument {
  const projects: SettingsDocument["projects"] = {};
  for (const [name, row] of Object.entries(config.projects ?? {})) projects[name] = projectRow(name, row, config);
  const families: SettingsDocument["families"] = {};
  for (const [name, rule] of Object.entries(config.families ?? {})) {
    families[name] = {
      providers: [...rule.providers],
      modelPrefixes: [...rule.modelPrefixes],
      noFast: rule.noFast,
      noUltra: rule.noUltra,
      requirePoolSeen: rule.requirePoolSeen,
    };
  }
  const banned = config.bannedProviders;
  return {
    language: config.language ?? LEGACY_LANGUAGE,
    projects,
    concurrency: {
      global: config.concurrency.global,
      pools: { ...config.concurrency.pools },
      roles: { ...config.concurrency.roles },
    },
    staleStopPct: { ...(config.staleStopPct ?? {}) },
    thresholds: thresholdsOf(config),
    families,
    bannedProviders: {
      providers: [...(banned?.providers ?? [])],
      families: [...(banned?.families ?? [])],
      pools: [...(banned?.pools ?? [])],
      models: [...(banned?.models ?? [])],
    },
    disabledPools: [...(config.disabledPools ?? [])],
  };
}

function viewFromConfig(config: KanbanConfig, revision: string, extras: Pick<SettingsRead, "candidates" | "candidatesNote">, env: NodeJS.ProcessEnv): SettingsRead {
  const stored = config.language ?? LEGACY_LANGUAGE;
  const language = languageSetting(config, env);
  return {
    language,
    revision,
    needsSetup: config.setupPending === true,
    problem: null,
    envOverride: language !== stored,
    candidatesNote: extras.candidatesNote,
    candidates: extras.candidates,
    leaders: Object.entries(config.supervisors)
      .map(([project, agentId]) => ({ project, agentId }))
      .sort((a, b) => a.project.localeCompare(b.project)),
    fallbackLeader: config.supervisorAgentId,
    document: toDocument(config),
  };
}

function unavailable(language: SettingsRead["language"], problem: string): SettingsRead {
  return {
    language,
    revision: "",
    needsSetup: false,
    problem,
    envOverride: false,
    candidatesNote: null,
    candidates: [],
    leaders: [],
    fallbackLeader: null,
    document: null,
  };
}

/** Read the settings document. Seeds a fresh directory from the example. Never replaces a file that is already there. */
export async function readSettings(list: WorkspaceList, env: NodeJS.ProcessEnv = process.env): Promise<SettingsRead> {
  let blocked: string | null = null;
  try {
    createConfigIfFresh(() => ({}));
  } catch (err) {
    if (!(err instanceof ConfigFileError)) throw err;
    blocked = err.message;
  }
  // Snapshot before the workspace list. The list waits on Paseo, and the file may change meanwhile.
  // Candidates are allowed to be newer than the document; the document and its revision are not.
  const shot = readSnapshot();
  if (!shot) {
    const reported = loadConfigForReport();
    return unavailable(languageSetting(reported, env), blocked ?? configFileProblem()?.message ?? t("settings.error.broken"));
  }
  const configured = new Set(Object.keys(shot.config.projects ?? {}));
  let candidates: SettingsRead["candidates"] = [];
  let candidatesNote: string | null = null;
  try {
    candidates = candidateProjects(await list(), configured);
  } catch (err) {
    console.error("[paseo-kanban] settings workspace list failed", err instanceof Error ? err.message : err);
    candidatesNote = t("settings.candidates.unavailable");
  }
  return viewFromConfig(shot.config, shot.revision, { candidates, candidatesNote }, env);
}

function nameOk(name: string): boolean {
  return name.length > 0 && name.length <= 200 && name.trim() === name && !/[\u0000-\u001f\\/]/.test(name);
}

function whole(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min && value <= Number.MAX_SAFE_INTEGER;
}

function cleanStrings(values: string[]): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    if (!nameOk(trimmed)) return null;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function numberMap(values: Record<string, number>, min: number, label: string): Record<string, number> | string {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(values)) {
    const key = name.trim();
    if (!nameOk(key)) return t("settings.error.poolName");
    if (!whole(value, min)) return t("settings.error.number", { name: `${label} ${key}` });
    out[key] = value;
  }
  return out;
}

function previousMode(raw: Record<string, unknown>, name: string): string | undefined {
  if (!isObject(raw.projects) || !isObject(raw.projects[name])) return undefined;
  const mode = raw.projects[name].defaultWorkspace;
  return typeof mode === "string" ? mode : undefined;
}

function validate(raw: Record<string, unknown>, document: SettingsDocument): string | null {
  if (document.language !== "en" && document.language !== "zh-CN" && document.language !== "system") return t("settings.error.language");
  if (!whole(document.concurrency.global, 1)) return t("settings.error.global");
  const pools = numberMap(document.concurrency.pools, 0, t("settings.concurrency.pools"));
  if (typeof pools === "string") return pools;
  const roles = numberMap(document.concurrency.roles, 0, t("settings.concurrency.roles"));
  if (typeof roles === "string") return roles;
  for (const [name, value] of Object.entries(document.staleStopPct)) {
    const key = name.trim();
    if (!nameOk(key)) return t("settings.error.poolName");
    if (!Number.isFinite(value) || value < 0 || value > 100) return t("settings.error.percent", { name: key });
  }
  for (const key of THRESHOLD_KEYS) {
    const value = document.thresholds[key];
    if (INTEGER_THRESHOLDS.has(key)) {
      if (!whole(value, 1)) return t("settings.error.count", { name: thresholdLabel(key) });
    } else if (!Number.isFinite(value) || value <= 0) {
      return t("settings.error.positive", { name: thresholdLabel(key) });
    }
  }
  const codes = new Map<string, string>();
  for (const [name, row] of Object.entries(document.projects)) {
    if (!nameOk(name)) return t("settings.error.name");
    const code = row.code.trim().toUpperCase();
    if (code && !isProjectCode(code)) return t("settings.error.code", { project: name });
    if (code) {
      const owner = codes.get(code);
      if (owner) return t("settings.error.codeTaken", { code, project: owner });
      codes.set(code, name);
    }
    if (!isBaseBranch(row.baseBranch.trim())) return t("settings.error.branch", { project: name });
    if (!whole(row.worktreeLanes, 1) || row.worktreeLanes > 32) return t("settings.error.lanes", { project: name });
    if (row.defaultWorkspace === "worktree" && previousMode(raw, name) !== "worktree") return t("settings.error.worktree", { project: name });
    if (row.defaultWorkspace !== "dir" && row.defaultWorkspace !== "worktree") return t("settings.error.worktree", { project: name });
  }
  for (const [name, rule] of Object.entries(document.families)) {
    if (!nameOk(name.trim())) return t("settings.error.poolName");
    if (!cleanStrings(rule.providers) || !cleanStrings(rule.modelPrefixes)) return t("settings.error.poolName");
  }
  const bannedLists = [document.bannedProviders.providers, document.bannedProviders.families, document.bannedProviders.pools, document.bannedProviders.models, document.disabledPools];
  for (const list of bannedLists) {
    if (!cleanStrings(list)) return t("settings.error.poolName");
  }
  return null;
}

function trimmedMap(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name.trim(), value]));
}

function trimmedBanned(banned: BannedSettings): BannedSettings {
  return {
    providers: cleanStrings(banned.providers) ?? [],
    families: cleanStrings(banned.families) ?? [],
    pools: cleanStrings(banned.pools) ?? [],
    models: cleanStrings(banned.models) ?? [],
  };
}

function mergeProject(prev: Record<string, unknown>, row: ProjectSettings): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev };
  next.defaultWorkspace = row.defaultWorkspace;
  next.baseBranch = row.baseBranch.trim();
  next.worktreeLanes = row.worktreeLanes;
  next.lanesEnabled = row.lanesEnabled;
  next.parallel = row.parallel;
  if (row.alwaysTemp) next.alwaysTemp = true;
  else delete next.alwaysTemp;
  if (row.waitParentPr) delete next.waitParentPr;
  else next.waitParentPr = false;
  const code = row.code.trim().toUpperCase();
  if (code) next.code = code;
  else delete next.code;
  return next;
}

function applyDocument(raw: Record<string, unknown>, document: SettingsDocument): void {
  raw.language = document.language;
  delete raw.setupPending;
  raw.concurrency = {
    global: document.concurrency.global,
    pools: trimmedMap(document.concurrency.pools),
    roles: trimmedMap(document.concurrency.roles),
  };
  raw.staleStopPct = trimmedMap(document.staleStopPct);
  for (const key of THRESHOLD_KEYS) raw[key] = document.thresholds[key];
  const families: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(document.families)) {
    families[name.trim()] = {
      providers: cleanStrings(rule.providers),
      modelPrefixes: cleanStrings(rule.modelPrefixes),
      noFast: rule.noFast,
      noUltra: rule.noUltra,
      requirePoolSeen: rule.requirePoolSeen,
    };
  }
  raw.families = families;
  raw.bannedProviders = trimmedBanned(document.bannedProviders);
  raw.disabledPools = cleanStrings(document.disabledPools);
  raw.autoStart = Object.fromEntries(Object.entries(document.projects).map(([name, row]) => [name, row.autoStart]));
  const previous = isObject(raw.projects) ? raw.projects : {};
  const projects: Record<string, unknown> = {};
  for (const [name, row] of Object.entries(document.projects)) {
    const prior = isObject(previous[name]) ? previous[name] : {};
    projects[name] = mergeProject(prior, row);
  }
  raw.projects = projects;
  if (isObject(raw.supervisors)) {
    for (const name of Object.keys(raw.supervisors)) {
      if (!Object.hasOwn(document.projects, name)) delete raw.supervisors[name];
    }
  }
}

interface Commit {
  ok: boolean;
  conflict: boolean;
  message: string;
}

function commitDocument(revision: string, document: SettingsDocument): Commit {
  return withConfigLock(() => {
    const shot = readSnapshot();
    if (!shot) {
      return { ok: false, conflict: false, message: configFileProblem()?.message ?? t("settings.error.broken") };
    }
    if (shot.revision !== revision) return { ok: false, conflict: true, message: t("settings.conflict") };
    const invalid = validate(shot.raw, document);
    if (invalid) return { ok: false, conflict: false, message: invalid };
    const next = structuredClone(shot.raw);
    applyDocument(next, document);
    writeConfigAtomic(`${JSON.stringify(next, null, 2)}\n`);
    applyServerLanguage();
    return { ok: true, conflict: false, message: t("settings.saved") };
  });
}

/** Write the document when `revision` matches the file. A mismatch or a bad document leaves the file as it was. */
export async function writeSettings(input: { revision: string; document: SettingsDocument }, list: WorkspaceList, env: NodeJS.ProcessEnv = process.env): Promise<SettingsWrite> {
  const outcome = commitDocument(input.revision, input.document);
  const view = await readSettings(list, env);
  return { ...view, ok: outcome.ok, conflict: outcome.conflict, message: outcome.message };
}
