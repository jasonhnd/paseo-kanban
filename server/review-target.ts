/// <reference types="node" />
import { actualModel, differentReviewModels } from "../shared/fleet/review-model";
import { t } from "../shared/i18n";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { executionFamily, type ExecutionFacts } from "./execution-family";
import type { RunRow, TaskRow } from "./task-record";

export type ReviewTarget = {
  ok: true;
  taskId: number;
  card: string;
  role: string;
  source: "run" | "legacy-inline";
  runId: number | null;
  agentId: string | null;
  profile: string | null;
  provider: string | null;
  model: string | null;
  recordedFamily: string | null;
  family: string;
} | { ok: false; taskId: number; card: string; reason: string };

/** Own-role work, never the last automatic reviewer run on an executor card. */
export function deliveryRun(task: TaskRow): RunRow | null {
  return (getDb().prepare("SELECT * FROM runs WHERE task_id = ? AND role = ? ORDER BY id DESC LIMIT 1")
    .get(task.id, task.role) as RunRow | undefined) ?? null;
}

/** No target means a genuinely independent review; titles never establish an association. */
export function resolveReviewTarget(task: TaskRow, reviewing: boolean): ReviewTarget | null {
  if (!reviewing && task.role !== "reviewer") return null;
  const linked = task.role === "reviewer" && task.review_of != null;
  if (!linked && task.role === "reviewer") return null;
  const id = linked ? task.review_of! : task.id;
  const card = cardMark(id);
  const unknown = (key: "reviewTarget.missing" | "reviewTarget.notRun" | "reviewTarget.binding" | "reviewTarget.family" | "reviewTarget.model"): ReviewTarget =>
    ({ ok: false, taskId: id, card, reason: t(key, { card }) });
  const original = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!original) return unknown("reviewTarget.missing");
  const run = deliveryRun(original);
  if (!run) {
    return unknown("reviewTarget.notRun");
  }
  // A stale binding or an unrecorded takeover must not silently reuse an older delivery.
  if (original.executor_agent_id && run.agent_id !== original.executor_agent_id) return unknown("reviewTarget.binding");
  const model = actualModel(run.model);
  if (!model) return unknown("reviewTarget.model");
  const family = executionFamily(run) ?? "unknown";
  if (!run.agent_id) return unknown("reviewTarget.binding");
  return {
    ok: true, taskId: id, card, role: original.role, source: "run", runId: run.id,
    agentId: run.agent_id, profile: run.profile_name, provider: run.provider,
    model, recordedFamily: run.family, family,
  };
}

/** Shared hard constraint, including already selected and resumed reviewers. */
export function reviewFamilyBlock(profile: ExecutionFacts, target: ReviewTarget | null | undefined): string | null {
  if (!target) return null;
  if (!target.ok) return target.reason;
  if (!actualModel(profile.model) || !actualModel(target.model)) return t("reviewTarget.model", { card: target.card });
  if (!differentReviewModels(target.model, profile.model)) return t("reviewTarget.sameModel", { card: target.card, model: actualModel(target.model)! });
  return null;
}
