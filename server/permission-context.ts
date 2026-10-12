/// <reference types="node" />
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { findAgentFile } from "./open";
import { getDb } from "./db";
import { getTask } from "./store";
import { loadConfig } from "./config";
import { cardMarkOf } from "./card-ref";
import { cardTmpRoot } from "./card-tmp";
import type { TaskReadScope } from "./read-scope";

export interface PermissionContext {
  kanban: boolean; autoAccept: boolean; role: string | null; taskId: number | null;
  readScope?: TaskReadScope;
}

/** Host-owned runs/tasks are the authority. Labels and payload cannot grant roots. */
export function permissionContext(agentId: string): PermissionContext {
  const file = findAgentFile(agentId);
  const run = getDb().prepare("SELECT task_id, role, auto_accept, ended_at FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1").get(agentId) as
    { task_id: number; role: string; auto_accept: number; ended_at: string | null } | undefined;
  const labelRole = file?.labels?.role;
  const taskFromLabel = Number(file?.labels?.kanban_task);
  const ctx: PermissionContext = {
    kanban: Boolean(file?.labels && "kanban" in file.labels) || Boolean(run),
    autoAccept: run?.auto_accept === 1 || file?.featureValues?.auto_accept === true,
    role: run?.role ?? (labelRole && labelRole !== "personal" ? labelRole : null),
    taskId: run?.task_id ?? (Number.isSafeInteger(taskFromLabel) && taskFromLabel > 0 ? taskFromLabel : null),
  };
  if (!run || run.ended_at || !["reader", "decision"].includes(run.role)) return ctx;
  try {
    const task = getTask(run.task_id);
    if (task.agent_id !== agentId || !["running", "reviewing"].includes(task.status) || !task.workspace_path) return ctx;
    const config = loadConfig();
    const roots = [...(config.projects?.[task.project]?.permissionReadRoots ?? [])];
    let temporaryRoot: string | undefined;
    const code = cardMarkOf(task, config);
    if (/^[A-Za-z0-9]+_\d+$/.test(code)) {
      const tmp = join(cardTmpRoot(), code);
      // Never inherit the process's TMPDIR/HOME as a read grant. Only this code.
      const stat = lstatSync(tmp, { throwIfNoEntry: false });
      if (stat?.isDirectory() && !stat.isSymbolicLink()) temporaryRoot = tmp;
    }
    ctx.readScope = { taskId: task.id, workspace: task.workspace_path, roots, ...(temporaryRoot ? { temporaryRoot } : {}) };
  } catch { /* Missing task/config evidence leaves ordinary reads denied. */ }
  return ctx;
}
