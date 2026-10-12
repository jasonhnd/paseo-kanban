import { assertSafeAgentId } from "./agent-id";
import { loadConfig, projectSupervisor, resolveSupervisorProject } from "./config";
import { withConfigLock } from "./config-lock";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { GUEST_ROLE, kanbanLaunched } from "./identity";
import { assertLeaderGone, changeKanbanLeader, changeProjectLeader } from "./leader-registry";
import type { Identity } from "./tokens";
import { appendEvent } from "./store";
import { t } from "../shared/i18n";

/** Reason recorded on each creator_changed event a handover writes. */
export function handoverReason(): string {
  return t("handover.reason");
}
const OPEN_STATUS_SQL = `status NOT IN ('done', 'archived')`;

export interface HandoverInput {
  project?: string;
  to: string;
  from?: string;
  dryRun: boolean;
  kanbanLeader: boolean;
}

export interface HandoverResult {
  ok: true;
  dryRun: boolean;
  scope: "project" | "kanban-leader";
  project: string | null;
  from: string;
  to: string;
  taskIds: number[];
  /** Whether supervisors.<project> (or supervisorAgentId) was or would be updated. */
  registryUpdated: boolean;
  text: string;
}

/** A <leader> session (registered or not yet) with an agent id. Workers, schedule agents and the bare shell are refused. */
function assertHandoverCaller(identity: Identity): string {
  if (identity.role !== "supervisor" && identity.role !== GUEST_ROLE) throw new KanbanError("forbidden", t("handover.error.notLeader"));
  if (!identity.agentId) throw new KanbanError("forbidden", t("handover.error.noAgentId"));
  return identity.agentId;
}

interface HandoverScope {
  caller: string;
  kanbanLeader: string | null;
  /** Registered <leader> of this scope before the handover. */
  current: string | null;
  from: string;
  to: string;
  hint: string;
}

/**
 * The current <leader> and the Kanban <leader> may hand over. A new session may claim for itself
 * (--to is its own id) only when every <leader> it displaces is gone.
 */
function assertHandoverAuthority(scope: HandoverScope): void {
  const { caller, kanbanLeader, current, from, to } = scope;
  if (caller === kanbanLeader || (current && caller === current)) return;
  if (caller === to) {
    for (const displaced of new Set([current, from])) {
      if (displaced && displaced !== to) assertLeaderGone(displaced, "", scope.hint);
    }
    return;
  }
  throw new KanbanError("forbidden", t("handover.error.authority"));
}

function openCardsOf(from: string, project: string | null): Array<{ id: number }> {
  const db = getDb();
  if (project) {
    return db.prepare(`SELECT id FROM tasks WHERE created_by_agent = ? AND project = ? AND ${OPEN_STATUS_SQL} ORDER BY id`).all(from, project) as Array<{ id: number }>;
  }
  return db.prepare(`SELECT id FROM tasks WHERE created_by_agent = ? AND ${OPEN_STATUS_SQL} ORDER BY id`).all(from) as Array<{ id: number }>;
}

export function handoverLeader(identity: Identity, input: HandoverInput): HandoverResult {
  return withConfigLock(() => {
    const to = input.to.trim();
    if (!to) throw new KanbanError("invalid", t("handover.error.noTo"));
    const caller = assertHandoverCaller(identity);
    assertSafeAgentId(to, "--to");
    const fromFlag = input.from?.trim() || null;
    if (fromFlag) assertSafeAgentId(fromFlag, "--from");
    if (kanbanLaunched(to)) throw new KanbanError("forbidden", t("handover.error.toWorker", { agent: to }));
    const config = loadConfig();
    if (!input.kanbanLeader && !input.project?.trim()) {
      throw new KanbanError("invalid", t("handover.error.noProject"));
    }
    const project = input.kanbanLeader ? null : resolveSupervisorProject(input.project?.trim() ?? "", config);
    const current = project ? projectSupervisor(project, config) : config.supervisorAgentId;
    const from = fromFlag || current;
    if (!from) throw new KanbanError("invalid", t("handover.error.noFrom"));
    if (from === to) throw new KanbanError("invalid", t("handover.error.sameFromTo"));
    const hint = `bin/kanban handover ${project ? `--project ${input.project?.trim()}` : "--kanban-leader"} --to ${to}`;
    assertHandoverAuthority({ caller, kanbanLeader: config.supervisorAgentId, current, from, to, hint });
    const taskIds = openCardsOf(from, project).map((row) => row.id);
    const registryUpdated = current !== to;
    const scope = project ? "project" : "kanban-leader";
    const where = project ? t("handover.where.project", { project }) : "Kanban <leader>";
    const ids = taskIds.length ? t("common.paren", { text: taskIds.join(t("common.listSep")) }) : "";
    const registry = input.dryRun
      ? t(registryUpdated ? "handover.registry.update" : "handover.registry.keep")
      : t(registryUpdated ? "handover.registry.updated" : "handover.registry.kept");
    const text = t(input.dryRun ? "handover.result.dryRun" : "handover.result.done", { where, count: taskIds.length, from, to, ids, registry });
    const result: HandoverResult = { ok: true, dryRun: input.dryRun, scope, project, from, to, taskIds, registryUpdated, text };
    if (input.dryRun) return result;
    const db = getDb();
    const update = db.prepare(`UPDATE tasks SET created_by_agent = ? WHERE id = ? AND created_by_agent = ?`);
    db.exec("BEGIN");
    try {
      for (const id of taskIds) {
        update.run(to, id, from);
        appendEvent(id, "creator_changed", from, to, "supervisor", { from, to, reason: handoverReason() });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const change = { actor: caller, via: "handover" as const };
    if (project) changeProjectLeader(project, to, change);
    else changeKanbanLeader(to, change);
    return result;
  });
}
