/// <reference types="node" />
import { onPullRequestMerged, watchPullRequest } from "./auto-archive";
import { t } from "../shared/i18n";
import { getDb } from "./db";
import { childFinished } from "./deps";
import { KanbanError } from "./errors";
import { guardCardSync } from "./guard";
import { parentPulls, parentsBlockReason, taskParents } from "./parents";
import { addComment, claimStatus, getTask, recordMergeCardDependencies } from "./store";
import { notifyAcceptance, notifyChildren, notifyParentMergeProblem } from "./wake";

function watchParents(taskId: number, observed: Set<number>, now = Date.now()): ReturnType<typeof taskParents> {
  const parents = taskParents(taskId);
  const child = getTask(taskId);
  recordMergeCardDependencies(child, parents, "scheduler");
  for (const pr of parentPulls(parents, child)) watchPullRequest(pr, now);
  for (const parent of parents) {
    if (observed.has(parent.id)) continue;
    observed.add(parent.id);
    notifyParentMergeProblem(parent.id).catch((err: unknown) => {
      console.error("[paseo-kanban] parent merge notice", parent.id, err instanceof Error ? err.message : err);
    });
  }
  return parents;
}

export function promoteWaiting(actor: string, now = Date.now()): number[] {
  const rows = getDb().prepare("SELECT id FROM tasks WHERE status = 'waiting' ORDER BY priority DESC, id ASC").all() as unknown as Array<{ id: number }>;
  const promoted: number[] = [];
  const observed = new Set<number>();
  for (const row of rows) {
    guardCardSync(row.id, "tick.promote", () => {
      const parents = watchParents(row.id, observed, now);
      if (parents.length === 0 || parentsBlockReason(parents, now, getTask(row.id)) !== null) return;
      try {
        claimStatus(row.id, "waiting", "ready", actor);
        getDb().prepare("UPDATE tasks SET unattended_at = NULL WHERE id = ?").run(row.id);
        promoted.push(row.id);
      } catch (err) {
        if (!(err instanceof KanbanError) || err.code !== "conflict") throw err;
      }
    }, new Date(now));
  }
  return promoted;
}

// A parent PR seen merged releases its waiting children in the same round, not at the next tick.
onPullRequestMerged(() => {
  promoteWaiting("scheduler");
});

/** Triage parents move to acceptance only after every child has finished its own work. */
export function promoteParents(actor: string): number[] {
  const rows = getDb().prepare("SELECT id FROM tasks WHERE status = 'triage' ORDER BY id ASC").all() as unknown as Array<{ id: number }>;
  const promoted: number[] = [];
  for (const row of rows) {
    guardCardSync(row.id, "tick.promoteParents", () => {
      const children = getDb()
        .prepare("SELECT t.status FROM links l JOIN tasks t ON t.id = l.task_id WHERE l.parent_id = ?")
        .all(row.id) as unknown as Array<{ status: string }>;
      if (children.length === 0 || !children.every((item) => childFinished(item.status))) return;
      try {
        claimStatus(row.id, "triage", "acceptance", actor);
      } catch (err) {
        if (!(err instanceof KanbanError) || err.code !== "conflict") throw err;
        return;
      }
      addComment(row.id, actor, t("promote.allChildrenDone"));
      notifyChildren(row.id);
      notifyAcceptance(row.id);
      promoted.push(row.id);
    });
  }
  return promoted;
}
