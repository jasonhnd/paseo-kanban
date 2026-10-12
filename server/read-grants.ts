import { t } from "../shared/i18n";
import { loadConfig, projectSupervisor } from "./config";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { assertReadGrantScope } from "./identity";
import { clearLeaderUnresponsive } from "./leader-activity";
import { getTask, now, type TaskRow } from "./task-record";
import type { Identity } from "./tokens";

export function hasProjectRead(task: TaskRow): boolean {
  return task.project_read_scope === "project" && task.status !== "done" && task.status !== "archived";
}

/** Permission and audit event commit together; concurrent completion cannot leave a stale grant. */
export function changeReadGrant(id: number, scope: unknown, identity: Identity, revoke = false): TaskRow {
  const db = getDb();
  const validated = getTask(id);
  // Registration and agent-file checks may read files; keep them outside the write lock.
  assertReadGrantScope(identity, validated);
  if (!revoke && scope !== "project") throw new KanbanError("invalid", t("readGrants.scopeRequired"));
  if (!revoke && (validated.status === "done" || validated.status === "archived")) {
    throw new KanbanError("invalid", t("readGrants.finished"));
  }
  const actor = identity.agentId!;
  const leaderAction = actor === "supervisor" || actor === projectSupervisor(validated.project, loadConfig());
  const kind = revoke ? "revoke_read" : "grant_read";
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = getTask(id);
    if (task.status !== validated.status || task.project !== validated.project || task.updated_at !== validated.updated_at) {
      throw new KanbanError("conflict", t("readGrants.conflict"), { id });
    }
    const at = now();
    db.prepare("UPDATE tasks SET project_read_scope = ?, updated_at = ? WHERE id = ?")
      .run(revoke ? null : "project", at, id);
    // appendEvent also reads config for leader activity; use the registration checked above.
    db.prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, ?, ?, ?)")
      .run(id, at, kind, actor, JSON.stringify({ scope: "project", project: task.project, agentId: actor }));
    if (leaderAction) clearLeaderUnresponsive(task.project, "leader_action", at, { action: kind, actionTaskId: id, actor });
    db.exec("COMMIT");
    return getTask(id);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
