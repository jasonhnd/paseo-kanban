import { basename, isAbsolute } from "node:path";
import { cardTmpEnv, type CardTmpContext } from "./card-tmp";
import { cardMarkOf } from "./card-ref";
import { getDb } from "./db";
import { appendEvent, type TaskRow } from "./store";
import { readWorktreeCreated } from "./worktree-record";

export function cardTmpTaskContext(task: TaskRow): CardTmpContext {
  return { project: task.project, workspacePath: readWorktreeCreated(task.id)?.root ?? task.workspace_path };
}

/** Host-owned event evidence, never an inherited TMPDIR or an agent-supplied label. */
export function preparedCardTmpDir(taskId: number, code: string): string | null {
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'card_tmp_prepared' ORDER BY id DESC LIMIT 1").get(taskId) as { data_json: string } | undefined;
  if (!row) return null;
  try {
    const path = JSON.parse(row.data_json).path;
    return typeof path === "string" && isAbsolute(path) && basename(path) === code ? path : null;
  } catch { return null; }
}

export function prepareTaskTmpEnv(task: TaskRow, actor: string): Record<string, string> {
  const code = cardMarkOf(task);
  const env = cardTmpEnv(code, cardTmpTaskContext(task), preparedCardTmpDir(task.id, code));
  if (env.KANBAN_TMP) appendEvent(task.id, "card_tmp_prepared", null, null, actor, { path: env.KANBAN_TMP });
  return env;
}
