/// <reference types="node" />
import { DEFAULT_ARCHIVE_DEADLINE_MS, loadConfig } from "./config";
import { getDb } from "./db";
import { pendingLand } from "./land-pending";
import { isLaneWorkspace } from "./lane-mark";
import type { TaskRow } from "./store";
import { t } from "../shared/i18n";
import { cleanupGeneration, cleanupGenerationSql, cleanupMark } from "./cleanup-state";

/** 1 minute, then 5, then 30. Further failures stay at 30 minutes. */
export const CLEANUP_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
/**
 * After this many failed attempts at one step, automatic retry stops: the failure row is marked
 * `stopped`, the Kanban supervisor is told once, and nothing retries it (cleanup, reconcile and a
 * restart all read the mark) until STOPPED_RETRY_MS later, when it gets one more try on its own; that try
 * failing stops it again without another wake. `bin/kanban resume-cleanup <card number>` retries at once. The row
 * is updated in place, so the log does not grow.
 */
export const RETRY_ATTEMPT_LIMIT = 12;
/** A stopped step or card is tried once more this long after it stopped (its retryAt is set that far out). */
export const STOPPED_RETRY_MS = 24 * 60 * 60_000;
/** A cleanup that throws for the whole card stops retrying after this many failures in a row. */
export const CARD_ERROR_LIMIT = RETRY_ATTEMPT_LIMIT;
export const STUCK_TIMEOUTS = 3;
/** A cleanup step that keeps failing stops after this many failures; the branch is kept. */
export const DELETE_BRANCH_RETRY_LIMIT = 12;
/** Re-archive this many times. The next time the agent comes back, stop and wake the Kanban supervisor. */
export const RESTORE_LIMIT = 3;
/** Reason written on a wait_turn cleanup row (shown to people, never compared). */
export function waitReason(): string {
  return t("archiveBook.reason.waitTurn");
}
/** Reason written on a re-archive after Paseo restored the agent (shown to people, never compared). */
export function restoredReason(): string {
  return t("archiveBook.reason.restored");
}

export interface CleanupRecord {
  /** The events row this record was read from or written to. Lets a retry update it in place. */
  rowId?: number;
  /** Successful rebuild event that owns this attempt (0 before any rebuild). */
  cleanupGeneration?: number;
  at: string;
  action?: string;
  reason?: string;
  ok?: boolean;
  agentId?: string;
  error?: string;
  workspaceId?: string;
  directory?: string;
  branch?: string;
  outcome?: "timeout" | "error";
  /** When the next automatic attempt is allowed. Compared with the cleanup clock, not the row's wall time. */
  retryAt?: string;
  /** After a successful archive, check again once this time has passed. */
  verifyAt?: string;
  /** This success was a re-archive after Paseo wrote the agent back. */
  restored?: boolean;
  /** Branch had landed when the WIP step ran. Later rounds reuse this instead of comparing again. */
  landed?: boolean;
  /** That WIP step wrote a commit. False when the tree was already clean. */
  committed?: boolean;
  /** The origin branch that contains the tip when it is not the card's own branch name. */
  originBranch?: string;
  /** Summary row (DEMO_0001): this success was confirmed `count` times in a row, first at `firstAt`, last at `lastAt`. */
  summary?: number;
  count?: number;
  firstAt?: string;
  lastAt?: string;
  /** How many failed attempts this one row stands for. A retry of the same step updates the row instead of adding one. */
  attempts?: number;
  /** Automatic retry gave up at the attempt limit. retryAt is then a day away; a resume clears this at once. */
  stopped?: boolean;
  /** A stopped card error whose retry went through: no longer holds the card back. */
  resolved?: boolean;
  /** Read-only periodic absence confirmation, linked to the original failure without rewriting it. */
  reconciled?: boolean;
  failureRowId?: number;
}

export function shortAgentId(agentId: string): string {
  return agentId.slice(0, 8);
}

export function stuckLabel(agentId: string): string {
  return t("archiveBook.label.stuck", { agent: shortAgentId(agentId) });
}

export function waitingLabel(agentId: string): string {
  return t("archiveBook.label.waiting", { agent: shortAgentId(agentId) });
}

