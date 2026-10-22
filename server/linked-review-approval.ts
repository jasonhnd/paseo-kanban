import { actualModel, differentReviewModels } from "../shared/fleet/review-model";
import { t } from "../shared/i18n";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { safeParse } from "./guard";
import { deliveryKey, deliveryRun, resolveReviewTarget } from "./review-target";
import type { TaskRow } from "./task-record";

/** Board-owned approval evidence, persisted in pr_wait when checks defer the verdict. */
export interface LinkedApprovalRequest {
  reviewTaskId: number;
  targetId: number;
  reviewerAgentId: string | null;
  reviewerRunId: number | null;
  targetDeliveryKey: string | null;
}

function targetOf(review: TaskRow): TaskRow | undefined {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(review.review_of!) as TaskRow | undefined;
}

export function linkedApprovalRequest(review: TaskRow, agentId = review.agent_id): LinkedApprovalRequest | null {
  if (review.role !== "reviewer" || review.review_of == null) return null;
  const target = targetOf(review);
  return { reviewTaskId: review.id, targetId: review.review_of, reviewerAgentId: agentId,
    reviewerRunId: deliveryRun(review)?.id ?? null, targetDeliveryKey: target ? deliveryKey(target, deliveryRun(target)) : null };
}

export function pendingLinkedApproval(review: TaskRow): LinkedApprovalRequest | null {
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'pr_wait' ORDER BY id DESC LIMIT 1")
    .get(review.id) as { data_json: string } | undefined;
  const request = safeParse<{ linkedApproval?: LinkedApprovalRequest }>(row?.data_json)?.linkedApproval;
  if (!request || request.reviewTaskId !== review.id || !Number.isInteger(request.targetId) ||
    !(request.reviewerAgentId === null || typeof request.reviewerAgentId === "string") ||
    !(request.reviewerRunId === null || Number.isInteger(request.reviewerRunId)) ||
    !(request.targetDeliveryKey === null || typeof request.targetDeliveryKey === "string")) return null;
  return request;
}

export function linkedApprovalCurrent(review: TaskRow, request: LinkedApprovalRequest): boolean {
  return review.role === "reviewer" && request.reviewTaskId === review.id && request.targetId === review.review_of &&
    request.reviewerAgentId === review.agent_id && request.reviewerRunId === (deliveryRun(review)?.id ?? null);
}

type Approval = { target: TaskRow | undefined; reason: string } | {
  target: TaskRow;
  evidence: { reviewTaskId: number; reviewCard: string; reviewerAgentId: string; reviewerRunId: number;
    reviewerModel: string; executorRunId: number; executorModel: string };
};

/** Re-read actual runs and competing reservations under the verdict's SQLite write lock. */
export function linkedApproval(review: TaskRow, request: LinkedApprovalRequest | null): Approval {
  const target = targetOf(review);
  const held = (reason: string): Approval => ({ target, reason });
  if (!target) return held(t("flow.linkedApproval.missingTarget"));
  if (target.status !== "in_review") return held(t("flow.linkedApproval.targetState", { status: target.status }));
  if (!request?.reviewerAgentId || !linkedApprovalCurrent(review, request)) return held(t("flow.linkedApproval.binding"));
  const run = deliveryRun(review);
  if (!run || run.agent_id !== request.reviewerAgentId) return held(t("flow.linkedApproval.binding"));
  const model = actualModel(run.model);
  if (!model) return held(t("flow.linkedApproval.missingReviewerModel"));
  // Explicit legacy profile authorization may start a review, but cannot invent executor model evidence.
  const execution = resolveReviewTarget(review, true, false);
  if (!execution?.ok) return held(t(execution?.failure === "binding" ? "flow.linkedApproval.executorBinding" : "flow.linkedApproval.missingExecutorModel"));
  if (request.targetDeliveryKey !== deliveryKey(target, deliveryRun(target))) return held(t("flow.linkedApproval.changedDelivery"));
  if (!differentReviewModels(execution.model, model)) return held(t("flow.linkedApproval.sameModel", { model }));
  const other = getDb().prepare(`SELECT t.id FROM tasks t WHERE t.role = 'reviewer' AND t.review_of = ? AND t.id != ?
    AND (t.status NOT IN ('acceptance', 'done', 'archived') OR EXISTS
      (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.kind IN ('approve', 'leader_pass')))
    ORDER BY t.id LIMIT 1`).get(target.id, review.id) as { id: number } | undefined;
  // A queued in_review reservation is not another running review. Live inline runs and prior verdicts are.
  const inline = getDb().prepare(`SELECT 1 FROM runs WHERE task_id = ? AND role = 'reviewer' AND ended_at IS NULL
    UNION ALL SELECT 1 FROM events WHERE task_id = ? AND kind IN ('approve', 'leader_pass') LIMIT 1`).get(target.id, target.id);
  if (other || inline) return held(t("flow.linkedApproval.otherReview", { review: cardMark(other?.id ?? target.id) }));
  return { target, evidence: { reviewTaskId: review.id, reviewCard: cardMark(review.id), reviewerAgentId: request.reviewerAgentId,
    reviewerRunId: run.id, reviewerModel: model, executorRunId: execution.runId!, executorModel: execution.model! } };
}
