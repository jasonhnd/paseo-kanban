/// <reference types="node" />
import { createNativeAgentReader, type NativeAgentReader } from "./native-agent-index";
import { prepareNativeSession, nativeSessionAfterArchive, nativeSessionSettled, processNativeSessionBatch } from "./native-sessions";
import {
  agentAttemptDue,
  agentNeedsReconcile,
  agentStuck,
  agentsClaimedBy,
  agentsMarkedForRelease,
  agentsOpenedBy,
  archiveSucceeded,
  CARD_ERROR_LIMIT,
  cardErrorBlocks,
  STOPPED_RETRY_MS,
  cleanupFinished,
  type CleanupRecord,
  failuresSinceOk,
  hardFailureCount,
  nextRetryAt,
  overdueAgentIds,
  readCleanupEvents,
  readCleanupEventsBatch,
  reconcileSettled,
  restoredReason,
  restoreCount,
  RESTORE_LIMIT,
  restoreStoppedIds,
  restoredLabel,
  retryReady,
  retryDelayMs,
  RETRY_ATTEMPT_LIMIT,
  type RetryAction,
  shortAgentId,
  verifyRecorded,
  waitingOnTurn,
  stuckAgentIds,
  stuckLabel,
  waitReason,
  overdueLabel,
  releaseCleanupBackoff,
} from "./archive-book";
import {
  DEFAULT_ARCHIVE_TIMEOUT_MS,
  DEFAULT_ARCHIVE_VERIFY_MS,
  DEFAULT_CLEANUP_CONCURRENCY,
  DEFAULT_RECONCILE_INTERVAL_MS,
  loadConfig,
} from "./config";
import { getDb } from "./db";
import { isProjectMain, samePath, type ListedWorkspace } from "./placement";
import { appendEvent, getTask, setFinishedListener, setReleaseListener, type TaskRow } from "./store";
import { laneBranchDue, settleLaneBranch } from "./lane";
import { isLaneWorkspace } from "./lane-mark";
import { isTempWorkspace, tempCleaned } from "./temp-mark";
import { rebuiltCleanupPending, overdueTempWorkspaces, settleTempWorkspace, suppressTempArchiveStuck, tempCleanupDue } from "./temp-workspace";
import { createdWorktree, gitRemovalDue, settleOwnedWorktree } from "./worktree-gc";
import { agentOccupiesDirectory, agentsTouching, purgeCardAgents, readCwdAgentList } from "./missing-cwd";
import { wakeKanbanSupervisor, wakeOverdueArchives, type OverdueArchive } from "./wake";
import { round, stage } from "./perf";
import { invalidateAgentIndex } from "./agent-index";
import { t } from "../shared/i18n";
import { cleanupGeneration, currentCleanupSql, holdCleanupCard as holdCard, tryHoldCleanupCard as tryHoldCard, trackCleanupWork } from "./cleanup-state";
import { reconcileGone, resetGoneScan, type GoneReader } from "./cleanup-gone";
import { readWorktreeCreated } from "./worktree-record";

/** What Paseo currently says about one agent. busy means a turn is still in progress. */
export interface AgentSnapshot {
  archived: boolean;
  busy: boolean;
}

export interface CleanupOps {
  archiveAgent(agentId: string): Promise<void>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  listAgents(workspaceId: string): Promise<Array<{ id: string; archived: boolean }>>;
  inspectWorkspace(workspaceId: string): Promise<ListedWorkspace | null>;
  /** Complete, validated, unfiltered inventory. Missing support or any failed page is unknown. */
  listWorkspaceIds?(): Promise<ReadonlySet<string>>;
  /** Omitted means cleanup cannot tell, and treats the agent as idle. A null snapshot means the agent is already gone. */
  inspectAgent?(agentId: string): Promise<AgentSnapshot | null>;
}

export interface CleanupLimits {
  timeoutMs?: number;
  concurrency?: number;
  /**
   * Replacing the Paseo client (every turn end rebinds it) must not zero the
   * sweep clock. Zeroing it made every tick a full verify pass.
   */
  keepSweepClock?: boolean;
}

let ops: CleanupOps | null = null;

/** Thrown by a call that reaches the Paseo client after cleanup was uninstalled. Nothing is recorded for it. */
class CleanupDetached extends Error {
  constructor() {
    super(t("cleanup.detached"));
  }
}

function currentOps(): CleanupOps {
  if (!ops) throw new CleanupDetached();
  return ops;
}

/**
 * What queued operations and the reconcile loop talk to. Every call goes to whichever client is installed right
 * now, so a rebind (every turn end) never leaves a queued job or a half-finished sweep holding a
 * closed client. Without it the old job finished its card on the dead client and wrote a false error row.
 */
const liveOps: CleanupOps = {
  archiveAgent: (agentId) => currentOps().archiveAgent(agentId),
  archiveWorkspace: (workspaceId) => currentOps().archiveWorkspace(workspaceId),
  listAgents: (workspaceId) => currentOps().listAgents(workspaceId),
  inspectWorkspace: (workspaceId) => currentOps().inspectWorkspace(workspaceId),
  listWorkspaceIds: () => {
    const chosen = currentOps();
    if (!chosen.listWorkspaceIds) return Promise.reject(new Error("Workspace inventory unavailable"));
    return chosen.listWorkspaceIds();
  },
  get inspectAgent() {
    const chosen = ops?.inspectAgent;
    return chosen ? (agentId: string) => currentOps().inspectAgent!(agentId) : undefined;
  },
};

let limits: CleanupLimits = {};
const pending = new Set<Promise<void>>();
const queue: number[] = [];
const queued = new Set<number>();
const running = new Set<number>();
const rerun = new Set<number>();
const scheduledAt = new Map<number, Date>();
let active = 0;

/**
 * A timed-out archive keeps running in the background. The key stays until that
 * call settles, so the same agent or workspace is never archived twice at once,
 * and the cleanup slot is free as soon as the timeout fires.
 */
const inflight = new Map<string, Promise<void>>();
let epoch = 0;
/** Bumped when the cleanup state is reset or removed, never by an ordinary rebind. A reconcile pass ends when it changes. */
let generation = 0;
let lastSweep = 0;
let reconciling: Promise<void> | null = null;
/** While a sweep is running: the last card id it has visited. null means no sweep is in progress. */
let sweepCursor: number | null = null;
let resumeRequestCursor = 0;

/**
 * One writer per card at a time. The cleanup job and the reconcile pass both append cleanup rows
 * and decide retries from the rows they read, so two of them on one card wrote duplicate waits and
 * could each reach "stuck" early. The cleanup job waits its turn; reconcile skips a busy card and
 * sees it on a later round.
 */
/**
 * Finished cards whose agents are not all confirmed yet, or that cleanup just touched. Ordinary reconcile
 * rounds look only at these, so their cost follows the cards with work, not every card ever finished. A card
 * leaves the set once every claimed agent is confirmed; the periodic sweep re-checks the rest of the board
 * a page at a time and puts back anything that changed. Memory only: after a restart the first sweep
 * rebuilds it.
 */
const hotCards = new Set<number>();

function markHot(taskId: number): void {
  hotCards.add(taskId);
}
/**
 * Agents that both the Paseo API and the agent records report as gone, with the time that
 * was last confirmed. Without this a purged agent never reaches "verified", so its card
 * stayed unsettled and every tick asked Paseo about it again (hundreds of calls per tick).
 * Ordinary ticks skip a gone agent for GONE_RECHECK_MS; a sweep (every reconcileIntervalMs)
 * always looks again, so one that came back is noticed there. A failed lookup, including an
 * unreadable record, is never "gone". The agents index is refreshed before each pass decides.
 */
const goneAgents = new Map<string, number>();
const GONE_RECHECK_MS = 60 * 60_000;

function knownGone(agentId: string, now: Date): boolean {
  const at = goneAgents.get(agentId);
  return at != null && now.getTime() - at < GONE_RECHECK_MS;
}

