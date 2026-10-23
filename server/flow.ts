import { isQaReview, notifyQaSignoff } from "./qa-review";
/// <reference types="node" />
import { assertRunBudgetSettled, resetRunBudget } from "./run-budget-control";
import { guardCard, safeParse } from "./guard";
import { getDb } from "./db";
import { assertReviewAvailable } from "./review-assignment";
import { linkedApproval, linkedApprovalCurrent, linkedApprovalRequest, pendingLinkedApproval, type LinkedApprovalRequest } from "./linked-review-approval";
import { parentBlockReason, parentsBlockReason, taskParents } from "./parents";
import { cardMark } from "./card-ref";
import { KanbanError } from "./errors";
import { DEFAULT_LAND_CONFLICT_LIMIT, DEFAULT_NUDGE_GRACE_MS, DEFAULT_NUDGE_INTERVAL_MS, DEFAULT_PROGRESS_GRACE_MS, loadConfig, projectSupervisor } from "./config";
import { inOpeningGrace, judgeNudge, lastAssistantText, progressCoversTurn, timelineShowsWork, truncateHandoff, withinNudgeInterval } from "./nudge";
import { promoteParents } from "./promote";
import { evaluateContract, readContract, rememberPullRequest, writeContract, type PrVerdict, type PrBindingDiagnostics } from "./pr";
import { agentCwdMissing } from "./missing-cwd";
import { readAgentRecord } from "./open";
import { assertTransition, canTransition } from "./state";
import { agentReleaseRequested } from "./archive-book";
import { addComment, appendEvent, blockTask, claimStatus, getTask, notifyFinished, requestAgentReleases, setHold, recordMergeCardDependencies, withMergeCardWarnings, type TaskRow } from "./store";
import { revokeAgentToken, revokeTaskWorkerTokens } from "./tokens";
import { leaderHoldReason, reviewHoldNotice } from "./review-hold";
import { deliverStoredReviewHold, notifyAcceptance, notifyTask, wakeKanbanSupervisor } from "./wake";
import { reviewRejectCaption, roleLabel, statusLabel, supervisorRejectCaption, type Status } from "../shared/labels";
import { pendingLand, recordLandPending } from "./land-pending";
import { judgedWorktree, noteObservedBranch } from "./branch-observed";
import { resolveArtifactEvidence, type ArtifactAcceptance, type ArtifactBranch } from "./artifact-accept";
import { landLocalBranch, landPlan, type LandResult } from "./temp-land";
import { createdWorktree, ownedWorktree, worktreeOwnershipError } from "./worktree-gc";
import { commitWipSync } from "./temp-workspace";
import { runGitSync } from "./git";
import { presenceIsGone, type AgentPresence } from "./presence";
import { archiveInFlight } from "./cleanup";
import { hookObjects } from "./hook-objects";
import { storedWaitingOn, waitingOn } from "./external-wait";
import { isProjectDormant } from "./paused";
import { completionHandoffWarnings } from "./write-source";
import { isGoogleProfile } from "./profiles";
import { t } from "../shared/i18n";
import { LOCAL_GIT_OPTIONS, disabledGitFilters } from "./cloud-git-policy";
import { localCloudReceipt } from "./cloud-record";
import { recordCardWorkBytes } from "./capacity-guard";

const COMPLETERS = new Set(["executor", "reader", "decision", "batch"]);

/**
 * Completing this role enters in_review.
 * Reader, decision, and batch go straight to acceptance and never open a reviewer.
 */
export function submitsToReview(role: string): boolean {
  return role === "executor";
}

/** Google batch work can change files, so it follows execution's review lifecycle. */
function taskSubmitsToReview(task: TaskRow): boolean {
  if (submitsToReview(task.role)) return true;
  if (task.role !== "batch") return false;
  if (task.executor_family === "google") return true;
  const worker = getDb().prepare("SELECT provider, model FROM runs WHERE task_id = ? AND role = 'batch' ORDER BY id DESC LIMIT 1").get(task.id) as { provider: string; model?: string } | undefined;
  return Boolean(worker && isGoogleProfile(worker));
}

function move(id: number, from: Status, to: Status, actor: string, kind: string, extra: string, params: Array<string | number | null>, data: Record<string, unknown>): TaskRow {
  assertTransition(from, to);
  const ts = new Date().toISOString();
  const info = getDb()
    .prepare(`UPDATE tasks SET status = ?, updated_at = ?, nudge_count = 0${extra} WHERE id = ? AND status = ?`)
    .run(to, ts, ...params, id, from);
  if (info.changes !== 1) throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(id) }), { id, from, to });
  appendEvent(id, kind, from, to, actor, data);
  if ((kind === "complete" || kind === "accept") && (to === "in_review" || to === "acceptance" || to === "done")) {
    recordCardWorkBytes(id);
  }
  return getTask(id);
}

export function resetNudges(id: number): void {
  getDb().prepare("UPDATE tasks SET nudge_count = 0 WHERE id = ?").run(id);
}

function saveContract(id: number, raw: string): void {
  getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(raw, id);
}

