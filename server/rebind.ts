/// <reference types="node" />
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import type { AgentPresence } from "./presence";
import { assertTransition } from "./state";
import { appendEvent, getTask, type TaskRow } from "./store";
import { statusLabel, type Status } from "../shared/labels";
import { t } from "../shared/i18n";

const REBIND_FROM = new Set<Status>(["ready", "blocked", "in_review"]);

export interface RebindResult {
  id: number;
  title: string;
  status: string;
  project: string;
  agentId: string;
  text: string;
}

interface PriorRun {
  role: string;
  profile_name: string | null;
  provider: string | null;
  model: string | null;
  family: string | null;
  auto_accept: number;
  thinking_option_id: string | null;
  effort: string | null;
}

function reboundStatus(task: TaskRow): Status {
  if (task.status === "in_review") return "reviewing";
  if (task.status === "blocked" && (task.blocked_from === "in_review" || task.blocked_from === "reviewing")) return "reviewing";
  return "running";
}

function hint(id: number, agentId: string, status: string): string {
  return [
    t("rebind.hint.rebound", { card: cardMark(id), agent: agentId, status: statusLabel(status) }),
    t("rebind.hint.noToken"),
    t("rebind.hint.complete", { id }),
    t("rebind.hint.review"),
  ].join("\n");
}

/**
 * Put a card that was reclaimed to ready / in_review, or blocked to stop a redispatch,
 * back on an agent that already ran it and is still open.
 * Does not issue a token: the agent's MCP config cannot be updated.
 */
export function rebindTask(taskId: number, agentId: string, presence: AgentPresence): RebindResult {
  const id = agentId.trim();
  if (!id) throw new KanbanError("invalid", t("rebind.error.noAgent"));
  if (presence === "archived") throw new KanbanError("invalid", t("rebind.error.archived"));
  if (presence === "closed") throw new KanbanError("invalid", t("rebind.error.closed"));
  if (presence === "missing") throw new KanbanError("invalid", t("rebind.error.missing"));
  if (presence === "unknown") throw new KanbanError("invalid", t("rebind.error.unknown"));

  const task = getTask(taskId);
  if (!REBIND_FROM.has(task.status)) {
    throw new KanbanError("illegal_transition", t("rebind.error.wrongStatus", { status: statusLabel(task.status) }));
  }
  const prior = getDb()
    .prepare(
      `SELECT role, profile_name, provider, model, family, auto_accept, thinking_option_id, effort
       FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, id) as PriorRun | undefined;
  if (!prior) throw new KanbanError("invalid", t("rebind.error.neverRan"));

  const to = reboundStatus(task);
  assertTransition(task.status, to);
  const ts = new Date().toISOString();
  const info = getDb()
    .prepare(
      `UPDATE tasks
       SET status = ?, agent_id = ?, nudge_count = 0,
           blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL,
           hold_reason = NULL, cooldown_until = NULL, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .run(to, id, ts, taskId, task.status);
  if (info.changes !== 1) throw new KanbanError("conflict", t("rebind.error.changed", { card: cardMark(taskId) }), { id: taskId });

  getDb().prepare(`UPDATE runs SET ended_at = ?, end_kind = 'rebound' WHERE task_id = ? AND ended_at IS NULL`).run(ts, taskId);
  getDb()
    .prepare(
      `INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, effort, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(taskId, id, prior.role, prior.profile_name, prior.provider, prior.model, prior.family, prior.auto_accept ?? 0, prior.thinking_option_id, prior.effort, ts);

  const reason = t("rebind.event.reason");
  appendEvent(taskId, "rebound", task.status, to, "supervisor", { agentId: id, reason });
  const next = getTask(taskId);
  return {
    id: next.id,
    title: next.title,
    status: next.status,
    project: next.project,
    agentId: id,
    text: hint(next.id, id, next.status),
  };
}
