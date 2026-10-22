/// <reference types="node" />
import { paseoProjectsReadAt, removedProjects } from "./paseo-projects";
import { LANGUAGES, t, translate, type MessageKey } from "../shared/i18n";
import { leaderActionNote } from "./protocol";
import { tightenFile } from "./data-perms";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "./perf-fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { blockedKindLabel, isBlockedKind, isQuotaWaitReason } from "../shared/blocked";
import { cardDecisions, type DecisionView } from "../shared/decisions";
import { formatTickTime } from "../shared/scheduler";
import type { DatabaseSync } from "node:sqlite";
import { isAgentAlive } from "./alive";
import { deliverWake, hasWakeSender } from "./bus";
import { cardMarkOf } from "./card-ref";
import { CARD_WORK_DIR } from "./card-tmp";
import { DEFAULT_ARCHIVE_DEADLINE_MS, doctorSettings, kanbanLeaderForAlarm, loadConfigForReport, projectWorkspace, type DoctorSettings } from "./config";
import { checkConfigFile, checkDataDir, checkProjectCodes } from "./doctor-config";
import { checkMigration } from "./doctor-migration";
import { getReadOnlyDb } from "./db";
import { readOpenDecisions } from "./decisions";
import type { CockpitHealth, ContractHealth } from "./afc-sources";
import { STALE_FACTOR } from "./contract";
import { isLaneDirectory, isLaneWorkspace } from "./lane-mark";
import { agentCwdMissing } from "./missing-cwd";
import { tmpCleanupProblems, tmpNamesFor } from "./tmp-cleanup";
import { realDispatchMatrixPath } from "./matrix";
import { dataDir } from "./paths";
import { stableBinFinding } from "./stable-bin";
import { samePath } from "./placement";
import { currentCleanupSql } from "./cleanup-state";
import { integrationBranchContaining } from "./integration-branches";
import { runGit } from "./git";
import { recordedPlaceholderError, recordedPlaceholderPaths } from "./placeholder-cleanup";
import { capacityAlertSuppressId, capacityFindings, markCapacityLeaderAlerted, refreshCapacityGuard } from "./capacity-guard";

export const DOCTOR_REPORT_FILE = "doctor-report.json";

export type DoctorSeverity = "red" | "yellow" | "info";

export type DoctorCheck = "workspace" | "worktree" | "branch" | "directory" | "agent" | "card" | "board";

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  check: DoctorCheck;
  project: string | null;
  card: string | null;
  taskId: number | null;
  object: string;
  symptom: string;
  evidence: string;
  suggestion: string;
}

export interface DoctorReport {
  at: string;
  durationMs: number;
  timedOut: boolean;
  counts: { red: number; yellow: number; info: number };
  findings: DoctorFinding[];
  /** Red finding ids already sent. Kept until a finished check confirms that object is gone. */
  alertedIds: string[];
  /** When the scheduler last ran this. A manual run does not move it. */
  schedulerAt?: string | null;
}

export interface DoctorWorkspace {
  id: string;
  name: string | null;
  directory: string | null;
  projectRoot: string | null;
  kind: string;
  archived: boolean;
}

export interface DoctorAgent {
  id: string;
  archived: boolean;
  title?: string | null;
  cwd?: string | null;
  workspaceId?: string | null;
  labels?: Record<string, string>;
  /** Paseo status, such as idle or running. Missing means the clock is unknown. */
  status?: string | null;
  idleSince?: string | null;
}

export interface DoctorAgentSource {
  agents: DoctorAgent[];
  /**
   * Ids on Paseo's active list. When set, a running card whose agent is absent
   * here and not a live record is reported. Omit when the list could not be read.
   */
  paseoIds?: string[];
  error?: string;
}

export interface DoctorWorktree {
  path: string;
  branch: string | null;
  /** Set when `git worktree list --porcelain` marks the entry prunable. */
  prunable?: boolean;
}

export type DoctorPr = "merged" | "open" | "closed" | "none" | "unknown";

/** A merged PR only covers the worktree when headOid is the current local tip. */
export type DoctorPrResult = DoctorPr | { state: DoctorPr; headOid?: string | null };

export interface DoctorGit {
  repos: string[];
  worktrees(repo: string): Promise<DoctorWorktree[]>;
  dirty(path: string): Promise<boolean | "unknown">;
  branches(repo: string): Promise<string[]>;
  /**
   * True only when the local branch tip and the remote tip are the same commit.
   * A remote branch that merely exists is not pushed.
   */
  pushed(repo: string, branch: string): Promise<boolean | "unknown">;
  /** Local tip. Absent on older fakes; a merged PR then cannot be proved from headOid. */
  tip?(repo: string, branch: string): Promise<string | "unknown">;
  pr(repo: string, branch: string): Promise<DoctorPrResult>;
}

export interface DoctorDirs {
  root: string;
  /** Immediate children of project buckets under the worktrees root. Exclude the buckets and deeper descendants. */
  list(): string[];
  /** Null when the directory is not a placeholder. Empty means a placeholder with no named agent. `"unknown"` means the file could not be read. */
  placeholderAgents(dir: string): string[] | null | "unknown";
  /** Paths from `git worktree list` that live under the root. */
  worktrees: string[];
  /** False when the tree was not walked. An empty list is then not proof it is clean. */
  scanned?: boolean;
  /** Set when the root listing itself failed. */
  scanError?: string;
  /** Directories whose children or placeholder file were not read. Alerts under these stay. */
  unread?: string[];
}

export interface DoctorBoard {
  plugin: "running" | "stopped" | "unknown";
  quota: "fresh" | "stale" | "missing" | "unknown";
  quotaAgeMs: number | null;
  matrix: "ok" | "stale" | "missing" | "invalid" | "unknown";
  matrixAgeMs: number | null;
  tickAt: string | null;
  missingCwdCount: number | "unknown";
  /** The cockpit's contract exports. Missing on a hand-built board: no contract findings then. */
  contracts?: CockpitHealth;
  /** The combined runtime admits work only through its immutable policy. */
  policyRequired?: boolean;
}

export interface DoctorSources {
  workspaces?: DoctorWorkspace[];
  workspaceError?: string;
  agents?: DoctorAgentSource;
  git?: DoctorGit;
  dirs?: DoctorDirs;
  board?: DoctorBoard;
  /** Set when listing repos stopped early. Not a pass. */
  collectError?: string;
  /** Configured project checkouts that could not be opened. */
  missingRepos?: Array<{ project: string; path: string }>;
  /** Confirmed ENOENT checkouts with no unfinished cards. These do not block scanning. */
  skippedRepos?: Array<{ project: string; path: string }>;
}

export interface DoctorRunInput {
  now?: Date;
  settings?: DoctorSettings;
  sources?: DoctorSources;
  /** Read-only decisions source override for isolated fixtures. Read afresh on every run. */
  decisionsPath?: string;
  /** Scheduler sets this. A manual run only reports. */
  wake?: boolean;
  /** Write the latest report so `doctor --last` can show it. */
  persist?: boolean;
  /** Wall clock for the total deadline. Tests inject a fake one so a timeout does not depend on machine load. */
  clock?: () => number;
}

interface DocTask {
  id: number;
  project: string;
  title: string;
  status: string;
  role: string;
  code_seq: number | null;
  workspace_path: string | null;
  workspace_kind: string | null;
  paseo_workspace_id: string | null;
  agent_id: string | null;
  executor_agent_id: string | null;
  blocked_kind: string | null;
  blocked_reason: string | null;
  blocked_at: string | null;
  scheduled_until: string | null;
  hold_reason: string | null;
  updated_at: string;
  created_at: string;
}

interface DocEvent {
  id: number;
  task_id: number;
  at: string;
  kind: string;
  to_status: string | null;
  data_json: string;
}

interface DocRun {
  task_id: number;
  agent_id: string;
  role: string;
  ended_at: string | null;
}

const SEVERITY_ORDER: Record<DoctorSeverity, number> = { red: 0, yellow: 1, info: 2 };

/**
 * Hold reasons that mean a ready card is queued on purpose (waiting for the user, concurrency, quota,
 * auto-start queue, same working directory, snapshot, lanes disabled). Other files write these texts into
 * the database, so old rows hold the Chinese wording: those stay as \u escapes. Texts with a catalog key
 * are matched in both languages; the rest have English literal alternatives.
 */
const LEGACY_NORMAL_HOLD = [
  "\u7b49\u7528\u6237\uff1a", // waiting for user + full-width colon
  "\u5e76\u53d1\u5df2\u6ee1", // concurrency full
  "\u989d\u5ea6", // quota
  "\u7b49\u5f85\u81ea\u52a8\u5f00\u5de5", // waiting to start automatically
  "\u540c\u4e00\u5de5\u4f5c\u76ee\u5f55", // same working directory
  "\u5feb\u7167", // snapshot
  "\u6b64\u9879\u76ee\u672a\u542f\u7528\u5e76\u884c\u5de5\u4f5c\u533a", // parallel workspaces are disabled for this project
];
/** Fragments of the English hold texts the scheduler and dispatch write (schedule.*, routing.poolFull, pools.*). */
const ENGLISH_NORMAL_HOLD = ["concurrency is full", "quota", "same working directory", "snapshot"];

let normalHoldPattern: RegExp | null = null;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Built on first use (never at import, the language is not set yet) from both catalogs, so it is the same in either language. */
function normalHoldRegExp(): RegExp {
  if (normalHoldPattern) return normalHoldPattern;
  const keyed = LANGUAGES.flatMap((language) => [
    translate(language, "waitUser.hold", { decision: "" }),
    translate(language, "config.lanesDisabled").split(/[:\uff1a]/)[0] ?? "",
    translate(language, "schedule.waitingAutoStart", { reason: "" }),
  ]).filter((text) => text.trim() !== "");
  const parts = [...new Set([...LEGACY_NORMAL_HOLD, ...keyed, ...ENGLISH_NORMAL_HOLD])].map(escapeRegExp);
  normalHoldPattern = new RegExp(parts.join("|"), "i");
  return normalHoldPattern;
}

export function doctorReportPath(): string {
  return resolve(dataDir(), DOCTOR_REPORT_FILE);
}

