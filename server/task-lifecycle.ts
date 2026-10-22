/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { scheduledUntil } from "./scheduled-time";
import { agentReleaseRequested } from "./archive-book";
import { getDb } from "./db";
import { cachedMergeState, contractPullRequest, type ContractState } from "./pr";
import { cardMark } from "./card-ref";
import { KanbanError } from "./errors";
import { assertTransition } from "./state";
import { BLOCKED_KINDS, blockedKindLabel, isBlockedKind } from "../shared/blocked";
import { externalWaitMessage, isExternalWait } from "./external-wait";
import { agentsRootMissing, readAgentRecord } from "./open";
import { expireTaskWorkerTokens, revokeAgentToken, revokeTaskWorkerTokens } from "./tokens";
import { ROLES, statusLabel, type Status } from "../shared/labels";
import { addComment, addEvent, appendEvent, now, taskById, type TaskRow } from "./task-record";
import { t } from "../shared/i18n";
import { parseRunBudget } from "./run-budget-config";
import { assertRunBudgetSettled, resetRunBudget } from "./run-budget-control";

export function blockTask(id: number, kind: string, reason: string, actor: string, extra?: Record<string, unknown>): TaskRow & { text?: string } {
  const text = reason.trim();
  if (!text) throw new KanbanError("invalid", t("taskLifecycle.error.noReason"));
  if (!isBlockedKind(kind)) {
    throw new KanbanError("invalid", t("taskLifecycle.error.blockedKind", { kinds: BLOCKED_KINDS.join(t("common.listSep")) }), { kind });
  }
  const task = taskById(id);
  // A worker may still be finishing its turn after the leader closed the card.
  // Keep the late report for inspection without reopening it or notifying blockers.
  const cardAgent = actor !== "supervisor" && (ROLES as readonly string[]).includes(actor);
  if (cardAgent && (task.status === "archived" || task.status === "done")) {
    const message = task.status === "archived" ? t("taskLifecycle.blockIgnored.archived") : t("taskLifecycle.blockIgnored.done");
    addEvent(id, "block_ignored", null, null, actor, { ...(extra ?? {}), kind, reason: text, status: task.status, message });
    addComment(id, actor, t("taskLifecycle.blockIgnored.comment", { message, kind: blockedKindLabel(kind), reason: text }));
    return { ...task, text: message };
  }
  if (actor === "executor" && kind === "dependency" && isExternalWait(text)) {
    addEvent(id, "block_rejected", null, null, actor, { kind, reason: text, message: externalWaitMessage() });
    throw new KanbanError("invalid", externalWaitMessage());
  }
  const until = scheduledUntil(kind, extra?.until);
  assertTransition(task.status, "blocked");
  const ts = now();
  const info = getDb()
    .prepare(
      `UPDATE tasks SET status = 'blocked', blocked_kind = ?, blocked_reason = ?, blocked_from = ?, blocked_at = ?, hold_reason = ?, updated_at = ?,
       scheduled_until = ?, scheduled_wake_id = ?, scheduled_wake_text = ?, scheduled_claim_id = NULL, scheduled_claim_until = NULL
       WHERE id = ? AND status = ?`,
    )
    .run(kind, text, task.status, ts, text, ts, until, until ? randomUUID() : null, until ? t("scheduled.wake", { until }) : null, id, task.status);
  if (info.changes !== 1) throw new KanbanError("conflict", t("taskLifecycle.error.statusChanged", { card: cardMark(id) }), { id });
  addEvent(id, "blocked", task.status, "blocked", actor, { kind, reason: text, ...(extra ?? {}) });
  addComment(id, actor, t("taskLifecycle.block.comment", { kind: blockedKindLabel(kind), reason: text }));
  const blocked = taskById(id);
  try {
    blockedListener?.(blocked, actor);
  } catch (err) {
    console.error("[paseo-kanban] blocked listener", err instanceof Error ? err.message : err);
  }
  return blocked;
}

type BlockedListener = (task: TaskRow, actor: string) => void;
let blockedListener: BlockedListener | null = null;

export function setBlockedListener(fn: BlockedListener | null): void {
  blockedListener = fn;
}

