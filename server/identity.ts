/// <reference types="node" />
import { t } from "../shared/i18n";
import type { DatabaseSync } from "node:sqlite";
import { envAgentId } from "./agent-id";
import { assertConfigReadable, loadConfig, projectSupervisor, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { findAgentFile } from "./open";
import type { TaskRow } from "./store";
import { ensureSupervisorToken, identityFromToken, tokenExpired, type Identity } from "./tokens";

const WORKER_ROLES = new Set(["executor", "reviewer", "reader", "decision", "batch"]);

/** A hand-opened Paseo agent that Kanban did not launch and that is not a registered <leader>: read-only. */
export const GUEST_ROLE = "guest";
/** An agent a Paseo schedule opened (label paseo.schedule-id): may read and create cards, nothing else. */
export const SCHEDULE_ROLE = "schedule";
const SCHEDULE_LABEL = "paseo.schedule-id";

function workerRole(role: string | null | undefined): string {
  if (role && WORKER_ROLES.has(role)) return role;
  return "executor";
}

/** An agent Kanban itself opened. Those keep the card's role and never become the supervisor. */
export function kanbanLaunched(agentId: string, db: DatabaseSync = getDb()): Identity | null {
  const task = db
    .prepare(`SELECT id, role, agent_id FROM tasks WHERE agent_id = ? OR executor_agent_id = ? ORDER BY id DESC LIMIT 1`)
    .get(agentId, agentId) as { id: number; role: string; agent_id: string | null } | undefined;
  if (task) {
    if (task.agent_id === agentId) {
      const run = db.prepare(`SELECT role FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1`).get(task.id, agentId) as
        | { role: string }
        | undefined;
      if (run && WORKER_ROLES.has(run.role)) return { role: run.role, taskId: task.id, agentId };
    }
    return { role: workerRole(task.role), taskId: task.id, agentId };
  }

  const run = db.prepare(`SELECT task_id, role FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1`).get(agentId) as
    | { task_id: number; role: string }
    | undefined;
  if (run) {
    const card = db.prepare(`SELECT role FROM tasks WHERE id = ?`).get(run.task_id) as { role: string } | undefined;
    return { role: workerRole(card?.role ?? run.role), taskId: run.task_id, agentId };
  }

  const token = db.prepare(`SELECT task_id, role FROM tokens WHERE agent_id = ? AND role != 'guest' ORDER BY created_at DESC LIMIT 1`).get(agentId) as
    | { task_id: number | null; role: string }
    | undefined;
  if (token) return { role: workerRole(token.role), taskId: token.task_id, agentId };

  const file = findAgentFile(agentId);
  const label = file?.labels?.kanban;
  if (label === "1" || label === "true") return { role: workerRole(file?.labels?.role), taskId: null, agentId };
  return null;
}

/** Registered as some project's <leader> (supervisors.<project>) or as the Kanban <leader> (supervisorAgentId). */
export function isRegisteredLeader(agentId: string, config: KanbanConfig = loadConfig()): boolean {
  if (config.supervisorAgentId === agentId) return true;
  return Object.values(config.supervisors).some((id) => id.trim() === agentId);
}

export function isKanbanLeader(agentId: string | null, config: KanbanConfig = loadConfig()): boolean {
  return !!agentId && config.supervisorAgentId === agentId;
}

function scheduleLaunched(agentId: string): boolean {
  const label = findAgentFile(agentId)?.labels?.[SCHEDULE_LABEL];
  return typeof label === "string" && label.trim() !== "";
}

/**
 * Identity of a PASEO_AGENT_ID without a token. A board-launched agent keeps its card role;
 * a registered <leader> is the supervisor; a schedule agent may create cards; anyone else is a read-only guest.
 */
export function agentIdentity(agentId: string, db?: DatabaseSync): Identity {
  const launched = kanbanLaunched(agentId, db);
  if (launched) return launched;
  if (isRegisteredLeader(agentId)) return { role: "supervisor", taskId: null, agentId };
  if (scheduleLaunched(agentId)) return { role: SCHEDULE_ROLE, taskId: null, agentId };
  return { role: GUEST_ROLE, taskId: null, agentId };
}

/**
 * CLI identity.
 * A token wins. Otherwise PASEO_AGENT_ID is checked for shape and resolved by agentIdentity,
 * and a shell with neither variable is the unrestricted supervisor.
 */
export function resolveCliIdentity(env: NodeJS.ProcessEnv): Identity {
  const token = env.KANBAN_TOKEN?.trim();
  if (token) {
    try {
      const identity = identityFromToken(token);
      return identity.role === GUEST_ROLE && identity.agentId ? agentIdentity(identity.agentId) : identity;
    } catch (err) {
      throw new KanbanError("unauthorized", err instanceof Error ? err.message : String(err));
    }
  }
  const agentId = envAgentId(env);
  if (agentId) return agentIdentity(agentId);
  return identityFromToken(ensureSupervisorToken());
}

/**
 * Identity for compact-events. Reads an already-open database and does not create a token.
 * A shell with no token and no agent id is the supervisor. An agent id resolves as in resolveCliIdentity.
 */
export function resolveCompactIdentity(env: NodeJS.ProcessEnv, db: DatabaseSync): Identity {
  const token = env.KANBAN_TOKEN?.trim();
  if (token) {
    const row = db.prepare("SELECT role, task_id, agent_id, expires_at FROM tokens WHERE token = ?").get(token) as
      | { role: string; task_id: number | null; agent_id: string | null; expires_at: string | null }
      | undefined;
    if (!row || tokenExpired(row.expires_at)) throw new KanbanError("unauthorized", t("identity.tokenInvalid"));
    return { role: row.role, taskId: row.task_id, agentId: row.agent_id };
  }
  const agentId = envAgentId(env);
  if (agentId) return agentIdentity(agentId, db);
  return { role: "supervisor", taskId: null, agentId: null };
}

const GUEST_COMMANDS = new Set(["list", "show", "supervise", "handover"]);
const SCHEDULE_COMMANDS = new Set(["list", "show", "create"]);

/** Refusal for a guest. A broken config file hides every registration, so it is reported instead. */
export function guestForbidden(agentId: string | null): KanbanError {
  assertConfigReadable();
  return new KanbanError("forbidden", guestDenial(agentId));
}

export function guestDenial(agentId: string | null): string {
  return t("identity.guestDenial", { agentId: agentId ?? "" });
}

export function scheduleDenial(what: string): string {
  return t("identity.scheduleDenial", { action: what });
}

/** Guests and schedule agents only get their few commands; everything else is refused before it runs. */
export function assertCliCommandAllowed(identity: Identity, command: string): void {
  if (identity.role === GUEST_ROLE && !GUEST_COMMANDS.has(command)) throw guestForbidden(identity.agentId);
  if (identity.role === SCHEDULE_ROLE && !SCHEDULE_COMMANDS.has(command)) throw new KanbanError("forbidden", scheduleDenial(command));
}

/** Stuck by the board itself: dispatch, fuse, nudge, or a quota/transient/rate-limit hold. */
export function boardCausedBlock(task: TaskRow): boolean {
  if (task.status !== "blocked") return false;
  if (task.blocked_kind === "quota" || task.blocked_kind === "transient" || task.blocked_kind === "rate_limit") return true;
  const row = getDb()
    .prepare(`SELECT actor FROM events WHERE task_id = ? AND kind = 'blocked' ORDER BY id DESC LIMIT 1`)
    .get(task.id) as { actor: string | null } | undefined;
  return row?.actor === "scheduler" || row?.actor === "kanban";
}

/**
 * The action text callers passed for unblock before the text was translated. Still accepted so a caller
 * that passes the old literal keeps the Kanban <leader>'s unblock exception.
 */
const LEGACY_UNBLOCK_ACTION = "\u89e3\u9664\u5361\u4f4f";

export interface SupervisorScopeOptions {
  /** Set by the unblock command: the Kanban <leader> may then unblock a block the board itself caused. */
  unblock?: boolean;
  /** Cleanup fallback belongs to the Kanban leader across every project. */
  resumeCleanup?: boolean;
}

/** `action` is display text only (it goes into the refusal); behaviour is chosen by `options`. */
export function assertSupervisorScope(identity: Identity, task: TaskRow, action: string, options: SupervisorScopeOptions = {}): void {
  if (identity.role !== "supervisor" || !identity.agentId) return;
  if (task.created_by_agent === identity.agentId) return;
  if (projectSupervisor(task.project) === identity.agentId) return;
  if (options.resumeCleanup && isKanbanLeader(identity.agentId)) return;
  const unblock = options.unblock === true || action === LEGACY_UNBLOCK_ACTION;
  if (unblock && loadConfig().supervisorAgentId === identity.agentId && boardCausedBlock(task)) return;
  throw new KanbanError("forbidden", t("identity.otherProjectCard", { action, project: task.project }));
}

/** Destructive cleanup needs a registered project/Kanban leader, never a card-bound token or anonymous shell. */
export function assertDiscardCleanupScope(identity: Identity, task: TaskRow): void {
  if (identity.role !== "supervisor" || identity.taskId != null || !identity.agentId ||
      (projectSupervisor(task.project) !== identity.agentId && !isKanbanLeader(identity.agentId))) {
    throw new KanbanError("forbidden", t("cleanupDiscard.onlyLeader"));
  }
}

/** Adjudication belongs to the registered project leader or the Kanban leader. */
export function assertLeaderDecisionScope(identity: Identity, task: TaskRow): void {
  if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("identity.onlyLeaderRules"));
  // Preserve the existing unrestricted identity for a user running the CLI directly.
  if (!identity.agentId) return;
  if (projectSupervisor(task.project) === identity.agentId || loadConfig().supervisorAgentId === identity.agentId) return;
  throw new KanbanError("forbidden", t("identity.otherProjectRule", { project: task.project }));
}

