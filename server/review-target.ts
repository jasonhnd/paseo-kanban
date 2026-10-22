/// <reference types="node" />
import { actualModel, differentReviewModels } from "../shared/fleet/review-model";
import { t } from "../shared/i18n";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { executionFamily, type ExecutionFacts } from "./execution-family";
import { findProfile, type Profile } from "./profiles";
import { assertReviewStartAvailable } from "./review-assignment";
import { requestAgentReleases } from "./task-lifecycle";
import { addComment, appendEvent, taskById, type RunRow, type TaskRow } from "./task-record";
import { revokeAgentToken } from "./tokens";
import { isCloudDeliveryRun } from "./cloud-record";

export interface ReviewAuthorization {
  profileId: string;
  profileName: string;
  provider: string;
  model: string;
  reason: string;
  authorizedBy: string;
  deliveryKey: string;
}
type Failure = "missing" | "notRun" | "binding" | "family" | "model";
export type ReviewTarget = {
  ok: true;
  taskId: number;
  card: string;
  role: string;
  source: "run" | "legacy-inline" | "leader-profile";
  runId: number | null;
  agentId: string | null;
  profile: string | null;
  provider: string | null;
  model: string | null;
  recordedFamily: string | null;
  family: string;
  authorization?: ReviewAuthorization;
} | { ok: false; taskId: number; card: string; failure: Failure; reason: string };

/** Own-role work, never the last automatic reviewer run on an executor card. */
export function deliveryRun(task: TaskRow): RunRow | null {
  return (getDb().prepare("SELECT * FROM runs WHERE task_id = ? AND role = ? ORDER BY id DESC LIMIT 1")
    .get(task.id, task.role) as RunRow | undefined) ?? null;
}

/** Queue/unblock changes do not grant a new delivery. Rework and a new submission do. */
export function deliveryKey(task: TaskRow, run: RunRow | null): string {
  const event = getDb().prepare(`SELECT id FROM events WHERE task_id = ?
    AND kind IN ('complete', 'auto_complete', 'leader_rework', 'request_changes', 'rejected')
    AND from_status IS NOT NULL AND to_status IS NOT NULL AND from_status != to_status
    ORDER BY id DESC LIMIT 1`).get(task.id) as { id: number } | undefined;
  return JSON.stringify([task.id, task.role, task.executor_agent_id ?? run?.agent_id ?? null,
    run?.id ?? null, run?.agent_id ?? null, run?.provider ?? null, run?.model ?? null, event?.id ?? null]);
}

function authorizationRecord(taskId: number): { data_json: string } | undefined {
  return getDb().prepare(`SELECT data_json FROM events WHERE task_id = ?
    AND kind = 'review_profile_authorized' ORDER BY id DESC LIMIT 1`).get(taskId) as { data_json: string } | undefined;
}

function authorizationFor(task: TaskRow, original: TaskRow, run: RunRow | null, row = authorizationRecord(task.id)): ReviewAuthorization | null {
  try {
    const saved = JSON.parse(row?.data_json ?? "null") as { reviewTaskId?: number; authorization?: ReviewAuthorization } | null;
    const a = saved?.authorization;
    if (saved?.reviewTaskId !== task.id || !a || a.deliveryKey !== deliveryKey(original, run)) return null;
    if (![a.profileId, a.profileName, a.provider, a.model, a.reason, a.authorizedBy].every(value => typeof value === "string" && value.trim())) return null;
    return actualModel(a.model) === a.model ? a : null;
  } catch { return null; }
}

function authorizedTarget(original: TaskRow, run: RunRow | null, authorization: ReviewAuthorization): ReviewTarget {
  const standalone = original.role === "reviewer" && original.review_of == null;
  return {
    ok: true, taskId: original.id, card: cardMark(original.id), role: original.role, source: "leader-profile", runId: run?.id ?? null,
    agentId: standalone ? null : run?.agent_id ?? original.executor_agent_id, profile: run?.profile_name ?? null,
    provider: run?.provider ?? null, model: null, recordedFamily: run?.family ?? null,
    family: run ? executionFamily(run) ?? "unknown" : "unknown", authorization,
  };
}

/** No target means a genuinely independent review; titles never establish an association. */
export function resolveReviewTarget(task: TaskRow, reviewing: boolean, allowRecovery = true): ReviewTarget | null {
  if (!reviewing && task.role !== "reviewer") return null;
  const linked = task.role === "reviewer" && task.review_of != null;
  if (!linked && task.role === "reviewer") {
    // Old standalone review cards have no executor association. Only explicit leader
    // authorization supplies a pinned legacy recovery route; titles remain irrelevant.
    const record = allowRecovery ? authorizationRecord(task.id) : undefined;
    if (!record) return null;
    const authorization = authorizationFor(task, task, null, record);
    if (authorization) return authorizedTarget(task, null, authorization);
    return { ok: false, taskId: task.id, card: cardMark(task.id), failure: "model",
      reason: t("reviewRecovery.expired", { card: cardMark(task.id) }) };
  }
  const id = linked ? task.review_of! : task.id;
  const card = cardMark(id);
  const original = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  const run = original ? deliveryRun(original) : null;
  const unknown = (failure: Failure): ReviewTarget => {
    const recoverable = failure === "model" || failure === "notRun";
    const authorization = allowRecovery && recoverable && original ? authorizationFor(task, original, run) : null;
    if (authorization && original) return authorizedTarget(original, run, authorization);
    const guidance = recoverable ? ` ${t("reviewRecovery.guidance", { card: cardMark(task.id) })}` : "";
    return { ok: false, taskId: id, card, failure, reason: t(`reviewTarget.${failure}`, { card }) + guidance };
  };
  if (!original) return unknown("missing");
  if (!run) return unknown("notRun");
  // A stale binding or an unrecorded takeover must not silently reuse an older delivery.
  if (original.executor_agent_id && run.agent_id !== original.executor_agent_id) return unknown("binding");
  if (!run.agent_id && !isCloudDeliveryRun(id, run.id)) return unknown("binding");
  const model = actualModel(run.model);
  if (!model) return unknown("model");
  return {
    ok: true, taskId: id, card, role: original.role, source: "run", runId: run.id,
    agentId: run.agent_id, profile: run.profile_name, provider: run.provider,
    model, recordedFamily: run.family, family: executionFamily(run) ?? "unknown",
  };
}

