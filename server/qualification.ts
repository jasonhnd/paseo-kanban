/// <reference types="node" />
import { operationalExecution, qualifiedCandidates, type QualifiedCandidate } from "../shared/fleet/executor-effort";
import { parseTags } from "./profile-rules";
import { loadConfig, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { effortForOwnRole } from "./effort";
import type { TaskRow } from "./task-record";
import { resolveTier, type Tier } from "./tier";

/** Review/acceptance rejection and leader rework count, even without countRound. */
export function qualificationReworkCount(taskId: number): number {
  const rows = getDb().prepare(`SELECT kind, from_status, to_status FROM events WHERE task_id = ? AND
    kind IN ('request_changes', 'rejected', 'leader_rework', 'started', 'resumed') ORDER BY id`).all(taskId) as
    Array<{ kind: string; from_status: string | null; to_status: string | null }>;
  let count = 0, pendingReturn = false;
  for (const row of rows) {
    if (row.kind === "started" || row.kind === "resumed") { pendingReturn = false; continue; }
    if (["request_changes", "rejected"].includes(row.kind) && row.to_status === "rework") { count++; pendingReturn = true; }
    else if (row.kind === "leader_rework") {
      // Continuing a stopped review is bookkeeping for the same return, not a second rejection.
      if (!(pendingReturn && row.from_status === "rework")) count++;
      pendingReturn = false;
    }
  }
  return count;
}

/**
 * G2 fresh-agent adapter. Call only when selecting a NEW agent, including replacement
 * after rework; a resumed agent keeps its original session's depth. G2c intersects this
 * result with the live matrix/catalog before ranking pools and opening the agent.
 * The automatic review of a delivery does not inherit executor effort, max tag or rework count.
 */
export function qualificationForNewAgent(task: TaskRow, review = false, config: KanbanConfig = loadConfig(), matrixDefaultTier: Tier | null = null): QualifiedCandidate[] {
  const role = review ? "reviewer" : task.role;
  const tags = parseTags(task.tags);
  const context = { role, review, tags, title: task.title, brief: task.brief };
  const cardType = operationalExecution(context) ? "ops" : role;
  const explicitEffort = effortForOwnRole(task, review) ?? (!review && tags.includes("needs-max") ? "max" : null);
  return qualifiedCandidates({ role, tier: resolveTier(task.tier, tags, matrixDefaultTier), cardType,
    reworkCount: review ? 0 : qualificationReworkCount(task.id), explicitEffort },
  { global: config.qualification, project: config.projects?.[task.project]?.qualification });
}