type FinishedListener = (task: TaskRow) => void;
let finishedListener: FinishedListener | null = null;

export function setFinishedListener(fn: FinishedListener | null): void {
  finishedListener = fn;
}

export function notifyFinished(task: TaskRow): void {
  if (task.status !== "done" && task.status !== "archived") return;
  if (task.status === "done") expireTaskWorkerTokens(task.id);
  try {
    finishedListener?.(task);
  } catch (err) {
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
  }
}

type ReleaseListener = (taskId: number) => void;
let releaseListener: ReleaseListener | null = null;

export function setReleaseListener(fn: ReleaseListener | null): void {
  releaseListener = fn;
}

/**
 * Ask cleanup to archive these agents now, before the card is done.
 * Events are written first, then cleanup runs once, so one pass sees every id.
 * A reviewer is released when they give a verdict. A worker is released when the card enters acceptance.
 */
export function requestAgentReleases(taskId: number, items: Array<{ agentId: string; role: "reviewer" | "executor" }>): void {
  let added = false;
  for (const item of items) {
    const id = item.agentId.trim();
    if (!id || agentReleaseRequested(taskId, id)) continue;
    appendEvent(taskId, "release_agent", null, null, "kanban", { agentId: id, role: item.role });
    added = true;
  }
  if (!added && items.length === 0) return;
  try {
    releaseListener?.(taskId);
  } catch (err) {
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
  }
}

export function setHold(id: number, reason: string | null): void {
  getDb().prepare("UPDATE tasks SET hold_reason = ? WHERE id = ?").run(reason, id);
}

type DepartedAgent = { agentId: string; reason: "agent_gone" | "agent_archived" | "agent_purged"; note: string };

/** The assigned agent cannot take the card back. An unreadable record is not proof it left, unless the agent root itself is missing. */
function departedAgent(task: TaskRow): DepartedAgent | null {
  const agentId = task.agent_id?.trim();
  if (!agentId) return null;
  const purged = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'agent_purged'").all(task.id) as Array<{
    data_json: string;
  }>;
  for (const row of purged) {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: unknown };
      if (data.agentId === agentId) {
        return { agentId, reason: "agent_purged", note: t("taskLifecycle.departed.purged") };
      }
    } catch {
      // a broken purge event does not name this agent
    }
  }
  const read = readAgentRecord(agentId);
  if (read.state === "missing" || (read.state === "unreadable" && agentsRootMissing())) {
    return { agentId, reason: "agent_gone", note: t("taskLifecycle.departed.gone") };
  }
  if (read.state === "ok" && read.file.archivedAt) {
    return { agentId, reason: "agent_archived", note: t("taskLifecycle.departed.archived") };
  }
  return null;
}

/**
 * Agent id unblock would hand the card back to.
 * Null when the assigned agent is already gone and unblock would return the card to ready.
 */
export function resumableAgentId(task: TaskRow): string | null {
  const restore = (task.blocked_from as Status | null) ?? "ready";
  if (restore !== "running" && restore !== "reviewing") return null;
  if (departedAgent(task)) return null;
  const agentId = task.agent_id?.trim() ?? "";
  return agentId || null;
}

function closeOpenRuns(taskId: number, endKind: string, ts: string): void {
  const open = getDb().prepare("SELECT id, agent_id FROM runs WHERE task_id = ? AND ended_at IS NULL").all(taskId) as Array<{
    id: number;
    agent_id: string | null;
  }>;
  for (const row of open) {
    getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = ? WHERE id = ?").run(ts, endKind, row.id);
    revokeAgentToken(row.agent_id);
  }
}

