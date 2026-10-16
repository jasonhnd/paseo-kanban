/// <reference types="node" />
import { findDecision, type DecisionLookup } from "./decisions";
import { getDb } from "./db";
import { dependencyMet } from "./deps";
import { KanbanError } from "./errors";
import type { TaskRow } from "./task-record";
import { addEvent, now, taskById } from "./task-record";
import { resumableAgentId } from "./task-lifecycle";
import { parentsBlockReason, taskParents } from "./parents";
import { cachedMergeState, contractPullRequest, readContract } from "./pr";
import { t } from "../shared/i18n";

/** Pending-decision id: the cockpit's d1005-091216-1, or k1005-091216-1 from the board's own list. */
export const DECISION_ID = /^[dk]\d{4}-\d{6}-\d+$/;
/**
 * Accept current Kanban wording and the legacy AFC spelling for automatic reminders: "AFC automatic reminder", or the
 * Chinese wording "AFC \u81ea\u52a8\u63d0\u9192" that cards and schedules have always used.
 */
const AFC_REMINDER = /(?:AFC|Kanban|\u770b\u677f)\s*(?:\u81ea\u52a8\u63d0\u9192|automatic\s+reminder)/i;

/** The hold reason a waiting card shows (and stores): "Waiting for user: <decision id>". */
export function waitUserHold(decision: string): string {
  return t("waitUser.hold", { decision });
}

/** Trim and validate a pending-decision id. Returns null when the flag was not given. */
export function parseDecisionId(value: unknown, required = false): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw new KanbanError("invalid", t("waitUser.decisionRequired"));
    return null;
  }
  if (!DECISION_ID.test(text)) throw new KanbanError("invalid", t("waitUser.decisionMalformed", { text }));
  return text;
}

/** Pause ready, or atomically convert a needs_human block to ready with a user hold. */
export function waitUser(id: number, decision: string, actor: string): TaskRow {
  decision = parseDecisionId(decision, true)!;
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read under the write lock: scope was checked by the handler before entering here,
    // but unblock/start may have changed the state while that check was in flight.
    const task = taskById(id);
    const blocked = task.status === "blocked" && task.blocked_kind === "needs_human";
    if (task.status !== "ready" && !blocked) {
      throw new KanbanError("illegal_transition", t("waitUser.onlyReady"), { from: task.status, kind: task.blocked_kind });
    }
    // Never replace another decision, or take over a blocked card whose start/resume is
    // still active. Ready keeps the existing pre-launch wait behaviour: dispatch checks
    // wait_decision again before claiming running/reviewing and releases its own claim.
    if (task.wait_decision && task.wait_decision !== decision) {
      throw new KanbanError("conflict", t("waitUser.alreadyWaiting", { decision: task.wait_decision }), { id });
    }
    if (blocked && (db.prepare("SELECT 1 FROM start_claims WHERE task_id = ?").get(id) || resumableAgentId(task))) {
      throw new KanbanError("conflict", t("waitUser.activeStart"), { id });
    }
    if (blocked) {
      // A block covering waiting still needs the full admission gate. An already
      // admitted card must not depend on a fresh CLI's empty process-local PR cache:
      // keep unfinished parents and known unmerged PRs gated, without querying gh.
      const parents = taskParents(id).filter(parent => {
        if (task.blocked_from === "waiting" || !dependencyMet(parent.status)) return true;
        const pr = contractPullRequest(readContract(parent.contract_json));
        const cached = pr ? cachedMergeState(pr) : null;
        return cached !== null && !cached.merged;
      });
      const reason = parentsBlockReason(parents, Date.now(), task);
      if (reason) throw new KanbanError("not_ready", t("waitUser.parentsWaiting", { reason }), { id });
    }
    if (task.status === "ready" && task.wait_decision === decision && task.hold_reason === waitUserHold(decision)) {
      db.exec("COMMIT");
      return task;
    }
    const at = now();
    const info = blocked
      ? db.prepare(`UPDATE tasks SET status = 'ready', wait_decision = ?, hold_reason = ?,
          blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'blocked' AND blocked_kind = 'needs_human'
          AND NOT EXISTS (SELECT 1 FROM start_claims WHERE task_id = tasks.id)`)
        .run(decision, waitUserHold(decision), at, id)
      : db.prepare("UPDATE tasks SET wait_decision = ?, hold_reason = ?, updated_at = ? WHERE id = ? AND status = 'ready'")
        .run(decision, waitUserHold(decision), at, id);
    if (info.changes !== 1) throw new KanbanError("conflict", t("waitUser.raced"), { id });
    addEvent(id, "wait_user", task.status, "ready", actor, { decision }, at);
    const waiting = taskById(id);
    db.exec("COMMIT");
    return waiting;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Clear the wait. The card is ordinary ready again and the next round may start it. */
export function unwait(id: number, actor: string): TaskRow {
  const task = taskById(id);
  if (!task.wait_decision) throw new KanbanError("invalid", t("waitUser.notWaiting"), { id });
  getDb().prepare("UPDATE tasks SET wait_decision = NULL, hold_reason = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  addEvent(id, "wait_user_cleared", task.status, task.status, actor, { decision: task.wait_decision });
  return taskById(id);
}

/**
 * The decision must exist and be answered by the user (status done): in the cockpit's full
 * decisions.json (ROLES_STATE_DIR first; the contract export lists open decisions only, so it
 * cannot say whether one was decided), or in the board's own list when the cockpit is not
 * installed. Never writes either file.
 */
export function assertDecisionDecided(decision: string): void {
  let lookup: DecisionLookup;
  try {
    lookup = findDecision(decision);
  } catch (err) {
    throw new KanbanError("invalid", t("waitUser.listUnreadable", { detail: err instanceof Error ? err.message : String(err), decision }));
  }
  if (!lookup.found && !lookup.readable) {
    throw new KanbanError("invalid", t("waitUser.listUnreadable", { detail: lookup.where, decision }));
  }
  if (!lookup.found) throw new KanbanError("invalid", t("waitUser.notFound", { decision }));
  if (lookup.status !== "done") throw new KanbanError("invalid", t("waitUser.notDecided", { decision, status: lookup.status }));
}

/** AFC's automatic reminders (schedule agents, or a card that says so) must cite a decided pending decision. */
export function assertReminderGuard(opts: { isSchedule: boolean; title: string; brief: string; decision: string | null }): void {
  const reminder = opts.isSchedule || AFC_REMINDER.test(opts.title) || AFC_REMINDER.test(opts.brief);
  if (!reminder) return;
  if (!opts.decision) throw new KanbanError("invalid", t("waitUser.reminderNeedsDecision"));
  assertDecisionDecided(opts.decision);
}
