/// <reference types="node" />
import { prepareNativeSession, nativeSessionAfterArchive } from "./native-sessions";
import { t } from "../shared/i18n";
import { loadConfig } from "./config";
import { getDb } from "./db";
import type { AgentListItem } from "./paseo";
import { appendEvent, type TaskRow } from "./store";
import { isLeaderSessionTitle } from "./supervisor";

/** Keep the cutoff at process birth, including agents opened before an early bind succeeds. */
export const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000);

function registered(task: TaskRow, agentId: string): boolean {
  if (task.agent_id === agentId || task.executor_agent_id === agentId) return true;
  const db = getDb();
  if (db.prepare("SELECT id FROM runs WHERE task_id = ? AND agent_id = ? LIMIT 1").get(task.id, agentId)) return true;
  const events = db.prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'agent_opened'").all(task.id) as unknown as Array<{ data_json: string }>;
  for (const event of events) {
    // An unreadable registration cannot safely be treated as no registration.
    const data = JSON.parse(event.data_json) as { agentId?: unknown } | null;
    if (data?.agentId === agentId) return true;
  }
  return false;
}

/** A shared barrier: successful reconciliation runs once; failures leave dispatch gated for retry. */
export function createStartupReconciler(options: {
  listAgents(): Promise<AgentListItem[]>;
  archiveAgent(agentId: string): Promise<void>;
  startedAt?: Date;
}): () => Promise<void> {
  const cutoff = (options.startedAt ?? PROCESS_STARTED_AT).getTime();
  if (!Number.isFinite(cutoff)) throw new Error(t("startupOrphans.noStartTime"));
  let done = false;
  let pending: Promise<void> | null = null;
  return () => {
    if (done) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      const agents = await options.listAgents();
      for (const agent of agents) {
        if (agent.archived || agent.labels?.kanban !== "1") continue;
        if (agent.labels.role === "supervisor" || isLeaderSessionTitle(agent.title ?? "")) continue;
        const label = agent.labels.kanban_task;
        if (!label || !/^\d+$/.test(label)) continue;
        const taskId = Number(label);
        if (!Number.isSafeInteger(taskId) || taskId <= 0) continue;
        const createdAt = Date.parse(agent.createdAt ?? "");
        if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
        const task = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
        if (!task || registered(task, agent.id)) continue;
        const config = loadConfig();
        if (config.supervisorAgentId === agent.id || Object.values(config.supervisors).includes(agent.id)) continue;
        await prepareNativeSession(task.id, agent.id);
        await options.archiveAgent(agent.id);
        nativeSessionAfterArchive(task.id, agent.id);
        appendEvent(task.id, "orphan_agent_discarded", null, null, "scheduler", {
          agentId: agent.id,
          cwd: agent.cwd ?? null,
          reason: t("startupOrphans.reason"),
        });
      }
      done = true;
    }).finally(() => { pending = null; });
    return pending;
  };
}
