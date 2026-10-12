import { getDb } from "./db";
import { loadConfig, projectSupervisor } from "./config";
import { parseTags } from "./profile-rules";

export const LEADER_UNRESPONSIVE_TAG = "leader-unresponsive";
const NON_LEADER_ACTORS = new Set(["scheduler", "kanban", "executor", "reviewer", "reader", "decision", "batch"]);

/** Scheduler bookkeeping must not masquerade as a leader action or reset card age. */
export function clearLeaderUnresponsive(project: string, reason: string, at: string, data: Record<string, unknown> = {}, taskId?: number): void {
  const db = getDb();
  const rows = (taskId == null
    ? db.prepare("SELECT id, status, tags FROM tasks WHERE project = ? AND tags LIKE ?").all(project, `%${LEADER_UNRESPONSIVE_TAG}%`)
    : db.prepare("SELECT id, status, tags FROM tasks WHERE project = ? AND id = ? AND tags LIKE ?").all(project, taskId, `%${LEADER_UNRESPONSIVE_TAG}%`)) as Array<{ id: number; status: string; tags: string | null }>;
  for (const row of rows) {
    if (taskId != null && row.id !== taskId) continue;
    const tags = parseTags(row.tags);
    if (!tags.includes(LEADER_UNRESPONSIVE_TAG)) continue;
    const rest = tags.filter(tag => tag !== LEADER_UNRESPONSIVE_TAG);
    const changed = db.prepare("UPDATE tasks SET tags = ? WHERE id = ? AND tags = ?").run(rest.length ? JSON.stringify(rest) : null, row.id, row.tags);
    if (changed.changes !== 1) continue;
    db.prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, ?, 'scheduler', ?)")
      .run(row.id, at, "leader_responsive", JSON.stringify({ reason, ...data }));
  }
}

/** Called synchronously for every persisted card event, including create/comment. */
export function noteLeaderAction(taskId: number, actor: string, kind: string, at: string): void {
  // Internal/worker bookkeeping is frequent (including native archive batches).
  // It can never be a supervisor action: skip before any DB/config I/O.
  if (NON_LEADER_ACTORS.has(actor)) return;
  const row = getDb().prepare("SELECT project FROM tasks WHERE id = ?").get(taskId) as { project: string } | undefined;
  if (!row) return;
  if (actor !== "supervisor" && actor !== projectSupervisor(row.project, loadConfig())) return;
  clearLeaderUnresponsive(row.project, "leader_action", at, { action: kind, actionTaskId: taskId, actor });
}