export function installCleanup(next: CleanupOps | null, options?: CleanupLimits): () => void {
  epoch += 1;
  // A running reconcile pass is left alone: it reads the client through liveOps and ends on its own
  // when the state is reset below. Clearing the guard here let the next tick start a second pass.
  if (!options?.keepSweepClock || !next) {
    generation += 1;
    lastSweep = 0;
    sweepCursor = null;
    attentionCursor = 0;
    resumeRequestCursor = 0;
    hotCards.clear();
    goneAgents.clear();
    resetGoneScan();
  }
  limits = {
    timeoutMs: options?.timeoutMs,
    concurrency: options?.concurrency,
  };
  if (!next) {
    ops = null;
    setFinishedListener(null);
    setReleaseListener(null);
    return () => {};
  }
  ops = next;
  setFinishedListener((task) => enqueue(task.id));
  setReleaseListener((taskId) => enqueue(taskId));
  return () => {
    if (ops !== next) return;
    ops = null;
    setFinishedListener(null);
    setReleaseListener(null);
  };
}

function timeoutMs(): number {
  if (typeof limits.timeoutMs === "number" && limits.timeoutMs > 0) return limits.timeoutMs;
  return loadConfig().archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS;
}

function concurrencyLimit(): number {
  const chosen = typeof limits.concurrency === "number" && limits.concurrency >= 1 ? limits.concurrency : (loadConfig().cleanupConcurrency ?? DEFAULT_CLEANUP_CONCURRENCY);
  return Math.max(1, Math.floor(chosen));
}

function inflightKey(kind: "agent" | "workspace", id: string): string {
  return `${kind}:${id}`;
}

export function archiveInFlight(kind: "agent" | "workspace", id: string): boolean {
  return inflight.has(inflightKey(kind, id));
}

/** Durable confirmation request for an existing periodic candidate. Never runs cleanup in the CLI.
 * One row per generation/target, including after acknowledgement. No stop/backoff is cleared here.
 */
export function requestRebuiltCleanup(id: number): number | null {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = getTask(id);
    if (!rebuiltCleanupPending(task)) { db.exec("COMMIT"); return null; }
    const target = { cleanupGeneration: cleanupGeneration(id), workspaceId: task.paseo_workspace_id,
      directory: task.workspace_path, branch: readWorktreeCreated(id)?.branch ?? null };
    const previous = db.prepare(`SELECT id FROM events WHERE task_id = ? AND kind = 'cleanup_resume_requested'
      AND json_extract(data_json, '$.cleanupGeneration') = ?
      AND json_extract(data_json, '$.workspaceId') IS ? AND json_extract(data_json, '$.directory') IS ?
      AND json_extract(data_json, '$.branch') IS ?
      AND NOT EXISTS (SELECT 1 FROM events a WHERE a.task_id = events.task_id AND a.kind = 'cleanup_resume_acknowledged'
        AND json_extract(a.data_json, '$.requestId') = events.id AND json_extract(a.data_json, '$.outcome') = 'obsolete')
      ORDER BY id DESC LIMIT 1`)
      .get(id, target.cleanupGeneration, target.workspaceId, target.directory, target.branch) as { id: number } | undefined;
    const requestId = previous?.id ?? Number(db.prepare(`INSERT INTO events (task_id, at, kind, actor, data_json)
      VALUES (?, ?, 'cleanup_resume_requested', 'supervisor', ?)`)
      .run(id, new Date().toISOString(), JSON.stringify({ ...target, execution: "periodic" })).lastInsertRowid);
    db.exec("COMMIT");
    return requestId;
  } catch (err) { db.exec("ROLLBACK"); throw err; }
}

/** Bounded round-robin observation, not an alternate queue. The normal due-card path executes.
 * Acknowledgement proves candidate confirmation only; finished/physical cleanup remain separate evidence.
 */
function confirmResumeRequests(due: ReadonlySet<number>, now: Date): void {
  const db = getDb();
  const read = () => db.prepare(`SELECT r.id, r.task_id, r.data_json FROM events r
    WHERE r.kind = 'cleanup_resume_requested' AND r.id > ?
      AND NOT EXISTS (SELECT 1 FROM events a WHERE a.task_id = r.task_id
        AND a.kind = 'cleanup_resume_acknowledged' AND json_extract(a.data_json, '$.requestId') = r.id)
    ORDER BY r.id LIMIT 100`).all(resumeRequestCursor) as Array<{ id: number; task_id: number; data_json: string }>;
  let requests = read();
  if (!requests.length && resumeRequestCursor) { resumeRequestCursor = 0; requests = read(); }
  for (const row of requests) {
    resumeRequestCursor = row.id;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may already have observed this request while we waited for the write lock.
      const observed = db.prepare(`SELECT 1 FROM events WHERE task_id = ? AND kind = 'cleanup_resume_acknowledged'
        AND json_extract(data_json, '$.requestId') = ? LIMIT 1`).get(row.task_id, row.id);
      if (!observed) {
        const target = JSON.parse(row.data_json) as Record<string, unknown>;
        const task = getTask(row.task_id);
        const sameTarget = target.cleanupGeneration === cleanupGeneration(task.id) && target.workspaceId === task.paseo_workspace_id &&
          target.directory === task.workspace_path && target.branch === (readWorktreeCreated(task.id)?.branch ?? null);
        const obsolete = !sameTarget || (task.status !== "done" && task.status !== "archived");
        const outcome = obsolete ? "obsolete" : cleanupFinished(task.id) ? "already_complete" :
          due.has(task.id) && rebuiltCleanupPending(task) ? "periodic_candidate" : null;
        if (outcome) appendEvent(task.id, "cleanup_resume_acknowledged", null, null, "kanban", {
          ...target, requestId: row.id, outcome, observedAt: now.toISOString(),
        });
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      console.error("[paseo-kanban] cleanup request", err instanceof Error ? err.message : err);
    }
  }
}

/** Owners whose next cleanup must run now because a borrower just released the directory. */
const borrowedKick = new Set<number>();

function kickBorrowedOwner(ownerId: number, now: Date): void {
  releaseCleanupBackoff(ownerId, now);
  borrowedKick.add(ownerId);
  enqueue(ownerId, now);
}

function enqueue(id: number, now = new Date()): void {
  if (!ops) return;
  markHot(id);
  const previous = scheduledAt.get(id);
  if (!previous || now.getTime() > previous.getTime()) scheduledAt.set(id, now);
  if (queued.has(id) || running.has(id)) {
    if (running.has(id)) rerun.add(id);
    return;
  }
  if (cleanupFinished(id) && !failedArchivePending(id, now)) {
    // Closed while a rerun was pending: nothing will run, so the stamp set above would never be dropped.
    scheduledAt.delete(id);
    return;
  }
  queued.add(id);
  queue.push(id);
  pump();
}