export function unblockTask(id: number, actor: string, extra?: Record<string, unknown>): TaskRow {
  const task = taskById(id);
  if (task.status !== "blocked") throw new KanbanError("illegal_transition", t("taskLifecycle.error.notBlocked"), { from: task.status, to: "ready" });
  assertRunBudgetSettled(id);
  const override = extra?.runBudget === undefined ? undefined : parseRunBudget(extra.runBudget);
  if (override && (typeof extra?.reason !== "string" || !extra.reason.trim())) throw new KanbanError("invalid", t("runBudget.overrideReason"));
  const restore = (task.blocked_from as Status | null) ?? "ready";
  let target: Status = restore === "blocked" || restore === "archived" ? "ready" : restore;
  const departed = target === "running" || target === "reviewing" ? departedAgent(task) : null;
  if (departed) target = "ready";
  assertTransition("blocked", target);
  const ts = now();
  const info = departed
    ? getDb()
        .prepare(
          `UPDATE tasks SET status = ?, agent_id = NULL, blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, hold_reason = NULL, cooldown_until = NULL, background_wait_json = NULL, scheduled_until = NULL, scheduled_wake_id = NULL, scheduled_wake_text = NULL, scheduled_claim_id = NULL, scheduled_claim_until = NULL, nudge_count = 0, updated_at = ?
           WHERE id = ? AND status = 'blocked'`,
        )
        .run(target, ts, id)
    : getDb()
        .prepare(
          `UPDATE tasks SET status = ?, blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, hold_reason = NULL, cooldown_until = NULL, background_wait_json = NULL, scheduled_until = NULL, scheduled_wake_id = NULL, scheduled_wake_text = NULL, scheduled_claim_id = NULL, scheduled_claim_until = NULL, nudge_count = 0, updated_at = ?
           WHERE id = ? AND status = 'blocked'`,
        )
        .run(target, ts, id);
  if (info.changes !== 1) throw new KanbanError("conflict", t("taskLifecycle.error.statusChanged", { card: cardMark(id) }), { id });
  if (departed) closeOpenRuns(id, "unblocked", ts);
  const data = departed
    ? { agentId: departed.agentId, reason: departed.reason, note: departed.note, ...(extra ?? {}) }
    : { ...(extra ?? {}) };
  addEvent(id, "unblocked", "blocked", target, actor, data);
  if (extra?.via !== "background_wait") resetRunBudget(id);
  if (override) addEvent(id, "run_budget_override", null, target, actor, { limits: override, reason: extra!.reason, grantedBy: extra!.grantedBy ?? actor, once: true });
  return taskById(id);
}

/**
 * Unblock one transient hold only when it is still the same wait.
 * A block that landed while the review prompt was in flight stays put.
 */
export function releaseSameTransient(
  id: number,
  actor: string,
  held: { blockedAt: string; agentId: string | null },
  extra?: Record<string, unknown>,
): TaskRow | null {
  return releaseSameBlock(id, actor, "transient", held, extra);
}

export function releaseSameScheduled(
  id: number, actor: string, held: { blockedAt: string; agentId: string | null; wakeId: string }, extra?: Record<string, unknown>,
): TaskRow | null {
  return releaseSameBlock(id, actor, "scheduled", held, extra);
}

export function releaseSameBackground(
  id: number, actor: string, held: { blockedAt: string; agentId: string | null; wakeId: string }, extra?: Record<string, unknown>,
): TaskRow | null {
  return releaseSameBlock(id, actor, "background", held, extra);
}