export function readLastDoctorReport(): DoctorReport | null {
  try {
    const raw = JSON.parse(readFileSync(doctorReportPath(), "utf8")) as DoctorReport;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.findings)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function doctorAuditLine(report: DoctorReport | null = readLastDoctorReport()): string {
  if (!report) return t("doctor.auditLine.none");
  const red = report.counts?.red ?? 0;
  const yellow = report.counts?.yellow ?? 0;
  return t("doctor.auditLine", { red, yellow, time: formatTickTime(report.at) });
}

export function formatDoctor(report: DoctorReport): string {
  const head = t("doctor.format.head", { time: formatTickTime(report.at), red: report.counts.red, yellow: report.counts.yellow, info: report.counts.info, unfinished: report.timedOut ? t("doctor.format.unfinished") : "" });
  if (report.findings.length === 0) return `${head}\n${t("doctor.format.none")}`;
  const lines = [head];
  for (const finding of report.findings) {
    const where = [finding.card, finding.project].filter(Boolean).join(" · ");
    lines.push("");
    lines.push(`[${finding.severity}] ${where ? `${where} · ` : ""}${finding.check} ${finding.object}`);
    lines.push(finding.symptom);
    lines.push(t("doctor.format.evidence", { text: finding.evidence }));
    lines.push(t("doctor.format.suggestion", { text: finding.suggestion }));
  }
  return lines.join("\n");
}

/** `git worktree list --porcelain` records. Detached entries have a null branch. */
export function parseWorktreePorcelain(text: string): DoctorWorktree[] {
  const out: DoctorWorktree[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  let prunable = false;
  const flush = () => {
    if (path) out.push(prunable ? { path, branch, prunable: true } : { path, branch });
    path = null;
    branch = null;
    prunable = false;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached") branch = null;
    else if (line.startsWith("prunable")) prunable = true;
  }
  flush();
  return out;
}

/** Temp path for one report write. Pid, time, and a random suffix keep concurrent writers apart. */
export function doctorReportSidecar(file = doctorReportPath(), pid = process.pid): string {
  return `${file}.${pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function writeReport(report: DoctorReport): void {
  const file = doctorReportPath();
  const tmp = doctorReportSidecar(file);
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    tightenFile(file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file was never created, or another writer already removed it.
    }
    console.error("[paseo-kanban] doctor report", err instanceof Error ? err.message : err);
  }
}

function countsOf(findings: DoctorFinding[]): DoctorReport["counts"] {
  return {
    red: findings.filter((item) => item.severity === "red").length,
    yellow: findings.filter((item) => item.severity === "yellow").length,
    info: findings.filter((item) => item.severity === "info").length,
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t("doctor.timeout"))), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function unfinished(status: string): boolean {
  return status !== "done" && status !== "archived";
}

function finished(status: string): boolean {
  return status === "done" || status === "archived";
}

function parseData(text: string): Record<string, unknown> {
  try {
    const data = JSON.parse(text) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadTasks(db: DatabaseSync): DocTask[] {
  return db.prepare(
    `SELECT id, project, title, status, role, code_seq, workspace_path, workspace_kind,
            paseo_workspace_id, agent_id, executor_agent_id, blocked_kind, blocked_reason, blocked_at, scheduled_until,
            hold_reason, updated_at, created_at
     FROM tasks ORDER BY id`,
  ).all() as unknown as DocTask[];
}

/** Latest cleanup row per action and object. A later success replaces an older failure. */
function loadEvents(db: DatabaseSync): DocEvent[] {
  const rows = db.prepare(
    `SELECT id, task_id, at, kind, to_status, data_json FROM events
     WHERE (kind IN (
       'worktree_created', 'temp_workspace', 'workspace_bound', 'cleanup_finished',
       'temp_workspace_cleaned', 'land_pending', 'landed', 'land_settled', 'lane_bound',
       'agent_creating', 'agent_recover_ambiguous',
       'card_tmp_prepared', 'tmp_cleanup_failed', 'tmp_cleaned'
     ) OR to_status IN ('acceptance', 'done', 'archived'))
     AND (kind NOT IN ('cleanup_finished', 'temp_workspace_cleaned') OR ${currentCleanupSql("events", "events.task_id")})
     ORDER BY id`,
  ).all() as unknown as DocEvent[];
  const openCleanup = `(SELECT id FROM tasks
     WHERE status IN ('done', 'archived')
     AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.kind = 'cleanup_finished' AND ${currentCleanupSql("e", "tasks.id")}))`;
  const latest = db.prepare(
    `SELECT id, task_id, at, kind, to_status, data_json FROM events
     WHERE kind = 'cleanup' AND task_id IN ${openCleanup}
     AND ${currentCleanupSql("events", "events.task_id")}
     AND id IN (
       SELECT MAX(id) FROM events
       WHERE kind = 'cleanup' AND task_id IN ${openCleanup}
       AND ${currentCleanupSql("events", "events.task_id")}
       GROUP BY task_id,
         COALESCE(json_extract(data_json, '$.action'), ''),
         COALESCE(
           NULLIF(json_extract(data_json, '$.agentId'), ''),
           NULLIF(json_extract(data_json, '$.directory'), ''),
           NULLIF(json_extract(data_json, '$.workspaceId'), ''),
           NULLIF(json_extract(data_json, '$.reason'), ''),
           ''
         )
     )
     ORDER BY id`,
  ).all() as unknown as DocEvent[];
  rows.push(...latest);
  return rows;
}

/** One doctor's event index and lane database. Not shared with another overlapping run. */
interface DoctorScan {
  events: Map<number, DocEvent[]>;
  laneDb: DatabaseSync | null;
}

function indexEvents(events: DocEvent[]): Map<number, DocEvent[]> {
  const eventIndex = new Map<number, DocEvent[]>();
  for (const event of events) {
    const list = eventIndex.get(event.task_id);
    if (list) list.push(event);
    else eventIndex.set(event.task_id, [event]);
  }
  return eventIndex;
}

function taskEvents(scan: DoctorScan, taskId: number): DocEvent[] {
  return scan.events.get(taskId) ?? [];
}

function loadAgentRuns(db: DatabaseSync): DocRun[] {
  return db.prepare(
    `SELECT task_id, agent_id, role, ended_at FROM runs WHERE agent_id IS NOT NULL ORDER BY id`,
  ).all() as unknown as DocRun[];
}

/** Sha of `refs/heads/<branch>` in `git ls-remote` output, or null when that head is absent. */
export function remoteTipFromLs(stdout: string, branch: string): string | null {
  const want = `refs/heads/${branch}`;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/);
    if (ref === want && /^[0-9a-f]{7,64}$/i.test(sha ?? "")) return sha;
  }
  return null;
}

function ownsBranch(task: DocTask, branch: string): boolean {
  if (!branch.startsWith("kanban/") || branch.includes("..") || branch.startsWith("-")) return false;
  if (branch.startsWith(`kanban/${task.id}-`)) return true;
  const mark = cardMarkOf(task);
  if (mark.startsWith("#")) return false;
  return branch.startsWith(`kanban/${mark}-`);
}

function lane(scan: DoctorScan, workspaceId: string | null | undefined, directory?: string | null): boolean {
  if (isLaneDirectory(directory)) return true;
  if (!scan.laneDb) return false;
  return isLaneWorkspace(workspaceId, directory, scan.laneDb);
}

function markOf(task: DocTask): string {
  return cardMarkOf(task);
}

function ageMs(at: string | null | undefined, now: number): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return now - ms;
}

function underRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function ancestor(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function cleanupClosed(scan: DoctorScan, taskId: number): boolean {
  return taskEvents(scan, taskId).some((event) => event.kind === "cleanup_finished" || event.kind === "temp_workspace_cleaned");
}

function keptBranch(scan: DoctorScan, taskId: number): boolean {
  const rows = taskEvents(scan, taskId).filter((event) => event.kind === "temp_workspace_cleaned");
  const last = rows.at(-1);
  if (!last) return false;
  return parseData(last.data_json).keptBranch === true;
}

function finishedStamp(scan: DoctorScan, task: DocTask): number | null {
  const rows = taskEvents(scan, task.id).filter((event) => event.to_status === "done" || event.to_status === "archived");
  const last = rows.at(-1);
  return ageMs(last?.at ?? task.updated_at, 0) === null ? null : Date.parse(last?.at ?? task.updated_at);
}

function graceActive(scan: DoctorScan, task: DocTask, now: number, graceMs: number): boolean {
  if (!finished(task.status) || cleanupClosed(scan, task.id)) return false;
  const at = finishedStamp(scan, task);
  if (at == null || !Number.isFinite(at)) return false;
  return now - at < graceMs;
}

interface BoundPlace {
  workspaceId: string | null;
  directory: string | null;
}

function boundPlaces(scan: DoctorScan, taskId: number): BoundPlace[] {
  const places: BoundPlace[] = [];
  for (const event of taskEvents(scan, taskId)) {
    if (event.kind !== "workspace_bound" && event.kind !== "worktree_created" && event.kind !== "temp_workspace") continue;
    const data = parseData(event.data_json);
    if (data.discarded === true) continue;
    const workspaceId = typeof data.workspaceId === "string" && data.workspaceId ? data.workspaceId : null;
    const directory = typeof data.directory === "string" && data.directory ? data.directory : null;
    if (!workspaceId && !directory) continue;
    places.push({ workspaceId, directory });
  }
  return places;
}

function distinctIds(places: BoundPlace[]): string[] {
  const ids: string[] = [];
  for (const place of places) {
    if (!place.workspaceId) continue;
    if (!ids.includes(place.workspaceId)) ids.push(place.workspaceId);
  }
  return ids;
}

function distinctDirs(places: BoundPlace[]): string[] {
  const dirs: string[] = [];
  for (const place of places) {
    if (!place.directory) continue;
    if (dirs.some((dir) => samePath(dir, place.directory))) continue;
    dirs.push(place.directory);
  }
  return dirs;
}

function taskOwnsPath(scan: DoctorScan, task: DocTask, events: DocEvent[], path: string, branch: string | null): boolean {
  if (task.workspace_path && samePath(task.workspace_path, path)) return true;
  if (boundPlaces(scan, task.id).some((place) => place.directory && samePath(place.directory, path))) return true;
  if (branch && ownsBranch(task, branch)) return true;
  return false;
}

/** Directory names that mean this card, including the lower-case, hyphenated and compact aliases. */
function cardDirNames(task: DocTask): string[] {
  const mark = cardMarkOf(task);
  if (mark.startsWith("#")) return [];
  return tmpNamesFor(mark);
}

function insideDir(parent: string, child: string): boolean {
  return samePath(parent, child) || ancestor(parent, child);
}

/** Latest recorded card temp root whose directory name is this card. A root of `/` is ignored. */
function preparedTmpPath(scan: DoctorScan, task: DocTask): string | null {
  const names = new Set(cardDirNames(task));
  if (names.size === 0) return null;
  const rows = taskEvents(scan, task.id).filter((event) => event.kind === "card_tmp_prepared");
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = parseData(rows[i].data_json).path;
    if (typeof value !== "string" || !isAbsolute(value)) continue;
    const root = resolve(value);
    if (root === resolve(sep) || !names.has(basename(root))) continue;
    return root;
  }
  return null;
}

/** Deepest `.kanban-work/<card>/` prefix of `path` for this card, in any project. */
function conventionalTmpRoot(task: DocTask, path: string): string | null {
  const names = new Set(cardDirNames(task));
  if (names.size === 0) return null;
  const parts = resolve(path).split(sep);
  let best: string | null = null;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] !== CARD_WORK_DIR || !names.has(parts[i + 1] ?? "")) continue;
    const root = parts.slice(0, i + 2).join(sep) || sep;
    if (root === resolve(sep)) continue;
    if (!best || root.length > best.length) best = root;
  }
  return best;
}

/** Longest board-owned temp root of this card that contains `path`. */
function cardTmpRootFor(scan: DoctorScan, task: DocTask, path: string): string | null {
  const found: string[] = [];
  const conventional = conventionalTmpRoot(task, path);
  if (conventional && insideDir(conventional, path)) found.push(conventional);
  const prepared = preparedTmpPath(scan, task);
  if (prepared && insideDir(prepared, path)) found.push(prepared);
  if (found.length === 0) return null;
  return found.reduce((best, root) => (root.length > best.length ? root : best));
}

/** Cards whose temp root contains `path`. Only the deepest matching roots are returned. */
function nearestCardTmpOwners(scan: DoctorScan, tasks: DocTask[], path: string): DocTask[] {
  const hits: { task: DocTask; root: string }[] = [];
  for (const task of tasks) {
    const root = cardTmpRootFor(scan, task, path);
    if (root) hits.push({ task, root });
  }
  if (hits.length === 0) return [];
  const longest = hits.reduce((max, hit) => Math.max(max, hit.root.length), 0);
  return hits.filter((hit) => hit.root.length === longest).map((hit) => hit.task);
}

function eventPath(event: DocEvent): string {
  const data = parseData(event.data_json);
  if (typeof data.path === "string" && data.path) return data.path;
  if (typeof data.summaryKey === "string" && data.summaryKey) return data.summaryKey;
  return "";
}

/** An open temp-cleanup failure. A later `tmp_cleaned` for the same path closes it. */
function tmpCleanupFailed(scan: DoctorScan, taskId: number): boolean {
  const latest = new Map<string, DocEvent>();
  for (const event of taskEvents(scan, taskId)) {
    if (event.kind !== "tmp_cleanup_failed" && event.kind !== "tmp_cleaned") continue;
    const path = eventPath(event);
    if (!path) continue;
    const prev = latest.get(path);
    if (!prev || event.id > prev.id) latest.set(path, event);
  }
  for (const event of latest.values()) {
    if (event.kind === "tmp_cleanup_failed") return true;
  }
  return false;
}

function taskOwnsWorkspace(scan: DoctorScan, task: DocTask, events: DocEvent[], workspace: DoctorWorkspace): boolean {
  if (task.paseo_workspace_id === workspace.id) return true;
  if (workspace.directory && task.workspace_path && samePath(task.workspace_path, workspace.directory)) return true;
  return boundPlaces(scan, task.id).some(
    (place) => place.workspaceId === workspace.id || (place.directory && workspace.directory && samePath(place.directory, workspace.directory)),
  );
}

/**
 * A running card with no agent whose lost-create recovery found more than one
 * live candidate after its latest start claim. The scheduler skips reclaim for
 * it every tick, so it stays running with nothing working on it.
 */
function ambiguousRecover(scan: DoctorScan, task: DocTask): { event: DocEvent; data: Record<string, unknown> } | null {
  if ((task.status !== "running" && task.status !== "reviewing") || task.agent_id) return null;
  const events = taskEvents(scan, task.id);
  const event = events.findLast((item) => item.kind === "agent_recover_ambiguous");
  if (!event) return null;
  const claim = events.findLast((item) => item.kind === "agent_creating");
  if (claim && claim.id > event.id) return null;
  return { event, data: parseData(event.data_json) };
}

function liveAgent(agents: DoctorAgent[], id: string): DoctorAgent | undefined {
  return agents.find((agent) => agent.id === id && !agent.archived);
}

function agentOnPath(agents: DoctorAgent[], path: string): DoctorAgent | undefined {
  return agents.find((agent) => !agent.archived && agent.cwd && samePath(agent.cwd, path));
}

function normalHold(reason: string | null): boolean {
  return Boolean(reason && normalHoldRegExp().test(reason));
}

function suggestionSafe(parts: string[]): string {
  return parts.filter(Boolean).join(t("common.semicolon"));
}

/**
 * Read the board and the supplied snapshots. Does not write the database,
 * delete anything, or call a Paseo method that changes state.
 */
export async function runDoctor(input: DoctorRunInput = {}): Promise<DoctorReport> {
  const clock = input.clock ?? Date.now;
  const started = clock();
  const nowDate = input.now ?? new Date();
  const now = nowDate.getTime();
  // Doctor only reads. A lost config is reported below as a red, so it must not stop the checkup.
  const settings = input.settings ?? doctorSettings(loadConfigForReport());
  if (!process.env.NODE_TEST_CONTEXT) {
    await refreshCapacityGuard({ now: nowDate, config: loadConfigForReport(), notify: false });
  }
  const sources = input.sources ?? {};
  const findings: DoctorFinding[] = [];
  const deadline = started + settings.totalTimeoutMs;
  let timedOut = false;
  const expired = () => {
    if (clock() >= deadline) {
      timedOut = true;
      return true;
    }
    return false;
  };
  // A project that left Paseo is not checked: no red or yellow for it, only one info line naming it.
  const leftPaseo = removedProjectsForReport();
  const skippedProjects = new Set<string>();
  let tasks: DocTask[] = [];
  /** The project a finding belongs to: named by the finding, or through its card. */
  const ownerOf = (finding: DoctorFinding): string | null => {
    if (finding.project != null) return finding.project;
    const related = RELATED_CARDS.get(finding);
    if (related && related.length > 0) {
      // Several cards share one leftover: it is a removed project's only when every card is known and left Paseo.
      const owners = related.map((card) => tasks.find((item) => markOf(item) === card)?.project ?? null);
      if (owners.every((owner): owner is string => owner != null && leftPaseo.has(owner))) {
        for (const owner of owners) skippedProjects.add(owner as string);
        return owners[0];
      }
      return null;
    }
    const task = tasks.find((item) => (finding.taskId != null && item.id === finding.taskId) || (finding.card != null && markOf(item) === finding.card));
    return task?.project ?? null;
  };
  const add = (finding: DoctorFinding) => {
    if (findings.some((item) => item.id === finding.id)) return;
    const owner = ownerOf(finding);
    if (owner != null && leftPaseo.has(owner)) {
      skippedProjects.add(owner);
      return;
    }
    findings.push(finding);
  };
  /**
   * `object` is shown to people. The id uses `token` instead when `object` is translated text, so the id
   * stays the same in every language; untranslated objects (repository paths, file names) are their own token.
   */
  const fail = (check: DoctorCheck, object: string, evidence: string, token: string = object) => {
    add({
      id: `check:${check}:${token}`,
      severity: "info",
      check,
      project: null,
      card: null,
      taskId: null,
      object,
      symptom: t("doctor.check.incomplete"),
      evidence,
      suggestion: t("doctor.check.retry"),
    });
  };

  let events: DocEvent[] = [];
  let runs: DocRun[] = [];
  let scan: DoctorScan = { events: new Map(), laneDb: null };
  let dbReady = false;
  try {
    const db = getReadOnlyDb();
    tasks = loadTasks(db);
    events = loadEvents(db);
    scan = { events: indexEvents(events), laneDb: db };
    runs = loadAgentRuns(db);
    dbReady = true;
  } catch (err) {
    scan = { events: new Map(), laneDb: null };
    fail("board", t("doctor.object.database"), err instanceof Error ? err.message : String(err), "database");
  }
  const graceMs = loadConfigForReport().archiveDeadlineMs ?? DEFAULT_ARCHIVE_DEADLINE_MS;
  const complete = new Set<DoctorCheck>();
  const withheld = new Set<string>();
  let directoryUnread: string[] = [];

  const budget = () => {
    const left = deadline - clock();
    if (left <= 0) {
      timedOut = true;
      return 0;
    }
    return Math.min(settings.commandTimeoutMs, left);
  };
  if (sources.collectError) fail("board", t("doctor.object.doctor"), sources.collectError, "doctor");
  for (const skipped of sources.skippedRepos ?? []) {
    add({
      id: `repo:skipped:${skipped.project}`,
      severity: "info",
      check: "worktree",
      project: skipped.project,
      card: null,
      taskId: null,
      object: skipped.path,
      symptom: t("doctor.repo.skipped.symptom", { project: skipped.project }),
      evidence: t("doctor.repo.skipped.evidence", { path: skipped.path }),
      suggestion: t("doctor.repo.skipped.suggestion"),
    });
  }
  for (const miss of sources.missingRepos ?? []) {
    fail("worktree", miss.project, t("doctor.repo.missing", { path: miss.path }));
  }
  try {
    checkConfigFile(add);
  } catch (err) {
    fail("board", "kanban.config.json", err instanceof Error ? err.message : String(err));
  }
  checkDataDir(add);
  try {
    const stableBin = stableBinFinding();
    if (stableBin) add(stableBin);
  } catch (err) {
    fail("board", "stable bin", err instanceof Error ? err.message : String(err), "stable-bin");
  }
  try {
    checkMigration(add, dataDir(), dbReady ? getReadOnlyDb() : "skip", nowDate);
  } catch (err) {
    fail("board", "MIGRATION.json", err instanceof Error ? err.message : String(err));
  }
  if (dbReady) checkProjectCodes(tasks.map((task) => task.project), add);
  // Pushed directly: a finished card's directory stays visible even when its project has left Paseo.
  if (dbReady) {
    try {
      for (const problem of tmpCleanupProblems()) {
        const id = `tmp-cleanup:${problem.taskId}:${problem.path}`;
        if (findings.some((item) => item.id === id)) continue;
        findings.push({
          id,
          severity: "red",
          check: "directory",
          project: problem.project,
          card: problem.card,
          taskId: problem.taskId,
          object: problem.path,
          symptom: t("doctor.tmpCleanup.symptom"),
          evidence: t("doctor.tmpCleanup.evidence", { path: problem.path, reason: problem.reason }),
          suggestion: t("doctor.tmpCleanup.suggestion"),
        });
      }
    } catch (err) {
      fail("directory", t("doctor.object.doctor"), err instanceof Error ? err.message : String(err), "tmp-cleanup");
    }
  }
  if (!dbReady) {
    // The board could not be read. Nothing was confirmed gone.
  } else if (!expired()) {
    if (checkWorkspaces(tasks, events, scan, sources, now, graceMs, add, fail)) complete.add("workspace");
    if (!expired() && checkAgents(tasks, events, scan, runs, sources, now, add, fail)) complete.add("agent");
    if (!expired()) {
      const decisionSource = readOpenDecisions(input.decisionsPath);
      // Reuse the board's matcher without reading or resolving any leader agent records.
      const decisions = decisionSource.items.map((item) => ({ ...item, leader: { agentId: null, reason: null } }));
      if (await checkCards(tasks, events, scan, sources, settings, now, add, decisions, budget)) complete.add("card");
    }
    if (!expired()) {
      const boardChecked = checkBoard(sources.board, settings, now, add);
      if (boardChecked.done) complete.add("board");
      for (const id of boardChecked.hold) withheld.add(id);
    }
    if (!expired()) {
      const directoryChecked = checkDirectories(sources, tasks, add);
      if (directoryChecked.done) complete.add("directory");
      directoryUnread = directoryChecked.unread;
    }
    if (!expired() && (await checkGit(tasks, events, scan, sources, now, graceMs, expired, budget, add, fail))) {
      complete.add("worktree");
      complete.add("branch");
    }
  }
  if (skippedProjects.size > 0) add(removedProjectsNote([...skippedProjects].sort()));
  for (const finding of capacityFindings()) add(finding);
  if (timedOut) {
    add({
      id: "check:timeout",
      severity: "info",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.doctor"),
      symptom: t("doctor.timeout.symptom"),
      evidence: t("doctor.timeout.evidence", { ms: settings.totalTimeoutMs }),
      suggestion: t("doctor.timeout.suggestion"),
    });
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
  const reds = findings.filter((item) => item.severity === "red");
  const prev = readLastDoctorReport();
  const prevAlerted = new Set(prev?.alertedIds ?? []);
  const capacitySuppress = capacityAlertSuppressId();
  if (capacitySuppress) prevAlerted.add(capacitySuppress);
  const fresh = reds.filter((item) => !prevAlerted.has(item.id));
  let woke: string[] = [];
  if (input.wake) {
    try {
      woke = await wakeLeader(fresh, Math.max(0, deadline - clock()));
    } catch {
      woke = [];
    }
  }
  const wokeIds = new Set(woke);
  if (wokeIds.has("board:capacity")) markCapacityLeaderAlerted();
  const redIds = new Set(reds.map((item) => item.id));
  const carried = [...prevAlerted].filter((id) => {
    if (redIds.has(id)) return false;
    if (withheld.has(id)) return true;
    if (directoryUnread.some((dir) => directoryAlertUnder(id, dir))) return true;
    const check = checkOfAlert(id);
    return check != null && !complete.has(check);
  });
  const alertedIds = [
    ...reds.map((item) => item.id).filter((id) => prevAlerted.has(id) || wokeIds.has(id)),
    ...carried,
  ];
  const report: DoctorReport = {
    at: nowDate.toISOString(),
    durationMs: clock() - started,
    timedOut,
    counts: countsOf(findings),
    findings,
    alertedIds,
    schedulerAt: input.wake ? nowDate.toISOString() : (prev?.schedulerAt ?? null),
  };
  if (input.persist) writeReport(report);
  return report;
}

/** Never throws: a failure here only means nothing is treated as removed. */
function removedProjectsForReport(): ReadonlySet<string> {
  try {
    return removedProjects(loadConfigForReport());
  } catch (err) {
    console.error("[paseo-kanban] doctor removed projects", err instanceof Error ? err.message : String(err));
    return new Set();
  }
}

function removedProjectsNote(projects: string[]): DoctorFinding {
  return {
    id: "paseo-project:removed",
    severity: "info",
    check: "board",
    project: null,
    card: null,
    taskId: null,
    object: t("doctor.paseoProject.removed.object"),
    symptom: t("doctor.paseoProject.removed.symptom", { count: projects.length, projects: projects.join(t("common.listSep")) }),
    evidence: t("doctor.paseoProject.removed.evidence", { readAt: paseoProjectsReadAt() ?? "" }),
    suggestion: t("doctor.paseoProject.removed.suggestion"),
  };
}

function directoryAlertUnder(id: string, dir: string): boolean {
  const marker = id.startsWith("dir:stray:") ? "dir:stray:" : id.startsWith("dir:placeholder:") ? "dir:placeholder:" : null;
  if (!marker) return false;
  const path = id.slice(marker.length);
  return samePath(path, dir) || ancestor(dir, path);
}

function checkOfAlert(id: string): DoctorCheck | null {
  if (id.startsWith("ws:")) return "workspace";
  if (id.startsWith("git:worktree:")) return "worktree";
  if (id.startsWith("git:branch:")) return "branch";
  if (id.startsWith("dir:")) return "directory";
  if (id.startsWith("agent:")) return "agent";
  if (id.startsWith("card:")) return "card";
  if (id.startsWith("board:")) return "board";
  return null;
}

async function wakeLeader(fresh: DoctorFinding[], timeoutMs: number): Promise<string[]> {
  if (fresh.length === 0 || timeoutMs <= 0) return [];
  const who = kanbanLeaderForAlarm();
  if (!who || !isAgentAlive(who) || !hasWakeSender()) return [];
  if (agentCwdMissing(who)) return [];
  const shown = fresh.slice(0, 30);
  const extra = fresh.length - shown.length;
  const lines = shown.map((item) => `${item.card ?? t("doctor.wake.board")} ${item.symptom}`);
  if (extra > 0) lines.push(t("doctor.wake.more", { count: extra }));
  try {
    const sent = await withTimeout(deliverWake(who, [t("doctor.wake.title"), ...lines, t("doctor.wake.ask"), leaderActionNote()].join("\n")), timeoutMs);
    return sent ? fresh.map((item) => item.id) : [];
  } catch {
    return [];
  }
}

function checkWorkspaces(
  tasks: DocTask[],
  events: DocEvent[],
  scan: DoctorScan,
  sources: DoctorSources,
  now: number,
  graceMs: number,
  add: (finding: DoctorFinding) => void,
  fail: (check: DoctorCheck, object: string, evidence: string) => void,
): boolean {
  if (sources.workspaceError || !sources.workspaces) {
    if (sources.workspaceError) fail("workspace", "paseo", sources.workspaceError);
    return false;
  }
  const list = sources.workspaces;

  for (const task of tasks) {
    const places = boundPlaces(scan, task.id);
    const ids = distinctIds(places);
    const dirs = distinctDirs(places);
    const presentIds = ids.filter((id) => {
      const workspace = list.find((item) => item.id === id && !item.archived);
      if (!workspace || workspace.kind !== "worktree") return false;
      return !lane(scan, workspace.id, workspace.directory);
    });
    const presentDirs = dirs.filter((dir) => {
      if (lane(scan, null, dir)) return false;
      return list.some((workspace) => workspace.kind === "worktree" && !workspace.archived && workspace.directory && samePath(workspace.directory, dir));
    });
    if (presentIds.length < 2 && presentDirs.length < 2) continue;
    add({
      id: `ws:multi:${task.id}`,
      severity: "red",
      check: "workspace",
      project: task.project,
      card: markOf(task),
      taskId: task.id,
      object: presentIds.join(t("common.listSep")) || presentDirs.join(t("common.listSep")),
      symptom: t("doctor.ws.multi.symptom"),
      evidence: t("doctor.ws.multi.evidence", { ids: presentIds.join(t("common.listSep")) || t("doctor.none"), dirs: presentDirs.join(t("common.listSep")) || t("doctor.none") }),
      suggestion: t("doctor.ws.multi.suggestion"),
    });
  }

  for (const workspace of list) {
    if (workspace.archived || workspace.kind !== "worktree") continue;
    if (lane(scan, workspace.id, workspace.directory)) continue;
    const owners = tasks.filter((task) => taskOwnsWorkspace(scan, task, events, workspace));
    if (owners.some((task) => unfinished(task.status))) continue;
    const recent = owners.some((task) => graceActive(scan, task, now, graceMs));
    if (recent) continue;
    const cleaned = owners.find((task) => finished(task.status) && cleanupClosed(scan, task.id));
    const card = cleaned ?? owners[0] ?? null;
    add({
      id: `ws:orphan:${workspace.id}`,
      severity: "red",
      check: "workspace",
      project: card?.project ?? null,
      card: card ? markOf(card) : null,
      taskId: card?.id ?? null,
      object: workspace.id,
      symptom: cleaned ? t("doctor.ws.orphan.cleaned") : t("doctor.ws.orphan.noCard"),
      evidence: `${workspace.name ?? workspace.id} ${workspace.directory ?? ""}`.trim(),
      suggestion: t("doctor.ws.orphan.suggestion"),
    });
  }
  return true;
}

async function checkGit(
  tasks: DocTask[],
  events: DocEvent[],
  scan: DoctorScan,
  sources: DoctorSources,
  now: number,
  graceMs: number,
  expired: () => boolean,
  budget: () => number,
  add: (finding: DoctorFinding) => void,
  fail: (check: DoctorCheck, object: string, evidence: string) => void,
): Promise<boolean> {
  const git = sources.git;
  if (!git) return false;
  const root = sources.dirs?.root;
  const seenPaths = new Set<string>();
  let ok = true;
  for (const repo of git.repos) {
    if (expired()) return false;
    let trees: DoctorWorktree[] = [];
    try {
      const wait = budget();
      if (wait <= 0) return false;
      trees = await withTimeout(git.worktrees(repo), wait);
    } catch (err) {
      fail("worktree", repo, err instanceof Error ? err.message : String(err));
      ok = false;
      trees = [];
    }
    for (const tree of trees) {
      if (root && !underRoot(tree.path, root)) continue;
      const key = resolve(tree.path);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      if (lane(scan, null, tree.path)) continue;
      const owners = tasks.filter((task) => taskOwnsPath(scan, task, events, tree.path, tree.branch));
      // A nested checkout inside a board card temp root belongs to that card.
      const nearest = nearestCardTmpOwners(scan, tasks, tree.path);
      const held = [...owners];
      for (const task of nearest) {
        if (!held.some((item) => item.id === task.id)) held.push(task);
      }
      if (held.some((task) => unfinished(task.status))) continue;
      // An unfinished card (an independent review, for example) can hold the same Paseo workspace by id.
      const trunk = (sources.workspaces ?? []).filter((workspace) => workspace.directory && samePath(workspace.directory, tree.path));
      if (tasks.some((task) => unfinished(task.status) && trunk.some((workspace) => taskOwnsWorkspace(scan, task, events, workspace)))) continue;
      if (held.some((task) => graceActive(scan, task, now, graceMs))) continue;
      const failed = nearest.filter((task) => finished(task.status) && tmpCleanupFailed(scan, task.id));
      const quiet = nearest.filter((task) => finished(task.status) && !tmpCleanupFailed(scan, task.id));
      if (nearest.length > 0 && failed.length === 0 && quiet.length === nearest.length) {
        // The checkout is already gone. `git worktree prune` drops this registration.
        // Reporting the card-temp info would keep a finding for a directory cleanup has removed.
        if (tree.prunable && !existsSync(tree.path)) continue;
        const card = quiet[0] ?? null;
        add({
          id: `git:worktree:${key}`,
          severity: "info",
          check: "worktree",
          project: card?.project ?? null,
          card: card ? markOf(card) : null,
          taskId: card?.id ?? null,
          object: tree.path,
          symptom: t("doctor.git.worktree.cardTmp"),
          evidence: `${tree.branch ?? "detached"} @ ${repo}`,
          suggestion: t("doctor.git.worktree.cardTmpSuggestion"),
        });
        continue;
      }
      const card = failed[0] ?? owners[0] ?? nearest[0] ?? null;
      const safety = await safetyOf(git, repo, tree, sources, budget, expired, now);
      add({
        id: `git:worktree:${key}`,
        severity: "red",
        check: "worktree",
        project: card?.project ?? null,
        card: card ? markOf(card) : null,
        taskId: card?.id ?? null,
        object: tree.path,
        symptom: card ? t("doctor.git.worktree.notUnfinished") : t("doctor.git.worktree.noCard"),
        evidence: `${tree.branch ?? "detached"} @ ${repo}`,
        suggestion: safety.text,
      });
    }
    if (expired()) return false;
    let branches: string[] = [];
    try {
      const wait = budget();
      if (wait <= 0) return false;
      branches = await withTimeout(git.branches(repo), wait);
    } catch (err) {
      fail("branch", repo, err instanceof Error ? err.message : String(err));
      ok = false;
      continue;
    }
    for (const branch of branches) {
      if (!branch.startsWith("kanban/")) continue;
      const owner = tasks.find((task) => ownsBranch(task, branch)) ?? null;
      if (!owner || unfinished(owner.status) || !cleanupClosed(scan, owner.id)) continue;
      if (graceActive(scan, owner, now, graceMs)) continue;
      const kept = keptBranch(scan, owner.id);
      add({
        id: `git:branch:${resolve(repo)}:${branch}`,
        severity: kept ? "info" : "yellow",
        check: "branch",
        project: owner.project,
        card: markOf(owner),
        taskId: owner.id,
        object: branch,
        symptom: kept ? t("doctor.branch.kept") : t("doctor.branch.leftover"),
        evidence: repo,
        suggestion: kept
          ? t("doctor.branch.keptSuggestion")
          : t("doctor.branch.deleteAfterMerge", { branch }),
      });
    }
  }
  if ((sources.missingRepos ?? []).length > 0) return false;
  return ok;
}

function readPr(value: DoctorPrResult): { state: DoctorPr; headOid: string | null } {
  if (typeof value === "string") return { state: value, headOid: null };
  return { state: value.state, headOid: value.headOid ?? null };
}

/**
 * An active agent on this checkout, unknown when the list failed or an active
 * agent cannot be placed, or null when every active agent is somewhere else.
 */
function agentForTree(sources: DoctorSources, path: string): { id: string } | "unknown" | null {
  const src = sources.agents;
  if (!src) return null;
  if (src.error) return "unknown";
  const onDisk = src.agents.find((agent) => !agent.archived && agent.cwd && samePath(agent.cwd, path));
  if (onDisk) return onDisk;
  for (const agent of src.agents) {
    if (agent.archived || !agent.workspaceId) continue;
    const workspace = sources.workspaces?.find((item) => item.id === agent.workspaceId && item.directory && samePath(item.directory, path));
    if (workspace) return agent;
  }
  const loose = (src.paseoIds ?? []).filter((id) => {
    const agent = src.agents.find((item) => item.id === id);
    if (!agent || agent.archived) return true;
    if (agent.cwd) return false;
    if (agent.workspaceId && sources.workspaces?.some((item) => item.id === agent.workspaceId && item.directory)) return false;
    return true;
  });
  if (loose.length > 0) return "unknown";
  return null;
}

const SAFETY_CACHE_MS = 30 * 60_000;

interface SafetyProbe {
  at: number;
  dirty: boolean | "unknown";
  pushed: boolean | "unknown";
  pr: DoctorPrResult;
  localTip: string | "unknown";
}

const safetyCache = new Map<string, SafetyProbe>();

/** Test hook. A doctor run keeps entries so a later run inside 30 minutes can reuse them. */
export function clearDoctorSafetyCache(): void {
  safetyCache.clear();
}

function safetyKey(repo: string, tree: DoctorWorktree): string {
  return `${resolve(repo)}\0${resolve(tree.path)}\0${tree.branch ?? ""}`;
}

function freshProbe(probe: SafetyProbe | undefined, now: number): probe is SafetyProbe {
  return probe != null && now >= probe.at && now - probe.at < SAFETY_CACHE_MS;
}

async function safetyOf(
  git: DoctorGit,
  repo: string,
  tree: DoctorWorktree,
  sources: DoctorSources,
  budget: () => number,
  expired: () => boolean,
  now: number,
): Promise<{ text: string }> {
  const key = safetyKey(repo, tree);
  const cached = safetyCache.get(key);
  if (expired() && !freshProbe(cached, now)) return { text: t("doctor.safety.timedOut") };
  let dirty: boolean | "unknown" = "unknown";
  let pushed: boolean | "unknown" = "unknown";
  let pr: DoctorPrResult = "unknown";
  let localTip: string | "unknown" = "unknown";
  if (freshProbe(cached, now)) {
    dirty = cached.dirty;
    pushed = cached.pushed;
    pr = cached.pr;
    localTip = cached.localTip;
  } else {
    const cap = () => {
      const wait = budget();
      return wait > 0 ? wait : 1;
    };
    try {
      dirty = await withTimeout(git.dirty(tree.path), cap());
    } catch {
      dirty = "unknown";
    }
    if (tree.branch) {
      if (git.tip) {
        try {
          localTip = await withTimeout(git.tip(repo, tree.branch), cap());
        } catch {
          localTip = "unknown";
        }
      }
      try {
        pushed = await withTimeout(git.pushed(repo, tree.branch), cap());
      } catch {
        pushed = "unknown";
      }
      try {
        pr = await withTimeout(git.pr(repo, tree.branch), cap());
      } catch {
        pr = "unknown";
      }
    } else {
      pushed = "unknown";
      pr = "none";
    }
    safetyCache.set(key, { at: now, dirty, pushed, pr, localTip });
  }
  const agent = agentForTree(sources, tree.path);
  const prInfo = readPr(pr);
  const headMatches = prInfo.headOid != null && localTip !== "unknown" && prInfo.headOid === localTip;
  const prLanded = prInfo.state === "merged" && (headMatches || (prInfo.headOid == null && !git.tip));
  const prUnproved = prInfo.state === "unknown" || (prInfo.state === "merged" && prInfo.headOid != null && localTip === "unknown") || (prInfo.state === "merged" && prInfo.headOid == null && Boolean(git.tip));
  const clean = dirty === false;
  const gone = agent === null;
  const landed = pushed === true || prLanded === true;
  const unknown = dirty === "unknown" || pushed === "unknown" || prUnproved || agent === "unknown";
  const safe = clean && gone && landed && !unknown;
  const prText = prInfo.state === "merged" && prInfo.headOid && localTip !== "unknown" && prInfo.headOid !== localTip
    ? t("doctor.safety.mergedOther")
    : prInfo.state;
  const bits = [
    t("doctor.safety.dirty", { value: dirty === "unknown" ? "unknown" : dirty ? t("doctor.safety.has") : t("doctor.none") }),
    t("doctor.safety.agent", { value: agent === "unknown" ? "unknown" : agent ? agent.id : t("doctor.none") }),
    t("doctor.safety.pushed", { value: pushed === "unknown" ? "unknown" : pushed ? t("doctor.safety.yes") : t("doctor.safety.no") }),
    t("doctor.safety.pr", { value: prText }),
  ];
  const verdict = safe ? t("doctor.safety.safe") : unknown ? t("doctor.safety.unknown") : t("doctor.safety.unsafe");
  const command = `git worktree remove ${tree.path}`;
  return { text: t("doctor.safety.text", { verdict, bits: bits.join(t("common.comma")), command }) };
}

/** Every card a directory leftover mentions, so a leftover shared by cards of removed projects can be left out. */
const RELATED_CARDS = new WeakMap<DoctorFinding, string[]>();

function checkDirectories(sources: DoctorSources, tasks: DocTask[], add: (finding: DoctorFinding) => void): { done: boolean; unread: string[] } {
  const dirs = sources.dirs;
  if (!dirs) return { done: false, unread: [] };
  if (dirs.scanned === false) {
    add({
      id: "check:directory:root",
      severity: "info",
      check: "directory",
      project: null,
      card: null,
      taskId: null,
      object: dirs.root,
      symptom: t("doctor.check.incomplete"),
      evidence: dirs.scanError ?? t("doctor.dir.listIncomplete"),
      suggestion: t("doctor.check.retry"),
    });
    return { done: false, unread: dirs.unread ?? [] };
  }
  let listed: string[] = [];
  try {
    listed = dirs.list();
  } catch (err) {
    add({
      id: "check:directory:root",
      severity: "info",
      check: "directory",
      project: null,
      card: null,
      taskId: null,
      object: dirs.root,
      symptom: t("doctor.check.incomplete"),
      evidence: err instanceof Error ? err.message : String(err),
      suggestion: t("doctor.check.retry"),
    });
    return { done: false, unread: dirs.unread ?? [] };
  }
  const unread = new Set((dirs.unread ?? []).map((dir) => resolve(dir)));
  const hidden = (dir: string) => [...unread].some((parent) => samePath(parent, dir) || ancestor(parent, dir));
  const agents = sources.agents?.agents ?? [];
  const agentKnown = sources.agents != null && !sources.agents.error;
  const activeIds = new Set(sources.agents?.paseoIds ?? []);
  for (const dir of listed) {
    if (hidden(dir)) continue;
    const placeholder = readPlaceholder(dirs, dir);
    if (placeholder === "unknown") {
      unread.add(resolve(dir));
      continue;
    }
    if (placeholder != null) {
      if (placeholder.length === 0) continue;
      if (!agentKnown) {
        unread.add(resolve(dir));
        continue;
      }
      if (placeholder.some((id) => activeIds.has(id) || liveAgent(agents, id))) continue;
      // Archived records still need their cwd. Only a deleted record is gone.
      const retained = agents.filter((agent) => placeholder.includes(agent.id));
      const cards = [...new Set(retained.flatMap((agent) => {
        const label = agent.labels?.kanban_task;
        const task = tasks.find((item) => item.id === Number(label));
        if (task) return [markOf(task)];
        const code = label?.match(/^[A-Z][A-Z0-9]*_\d+$/i)?.[0]
          ?? agent.title?.match(/\b[A-Z][A-Z0-9]*_\d+\b/i)?.[0];
        return code ? [code] : [];
      }))];
      let knownTask: DocTask | undefined;
      let removalError: string | null = null;
      try {
        const db = getReadOnlyDb();
        const paths = recordedPlaceholderPaths(db);
        const owners = paths.get(resolve(dir));
        if (owners?.size) {
          const taskId = [...owners][0]!;
          if (owners.size === 1) knownTask = tasks.find(task => task.id === taskId);
          removalError = recordedPlaceholderError({ directory: dir, taskId, paths, db,
            worktrees: dirs.worktrees, worktreesRoot: dirs.root });
        }
      } catch {
        // Without readable ownership records retain the ordinary orphan warning.
      }
      const leftover: DoctorFinding = {
        id: `dir:placeholder:${resolve(dir)}`,
        severity: retained.length > 0 ? "yellow" : "red",
        check: "directory",
        project: knownTask?.project ?? null,
        card: knownTask ? markOf(knownTask) : cards.length === 1 ? cards[0] : null,
        taskId: knownTask?.id ?? null,
        object: dir,
        symptom: retained.length > 0 ? t("doctor.dir.placeholder.retained") : t("doctor.dir.placeholder.gone"),
        evidence: [placeholder.join(t("common.listSep")), removalError].filter(Boolean).join("\n"),
        suggestion: retained.length > 0
          ? t("doctor.dir.placeholder.purge", { commands: cards.length > 0 ? cards.map((card) => ` purge-agents ${card}`).join(t("common.semicolon")) : t("doctor.dir.placeholder.purgeAny") })
          : knownTask || removalError ? t("doctor.cleanup.suggestion") : t("doctor.dir.placeholder.delete"),
      };
      RELATED_CARDS.set(leftover, cards);
      add(leftover);
      continue;
    }
    if (dirs.worktrees.some((path) => samePath(path, dir))) continue;
    if (listed.some((other) => ancestor(dir, other))) continue;
    add({
      id: `dir:stray:${resolve(dir)}`,
      severity: "red",
      check: "directory",
      project: null,
      card: null,
      taskId: null,
      object: dir,
      symptom: t("doctor.dir.stray.symptom"),
      evidence: dirs.root,
      suggestion: t("doctor.dir.stray.suggestion"),
    });
  }
  const missed = [...unread];
  if (missed.length > 0) {
    add({
      id: "check:directory:root",
      severity: "info",
      check: "directory",
      project: null,
      card: null,
      taskId: null,
      object: dirs.root,
      symptom: t("doctor.check.incomplete"),
      evidence: t("doctor.dir.unread", { dirs: missed.join(t("common.listSep")), agents: !agentKnown ? t("doctor.dir.unreadAgents", { error: sources.agents?.error ?? t("doctor.dir.noResult") }) : "" }),
      suggestion: t("doctor.check.retry"),
    });
  }
  return { done: agentKnown, unread: missed };
}

function readPlaceholder(dirs: DoctorDirs, dir: string): string[] | null | "unknown" {
  try {
    return dirs.placeholderAgents(dir);
  } catch {
    return "unknown";
  }
}

function checkAgents(
  tasks: DocTask[],
  events: DocEvent[],
  scan: DoctorScan,
  runs: DocRun[],
  sources: DoctorSources,
  now: number,
  add: (finding: DoctorFinding) => void,
  fail: (check: DoctorCheck, object: string, evidence: string) => void,
): boolean {
  const source = sources.agents;
  if (!source) return false;
  if (source.error) fail("agent", "paseo", source.error);
  const agents = source.agents;
  const byTask = new Map<number, Set<string>>();
  const note = (taskId: number, agentId: string) => {
    const set = byTask.get(taskId) ?? new Set<string>();
    set.add(agentId);
    byTask.set(taskId, set);
  };
  for (const run of runs) {
    if (run.role !== "executor" || run.ended_at != null) continue;
    if (!liveAgent(agents, run.agent_id)) continue;
    note(run.task_id, run.agent_id);
  }
  for (const agent of agents) {
    if (agent.archived) continue;
    const labels = agent.labels ?? {};
    const taskId = Number(labels.kanban_task);
    const run = runs.find((item) => item.agent_id === agent.id);
    const task = tasks.find((item) => item.id === taskId) ?? tasks.find((item) => item.agent_id === agent.id || item.executor_agent_id === agent.id) ??
      tasks.find((item) => item.id === run?.task_id) ?? null;
    const kanban = labels.kanban === "1" || labels.kanban === "true" || Boolean(task);
    if (!kanban) continue;
    const main = sources.workspaces?.find((workspace) => !workspace.archived && workspace.kind !== "worktree" &&
      samePath(workspace.directory, workspace.projectRoot) &&
      (agent.workspaceId ? agent.workspaceId === workspace.id : samePath(agent.cwd, workspace.directory)));
    if (main) {
      add({
        id: `agent:main:${agent.id}`, severity: "yellow", check: "agent",
        project: task?.project ?? null, card: task ? markOf(task) : null, taskId: task?.id ?? null,
        object: agent.id, symptom: t("doctor.agent.main.symptom"),
        evidence: t("doctor.agent.main.evidence", { id: main.id, directory: String(main.directory), status: agent.status ?? "unknown" }),
        suggestion: t("doctor.agent.main.suggestion"),
      });
    }
    if (!task) {
      add({
        id: `agent:orphan:${agent.id}`,
        severity: "red",
        check: "agent",
        project: null,
        card: labels.kanban_task ? `#${labels.kanban_task}` : null,
        taskId: Number.isInteger(taskId) ? taskId : null,
        object: agent.id,
        symptom: t("doctor.agent.orphan.noCard"),
        evidence: `kanban_task=${labels.kanban_task ?? ""}`,
        suggestion: t("doctor.agent.orphan.archive"),
      });
      continue;
    }
    if (finished(task.status) && cleanupClosed(scan, task.id)) {
      add({
        id: `agent:orphan:${agent.id}`,
        severity: "red",
        check: "agent",
        project: task.project,
        card: markOf(task),
        taskId: task.id,
        object: agent.id,
        symptom: t("doctor.agent.orphan.cleaned"),
        evidence: `status=${agent.status ?? "unknown"}`,
        suggestion: t("doctor.agent.orphan.purge", { card: markOf(task) }),
      });
    }
    if ((labels.role === "executor" || task.role === "executor") && labels.role !== "reviewer") {
      if (labels.role === "executor" || (!labels.role && task.agent_id === agent.id)) note(task.id, agent.id);
    }
  }
  for (const [taskId, ids] of byTask) {
    if (ids.size < 2) continue;
    const task = tasks.find((item) => item.id === taskId);
    if (!task || finished(task.status)) continue;
    add({
      id: `agent:double:${taskId}`,
      severity: "red",
      check: "agent",
      project: task.project,
      card: markOf(task),
      taskId,
      object: [...ids].join(t("common.listSep")),
      symptom: t("doctor.agent.double.symptom"),
      evidence: [...ids].join(t("common.listSep")),
      suggestion: t("doctor.agent.double.suggestion"),
    });
  }

  if (!source.paseoIds) return !source.error;
  const known = new Set(source.paseoIds);
  for (const task of tasks) {
    if (task.status !== "running" && task.status !== "reviewing") continue;
    if (!task.agent_id) continue;
    if (known.has(task.agent_id)) continue;
    const record = agents.find((agent) => agent.id === task.agent_id);
    if (record && !record.archived) continue;
    add({
      id: `agent:missing:${task.id}`,
      severity: "red",
      check: "agent",
      project: task.project,
      card: markOf(task),
      taskId: task.id,
      object: task.agent_id,
      symptom: t("doctor.agent.missing.symptom"),
      evidence: record?.archived ? t("doctor.agent.missing.archived") : t("doctor.agent.missing.nowhere"),
      suggestion: t("doctor.agent.missing.suggestion", { card: markOf(task) }),
    });
  }
  return !source.error;
}

