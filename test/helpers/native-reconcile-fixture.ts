import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../../server/db";
import { loadConfig, saveConfig } from "../../server/config";
import { createTask } from "../../server/store";

/** Disposable board metadata only; no daemon or desktop application is called. */
export function nativeReconcileFixture() {
  const home = mkdtempSync(join(tmpdir(), "native-reconcile-"));
  const saved = process.env.KANBAN_DATA_DIR;
  closeDb();
  process.env.KANBAN_DATA_DIR = join(home, "board");
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader" });
  const env = { PASEO_AGENT_ID: "board-leader" };
  const queue = (provider: string, sessionId: string, project = "demo") => {
    const task = createTask({ project, title: "Native metadata fixture", role: "executor" });
    const agentId = `agent-${task.id}`;
    getDb().prepare(`INSERT INTO native_session_queue
      (agent_id, task_id, provider, session_id, cwd, home, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(agentId, task.id, provider, sessionId, "/work/demo", home);
    return agentId;
  };
  const status = (agentId: string) => getDb().prepare("SELECT status FROM native_session_queue WHERE agent_id = ?").get(agentId)!.status;
  const cleanup = () => {
    closeDb();
    if (saved === undefined) delete process.env.KANBAN_DATA_DIR;
    else process.env.KANBAN_DATA_DIR = saved;
    rmSync(home, { recursive: true, force: true });
  };
  return { home, env, queue, status, cleanup };
}