function releaseSameBlock(
  id: number, actor: string, kind: "transient" | "scheduled" | "background",
  held: { blockedAt: string; agentId: string | null; wakeId?: string }, extra?: Record<string, unknown>,
): TaskRow | null {
  const task = taskById(id);
  if (task.status !== "blocked" || task.blocked_kind !== kind) return null;
  if (task.blocked_at !== held.blockedAt || (task.agent_id ?? null) !== held.agentId) return null;
  if (kind !== "transient" && task.scheduled_wake_id !== held.wakeId) return null;
  const restore = (task.blocked_from as Status | null) ?? "ready";
  let target: Status = restore === "blocked" || restore === "archived" ? "ready" : restore;
  const departed = target === "running" || target === "reviewing" ? departedAgent(task) : null;
  if (departed) target = "ready";
  assertTransition("blocked", target);
  const ts = now();
  const where = `WHERE id = ? AND status = 'blocked' AND blocked_kind = ? AND blocked_at = ? AND agent_id IS ?
    AND scheduled_wake_id IS ?`;
  const info = departed
    ? getDb()
        .prepare(
          `UPDATE tasks SET status = ?, agent_id = NULL, blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, hold_reason = NULL, cooldown_until = NULL, background_wait_json = NULL, scheduled_until = NULL, scheduled_wake_id = NULL, scheduled_wake_text = NULL, scheduled_claim_id = NULL, scheduled_claim_until = NULL, nudge_count = 0, updated_at = ?
           ${where}`,
        )
        .run(target, ts, id, kind, held.blockedAt, held.agentId, task.scheduled_wake_id)
    : getDb()
        .prepare(
          `UPDATE tasks SET status = ?, blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, hold_reason = NULL, cooldown_until = NULL, background_wait_json = NULL, scheduled_until = NULL, scheduled_wake_id = NULL, scheduled_wake_text = NULL, scheduled_claim_id = NULL, scheduled_claim_until = NULL, nudge_count = 0, updated_at = ?
           ${where}`,
        )
        .run(target, ts, id, kind, held.blockedAt, held.agentId, task.scheduled_wake_id);
  if (info.changes !== 1) return null;
  if (departed) closeOpenRuns(id, "unblocked", ts);
  const data = departed
    ? { agentId: departed.agentId, reason: departed.reason, note: departed.note, ...(extra ?? {}) }
    : { ...(extra ?? {}) };
  addEvent(id, "unblocked", "blocked", target, actor, data);
  if (extra?.via !== "background_wait") resetRunBudget(id);
  return taskById(id);
}

export function archiveTask(id: number, actor: string): TaskRow {
  const task = taskById(id);
  assertTransition(task.status, "archived");
  const ts = now();
  const info = getDb()
    .prepare(`UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ? AND status = ?`)
    .run(ts, id, task.status);
  if (info.changes !== 1) throw new KanbanError("conflict", t("taskLifecycle.error.statusChanged", { card: cardMark(id) }), { id });
  addEvent(id, "archived", task.status, "archived", actor, {});
  revokeTaskWorkerTokens(id);
  const archived = taskById(id);
  notifyFinished(archived);
  return archived;
}

/** Reason recorded on the auto_archived event. */
export function autoArchiveReason(): string {
  return t("taskLifecycle.autoArchive.reason");
}

/**
 * Done → archived by the scheduler. Only a card still in done moves, so a card
 * the user archived or reopened in the meantime is left alone. Cleanup runs
 * through the same listener as a manual archive, and skips work already finished.
 */
export function autoArchiveTask(id: number, actor: string, data: Record<string, unknown> = {}): TaskRow | null {
  const ts = now();
  const info = getDb().prepare(`UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'done'`).run(ts, id);
  if (info.changes !== 1) return null;
  addEvent(id, "auto_archived", "done", "archived", actor, { reason: autoArchiveReason(), ...data });
  revokeTaskWorkerTokens(id);
  const archived = taskById(id);
  notifyFinished(archived);
  return archived;
}

/** When the card last entered done. Falls back to updated_at for cards with no such event. */
export function finishedAt(task: Pick<TaskRow, "id" | "updated_at">): string {
  const row = getDb()
    .prepare(`SELECT at FROM events WHERE task_id = ? AND to_status = 'done' ORDER BY id DESC LIMIT 1`)
    .get(task.id) as { at: string } | undefined;
  return row?.at ?? task.updated_at;
}

/** A done card with a GitHub PR whose PR is not known to be merged yet. */
export function awaitingMerge(task: Pick<TaskRow, "status">, contract: ContractState): boolean {
  const pr = contractPullRequest(contract);
  if (task.status !== "done" || !pr) return false;
  return cachedMergeState(pr)?.merged !== true;
}

/** Claim a card only if it is still in `from`. One UPDATE, so two racers cannot both win. */
export function claimStatus(id: number, from: Status, to: Status, actor: string): TaskRow {
  assertTransition(from, to);
  const ts = now();
  const info = getDb().prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?`).run(to, ts, id, from);
  if (info.changes !== 1) {
    const current = taskById(id);
    throw new KanbanError("conflict", t("taskLifecycle.error.claimConflict", { card: cardMark(id), actual: statusLabel(current.status), from: statusLabel(from) }), {
      id,
      from,
      to,
      actual: current.status,
    });
  }
  addEvent(id, "claim", from, to, actor, {});
  return taskById(id);
}