async function checkCards(
  tasks: DocTask[],
  events: DocEvent[],
  scan: DoctorScan,
  sources: DoctorSources,
  settings: DoctorSettings,
  now: number,
  add: (finding: DoctorFinding) => void,
  decisions: readonly DecisionView[],
  budget: () => number,
): Promise<boolean> {
  const agents = sources.agents?.agents;
  const landBranches = new Map<string, Promise<string[] | null>>();
  function addTimeout(finding: DoctorFinding): void {
    const matches = cardDecisions(finding.card ?? "", decisions);
    if (matches.length === 0) {
      add(finding);
      return;
    }
    add({
      ...finding,
      severity: "info",
      symptom: t("doctor.decision.symptom", { ids: matches.map((item) => item.id).join(t("common.listSep")) }),
      evidence: `${finding.symptom}${t("common.semicolon")}${finding.evidence}`,
      suggestion: t("doctor.decision.suggestion"),
    });
  }
  for (const task of tasks) {
    if (agents && (task.status === "running" || task.status === "reviewing") && task.agent_id) {
      const agent = agents.find((item) => item.id === task.agent_id);
      if (agent && !agent.archived && agent.status === "idle") {
        const limit = loadConfigForReport().stallIdleMs ?? 10 * 60_000;
        const idle = ageMs(agent.idleSince, now);
        if (idle != null && idle >= limit) {
          add({
            id: `card:idle:${task.id}`,
            severity: "yellow",
            check: "card",
            project: task.project,
            card: markOf(task),
            taskId: task.id,
            object: task.agent_id,
            symptom: t("doctor.idle.symptom", { minutes: Math.round(limit / 60_000) }),
            evidence: t("doctor.idle.evidence", { minutes: Math.round(idle / 60_000) }),
            suggestion: t("doctor.idle.suggestion"),
          });
        }
      }
    }
    const ambiguous = ambiguousRecover(scan, task);
    if (ambiguous) {
      const ids = Array.isArray(ambiguous.data.agentIds) ? ambiguous.data.agentIds.map(String) : [];
      add({
        id: `card:recover-ambiguous:${task.id}`,
        severity: "red",
        check: "card",
        project: task.project,
        card: markOf(task),
        taskId: task.id,
        object: ids.join(", ") || "agent_recover_ambiguous",
        symptom: t("doctor.ambiguous.symptom"),
        evidence: t("doctor.ambiguous.evidence", { at: ambiguous.event.at, ids: ids.join(t("common.listSep")) || t("doctor.ambiguous.noIds") }),
        suggestion: t("doctor.ambiguous.suggestion", { ids: ids.join(t("common.listSep")) || t("doctor.ambiguous.seeEvent") }),
      });
    }
    if (task.status === "blocked" && task.blocked_kind !== "background") {
      const kind = task.blocked_kind && isBlockedKind(task.blocked_kind) ? task.blocked_kind : "transient";
      const limitH = settings.blockedHours[kind === "scheduled" ? "transient" : kind];
      // A planned wait is healthy until its deadline. The normal overdue grace starts there.
      const blocked = ageMs((kind === "scheduled" ? task.scheduled_until : null) ?? task.blocked_at ?? task.updated_at, now);
      if (blocked != null && blocked >= limitH * 3_600_000) {
        const quotaWait = kind === "quota" || isQuotaWaitReason(task.blocked_reason) || isQuotaWaitReason(task.hold_reason);
        const severe = !quotaWait && (kind === "needs_human" || kind === "capability" || kind === "transient" || kind === "scheduled");
        addTimeout({
          id: `card:blocked:${task.id}`,
          severity: severe ? "red" : "yellow",
          check: "card",
          project: task.project,
          card: markOf(task),
          taskId: task.id,
          object: blockedKindLabel(kind),
          symptom: t("doctor.blocked.symptom", { kind: blockedKindLabel(kind), hours: limitH }),
          evidence: task.hold_reason ?? task.blocked_kind ?? "",
          suggestion: t("doctor.blocked.suggestion", { card: markOf(task) }),
        });
      }
    }
    if (task.status === "acceptance") {
      const row = taskEvents(scan, task.id).findLast((event) => event.to_status === "acceptance");
      const waited = ageMs(row?.at ?? task.updated_at, now);
      if (waited != null && waited >= settings.acceptanceHours * 3_600_000) {
        addTimeout({
          id: `card:acceptance:${task.id}`,
          severity: "red",
          check: "card",
          project: task.project,
          card: markOf(task),
          taskId: task.id,
          object: "acceptance",
          symptom: t("doctor.acceptance.symptom", { hours: settings.acceptanceHours }),
          evidence: row?.at ?? task.updated_at,
          suggestion: t("doctor.acceptance.suggestion", { card: markOf(task) }),
        });
      }
    }
    if (task.status === "ready" && !normalHold(task.hold_reason) && !isQuotaWaitReason(task.hold_reason)) {
      const waited = ageMs(task.updated_at || task.created_at, now);
      if (waited != null && waited >= settings.readyHours * 3_600_000) {
        add({
          id: `card:ready:${task.id}`,
          severity: "yellow",
          check: "card",
          project: task.project,
          card: markOf(task),
          taskId: task.id,
          object: "ready",
          symptom: t("doctor.ready.symptom", { hours: settings.readyHours }),
          evidence: task.hold_reason ?? t("doctor.ready.noHold"),
          suggestion: t("doctor.ready.suggestion", { card: markOf(task) }),
        });
      }
    }
    const pending = openLand(scan, task.id);
    if (pending) {
      const row = taskEvents(scan, task.id).findLast((event) => event.kind === "land_pending");
      const waited = ageMs(row?.at, now);
      const created = taskEvents(scan, task.id).findLast(event => event.kind === "worktree_created" && parseData(event.data_json).discarded !== true);
      const root = created && parseData(created.data_json).root;
      let missing = pending.missingBranch;
      let unknown = false;
      if (typeof root === "string" && sources.git?.repos.includes(root) && pending.branch) {
        let listed = landBranches.get(root);
        if (!listed) {
          const wait = budget();
          listed = wait > 0 ? withTimeout(sources.git.branches(root), wait).catch(() => null) : Promise.resolve(null);
          landBranches.set(root, listed);
        }
        const branches = await listed;
        unknown = branches === null;
        if (branches) missing = !branches.includes(pending.branch);
      }
      if (missing || (waited != null && waited >= settings.landPendingMinutes * 60_000)) {
        add({
          id: `card:land:${task.id}`,
          severity: missing || pending.conflict ? "red" : "yellow",
          check: "card",
          project: task.project,
          card: markOf(task),
          taskId: task.id,
          object: pending.branch || "land_pending",
          symptom: missing ? t("doctor.land.missing") : pending.conflict ? t("doctor.land.conflict", { minutes: settings.landPendingMinutes }) : t("doctor.land.waiting", { minutes: settings.landPendingMinutes }),
          evidence: missing ? t("missingLand.stopped", { branch: pending.branch, detail: pending.reason }) : pending.reason,
          suggestion: missing ? t("missingLand.next", { card: markOf(task) }) : unknown ? t("doctor.land.unknownSuggestion")
            : pending.conflict ? t("doctor.land.conflictSuggestion") : pending.mainDirty ? t("doctor.land.waitingSuggestion") : t("doctor.land.retrySuggestion"),
        });
      }
    }
    if (finished(task.status) && !cleanupClosed(scan, task.id)) {
      const latest = new Map<string, DocEvent>();
      for (const event of taskEvents(scan, task.id)) {
        if (event.kind !== "cleanup") continue;
        const data = parseData(event.data_json);
        // wait_turn is the waiting half of archive_agent: a later archive_agent result replaces it.
        const action = data.action === "wait_turn" ? "archive_agent" : String(data.action ?? "");
        const key = `${action}:${String(data.agentId ?? data.directory ?? data.workspaceId ?? data.reason ?? "")}`;
        latest.set(key, event);
      }
      for (const [key, event] of latest) {
        const data = parseData(event.data_json);
        if (data.ok === true) continue;
        const retryAt = typeof data.retryAt === "string" ? Date.parse(data.retryAt) : Number.NaN;
        const base = Number.isFinite(retryAt) ? retryAt : Date.parse(event.at);
        if (!Number.isFinite(base)) continue;
        if (now - base < settings.cleanupStaleHours * 3_600_000) continue;
        // Old not_merged rows can predate an integration merge. Reuse cleanup's
        // read-only proof, scoped to the recorded workspace; other failures still count.
        if (data.reason === "not_merged" && (data.action === "skip_worktree" || data.action === "skip_lane")) {
          const bindingKind = data.action === "skip_lane" ? "lane_bound" : "worktree_created";
          const created = taskEvents(scan, task.id).findLast(row => row.kind === bindingKind);
          const owned = created ? parseData(created.data_json) : {};
          const branch = typeof data.branch === "string" ? data.branch : owned.branch;
          const names = projectWorkspace(task.project, loadConfigForReport()).integrationBranches ?? [];
          if (names.length && typeof owned.root === "string" && typeof owned.directory === "string" &&
              typeof data.directory === "string" && samePath(data.directory, owned.directory) && typeof branch === "string" && ownsBranch(task, branch)) {
            const wait = budget();
            if (wait <= 0) return false;
            try {
              const integrated = await withTimeout(integrationBranchContaining(owned.root, branch, names, runGit), wait);
              if (integrated && "ref" in integrated) continue;
            } catch {
              // Unknown containment leaves the original failure visible.
            }
          }
        }
        const reason = cleanupFailureReason(data);
        add({
          id: `card:cleanup:${task.id}:${key}`,
          severity: "red",
          check: "card",
          project: task.project,
          card: markOf(task),
          taskId: task.id,
          object: String(data.action ?? "cleanup"),
          symptom: t("doctor.cleanup.symptom", { hours: settings.cleanupStaleHours, reason }),
          evidence: typeof data.retryAt === "string" ? `retryAt ${data.retryAt}` : event.at,
          suggestion: t("doctor.cleanup.suggestion"),
        });
      }
    }
  }
  return true;
}