/** Removing dependencies belongs to the registered project leader or the Kanban leader. */
export function assertUnlinkScope(identity: Identity, task: TaskRow): void {
  if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("identity.onlyLeaderUnlink"));
  if (!identity.agentId) return; // User CLI, matching existing leader operations.
  if (projectSupervisor(task.project) === identity.agentId || loadConfig().supervisorAgentId === identity.agentId) return;
  throw new KanbanError("forbidden", t("identity.otherProjectUnlink", { project: task.project }));
}

/** Pausing a card for the user belongs to the project's registered <leader> or the Kanban <leader>. */
export function assertWaitUserScope(identity: Identity, task: TaskRow, action: string): void {
  if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("identity.onlyLeaderAction", { action }));
  if (!identity.agentId) return;
  if (projectSupervisor(task.project) === identity.agentId || isKanbanLeader(identity.agentId)) return;
  throw new KanbanError("forbidden", t("identity.otherProjectAction", { action, project: task.project }));
}

/** Read grants require an actual registered leader, never a card-bound or anonymous token. */
export function assertReadGrantScope(identity: Identity, task: TaskRow): void {
  if (identity.role !== "supervisor" || identity.taskId != null || !identity.agentId || scheduleLaunched(identity.agentId)) {
    throw new KanbanError("forbidden", t("readGrants.onlyLeader"));
  }
  const config = loadConfig();
  if (projectSupervisor(task.project, config) === identity.agentId || isKanbanLeader(identity.agentId, config)) return;
  throw new KanbanError("forbidden", t("readGrants.otherProject", { project: task.project }));
}

/**
 * Create, backfill and project settings: an agent-bound <leader> only in a project it is registered for,
 * or the Kanban <leader> anywhere. A shell without an agent id stays unrestricted.
 */
export function assertProjectScope(identity: Identity, project: string, action: string): void {
  if (identity.role !== "supervisor" || !identity.agentId) return;
  const config = loadConfig();
  if (projectSupervisor(project, config) === identity.agentId || isKanbanLeader(identity.agentId, config)) return;
  throw new KanbanError("forbidden", t("identity.otherProjectScope", { action, project }));
}

/** Binding a registered <leader> id to a card would make it resolve as that card's worker. */
export function assertNotLeaderAgent(agentId: string): void {
  const config = loadConfig();
  if (!isRegisteredLeader(agentId, config)) return;
  const projects = Object.entries(config.supervisors).filter(([, id]) => id === agentId).map(([name]) => name);
  const where = [...projects, ...(config.supervisorAgentId === agentId ? ["Kanban"] : [])].join(t("common.listSep"));
  throw new KanbanError("forbidden", t("identity.leaderNotBindable", { agentId, where }));
}
