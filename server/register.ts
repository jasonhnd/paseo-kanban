/// <reference types="node" />
import { takeCodeSeq } from "./card-ref";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { agentCreatedAt } from "./open";
import { appendEvent, getTask, type TaskRow } from "./store";
import { hookObjects } from "./hook-objects";
import { t } from "../shared/i18n";

export interface RegisterInput {
  project: string;
  title: string;
  brief: string;
  role: string;
  profileName: string;
  provider: string;
  model: string;
  thinking?: string;
  agentId: string;
  family?: string;
  workspacePath?: string;
  idempotencyKey?: string;
  actor?: string;
  /** Overrides the agent file. Tests pass this; real backfill reads createdAt. */
  startedAt?: string;
}

/** Record a card that is already being worked, without creating an agent. */
export function registerTask(input: RegisterInput): TaskRow {
  const project = input.project.trim();
  const title = input.title.trim();
  const agentId = input.agentId.trim();
  if (!project || !title || !input.role.trim() || !agentId) throw new KanbanError("invalid", t("register.error.emptyFields"));
  if (!input.profileName.trim() || !input.provider.trim() || !input.model.trim()) throw new KanbanError("invalid", t("register.error.emptyProfile"));
  const db = getDb();
  const startedAt = input.startedAt?.trim() || agentCreatedAt(agentId);
  if (input.idempotencyKey) {
    const existing = db.prepare("SELECT id FROM tasks WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: number } | undefined;
    if (existing) {
      if (startedAt) {
        db.prepare("UPDATE runs SET started_at = ? WHERE task_id = ? AND agent_id = ?").run(startedAt, existing.id, agentId);
      }
      const task = getTask(existing.id);
      if (task.agent_id) hookObjects.rememberAgent(task.agent_id);
      if (task.executor_agent_id) hookObjects.rememberAgent(task.executor_agent_id);
      return task;
    }
  }
  if (!startedAt) throw new KanbanError("invalid", t("register.error.noCreatedAt", { agentId }));
  const ts = new Date().toISOString();
  const actor = input.actor ?? "supervisor";
  const codeSeq = takeCodeSeq(project);
  const info = db
    .prepare(
      `INSERT INTO tasks (
        project, title, brief, role, profile_override, status, idempotency_key, workspace_path,
        created_by, agent_id, executor_agent_id, executor_profile, executor_family, code_seq, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project,
      title,
      input.brief,
      input.role.trim(),
      input.profileName.trim(),
      input.idempotencyKey ?? null,
      input.workspacePath ?? null,
      actor,
      agentId,
      agentId,
      input.profileName.trim(),
      input.family ?? null,
      codeSeq,
      ts,
      ts,
    );
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, effort, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, agentId, input.role.trim(), input.profileName.trim(), input.provider.trim(), input.model.trim(), input.family ?? null, input.thinking ?? null, input.thinking ?? null, startedAt);
  hookObjects.rememberAgent(agentId);
  appendEvent(id, "registered", null, "running", actor, { note: t("register.event.note"), agentId, profile: input.profileName.trim() });
  return getTask(id);
}