/** Synchronous submission and linked creation must reserve under the same write lock. */
function reserveAutomaticReview<T>(id: number, submit: () => T): T {
  const db = getDb();
  const reserve = () => { assertReviewAvailable(id); return submit(); };
  if (db.isTransaction) return reserve();
  db.exec("BEGIN IMMEDIATE");
  try {
    const next = reserve();
    db.exec("COMMIT");
    return next;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Advisory only: a dirty or unreadable checkout must not prevent handoff. */
function completionWorkspaceWarning(task: TaskRow): string | null {
  if (!task.workspace_path) return null;
  const keys = localCloudReceipt(task.id) ? runGitSync(task.workspace_path, [...LOCAL_GIT_OPTIONS, "config", "--null", "--name-only", "--list"]) : null;
  if (keys && keys.code !== 0) return null;
  const result = runGitSync(task.workspace_path, [...(keys ? [...LOCAL_GIT_OPTIONS, ...disabledGitFilters(keys.stdout)] : []), "status", "--short", "--untracked-files=all"]);
  if (result.code !== 0) return null;
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) return null;
  const remainder = entries.length > 5 ? `\n${t("flow.workspace.more", { count: entries.length - 5 })}` : "";
  return t("flow.workspace.warning", { entries: entries.slice(0, 5).join("\n"), remainder });
}

export interface CompleteOnBehalf {
  onBehalf?: boolean;
  actorAgentId?: string | null;
}

interface StoredOnBehalf {
  onBehalf: true;
  actorAgentId: string;
  note: string;
  blockedEventId?: number | null;
  generation?: string;
}

function latestBlockEvent(id: number): number | null {
  const row = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'blocked' ORDER BY id DESC LIMIT 1").get(id) as { id: number } | undefined;
  return row?.id ?? null;
}

/** A status round-trip or a new run must invalidate an earlier hand-in. */
function completionGeneration(task: TaskRow): string {
  const run = getDb().prepare("SELECT id, ended_at FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(task.id) as { id: number; ended_at: string | null } | undefined;
  const transition = getDb().prepare(`SELECT id FROM events WHERE task_id = ?
    AND from_status IS NOT NULL AND to_status IS NOT NULL AND from_status <> to_status
    ORDER BY id DESC LIMIT 1`).get(task.id) as { id: number } | undefined;
  return JSON.stringify([task.status, task.agent_id, task.paseo_workspace_id, run?.id ?? null, run?.ended_at ?? null, transition?.id ?? null]);
}

/** Internal submission metadata, outside the caller-provided handoff. */
function storedOnBehalf(task: TaskRow): StoredOnBehalf | null {
  const saved = safeParse<{ completion?: Partial<StoredOnBehalf> }>(task.handoff_json)?.completion;
  if (saved?.onBehalf !== true || typeof saved.actorAgentId !== "string" || !saved.actorAgentId.trim() || typeof saved.note !== "string") return null;
  return { onBehalf: true, actorAgentId: saved.actorAgentId, note: saved.note, blockedEventId: saved.blockedEventId, generation: saved.generation };
}

export function completeTask(id: number, actorRole: "executor", summary: string, handoff: unknown, options?: CompleteOnBehalf): TaskRow;
export function completeTask(id: number, actorRole: string, summary: string, handoff: unknown, options?: CompleteOnBehalf): TaskRow | Promise<TaskRow>;
export function completeTask(id: number, actorRole: string, summary: string, handoff: unknown, options?: CompleteOnBehalf): TaskRow | Promise<TaskRow> {
  const text = summary.trim();
  if (!text) throw new KanbanError("invalid", t("flow.error.noSummary"));
  const task = getTask(id);
  const onBehalf = options?.onBehalf === true;
  const behalfActor = options?.actorAgentId?.trim() || "";
  if (onBehalf) {
    const settings = loadConfig();
    const allowed = behalfActor !== "" && (settings.supervisorAgentId === behalfActor || projectSupervisor(task.project, settings) === behalfActor);
    if (!allowed) throw new KanbanError("forbidden", t("flow.error.onBehalfLeaderOnly"), { role: actorRole });
  } else if (!COMPLETERS.has(actorRole)) {
    throw new KanbanError("forbidden", t("flow.error.cannotComplete", { role: roleLabel(actorRole) }), { role: actorRole });
  }
  const actor = onBehalf ? behalfActor : actorRole;
  const behalf = onBehalf ? { onBehalf: true, actorAgentId: behalfActor, note: t("flow.onBehalf.note") } : {};
  const prepare = () => {
    const wait = waitingOn(handoff);
    if (actorRole === "executor") noteObservedBranch(task, actorRole);
    const warning = completionWorkspaceWarning(task);
    const handoffWarnings = completionHandoffWarnings(handoff);
    const stored = JSON.stringify({ summary: [text, warning].filter(Boolean).join("\n\n"), handoff: handoff ?? null,
      ...(handoffWarnings.length ? { submissionWarnings: handoffWarnings } : {}),
      ...(onBehalf ? { completion: { ...behalf, generation: completionGeneration(task), ...(task.status === "blocked" ? { blockedEventId: latestBlockEvent(id) } : {}) } } : {}),
    });
    const diagnostics: PrBindingDiagnostics = {};
    const bound = writeContract(rememberPullRequest(task.contract_json, handoff, text, {
      project: task.project, workspacePath: task.workspace_path, diagnostics,
    }));
    return { wait, stored, diagnostics, bound };
  };
  if (submitsToReview(actorRole) || taskSubmitsToReview(task)) {
    return reserveAutomaticReview(id, () => {
      const { wait, stored, diagnostics, bound } = prepare();
      saveContract(id, bound);
      const next = move(id, task.status, "in_review", actor, "complete", ", handoff_json = ?", [stored], { summary: text, ...diagnostics, ...(wait ? { waitingOn: wait } : {}), ...behalf });
      addComment(id, actor, text);
      finishRun(id, "complete");
      return next;
    });
  }
  const { stored, bound } = prepare();
  saveContract(id, bound);
  if (readContract(bound).kind !== "github") return enterAcceptance(id, task.status, actor, text, stored, behalf);
  getDb().prepare("UPDATE tasks SET handoff_json = ? WHERE id = ?").run(stored, id);
  return gateDirectComplete(id, actor, text, stored, behalf);
}

function enterAcceptance(id: number, from: Status, actorRole: string, summary: string, stored: string, extra: Record<string, unknown> = {}): TaskRow {
  const wait = storedWaitingOn(stored);
  const diagnostics: PrBindingDiagnostics = {};
  const task = getTask(id);
  let saved: { handoff?: unknown; summary?: unknown } = {};
  try { saved = JSON.parse(stored); } catch { /* Preserve legacy unstructured handoffs. */ }
  rememberPullRequest(task.contract_json, saved.handoff, saved.summary, {
    project: task.project, workspacePath: task.workspace_path, diagnostics,
  });
  const next = move(id, from, "acceptance", actorRole, "complete", ", handoff_json = ?", [stored], { summary, ...diagnostics, ...(wait ? { waitingOn: wait } : {}), ...extra });
  addComment(id, actorRole, summary || t("flow.comment.completed"));
  finishRun(id, "complete");
  notifyAcceptance(next.id);
  promoteParents(actorRole);
  releaseAgents(id, null, true);
  return next;
}

/** Executors (and other non-review workers) are archived as soon as the card waits for acceptance. */
function workerIds(taskId: number): string[] {
  const task = getTask(taskId);
  const ids = new Set<string>();
  if (task.executor_agent_id) ids.add(task.executor_agent_id);
  const runs = getDb().prepare("SELECT agent_id, role FROM runs WHERE task_id = ? AND agent_id IS NOT NULL").all(taskId) as unknown as Array<{
    agent_id: string;
    role: string;
  }>;
  for (const row of runs) {
    if (row.role !== "reviewer" && row.agent_id) ids.add(row.agent_id);
  }
  return [...ids];
}

function releaseAgents(taskId: number, reviewerId: string | null, workers: boolean): void {
  const items: Array<{ agentId: string; role: "reviewer" | "executor" }> = [];
  if (reviewerId && reviewerId !== getTask(taskId).executor_agent_id) items.push({ agentId: reviewerId, role: "reviewer" });
  if (workers) {
    for (const agentId of workerIds(taskId)) items.push({ agentId, role: "executor" });
  }
  if (items.length === 0) return;
  requestAgentReleases(taskId, items);
}

function holdChecks(id: number, from: Status, actor: string, verdict: Exclude<PrVerdict, { kind: "pass" | "skip" }>): TaskRow {
  const state = readContract(getTask(id).contract_json);
  if (verdict.kind === "wait") {
    saveContract(id, writeContract({ ...state, awaiting: true }));
    setHold(id, verdict.summary);
    appendEvent(id, "pr_wait", from, from, actor, { summary: verdict.summary });
    return getTask(id);
  }
  if (verdict.kind === "fail") {
    saveContract(id, writeContract({ ...state, awaiting: false }));
    setHold(id, verdict.summary);
    appendEvent(id, "pr_failed", from, from, actor, { summary: verdict.summary, checks: verdict.checks });
    addComment(id, actor, checksNote(verdict));
    return getTask(id);
  }
  setHold(id, verdict.summary);
  appendEvent(id, "pr_error", null, from, actor, { summary: verdict.summary });
  throw new KanbanError("pr_checks", verdict.summary);
}

async function gateDirectComplete(id: number, actorRole: string, summary: string, stored: string, extra: Record<string, unknown> = {}): Promise<TaskRow> {
  const task = getTask(id);
  const state = readContract(task.contract_json);
  if (state.kind !== "github") return enterAcceptance(id, task.status, actorRole, summary, stored, extra);
  const verdict = await evaluateContract(state);
  if (verdict.kind === "pass" || verdict.kind === "skip") {
    saveContract(id, writeContract({ ...state, awaiting: false }));
    return enterAcceptance(id, task.status, actorRole, summary, stored, extra);
  }
  if (verdict.kind === "fail") {
    holdChecks(id, task.status, actorRole, verdict);
    throw new KanbanError("pr_checks", checksNote(verdict));
  }
  holdChecks(id, task.status, actorRole, verdict);
  throw new KanbanError("pr_checks", verdict.summary);
}

function checksNote(verdict: Extract<PrVerdict, { kind: "fail" }>): string {
  const lines = [verdict.summary];
  for (const check of verdict.checks) lines.push(check.url ? `${check.name} ${check.url}` : `${check.name}${t("common.paren", { text: check.state })}`);
  return lines.join("\n");
}

function returnForChecks(id: number, verdict: Extract<PrVerdict, { kind: "fail" }>, actor: string): TaskRow {
  const task = getTask(id);
  if (task.status !== "reviewing") throw new KanbanError("illegal_transition", t("flow.error.cannotReturn", { status: task.status }), { from: task.status });
  const note = checksNote(verdict);
  const ts = new Date().toISOString();
  const info = getDb()
    .prepare(
      `UPDATE tasks SET status = 'rework', agent_id = executor_agent_id, updated_at = ?, nudge_count = 0 WHERE id = ? AND status = 'reviewing'`,
    )
    .run(ts, id);
  if (info.changes !== 1) throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(id) }), { id });
  const state = readContract(getTask(id).contract_json);
  saveContract(id, writeContract({ ...state, awaiting: false }));
  appendEvent(id, "pr_failed", "reviewing", "rework", actor, { summary: verdict.summary, checks: verdict.checks });
  addComment(id, actor, note);
  finishRun(id, "pr_failed");
  return getTask(id);
}

async function gateReview(task: TaskRow, actor: string, approval: LinkedApprovalRequest | null): Promise<TaskRow | null> {
  const state = readContract(task.contract_json);
  if (state.kind !== "github") return null;
  const generation = completionGeneration(task);
  const verdict = await evaluateContract(state);
  const fresh = getTask(task.id);
  if (fresh.contract_json !== task.contract_json || completionGeneration(fresh) !== generation) {
    throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(task.id) }));
  }
  if (verdict.kind === "pass" || verdict.kind === "skip") {
    saveContract(task.id, writeContract({ ...state, awaiting: false }));
    return null;
  }
  if (verdict.kind === "wait") {
    saveContract(task.id, writeContract({ ...state, awaiting: true }));
    setHold(task.id, verdict.summary);
    appendEvent(task.id, "pr_wait", task.status, task.status, actor, { summary: verdict.summary, ...(approval ? { linkedApproval: approval } : {}) });
    return getTask(task.id);
  }
  if (verdict.kind === "fail") return returnForChecks(task.id, verdict, actor);
  setHold(task.id, verdict.summary);
  appendEvent(task.id, "pr_error", null, task.status, actor, { summary: verdict.summary });
  throw new KanbanError("pr_checks", verdict.summary);
}