/** Shared hard constraint, including already selected and resumed reviewers. */
export function reviewFamilyBlock(profile: ExecutionFacts, target: ReviewTarget | null | undefined): string | null {
  if (!target) return null;
  if (!target.ok) return target.reason;
  if (target.source === "leader-profile" && target.authorization) {
    const a = target.authorization;
    return actualModel(profile.model) === a.model && profile.provider === a.provider ? null
      : t("reviewRecovery.profileChanged", { profile: a.profileName });
  }
  if (!actualModel(profile.model) || !actualModel(target.model)) return t("reviewTarget.model", { card: target.card });
  if (!differentReviewModels(target.model, profile.model)) return t("reviewTarget.sameModel", { card: target.card, model: actualModel(target.model)! });
  return null;
}

/** The CLI has authenticated leader scope. Scheduler selections and chosen profiles cannot call this implicitly. */
export function authorizeReviewRecovery(id: number, selector: string, reason: string, profiles: Profile[], actor: string, leaderAgentId?: string | null): TaskRow {
  if (actor !== "supervisor") throw new KanbanError("forbidden", t("reviewRecovery.leaderOnly"));
  if (!selector.trim() || !reason.trim()) throw new KanbanError("invalid", t("reviewRecovery.arguments"));
  const profile = findProfile(profiles, selector);
  const model = actualModel(profile?.model);
  if (!profile || !model || !(profile.role === "reviewer" || (profile.role === "candidate" && profile.candidateFor === "reviewer"))) {
    throw new KanbanError("invalid", t("reviewRecovery.profileRequired"));
  }
  const db = getDb();
  let oldReviewer: string | null = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = taskById(id);
    const reviewCard = task.role === "reviewer";
    const standalone = reviewCard && task.review_of == null;
    const phase = task.status === "blocked" ? task.blocked_from : task.status;
    if ((task.status === "blocked" && task.blocked_kind !== "needs_human") ||
        !(reviewCard ? ["ready", "draft", "reviewing", "in_review", "rework"].includes(phase ?? "") : phase === "in_review" || phase === "reviewing") ||
        task.status === "reviewing" || task.status === "running") {
      throw new KanbanError("invalid", t("reviewRecovery.queueOnly"));
    }
    assertReviewStartAvailable(task, true);
    const target = resolveReviewTarget(task, true, false);
    if (!standalone && (!target || target.ok || (target.failure !== "model" && target.failure !== "notRun"))) {
      throw new KanbanError("invalid", target && !target.ok ? target.reason : t("reviewRecovery.unknownOnly"));
    }
    const original = standalone ? task : taskById(target!.taskId);
    const originalPhase = original.status === "blocked" ? original.blocked_from : original.status;
    if (!standalone && !["in_review", "reviewing", "acceptance", "done", "archived"].includes(originalPhase ?? "")) {
      throw new KanbanError("invalid", t("reviewRecovery.deliveredOnly"));
    }
    const authorization: ReviewAuthorization = {
      profileId: profile.id, profileName: profile.name, provider: profile.provider, model,
      reason: reason.trim(), authorizedBy: leaderAgentId || actor, deliveryKey: deliveryKey(original, standalone ? null : deliveryRun(original)),
    };
    const previous = db.prepare("SELECT agent_id FROM runs WHERE task_id = ? AND role = 'reviewer' AND agent_id = ? ORDER BY id DESC LIMIT 1")
      .get(id, task.agent_id) as { agent_id: string | null } | undefined;
    oldReviewer = previous?.agent_id ?? null;
    const queued = reviewCard && phase !== "in_review" ? "ready" : "in_review";
    const at = new Date().toISOString();
    db.prepare(`UPDATE tasks SET status = ?, agent_id = ?, hold_reason = NULL, blocked_kind = NULL,
      blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, cooldown_until = NULL, nudge_count = 0, updated_at = ? WHERE id = ?`)
      .run(queued, reviewCard ? null : task.executor_agent_id, at, id);
    db.prepare("UPDATE runs SET ended_at = ?, end_kind = 'review_profile_replaced' WHERE task_id = ? AND role = 'reviewer' AND ended_at IS NULL").run(at, id);
    appendEvent(id, "review_profile_authorized", task.status, queued, authorization.authorizedBy, { reviewTaskId: id, authorization, previousReviewerAgentId: oldReviewer });
    const note = t("reviewRecovery.recorded", { card: cardMark(id), profile: profile.name, model, reason: authorization.reason, leader: authorization.authorizedBy });
    addComment(id, authorization.authorizedBy, note);
    if (original.id !== id) addComment(original.id, authorization.authorizedBy, note);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (oldReviewer) {
    revokeAgentToken(oldReviewer);
    requestAgentReleases(id, [{ agentId: oldReviewer, role: "reviewer" }]);
  }
  return taskById(id);
}
