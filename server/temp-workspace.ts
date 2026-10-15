/// <reference types="node" />
import { join } from "node:path";
import { translate, t } from "../shared/i18n";
import { invalidateAgentIndex } from "./agent-index";
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "./perf-fs";
import { agentAttemptDue, DELETE_BRANCH_RETRY_LIMIT, failureCount, agentsInTurnGrace, agentsOpenedBy, CLEANUP_BACKOFF_MS, nextRetryAt, readCleanupEvents, retryReady, waitingOnTurn, waitReason, type CleanupRecord, type RetryAction } from "./archive-book";
import { ARTIFACT_KEEP_BRANCH, artifactAcceptanceSha, artifactCommitInBase } from "./artifact-accept";
import { cardMark } from "./card-ref";
import { DEFAULT_ARCHIVE_DEADLINE_MS, loadConfig } from "./config";
import { getDb } from "./db";
import { headRef, isProtectedBranch, refOk, removeReadOnlyWorktree, runGit, runGitSync, type GitRunner } from "./git";
import { agentsTouching, directoryState, pathWithin, PLACEHOLDER_NAME, placeholderBlocksRemoval, purgeCardAgents, purgeDecision, readCwdAgentList, retainAgentsBeforeDirectoryRemoval, agentListUnreadReason, type CwdAgent } from "./missing-cwd";
import { samePath } from "./placement";
import { readContract } from "./pr";
import { statusLabel } from "../shared/labels";
import { addComment, appendEvent, getTask, type TaskRow } from "./store";
import { describePendingLand, pendingLand } from "./land-pending";
import { isTempWorkspace, tempCleaned } from "./temp-mark";
import { captureReadOnlyCopy, deleteReadOnlyBranch, READONLY_LEFTOVERS } from "./readonly-worktree";
import { missingPrWakeDelivered, notifyBranchKept, notifyMissingPullRequest, type OverdueArchive } from "./wake";
import { branchFailureKind, branchAlreadyGone, createdWorktree, deleteOwnedBranch, dirtyWorktreeError, isUnderWorktrees, ownedWorktree, pushedWorktreeBasis, isPushedCleanupBasis, isDirectoryOnlyBasis, worktreeLanded, worktreeOwnershipError, type OwnedWorktree } from "./worktree-gc";
import { readWorktreeCreated, correctedFromDirectories, reconcileRecordedDirectory } from "./worktree-record";
import { cleanupGeneration, cleanupMark, currentCleanupSql } from "./cleanup-state";
import { removeArchivedClaudeProjects } from "./native-sessions";
import { deleteDiscardedBranch, discardAuthorization, discardStillValid } from "./cleanup-discard";

