import { escapeClass, escapeRegExp } from "../../shared/fleet/decision-parse";
import { LANGUAGES, type MessageKey, t, tIn } from "../../shared/fleet/i18n";

/** Idle agents older than this are eligible for the sweep. Strictly greater than 24 hours. */
export const IDLE_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Worker roles whose agents the sweep may archive (title prefix such as the Chinese bracketed role name). */
const ARCHIVE_ROLE_KEYS: readonly MessageKey[] = [
  "upgrade.workerRole.executor",
  "upgrade.workerRole.reviewer",
  "upgrade.workerRole.reader",
  "upgrade.workerRole.decision",
  "upgrade.workerRole.batch",
];

/**
 * Role-prefixed titles the sweep may archive, in every language (Kanban titles may be written in either).
 * Supervisors, ops, research, patrol, and untitled chats stay.
 */
export function archiveTitleRe(): RegExp {
  const forms = LANGUAGES.map((lang) => {
    const open = escapeRegExp(tIn(lang, "sweep.title.open"));
    const close = tIn(lang, "sweep.title.close");
    const roles = ARCHIVE_ROLE_KEYS.map((key) => escapeRegExp(tIn(lang, key))).join("|");
    return `${open}(?:${roles})[^${escapeClass(close)}]*${escapeRegExp(close)}`;
  });
  return new RegExp(`^(?:${[...new Set(forms)].join("|")})`);
}

export function kanbanUnreadable(): string {
  return t("sweep.kanbanUnreadable");
}

export interface SweepAgent {
  id: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt: string | null;
  /** More accurate last-turn time when the record has one; otherwise the sweep uses updatedAt. */
  lastActivityAt: string | null;
  archivedAt: string | null;
  requiresAttention: boolean;
  attentionReason: string | null;
  pendingPermission: boolean;
  lastError: string | null;
}

export interface ArchiveCandidate {
  id: string;
  title: string;
  cwd: string;
  idleHours: number;
  reason: string;
}

export interface SweepSelection {
  archive: ArchiveCandidate[];
  aborted: string | null;
}

export interface SweepStateRaw {
  enabled?: unknown;
  failures?: unknown;
}

/** Missing state means the switch is on. Only an explicit false turns it off. */
export function normalizeSweepState(raw: SweepStateRaw): { enabled: boolean; failures: Record<string, number> } {
  const failures: Record<string, number> = {};
  if (raw.failures && typeof raw.failures === "object") {
    for (const [id, value] of Object.entries(raw.failures as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) failures[id] = Math.floor(value);
    }
  }
  return { enabled: raw.enabled !== false, failures };
}

/** `paseo archive <id>`. Never `--force`: a running agent must not be interrupted. */
export function archiveCommandArgs(id: string): string[] {
  return ["archive", id];
}

function activityMs(agent: SweepAgent): number | null {
  for (const raw of [agent.lastActivityAt, agent.updatedAt]) {
    if (!raw) continue;
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return at;
  }
  return null;
}

function isError(agent: SweepAgent): boolean {
  return agent.status === "error" || agent.attentionReason === "error" || Boolean(agent.lastError);
}

/**
 * Waiting on a person to approve a tool call.
 * `requiresAttention` with `attentionReason === "finished"` is the unread-done flag Paseo
 * leaves on a closed session. It is not an approval wait; those leftover sessions are
 * what this sweep collects.
 */
function isAwaitingApproval(agent: SweepAgent): boolean {
  if (agent.pendingPermission) return true;
  if (agent.attentionReason === "permission") return true;
  if (agent.requiresAttention && agent.attentionReason !== "finished") return true;
  return false;
}

/**
 * Agents to archive.
 * `unfinishedAgentIds === null` means kanban.db could not be read: archive nobody.
 */
export function selectIdleAgents(
  agents: readonly SweepAgent[],
  unfinishedAgentIds: ReadonlySet<string> | null,
  now: number,
): SweepSelection {
  if (unfinishedAgentIds === null) return { archive: [], aborted: kanbanUnreadable() };
  const archive: ArchiveCandidate[] = [];
  const titleRe = archiveTitleRe();
  for (const agent of agents) {
    if (agent.archivedAt) continue;
    if (!titleRe.test(agent.title)) continue;
    if (agent.status !== "idle" && agent.status !== "closed") continue;
    if (isAwaitingApproval(agent)) continue;
    if (isError(agent)) continue;
    if (unfinishedAgentIds.has(agent.id)) continue;
    const active = activityMs(agent);
    if (active === null) continue;
    const idleMs = now - active;
    if (!(idleMs > IDLE_ARCHIVE_AFTER_MS)) continue;
    const idleHours = Math.round((idleMs / 3_600_000) * 10) / 10;
    archive.push({
      id: agent.id,
      title: agent.title,
      cwd: agent.cwd,
      idleHours,
      reason: t("sweep.idleReason", { hours: idleHours, status: agent.status }),
    });
  }
  archive.sort((a, b) => b.idleHours - a.idleHours || a.id.localeCompare(b.id));
  return { archive, aborted: null };
}