function approveNow(id: number, summary: string, actor: string, approval: LinkedApprovalRequest | null = null): TaskRow {
  const db = getDb();
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  let next: TaskRow;
  let passed: { task: TaskRow; actor: string } | undefined;
  let reviewerId: string | null;
  try {
    const task = getTask(id);
    reviewerId = task.agent_id;
    if (approval && !linkedApprovalCurrent(task, approval)) throw new KanbanError("forbidden", t("tools.tokenNotCardAgent"));
    const linked = task.role === "reviewer" && task.review_of != null ? linkedApproval(task, approval) : null;
    next = move(id, "reviewing", "acceptance", actor, "approve", "", [], { summary });
    addComment(id, actor, summary || t("flow.comment.approved"));
    finishRun(id, "approve");
    if (linked && "evidence" in linked) {
      const evidence = linked.evidence;
      const note = t("flow.linkedApproval.passed", { review: evidence.reviewCard, agent: evidence.reviewerAgentId, model: evidence.reviewerModel, summary });
      recordPassedAcceptance(linked.target, note, evidence.reviewerAgentId, "approve", { summary: note, ...evidence });
      passed = { task: linked.target, actor: evidence.reviewerAgentId };
    } else if (linked) {
      const target = cardMark(task.review_of!);
      const note = [t("flow.linkedApproval.held", { review: cardMark(id), target, reason: linked.reason }),
        linked.target?.status === "in_review" ? t("flow.linkedApproval.pass", { target }) : ""].filter(Boolean).join(" ");
      addComment(id, actor, note);
      if (linked.target) addComment(linked.target.id, actor, note);
      appendEvent(id, "linked_review_approval_held", null, "acceptance", actor, { targetId: task.review_of, reason: linked.reason });
    }
    if (isQaReview(next)) {
      db.prepare("UPDATE tasks SET handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary, handoff: { verdictTable: summary } }), next.id);
      next = getTask(next.id);
    }
    if (ownsTransaction) db.exec("COMMIT");
  } catch (err) {
    if (ownsTransaction) db.exec("ROLLBACK");
    throw err;
  }
  if (passed) notifyQaSignoff(next, passed.task, summary);
  notifyAcceptance(next.id);
  if (passed) finishPassedAcceptance(passed.task, passed.actor);
  else promoteParents(actor);
  releaseAgents(id, reviewerId, true);
  return next;
}

/** Record the own-card verdict; only a bound, independent linked review can advance its queued target. */
export function approveTask(id: number, summary: string, actor = "reviewer", actorAgentId?: string | null): TaskRow | Promise<TaskRow> {
  const text = summary.trim();
  if (!text) throw new KanbanError("invalid", t("flow.error.noSummary"));
  const task = getTask(id);
  if (task.status !== "reviewing") {
    throw new KanbanError("illegal_transition", t("flow.error.cannotApprove", { status: task.status }), { from: task.status, to: "acceptance" });
  }
  if (actorAgentId !== undefined && actorAgentId !== task.agent_id) throw new KanbanError("forbidden", t("tools.tokenNotCardAgent"));
  const approval = linkedApprovalRequest(task, actorAgentId === undefined ? task.agent_id : actorAgentId);
  if (readContract(task.contract_json).kind !== "github") return approveNow(id, text, actor, approval);
  return gateReview(task, actor, approval).then((held) => held ?? approveNow(id, text, actor, approval));
}

function reviewHandoff(reason: string, findings: string): string {
  return JSON.stringify({ summary: reason, handoff: { reason, findings } });
}

/** A reviewer card has no executor. Hand the verdict to the supervisor as acceptance. */
function handStandaloneReview(id: number, from: Status, reason: string, findings: string, actor: string): TaskRow {
  const stored = reviewHandoff(reason, findings);
  const next = move(id, from, "acceptance", actor, "request_changes", ", handoff_json = ?, hold_reason = NULL", [stored], {
    reason,
    findings,
    summary: reviewRejectCaption(reason),
  });
  const note = [reason, findings].filter(Boolean).join("\n");
  addComment(id, actor, note || t("flow.comment.reviewRejected"));
  finishRun(id, "request_changes");
  notifyAcceptance(next.id);
  promoteParents(actor);
  return next;
}

function storedReviewNote(taskId: number): { reason: string; findings: string } {
  const row = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'request_changes' ORDER BY id DESC LIMIT 1`)
    .get(taskId) as { data_json: string } | undefined;
  if (!row) return { reason: t("flow.comment.reviewRejected"), findings: "" };
  try {
    const data = JSON.parse(row.data_json) as { reason?: unknown; findings?: unknown };
    const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : t("flow.comment.reviewRejected");
    const findings = typeof data.findings === "string" ? data.findings : "";
    return { reason, findings };
  } catch {
    return { reason: t("flow.comment.reviewRejected"), findings: "" };
  }
}

/**
 * A reviewer card left in rework with no executor cannot be sent back.
 * Move it to acceptance once. A second call finds it is no longer rework.
 */
export function recoverStandaloneReview(id: number, actor = "scheduler"): TaskRow | null {
  const task = getTask(id);
  if (task.role !== "reviewer" || task.executor_agent_id || task.status !== "rework") return null;
  const note = storedReviewNote(id);
  try {
    return handStandaloneReview(id, "rework", note.reason, note.findings, actor);
  } catch (err) {
    if (err instanceof KanbanError && err.code === "conflict") {
      const current = getTask(id);
      return current.status === "acceptance" ? current : null;
    }
    throw err;
  }
}

/**
 * An agent file that says archived or closed is gone (#77 archives the executor on acceptance).
 * No file, or a file we cannot read, still counts as here: send the work back instead of opening someone new.
 */
function executorPresent(taskId: number, agentId: string | null): boolean {
  if (!agentId) return false;
  if (agentReleaseRequested(taskId, agentId)) return false;
  const read = readAgentRecord(agentId);
  if (read.state !== "ok") return true;
  if (read.file.archivedAt) return false;
  if (read.file.lastStatus === "closed") return false;
  if (agentCwdMissing(agentId)) return false;
  return true;
}

/** The card forgot this executor; queue it for the normal archive flow (notes saved first) so it does not idle forever. */
function releaseSupersededExecutor(taskId: number, agentId: string | null): void {
  if (agentId) requestAgentReleases(taskId, [{ agentId, role: "executor" }]);
}

export function appendRejectBrief(task: TaskRow, reason: string): void {
  // Local cloud feedback is sent separately. The host handoff includes private paths and source mappings.
  if (localCloudReceipt(task.id)) return;
  const prior = task.handoff_json?.trim() || t("flow.brief.noPriorHandoff");
  const addition = `\n\n${t("flow.brief.rejected")}\n${reason.trim()}\n\n${t("flow.brief.priorHandoff")}\n${prior}\n`;
  getDb().prepare("UPDATE tasks SET brief = ? WHERE id = ?").run(`${task.brief ?? ""}${addition}`, task.id);
}

const LEADER_REWORK_FROM = new Set<Status>(["blocked", "acceptance", "reviewing", "in_review", "rework"]);
const LEADER_PASS_FROM = new Set<Status>(["blocked", "reviewing", "in_review", "rework"]);
const CLEAR_LEADER_HOLDS = "blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, hold_reason = NULL, cooldown_until = NULL, nudge_count = 0";

/** Shared by leader adjudication and automatic recovery of a departed executor. */
function reworkAssignment(task: TaskRow, reason: string, agentId: string | null, present: boolean) {
  return {
    status: present ? "rework" : "ready",
    agentId: present ? agentId : null,
    brief: present ? task.brief : `${task.brief}\n\n${t("flow.brief.thisRound")}\n${reason}\n`,
  };
}

export interface ReworkReplacement {
  oldAgentId: string | null;
  oldProfile: string | null;
  presence: string;
  reason: string;
}

function recordReworkReplacement(task: TaskRow, agentId: string | null, presence: string, reason: string, actor: string, at: string): void {
  const prior = !task.executor_profile
    ? getDb().prepare("SELECT profile_name FROM runs WHERE task_id = ? AND role = ? ORDER BY id DESC LIMIT 1")
        .get(task.id, task.role) as { profile_name: string | null } | undefined
    : undefined;
  appendEvent(task.id, "rework_reopen_pending", null, null, actor, {
    oldAgentId: agentId, oldProfile: task.executor_profile ?? prior?.profile_name ?? null, presence, reason,
  }, at);
}

/** Remains pending through quota holds and failed creates; only a successful start consumes it. */
export function pendingReworkReplacement(id: number): ReworkReplacement | null {
  const row = getDb().prepare(
    "SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN ('rework_reopen_pending', 'started', 'rework_reopened') ORDER BY id DESC LIMIT 1",
  ).get(id) as { kind: string; data_json: string } | undefined;
  if (row?.kind !== "rework_reopen_pending") return null;
  // The pending marker is what matters. Unreadable details must not stop the card from starting.
  return safeParse<ReworkReplacement>(row.data_json) ?? { oldAgentId: null, oldProfile: null, presence: "unknown", reason: t("flow.rework.unreadable") };
}

/** Keep the submission directory and profile; normal dispatch chooses an available executor. */
export function reopenDepartedRework(task: TaskRow, agentId: string | null, presence: "archived" | "missing", reason: string, at: string): TaskRow {
  const next = reworkAssignment(task, reason, agentId, false);
  const info = getDb().prepare(
    `UPDATE tasks SET status = ?, agent_id = ?, executor_agent_id = ?, brief = ?, ${CLEAR_LEADER_HOLDS}, updated_at = ?
     WHERE id = ? AND status = 'rework' AND updated_at = ?`,
  ).run(next.status, next.agentId, next.agentId, next.brief, at, task.id, task.updated_at);
  if (info.changes !== 1) throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(task.id) }));
  revokeAgentToken(agentId);
  closeLeaderRuns(task.id, "rework_reopen", at);
  appendEvent(task.id, "rework_reopen_queued", "rework", "ready", "scheduler", { agentId, presence }, at);
  recordReworkReplacement(task, agentId, presence, reason, "scheduler", at);
  return getTask(task.id);
}

/** A leader decision bypasses the review fuse; counting a round is explicitly optional. */
export async function leaderReworkTask(
  id: number,
  reason: string,
  options: { agentId?: string; countRound?: boolean; presence: (agentId: string) => Promise<AgentPresence> | AgentPresence },
  actor = "supervisor",
): Promise<TaskRow> {
  const text = reason.trim();
  if (!text) throw new KanbanError("invalid", t("flow.error.noReworkReason"));
  const task = getTask(id);
  assertRunBudgetSettled(id);
  // A done card whose queued land hit a conflict can go back to its kept worktree; nothing else leaves done.
  const landConflict = (task.status === "done" || task.status === "archived") && pendingLand(task.id)?.conflict === true;
  if (!LEADER_REWORK_FROM.has(task.status) && !landConflict) throw new KanbanError("illegal_transition", t("flow.error.cannotRuleRework", { status: statusLabel(task.status) }));
  const prior = task.status === "rework" && !task.executor_agent_id
    ? getDb().prepare("SELECT agent_id FROM runs WHERE task_id = ? AND role = ? ORDER BY id DESC LIMIT 1")
        .get(task.id, task.role) as { agent_id: string | null } | undefined
    : undefined;
  const agentId = options.agentId === undefined ? task.executor_agent_id ?? prior?.agent_id : options.agentId.trim();
  if (options.agentId !== undefined && !agentId) throw new KanbanError("invalid", t("flow.error.noAgent"));
  const presence = agentId ? await options.presence(agentId) : "missing";
  // Unknown is not evidence of departure: retain the original executor through daemon reloads.
  const present = !!agentId && !presenceIsGone(presence);
  if (present && archiveInFlight("agent", agentId)) throw new KanbanError("conflict", t("flow.error.executorArchiving"));
  assertRunBudgetSettled(id);
  const next = reworkAssignment(task, text, agentId ?? null, present);
  const to = next.status;
  const ts = new Date().toISOString();
  const info = getDb().prepare(
    `UPDATE tasks SET status = ?, agent_id = ?, executor_agent_id = ?, brief = ?, review_round = ?,
     ${CLEAR_LEADER_HOLDS}, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?`,
  ).run(to, next.agentId, next.agentId, next.brief, task.review_round + (options.countRound ? 1 : 0), ts, id, task.status, task.updated_at);
  if (info.changes !== 1) throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(id) }));
  if (present && agentId) hookObjects.rememberAgent(agentId);
  if (present && agentReleaseRequested(id, agentId)) appendEvent(id, "release_agent_canceled", null, null, actor, { agentId });
  appendEvent(id, "leader_rework", task.status, to, actor, { reason: text, fromStatus: task.status, countRound: options.countRound === true, agentId, presence });
  closeLeaderRuns(id, "leader_rework", ts);
  resetRunBudget(id);
  if (!present) recordReworkReplacement(task, agentId ?? null, presence, text, actor, ts);
  addComment(id, actor, text);
  // The binding no longer points at the old executor (replaced, or departed and reopened): retire it.
  const oldExecutor = task.executor_agent_id ?? prior?.agent_id;
  if (oldExecutor && next.agentId !== oldExecutor) releaseSupersededExecutor(id, oldExecutor);
  // Retire the superseded reviewer, preserving the executor for the scheduler's resume path.
  if (task.agent_id && task.agent_id !== task.executor_agent_id && task.agent_id !== agentId) {
    revokeAgentToken(task.agent_id);
    releaseAgents(id, task.agent_id, false);
  }
  return getTask(id);
}

function closeLeaderRuns(id: number, kind: string, ts: string): void {
  getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = ? WHERE task_id = ? AND ended_at IS NULL").run(ts, kind, id);
}

/** An explicit verdict enters the usual acceptance/notification lifecycle without accepting. */
export function leaderPassTask(id: number, note: string, actor = "supervisor"): TaskRow {
  const text = note.trim();
  if (!text) throw new KanbanError("invalid", t("flow.error.noRulingReason"));
  const task = getTask(id);
  if (!LEADER_PASS_FROM.has(task.status)) throw new KanbanError("illegal_transition", t("flow.error.cannotRulePass", { status: statusLabel(task.status) }));
  recordPassedAcceptance(task, text, actor, "leader_pass", { note: text });
  finishPassedAcceptance(task, actor);
  return getTask(id);
}

/** Shared acceptance lifecycle; linked approval does not grant the reviewer the leader's pass API. */
function recordPassedAcceptance(task: TaskRow, note: string, actor: string, kind: "leader_pass" | "approve", data: Record<string, unknown>): void {
  const id = task.id;
  const ts = new Date().toISOString();
  const info = getDb().prepare(
    `UPDATE tasks SET status = 'acceptance', ${CLEAR_LEADER_HOLDS}, updated_at = ? WHERE id = ? AND status = ?`,
  ).run(ts, id, task.status);
  if (info.changes !== 1) throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(id) }));
  appendEvent(id, kind, task.status, "acceptance", actor, data);
  addComment(id, actor, note);
  closeLeaderRuns(id, kind, ts);
}

function finishPassedAcceptance(task: TaskRow, actor: string): void {
  const id = task.id;
  // Keep the executor's embedded token usable if acceptance is immediately sent back.
  // It cannot submit from acceptance; the usual current-agent and transition guards still apply.
  if (task.agent_id !== task.executor_agent_id) revokeAgentToken(task.agent_id);
  notifyAcceptance(id);
  promoteParents(actor);
  releaseAgents(id, task.agent_id, true);
}

/**
 * Send a card back to rework. The original executor gets it when they are still here.
 * Otherwise clear that executor so the scheduler opens a new one, and append the reason to the brief.
 * The second review rejection (review_round becomes 2) stops on rework and wakes the project leader.
 * It does not resume the executor. A later rejection, after the leader sends it back, still stops at round 3.
 * Leader rejects and land conflicts do not take the round-2 stop. Land conflicts do not increment review_round.
 * in_review is included so a linked review can send back a target that no inline reviewer has claimed.
 * The review card itself must still be reviewing. Creating the review does not claim the target.
 */
const REWORK_FROM = new Set<Status>(["acceptance", "done", "archived", "rework", "reviewing", "blocked", "in_review"]);

function parkSecondReview(task: TaskRow, reason: string, findings: string, actor: string, endRun: boolean): TaskRow {
  const text = reason.trim();
  const nextRound = task.review_round + 1;
  const note = [text, findings].filter(Boolean).join("\n");
  const notice = reviewHoldNotice(task.id, { reason: text, findings });
  const data = {
    reason: text,
    findings,
    reviewRound: nextRound,
    summary: reviewRejectCaption(text),
    reopened: task.status === "done" || task.status === "archived",
    leaderHold: true,
  };
  const from = task.status;
  if (from !== "rework") assertTransition(from, "rework");
  const ts = new Date().toISOString();
  const clearBlocked =
    from === "blocked"
      ? ", blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, cooldown_until = NULL"
      : "";
  const info =
    from === "rework"
      ? getDb()
          .prepare(
            `UPDATE tasks SET review_round = ?, agent_id = NULL, hold_reason = ?, updated_at = ?, nudge_count = 0 WHERE id = ? AND status = 'rework'`,
          )
          .run(nextRound, leaderHoldReason(), ts, task.id)
      : getDb()
          .prepare(
            `UPDATE tasks SET status = 'rework', review_round = ?, agent_id = NULL, hold_reason = ?${clearBlocked}, updated_at = ?, nudge_count = 0 WHERE id = ? AND status = ?`,
          )
          .run(nextRound, leaderHoldReason(), ts, task.id, from);
  if (info.changes !== 1) throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(task.id) }), { id: task.id });
  appendEvent(task.id, "request_changes", from, "rework", actor, data);
  appendEvent(task.id, "review_leader_hold", "rework", "rework", actor, {
    reviewRound: nextRound,
    rounds: notice.rounds,
    lead: notice.lead,
    next: notice.next,
  });
  addComment(task.id, actor, note || t("flow.comment.round2"));
  if (endRun) finishRun(task.id, "request_changes");
  deliverStoredReviewHold(task.id);
  return getTask(task.id);
}

function returnForRework(
  task: TaskRow,
  reason: string,
  findings: string,
  actor: string,
  kind: "request_changes" | "rejected",
  endRun: boolean,
): TaskRow {
  if (!REWORK_FROM.has(task.status)) {
    throw new KanbanError("illegal_transition", t("flow.error.reviewedNotReworkable", { card: cardMark(task.id), status: statusLabel(task.status) }), {
      from: task.status,
      to: "rework",
    });
  }
  const text = reason.trim();
  const nextRound = task.review_round + 1;
  const note = [text, findings].filter(Boolean).join("\n");
  const summary = kind === "rejected" ? supervisorRejectCaption(text) : reviewRejectCaption(text);
  const data = {
    reason: text,
    findings,
    reviewRound: nextRound,
    summary,
    reopened: task.status === "done" || task.status === "archived",
  };
  if (nextRound >= 3) {
    let current = task;
    if (current.status === "done" || current.status === "archived" || !canTransition(current.status, "blocked")) {
      current = move(current.id, current.status, "rework", actor, "reopened", "", [], { reason: text });
    }
    const blocked = blockTask(current.id, "needs_human", t("flow.block.round3", { note }), actor);
    getDb().prepare("UPDATE tasks SET review_round = ? WHERE id = ?").run(nextRound, current.id);
    addComment(current.id, actor, note || t("flow.comment.round3"));
    if (kind === "rejected") appendEvent(current.id, "rejected", task.status, "blocked", actor, data);
    if (endRun) finishRun(current.id, kind);
    return getTask(blocked.id);
  }
  if (kind === "request_changes" && nextRound === 2) {
    return parkSecondReview(task, text, findings, actor, endRun);
  }
  const present = executorPresent(task.id, task.executor_agent_id);
  if (!present) {
    appendRejectBrief(getTask(task.id), text);
    releaseSupersededExecutor(task.id, task.executor_agent_id);
  }
  const from = task.status;
  if (from !== "rework") assertTransition(from, "rework");
  const ts = new Date().toISOString();
  const assign = present
    ? "agent_id = executor_agent_id"
    : "agent_id = NULL, executor_agent_id = NULL";
  const clearBlocked =
    from === "blocked"
      ? ", blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, hold_reason = NULL, cooldown_until = NULL"
      : "";
  const info =
    from === "rework"
      ? getDb()
          .prepare(`UPDATE tasks SET review_round = ?, ${assign}, updated_at = ?, nudge_count = 0 WHERE id = ? AND status = 'rework'`)
          .run(nextRound, ts, task.id)
      : getDb()
          .prepare(
            `UPDATE tasks SET status = 'rework', review_round = ?, ${assign}${clearBlocked}, updated_at = ?, nudge_count = 0 WHERE id = ? AND status = ?`,
          )
          .run(nextRound, ts, task.id, from);
  if (info.changes !== 1) throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(task.id) }), { id: task.id });
  appendEvent(task.id, kind, from, "rework", actor, data);
  addComment(task.id, actor, note || (kind === "rejected" ? t("flow.comment.leaderRejected") : t("flow.comment.reviewRejected")));
  if (endRun) finishRun(task.id, kind);
  return getTask(task.id);
}

/** Latest review rejection or accept-time land conflict. A later normal rejection wins. */
export function latestReworkKind(taskId: number): "land_conflict" | "request_changes" | "rejected" | "leader_rework" | null {
  const row = getDb()
    .prepare(
      `SELECT kind FROM events WHERE task_id = ? AND kind IN ('land_conflict', 'request_changes', 'rejected', 'leader_rework') ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { kind: string } | undefined;
  if (row?.kind === "land_conflict" || row?.kind === "request_changes" || row?.kind === "rejected" || row?.kind === "leader_rework") return row.kind;
  return null;
}

/** Reviewers only need this when the submission they are looking at came back from a land conflict. */
export function conflictReviewNote(taskId: number): string | null {
  if (latestReworkKind(taskId) !== "land_conflict") return null;
  return t("flow.conflict.reviewNote");
}

function landConflictDetail(landed: Extract<LandResult, { kind: "conflict" }>): string {
  return `${landed.message}\n${t("flow.conflict.redo", { base: landed.base })}`;
}

function appendLandConflictBrief(task: TaskRow, text: string): void {
  getDb().prepare("UPDATE tasks SET brief = ? WHERE id = ?").run(`${task.brief ?? ""}\n\n${t("flow.brief.landConflict")}\n${text.trim()}\n`, task.id);
}

/**
 * Accept hit a rebase conflict. Send the card back without counting a review round.
 * The original executor gets it when they are still here. Past landConflictLimit, stop for a person.
 */
function returnForLandConflict(task: TaskRow, landed: Extract<LandResult, { kind: "conflict" }>, actor: string): TaskRow {
  if (!REWORK_FROM.has(task.status)) {
    throw new KanbanError("illegal_transition", t("flow.error.reviewedNotReworkable", { card: cardMark(task.id), status: statusLabel(task.status) }), {
      from: task.status,
      to: "rework",
    });
  }
  const count = task.land_conflict_count + 1;
  const limit = loadConfig().landConflictLimit ?? DEFAULT_LAND_CONFLICT_LIMIT;
  const detail = landConflictDetail(landed);
  const data = {
    reason: detail,
    message: landed.message,
    files: landed.files,
    other: landed.other,
    base: landed.base,
    count,
  };
  appendLandConflictBrief(task, detail);
  if (count > limit) {
    const why = t("flow.conflict.limit", { count, limit, detail });
    if (task.status === "blocked") {
      const ts = new Date().toISOString();
      getDb()
        .prepare(
          `UPDATE tasks SET blocked_kind = 'needs_human', blocked_reason = ?, blocked_at = ?, hold_reason = ?, land_conflict_count = ?, updated_at = ? WHERE id = ?`,
        )
        .run(why, ts, why, count, ts, task.id);
      appendEvent(task.id, "land_conflict", task.status, "blocked", actor, data);
      addComment(task.id, actor, why);
      notifyTask(getTask(task.id), "blocked", why);
    } else {
      if (!canTransition(task.status, "blocked")) {
        move(task.id, task.status, "rework", actor, "reopened", "", [], { reason: detail });
      }
      const current = getTask(task.id);
      blockTask(current.id, "needs_human", why, actor);
      getDb().prepare("UPDATE tasks SET land_conflict_count = ? WHERE id = ?").run(count, current.id);
      appendEvent(current.id, "land_conflict", task.status, "blocked", actor, data);
    }
    finishRun(task.id, "land_conflict");
    return getTask(task.id);
  }
  const present = executorPresent(task.id, task.executor_agent_id);
  if (!present) releaseSupersededExecutor(task.id, task.executor_agent_id);
  const from = task.status;
  if (from !== "rework") assertTransition(from, "rework");
  const ts = new Date().toISOString();
  const assign = present ? "agent_id = executor_agent_id" : "agent_id = NULL, executor_agent_id = NULL";
  const clearBlocked =
    from === "blocked"
      ? ", blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, hold_reason = NULL, cooldown_until = NULL"
      : "";
  const info =
    from === "rework"
      ? getDb()
          .prepare(`UPDATE tasks SET land_conflict_count = ?, ${assign}, updated_at = ?, nudge_count = 0 WHERE id = ? AND status = 'rework'`)
          .run(count, ts, task.id)
      : getDb()
          .prepare(
            `UPDATE tasks SET status = 'rework', land_conflict_count = ?, ${assign}${clearBlocked}, updated_at = ?, nudge_count = 0 WHERE id = ? AND status = ?`,
          )
          .run(count, ts, task.id, from);
  if (info.changes !== 1) throw new KanbanError("conflict", t("flow.error.statusChanged", { card: cardMark(task.id) }), { id: task.id });
  appendEvent(task.id, "land_conflict", from, "rework", actor, data);
  addComment(task.id, actor, detail);
  finishRun(task.id, "land_conflict");
  return getTask(task.id);
}

function finishReviewRejected(task: TaskRow, reason: string, findings: string, actor: string): TaskRow {
  const stored = reviewHandoff(reason, findings);
  const next = move(task.id, task.status, "done", actor, "request_changes", ", handoff_json = ?, hold_reason = NULL", [stored], {
    reason,
    findings,
    summary: reviewRejectCaption(reason),
    reviewOf: task.review_of,
  });
  const note = [reason, findings].filter(Boolean).join("\n");
  addComment(task.id, actor, note || t("flow.comment.reviewRejected"));
  finishRun(task.id, "request_changes");
  notifyFinished(next);
  promoteParents(actor);
  return next;
}

export function requestChanges(id: number, reason: string, findings: string, actor = "reviewer"): TaskRow {
  const text = reason.trim();
  if (!text) throw new KanbanError("invalid", t("flow.error.noReason"));
  const task = getTask(id);
  if (task.status !== "reviewing") {
    throw new KanbanError("illegal_transition", t("flow.error.cannotReject", { status: task.status }), { from: task.status, to: "rework" });
  }
  const reviewerId = task.agent_id;
  let next: TaskRow;
  if (task.role === "reviewer" && task.review_of) {
    const original = getTask(task.review_of);
    try {
      returnForRework(original, text, findings.trim(), actor, "request_changes", false);
    } catch (err) {
      if (err instanceof KanbanError && err.code === "illegal_transition") {
        addComment(id, actor, t("flow.comment.rejectFailed", { error: err.message, reason: text }));
      }
      throw err;
    }
    next = finishReviewRejected(getTask(id), text, findings.trim(), actor);
  } else if (task.role === "reviewer") {
    next = handStandaloneReview(id, task.status, text, findings.trim(), actor);
  } else {
    next = returnForRework(task, text, findings.trim(), actor, "request_changes", true);
  }
  releaseAgents(id, reviewerId, false);
  return next;
}

/** Supervisor sends an acceptance card back to rework. Same scope as accept; only acceptance. */
export function rejectTask(id: number, reason: string, actor = "supervisor"): TaskRow {
  const text = reason.trim();
  if (!text) throw new KanbanError("invalid", t("flow.error.noReason"));
  const task = getTask(id);
  if (task.status !== "acceptance") {
    throw new KanbanError("illegal_transition", t("flow.error.cannotReject", { status: statusLabel(task.status) }), { from: task.status, to: "rework" });
  }
  if (task.role === "reviewer") {
    throw new KanbanError("illegal_transition", t("flow.error.reviewerReject"), { from: task.status, to: "rework" });
  }
  return returnForRework(task, text, "", actor, "rejected", true);
}

function artifactReviewSatisfied(task: TaskRow): boolean {
  const own = getDb().prepare("SELECT 1 AS ok FROM events WHERE task_id = ? AND kind IN ('approve', 'leader_pass') LIMIT 1").get(task.id);
  if (own) return true;
  const reviewed = getDb()
    .prepare(
      `SELECT 1 AS ok FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE t.review_of = ? AND e.kind IN ('approve', 'leader_pass') LIMIT 1`,
    )
    .get(task.id);
  return Boolean(reviewed);
}

function artifactEventData(record: ArtifactAcceptance): Record<string, unknown> {
  return {
    sha: record.sha,
    tree: record.tree,
    branch: record.branch,
    base: record.base,
    evidenceKind: record.evidenceKind,
    evidence: record.evidence,
    ...(record.evidencePath ? { evidencePath: record.evidencePath } : {}),
    ...(record.evidenceSha256 ? { evidenceSha256: record.evidenceSha256 } : {}),
    ...(record.evidenceBytes != null ? { evidenceBytes: record.evidenceBytes } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  };
}

/**
 * Card branch used to identify an artifact. A pull request or GitHub contract skips
 * local landing, but it does not skip this branch. No temporary branch means the
 * checked-out commit is the delivery, including a detached HEAD.
 */
function artifactBranch(task: TaskRow): { owned: ArtifactBranch | null; checkout: boolean } {
  const created = createdWorktree(task.id);
  if (!created) return { owned: null, checkout: true };
  const problem = worktreeOwnershipError(task.id, created);
  if (problem) throw new KanbanError("conflict", problem);
  if (created.readOnly === true) return { owned: null, checkout: false };
  const owned = ownedWorktree(task.id, created);
  if (!owned) throw new KanbanError("conflict", t("tempLand.refuse.notOwned"));
  const judged = judgedWorktree(task.id, owned);
  return { owned: { root: judged.root, branch: judged.branch, base: judged.base }, checkout: false };
}

/**
 * Explicit artifact acceptance. Ordinary accept is unchanged when no artifact evidence is passed.
 * This does not fast-forward or rebase, and a missing remote does not select it.
 */
async function acceptArtifact(task: TaskRow, actor: string, evidence: string, reason: string | undefined): Promise<TaskRow & { artifact: ArtifactAcceptance }> {
  if (task.status !== "acceptance") {
    throw new KanbanError("illegal_transition", t("artifactAccept.onlyAcceptance", { status: task.status }), { from: task.status, to: "done" });
  }
  if (taskSubmitsToReview(task) && !artifactReviewSatisfied(task)) {
    throw new KanbanError("forbidden", t("artifactAccept.reviewRequired"));
  }
  const located = artifactBranch(task);
  const record = await resolveArtifactEvidence({
    evidence,
    reason,
    workspacePath: task.workspace_path,
    owned: located.owned,
    checkout: located.checkout,
    checkoutBase: task.workspace_base,
    boundPullRequest: readContract(task.contract_json).pr,
  });
  const data = artifactEventData(record);
  const next = move(task.id, task.status, "done", actor, "accept", "", [], data);
  appendEvent(task.id, "artifact_accepted", null, null, actor, data);
  addComment(task.id, actor, t("flow.accept.artifact", { sha: record.sha, tree: record.tree }));
  finishRun(task.id, "accept");
  promoteChildren(task.id, actor);
  promoteParents(actor);
  notifyFinished(next);
  return { ...next, artifact: record };
}

export async function acceptTask(id: number, actor = "supervisor", options: { artifact?: string; reason?: string } = {}): Promise<TaskRow & { merged?: string[]; unmerged?: string; pending?: string; artifact?: ArtifactAcceptance }> {
  const task = getTask(id);
  if (typeof options.artifact === "string") return acceptArtifact(task, actor, options.artifact, options.reason);
  assertTransition(task.status, "done");
  const plan = landPlan(task);
  if (plan.kind === "refuse") throw new KanbanError("conflict", plan.message);
  let merged: string[] | undefined;
  let pending: string | undefined;
  let unmerged = plan.kind === "note" ? plan.reason : undefined;
  if (plan.kind === "land") {
    const landed = await landLocalBranch(task, plan.owned, actor);
    if (landed.kind === "pending") {
      recordLandPending(task.id, task.status, actor, { reason: landed.reason, branch: landed.branch, base: landed.base, head: landed.head, mainDirty: landed.mainDirty });
      pending = landed.reason;
    } else if (landed.kind === "refuse") throw new KanbanError("conflict", landed.message);
    else if (landed.kind === "conflict") {
      returnForLandConflict(task, landed, actor);
      throw new KanbanError("conflict", landed.message);
    } else if (landed.kind === "merged") merged = landed.commits;
    else unmerged = landed.message;
  }
  const accepted = t("flow.accept.done");
  const note = merged
    ? `${accepted}\n${merged.length ? merged.map((line) => t("flow.accept.commit", { commit: line })).join("\n") : t("flow.accept.noCommits")}`
    : pending
      ? `${accepted}\n${t("flow.accept.pending", { reason: pending })}`
      : unmerged
        ? `${accepted}\n${t("flow.accept.unmerged", { reason: unmerged })}`
        : accepted;
  const next = move(id, task.status, "done", actor, "accept", "", [], merged ? { commits: merged } : {});
  addComment(id, actor, note);
  finishRun(id, "accept");
  promoteChildren(id, actor);
  promoteParents(actor);
  notifyFinished(next);
  if (merged) return { ...next, merged };
  if (pending) return { ...next, pending };
  if (unmerged) return { ...next, unmerged };
  return next;
}

export function linkTask(taskId: number, parentId: number, actor: string): TaskRow & { warnings?: string[] } {
  if (taskId === parentId) throw new KanbanError("invalid", t("flow.error.linkSelf"));
  getTask(taskId);
  const parent = getTask(parentId);
  getDb().prepare("INSERT OR IGNORE INTO links (task_id, parent_id) VALUES (?, ?)").run(taskId, parentId);
  appendEvent(taskId, "link", null, null, actor, { parentId });
  const task = getTask(taskId);
  recordMergeCardDependencies(task, [parent], actor);
  const next = task.status === "ready" && parentBlockReason(parent, Date.now(), task) !== null
    ? claimStatus(taskId, "ready", "waiting", actor) : task;
  return withMergeCardWarnings(next, taskParents(taskId));
}

/** Remove a batch atomically, then reevaluate only this child's remaining merge gates. */
export function unlinkTask(taskId: number, parentIds: number[], actor: string): TaskRow {
  const task = getTask(taskId);
  const ids = [...new Set(parentIds)];
  if (!ids.length) throw new KanbanError("invalid", t("flow.error.noParents"));
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const parentId of ids) {
      getTask(parentId);
      if (!db.prepare("SELECT id FROM links WHERE task_id = ? AND parent_id = ?").get(taskId, parentId)) {
        throw new KanbanError("not_found", t("flow.error.noSuchParent", { card: cardMark(taskId), parent: cardMark(parentId) }));
      }
    }
    for (const parentId of ids) {
      db.prepare("DELETE FROM links WHERE task_id = ? AND parent_id = ?").run(taskId, parentId);
      appendEvent(taskId, "unlinked", null, null, actor, { parentId });
    }
    const reason = parentsBlockReason(taskParents(taskId), Date.now(), task);
    if (task.status === "waiting") {
      db.prepare("UPDATE tasks SET hold_reason = ?, updated_at = ? WHERE id = ?").run(reason, new Date().toISOString(), taskId);
      if (reason === null) {
        claimStatus(taskId, "waiting", "ready", actor);
        db.prepare("UPDATE tasks SET unattended_at = NULL WHERE id = ?").run(taskId);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getTask(taskId);
}

function finishRun(taskId: number, endKind: string): void {
  const open = getDb()
    .prepare(`SELECT id, agent_id FROM runs WHERE task_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get(taskId) as { id: number; agent_id: string | null } | undefined;
  if (open) getDb().prepare(`UPDATE runs SET ended_at = ?, end_kind = ? WHERE id = ?`).run(new Date().toISOString(), endKind, open.id);
  if (endKind === "complete") return;
  if (endKind === "accept") {
    revokeTaskWorkerTokens(taskId);
    return;
  }
  revokeAgentToken(open?.agent_id ?? null);
}

function promoteChildren(parentId: number, actor: string): void {
  const rows = getDb().prepare("SELECT task_id FROM links WHERE parent_id = ?").all(parentId) as unknown as Array<{ task_id: number }>;
  for (const row of rows) {
    const child = getTask(row.task_id);
    if (child.status !== "waiting") continue;
    const parents = taskParents(child.id);
    recordMergeCardDependencies(child, parents, actor);
    if (parents.length > 0 && parents.every((item) => parentBlockReason(item, Date.now(), child) === null)) {
      claimStatus(child.id, "waiting", "ready", actor);
    }
  }
}

export interface NudgeClock {
  nowMs?: number;
  graceMs?: number;
  /** How long a streak of progress comments may skip nudges. Omit to read config. */
  progressGraceMs?: number;
  /** Pass null when the agent has no user message yet. Omit to read the agent file. */
  lastUserMessageAt?: string | null;
  /** This turn's Paseo timeline. A still-running sub-agent is not a miss. Finished tool calls are. */
  timeline?: unknown;
  /** Minimum gap between counted nudges. Omit to read config. */
  intervalMs?: number;
}

function runStartedAt(task: TaskRow): string | null {
  if (!task.agent_id) return null;
  const row = getDb()
    .prepare(
      `SELECT started_at FROM runs WHERE task_id = ? AND agent_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(task.id, task.agent_id) as { started_at: string } | undefined;
  return row?.started_at ?? null;
}

function storedUserMessageAt(agentId: string | null): string | null {
  if (!agentId) return null;
  const read = readAgentRecord(agentId);
  return read.state === "ok" ? read.file.lastUserMessageAt : null;
}

/** The first round after open, or a turn that ends inside nudgeGraceMs. */
export function turnIsOpening(taskId: number, lastUserMessageAt?: string | null, nowMs?: number): boolean {
  const clock: NudgeClock = {};
  if (nowMs != null) clock.nowMs = nowMs;
  if (lastUserMessageAt !== undefined) clock.lastUserMessageAt = lastUserMessageAt;
  return openingQuiet(getTask(taskId), clock);
}

/** A just-opened agent has not finished a round yet. Leave the counter alone. */
function openingQuiet(task: TaskRow, clock?: NudgeClock): boolean {
  const nowMs = clock?.nowMs ?? Date.now();
  const graceMs = clock?.graceMs ?? loadConfig().nudgeGraceMs ?? DEFAULT_NUDGE_GRACE_MS;
  const lastUser = clock && "lastUserMessageAt" in clock ? (clock.lastUserMessageAt ?? null) : storedUserMessageAt(task.agent_id);
  return inOpeningGrace(runStartedAt(task), lastUser, nowMs, graceMs);
}

function eventTimes(taskId: number, kind: string, actor: string): string[] {
  const rows = getDb()
    .prepare("SELECT at FROM events WHERE task_id = ? AND kind = ? AND actor = ? ORDER BY id")
    .all(taskId, kind, actor) as Array<{ at: string }>;
  return rows.map((row) => row.at);
}

function latestEventAt(taskId: number, kind: string, actor: string): string | null {
  const row = getDb()
    .prepare("SELECT at FROM events WHERE task_id = ? AND kind = ? AND actor = ? ORDER BY id DESC LIMIT 1")
    .get(taskId, kind, actor) as { at: string } | undefined;
  return row?.at ?? null;
}

/**
 * Executor, batch or reader still running, or any card in review. Batch and reader cards are handed
 * to acceptance (they never open a reviewer); the three-miss block stays only for decision cards.
 */
export function quietHandoffEligible(task: Pick<TaskRow, "status" | "role">): boolean {
  if (task.status === "reviewing") return true;
  return task.status === "running" && (task.role === "executor" || task.role === "batch" || task.role === "reader");
}



function rulingNoted(taskId: number, agentId: string): boolean {
  const rows = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'review_ruling' ORDER BY id DESC`)
    .all(taskId) as unknown as Array<{ data_json: string }>;
  return rows.some((row) => {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: string };
      return data.agentId === agentId;
    } catch {
      return false;
    }
  });
}

/**
 * One nudge already went out and the wait is over.
 * Executors move to in_review. Reviewers stay put and ask the leader to rule.
 * Quota, login, and crash cards are no longer running or reviewing, so they skip.
 */
export function settleQuietHandoff(
  taskId: number,
  input?: { now?: Date; lastText?: string | null; timeline?: unknown; source?: string },
): "auto_completed" | "ruling" | "skip" {
  try {
    const task = getTask(taskId);
    if (!quietHandoffEligible(task) || !task.agent_id) return "skip";
    const raw = (input?.lastText ?? lastAssistantText(input?.timeline) ?? "").trim();
    const lastMessage = raw ? truncateHandoff(raw) : null;
    const at = (input?.now ?? new Date()).toISOString();
    if (task.status === "reviewing") {
      if (rulingNoted(task.id, task.agent_id)) return "skip";
      const shown = lastMessage ?? t("flow.auto.noMessage");
      const detail = t("flow.auto.reviewRuling", { message: shown });
      appendEvent(task.id, "review_ruling", "reviewing", "reviewing", "scheduler", {
        agentId: task.agent_id,
        lastMessage: shown,
        source: input?.source ?? "nudge",
        at,
      });
      addComment(task.id, "scheduler", detail);
      wakeKanbanSupervisor({ taskId: task.id, kind: "review_ruling", detail, subject: task.agent_id });
      return "ruling";
    }
    const submitsReview = taskSubmitsToReview(task);
    if (submitsReview) assertReviewAvailable(task.id);
    // Only work that enters review commits its worktree. Readers and non-Google batch cards save nothing.
    const wip: ReturnType<typeof commitWipSync> =
      submitsReview && task.workspace_path ? commitWipSync(task.workspace_path, task.id) : { committed: false };
    const summary = lastMessage ? `${t("flow.auto.prefix")}\n${lastMessage}` : t("flow.auto.empty");
    const warning = completionWorkspaceWarning(getTask(task.id));
    const handoff = {
      auto: true,
      agentId: task.agent_id,
      lastMessage,
      wipCommitted: wip.committed,
      wipError: wip.error ?? null,
      wipSkipped: wip.skipped ?? null,
    };
    const stored = JSON.stringify({ summary: warning ? `${summary}\n\n${warning}` : summary, handoff });
    let bound: string | null = null;
    let contractError: string | null = null;
    const diagnostics: PrBindingDiagnostics = {};
    try {
      bound = writeContract(rememberPullRequest(task.contract_json, handoff, summary, {
        project: task.project, workspacePath: task.workspace_path, diagnostics,
      }));
    } catch (err) {
      contractError = err instanceof Error ? err.message : String(err);
    }
    const data = {
      summary,
      agentId: task.agent_id,
      lastMessage,
      wipCommitted: wip.committed,
      wipError: wip.error ?? null,
      wipSkipped: wip.skipped ?? null,
      contractError,
      ...diagnostics,
      source: input?.source ?? "nudge",
    };
    const submit = () => {
      if (bound !== null) saveContract(task.id, bound);
      if (!submitsReview) {
        appendEvent(task.id, "auto_complete", "running", "running", "scheduler", data);
        enterAcceptance(task.id, "running", "scheduler", summary, stored);
      } else {
        const next = move(task.id, "running", "in_review", "scheduler", "auto_complete", ", handoff_json = ?", [stored], data);
        addComment(next.id, "scheduler", summary);
        finishRun(next.id, "auto_complete");
      }
      return "auto_completed" as const;
    };
    return submitsReview ? reserveAutomaticReview(task.id, submit) : submit();
  } catch (err) {
    console.error("[paseo-kanban] quiet handoff", err instanceof Error ? err.message : err);
    return "skip";
  }
}

/** This agent wrote progress since the last nudge, and the streak is still inside the grace window. */
function progressQuiet(task: TaskRow, clock?: NudgeClock): boolean {
  if (!task.agent_id) return false;
  const nowMs = clock?.nowMs ?? Date.now();
  const graceMs = clock?.progressGraceMs ?? loadConfig().progressGraceMs ?? DEFAULT_PROGRESS_GRACE_MS;
  return progressCoversTurn(eventTimes(task.id, "comment", task.agent_id), latestEventAt(task.id, "nudge", task.agent_id), nowMs, graceMs);
}

/** The last counted nudge for this agent is still inside nudgeIntervalMs. */
function spacingQuiet(task: TaskRow, clock?: NudgeClock): boolean {
  if (!task.agent_id) return false;
  const nowMs = clock?.nowMs ?? Date.now();
  const intervalMs = clock?.intervalMs ?? loadConfig().nudgeIntervalMs ?? DEFAULT_NUDGE_INTERVAL_MS;
  return withinNudgeInterval(latestEventAt(task.id, "nudge", task.agent_id), nowMs, intervalMs);
}

export function applyNudge(taskId: number, finished: boolean, clock?: NudgeClock): { action: "none" | "remind" | "block" | "handoff" | "ruling"; count: number } {
  const task = getTask(taskId);
  if (task.status !== "running" && task.status !== "reviewing") return { action: "none", count: task.nudge_count ?? 0 };
  // A paused project is not chased: no reminder, no hand-in, no three-miss block.
  if (!finished && isProjectDormant(task.project)) return { action: "none", count: task.nudge_count ?? 0 };
  if (!finished && openingQuiet(task, clock)) return { action: "none", count: task.nudge_count ?? 0 };
  // A readable timeline with no running sub-agent means the agent stopped. A progress comment right
  // before the stop is not a reason to wait: only an unreadable timeline falls back to the grace.
  const blind = !Array.isArray(clock?.timeline);
  const progress = !finished && blind && progressQuiet(task, clock);
  if (!finished && (progress || timelineShowsWork(clock?.timeline))) {
    return { action: "none", count: task.nudge_count ?? 0 };
  }
  if (!finished && spacingQuiet(task, clock)) return { action: "none", count: task.nudge_count ?? 0 };
  if (!finished && quietHandoffEligible(task) && (task.nudge_count ?? 0) >= 1) {
    const outcome = settleQuietHandoff(taskId, {
      now: new Date(clock?.nowMs ?? Date.now()),
      timeline: clock?.timeline,
      source: "nudge",
    });
    if (outcome === "auto_completed") return { action: "handoff", count: task.nudge_count ?? 1 };
    if (outcome === "ruling") return { action: "ruling", count: task.nudge_count ?? 1 };
    return { action: "none", count: task.nudge_count ?? 0 };
  }
  const decision = judgeNudge(task.nudge_count ?? 0, finished, false);
  getDb().prepare("UPDATE tasks SET nudge_count = ? WHERE id = ?").run(decision.count, taskId);
  if (!finished && task.agent_id && (decision.action === "remind" || decision.action === "block")) {
    const at = new Date(clock?.nowMs ?? Date.now()).toISOString();
    appendEvent(taskId, "nudge", null, task.status, task.agent_id, { count: decision.count, action: decision.action }, at);
  }
  if (decision.action === "remind" && decision.count >= 2) {
    wakeKanbanSupervisor({
      taskId,
      kind: "nudge_stuck",
      detail: t("flow.nudge.stuck"),
    });
  }
  if (decision.action === "block") {
    blockTask(taskId, "needs_human", t("flow.nudge.blocked"), "kanban");
  }
  return decision;
}

function storedSummary(task: TaskRow, fallback: string): { summary: string; stored: string } {
  if (!task.handoff_json) return { summary: fallback, stored: JSON.stringify({ summary: fallback, handoff: null }) };
  try {
    const parsed = JSON.parse(task.handoff_json) as { summary?: string };
    const summary = typeof parsed.summary === "string" && parsed.summary ? parsed.summary : fallback;
    return { summary, stored: task.handoff_json };
  } catch {
    return { summary: fallback, stored: task.handoff_json };
  }
}

/** One poll round stops starting gh calls after this long; cards left over are checked next round. */
export const PR_POLL_BUDGET_MS = 30_000;

let pollCursor = 0;

/** Re-check cards waiting on required GitHub checks before they can enter acceptance. */
export async function pollAwaitingPr(budgetMs = PR_POLL_BUDGET_MS): Promise<number[]> {
  const deadline = Date.now() + budgetMs;
  const all = getDb().prepare("SELECT id FROM tasks WHERE status IN ('reviewing', 'running', 'blocked') ORDER BY id").all() as unknown as Array<{ id: number }>;
  // Start after the card the last round stopped on, so a slow card cannot starve the ones behind it.
  const rows = [...all.filter((row) => row.id > pollCursor), ...all.filter((row) => row.id <= pollCursor)];
  const moved: number[] = [];
  for (const row of rows) {
    if (Date.now() > deadline) break;
    await guardCard(row.id, "tick.awaitingPr", async () => {
      const task = getTask(row.id);
      const state = readContract(task.contract_json);
      if (state.kind !== "github" || !state.awaiting) return;
      if (task.status !== "reviewing" && task.status !== "running" && task.status !== "blocked") return;
      if (task.status !== "reviewing" && taskSubmitsToReview(task)) return;
      const behalf = storedOnBehalf(task);
      // Check every direct delegated submission, including cards that returned
      // to running after unblock or were assigned a new run on the same agent.
      // Missing generation evidence from older hand-ins also requires resubmission.
      if (task.status !== "reviewing" && behalf && behalf.generation !== completionGeneration(task)) {
        saveContract(task.id, writeContract({ ...state, awaiting: false }));
        return;
      }
      // Only a leader's explicit submission of this exact blocked state may
      // resume. A later block is a new decision, not a completed CI wait.
      if (task.status === "blocked" && (!COMPLETERS.has(task.role) || !behalf
        || behalf.blockedEventId == null || behalf.blockedEventId !== latestBlockEvent(task.id))) return;
      const linkedApproval = task.status === "reviewing" && task.role === "reviewer" && task.review_of != null ? pendingLinkedApproval(task) : null;
      if (linkedApproval && !linkedApprovalCurrent(task, linkedApproval)) {
        saveContract(task.id, writeContract({ ...state, awaiting: false }));
        addComment(task.id, "scheduler", t("flow.linkedApproval.expired"));
        return;
      }
      const actor = behalf?.actorAgentId ?? "scheduler";
      pollCursor = task.id;
      const verdict = await evaluateContract(state, undefined, { deadline });
      const fresh = getTask(task.id);
      if (fresh.status !== task.status || fresh.agent_id !== task.agent_id
        || fresh.contract_json !== task.contract_json || fresh.handoff_json !== task.handoff_json
        || (task.status === "blocked" && behalf?.blockedEventId !== latestBlockEvent(task.id))
        || (task.status !== "reviewing" && behalf && behalf.generation !== completionGeneration(fresh))) return;
      if (verdict.kind === "pass") {
        saveContract(task.id, writeContract({ ...state, awaiting: false }));
        if (task.status === "reviewing") approveNow(task.id, verdict.summary, "scheduler", linkedApproval);
        else {
          const saved = storedSummary(task, verdict.summary);
          enterAcceptance(task.id, task.status, actor, saved.summary, saved.stored,
            behalf ? { onBehalf: true, actorAgentId: behalf.actorAgentId, note: behalf.note } : {});
        }
        moved.push(task.id);
      } else if (verdict.kind === "fail") {
        if (task.status === "reviewing") returnForChecks(task.id, verdict, "scheduler");
        else holdChecks(task.id, task.status, actor, verdict);
        moved.push(task.id);
      } else if (verdict.kind === "wait" || verdict.kind === "error") {
        setHold(task.id, verdict.summary);
      }
    });
  }
  return moved;
}

export function latestChangeNote(taskId: number): string {
  if (latestReworkKind(taskId) === "leader_rework") {
    const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'leader_rework' ORDER BY id DESC LIMIT 1").get(taskId) as { data_json: string };
    return String(safeParse<{ reason?: unknown }>(event.data_json)?.reason ?? "");
  }
  const row = getDb()
    .prepare("SELECT body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1")
    .get(taskId) as { body: string } | undefined;
  return row?.body ?? "";
}