/** Board and audit text once the archive deadline has passed and the turn is still running. */
export function turnOpenLabel(agentId: string): string {
  return t("archiveBook.label.turnOpen", { agent: shortAgentId(agentId) });
}

/** The last look said the turn was running, and that look is older than the grace window. */
export function turnUnknownLabel(agentId: string): string {
  return t("archiveBook.label.turnUnknown", { agent: shortAgentId(agentId) });
}

/**
 * How long a confirmed-busy wait_turn still suppresses the overdue alert
 * after its retryAt. A later idle observation or purge/archive failure
 * ends the wait immediately. A retry only a few seconds away is inside this window.
 */
export const WAIT_TURN_ALERT_GRACE_MS = 60_000;

/**
 * After a card is archived mid-turn, its agent gets this long after the turn ends
 * (the latest turn_idle note) before an unarchived agent counts as overdue.
 */
export const TURN_END_ALERT_GRACE_MS = 10 * 60_000;

function turnEndedRecently(events: CleanupRecord[], agentId: string, now: Date): boolean {
  const index = events.findLastIndex((event) => event.action === "turn_idle" && event.agentId === agentId);
  const idle = events[index];
  if (!idle) return false;
  // Retryable failures after the turn ended stay inside the grace; repeated ones reach agentStuck.
  const at = Date.parse(idle.at);
  return Number.isFinite(at) && now.getTime() - at < TURN_END_ALERT_GRACE_MS;
}

export function restoredLabel(agentId: string): string {
  return t("archiveBook.label.restored", { agent: shortAgentId(agentId) });
}

/** Board and wake text for agents (short ids, already joined) still unarchived after the archive deadline. */
export function overdueLabel(agents: string): string {
  return t("archiveBook.label.overdue", { agent: agents });
}

interface StoredCleanup {
  id: number;
  at: string;
  data_json: string;
}

function parseCleanup(row: StoredCleanup): CleanupRecord {
  const data = JSON.parse(row.data_json) as Omit<CleanupRecord, "at">;
  return { ...data, at: row.at, rowId: row.id };
}

/**
 * Current-generation cleanup rows for one card; earlier attempts stay in the event history.
 * Repeated verify_agent lines are not loaded: only the latest one per agent is
 * needed to know the archive was confirmed. Pass `{ verify: false }` for notes.
 */
