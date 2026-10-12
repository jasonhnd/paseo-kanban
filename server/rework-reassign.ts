/// <reference types="node" />
import { t } from "../shared/i18n";
import { DEFAULT_REWORK_REASSIGN_HOURS, type KanbanConfig } from "./config";
import { agentReleaseRequested } from "./archive-book";
import { getDb } from "./db";
import { latestChangeNote } from "./flow";
import { awaitingLeaderHold } from "./review-hold";
import type { AgentLiveness } from "./open";
import { quotaWaitLabel } from "../shared/blocked";
import { onlyRolesBlock, type PoolSnapshot } from "./pools";
import type { Profile } from "./profiles";
import { familyDispatchBlock, poolUnseenReason, profilePoolRole } from "./routing";
import { appendEvent, type TaskRow } from "./store";

export function reworkTakeoverNote(): string {
  return t("reworkReassign.takeoverNote");
}

export interface ReworkReassignment {
  oldAgentId: string | null;
  oldProfile: string | null;
  oldPool: string | null;
  oldAgentState: AgentLiveness;
  /** The task columns can already be null when rejection found the old agent gone. */
  expectedExecutorAgentId: string | null;
  reason: string;
  waitSince: string;
  evaluatedAt: string;
}

type EventRow = { id: number; at: string; kind: string; data_json: string };

function dataOf(row: EventRow | undefined): Record<string, unknown> {
  try {
    const data: unknown = row ? JSON.parse(row.data_json) : {};
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Read the verdict event, since progress comments may have been added after the rejection. */
export function latestReworkFeedback(taskId: number): string {
  const row = getDb().prepare(
    "SELECT id, at, kind, data_json FROM events WHERE task_id = ? AND kind IN ('request_changes', 'rejected', 'land_conflict', 'pr_failed', 'leader_rework') ORDER BY id DESC LIMIT 1",
  ).get(taskId) as EventRow | undefined;
  const data = dataOf(row);
  const parts = [data.reason ?? data.summary, data.findings, data.detail, data.checks].filter((part) => typeof part === "string" && part.trim());
  return parts.join("\n") || latestChangeNote(taskId);
}

/** Keep a durable wait clock per executor and rejection; unrelated updated_at changes do not reset it. */
export function planReworkReassignment(
  task: TaskRow,
  profiles: Profile[],
  pools: PoolSnapshot,
  config: KanbanConfig,
  now: number,
  agentState: (id: string) => AgentLiveness,
): { state: "waiting"; kind: "quota" | "transient" | "capability"; reason: string } | { state: "reassign"; assignment: ReworkReassignment } | null {
  if (task.status !== "rework" || task.role === "reviewer" || awaitingLeaderHold(task.id)) return null;
  const prior = getDb().prepare(
    "SELECT agent_id, profile_name FROM runs WHERE task_id = ? AND role = ? ORDER BY id DESC LIMIT 1",
  ).get(task.id, task.role) as { agent_id: string | null; profile_name: string | null } | undefined;
  const oldAgentId = task.executor_agent_id ?? prior?.agent_id ?? null;
  const oldProfile = task.executor_profile ?? prior?.profile_name ?? null;
  if (!oldAgentId && !oldProfile) return null;
  const profile = profiles.find((item) => item.name === oldProfile) ?? null;
  const starts = getDb().prepare(
    "SELECT id, at, kind, data_json FROM events WHERE task_id = ? AND kind = 'started' ORDER BY id DESC",
  ).all(task.id) as EventRow[];
  const opened = starts.find((row) => dataOf(row).agentId === oldAgentId);
  const quota = dataOf(opened).quota as { pool?: unknown } | undefined;
  const oldPool = profile?.pool ?? (typeof quota?.pool === "string" ? quota.pool : null);
  const state = oldAgentId ? agentState(oldAgentId) : "missing";
  const retired = Boolean(oldAgentId && agentReleaseRequested(task.id, oldAgentId));
  let reason: string | null = null;
  let kind: "quota" | "transient" | "capability" = "quota";
  if (!task.executor_agent_id || state === "missing" || state === "archived" || retired) {
    kind = "transient";
    reason = retired ? t("reworkReassign.agentRetired") : t("reworkReassign.agentGone");
  } else if (!profile) {
    kind = "capability";
    reason = t("reworkReassign.profileGone", { profile: oldProfile ?? t("reworkReassign.notRecorded") });
  } else {
    const entry = pools.entry(oldPool);
    const limited = onlyRolesBlock(entry, oldPool, profilePoolRole(profile, false));
    if (oldPool && !entry.dispatchable) {
      reason = quotaWaitLabel(oldPool, t("reworkReassign.waitingAutoStart", { reason: entry.reason || t("reworkReassign.poolClosed", { pool: oldPool }) }));
    } else if (limited) reason = quotaWaitLabel(oldPool, t("reworkReassign.waitingAutoStart", { reason: limited }));
    else if (familyDispatchBlock(profile, null, pools) === poolUnseenReason()) reason = quotaWaitLabel(oldPool, poolUnseenReason());
  }
  const cycle = getDb().prepare(
    "SELECT id FROM events WHERE task_id = ? AND to_status = 'rework' AND (from_status != 'rework' OR kind IN ('request_changes', 'rejected', 'land_conflict', 'pr_failed', 'leader_rework')) ORDER BY id DESC LIMIT 1",
  ).get(task.id) as { id: number } | undefined;
  const cycleId = cycle?.id ?? 0;
  const lastWait = getDb().prepare(
    "SELECT id, at, kind, data_json FROM events WHERE task_id = ? AND kind IN ('rework_wait_started', 'rework_wait_cleared') ORDER BY id DESC LIMIT 1",
  ).get(task.id) as EventRow | undefined;
  const data = dataOf(lastWait);
  const continuing = lastWait?.kind === "rework_wait_started" && data.cycleId === cycleId && data.oldAgentId === oldAgentId && data.oldProfile === oldProfile;
  if (!reason) {
    if (continuing) appendEvent(task.id, "rework_wait_cleared", "rework", "rework", "scheduler", {}, new Date(now).toISOString());
    return null;
  }
  const savedSince = continuing ? String(data.waitSince ?? lastWait!.at) : "";
  let waitSince = Number.isFinite(Date.parse(savedSince)) ? savedSince : new Date(now).toISOString();
  if (!continuing) {
    // Existing quota holds can predate this feature. Reuse their timestamp only for this rejection and this hold.
    const held = getDb().prepare(
      "SELECT id, at, kind, data_json FROM events WHERE task_id = ? AND id > ? AND kind = 'held' AND from_status = 'rework' ORDER BY id DESC LIMIT 1",
    ).get(task.id, cycleId) as EventRow | undefined;
    const hold = dataOf(held);
    if (held && hold.kind === "quota" && hold.reason === task.hold_reason && task.hold_reason === reason && Date.parse(held.at) <= now) waitSince = held.at;
    appendEvent(task.id, "rework_wait_started", "rework", "rework", "scheduler", { cycleId, oldAgentId, oldProfile, oldPool, reason, waitSince }, new Date(now).toISOString());
  }
  const hours = config.reworkReassignHours ?? DEFAULT_REWORK_REASSIGN_HOURS;
  if (now - Date.parse(waitSince) <= hours * 3_600_000) return { state: "waiting", kind, reason };
  return { state: "reassign", assignment: {
    oldAgentId, oldProfile, oldPool, oldAgentState: state, expectedExecutorAgentId: task.executor_agent_id,
    reason, waitSince, evaluatedAt: new Date(now).toISOString(),
  } };
}
