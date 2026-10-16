/// <reference types="node" />
import { noteLeaderAction } from "./leader-activity";
import { t } from "../shared/i18n";
import { getDb } from "./db";
import { cardMark } from "./card-ref";
import { KanbanError } from "./errors";
import { clearExternalWait } from "./external-wait";
import { roleLabel, type Status } from "../shared/labels";

export interface TaskRow {
  id: number;
  project: string;
  title: string;
  brief: string;
  role: string;
  profile_override: string | null;
  status: Status;
  priority: number;
  idempotency_key: string | null;
  max_retries: number;
  max_runtime_sec: number | null;
  workspace_path: string | null;
  workspace_kind: string | null;
  workspace_base: string | null;
  contract_json: string | null;
  created_by: string | null;
  created_by_agent: string | null;
  agent_id: string | null;
  executor_agent_id: string | null;
  executor_profile: string | null;
  executor_family: string | null;
  review_round: number;
  /** Consecutive accept-time land conflicts. A clean land sets this back to 0. */
  land_conflict_count: number;
  handoff_json: string | null;
  blocked_kind: string | null;
  blocked_reason: string | null;
  blocked_from: string | null;
  blocked_at: string | null;
  scheduled_until: string | null;
  scheduled_wake_id: string | null;
  scheduled_claim_id: string | null;
  scheduled_claim_until: string | null;
  nudge_count: number;
  fail_count: number;
  cooldown_until: string | null;
  hold_reason: string | null;
  paseo_workspace_id: string | null;
  paseo_workspace_name: string | null;
  unattended_at: string | null;
  /** JSON array of card tags, e.g. ["high-risk"]. Null when the card has none. */
  tags: string | null;
  /** Forced reasoning depth for this card's own role. Null means use the profile default. */
  effort: string | null;
  /** Stored difficulty. Null means use the matrix default, or L4 when the card is high-risk. */
  tier: string | null;
  /** The card this review card is about. Null when the review is not tied to one card. */
  review_of: number | null;
  /** Per-project sequence. Together with the project's short code this is the number people see. */
  code_seq: number | null;
  /** Pending decision id when a <leader> paused this ready card with wait-user. Null otherwise. */
  wait_decision: string | null;
  /** Explicit project-wide read access. Cleared on submission, completion or archive. */
  project_read_scope: "project" | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: number;
  task_id: number;
  agent_id: string | null;
  role: string;
  profile_name: string | null;
  provider: string | null;
  model: string | null;
  family: string | null;
  auto_accept: number;
  thinking_option_id: string | null;
  /** Depth this run actually used. Null on runs recorded before the column existed. */
  effort: string | null;
  started_at: string;
  ended_at: string | null;
  end_kind: string | null;
}

export function now(): string {
  return new Date().toISOString();
}

export function asRows<T>(value: unknown): T[] {
  return value as T[];
}

export function taskById(id: number): TaskRow {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!row) throw new KanbanError("not_found", t("taskRecord.notFound", { card: cardMark(id) }), { id });
  return row;
}

export function addEvent(
  taskId: number,
  kind: string,
  from: string | null,
  to: string | null,
  actor: string,
  data: Record<string, unknown> = {},
  at?: string,
): number {
  // All committed status transitions pass through here, including recovery paths.
  // Ignore non-transition events and late events for a card that has moved again.
  if (from && (to === "rework" || to === "running" || kind === "leader_rework") && taskById(taskId).status === to) {
    clearExternalWait(taskId);
  }
  const eventAt = at ?? now();
  const info = getDb()
    .prepare(
      `INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(taskId, eventAt, kind, from, to, actor, JSON.stringify(data));
  noteLeaderAction(taskId, actor, kind, eventAt);
  return Number(info.lastInsertRowid);
}

export function addComment(taskId: number, author: string, body: string): void {
  taskById(taskId);
  getDb().prepare(`INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`).run(taskId, author, body, now());
}

export function getTask(id: number): TaskRow {
  return taskById(id);
}

export function appendEvent(
  taskId: number,
  kind: string,
  from: string | null,
  to: string | null,
  actor: string,
  data: Record<string, unknown> = {},
  at?: string,
): number {
  return addEvent(taskId, kind, from, to, actor, data, at);
}

export function latestRun(taskId: number): RunRow | null {
  return (getDb().prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1`).get(taskId) as RunRow | undefined) ?? null;
}

/** The run for whoever is assigned now, not the previous reviewer left at the top of the table. */
export function currentRun(task: TaskRow): RunRow | null {
  if (task.agent_id) {
    const matched = getDb()
      .prepare(`SELECT * FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1`)
      .get(task.id, task.agent_id) as RunRow | undefined;
    if (matched) return matched;
  }
  return latestRun(task.id);
}

/** Send-back opens a new run on the original executor's profile, model, and agent. */
export function openExecutorRun(taskId: number): void {
  const task = taskById(taskId);
  if (!task.executor_agent_id) return;
  const prior = getDb()
    .prepare(
      `SELECT profile_name, provider, model, family, auto_accept, thinking_option_id, effort
       FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, task.executor_agent_id) as
    | Pick<RunRow, "profile_name" | "provider" | "model" | "family" | "auto_accept" | "thinking_option_id" | "effort">
    | undefined;
  getDb()
    .prepare(
      `INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, effort, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      task.executor_agent_id,
      task.role,
      prior?.profile_name ?? task.executor_profile ?? task.profile_override,
      prior?.provider ?? null,
      prior?.model ?? null,
      prior?.family ?? task.executor_family,
      prior?.auto_accept ?? 0,
      prior?.thinking_option_id ?? null,
      prior?.effort ?? null,
      now(),
    );
}

export function earliestRun(taskId: number): RunRow | null {
  return (getDb().prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY id ASC LIMIT 1`).get(taskId) as RunRow | undefined) ?? null;
}

export function executorRun(task: TaskRow): RunRow | null {
  if (!task.executor_agent_id) return null;
  return (
    (getDb().prepare(`SELECT * FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id ASC LIMIT 1`).get(task.id, task.executor_agent_id) as RunRow | undefined) ??
    null
  );
}

export function modelOf(run: RunRow | null): string | null {
  if (!run?.model) return null;
  return run.thinking_option_id ? `${run.model} · ${run.thinking_option_id}` : run.model;
}

export function personText(role: string, profile: string | null, model: string | null, agentId: string | null): string {
  const label = roleLabel(role);
  const name = profile && profile !== label ? profile : label;
  const parts = [name];
  if (model) parts.push(model);
  if (agentId) parts.push(`agent ${agentId.slice(0, 8)}`);
  return parts.join(" · ");
}