function pump(): void {
  if (!ops) return;
  const limit = concurrencyLimit();
  while (active < limit && queue.length > 0) {
    const id = queue.shift();
    if (id == null) break;
    queued.delete(id);
    if (running.has(id)) continue;
    running.add(id);
    active += 1;
    const now = scheduledAt.get(id) ?? new Date();
    const job = round("cleanupJob", () => cleanupBody(id, liveOps, now)).finally(() => {
      running.delete(id);
      active -= 1;
      const again = rerun.delete(id);
      // Nothing pending for this card: drop its stamp, or the map keeps one entry per finished card.
      if (!again && !queued.has(id)) scheduledAt.delete(id);
      if (again) enqueue(id);
      pump();
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
}

export async function flushCleanups(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (pending.size === 0 && queue.length === 0) return;
    if (pending.size === 0) {
      pump();
      await Promise.resolve();
      continue;
    }
    await Promise.all([...pending]);
  }
}

/**
 * An agent opened after cleanup already finished. The failure row is the retry
 * record; success and a stuck agent are left alone, and the workspace is not opened again.
 */
function failedArchivePending(id: number, now: Date, preloaded?: CleanupRecord[]): boolean {
  let task: TaskRow;
  try {
    task = getTask(id);
  } catch {
    return false;
  }
  if (task.status !== "done" && task.status !== "archived") return false;
  const events = preloaded ?? readCleanupEvents(id);
  for (const agentId of agentsOpenedBy(task)) {
    if (archiveSucceeded(events, "archive_agent", agentId)) continue;
    if (agentStuck(events, agentId)) continue;
    const failed = events.some((event) => event.action === "archive_agent" && event.agentId === agentId && event.ok === false);
    if (!failed) continue;
    if (retryReady(events, "archive_agent", agentId, now)) return true;
  }
  return false;
}

/** Cleanup rows loaded ahead for the cards one round is about to judge. */
type PreloadedEvents = ReadonlyMap<number, CleanupRecord[]>;

export function cardDue(id: number, now: Date, preloaded?: PreloadedEvents): boolean {
  const eventsFor = (): CleanupRecord[] => preloaded?.get(id) ?? readCleanupEvents(id);
  if (cleanupFinished(id)) {
    // A finished card is only due again when a failed archive_agent line may still be retryable.
    return failedArchivePending(id, now, preloaded?.get(id));
  }
  let task: TaskRow;
  try {
    task = getTask(id);
  } catch {
    return false;
  }
  if (task.status !== "done" && task.status !== "archived") return releasesDue(id, now, preloaded?.get(id));
  // The card's own cleanup threw and is backing off. Waiting out that backoff is what keeps the log quiet.
  if (cardErrorBlocks(eventsFor(), now)) return false;
  if (isTempWorkspace(task.id) && !tempCleaned(task.id)) return tempCleanupDue(task, now);
  const events = eventsFor();
  const agents = agentsOpenedBy(task);
  let agentsPending = false;
  for (const agentId of agents) {
    if (archiveSucceeded(events, "archive_agent", agentId)) continue;
    if (agentStuck(events, agentId)) continue;
    agentsPending = true;
    if (archiveInFlight("agent", agentId)) {
      if (retryReady(events, "archive_agent", agentId, now)) return true;
      continue;
    }
    if (agentAttemptDue(events, agentId, now)) return true;
  }
  if (agentsPending) return false;
  if (agents.some((agentId) => agentStuck(events, agentId))) return false;
  if (workspaceSettled(events)) return task.workspace_kind === "lane" ? laneBranchDue(task.id, events, now) : gitRemovalDue(task, events, now);
  const workspaceId = task.paseo_workspace_id;
  if (workspaceId && archiveInFlight("workspace", workspaceId)) return false;
  if (workspaceId && !retryReady(events, "archive_workspace", workspaceId, now)) return false;
  return true;
}

/** A reviewer or executor released before the card is done. Stuck agents are left for the wake that already fired. */
function releasesDue(id: number, now: Date, preloaded?: CleanupRecord[]): boolean {
  const events = preloaded ?? readCleanupEvents(id);
  const agents = agentsMarkedForRelease(id).filter((agentId) => !archiveSucceeded(events, "archive_agent", agentId) && !agentStuck(events, agentId));
  if (agents.length === 0) return false;
  for (const agentId of agents) {
    if (archiveInFlight("agent", agentId)) {
      if (retryReady(events, "archive_agent", agentId, now)) return true;
      continue;
    }
    if (agentAttemptDue(events, agentId, now)) return true;
  }
  return false;
}

function workspaceSettled(events: CleanupRecord[]): boolean {
  return events.some(
    (event) =>
      (event.action === "skip_workspace" && event.ok === true) || (event.action === "archive_workspace" && event.ok === true),
  );
}

/**
 * Cards that might need a cleanup step this round, found in one statement and without touching the
 * cards whose cleanup is closed:
 *  - finished (done/archived) cards with no cleanup_finished yet;
 *  - cards that are not finished yet but already released an agent;
 *  - finished cards that still hold a failed archive_agent line no later success covers (retryable).
 * Their cleanup rows are then read in one batch. The cost follows the cards that have work, not the
 * number of cards the board has ever finished.
 */
function candidateCardIds(): number[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks
       WHERE status IN ('done', 'archived')
         AND NOT EXISTS (SELECT 1 FROM events WHERE events.task_id = tasks.id AND events.kind = 'cleanup_finished' AND ${currentCleanupSql("events", "tasks.id")})
       UNION
       SELECT DISTINCT e.task_id AS id FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.kind = 'release_agent' AND t.status NOT IN ('done', 'archived')
       UNION
       SELECT DISTINCT f.task_id AS id FROM events f INDEXED BY events_cleanup_archive_failed
       WHERE f.kind = 'cleanup'
         AND json_extract(f.data_json, '$.action') = 'archive_agent' AND json_extract(f.data_json, '$.ok') = 0
         AND ${currentCleanupSql("f", "f.task_id")}
         AND EXISTS (SELECT 1 FROM events c WHERE c.task_id = f.task_id AND c.kind = 'cleanup_finished' AND ${currentCleanupSql("c", "f.task_id")})
         AND NOT EXISTS (
           SELECT 1 FROM events s WHERE s.task_id = f.task_id AND s.kind = 'cleanup'
             AND json_extract(s.data_json, '$.action') = 'archive_agent'
             AND json_extract(s.data_json, '$.agentId') = json_extract(f.data_json, '$.agentId')
             AND json_extract(s.data_json, '$.ok') = 1 AND ${currentCleanupSql("s", "f.task_id")})`,
    )
    .all() as unknown as Array<{ id: number }>;
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

export function dueCardIds(now = new Date()): number[] {
  const ids = candidateCardIds();
  if (ids.length === 0) return [];
  const preloaded = stage("cleanup.preload", () => readCleanupEventsBatch(ids));
  return ids.filter((id) => cardDue(id, now, preloaded));
}

/**
 * Put due cards on the cleanup queue. Does not wait for them.
 * The deadline note runs before those pending operations finish. An agent whose latest note is
 * still wait_turn is not called stuck here: a late tick may still find the turn running.
 */
export function enqueueCleanups(now = new Date()): void {
  if (!ops) return;
  round("cleanup", () => {
    try {
      const due = stage("cleanup.dueCardIds", () => dueCardIds(now));
      try { stage("cleanup.resumeRequests", () => confirmResumeRequests(new Set(due), now)); }
      catch (err) { console.error("[paseo-kanban] cleanup request", err instanceof Error ? err.message : err); }
      for (const id of due) enqueue(id, now);
    } catch (err) {
      console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
    }
    stage("cleanup.overdue", () => noteOverdueArchives(now));
    scheduleReconcile(now);
  });
  const nativeJob = round("native", () => processNativeSessionBatch({ now })).then(() => {}).catch(err => console.error("[paseo-kanban] native sessions", String(err)));
  pending.add(nativeJob);
  void nativeJob.finally(() => pending.delete(nativeJob));
}

/**
 * One wake per project per round for finished cards whose agents are still open after the
 * deadline or whose temporary workspace was left behind. A card's two kinds share one line.
 */
export function noteOverdueArchives(now = new Date()): void {
  try {
    const found: OverdueArchive[] = [];
    // Cards whose cleanup closed can never be overdue (overdueAgentIds returns [] for them), so skip them in SQL.
    const rows = getDb()
      .prepare(
        `SELECT id FROM tasks WHERE status IN ('done', 'archived')
         AND NOT EXISTS (SELECT 1 FROM events WHERE events.task_id = tasks.id AND kind IN ('cleanup_finished', 'temp_workspace_cleaned') AND ${currentCleanupSql("events", "tasks.id")})
         ORDER BY id`,
      )
      .all() as unknown as Array<{ id: number }>;
    for (const row of rows) {
      const late = overdueAgentIds(row.id, now);
      if (late.length === 0) continue;
      // The copy is waiting on a missing pull request. That wake goes to the project leader, not as "archive stuck".
      if (suppressTempArchiveStuck(row.id)) continue;
      found.push({ taskId: row.id, kind: "deadline", detail: overdueLabel(late.map((agentId) => shortAgentId(agentId)).join(t("common.listSep"))) });
    }
    found.push(...stage("cleanup.overdueTemp", () => overdueTempWorkspaces(now)));
    stage("cleanup.overdueWake", () => wakeOverdueArchives(found, now));
  } catch (err) {
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
  }
}

export async function drainCleanups(now = new Date()): Promise<void> {
  if (!ops) return;
  enqueueCleanups(now);
  for (let i = 0; i < 100 && (pending.size > 0 || queue.length > 0); i += 1) {
    await flushCleanups();
  }
}

/** Steps whose failed retry updates the previous failure row instead of adding another one. */
const MERGED_RETRY_ACTIONS = new Set(["purge_agents", "wait_turn", "archive_agent", "archive_workspace", "remove_worktree", "drop_directory", "wip_commit"]);

function mergesInPlace(data: Omit<CleanupRecord, "at">): boolean {
  if (data.ok !== false || !data.action || !MERGED_RETRY_ACTIONS.has(data.action)) return false;
  // A timed-out archive is counted row by row: three in a row make the agent stuck.
  if (data.action === "archive_agent" && data.outcome !== "error") return false;
  return data.retryAt != null;
}

/** Latest event about the same thing the new row is about: the agent, else the workspace, else the directory. */
function latestAbout(events: readonly CleanupRecord[], data: Omit<CleanupRecord, "at">): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (data.agentId) {
      if (event.agentId === data.agentId) return i;
    } else if (data.workspaceId && !data.directory) {
      if (event.workspaceId === data.workspaceId && !event.agentId) return i;
    } else if (event.directory === data.directory && !event.agentId) {
      return i;
    }
  }
  return -1;
}

/** The attempt limit was reached: automatic retry stops and the supervisor hears once. */
function noteRetryStopped(taskId: number, data: Omit<CleanupRecord, "at">, attempts: number): void {
  const subject = data.agentId ?? data.workspaceId ?? data.directory ?? data.action ?? "cleanup";
  wakeArchive(
    taskId,
    subject,
    t("cleanup.wake.stepStopped", { action: String(data.action), attempts, error: data.error ?? t("cleanup.wake.unknownError") }),
  );
}

function retryTarget(data: Omit<CleanupRecord, "at">): { action: RetryAction; id: string } | null {
  if (!data.action) return null;
  if (data.action === "wait_turn") return data.agentId ? { action: "archive_agent", id: data.agentId } : null;
  const action = data.action as RetryAction;
  if (action === "archive_workspace") return { action, id: data.workspaceId ?? "" };
  if (action === "archive_agent") return { action, id: data.agentId ?? "" };
  return { action, id: data.directory ?? "" };
}

/**
 * Write one cleanup row. A failed retry of the same step as the latest row about the same agent,
 * workspace or directory updates that row in place (attempts, retryAt, error) instead of adding a
 * new one, so a step that keeps failing costs one row, not one per retry. It only merges into a row the
 * step's own failure count still includes: after a success on the same counting target (for a purge
 * that is the directory, whichever agent it was about) the next failure starts a fresh row, so the
 * count, the backoff and the stop below always agree. The attempt that reaches RETRY_ATTEMPT_LIMIT
 * marks the row `stopped` and wakes the supervisor once.
 */
export function record(taskId: number, data: Omit<CleanupRecord, "at">, events: CleanupRecord[]): void {
  data = { cleanupGeneration: cleanupGeneration(taskId), ...data };
  markHot(taskId);
  if (foldRepeatedVerify(taskId, data, events)) return;
  const target = mergesInPlace(data) ? retryTarget(data) : null;
  if (!target) {
    const rowId = appendEvent(taskId, "cleanup", null, null, "kanban", { ...data });
    events.push({ ...data, at: new Date().toISOString(), rowId });
    return;
  }
  const counts = data.action !== "wait_turn";
  const attempt = hardFailureCount(events, target.action, target.id) + 1;
  const stop = counts && attempt >= RETRY_ATTEMPT_LIMIT;
  const row = stop ? { ...data, stopped: true, retryAt: stoppedRetryAt(data.retryAt) } : data;
  const index = latestAbout(events, data);
  const previous = index >= 0 ? events[index] : undefined;
  const counted = failuresSinceOk(events, target.action, target.id);
  if (previous && previous.rowId != null && previous.action === data.action && previous.ok === false && previous.outcome === data.outcome && counted.includes(previous)) {
    const merged: CleanupRecord = { ...previous, ...row, at: previous.at, rowId: previous.rowId, attempts: (previous.attempts ?? 1) + 1 };
    const { at: _at, rowId: _rowId, ...stored } = merged;
    getDb().prepare("UPDATE events SET data_json = ? WHERE id = ?").run(JSON.stringify(stored), previous.rowId);
    events[index] = merged;
  } else {
    const rowId = appendEvent(taskId, "cleanup", null, null, "kanban", { ...row });
    events.push({ ...row, at: new Date().toISOString(), rowId });
  }
  // Woken once: a daily retry that fails again stops quietly.
  if (stop && !counted.some((event) => event.stopped)) noteRetryStopped(taskId, data, attempt);
}

/**
 * A successful verify_agent is only a confirmation: readers want the latest one per agent, and compact-events
 * already keeps just the first and last. So when the newest cleanup row about this agent is itself a successful
 * verify_agent, the repeat updates that row (count, lastAt) instead of adding one. Any other step in between,
 * such as a new archive attempt, makes the next confirmation a fresh row, so `verifyRecorded` still sees the
 * order. The row's own `at` stays the first confirmation. Failed confirmations are never folded.
 */
function foldRepeatedVerify(taskId: number, data: Omit<CleanupRecord, "at">, events: CleanupRecord[]): boolean {
  if (data.action !== "verify_agent" || data.ok !== true || !data.agentId) return false;
  const db = getDb();
  const last = db.prepare(`SELECT id, at, data_json FROM events WHERE task_id = ? AND kind = 'cleanup'
    AND json_extract(data_json, '$.agentId') = ? ORDER BY id DESC LIMIT 1`).get(taskId, data.agentId) as { id: number; at: string; data_json: string } | undefined;
  if (!last) return false;
  const previous = JSON.parse(last.data_json) as Omit<CleanupRecord, "at">;
  if (previous.action !== "verify_agent" || previous.ok !== true || last.id <= data.cleanupGeneration! ||
      (previous.cleanupGeneration ?? data.cleanupGeneration) !== data.cleanupGeneration) return false;
  const lastAt = new Date().toISOString();
  const stored = { ...previous, ...data, summary: 1, count: (previous.count ?? 1) + 1, firstAt: previous.firstAt ?? last.at, lastAt };
  db.prepare("UPDATE events SET data_json = ? WHERE id = ?").run(JSON.stringify(stored), last.id);
  const merged: CleanupRecord = { ...stored, at: last.at, rowId: last.id };
  const index = events.findIndex((event) => event.rowId === last.id);
  if (index >= 0) events[index] = merged;
  else events.push(merged);
  return true;
}

/** When a step that just hit its cap gets its one daily retry: a day after the backoff it would have waited. */
function stoppedRetryAt(retryAt: string | undefined): string {
  const base = retryAt ? Date.parse(retryAt) : Date.now();
  return new Date((Number.isNaN(base) ? Date.now() : base) + STOPPED_RETRY_MS).toISOString();
}

/** Renew a confirmed busy wait in place; keep the event log limited to transitions. */
function recordBusyWait(taskId: number, agentId: string, events: CleanupRecord[], now: Date): void {
  if (!retryReady(events, "archive_agent", agentId, now)) return;
  if (!waitingOnTurn(events, agentId)) {
    record(taskId, { action: "wait_turn", agentId, ok: false, reason: waitReason(), retryAt: nextRetryAt(events, "archive_agent", agentId, now) }, events);
    return;
  }
  const waiting = events.findLast((event) => event.action === "wait_turn" && event.agentId === agentId);
  if (!waiting) return;
  const db = getDb();
  const row = db.prepare(`SELECT id, data_json FROM events
    WHERE task_id = ? AND kind = 'cleanup'
      AND json_extract(data_json, '$.action') = 'wait_turn'
      AND json_extract(data_json, '$.agentId') = ?
      AND ${currentCleanupSql("events", "events.task_id")} ORDER BY id DESC LIMIT 1`).get(taskId, agentId) as { id: number; data_json: string } | undefined;
  if (!row) return;
  const progress = JSON.parse(row.data_json) as CleanupRecord & { waitChecks?: number };
  // Another cleanup path may have renewed this row while we inspected Paseo.
  if (progress.retryAt && now.getTime() < Date.parse(progress.retryAt)) {
    Object.assign(waiting, progress);
    return;
  }
  const waitChecks = (progress.waitChecks ?? 1) + 1;
  // Retain any archive-failure backoff that preceded this waiting episode.
  const delay = Math.max(retryDelayMs(waitChecks), Date.parse(nextRetryAt(events, "archive_agent", agentId, now)) - now.getTime());
  const retryAt = new Date(now.getTime() + delay).toISOString();
  db.prepare("UPDATE events SET data_json = json_set(data_json, '$.retryAt', ?, '$.waitChecks', ?) WHERE id = ?")
    .run(retryAt, waitChecks, row.id);
  Object.assign(waiting, { retryAt, waitChecks });
}

function recordFailure(
  taskId: number,
  events: CleanupRecord[],
  data: Omit<CleanupRecord, "at" | "retryAt"> & { action: "archive_agent" | "archive_workspace" },
  now: Date,
): void {
  const id = data.action === "archive_workspace" ? (data.workspaceId ?? "") : (data.agentId ?? "");
  record(taskId, { ...data, retryAt: nextRetryAt(events, data.action, id, now) }, events);
}

function verifyDelayMs(): number {
  return loadConfig().archiveVerifyMs ?? DEFAULT_ARCHIVE_VERIFY_MS;
}

function verifyAtFrom(now: Date): string {
  return new Date(now.getTime() + verifyDelayMs()).toISOString();
}

function wakeArchive(taskId: number, agentId: string, detail: string): void {
  try {
    wakeKanbanSupervisor({ taskId, kind: "archive_stuck", detail, subject: agentId });
  } catch (err) {
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
  }
}

/** null is gone (no file and no Paseo record). A throw is unknown and is retried. */
async function readActivity(chosen: CleanupOps, agentId: string): Promise<"busy" | "idle" | "gone" | "unknown"> {
  if (!chosen.inspectAgent) return "idle";
  try {
    const snap = await chosen.inspectAgent(agentId);
    if (!snap) return "gone";
    return snap.busy ? "busy" : "idle";
  } catch (err) {
    if (err instanceof CleanupDetached) throw err;
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
    return "unknown";
  }
}

function noteLateSuccess(taskId: number, kind: "agent" | "workspace", id: string, boundary: number): void {
  const data =
    kind === "agent"
      ? { action: "archive_agent", agentId: id, ok: true, late: true, verifyAt: verifyAtFrom(new Date()) }
      : { action: "archive_workspace", workspaceId: id, ok: true, late: true };
  try {
    appendEvent(taskId, "cleanup", null, null, "kanban", { ...data, cleanupGeneration: boundary });
    if (kind === "agent") nativeSessionAfterArchive(taskId, id);
  } catch (err) {
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
    return;
  }
  enqueue(taskId);
}

type ArchiveCall = "ok" | "timeout" | "busy" | { error: string };

function callArchive(taskId: number, kind: "agent" | "workspace", id: string, fn: () => Promise<void>): Promise<ArchiveCall> {
  const key = inflightKey(kind, id);
  if (inflight.has(key)) return Promise.resolve("busy");
  const mine = epoch;
  const boundary = cleanupGeneration(taskId);
  let timedOut = false;
  const job = Promise.resolve().then(fn);
  inflight.set(key, job);
  trackCleanupWork(taskId, job);
  const clear = () => {
    if (inflight.get(key) === job) inflight.delete(key);
  };
  void job.then(
    () => {
      clear();
      if (timedOut && mine === epoch) noteLateSuccess(taskId, kind, id, boundary);
    },
    () => {
      clear();
    },
  );
  const ms = timeoutMs();
  return new Promise((resolve) => {
    // Stay referenced. An unref'd timer never fires when this await is the only
    // handle left, so a hung archive would skip the timeout record.
    const timer = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, ms);
    job.then(
      () => {
        clearTimeout(timer);
        if (!timedOut) resolve("ok");
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (timedOut) return;
        // Cleanup was uninstalled while this call was starting: not a failure of the archive.
        resolve(err instanceof CleanupDetached ? "busy" : { error: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}

/**
 * The cleanup threw for this card. The error is one row per episode: a repeat updates it in place with
 * a retryAt (1, 5, then 30 minutes) and a count. At CARD_ERROR_LIMIT it is marked `stopped`, the supervisor
 * is told once, and the card is left alone for a day (its retryAt) before one more try, or until
 * `resume-cleanup`. A try that throws again stops it again without another wake. It used to add a row every
 * minute for as long as the cause lasted.
 */
export function recordCardError(taskId: number, error: string, now: Date): void {
  markHot(taskId);
  const events = readCleanupEvents(taskId, { verify: false });
  const last = events.findLast((event) => event.action !== "verify_agent");
  // An open stop counts as the episode even after other rows were written behind it.
  const open = events.findLast((event) => event.action === "error" && event.stopped && !event.resolved);
  const previous = open?.rowId != null ? open : last?.action === "error" && last.rowId != null ? last : null;
  const attempts = (previous?.attempts ?? (previous ? 1 : 0)) + 1;
  const stop = attempts >= CARD_ERROR_LIMIT;
  const retryAt = new Date(now.getTime() + (stop ? STOPPED_RETRY_MS : retryDelayMs(attempts))).toISOString();
  const data = {
    action: "error",
    cleanupGeneration: cleanupGeneration(taskId),
    ok: false,
    outcome: "error",
    error,
    attempts,
    retryAt,
    ...(stop ? { stopped: true } : {}),
  };
  if (previous?.rowId != null) getDb().prepare("UPDATE events SET data_json = ? WHERE id = ?").run(JSON.stringify(data), previous.rowId);
  else appendEvent(taskId, "cleanup", null, null, "kanban", data);
  if (stop && !previous?.stopped) wakeArchive(taskId, "cleanup_error", t("cleanup.wake.cardStopped", { attempts, error }));
}

/** A cleanup of a card whose stopped error row has come due went through: that row no longer holds the card. */
function settleCardError(taskId: number): void {
  const events = readCleanupEvents(taskId, { verify: false });
  const open = events.findLast((event) => event.action === "error" && event.stopped && !event.resolved);
  if (open?.rowId == null) return;
  const { at: _at, rowId: _rowId, ...stored } = open;
  getDb().prepare("UPDATE events SET data_json = ? WHERE id = ?").run(JSON.stringify({ ...stored, stopped: false, resolved: true }), open.rowId);
}

async function cleanupBody(id: number, chosen: CleanupOps, now: Date): Promise<void> {
  const release = await holdCard(id, 2 * timeoutMs());
  if (!release) {
    console.error("[paseo-kanban] cleanup", `card ${id}: another writer kept holding it; skipping this round`);
    return;
  }
  try {
    // A failure row may have been written after the kick, while this card was still running.
    if (borrowedKick.delete(id)) releaseCleanupBackoff(id, now);
    if (cardErrorBlocks(readCleanupEvents(id, { verify: false }), now)) return;
    await cleanupInner(id, chosen, now);
    settleCardError(id);
  } catch (err) {
    if (err instanceof CleanupDetached) return;
    const error = err instanceof Error ? err.message : String(err);
    console.error("[paseo-kanban] cleanup", error);
    try {
      recordCardError(id, error, now);
    } catch (writeErr) {
      console.error("[paseo-kanban] cleanup event", writeErr instanceof Error ? writeErr.message : writeErr);
    }
  } finally {
    release();
  }
}

async function archiveAgents(id: number, agents: string[], events: CleanupRecord[], chosen: CleanupOps, now: Date): Promise<boolean> {
  let agentsOk = true;
  for (const agentId of agents) {
    if (archiveSucceeded(events, "archive_agent", agentId)) continue;
    if (agentStuck(events, agentId)) {
      wakeArchive(id, agentId, stuckLabel(agentId));
      agentsOk = false;
      continue;
    }
    const ready = retryReady(events, "archive_agent", agentId, now);
    // wait_turn stays due every tick. Idle skips the backoff; still busy does not write another wait.
    const holding = waitingOnTurn(events, agentId);
    if (!ready && !holding) {
      agentsOk = false;
      continue;
    }
    if (archiveInFlight("agent", agentId)) {
      if (!ready) {
        agentsOk = false;
        continue;
      }
      recordFailure(id, events, { action: "archive_agent", agentId, ok: false, outcome: "timeout", error: t("cleanup.error.timeout") }, now);
      if (agentStuck(events, agentId)) wakeArchive(id, agentId, stuckLabel(agentId));
      agentsOk = false;
      continue;
    }
    const activity = await readActivity(chosen, agentId);
    // A leader may resume this executor while inspectAgent is awaiting Paseo.
    const current = getTask(id);
    if (current.status !== "done" && current.status !== "archived" && !agentsMarkedForRelease(id).includes(agentId)) continue;
    // null from inspect is "gone": daemonAgentMissing ("Agent not found") and no record file.
    // A thrown inspect is "unknown" (timeout, connection) and still backs off.
    if (activity === "gone") {
      await prepareNativeSession(id, agentId);
      record(id, { action: "archive_agent", agentId, ok: true, verifyAt: verifyAtFrom(now), reason: t("cleanup.reason.gone") }, events);
      nativeSessionAfterArchive(id, agentId);
      continue;
    }
    if (activity === "unknown") {
      if (!ready) {
        agentsOk = false;
        continue;
      }
      recordFailure(id, events, { action: "archive_agent", agentId, ok: false, outcome: "error", error: t("cleanup.error.unreadable") }, now);
      agentsOk = false;
      continue;
    }
    if (activity === "busy") {
      recordBusyWait(id, agentId, events, now);
      agentsOk = false;
      continue;
    }
    if (waitingOnTurn(events, agentId)) record(id, { action: "turn_idle", agentId, ok: true }, events);
    await prepareNativeSession(id, agentId);
    if (!stillFinished(id) && !agentsMarkedForRelease(id).includes(agentId)) continue;
    const result = await callArchive(id, "agent", agentId, () => chosen.archiveAgent(agentId));
    if (result === "busy") {
      agentsOk = false;
      continue;
    }
    if (result === "ok") {
      record(id, { action: "archive_agent", agentId, ok: true, verifyAt: verifyAtFrom(now) }, events);
      nativeSessionAfterArchive(id, agentId);
      continue;
    }
    agentsOk = false;
    if (result === "timeout") {
      recordFailure(id, events, { action: "archive_agent", agentId, ok: false, outcome: "timeout", error: t("cleanup.error.timeout") }, now);
      if (agentStuck(events, agentId)) wakeArchive(id, agentId, stuckLabel(agentId));
      continue;
    }
    recordFailure(id, events, { action: "archive_agent", agentId, ok: false, outcome: "error", error: result.error }, now);
  }
  return agentsOk;
}

/** Re-read right before a workspace or worktree step: the status taken at job start goes stale across awaits. */
function stillFinished(id: number): boolean {
  const status = getTask(id).status;
  return status === "done" || status === "archived";
}

async function cleanupInner(id: number, chosen: CleanupOps, now: Date): Promise<void> {
  const task = getTask(id);
  const terminal = task.status === "done" || task.status === "archived";
  const boundary = cleanupGeneration(id);
  const finish = () => {
    if (stillFinished(id) && cleanupGeneration(id) === boundary && !cleanupFinished(id))
      appendEvent(id, "cleanup_finished", null, null, "kanban", { cleanupGeneration: boundary });
  };
  if (terminal && cleanupFinished(id)) {
    if (!failedArchivePending(id, now)) return;
    const events = readCleanupEvents(id);
    const pending = agentsOpenedBy(task).filter((agentId) => {
      if (archiveSucceeded(events, "archive_agent", agentId)) return false;
      return events.some((event) => event.action === "archive_agent" && event.agentId === agentId && event.ok === false);
    });
    await archiveAgents(id, pending, events, chosen, now);
    return;
  }
  if (terminal && isTempWorkspace(id)) {
    if (tempCleaned(id)) {
      finish();
      return;
    }
    const events = readCleanupEvents(id);
    const outcome = await settleTempWorkspace({
      task,
      events,
      now,
      record: (data) => record(id, data, events),
      archiveWorkspace: async (workspaceId) => {
        const result = await callArchive(id, "workspace", workspaceId, () => chosen.archiveWorkspace(workspaceId));
        if (result === "ok") return;
        if (result === "busy") throw new Error(t("cleanup.error.busy"));
        if (result === "timeout") throw new Error(t("cleanup.error.timeout"));
        throw new Error(result.error);
      },
      decideWorkspace: () => workspaceDecision(task, agentsOpenedBy(task), chosen),
      agentActivity: (agentId) => readActivity(chosen, agentId),
    });
    if (outcome === "pending") return;
    finish();
    return;
  }
  const events = readCleanupEvents(id);
  const opened = agentsOpenedBy(task);
  const targets = terminal ? opened : agentsMarkedForRelease(id);
  if (!terminal && targets.length === 0) return;
  const agentsOk = await archiveAgents(id, targets, events, chosen, now);
  if (!terminal || !agentsOk || !stillFinished(id)) return;

  const decision = await workspaceDecision(task, opened, chosen);
  // A card reopened while Paseo answered keeps its workspace and worktree (DEMO_0001).
  if (!stillFinished(id)) return;
  if (decision.action === "retry") {
    const last = events.at(-1);
    if (!(last?.action === "skip_workspace" && last.reason === decision.reason)) {
      record(id, { action: "skip_workspace", reason: decision.reason, ok: false }, events);
    }
    return;
  }
  if (decision.action === "archive") {
    if (!retryReady(events, "archive_workspace", decision.workspaceId, now)) return;
    const result = await callArchive(id, "workspace", decision.workspaceId, () => chosen.archiveWorkspace(decision.workspaceId));
    if (result === "busy") return;
    if (result === "ok") {
      record(id, { action: "archive_workspace", workspaceId: decision.workspaceId, ok: true }, events);
    } else if (result === "timeout") {
      recordFailure(
        id,
        events,
        {
          action: "archive_workspace",
          workspaceId: decision.workspaceId,
          ok: false,
          outcome: "timeout",
          error: t("cleanup.error.timeout"),
        },
        now,
      );
      return;
    } else {
      recordFailure(
        id,
        events,
        {
          action: "archive_workspace",
          workspaceId: decision.workspaceId,
          ok: false,
          outcome: "error",
          error: result.error,
        },
        now,
      );
      return;
    }
  } else if (!workspaceSettled(events)) {
    record(id, { action: "skip_workspace", reason: decision.reason, ok: true }, events);
  }
  if (!stillFinished(id)) return;
  // A lane is a long-lived worktree. Cleanup may delete the card branch after it
  // is merged, and never removes the lane directory or archives the lane workspace.
  // A per-card worktree is removed inside settleOwnedWorktree, which first purges
  // finished Kanban agents and then leaves a placeholder for any agent it cannot delete.
  const git =
    task.workspace_kind === "lane"
      ? await settleLaneBranch({
          task,
          events,
          now,
          timeoutMs: timeoutMs(),
          record: (data) => record(id, data, events),
        })
      : await settleOwnedWorktree({
          task,
          events,
          now,
          timeoutMs: timeoutMs(),
          record: (data) => record(id, data, events),
          agentActivity: (agentId) => readActivity(chosen, agentId),
        });
  if (git === "pending") return;
  if (!(await releaseBorrowedClaim(id, now))) return;
  finish();
}

/**
 * This card followed another card's temporary workspace. Delete only this card's agents, then
 * let the owner retry at once. A live agent of ours still holds the claim, so cleanup stays open
 * and tries again. An unfinished owner is left to its own shared wait.
 */
async function releaseBorrowedClaim(id: number, now: Date): Promise<boolean> {
  const task = getTask(id);
  if (isTempWorkspace(id)) return true;
  const workspaceId = task.paseo_workspace_id;
  if (!workspaceId) return true;
  const others = getDb().prepare("SELECT id, status FROM tasks WHERE paseo_workspace_id = ? AND id != ?").all(workspaceId, id) as Array<{ id: number; status: string }>;
  const owners = others.filter((row) => (row.status === "done" || row.status === "archived") && isTempWorkspace(row.id) && createdWorktree(row.id));
  if (owners.length === 0) return true;
  try {
    await purgeCardAgents(id);
  } catch (err) {
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
    return false;
  }
  invalidateAgentIndex();
  const current = getTask(id);
  const mine = new Set(agentsOpenedBy(current));
  let held = false;
  for (const owner of owners) {
    const directory = createdWorktree(owner.id)?.directory;
    if (!directory) continue;
    const listed = readCwdAgentList();
    const occupies = listed == null || agentsTouching(directory, listed).some((agent) => mine.has(agent.id) && agentOccupiesDirectory(agent));
    if (occupies) {
      held = true;
      continue;
    }
    kickBorrowedOwner(owner.id, now);
  }
  return !held;
}

export async function workspaceDecision(
  task: TaskRow,
  agents: string[],
  chosen: CleanupOps,
): Promise<{ action: "skip"; reason: string } | { action: "retry"; reason: string } | { action: "archive"; workspaceId: string; directory: string }> {
  if (task.workspace_kind === "lane" || isLaneWorkspace(task.paseo_workspace_id, task.workspace_path)) return { action: "skip", reason: "lane" };
  if (task.workspace_kind !== "worktree") return { action: "skip", reason: "not_worktree" };
  const workspaceId = task.paseo_workspace_id;
  if (!workspaceId) return { action: "skip", reason: "missing_id" };
  const others = getDb().prepare("SELECT status FROM tasks WHERE paseo_workspace_id = ? AND id != ?").all(workspaceId, task.id) as Array<{ status: string }>;
  if (others.some((row) => row.status !== "done" && row.status !== "archived")) return { action: "retry", reason: "shared" };
  let snapshot: ListedWorkspace | null;
  try {
    snapshot = await chosen.inspectWorkspace(workspaceId);
  } catch {
    return { action: "retry", reason: "inspect_failed" };
  }
  if (!snapshot) return { action: "skip", reason: "gone" };
  if (isLaneWorkspace(workspaceId, snapshot.directory)) return { action: "skip", reason: "lane" };
  if (snapshot.archived || snapshot.kind !== "worktree" || isProjectMain(snapshot) || samePath(snapshot.directory, snapshot.projectRoot)) {
    return { action: "skip", reason: "main" };
  }
  let live: Array<{ id: string; archived: boolean }> = [];
  try {
    live = await chosen.listAgents(workspaceId);
  } catch {
    return { action: "retry", reason: "agents_failed" };
  }
  const ours = new Set(agents);
  if (live.some((agent) => !agent.archived && !ours.has(agent.id))) return { action: "retry", reason: "live_agents" };
  return { action: "archive", workspaceId, directory: snapshot.directory ?? "" };
}

function scheduleReconcile(now: Date): void {
  if (!ops?.inspectAgent && !ops?.listWorkspaceIds) return;
  if (reconciling) return;
  const mine = generation;
  const job = round("reconcile", () => reconcileBody(liveOps, now, mine)).finally(() => {
    if (reconciling === job) reconciling = null;
  });
  reconciling = job;
  pending.add(job);
  void job.finally(() => pending.delete(job));
}

/** Finished cards one sweep visits per round. A sweep over a long board is spread across rounds, not run in one. */
export const RECONCILE_SWEEP_CHUNK = 100;
/** Cards that are not confirmed yet (hot) one round looks at. Beyond this the rest rotate in on later rounds. */
export const RECONCILE_ATTENTION_CAP = 100;
/** A round stops starting new cards after this long; what is left waits for the next round. */
export const RECONCILE_ROUND_BUDGET_MS = 30_000;

/** The ids after `after`, wrapping around to the start, at most `limit` of them. */
function rotateFrom(ids: readonly number[], after: number, limit: number): number[] {
  const start = ids.findIndex((id) => id > after);
  const from = start < 0 ? 0 : start;
  return [...ids.slice(from), ...ids.slice(0, from)].slice(0, limit);
}

/** Where the round-robin over hot cards stopped. */
let attentionCursor = 0;

/** What the last reconcile round read and visited, so a test (or a log line) can see the scan work, not just the statements. */
export interface ReconcileScanStats {
  /** Finished-card rows read from the tasks table this round. Zero outside a sweep. */
  rowsRead: number;
  /** Cards handed to reconcileTask this round. */
  visited: number;
}
let lastScan: ReconcileScanStats = { rowsRead: 0, visited: 0 };

export function reconcileScanStats(): ReconcileScanStats {
  return { ...lastScan };
}

/**
 * One reconcile round. Ordinary rounds look only at hot cards (not yet confirmed, or just touched by
 * cleanup), straight from memory: they read no finished-card rows at all. The periodic sweep walks
 * the finished cards RECONCILE_SWEEP_CHUNK at a time with an id cursor and LIMIT, so a round reads and
 * visits a bounded number of rows however many cards the board has finished, and the sweep still finds
 * an agent that came back on a card nobody was watching. The 1-minute verify pass is never held up
 * behind one huge pass.
 */
async function reconcileBody(chosen: CleanupOps, now: Date, mine: number): Promise<void> {
  const interval = loadConfig().reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  let freshIndex = false;
  if (sweepCursor == null && now.getTime() - lastSweep >= interval) {
    sweepCursor = 0;
    lastSweep = now.getTime();
  }
  const cursor = sweepCursor;
  let chunk: number[] = [];
  if (cursor != null) {
    try {
      chunk = stage("reconcile.list", () =>
        (getDb()
          .prepare("SELECT id FROM tasks WHERE status IN ('done', 'archived') AND id > ? ORDER BY id LIMIT ?")
          .all(cursor, RECONCILE_SWEEP_CHUNK) as unknown as Array<{ id: number }>).map((row) => row.id),
      );
    } catch (err) {
      console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
      return;
    }
  }
  const swept = new Set(chunk);
  const hot = [...hotCards].filter((id) => !swept.has(id)).sort((a, b) => a - b);
  const attention = rotateFrom(hot, attentionCursor, RECONCILE_ATTENTION_CAP);
  const todo = [...chunk, ...attention].sort((a, b) => a - b);
  lastScan = { rowsRead: chunk.length, visited: todo.length };
  const readAgent = createNativeAgentReader();
  // A sweep decides "gone" against the agents directory as it is now, not as of the index's last listing.
  // An ordinary round does that only for an agent it is about to call gone (see refreshIndex).
  if (chunk.length > 0) {
    invalidateAgentIndex();
    freshIndex = true;
  }
  /** True when this call refreshed the listing, so asking again can give a different answer. */
  const refreshIndex = (): boolean => {
    if (freshIndex) return false;
    invalidateAgentIndex();
    freshIndex = true;
    return true;
  };
  const started = performance.now();
  // One complete inventory per round, loaded only if a workspace failure needs it.
  // A failed/incomplete inventory stays unknown for the entire round.
  let workspaceIds: Promise<ReadonlySet<string>> | undefined;
  const workspaceInventory = () => workspaceIds ??= boundedRead(() => chosen.listWorkspaceIds!(), Math.min(timeoutMs(), RECONCILE_ROUND_BUDGET_MS - (performance.now() - started)));
  let lastSwept = cursor ?? 0;
  let lastAttended = attentionCursor;
  let completed = true;
  for (const id of todo) {
    if (mine !== generation || !ops) return;
    if (performance.now() - started >= RECONCILE_ROUND_BUDGET_MS) {
      completed = false;
      break;
    }
    try {
      await stage("reconcile.card", () => reconcileTask(id, chosen, now, swept.has(id), readAgent, refreshIndex, workspaceInventory, mine, started));
    } catch (err) {
      if (err instanceof CleanupDetached) return;
      console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
    }
    if (swept.has(id)) lastSwept = id;
    else lastAttended = id;
  }
  if (mine !== generation) return;
  attentionCursor = lastAttended;
  if (cursor != null) sweepCursor = chunk.length < RECONCILE_SWEEP_CHUNK && completed ? null : lastSwept;
}

async function reconcileTask(
  id: number,
  chosen: CleanupOps,
  now: Date,
  sweep: boolean,
  readAgent: NativeAgentReader,
  refreshIndex: () => boolean,
  workspaceInventory: GoneReader["workspaceIds"],
  mine: number,
  roundStarted: number,
): Promise<void> {
  // The cleanup job owns the card right now; this card is looked at on a later round.
  const release = tryHoldCard(id);
  if (!release) return;
  try {
    await reconcileLocked(id, chosen, now, sweep, readAgent, refreshIndex, workspaceInventory, mine, roundStarted);
  } finally {
    release();
  }
}

async function reconcileLocked(id: number, chosen: CleanupOps, now: Date, sweep: boolean, readAgent: NativeAgentReader, refreshIndex: () => boolean, workspaceInventory: GoneReader["workspaceIds"], mine: number, roundStarted: number): Promise<void> {
  if (!sweep && !hotCards.has(id)) return;
  const task = getTask(id);
  if (task.status !== "done" && task.status !== "archived") {
    hotCards.delete(id);
    return;
  }
  const events = readCleanupEvents(id);
  if (sweep) {
    let reading = true;
    const budget = Math.min(timeoutMs(), RECONCILE_ROUND_BUDGET_MS - (performance.now() - roundStarted));
    try {
      await boundedRead(() => reconcileGone(task, events, {
        workspaceIds: workspaceInventory,
        agent: (agentId) => {
          if (!chosen.inspectAgent) return Promise.reject(new Error("Agent inspection unavailable"));
          return chosen.inspectAgent(agentId);
        },
        now,
        current: () => reading && mine === generation && Boolean(ops) && stillFinished(id) && performance.now() - roundStarted < RECONCILE_ROUND_BUDGET_MS,
      }, data => record(id, data, events)), budget);
    } catch {
      // Only absence may resolve a failure. A hung read leaves the original row and retry clock intact.
    } finally { reading = false; }
    if (mine !== generation || !ops || !stillFinished(id)) return;
  }
  const finished = cleanupFinished(id);
  if (finished && reconcileSettled(events, agentsClaimedBy(task).filter((agentId) => !knownGone(agentId, now)), now, finished)) {
    // Already confirmed. A sweep still looks once, so an agent that came back is noticed there.
    // Ordinary rounds do not: the card leaves the hot set.
    if (!sweep) {
      hotCards.delete(id);
      return;
    }
  }
  for (const agentId of stuckAgentIds(events)) wakeArchive(id, agentId, stuckLabel(agentId));
  for (const agentId of restoreStoppedIds(events)) wakeArchive(id, agentId, restoredLabel(agentId));
  const claimed = new Set(agentsClaimedBy(task));
  for (const agentId of claimed) {
    if (agentStuck(events, agentId) && !archiveSucceeded(events, "archive_agent", agentId)) continue;
    if (restoreStoppedIds(events).includes(agentId)) continue;
    if (!agentNeedsReconcile(events, agentId, now, sweep, finished)) continue;
    if (archiveInFlight("agent", agentId)) {
      if (retryReady(events, "archive_agent", agentId, now)) {
        recordFailure(id, events, { action: "archive_agent", agentId, ok: false, outcome: "timeout", error: t("cleanup.error.timeout") }, now);
        if (agentStuck(events, agentId)) wakeArchive(id, agentId, stuckLabel(agentId));
      }
      continue;
    }
    // A sweep looks at every agent again, including the ones last seen gone.
    if (!sweep && knownGone(agentId, now)) continue;
    let looked = await inspectClaimed(chosen, agentId);
    if (looked.failed) continue;
    if (!looked.snapshot && refreshIndex()) {
      // Gone is decided against a fresh listing of the agents directory, refreshed once per round.
      looked = await inspectClaimed(chosen, agentId);
      if (looked.failed) continue;
    }
    if (!stillFinished(id)) return;
    const snap = looked.snapshot;
    if (!snap) {
      goneAgents.set(agentId, now.getTime());
      continue;
    }
    goneAgents.delete(agentId);
    if (snap.archived) {
      // One confirmation, including when this database never recorded archive_agent ok.
      // A later archive, wait, or restore clears that confirm so the next look can write again.
      if (!verifyRecorded(events, agentId)) record(id, { action: "verify_agent", agentId, ok: true }, events);
      if (!nativeSessionSettled(agentId)) {
        await prepareNativeSession(id, agentId, { readAgent });
        nativeSessionAfterArchive(id, agentId);
      }
      continue;
    }
    if (snap.busy) {
      recordBusyWait(id, agentId, events, now);
      continue;
    }
    if (restoreCount(events, agentId) >= RESTORE_LIMIT) {
      record(id, { action: "restore_stuck", agentId, ok: false, reason: restoredLabel(agentId) }, events);
      wakeArchive(id, agentId, restoredLabel(agentId));
      continue;
    }
    // A failed archive waits out its backoff here too; an idle wait is due at once, as in the cleanup job.
    if (!retryReady(events, "archive_agent", agentId, now) && !waitingOnTurn(events, agentId)) continue;
    const prior = archiveSucceeded(events, "archive_agent", agentId);
    if (waitingOnTurn(events, agentId)) record(id, { action: "turn_idle", agentId, ok: true }, events);
    await prepareNativeSession(id, agentId, { readAgent });
    if (!stillFinished(id)) return;
    const result = await callArchive(id, "agent", agentId, () => chosen.archiveAgent(agentId));
    if (result === "busy") continue;
    if (result === "ok") {
      record(
        id,
        {
          action: "archive_agent",
          agentId,
          ok: true,
          restored: prior,
          ...(prior ? { reason: restoredReason() } : {}),
          verifyAt: verifyAtFrom(now),
        },
        events,
      );
      nativeSessionAfterArchive(id, agentId);
      continue;
    }
    if (result === "timeout") {
      recordFailure(id, events, { action: "archive_agent", agentId, ok: false, outcome: "timeout", error: t("cleanup.error.timeout") }, now);
      if (agentStuck(events, agentId)) wakeArchive(id, agentId, stuckLabel(agentId));
      continue;
    }
    recordFailure(id, events, { action: "archive_agent", agentId, ok: false, outcome: "error", error: result.error }, now);
  }
  if (finished && reconcileSettled(events, [...claimed].filter((agentId) => !knownGone(agentId, now)), now, finished)) hotCards.delete(id);
  else hotCards.add(id);
}

/** A read cannot occupy a reconcile slot indefinitely. Late results cannot write through GoneReader.current. */
function boundedRead<T>(read: () => Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("Reconcile read budget exhausted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Reconcile read timed out")), ms);
    Promise.resolve().then(read).then(value => { clearTimeout(timer); resolve(value); }, err => { clearTimeout(timer); reject(err); });
  });
}

/** A failed lookup (timeout, dropped connection) is not an answer; a null snapshot is "gone". */
async function inspectClaimed(chosen: CleanupOps, agentId: string): Promise<{ failed: boolean; snapshot: AgentSnapshot | null }> {
  if (!chosen.inspectAgent) return { failed: true, snapshot: null };
  try {
    return { failed: false, snapshot: await stage("reconcile.inspectAgent", () => boundedRead(() => chosen.inspectAgent!(agentId), timeoutMs())) };
  } catch (err) {
    if (err instanceof CleanupDetached) throw err;
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
    return { failed: true, snapshot: null };
  }
}

export function cleanupScheduledCountForTests(): number {
  return scheduledAt.size;
}
