/// <reference types="node" />
import { loadConfig, projectSupervisor, resolveSupervisorProject, setProjectSupervisor, setSupervisorAgentId, type KanbanConfig } from "./config";
import { withConfigLock } from "./config-lock";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { GUEST_ROLE, SCHEDULE_ROLE, isKanbanLeader } from "./identity";
import { readAgentRecord } from "./open";
import type { Identity } from "./tokens";
import { t } from "../shared/i18n";

/** Who changed a registration, and through which door: supervise, handover, or the settings UI. */
export interface LeaderChange {
  actor: string;
  via: "supervise" | "handover" | "ui";
}

/**
 * Is a registered <leader> still there? Gone means its agent record is missing, archived or closed.
 * A record that cannot be read is not proof it is gone.
 */
export function leaderPresence(agentId: string): "present" | "gone" | "unknown" {
  const read = readAgentRecord(agentId);
  if (read.state === "missing") return "gone";
  if (read.state === "unreadable") return "unknown";
  if (read.file.archivedAt || read.file.lastStatus === "closed") return "gone";
  return "present";
}

/** Refuse to displace a registered <leader> whose session is still there (or cannot be checked). */
export function assertLeaderGone(previous: string, where: string, handoverHint: string): void {
  const presence = leaderPresence(previous);
  if (presence === "gone") return;
  const why = presence === "unknown"
    ? t("leaderRegistry.gone.unknown", { agent: previous })
    : t("leaderRegistry.gone.present", { agent: previous });
  throw new KanbanError("forbidden", t("leaderRegistry.gone.refuse", { where, why, hint: handoverHint }));
}

function recordSupervisorChange(project: string | null, from: string | null, to: string | null, change: LeaderChange): void {
  getDb()
    .prepare("INSERT INTO supervisor_events (at, kind, project, actor, data_json) VALUES (?, 'supervisor_changed', ?, ?, ?)")
    .run(new Date().toISOString(), project, change.actor, JSON.stringify({ from, to, via: change.via }));
}

/** Set or clear a project's <leader>, and record supervisor_changed when the value actually changes. */
export function changeProjectLeader(project: string, agentId: string | null, change: LeaderChange): KanbanConfig {
  return withConfigLock(() => {
    const before = loadConfig();
    const name = resolveSupervisorProject(project, before);
    const from = projectSupervisor(name, before);
    const config = setProjectSupervisor(name, agentId);
    const to = projectSupervisor(name, config);
    if (from !== to) recordSupervisorChange(name, from, to, change);
    return config;
  });
}

/** Set or clear the Kanban <leader>, and record supervisor_changed (project NULL) when it changes. */
export function changeKanbanLeader(agentId: string | null, change: LeaderChange): KanbanConfig {
  return withConfigLock(() => {
    const from = loadConfig().supervisorAgentId;
    const config = setSupervisorAgentId(agentId);
    if (from !== config.supervisorAgentId) recordSupervisorChange(null, from, config.supervisorAgentId, change);
    return config;
  });
}

export interface SuperviseResult {
  ok: true;
  project: string;
  agentId: string;
  supervisors: Record<string, string>;
  message?: string;
  hint: string;
  text: string;
}

/**
 * `bin/kanban supervise --project X`: register the calling session as X's <leader>.
 * A live <leader> cannot be displaced this way; only the Kanban <leader> may re-register over it.
 */
export function superviseProject(identity: Identity, project: string): SuperviseResult {
  return withConfigLock(() => {
    const agentId = identity.agentId;
    if (!agentId) throw new KanbanError("forbidden", t("leaderRegistry.error.noAgentId"));
    if (identity.role === SCHEDULE_ROLE) throw new KanbanError("forbidden", t("leaderRegistry.error.schedule"));
    if (identity.role !== "supervisor" && identity.role !== GUEST_ROLE) {
      throw new KanbanError("forbidden", t("leaderRegistry.error.notLeader"));
    }
    const config = loadConfig();
    const name = resolveSupervisorProject(project, config);
    const previous = projectSupervisor(name, config);
    if (previous && previous !== agentId && !isKanbanLeader(agentId, config)) {
      assertLeaderGone(previous, t("leaderRegistry.gone.registered", { project: name }), `bin/kanban handover --project ${project} --to ${agentId}`);
    }
    const next = changeProjectLeader(name, agentId, { actor: agentId, via: "supervise" });
    const fromArg = previous && previous !== agentId ? ` --from ${previous}` : "";
    const hint = t("leaderRegistry.supervise.hint", { project, agent: agentId, from: fromArg });
    return {
      ok: true, project: name, agentId, supervisors: next.supervisors,
      ...(name !== project ? { message: t("leaderRegistry.supervise.byCode", { code: String(next.projects?.[name]?.code), project: name }) } : {}),
      hint,
      text: t("leaderRegistry.supervise.done", { agent: agentId, project: name, hint }),
    };
  });
}