const CLEANUP_ACTION_LABEL: Record<string, MessageKey> = {
  delete_branch: "doctor.cleanup.deleteBranch",
  archive_agent: "doctor.cleanup.archiveAgent",
  archive_workspace: "doctor.cleanup.archiveWorkspace",
  drop_directory: "doctor.cleanup.dropDirectory",
  skip_worktree: "doctor.cleanup.skipWorktree",
  wip_commit: "doctor.cleanup.wipCommit",
  purge_agents: "doctor.cleanup.purgeAgents",
};

/** Reason for the latest failed attempt of this step, in that step's own words. */
function cleanupFailureReason(data: Record<string, unknown>): string {
  const detail = [data.reason, data.error, data.outcome].find((value) => typeof value === "string" && value);
  const labelKey = CLEANUP_ACTION_LABEL[String(data.action ?? "")];
  const label = labelKey ? t(labelKey) : undefined;
  if (data.action === "wait_turn") return typeof detail === "string" ? detail : t("doctor.cleanup.waitTurn");
  if (label && typeof detail === "string" && detail !== "error") return `${label}${t("common.colon")}${detail}`;
  return typeof detail === "string" ? detail : "ok:false";
}

const CONTRACT_HOLD_NOTE = "The board keeps dispatching in the base order; this is not an outage.";