function failure(result: { stderr: string; stdout: string }, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

function doneStamp(taskId: number): number | null {
  const row = getDb()
    .prepare(
      `SELECT at FROM events
       WHERE task_id = ? AND to_status IN ('done', 'archived')
         AND from_status IS NOT NULL AND from_status != to_status
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { at: string } | undefined;
  if (!row) return null;
  const stamp = Date.parse(row.at);
  return Number.isFinite(stamp) ? stamp : null;
}

/** Other cards (an independent review, for example) that use this card's Paseo workspace. */
function workspaceSharers(task: TaskRow): Array<{ id: number; status: string }> {
  const workspaceId = task.paseo_workspace_id;
  if (!workspaceId) return [];
  return getDb().prepare("SELECT id, status FROM tasks WHERE paseo_workspace_id = ? AND id != ?").all(workspaceId, task.id) as Array<{ id: number; status: string }>;
}

/** The workspace is still in use by an unfinished card, so cleanup cannot have run and nothing is overdue. */
function borrowedByOpenCard(task: TaskRow): boolean {
  return workspaceSharers(task).some((row) => row.status !== "done" && row.status !== "archived");
}

/** The cleanup clock starts when the last card on the workspace finished, not only the owner. */
function ownerStamp(task: TaskRow): number | null {
  const own = doneStamp(task.id);
  const stamps = workspaceSharers(task).map((row) => doneStamp(row.id)).filter((stamp): stamp is number => stamp != null);
  return stamps.length === 0 ? own : Math.max(...(own == null ? [] : [own]), ...stamps);
}

export interface TempWorkspaceRow {
  id: number;
  code: string;
  title: string;
  status: string;
  late: boolean;
  /** Set while accept finished but the branch is still waiting to land. */
  pendingReason: string | null;
}

/**
 * Every temporary workspace that has not been cleaned up, including cards still running.
 * Cleaned ones are left out in the one statement, so a board with hundreds of old temporary
 * cards reads only the few that are still open.
 */
export function listTempWorkspaces(now = new Date()): TempWorkspaceRow[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT t.id FROM tasks t
       JOIN events e ON e.task_id = t.id AND e.kind = 'temp_workspace'
       WHERE NOT EXISTS (SELECT 1 FROM events c WHERE c.task_id = t.id AND c.kind = 'temp_workspace_cleaned' AND ${currentCleanupSql("c", "t.id")})
       ORDER BY t.id`,
    )
    .all() as unknown as Array<{ id: number }>;
  const limit = loadConfig().archiveDeadlineMs ?? DEFAULT_ARCHIVE_DEADLINE_MS;
  const out: TempWorkspaceRow[] = [];
  for (const row of rows) {
    let task: TaskRow;
    try {
      task = getTask(row.id);
    } catch {
      continue;
    }
    const stamp = ownerStamp(task);
    const terminal = task.status === "done" || task.status === "archived";
    const pending = pendingLand(task.id);
    const late = !pending && terminal && !borrowedByOpenCard(task) && stamp != null && now.getTime() - stamp >= limit;
    out.push({
      id: task.id,
      code: cardMark(task.id),
      title: task.title,
      status: task.status,
      late,
      pendingReason: pending ? describePendingLand(pending) : null,
    });
  }
  return out;
}

export function tempWorkspaceMessage(now = new Date()): string | null {
  const late = listTempWorkspaces(now).filter((row) => row.late);
  if (late.length === 0) return null;
  return t("tempWorkspace.message.late", { count: late.length, codes: late.map((row) => row.code).join(t("common.listSep")) });
}

/** Archived copy kept its branch instead of waiting for a pull request. */
export const ARCHIVED_KEEP_BRANCH = "archived_keep_branch";

/** Done GitHub card exhausted the cleanup backoff without a pull request. */
export const MISSING_PR_REASON = "no_pr";
/** Older no_pr rows mark a dirty copy with the Chinese word for "uncommitted". */
const LEGACY_UNCOMMITTED_MARK = "\u672a\u63d0\u4ea4";

/** Whether a recorded no_pr error says the copy still had uncommitted changes, in any language. */
function missingPrDirty(error: string | undefined): boolean {
  if (!error) return false;
  const key = "tempWorkspace.missingPr.dirtySuffix";
  return error.includes(LEGACY_UNCOMMITTED_MARK) ||
    error.includes(translate("en", key).trim()) || error.includes(translate("zh-CN", key).trim());
}

function parkedMissingPr(events: CleanupRecord[], directory?: string): boolean {
  return events.some(
    (event) => event.action === "skip_worktree" && event.reason === MISSING_PR_REASON && (directory == null || event.directory === directory),
  );
}

/** not_merged rows with no read error. A fetch or status failure does not count toward the cap. */
function quietNotMergedCount(events: CleanupRecord[], directory: string): number {
  return events.filter(
    (event) => event.action === "skip_worktree" && event.ok === false && event.reason === "not_merged" && event.directory === directory && !event.error,
  ).length;
}

/** Archived cards already recorded only not_merged. That backoff must not keep the copy. */
function notMergedBackoffOnly(events: CleanupRecord[], directory: string): boolean {
  const failed = events.filter((event) => event.action === "skip_worktree" && event.directory === directory && event.ok === false);
  return failed.length > 0 && failed.every((event) => event.reason === "not_merged");
}

/**
 * A done GitHub card with no pull request is waiting on the bounded not_merged
 * retries, or has already been handed to the project leader. That is not a stuck archive.
 */
export function suppressTempArchiveStuck(taskId: number): boolean {
  const events = readCleanupEvents(taskId);
  // Parked and handed to a live receiver. An undelivered no_pr wake stays visible as a board problem.
  if (parkedMissingPr(events)) return missingPrWakeDelivered(taskId);
  let task: TaskRow;
  try {
    task = getTask(taskId);
  } catch {
    return false;
  }
  if (task.status !== "done") return false;
  let contract;
  try {
    contract = readContract(task.contract_json);
  } catch {
    return false;
  }
  if (contract.kind !== "github" || contract.pr) return false;
  const last = [...events].reverse().find((event) => event.action === "skip_worktree" && event.ok === false);
  return last?.reason === "not_merged" && !last.error;
}

/** Temporary workspaces left behind past the cleanup deadline, for the merged overdue wake. */
export function overdueTempWorkspaces(now = new Date()): OverdueArchive[] {
  const out: OverdueArchive[] = [];
  for (const row of listTempWorkspaces(now)) {
    if (!row.late) continue;
    if (suppressTempArchiveStuck(row.id)) continue;
    // The agent's turn is still running, or ended moments ago: the archive is not stuck yet.
    if (agentsInTurnGrace(row.id, now).length > 0) continue;
    out.push({ taskId: row.id, kind: "temp_workspace", detail: `${t("tempWorkspace.audit.latePrefix")}${row.code}` });
  }
  return out;
}

type RecordCleanup = (data: Omit<CleanupRecord, "at">) => void;

/** A per-agent purge result sets agentId. Only a directory-level success finishes that step. */
function recorded(events: CleanupRecord[], action: string): boolean {
  return events.some((event) => event.action === action && event.ok === true && event.agentId === undefined);
}

function agentPurgeDone(events: CleanupRecord[], agentId: string): boolean {
  return events.some((event) => event.action === "purge_agents" && event.agentId === agentId && event.ok === true);
}

function noteShared(events: CleanupRecord[], workspaceId: string, record: RecordCleanup): void {
  if (events.some((event) => event.action === "skip_workspace" && event.reason === "shared" && event.workspaceId === workspaceId)) return;
  record({ action: "skip_workspace", workspaceId, ok: false, reason: "shared" });
}

/** One note, with no retry time, so the next round can delete the agent as soon as its turn ends. */
function noteTurnOnce(events: CleanupRecord[], agentId: string, directory: string, record: RecordCleanup): void {
  if (events.some((event) => event.action === "wait_turn" && event.agentId === agentId && event.retryAt == null)) return;
  record({ action: "wait_turn", agentId, directory, ok: false, reason: waitReason() });
}

/** The agent is no longer in its turn. Later purge or archive failures are ordinary overdue failures. */
function noteTurnIdle(events: CleanupRecord[], agentId: string, record: RecordCleanup): void {
  if (!waitingOnTurn(events, agentId)) return;
  record({ action: "turn_idle", agentId, ok: true });
}

function unfinishedSharer(workspaceId: string, taskId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT id FROM tasks
       WHERE paseo_workspace_id = ? AND id != ? AND status NOT IN ('done', 'archived')
       LIMIT 1`,
    )
    .get(workspaceId, taskId);
  return Boolean(row);
}

/** Unfinished card that uses this same Paseo workspace, for example an independent review. */
function openCardSharesWorkspace(agent: CwdAgent, workspaceId: string): boolean {
  const db = getDb();
  const byColumn = db
    .prepare(
      `SELECT id FROM tasks
       WHERE paseo_workspace_id = ? AND status NOT IN ('done', 'archived')
         AND (agent_id = ? OR executor_agent_id = ?)
       LIMIT 1`,
    )
    .get(workspaceId, agent.id, agent.id);
  if (byColumn) return true;
  const byRun = db
    .prepare(
      `SELECT t.id FROM runs r JOIN tasks t ON t.id = r.task_id
       WHERE r.agent_id = ? AND t.paseo_workspace_id = ? AND t.status NOT IN ('done', 'archived')
       LIMIT 1`,
    )
    .get(agent.id, workspaceId);
  if (byRun) return true;
  const byToken = db
    .prepare(
      `SELECT t.id FROM tokens k JOIN tasks t ON t.id = k.task_id
       WHERE k.agent_id = ? AND t.paseo_workspace_id = ? AND t.status NOT IN ('done', 'archived')
       LIMIT 1`,
    )
    .get(agent.id, workspaceId);
  if (byToken) return true;
  const labeled = agent.labels.kanban_task;
  if (labeled && /^\d+$/.test(labeled)) {
    const byLabel = db
      .prepare(
        `SELECT id FROM tasks
         WHERE id = ? AND paseo_workspace_id = ? AND status NOT IN ('done', 'archived')
         LIMIT 1`,
      )
      .get(Number(labeled), workspaceId);
    if (byLabel) return true;
  }
  return false;
}

function markAgentPurged(events: CleanupRecord[], agentId: string, directory: string, record: RecordCleanup): void {
  if (agentPurgeDone(events, agentId)) return;
  record({ action: "purge_agents", agentId, directory, ok: true });
}

/** Landed is decided before the WIP commit and kept on that event. A later round must not compare the branch again. */
function savedWip(events: CleanupRecord[]): { landed: boolean; committed: boolean; pushed: boolean; basis?: string; originBranch?: string } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.action !== "wip_commit" || event.ok !== true) continue;
    if (typeof event.landed !== "boolean") return null;
    return { landed: event.landed, committed: event.committed === true, pushed: isPushedCleanupBasis(event.reason) || isDirectoryOnlyBasis(event.reason), basis: event.reason, originBranch: event.originBranch };
  }
  return null;
}

type WorkspaceChoice =
  | { action: "skip"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "archive"; workspaceId: string; directory: string };

/** False while a failed cleanup step is still inside its backoff. A mark with no worktree record is due once, so it can be closed. */
/** Recovery entrance for a successfully rebound terminal copy hidden by older cleanup marks.
 * Merely queues the ordinary path; no failure, stop, ownership or retry clock is cleared.
 */
export function rebuiltCleanupPending(task: TaskRow): boolean {
  if (task.status !== "done" && task.status !== "archived") return false;
  if (!isTempWorkspace(task.id) || tempCleaned(task.id) || cleanupMark(task.id, ["cleanup_finished"]) || pendingLand(task.id)) return false;
  const boundary = cleanupGeneration(task.id);
  if (!boundary || !getDb().prepare("SELECT 1 FROM events WHERE task_id = ? AND kind = 'cleanup_finished' AND id < ? LIMIT 1").get(task.id, boundary)) return false;
  const created = readWorktreeCreated(task.id);
  const owned = ownedWorktree(task.id, created);
  if (!owned || !task.paseo_workspace_id || !created ||
      created.workspaceId !== task.paseo_workspace_id || !task.workspace_path || !samePath(task.workspace_path, owned.directory)) return false;
  if (borrowedByOpenCard(task)) return false;
  const open = getDb().prepare("SELECT workspace_path FROM tasks WHERE id != ? AND status NOT IN ('done', 'archived') AND workspace_path IS NOT NULL").all(task.id) as Array<{ workspace_path: string }>;
  if (open.some(row => pathWithin(owned.directory, row.workspace_path))) return false;
  const listed = readCwdAgentList();
  if (!listed) return false;
  if (agentsTouching(owned.directory, listed).some(agent => !purgeDecision(agent).ok)) return false;
  return true;
}

export function tempCleanupDue(task: TaskRow, now: Date): boolean {
  if (pendingLand(task.id)) return false;
  const created = createdWorktree(task.id);
  if (!created) return true;
  const owned = ownedWorktree(task.id, created);
  const events = readCleanupEvents(task.id);
  if (!owned) return retryReady(events, "skip_worktree", created.directory || String(task.id), now);
  const discard = discardAuthorization(task, owned);
  if (!discard && parkedMissingPr(events, owned.directory)) return !missingPrWakeDelivered(task.id);
  const steps: Array<[RetryAction, string]> = [
    ["wip_commit", owned.directory],
    ["purge_agents", owned.directory],
    ["drop_directory", owned.directory],
    ["delete_branch", owned.directory],
  ];
  if (!discard && !(task.status === "archived" && notMergedBackoffOnly(events, owned.directory))) {
    steps.push(["skip_worktree", owned.directory]);
  }
  if (task.paseo_workspace_id) steps.push(["archive_workspace", task.paseo_workspace_id]);
  if (!steps.every(([action, id]) => retryReady(events, action, id, now))) return false;
  return agentsOpenedBy(task).every((agentId) => agentAttemptDue(events, agentId, now));
}

function defer(events: CleanupRecord[], action: RetryAction, id: string, now: Date, record: RecordCleanup, data: Omit<CleanupRecord, "at">): "pending" {
  if (!retryReady(events, action, id, now)) return "pending";
  record({ ...data, retryAt: nextRetryAt(events, action, id, now) });
  return "pending";
}

/** Same message the archive cleanup uses, so a handoff save is recognizable in git log. */
export function wipCommitMessage(taskId: number): string {
  return t("tempWorkspace.wip.commitMessage", { card: cardMark(taskId) });
}

/** Why a handoff WIP commit must not run here. Only the board's own temporary copy qualifies. */
function wipOwnerRefusal(directory: string, taskId: number): { refused: string } | { owned: OwnedWorktree } {
  const owned = ownedWorktree(taskId, createdWorktree(taskId));
  if (!owned || !samePath(owned.directory, directory)) {
    return { refused: t("tempWorkspace.wip.notOwnedCopy") };
  }
  if (owned.readOnly) return { refused: t("tempWorkspace.wip.readOnly") };
  return { owned };
}

/**
 * Commit uncommitted work in the card's own temporary copy (ownedWorktree), on the card branch
 * or a detached HEAD only. Never in a main directory, a lane or a read-only copy, and never on a
 * checked-out branch this card did not create (protected, base, or anyone else's): that ref is
 * shared by the whole repo. A refusal is `skipped` and leaves the changes in the tree, not an
 * error. An empty or missing tree is neither. A failed git command returns the error and does not throw.
 */
export function commitWipSync(directory: string, taskId: number): { committed: boolean; error?: string; skipped?: string } {
  const gate = wipOwnerRefusal(directory, taskId);
  if ("refused" in gate) return { committed: false, skipped: gate.refused };
  const { owned } = gate;
  if (!directory || directoryState(directory) !== "present") return { committed: false };
  const top = runGitSync(directory, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { committed: false, error: failure(top, t("tempWorkspace.wip.notGitRepo")) };
  if (!samePath(top.stdout.trim(), owned.directory)) return { committed: false, skipped: t("tempWorkspace.wip.notGitRoot") };
  const current = runGitSync(directory, ["branch", "--show-current"]);
  if (current.code !== 0) return { committed: false, error: failure(current, t("tempWorkspace.wip.branchUnreadable")) };
  const branch = current.stdout.trim();
  if (branch && (branch === owned.base || isProtectedBranch(branch))) {
    return { committed: false, skipped: t("tempWorkspace.wip.protectedBranch", { branch }) };
  }
  if (branch && branch !== owned.branch) {
    return { committed: false, skipped: t("tempWorkspace.wip.foreignBranch", { branch, cardBranch: owned.branch }) };
  }
  const status = runGitSync(directory, ["status", "--porcelain", "--", "."]);
  if (status.code !== 0) return { committed: false, error: failure(status, t("tempWorkspace.gitFailed", { command: "git status" })) };
  if (!status.stdout.trim()) return { committed: false };
  const added = runGitSync(directory, ["add", "-A", "--", "."]);
  if (added.code !== 0) return { committed: false, error: failure(added, t("tempWorkspace.gitFailed", { command: "git add" })) };
  const committed = runGitSync(directory, ["commit", "--no-verify", "--only", "-m", wipCommitMessage(taskId), "--", "."]);
  if (committed.code !== 0) return { committed: false, error: failure(committed, t("tempWorkspace.gitFailed", { command: "git commit" })) };
  return { committed: true };
}

/**
 * A WIP may only move the card branch. A named checkout of any other branch (the executor's
 * own feature branch, another card's, a team branch) switches back first, carrying the
 * uncommitted changes; git refuses when they would be overwritten, and that is an error to back off on.
 */
async function switchToCardBranch(owned: OwnedWorktree, run: GitRunner, canContinue: () => boolean): Promise<{ error: string } | { pending: true } | null> {
  const current = await run(owned.directory, ["branch", "--show-current"]);
  if (!canContinue()) return { pending: true };
  if (current.code !== 0) return { error: failure(current, t("tempWorkspace.wip.branchUnreadable")) };
  const name = current.stdout.trim();
  if (!name || name === owned.branch) return null;
  const switched = await run(owned.directory, ["switch", owned.branch]);
  if (switched.code !== 0) return { error: t("tempWorkspace.wip.switchFailed", { name, branch: owned.branch, error: failure(switched, t("tempWorkspace.gitFailed", { command: "git switch" })) }) };
  return null;
}

/** Commit uncommitted work onto the card branch, never onto another checked-out branch. An empty tree is not an error. */
async function commitDirty(task: TaskRow, owned: OwnedWorktree, run: GitRunner, canContinue: () => boolean): Promise<{ error: string } | { pending: true } | { committed: boolean }> {
  if (!canContinue()) return { pending: true };
  if (directoryState(owned.directory) !== "present") return { committed: false };
  const status = await run(owned.directory, ["status", "--porcelain"]);
  if (!canContinue()) return { pending: true };
  if (status.code !== 0) return { error: failure(status, t("tempWorkspace.gitFailed", { command: "git status" })) };
  if (!status.stdout.trim()) return { committed: false };
  const switched = await switchToCardBranch(owned, run, canContinue);
  if (!canContinue()) return { pending: true };
  if (switched) return switched;
  const added = await run(owned.directory, ["add", "-A"]);
  if (!canContinue()) return { pending: true };
  if (added.code !== 0) return { error: failure(added, t("tempWorkspace.gitFailed", { command: "git add" })) };
  const committed = await run(owned.directory, ["commit", "--no-verify", "-m", wipCommitMessage(task.id)]);
  if (committed.code !== 0) return { error: failure(committed, t("tempWorkspace.gitFailed", { command: "git commit" })) };
  return { committed: true };
}

/**
 * True while another open card still uses this workspace.
 * Recorded once, with no retry time, so the next cleanup round can finish as soon as that card ends.
 */
function holdForSharedWorkspace(task: TaskRow, events: CleanupRecord[], record: RecordCleanup): boolean {
  const workspaceId = task.paseo_workspace_id;
  if (!workspaceId) return false;
  if (events.some((event) => event.action === "archive_workspace" && event.ok === true && event.workspaceId === workspaceId)) return false;
  if (!unfinishedSharer(workspaceId, task.id)) return false;
  noteShared(events, workspaceId, record);
  return true;
}

type PurgeStep = "done" | "shared" | "retry" | "waiting";

function unreadAgentList(events: CleanupRecord[], directory: string, now: Date, record: RecordCleanup): PurgeStep {
  const retryAt = nextRetryAt(events, "purge_agents", directory, now);
  record({
    action: "purge_agents",
    directory,
    ok: false,
    outcome: "error",
    error: agentListUnreadReason(),
    retryAt,
  });
  return "retry";
}

/**
 * Delete this card's agents one by one.
 * Gone from disk means finished. Still on disk blocks the step, whatever the purge line said:
 * the delete failed, a linked card is still open, the agent belongs to another card,
 * or the board did not open it.
 */
async function purgeOpenedAgents(
  task: TaskRow,
  directory: string,
  events: CleanupRecord[],
  now: Date,
  record: RecordCleanup,
  activity?: (agentId: string) => Promise<"busy" | "idle" | "gone" | "unknown">,
): Promise<PurgeStep> {
  if (readCwdAgentList() == null) return unreadAgentList(events, directory, now, record);
  const purged = await purgeCardAgents(task.id);
  const listed = readCwdAgentList();
  if (listed == null) return unreadAgentList(events, directory, now, record);
  const pending: Array<{ agentId: string; reason: string }> = [];
  for (const line of purged.lines) {
    if (agentPurgeDone(events, line.agentId)) continue;
    const stillThere = listed.some((agent) => agent.id === line.agentId);
    if (!stillThere) {
      markAgentPurged(events, line.agentId, directory, record);
      continue;
    }
    pending.push({ agentId: line.agentId, reason: line.reason });
  }
  if (pending.length > 0) {
    const retryAt = nextRetryAt(events, "purge_agents", directory, now);
    for (const line of pending) {
      record({
        action: "purge_agents",
        agentId: line.agentId,
        directory,
        ok: false,
        outcome: "error",
        error: `${line.agentId}${t("common.colon")}${line.reason}`,
        retryAt,
      });
    }
    return "retry";
  }
  if (directoryState(directory) === "present") {
    const touching = await retainAgentsBeforeDirectoryRemoval(directory, activity);
    for (const agentId of touching.purged) markAgentPurged(events, agentId, directory, record);
    for (const agentId of touching.waiting) noteTurnOnce(events, agentId, directory, record);
    if (touching.unread.length > 0) {
      const retryAt = nextRetryAt(events, "purge_agents", directory, now);
      record({
        action: "purge_agents",
        directory,
        ok: false,
        outcome: "error",
        error: t("tempWorkspace.agents.unreadableList", { agents: touching.unread.join(t("common.listSep")) }),
        retryAt,
      });
      return "retry";
    }
    if (touching.kept.length > 0) {
      const workspaceId = task.paseo_workspace_id;
      const blocked = touching.kept.filter((agent) => !(workspaceId && openCardSharesWorkspace(agent, workspaceId)));
      if (blocked.length === 0) return "shared";
      const retryAt = nextRetryAt(events, "purge_agents", directory, now);
      const detail = blocked
        .map((agent) => {
          const decision = purgeDecision(agent);
          return `${agent.id}${t("common.paren", { text: decision.ok ? t("tempWorkspace.agents.deleteFailed") : decision.reason })}`;
        })
        .join(t("common.listSep"));
      record({
        action: "purge_agents",
        directory,
        ok: false,
        outcome: "error",
        error: t("tempWorkspace.agents.stillPointing", { agents: detail }),
        retryAt,
      });
      return "retry";
    }
    if (touching.waiting.length > 0) return "waiting";
  }
  if (!recorded(events, "purge_agents")) record({ action: "purge_agents", directory, ok: true });
  return "done";
}

/**
 * Delete a patrol placeholder only while it holds nothing but its README: unlink that file, then a
 * non-recursive rmdir, so a file that shows up in between makes the delete fail instead of vanishing.
 */
function removeBarePlaceholder(directory: string): string | null {
  try {
    if (!lstatSync(directory).isDirectory()) return t("tempWorkspace.placeholder.notDirectory");
    const others = readdirSync(directory).filter((name) => name !== PLACEHOLDER_NAME);
    if (others.length > 0) return t("tempWorkspace.placeholder.otherFiles", { files: others.slice(0, 5).join(t("common.listSep")), more: others.length > 5 ? t("tempWorkspace.placeholder.more") : "" });
    const readme = join(directory, PLACEHOLDER_NAME);
    if (!lstatSync(readme).isFile()) return t("tempWorkspace.placeholder.readmeNotFile");
    unlinkSync(readme);
    rmdirSync(directory);
  } catch (err) {
    return t("tempWorkspace.placeholder.removeFailedWith", { error: err instanceof Error ? err.message : String(err) });
  }
  return existsSync(directory) ? t("tempWorkspace.placeholder.removeFailed") : null;
}

/** Recheck cwd users even if an earlier cleanup round already purged the card's agents. */
function missingGitUsers(taskId: number, directory: string): string | null {
  const open = getDb().prepare("SELECT id, workspace_path FROM tasks WHERE id != ? AND status NOT IN ('done', 'archived')")
    .all(taskId) as Array<{ id: number; workspace_path: string | null }>;
  const users = open.filter(row => row.workspace_path && pathWithin(directory, row.workspace_path));
  if (users.length) return t("tempWorkspace.missingGit.openCards", { cards: users.map(row => cardMark(row.id)).join(t("common.listSep")) });
  // Both sides of prune must see records created within the production index TTL.
  invalidateAgentIndex();
  const agents = readCwdAgentList();
  if (agents == null) return agentListUnreadReason();
  const touching = agentsTouching(directory, agents);
  if (touching.length) return t("tempWorkspace.agents.stillPointing", { agents: touching.map(agent => agent.id).join(t("common.listSep")) });
  return null;
}

/**
 * Remove the worktree directory without leaving a placeholder. Agents must already be gone.
 * A patrol placeholder is removed only when every agent named in its README or
 * cwd_placeholder events has an explicit purge or successful archive on this card,
 * or a successful agent-list read shows it is gone. An unreadable list keeps the placeholder.
 * It must also be a real directory under the worktrees root holding only its README.
 */
async function dropDirectory(
  taskId: number,
  owned: OwnedWorktree,
  run: GitRunner,
  readOnly?: { allowDirty: boolean },
  canContinue: () => boolean = () => true,
): Promise<string | null> {
  const state = directoryState(owned.directory);
  if (state === "placeholder") {
    const blocked = placeholderBlocksRemoval(owned.directory, taskId);
    if (blocked) return blocked;
    if (!isUnderWorktrees(owned.directory)) return t("tempWorkspace.drop.isPlaceholder");
    const removed = removeBarePlaceholder(owned.directory);
    if (removed) return removed;
  } else if (state === "present") {
    const gitFile = directoryProbe(join(owned.directory, ".git"));
    if ("error" in gitFile) return gitFile.error;
    if (gitFile.state === "absent") {
      // Only this proven-owned copy is removed. A locked/still registered tree is kept.
      const blocked = missingGitUsers(taskId, owned.directory);
      if (blocked) return blocked;
      const pruned = await run(owned.root, ["worktree", "prune"]);
      if (pruned.code !== 0) return failure(pruned, t("tempWorkspace.gitFailed", { command: "git worktree prune" }));
      const listed = await run(owned.root, ["worktree", "list", "--porcelain"]);
      if (listed.code !== 0) return failure(listed, t("tempWorkspace.drop.listUnreadable"));
      if (listed.stdout.split("\n").some(line => line.startsWith("worktree ") && samePath(line.slice(9), owned.directory))) {
        return t("tempWorkspace.drop.stillRegistered");
      }
      if (!canContinue()) return t("tempWorkspace.drop.changed");
      const users = missingGitUsers(taskId, owned.directory);
      if (users) return users;
      const rechecked = directoryProbe(join(owned.directory, ".git"));
      if ("error" in rechecked) return rechecked.error;
      if (rechecked.state !== "absent") return t("tempWorkspace.drop.gitBack");
      if (!lstatSync(owned.directory).isDirectory() || !isUnderWorktrees(owned.directory)) return t("tempWorkspace.drop.notOwnedPath");
      try {
        rmSync(owned.directory, { recursive: true });
      } catch (err) {
        return t("tempWorkspace.drop.leftoverRemoveFailed", { error: err instanceof Error ? err.message : String(err) });
      }
    } else if (readOnly) {
      const status = await run(owned.directory, ["status", "--porcelain", "--untracked-files=all"]);
      if (status.code !== 0) return failure(status, t("tempWorkspace.drop.readOnlyStatusUnreadable"));
      if (status.stdout.trim() && !readOnly.allowDirty) return t("tempWorkspace.drop.readOnlyChanged");
      const removed = await removeReadOnlyWorktree(owned.root, owned.directory);
      if (removed.code !== 0 && existsSync(owned.directory)) return failure(removed, t("tempWorkspace.gitFailed", { command: "git worktree remove" }));
    } else {
      const removed = await run(owned.root, ["worktree", "remove", owned.directory]);
      if (removed.code !== 0 && existsSync(owned.directory)) return failure(removed, t("tempWorkspace.gitFailed", { command: "git worktree remove" }));
    }
  }
  const pruned = await run(owned.root, ["worktree", "prune"]);
  if (pruned.code !== 0) return failure(pruned, t("tempWorkspace.gitFailed", { command: "git worktree prune" }));
  if (directoryState(owned.directory) === "present") return t("tempWorkspace.drop.stillThere");
  return null;
}

export const DIRECTORY_GONE_REASON = "directory_gone";

/** present: lstat works. absent: ENOENT. Anything else (EACCES, EIO...) is a read error, never "absent". */
function directoryProbe(directory: string): { state: "present" | "absent" } | { error: string } {
  if (!directory.trim()) return { state: "absent" };
  try {
    lstatSync(directory);
    return { state: "present" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent" };
    return { error: t("tempWorkspace.probe.unreadable", { code: code ?? String(err) }) };
  }
}

/** The local card branch tip, null when the branch is gone, "unreadable" when git could not say. */
async function localBranchTip(owned: OwnedWorktree, run: GitRunner): Promise<string | null | "unreadable"> {
  if (!owned.branch || !refOk(owned.branch)) return null;
  const result = await run(owned.root, ["rev-parse", "--verify", "--quiet", `${headRef(owned.branch)}^{commit}`]);
  if (result.code === 0) return result.stdout.trim() || "unreadable";
  return result.code === 1 ? null : "unreadable";
}

/**
 * Clean a temporary workspace.
 * A copy directory already confirmed absent has no work left to lose: skip every merge/pushed check, keep the branch if it still exists (keep_branch directory_gone), then archive the workspace.
 * Landed cards: wait out a shared workspace, purge agents, archive the Paseo workspace, delete the merged branch, then record the event.
 * Clean terminal cards whose actual branch equals origin: keep the remote/PR, remove local resources.
 * An ancestor proof keeps the local branch and still removes the directory, including when the card is archived.
 * Archived cards that are not landed and not pushed (no origin, or a GitHub card with no pull request) commit a WIP when dirty, keep the branch, and do not retry not_merged.
 * An ahead-of-origin branch or failed fetch still defers for done cards.
 * Archived cards on the card branch use archived_keep_branch; see DESIGN for the detached exception.
 * A done GitHub card with no pull request retries not_merged only through the cleanup backoff, then wakes the project leader.
 * Does not create a placeholder directory.
 */
export async function settleTempWorkspace(input: {
  task: TaskRow;
  events: CleanupRecord[];
  now: Date;
  record: RecordCleanup;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  decideWorkspace: () => Promise<WorkspaceChoice>;
  /** gone means the agent is already absent. unknown means the query failed. */
  agentActivity?: (agentId: string) => Promise<"busy" | "idle" | "gone" | "unknown">;
  run?: GitRunner;
  worktreesRoot?: string;
}): Promise<"settled" | "pending"> {
  const { events } = input;
  const boundary = cleanupGeneration(input.task.id);
  const record: RecordCleanup = data => input.record({ cleanupGeneration: boundary, ...data });
  let task = getTask(input.task.id);
  if (!isTempWorkspace(task.id) || tempCleaned(task.id)) return "settled";
  if (task.status !== "done" && task.status !== "archived") return "pending";
  if (pendingLand(task.id)) return "pending";
  if (holdForSharedWorkspace(task, events, record)) return "pending";
  const run = input.run ?? ((cwd: string, args: string[]) => runGit(cwd, args));
  let created = createdWorktree(task.id);
  // The recorded directory can differ from the real one (a "-1" suffix): follow git before judging it gone.
  created = (await reconcileRecordedDirectory(task.id, created, run)) ?? created;
  task = getTask(task.id);
  if (task.status !== "done" && task.status !== "archived") return "pending";
  if (pendingLand(task.id)) return "pending";
  if (holdForSharedWorkspace(task, events, record)) return "pending";
  const owned = ownedWorktree(task.id, created, input.worktreesRoot);
  if (!created) {
    appendEvent(task.id, "temp_workspace_cleaned", null, null, "kanban", {
      cleanupGeneration: boundary,
      directory: null,
      branch: null,
      keptBranch: false,
      reason: "no_worktree",
    });
    return "settled";
  }
  if (!owned) {
    const id = created.directory || String(task.id);
    return defer(events, "skip_worktree", id, input.now, record, {
      action: "skip_worktree",
      directory: created.directory,
      branch: created.branch,
      ok: false,
      reason: "unowned",
      error: worktreeOwnershipError(task.id, created, input.worktreesRoot) ?? t("tempWorkspace.settle.unowned"),
    });
  }
  // Any awaited read can let a review borrow this copy or the owner reopen/move it.
  // Keep the proven owner identity and reread live state before WIP writes or retirement.
  const canContinue = (): boolean => {
    const current = getTask(task.id);
    if (cleanupGeneration(task.id) !== boundary || current.status !== task.status || current.workspace_path !== task.workspace_path ||
      current.workspace_kind !== task.workspace_kind || current.workspace_base !== task.workspace_base ||
      current.paseo_workspace_id !== task.paseo_workspace_id || current.agent_id !== task.agent_id ||
      current.executor_agent_id !== task.executor_agent_id || pendingLand(task.id)) return false;
    return !holdForSharedWorkspace(current, events, record);
  };
  const discard = discardAuthorization(task, owned);
  const discardReady = async (): Promise<boolean> => {
    if (!discard) return canContinue();
    if (!canContinue() || !(await discardStillValid(task, owned, discard, run)) || !canContinue()) {
      record({ action: "skip_worktree", directory: owned.directory, branch: owned.branch, ok: false,
        reason: "discard_changed", error: t("cleanupDiscard.changed") });
      return false;
    }
    return true;
  };
  if (input.agentActivity && !recorded(events, "purge_agents")) {
    for (const agentId of agentsOpenedBy(task)) {
      if (agentPurgeDone(events, agentId)) continue;
      const ready = retryReady(events, "archive_agent", agentId, input.now);
      if (!ready && !waitingOnTurn(events, agentId)) return "pending";
      const activity = await input.agentActivity(agentId);
      if (!canContinue()) return "pending";
      if (activity === "gone") {
        noteTurnIdle(events, agentId, record);
        continue;
      }
      if (activity === "busy") {
        if (!ready) return "pending";
        record({
          action: "wait_turn",
          agentId,
          directory: owned.directory,
          ok: false,
          reason: waitReason(),
          retryAt: nextRetryAt(events, "archive_agent", agentId, input.now),
        });
        return "pending";
      }
      if (activity === "unknown") {
        if (!ready) return "pending";
        return defer(events, "archive_agent", agentId, input.now, record, {
          action: "archive_agent",
          agentId,
          directory: owned.directory,
          ok: false,
          outcome: "error",
          error: t("tempWorkspace.agents.unreadable"),
        });
      }
      noteTurnIdle(events, agentId, record);
    }
  }
  if (!(await discardReady())) return "pending";
  // Once a proof was saved with the directory present, the normal path finishes it. Only an untouched card takes the shortcut.
  const probe = directoryProbe(owned.directory);
  const dirGone = (!!discard || !savedWip(events)) && "state" in probe && probe.state === "absent";
  if ("error" in probe) {
    // A read error must not look like a missing directory: existsSync-based checks below would treat it as gone.
    if (!retryReady(events, "skip_worktree", owned.directory, input.now)) return "pending";
    return defer(events, "skip_worktree", owned.directory, input.now, record, {
      action: "skip_worktree", directory: owned.directory, branch: owned.branch, ok: false, error: probe.error,
    });
  }
  if (!discard && !dirGone && parkedMissingPr(events, owned.directory)) {
    // Nobody took the no-PR wake yet: try again this round. It is recorded as sent only once delivered.
    if (!missingPrWakeDelivered(task.id)) {
      const parked = [...events].reverse().find((event) => event.action === "skip_worktree" && event.reason === MISSING_PR_REASON);
      await notifyMissingPullRequest(task.id, owned.branch, missingPrDirty(parked?.error));
    }
    return "pending";
  }
  const archived = task.status === "archived";
  // Prior not_merged rows from a missing pull request must not keep an archived copy waiting.
  // A real read failure still uses the backoff.
  const skipNotMergedBackoff = archived && !owned.readOnly && notMergedBackoffOnly(events, owned.directory);
  if (!discard && !dirGone && !skipNotMergedBackoff && !retryReady(events, "skip_worktree", owned.directory, input.now)) return "pending";
  const saved = discard ? undefined : savedWip(events);
  let landedFlag = saved?.landed ?? false;
  let committedWip = saved?.committed ?? false;
  let pushedFlag = saved?.pushed ?? false;
  let pushedBasis = saved?.basis;
  let originBranch = saved?.originBranch;
  let archivedKeep = saved?.basis === ARCHIVED_KEEP_BRANCH;
  let goneKeep = false;
  let readOnlyReason: string | undefined;
  if (discard) {
    // Explicit approval replaces only the merge proof. All ordinary ownership,
    // live-agent, shared-workspace and clean-directory gates still apply.
    landedFlag = true;
  } else if (dirGone) {
    if (!recorded(events, "keep_branch") && !events.some((e) => e.action === "skip_worktree" && e.ok === true && e.reason === "gone")) {
      const tip = await localBranchTip(owned, run);
      if (tip === "unreadable") {
        return defer(events, "skip_worktree", owned.directory, input.now, record, {
          action: "skip_worktree", directory: owned.directory, branch: owned.branch, ok: false,
          error: t("tempWorkspace.settle.branchUnreadable", { branch: owned.branch }),
        });
      }
      if (tip) {
        goneKeep = true;
        addComment(task.id, "kanban", t("tempWorkspace.settle.directoryGoneKept", { branch: owned.branch, tip: tip.slice(0, 12) }));
        // Supersede any earlier not_merged failure on this directory so doctor stops counting it.
        record({ action: "skip_worktree", directory: owned.directory, branch: owned.branch, ok: true, reason: DIRECTORY_GONE_REASON });
        record({ action: "keep_branch", directory: owned.directory, branch: owned.branch, ok: true, reason: DIRECTORY_GONE_REASON });
      } else {
        record({ action: "skip_worktree", directory: owned.directory, branch: owned.branch, ok: true, reason: "gone" });
      }
    } else {
      goneKeep = recorded(events, "keep_branch");
    }
    landedFlag = false;
    committedWip = false;
    pushedFlag = false;
  } else if (owned.readOnly) {
    // Inspect the copy only after the agent is gone, so a busy reader is not snapshotted mid-edit.
    landedFlag = true;
    committedWip = false;
    pushedFlag = false;
  } else if (pushedFlag && !recorded(events, "delete_branch") && directoryState(owned.directory) === "present") {
    const pushed = await pushedWorktreeBasis(task, owned, run);
    if (!("basis" in pushed)) {
      return defer(events, "skip_worktree", owned.directory, input.now, record, {
        action: "skip_worktree", directory: owned.directory, branch: owned.branch,
        ok: false, reason: "not_merged",
        error: "error" in pushed ? pushed.error : t("tempWorkspace.settle.differsFromOrigin"),
      });
    }
    // Once an ancestor proof was recorded, keep the stricter branch deletion gate.
    if (isDirectoryOnlyBasis(pushed.basis)) pushedBasis = pushed.basis;
    originBranch = pushed.originBranch ?? originBranch;
  }
  if (!discard && !dirGone && !owned.readOnly && !saved) {
    const landed = await worktreeLanded(task, owned, run, input.now.getTime());
    if (landed.landed && landed.gone) {
      if (!events.some((event) => event.action === "skip_worktree" && event.ok === true && event.reason === "gone")) {
        record({
          action: "skip_worktree",
          directory: owned.directory,
          branch: owned.branch,
          ok: true,
          reason: "gone",
        });
      }
      landedFlag = true;
      committedWip = false;
      record({
        action: "wip_commit",
        directory: owned.directory,
        branch: owned.branch,
        ok: true,
        landed: true,
        committed: false,
      });
    } else {
      if (!landed.landed) {
        const pushed = await pushedWorktreeBasis(task, owned, run);
        if ("basis" in pushed) {
          pushedFlag = true;
          pushedBasis = pushed.basis;
          originBranch = pushed.originBranch;
          record({ action: "wip_commit", directory: owned.directory, branch: owned.branch,
            ok: true, landed: false, committed: false, reason: pushedBasis,
            ...(pushed.originBranch ? { originBranch: pushed.originBranch } : {}) });
        } else {
          const noOrigin = "noOrigin" in pushed;
          const pushedError = "error" in pushed ? pushed.error : undefined;
          // Uncommitted work hides the push check, so it is not a read error when the card simply has no pull request.
          const dirty = pushedError === dirtyWorktreeError() && landed.missingPr === true && !landed.error;
          const readError = landed.error ?? (dirty ? undefined : pushedError);
          const missingPr = landed.missingPr === true && !readError && !noOrigin;
          // An archived copy never comes back and keeps its branch, so it needs no origin proof:
          // no origin, a branch origin does not have (or is ahead of), a failed origin read, or a missing pull request
          // all save a WIP and keep the branch. A done card still waits for the proof.
          const originUnproven = ("notPushed" in pushed || "error" in pushed) && pushed.keepable === true;
          const archivedKeepNow = archived && (noOrigin || missingPr || originUnproven);
          if (!archivedKeepNow) {
            if (missingPr && quietNotMergedCount(events, owned.directory) >= CLEANUP_BACKOFF_MS.length) {
              const error = t("tempWorkspace.missingPr.error", { branch: owned.branch, dirty: dirty ? t("tempWorkspace.missingPr.dirtySuffix") : "" });
              record({
                action: "skip_worktree",
                directory: owned.directory,
                branch: owned.branch,
                ok: false,
                reason: MISSING_PR_REASON,
                error,
              });
              await notifyMissingPullRequest(task.id, owned.branch, dirty);
              return "pending";
            }
            return defer(events, "skip_worktree", owned.directory, input.now, record, {
              action: "skip_worktree", directory: owned.directory, branch: owned.branch,
              ok: false, reason: "not_merged",
              ...(readError ? { error: readError } : {}),
            });
          }
        }
      }
      if (!pushedFlag) {
        if (!retryReady(events, "wip_commit", owned.directory, input.now)) return "pending";
        const wip = await commitDirty(task, owned, run, canContinue);
        if ("pending" in wip) return "pending";
        if ("error" in wip) {
          return defer(events, "wip_commit", owned.directory, input.now, record, {
            action: "wip_commit",
            directory: owned.directory,
            branch: owned.branch,
            ok: false,
            outcome: "error",
            error: wip.error,
          });
        }
        landedFlag = landed.landed;
        committedWip = wip.committed;
        // Landed and clean still deletes the branch. A WIP, or a copy that never landed, stays.
        if (archived) archivedKeep = !landedFlag || committedWip;
        record({
          action: "wip_commit",
          directory: owned.directory,
          branch: owned.branch,
          ok: true,
          landed: landedFlag,
          committed: committedWip,
          ...(archivedKeep ? { reason: ARCHIVED_KEEP_BRANCH } : {}),
        });
      }
    }
  }
  let keepBranch = discard ? false : dirGone ? goneKeep : archivedKeep || (!landedFlag && !pushedFlag) || committedWip;
  if (!dirGone && keepBranch && !recorded(events, "keep_branch")) {
    const code = cardMark(task.id);
    const extra = committedWip ? t("tempWorkspace.keep.wipSaved", { message: t("tempWorkspace.wip.commitMessage", { card: code }) }) : t("tempWorkspace.keep.clean");
    addComment(task.id, "kanban", t("tempWorkspace.keep.comment", { branch: owned.branch, extra }));
    record({
      action: "keep_branch",
      directory: owned.directory,
      branch: owned.branch,
      ok: true,
      ...(archivedKeep ? { reason: ARCHIVED_KEEP_BRANCH } : {}),
    });
  }
  if (!canContinue()) return "pending";
  if (!recorded(events, "purge_agents")) {
    if (!retryReady(events, "purge_agents", owned.directory, input.now)) return "pending";
    const step = await purgeOpenedAgents(task, owned.directory, events, input.now, record, input.agentActivity);
    if (step === "shared" && task.paseo_workspace_id) {
      noteShared(events, task.paseo_workspace_id, record);
      return "pending";
    }
    if (step !== "done") return "pending";
  }
  // Export and record a read-only copy's leftovers before archiving its Paseo workspace:
  // that archive deletes the directory, and anything not exported first would be lost.
  if (owned.readOnly && directoryState(owned.directory) === "present") {
    const captured = await captureReadOnlyCopy(task, owned, run);
    if ("error" in captured) {
      return defer(events, "skip_worktree", owned.directory, input.now, record, {
        action: "skip_worktree", directory: owned.directory, branch: owned.branch, ok: false, error: captured.error,
      });
    }
    readOnlyReason = captured.reason;
  }
  const workspaceId = task.paseo_workspace_id;
  if (workspaceId && !events.some((event) => event.action === "archive_workspace" && event.ok === true && event.workspaceId === workspaceId)) {
    if (!retryReady(events, "archive_workspace", workspaceId, input.now)) return "pending";
    const decision = await input.decideWorkspace();
    // A card reopened while Paseo answered keeps its workspace (DEMO_0001).
    if (!(await discardReady())) return "pending";
    // Paseo may still name the directory this card's record had before it was corrected to the real one.
    const mismatch = decision.action === "archive" && !samePath(decision.directory, owned.directory) &&
      !correctedFromDirectories(task.id).some((from) => samePath(decision.directory, from));
    if (decision.action === "retry" && decision.reason === "shared") {
      noteShared(events, workspaceId, record);
      return "pending";
    }
    if (decision.action === "retry") {
      return defer(events, "archive_workspace", workspaceId, input.now, record, {
        action: "archive_workspace",
        workspaceId,
        ok: false,
        outcome: "error",
        error: decision.reason,
      });
    }
    if (decision.action === "skip" || mismatch) {
      if (!events.some((event) => event.action === "skip_workspace" && event.ok === true)) {
        record({
          action: "skip_workspace",
          workspaceId,
          ok: true,
          reason: decision.action === "skip" ? decision.reason : "directory_mismatch",
        });
      }
    } else {
      try {
        await input.archiveWorkspace(workspaceId);
      } catch (err) {
        return defer(events, "archive_workspace", workspaceId, input.now, record, {
          action: "archive_workspace",
          workspaceId,
          ok: false,
          outcome: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      record({ action: "archive_workspace", workspaceId, ok: true });
    }
  }
  if (!recorded(events, "drop_directory")) {
    if (!retryReady(events, "drop_directory", owned.directory, input.now)) return "pending";
    if (!(await discardReady())) return "pending";
    const wasPlaceholder = directoryState(owned.directory) === "placeholder";
    const gitFile = directoryProbe(join(owned.directory, ".git"));
    const missingGit = !wasPlaceholder && directoryState(owned.directory) === "present" && "state" in gitFile && gitFile.state === "absent";
    const dropped = await dropDirectory(task.id, owned, run, owned.readOnly ? { allowDirty: readOnlyReason === READONLY_LEFTOVERS } : undefined, canContinue);
    if (dropped) {
      return defer(events, "drop_directory", owned.directory, input.now, record, {
        action: "drop_directory",
        directory: owned.directory,
        ok: false,
        outcome: "error",
        error: dropped,
      });
    }
    record({
      action: "drop_directory",
      directory: owned.directory,
      ok: true,
      ...(missingGit ? { reason: "missing_git" } : wasPlaceholder ? { reason: t("tempWorkspace.drop.placeholderAgentsDeleted") } : readOnlyReason ? { reason: readOnlyReason, forced: true } : {}),
    });
  }
  if (!canContinue()) return "pending";
  const recordedSha = artifactAcceptanceSha(task.id);
  if (!discard && recordedSha && !recorded(events, "delete_branch") && !(await artifactCommitInBase(owned.root, recordedSha, owned.base, run))) {
    keepBranch = true;
    if (!events.some((event) => event.action === "keep_branch" && event.reason === ARTIFACT_KEEP_BRANCH)) {
      record({
        action: "keep_branch",
        directory: owned.directory,
        branch: owned.branch,
        ok: true,
        reason: ARTIFACT_KEEP_BRANCH,
      });
    }
  }
  if (!keepBranch && !archivedKeep && (landedFlag || pushedFlag) && !committedWip && !recorded(events, "delete_branch")) {
    if (!retryReady(events, "delete_branch", owned.directory, input.now)) return "pending";
    const inspectionError = owned.readOnly ? await deleteReadOnlyBranch(task.id, owned, run) : null;
    const deleted = discard
      ? { ok: await deleteDiscardedBranch(task, owned, discard, run), error: t("cleanupDiscard.changed"), basis: "discard_unmerged" }
      : owned.readOnly
      ? { ok: !inspectionError, error: inspectionError ?? undefined, basis: readOnlyReason ?? t("tempWorkspace.branch.readOnlyUnchanged") }
      : await deleteOwnedBranch(task, owned, run, input.run, pushedFlag, isDirectoryOnlyBasis(pushedBasis), pushedBasis);
    let basis = deleted.ok ? deleted.basis : undefined;
    if (!deleted.ok) {
      if (discard) {
        record({ action: "delete_branch", directory: owned.directory, branch: owned.branch, ok: false,
          reason: "discard_changed", error: t("cleanupDiscard.changed") });
        return "pending";
      }
      const error = deleted.error ?? t("tempWorkspace.branch.notDeleted");
      const kind = branchFailureKind(error);
      if (kind === "gone") {
        basis = branchAlreadyGone();
      } else if (kind === "keep") {
        keepBranch = true;
        basis = t("tempWorkspace.branch.keptByRule", { error });
        addComment(task.id, "kanban", t("tempWorkspace.branch.keptComment", { basis }));
      } else if (failureCount(events, "delete_branch", owned.directory) + 1 < DELETE_BRANCH_RETRY_LIMIT) {
        return defer(events, "delete_branch", owned.directory, input.now, record, {
          action: "delete_branch",
          directory: owned.directory,
          branch: owned.branch,
          ok: false,
          outcome: "error",
          error: error,
        });
      } else {
        keepBranch = true;
        basis = t("tempWorkspace.branch.keptAfterRetries", { limit: DELETE_BRANCH_RETRY_LIMIT, error });
        addComment(task.id, "kanban", t("tempWorkspace.branch.keptAfterRetriesComment", { basis }));
        notifyBranchKept(task.id, t("tempWorkspace.branch.keptAfterRetriesWake", { limit: DELETE_BRANCH_RETRY_LIMIT, branch: owned.branch, error }));
      }
    } else if ("kept" in deleted && deleted.kept) {
      keepBranch = true;
      addComment(task.id, "kanban", t("tempWorkspace.branch.keptComment", { basis: String(deleted.basis) }));
    }
    record({
      action: keepBranch ? "keep_branch" : "delete_branch",
      directory: owned.directory,
      branch: owned.branch,
      ok: true,
      ...(basis ? { reason: basis } : {}),
    });
  }
  if (!canContinue()) return "pending";
  appendEvent(task.id, "temp_workspace_cleaned", null, null, "kanban", {
    cleanupGeneration: boundary,
    directory: owned.directory,
    branch: owned.branch,
    keptBranch: keepBranch,
    workspaceId: workspaceId ?? null,
    ...(pushedFlag && originBranch ? { originBranch } : {}),
    ...(dirGone ? { reason: DIRECTORY_GONE_REASON } : archivedKeep ? { reason: ARCHIVED_KEEP_BRANCH } : pushedFlag ? { reason: pushedBasis } : readOnlyReason ? { reason: readOnlyReason } : {}),
  });
  await removeArchivedClaudeProjects(owned.directory);
  return "settled";
}

export function tempAuditLines(rows: TempWorkspaceRow[]): string[] {
  return rows.map((row) => {
    if (row.pendingReason) return t("tempWorkspace.audit.pending", { code: row.code, reason: row.pendingReason });
    return row.late
      ? `${t("tempWorkspace.audit.latePrefix")}${row.code}${t("common.paren", { text: statusLabel(row.status) })}`
      : t("tempWorkspace.audit.temp", { code: row.code, status: statusLabel(row.status) });
  });
}

/** True for a tempAuditLines line about a workspace past its cleanup deadline, in either language. */
export function isLateTempLine(line: string): boolean {
  const key = "tempWorkspace.audit.latePrefix";
  return line.startsWith(translate("en", key)) || line.startsWith(translate("zh-CN", key));
}