export function readCleanupEvents(taskId: number, options?: { verify?: boolean }): CleanupRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, at, data_json FROM events INDEXED BY events_cleanup_other
       WHERE task_id = ?
         AND kind = 'cleanup'
         AND IFNULL(json_extract(data_json, '$.action'), '') != 'verify_agent'
       ORDER BY id`,
    )
    .all(taskId) as unknown as StoredCleanup[];
  const boundary = cleanupGeneration(taskId);
  const current = (row: StoredCleanup) => row.id > boundary && (JSON.parse(row.data_json).cleanupGeneration ?? boundary) === boundary;
  const combined = rows.filter(current);
  if (options?.verify !== false) {
    // Latest verify per agent comes from the verify index itself. A confirm that
    // is the only cleanup row for that agent must still be visible.
    const verifies = db
      .prepare(
        `SELECT id, at, data_json FROM (
           SELECT id, at, data_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY IFNULL(json_extract(data_json, '$.agentId'), ''),
                                 json_extract(data_json, '$.cleanupGeneration')
                    ORDER BY id DESC
                  ) AS rn
           FROM events INDEXED BY events_cleanup_verify
           WHERE task_id = ?
             AND kind = 'cleanup'
             AND json_extract(data_json, '$.action') = 'verify_agent'
         )
         WHERE rn = 1`,
      )
      .all(taskId) as unknown as StoredCleanup[];
    combined.push(...verifies.filter(current));
    combined.sort((a, b) => a.id - b.id);
  }
  return latestVerifies(combined.map(parseCleanup));
}

function latestVerifies(events: CleanupRecord[]): CleanupRecord[] {
  const latest = new Map<string | undefined, CleanupRecord>();
  for (const event of events) if (event.action === "verify_agent") latest.set(event.agentId, event);
  return events.filter(event => event.action !== "verify_agent" || latest.get(event.agentId) === event);
}

const BATCH_CHUNK = 400;

/**
 * Current-generation cleanup rows for many cards in three statements per chunk (two without verifies).
 * Same content and order as readCleanupEvents for each card; a card with no rows maps to [].
 */
export function readCleanupEventsBatch(taskIds: readonly number[], options?: { verify?: boolean }): Map<number, CleanupRecord[]> {
  const db = getDb();
  const out = new Map<number, CleanupRecord[]>();
  for (const id of taskIds) out.set(id, []);
  for (let start = 0; start < taskIds.length; start += BATCH_CHUNK) {
    const chunk = taskIds.slice(start, start + BATCH_CHUNK);
    const marks = chunk.map(() => "?").join(",");
    const boundaries = new Map((db.prepare(
      `SELECT id, ${cleanupGenerationSql("tasks.id")} AS generation FROM tasks WHERE id IN (${marks})`,
    ).all(...chunk) as Array<{ id: number; generation: number }>).map(row => [row.id, row.generation]));
    const rows = db
      .prepare(
        `SELECT id, task_id, at, data_json FROM events INDEXED BY events_cleanup_other
         WHERE task_id IN (${marks})
           AND kind = 'cleanup'
           AND IFNULL(json_extract(data_json, '$.action'), '') != 'verify_agent'
         ORDER BY task_id, id`,
      )
      .all(...chunk) as unknown as Array<StoredCleanup & { task_id: number }>;
    const verifies =
      options?.verify === false
        ? []
        : (db
            .prepare(
              `SELECT id, task_id, at, data_json FROM (
                 SELECT id, task_id, at, data_json,
                        ROW_NUMBER() OVER (
                          PARTITION BY task_id, IFNULL(json_extract(data_json, '$.agentId'), ''),
                                       json_extract(data_json, '$.cleanupGeneration')
                          ORDER BY id DESC
                        ) AS rn
                 FROM events INDEXED BY events_cleanup_verify
                 WHERE task_id IN (${marks})
                   AND kind = 'cleanup'
                   AND json_extract(data_json, '$.action') = 'verify_agent'
               )
               WHERE rn = 1`,
            )
            .all(...chunk) as unknown as Array<StoredCleanup & { task_id: number }>);
    for (const row of [...rows, ...verifies].sort((a, b) => a.id - b.id)) {
      const boundary = boundaries.get(row.task_id) ?? 0;
      if (row.id > boundary && (JSON.parse(row.data_json).cleanupGeneration ?? boundary) === boundary)
        out.get(row.task_id)?.push(parseCleanup(row));
    }
  }
  for (const [id, events] of out) out.set(id, latestVerifies(events));
  return out;
}

/** Agents a verdict or acceptance asked to archive before the card itself is finished. */
export function agentsMarkedForRelease(taskId: number): string[] {
  const rows = getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN ('release_agent', 'release_agent_canceled') ORDER BY id").all(taskId) as unknown as Array<{
    kind: string;
    data_json: string;
  }>;
  const ids: string[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: unknown };
      if (typeof data.agentId !== "string" || !data.agentId) continue;
      if (row.kind === "release_agent_canceled") {
        const index = ids.indexOf(data.agentId);
        if (index >= 0) ids.splice(index, 1);
      } else if (!ids.includes(data.agentId)) ids.push(data.agentId);
    } catch {
      // ignore a broken event
    }
  }
  return ids;
}

export function agentReleaseRequested(taskId: number, agentId: string): boolean {
  return agentsMarkedForRelease(taskId).includes(agentId);
}

/** Every agent this card opened: runs, the task columns, tokens, and events left when opening failed midway. */
export function agentsOpenedBy(task: TaskRow): string[] {
  const ids = new Set<string>();
  const runs = getDb().prepare("SELECT agent_id FROM runs WHERE task_id = ? AND agent_id IS NOT NULL").all(task.id) as unknown as Array<{
    agent_id: string;
  }>;
  for (const row of runs) ids.add(row.agent_id);
  if (task.agent_id) ids.add(task.agent_id);
  if (task.executor_agent_id) ids.add(task.executor_agent_id);
  const tokens = getDb().prepare("SELECT agent_id FROM tokens WHERE task_id = ? AND agent_id IS NOT NULL").all(task.id) as unknown as Array<{
    agent_id: string;
  }>;
  for (const row of tokens) ids.add(row.agent_id);
  const events = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind IN ('agent_opened', 'started', 'resumed', 'registered')")
    .all(task.id) as unknown as Array<{ data_json: string }>;
  for (const row of events) {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: unknown };
      if (typeof data.agentId === "string" && data.agentId) ids.add(data.agentId);
    } catch {
      // ignore a broken event; the other sources still count
    }
  }
  return [...ids];
}

/**
 * Agents the board itself opened, and only those.
 * Tokens and leftover open events stay out of the re-archive path.
 */
export function agentsClaimedBy(task: TaskRow): string[] {
  const ids = new Set<string>();
  const runs = getDb().prepare("SELECT agent_id FROM runs WHERE task_id = ? AND agent_id IS NOT NULL").all(task.id) as unknown as Array<{
    agent_id: string;
  }>;
  for (const row of runs) ids.add(row.agent_id);
  if (task.agent_id) ids.add(task.agent_id);
  if (task.executor_agent_id) ids.add(task.executor_agent_id);
  return [...ids];
}

export function cleanupFinished(taskId: number): boolean {
  return cleanupMark(taskId, ["cleanup_finished"]);
}

function matches(event: CleanupRecord, action: string, id: string): boolean {
  if (event.action !== action) return false;
  if (action === "archive_workspace") return event.workspaceId === id;
  if (
    action === "remove_worktree" ||
    action === "delete_lane_branch" ||
    action === "drop_directory" ||
    action === "delete_branch" ||
    action === "wip_commit" ||
    action === "skip_worktree" ||
    action === "purge_agents"
  ) {
    return event.directory === id;
  }
  return event.agentId === id;
}

export function archiveSucceeded(events: CleanupRecord[], action: "archive_agent" | "archive_workspace", id: string): boolean {
  return events.some((event) => matches(event, action, id) && event.ok === true);
}

export function consecutiveTimeouts(events: CleanupRecord[], agentId: string): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.action !== "archive_agent" || event.agentId !== agentId) continue;
    if (event.ok) break;
    if (event.outcome === "timeout") count += 1;
    else break;
  }
  return count;
}

export function agentStuck(events: CleanupRecord[], agentId: string): boolean {
  return consecutiveTimeouts(events, agentId) >= STUCK_TIMEOUTS;
}

export function stuckAgentIds(events: CleanupRecord[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.action === "archive_agent" && event.agentId) ids.add(event.agentId);
  }
  return [...ids].filter((id) => agentStuck(events, id) && !archiveSucceeded(events, "archive_agent", id));
}

export function waitingAgentIds(events: CleanupRecord[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.action === "wait_turn" && event.agentId) ids.add(event.agentId);
  }
  return [...ids].filter((id) => {
    if (agentStuck(events, id) && !archiveSucceeded(events, "archive_agent", id)) return false;
    return waitingOnTurn(events, id);
  });
}

export function restoreStoppedIds(events: CleanupRecord[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.action === "restore_stuck" && event.agentId) ids.add(event.agentId);
  }
  return [...ids].filter(id => {
    const stopped = events.findLastIndex(event => event.action === "restore_stuck" && event.agentId === id);
    return !events.slice(stopped + 1).some(event => event.action === "archive_agent" && event.agentId === id && event.ok === true && event.reason === "gone");
  });
}

/** cleanup_finished or temp_workspace_cleaned means this card's agents are already put away. */
function cleanupClosed(taskId: number): boolean {
  return cleanupMark(taskId, ["cleanup_finished", "temp_workspace_cleaned"]);
}

/**
 * A temporary workspace deletes the agent and records purge_agents, not archive_agent.
 * A directory-level purge success has no agent id and covers every agent on the card.
 */
function purgeCovers(events: CleanupRecord[], agentId: string): boolean {
  return events.some((event) => {
    if (event.action !== "purge_agents" || event.ok !== true) return false;
    return event.agentId == null || event.agentId === agentId;
  });
}

/**
 * Temporary cleanup already removed this agent: a purge_agents success, or temp_workspace_cleaned.
 * cleanup_finished alone is not enough. A normal card can finish and still have a live agent,
 * and audit keeps listing that as unarchived.
 */
export function agentRetired(taskId: number, agentId: string, events = readCleanupEvents(taskId)): boolean {
  if (purgeCovers(events, agentId)) return true;
  return cleanupMark(taskId, ["temp_workspace_cleaned"]);
}

/**
 * True when this agent should not be called overdue: it was retired, or the card
 * already recorded cleanup_finished / temp_workspace_cleaned. archive_agent success is separate.
 */
export function agentPastCleanup(taskId: number, agentId: string, events = readCleanupEvents(taskId)): boolean {
  if (agentRetired(taskId, agentId, events)) return true;
  return cleanupClosed(taskId);
}

/** When the card first became done or archived, if that deadline can apply. */
function archiveDeadlineStamp(taskId: number): number | null {
  const task = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!task || (task.status !== "done" && task.status !== "archived")) return null;
  if (pendingLand(taskId)) return null;
  // The first real transition into done or archived. Later rows (board_wake, stall)
  // copy the current status into to_status and must not restart the clock.
  const row = getDb()
    .prepare(
      `SELECT at FROM events
       WHERE task_id = ? AND to_status IN ('done', 'archived')
         AND from_status IS NOT NULL AND from_status != to_status
         AND id > ${cleanupGenerationSql("events.task_id")}
       ORDER BY id ASC LIMIT 1`,
    )
    .get(taskId) as { at: string } | undefined;
  if (!row) return null;
  const stamp = Date.parse(row.at);
  if (!Number.isFinite(stamp)) return null;
  return stamp;
}

function pastArchiveDeadline(taskId: number, now: Date): boolean {
  const stamp = archiveDeadlineStamp(taskId);
  if (stamp == null) return false;
  const limit = loadConfig().archiveDeadlineMs ?? DEFAULT_ARCHIVE_DEADLINE_MS;
  return now.getTime() - stamp >= limit;
}

function unfinishedAgents(taskId: number, events: CleanupRecord[]): string[] {
  const task = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!task) return [];
  return agentsOpenedBy(task).filter((id) => !archiveSucceeded(events, "archive_agent", id) && !agentPastCleanup(taskId, id, events));
}

/**
 * The latest wait_turn is still recent enough to say the turn is running.
 * A retryAt more than the grace window in the past has not been reconfirmed.
 * That case is unknown, not an overdue archive: this tick may still find the agent busy.
 */
function busyWaitCovers(events: CleanupRecord[], agentId: string, now: Date): boolean {
  if (!waitingOnTurn(events, agentId)) return false;
  const last = failuresSinceOk(events, "archive_agent", agentId).at(-1);
  if (!last?.retryAt) return true;
  const retryAt = Date.parse(last.retryAt);
  if (!Number.isFinite(retryAt)) return true;
  return now.getTime() <= retryAt + WAIT_TURN_ALERT_GRACE_MS;
}

/**
 * Agents still not archived after the card has been done or archived for the deadline
 * (5 minutes unless configured). Empty when the card is still open, the archive succeeded,
 * the agent was purged, the card's cleanup already finished, or the last note is still
 * wait_turn. A stale wait is not overdue until a later look says the agent was idle
 * or the archive itself failed.
 */
export function overdueAgentIds(taskId: number, now = new Date(), events?: CleanupRecord[]): string[] {
  if (!pastArchiveDeadline(taskId, now)) return [];
  if (cleanupClosed(taskId)) return [];
  const rows = events ?? readCleanupEvents(taskId, { verify: false });
  return unfinishedAgents(taskId, rows).filter((id) => !waitingOnTurn(rows, id) && !turnEndedRecently(rows, id, now));
}

/**
 * Agents past the archive deadline whose latest look still says the turn is running,
 * and that look is inside the grace window.
 */
export function turnOpenAgentIds(taskId: number, now = new Date(), events?: CleanupRecord[]): string[] {
  if (!pastArchiveDeadline(taskId, now)) return [];
  if (cleanupClosed(taskId)) return [];
  const rows = events ?? readCleanupEvents(taskId, { verify: false });
  return unfinishedAgents(taskId, rows).filter((id) => busyWaitCovers(rows, id, now));
}

/** Unarchived agents still inside a turn, waiting on one, or inside the grace after it ended. Not stuck yet. */
export function agentsInTurnGrace(taskId: number, now = new Date()): string[] {
  const rows = readCleanupEvents(taskId, { verify: false });
  const open = new Set(turnOpenAgentIds(taskId, now, rows));
  // A wait_turn that is stale or unconfirmed still means the turn was not seen ending.
  for (const id of unfinishedAgents(taskId, rows)) if (waitingOnTurn(rows, id) || turnEndedRecently(rows, id, now)) open.add(id);
  return [...open];
}

/**
 * Past the deadline, last note is still wait_turn, and that note is older than the grace window.
 * This tick has not confirmed busy or idle yet, so the board must not call the archive stuck.
 */
export function turnUnknownAgentIds(taskId: number, now = new Date(), events?: CleanupRecord[]): string[] {
  if (!pastArchiveDeadline(taskId, now)) return [];
  if (cleanupClosed(taskId)) return [];
  const rows = events ?? readCleanupEvents(taskId, { verify: false });
  return unfinishedAgents(taskId, rows).filter((id) => waitingOnTurn(rows, id) && !busyWaitCovers(rows, id, now));
}

export function cleanupNoteFor(taskId: number, now = new Date()): string | null {
  const events = readCleanupEvents(taskId, { verify: false });
  if (cleanupClosed(taskId)) {
    const restored = restoreStoppedIds(events);
    return restored.length === 0 ? null : restored.map(restoredLabel).join(t("common.semicolon"));
  }
  const putAway = (id: string) => agentPastCleanup(taskId, id, events);
  const turnOpen = new Set(turnOpenAgentIds(taskId, now, events));
  const unknown = new Set(turnUnknownAgentIds(taskId, now, events));
  const late = new Set(overdueAgentIds(taskId, now, events));
  const parts = [
    ...waitingAgentIds(events).filter((id) => !putAway(id) && !turnOpen.has(id) && !unknown.has(id) && !late.has(id)).map(waitingLabel),
    ...[...turnOpen].filter((id) => !putAway(id)).map(turnOpenLabel),
    ...[...unknown].filter((id) => !putAway(id)).map(turnUnknownLabel),
    ...stuckAgentIds(events).filter((id) => !putAway(id)).map(stuckLabel),
    // A card can finish cleanup and later have the agent written back. That note stays.
    ...restoreStoppedIds(events).map(restoredLabel),
    ...[...late].map((id) => overdueLabel(shortAgentId(id))),
  ];
  if (parts.length === 0) return null;
  return parts.join(t("common.semicolon"));
}

export type RetryAction =
  | "archive_agent"
  | "archive_workspace"
  | "remove_worktree"
  | "delete_lane_branch"
  | "purge_agents"
  | "drop_directory"
  | "delete_branch"
  | "wip_commit"
  | "skip_worktree";

function related(event: CleanupRecord, action: RetryAction, id: string): boolean {
  if (matches(event, action, id)) return true;
  return action === "archive_agent" && event.action === "wait_turn" && event.agentId === id;
}

export function failuresSinceOk(events: CleanupRecord[], action: RetryAction, id: string): CleanupRecord[] {
  const matched = events.filter((event) => related(event, action, id));
  let start = 0;
  for (let i = matched.length - 1; i >= 0; i -= 1) {
    if (matched[i]?.ok) {
      start = i + 1;
      break;
    }
  }
  return matched.slice(start).filter((event) => event.ok === false);
}

export function restoreCount(events: CleanupRecord[], agentId: string): number {
  return events.filter((event) => event.action === "archive_agent" && event.agentId === agentId && event.ok === true && event.restored === true).length;
}

export function lastArchiveOk(events: CleanupRecord[], agentId: string): CleanupRecord | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.action === "archive_agent" && event.agentId === agentId && event.ok === true) return event;
  }
  return undefined;
}

const CONFIRMATION_RESET = new Set(["archive_agent", "wait_turn", "restore_stuck", "turn_idle"]);

/**
 * The latest relevant state for this agent is a successful verify_agent.
 * That counts even when this database has no successful archive_agent.
 * A later archive attempt, wait, finished turn, or stuck restore makes the old confirm stale.
 */
export function verifyRecorded(events: CleanupRecord[], agentId: string): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.agentId !== agentId) continue;
    if (event.action === "verify_agent" && event.ok === true) return true;
    if (event.action && CONFIRMATION_RESET.has(event.action)) return false;
  }
  return false;
}

/** A later event that means cleanup already saw this agent idle, or the delete/archive failed. */
function clearsWait(event: CleanupRecord, agentId: string): boolean {
  if (event.agentId !== agentId) return false;
  if (event.action === "turn_idle") return true;
  if (event.action === "purge_agents" && event.ok === false) return true;
  if (event.action === "archive_agent") return true;
  // Confirmed archived. Later ticks must not keep treating the old wait as open.
  if (event.action === "verify_agent" && event.ok === true) return true;
  return false;
}

/**
 * The latest not-yet-successful archive attempt is wait_turn, and nothing after it
 * recorded that the agent was idle or that purge/archive failed.
 */
export function waitingOnTurn(events: CleanupRecord[], agentId: string): boolean {
  const last = failuresSinceOk(events, "archive_agent", agentId).at(-1);
  if (last?.action !== "wait_turn") return false;
  const index = events.lastIndexOf(last);
  if (index < 0) return true;
  for (let i = index + 1; i < events.length; i += 1) {
    const event = events[i];
    if (event && clearsWait(event, agentId)) return false;
  }
  return true;
}

/**
 * True when an archive attempt is allowed.
 * A wait_turn is due on every tick so cleanup can look again: idle archives immediately,
 * still busy does not write another wait until retryAt.
 */
export function agentAttemptDue(events: CleanupRecord[], agentId: string, now: Date): boolean {
  return retryReady(events, "archive_agent", agentId, now) || waitingOnTurn(events, agentId);
}

/**
 * The 1-minute check after a success, a wait for the current turn, or the periodic sweep.
 * Once verify_agent has succeeded, only a sweep looks again, and that look records an
 * event only when the agent is no longer archived.
 */
export function agentNeedsReconcile(events: CleanupRecord[], agentId: string, now: Date, sweep: boolean, finished: boolean): boolean {
  if (events.some((event) => event.action === "restore_stuck" && event.agentId === agentId)) return false;
  const lastOk = lastArchiveOk(events, agentId);
  if (!lastOk) return sweep && finished;
  if (waitingOnTurn(events, agentId)) return true;
  if (lastOk.verifyAt && now.getTime() < Date.parse(lastOk.verifyAt)) return false;
  if (!verifyRecorded(events, agentId)) return true;
  return sweep;
}

/**
 * A finished card can skip ordinary ticks after every claimed agent is confirmed.
 * Agents with no successful archive stay on the sweep. A verify_agent already stored
 * for them is enough; the write guard does not record another while it is current.
 * A pending verifyAt is not settled: the one confirmation still has to run.
 */
export function reconcileSettled(events: CleanupRecord[], agentIds: readonly string[], now: Date, finished: boolean): boolean {
  if (!finished) return false;
  for (const agentId of agentIds) {
    if (waitingOnTurn(events, agentId)) return false;
    const lastOk = lastArchiveOk(events, agentId);
    if (!lastOk) continue;
    if (lastOk.verifyAt && now.getTime() < Date.parse(lastOk.verifyAt)) return false;
    if (!verifyRecorded(events, agentId)) return false;
  }
  return true;
}

function attemptsOf(event: CleanupRecord): number {
  return Math.max(1, event.attempts ?? 1);
}

function totalAttempts(failures: readonly CleanupRecord[]): number {
  return failures.reduce((sum, event) => sum + attemptsOf(event), 0);
}

export function retryDelayMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  const index = Math.min(failureCount, CLEANUP_BACKOFF_MS.length) - 1;
  return CLEANUP_BACKOFF_MS[index] ?? CLEANUP_BACKOFF_MS[CLEANUP_BACKOFF_MS.length - 1];
}

/** How many times this target failed since its last success. */
export function failureCount(events: CleanupRecord[], action: RetryAction, id: string): number {
  return totalAttempts(failuresSinceOk(events, action, id));
}

/** Failed attempts that count toward the cap. A wait for a running turn is not a failure of the step. */
export function hardFailureCount(events: CleanupRecord[], action: RetryAction, id: string): number {
  return totalAttempts(failuresSinceOk(events, action, id).filter((event) => event.action !== "wait_turn"));
}

export function nextRetryAt(events: CleanupRecord[], action: RetryAction, id: string, now: Date): string {
  const prior = totalAttempts(failuresSinceOk(events, action, id));
  return new Date(now.getTime() + retryDelayMs(prior + 1)).toISOString();
}

/** True when this target has not failed, or the backoff after the latest failure has elapsed. */
export function retryReady(events: CleanupRecord[], action: RetryAction, id: string, now: Date): boolean {
  const failures = failuresSinceOk(events, action, id);
  if (failures.length === 0) return true;
  const last = failures[failures.length - 1];
  if (!last) return true;
  if (last.retryAt) return now.getTime() >= Date.parse(last.retryAt);
  return now.getTime() - Date.parse(last.at) >= retryDelayMs(totalAttempts(failures));
}

/**
 * The card's cleanup threw and is waiting out its backoff, or gave up and is waiting for its daily retry. The
 * backoff case looks at the latest cleanup row (other than a verify): the card-level error row, with its
 * retryAt still ahead. A stopped error row holds the card whatever was written after it (a reconcile pass
 * adds archive rows), until its retryAt a day later. The row is updated in place by each repeat, never
 * added, so this stays one row however long the cause lasts.
 */
export function cardErrorBlocks(events: readonly CleanupRecord[], now: Date): boolean {
  const stopped = events.findLast((event) => event.action === "error" && event.stopped && !event.resolved);
  if (stopped && (!stopped.retryAt || now.getTime() < Date.parse(stopped.retryAt))) return true;
  const last = events.findLast((event) => event.action !== "verify_agent");
  if (last?.action !== "error" || last.stopped) return false;
  if (!last.retryAt) return false;
  return now.getTime() < Date.parse(last.retryAt);
}

export function failureLine(event: CleanupRecord): string {
  const who = event.directory ? "worktree" : event.agentId ? `agent ${shortAgentId(event.agentId)}` : event.workspaceId ? `workspace ${event.workspaceId}` : t("archiveBook.failure.cleanup");
  if (event.action === "wait_turn") return t("archiveBook.failure.waitTurn", { who });
  if (event.outcome === "timeout") return t("archiveBook.failure.timeout", { who });
  return t("archiveBook.failure.error", { who, error: event.error ?? t("archiveBook.failure.unknown") });
}

export interface CleanupIssues {
  stuck: string[];
  failures: string[];
}

/** Latest archive failure for each target that is still not archived. Stuck agents are listed separately. */
export function cleanupIssues(taskId: number): CleanupIssues {
  const events = readCleanupEvents(taskId);
  const stuckIds = new Set(stuckAgentIds(events).filter((id) => !agentPastCleanup(taskId, id, events)));
  const failures: string[] = [];
  const agents = new Set<string>();
  const workspaces = new Set<string>();
  for (const event of events) {
    if (event.action === "archive_agent" && event.agentId) agents.add(event.agentId);
    if (event.action === "archive_workspace" && event.workspaceId) workspaces.add(event.workspaceId);
  }
  for (const agentId of agents) {
    if (stuckIds.has(agentId) || archiveSucceeded(events, "archive_agent", agentId) || agentPastCleanup(taskId, agentId, events)) continue;
    const latest = failuresSinceOk(events, "archive_agent", agentId).at(-1);
    if (latest) failures.push(failureLine(latest));
  }
  for (const workspaceId of workspaces) {
    if (isLaneWorkspace(workspaceId)) continue;
    if (archiveSucceeded(events, "archive_workspace", workspaceId)) continue;
    const latest = failuresSinceOk(events, "archive_workspace", workspaceId).at(-1);
    if (latest) failures.push(failureLine(latest));
  }
  return { stuck: [...stuckIds].map(stuckLabel), failures };
}



/**
 * Clear every "stopped" mark on this card so automatic retry starts again from one attempt, now rather
 * than at the daily retry. A tick, a reconcile pass or a restart does not clear it.
 * Returns how many rows changed.
 */
export function resumeCleanup(taskId: number, now = new Date()): number {
  const db = getDb();
  const rows = readCleanupEvents(taskId, { verify: false }).filter(row => row.stopped && row.rowId != null);
  const update = db.prepare("UPDATE events SET data_json = ? WHERE id = ?");
  for (const row of rows) {
    const { stopped: _stopped, at: _at, rowId, ...rest } = row;
    update.run(JSON.stringify({ ...rest, attempts: 1, retryAt: now.toISOString() }), rowId!);
  }
  return rows.length;
}