/**
 * Contract exports from the cockpit. Not installed is an info note; a stale or invalid export is
 * yellow and says how old it is or why it was rejected. Never red: the board degrades on its own.
 */
function checkContracts(
  health: CockpitHealth | undefined,
  add: (finding: DoctorFinding) => void,
): { notInstalled: boolean; coversQuota: boolean } {
  if (!health) return { notInstalled: false, coversQuota: false };
  if (!health.installed) {
    add({
      id: "board:cockpit",
      severity: "info",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: "fleet cockpit",
      symptom: "fleet cockpit not installed",
      evidence: "no contract exports and no cockpit state files",
      suggestion: "Dispatch uses the base order with kanban.config.json disabledPools; decisions go to the board's own list.",
    });
    return { notInstalled: true, coversQuota: true };
  }
  let coversQuota = false;
  for (const item of health.files) {
    if (item.state !== "stale" && item.state !== "invalid") continue;
    if (item.kind === "poolStatus") coversQuota = true;
    add(contractFinding(item));
  }
  return { notInstalled: false, coversQuota };
}

function contractFinding(item: ContractHealth): DoctorFinding {
  const name = basename(item.file);
  const minutes = item.ageMs != null ? Math.round(item.ageMs / 60_000) : null;
  const stale = item.state === "stale";
  return {
    id: `board:contract:${item.kind}`,
    severity: "yellow",
    check: "board",
    project: null,
    card: null,
    taskId: null,
    object: name,
    symptom: stale ? `${name} is stale` : `${name} is invalid`,
    evidence: stale
      ? `${minutes ?? "?"} minutes old (stale after ${item.ttlSeconds != null ? Math.round((item.ttlSeconds * STALE_FACTOR) / 60) : "?"} minutes)`
      : item.reason ?? "invalid",
    suggestion: `${stale ? "Check that the fleet cockpit is still writing its exports." : "The board ignores this file and handles it as absent."} ${CONTRACT_HOLD_NOTE}`,
  };
}

