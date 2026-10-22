/// <reference types="node" />
import { t } from "../shared/i18n";
import { cardMarkOf } from "./card-ref";
import { loadConfig } from "./config";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import type { TaskRow } from "./task-record";

export interface ReviewAssignment {
  taskId: number;
  targetId: number;
  code: string;
  automatic: boolean;
  state: "scheduled" | "running" | "blocked";
  profile: string | null;
  reservedEvent: number;
}

/** Inline automatic reviews and linked cards reserve the same delivery. No title inference. */
export function loadReviewAssignments(targetId?: number): Map<number, ReviewAssignment[]> {
  const rows = getDb().prepare(`SELECT t.id, t.project, t.code_seq, t.review_of, t.role, t.status,
    t.blocked_from, t.profile_override, r.profile_name,
    COALESCE((SELECT MIN(e.id) FROM events e WHERE e.task_id = t.id AND e.kind = 'created'), 0) AS created_event,
    COALESCE((SELECT MAX(e.id) FROM events e WHERE e.task_id = t.id AND e.kind IN ('complete', 'auto_complete') AND e.to_status = 'in_review'), 0) AS complete_event
    FROM tasks t LEFT JOIN runs r ON r.id = (SELECT id FROM runs
      WHERE task_id = t.id AND role = 'reviewer' AND agent_id = t.agent_id ORDER BY id DESC LIMIT 1)
    WHERE ((t.role = 'reviewer' AND t.review_of IS NOT NULL AND t.status NOT IN ('acceptance', 'done', 'archived'))
      OR (t.role != 'reviewer' AND (t.status IN ('in_review', 'reviewing')
        OR (t.status = 'blocked' AND t.blocked_from IN ('in_review', 'reviewing')))))
      ${targetId == null ? "" : "AND (t.id = ? OR t.review_of = ?)"}
    ORDER BY t.id`).all(...(targetId == null ? [] : [targetId, targetId])) as unknown as Array<{
      id: number; project: string; code_seq: number | null; review_of: number | null; role: string;
      status: string; blocked_from: string | null; profile_override: string | null; profile_name: string | null;
      created_event: number; complete_event: number;
    }>;
  const config = rows.length ? loadConfig() : undefined;
  const result = new Map<number, ReviewAssignment[]>();
  for (const row of rows) {
    const automatic = row.role !== "reviewer";
    const target = automatic ? row.id : row.review_of!;
    const state = row.status === "blocked" ? "blocked"
      : row.status === "running" || row.status === "reviewing" ? "running" : "scheduled";
    const assignment: ReviewAssignment = {
      taskId: row.id, targetId: target, code: cardMarkOf(row, config), automatic, state,
      profile: state === "running" || row.blocked_from === "reviewing" ? row.profile_name
        : automatic ? null : row.profile_override,
      reservedEvent: automatic ? row.complete_event : row.created_event,
    };
    const list = result.get(target) ?? [];
    list.push(assignment);
    result.set(target, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.reservedEvent - b.reservedEvent || a.taskId - b.taskId);
  return result;
}

export function reviewAssignmentText(assignment: ReviewAssignment): string {
  return t(`reviewAssignment.${assignment.state}`, {
    card: assignment.code,
    detail: [assignment.automatic ? t("reviewAssignment.automatic") : "", assignment.profile].filter(Boolean).join("; "),
  });
}

export function reviewStatusText(assignments: ReviewAssignment[] | undefined): string | null {
  return assignments?.length ? assignments.map(reviewAssignmentText).join("; ") : null;
}

function duplicate(assignment: ReviewAssignment): never {
  throw new KanbanError("conflict", t("reviewAssignment.duplicate", { existing: reviewAssignmentText(assignment) }), {
    reviewTaskId: assignment.taskId, targetId: assignment.targetId,
  });
}

/** Creation and automatic submission hold a write transaction while reserving a target. */
export function assertReviewAvailable(targetId: number): void {
  const existing = loadReviewAssignments(targetId).get(targetId)?.[0];
  if (existing) duplicate(existing);
}

/** Old duplicate rows may still exist. The first reservation owns the start, including across awaits. */
export function assertReviewStartAvailable(task: TaskRow, reviewing: boolean): void {
  if (!reviewing || (task.role === "reviewer" && task.review_of == null)) return;
  const targetId = task.role === "reviewer" ? task.review_of! : task.id;
  const owner = loadReviewAssignments(targetId).get(targetId)?.[0];
  if (owner && owner.taskId !== task.id) duplicate(owner);
}