function checkBoard(
  board: DoctorBoard | undefined,
  settings: DoctorSettings,
  now: number,
  add: (finding: DoctorFinding) => void,
): { done: boolean; hold: string[] } {
  if (!board) return { done: false, hold: [] };
  const hold: string[] = [];
  const tickAge = board.tickAt ? ageMs(board.tickAt, now) : Number.POSITIVE_INFINITY;
  if (tickAge == null || tickAge > settings.tickStaleMs) {
    add({
      id: "board:tick",
      severity: "red",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.scheduler"),
      symptom: board.tickAt ? t("doctor.tick.stale") : t("doctor.tick.none"),
      evidence: board.tickAt ? formatTickTime(board.tickAt) : t("doctor.none"),
      suggestion: t("doctor.tick.suggestion"),
    });
  }
  if (board.plugin === "stopped") {
    add({
      id: "board:plugin",
      severity: "red",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.plugin"),
      symptom: t("doctor.plugin.stopped"),
      evidence: "paseo plugin ls",
      suggestion: t("doctor.plugin.stoppedSuggestion"),
    });
  } else if (board.plugin === "unknown") {
    add({
      id: "board:plugin",
      severity: "yellow",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.plugin"),
      symptom: t("doctor.plugin.unknown"),
      evidence: t("doctor.plugin.unknownEvidence"),
      suggestion: t("doctor.plugin.unknownSuggestion"),
    });
    hold.push("board:plugin");
  }
  const contracts = board.policyRequired ? { notInstalled: false, coversQuota: false } : checkContracts(board.contracts, add);
  if (contracts.coversQuota && board.quota !== "fresh") {
    // The contract finding above already says why the snapshot is stale, invalid or not there.
  } else if (board.quota === "unknown") {
    add({
      id: "board:quota",
      severity: "yellow",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.quota"),
      symptom: t("doctor.quota.unknown"),
      evidence: t("doctor.queryFailedNotMissing"),
      suggestion: t("doctor.quota.unknownSuggestion"),
    });
    hold.push("board:quota");
  } else if (board.quota === "missing" || board.quota === "stale" || (board.quotaAgeMs != null && board.quotaAgeMs > settings.quotaStaleMs)) {
    // Missing or invalid combined policy holds dispatch; compatibility inputs are reported separately.
    add({
      id: "board:quota",
      severity: "yellow",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.quota"),
      symptom: board.quota === "missing" ? t("doctor.quota.missing") : t("doctor.quota.stale"),
      evidence: board.quotaAgeMs == null ? board.quota : t("doctor.minutes", { minutes: Math.round(board.quotaAgeMs / 60_000) }),
      suggestion: t("doctor.quota.suggestion"),
    });
    if (board.quota === "missing") hold.push("board:quota");
  }
  if (board.matrix === "unknown") {
    add({
      id: "board:matrix",
      severity: "yellow",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.matrix"),
      symptom: t("doctor.matrix.unknown"),
      evidence: t("doctor.queryFailedNotMissing"),
      suggestion: t("doctor.matrix.unknownSuggestion"),
    });
    hold.push("board:matrix");
  } else if (board.matrix === "invalid") {
    add({
      id: "board:matrix",
      severity: "red",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.matrix"),
      symptom: t("doctor.matrix.invalid"),
      evidence: "invalid",
      suggestion: t("doctor.matrix.check", { path: realDispatchMatrixPath() ?? t("doctor.matrix.afcFile") }),
    });
  } else if (board.matrix === "missing" && contracts.notInstalled) {
    // Covered by the "fleet cockpit not installed" note: the board uses the profiles' order.
  } else if (board.matrix === "missing") {
    add({
      id: "board:matrix",
      severity: "yellow",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.matrix"),
      symptom: t("doctor.matrix.missing"),
      evidence: "missing",
      suggestion: t("doctor.matrix.missingSuggestion"),
    });
    hold.push("board:matrix");
  } else if (board.matrix === "stale" || (board.matrixAgeMs != null && board.matrixAgeMs > settings.matrixStaleMs)) {
    add({
      id: "board:matrix",
      severity: "yellow",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: t("doctor.object.matrix"),
      symptom: t("doctor.matrix.stale"),
      evidence: board.matrixAgeMs == null ? "stale" : t("doctor.hours", { hours: Math.round(board.matrixAgeMs / 3_600_000) }),
      suggestion: t("doctor.matrix.staleSuggestion"),
    });
  }
  if (board.missingCwdCount === "unknown") {
    add({
      id: "board:cwd",
      severity: "info",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: "check-missing-cwd",
      symptom: t("doctor.cwd.unknown"),
      evidence: "unknown",
      suggestion: t("doctor.cwd.unknownSuggestion"),
    });
  } else if (board.missingCwdCount > 0) {
    add({
      id: "board:cwd",
      severity: "yellow",
      check: "board",
      project: null,
      card: null,
      taskId: null,
      object: "check-missing-cwd",
      symptom: t("doctor.cwd.missing", { count: board.missingCwdCount }),
      evidence: `count=${board.missingCwdCount}`,
      suggestion: t("doctor.cwd.missingSuggestion"),
    });
  }
  return { done: true, hold };
}

function openLand(scan: DoctorScan, taskId: number): { reason: string; branch: string; conflict: boolean; missingBranch: boolean; mainDirty: boolean } | null {
  const row = taskEvents(scan, taskId).findLast((event) => event.kind === "land_pending");
  if (!row || taskEvents(scan, taskId).some(event => event.id > row.id && (event.kind === "landed" || event.kind === "land_settled"))) return null;
  const data = parseData(row.data_json);
  if (typeof data.reason !== "string" || !data.reason.trim()) return null;
  return {
    reason: data.reason,
    branch: typeof data.branch === "string" ? data.branch : "",
    conflict: data.conflict === true,
    missingBranch: data.missingBranch === true,
    mainDirty: data.mainDirty === true,
  };
}
