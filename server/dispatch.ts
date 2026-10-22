/// <reference types="node" />
import { resolveReviewTarget, reviewFamilyBlock, deliveryRun, authorizeReviewRecovery } from "./review-target";
import { assertReviewStartAvailable } from "./review-assignment";
import { legacyReviewRecoveryHint } from "./review-recovery-hint";
import { BOARD_AGENT_ENV } from "./agent-env";
import { t } from "../shared/i18n";
import { parentsBlockReason, refreshStartBlockReason, taskParents } from "./parents";
import { claimStatus, recordMergeCardDependencies } from "./store";
import { prepareNativeSession, nativeSessionAfterArchive } from "./native-sessions";
import { existsSync, statSync } from "./perf-fs";
import { join } from "node:path";
import { cleanupFinished, nextRetryAt, readCleanupEvents, retryReady } from "./archive-book";
import { archiveInFlight } from "./cleanup";
import { inspectAgentState, type AgentInspector } from "./agent-check";
import { getDb } from "./db";
import { withConfigLock } from "./config-lock";
import { readPolicy } from "./application/policy-snapshot";
import { clearExternalWait } from "./external-wait";
import { confirmEffort, effortCatalogHold, effortForOwnRole, effortReason } from "./effort";
import { loadDispatchMatrix, type MatrixLoad } from "./matrix";
import type { EffortSource, RouteInput } from "./routing";
import { cardMark } from "./card-ref";
import { prepareTaskTmpEnv } from "./card-tmp-record";
import { KanbanError } from "./errors";
import { avoidedPools } from "./failures";
import { AGENT_CREATING, createRecoverAfterMs, findLostCardAgents, type CreatingRecord } from "./lost-agent";
import { agentLiveness } from "./open";
import { appendRejectBrief, conflictReviewNote, latestChangeNote, latestReworkKind, pendingReworkReplacement, recoverStandaloneReview } from "./flow";
import { awaitingLeaderHold } from "./review-hold";
import { agentCwdMissing } from "./missing-cwd";
import { DEFAULT_ARCHIVE_TIMEOUT_MS, loadConfig, projectAlwaysTemp, projectParallel } from "./config";
import { capacityHoldReason } from "./capacity-guard";
import { assertProjectInPaseo } from "./paseo-projects";
import { quotaWaitLabel } from "../shared/blocked";
import { noteQueueHold } from "./queue-hold";
import { onlyRolesBlock, quotaBrief, readPoolSnapshot, type PoolSnapshot, type QuotaBrief } from "./pools";
import { cardRouteContext } from "./profile-rules";
import { actualFamily, buildAgentConfig, findProfile, GOOGLE_DISPATCH_POLICY, isGoogleProfile, readProfiles, type Profile } from "./profiles";
import { currentOccupancy, holdsWorkspace, profilePoolRole, recordedExecutorFacts, routeProfile } from "./routing";
import { latestReworkFeedback, reworkTakeoverNote, type ReworkReassignment } from "./rework-reassign";
import { assertTransition } from "./state";
import { isProjectMain, pickWorkspace, samePath, type ListedWorkspace } from "./placement";
import { acquireStartClaim, alreadyStarting, holdsStartClaim, releaseStartClaim } from "./start-claim";
import { appendEvent, bindPaseoWorkspace, blockTask, getTask, openExecutorRun, requestAgentReleases, setHold, type TaskRow } from "./store";
import { bindTokenAgent, deleteToken, issueToken, revokeOtherRoleTokens } from "./tokens";
import { resolveWorktreeBase, runGit, runGitSync } from "./git";
import { readBranchObserved } from "./branch-observed";
import { readOnlyBranchName } from "./readonly-worktree";
import { reclaimedAgentNote } from "./reclaim-note";
import { laneBinding, placeLane } from "./lane";
import { isTempWorkspace } from "./temp-mark";
import { branchName, freshCopyNote, tempBranchName } from "./workspace";
import { actualWorktreeDirectory, commitWorktree, discardFreshWorktree, readWorktreeCreated, settleRivalRecord, type RivalWorktree } from "./worktree-record";
import { roleLabel, statusLabel, type Status } from "../shared/labels";
import { wakeKanbanSupervisor } from "./wake";
import { cleanupGeneration, trackCleanupWork } from "./cleanup-state";
import { RECREATE_FAILED, recreateReviewCopy, recreateWorkspace, worktreeDirectoryLost } from "./workspace-recreate";
import { PASEO_ARCHIVED, liveWorkspace } from "./paseo-archiving";
import { recordReworkStartup, recoverReworkStartup, workspaceFateReader, type StartupEvidence } from "./lost-workspace";
import { cloudExecutionEnabled, launchCloudTask } from "./cloud-runner";
import { cloudDelivery } from "./cloud-record";

export interface AgentLauncher {
  /** Plugin startup reconciliation must finish before starting or resuming work. */
  beforeStart?(): Promise<void>;
  create(options: {
    cwd: string;
    workspaceId?: string;
    title?: string;
    prompt?: string;
    labels?: Record<string, string>;
    env?: Record<string, string>;
    config: {
      provider: string;
      modeId?: string;
      thinkingOptionId?: string;
      featureValues?: Record<string, unknown>;
    };
  }): Promise<{ id: string; workspaceId?: string | null }>;
  /**
   * Paseo `providers.listModels`. Used only to check that a card's own-role effort
   * is a thinking option of this provider and model. Absent in tests that do not set effort.
   */
  listModels?(provider: string): Promise<{
    models?: Array<{ id: string; aliases?: string[]; thinkingOptions?: Array<{ id: string }> }>;
    error?: string | null;
  }>;
  send(agentId: string, text: string): Promise<void>;
  listWorkspaces?(): Promise<ListedWorkspace[]>;
  createDirectoryWorkspace?(options: { cwd: string }): Promise<{ id: string; directory: string; name: string | null }>;
  createWorktree?(options: {
    cwd: string;
    branchName: string;
    baseBranch: string;
    projectId?: string | null;
    /** Temporary workspace title. Paseo shows this name; the directory stays under its worktrees root. */
    title?: string;
    readOnly?: boolean;
    /** Directory name under Paseo's worktrees root. Omitted means Paseo derives it from the branch. */
    worktreeSlug?: string;
  }): Promise<{ directory: string; workspaceId?: string; name?: string | null; head?: string }>;
  archiveAgent?(agentId: string): Promise<void>;
  /** Live daemon state only; failures throw rather than falling back to a record file. */
  inspectAgent?: AgentInspector;
  archiveWorkspace?(workspaceId: string): Promise<void>;
  listAgents?(workspaceId: string): Promise<Array<{ id: string; archived: boolean }>>;
  inspectWorkspace?(workspaceId: string): Promise<ListedWorkspace | null>;
  /** Full canonical timeline and stopped host agent, used only for a bounded rework startup recovery. */
  inspectStartup?(agentId: string, workspaceId: string): Promise<StartupEvidence | null>;
}

function assertDirectory(path: string | null): string {
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) {
    throw new KanbanError("workspace_missing", t("dispatch.cwdMissingRefuse", { path: path ?? t("dispatch.notFilled") }));
  }
  return path;
}

interface Placement {
  cwd: string;
  workspaceId?: string;
  name?: string | null;
}

interface SavedWorktree {
  directory?: string;
  workspaceId?: string;
  name?: string | null;
}

const startLocks = new Map<number, Promise<void>>();
const startArchives = new Set<string>();

async function withStartLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const previous = startLocks.get(id) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  startLocks.set(id, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (startLocks.get(id) === tail) startLocks.delete(id);
  }
}

function savedWorktree(taskId: number): SavedWorktree | null {
  const saved = readWorktreeCreated(taskId);
  if (!saved) return null;
  return { directory: saved.directory, workspaceId: saved.workspaceId ?? undefined, name: saved.name ?? null };
}

async function dropRival(taskId: number, launcher: AgentLauncher, rival: RivalWorktree, assumeNoAgent: boolean): Promise<void> {
  let result: { archived: boolean; removedBranch: boolean; skipped?: string };
  try {
    result = await discardFreshWorktree({
      taskId,
      directory: rival.directory,
      branch: rival.branch,
      root: rival.root,
      base: rival.base,
      workspaceId: rival.workspaceId,
      readOnly: rival.readOnly,
      head: rival.head,
      assumeNoAgent,
      listAgents: launcher.listAgents,
      archiveWorkspace: launcher.archiveWorkspace,
    });
  } catch (err) {
    result = { archived: false, removedBranch: false, skipped: err instanceof Error ? err.message : String(err) };
  }
  try {
    appendEvent(taskId, "worktree_discarded", null, null, "scheduler", {
      directory: rival.directory,
      branch: rival.branch,
      workspaceId: rival.workspaceId,
      archived: result.archived,
      removedBranch: result.removedBranch,
      ...(result.skipped ? { skipped: result.skipped } : {}),
    });
    settleRivalRecord(taskId, rival.directory, result);
  } catch (err) {
    console.error("[paseo-kanban] worktree_discarded", err instanceof Error ? err.message : err);
  }
}

async function placeDirectory(directory: string, launcher: AgentLauncher): Promise<Placement> {
  if (!launcher.listWorkspaces) return { cwd: directory };
  const picked = pickWorkspace(await launcher.listWorkspaces(), directory);
  if (picked) return { cwd: directory, workspaceId: picked.id, name: picked.name ?? directory };
  if (!launcher.createDirectoryWorkspace) {
    throw new KanbanError("workspace_missing", t("dispatch.noReusableWorkspace", { path: directory }));
  }
  const created = await launcher.createDirectoryWorkspace({ cwd: directory });
  return { cwd: assertDirectory(created.directory), workspaceId: created.id, name: created.name ?? created.directory };
}

async function placeWorktree(
  task: TaskRow,
  launcher: AgentLauncher,
  claimToken: string,
  asTemp?: { base: string; holderId: number | null; actor: string; readOnly?: boolean; ref?: string },
): Promise<Placement | { hold: string }> {
  const saved = savedWorktree(task.id);
  if (saved?.directory && (!asTemp || !samePath(saved.directory, task.workspace_path))) {
    if (worktreeDirectoryLost(saved)) {
      return recreateWorkspace({ task, launcher, claimToken, actor: asTemp?.actor ?? "scheduler", reason: t("dispatch.copyMissing", { path: saved.directory }) });
    }
    const directory = assertDirectory(saved.directory);
    // Paseo may be archiving this workspace (merge auto-archive): no new agent in it until the directory is gone.
    const live = await liveWorkspace({ taskId: task.id, workspaceId: saved.workspaceId, directory, launcher, actor: asTemp?.actor ?? "scheduler" });
    if ("hold" in live) return live;
    if (task.workspace_path && !samePath(task.workspace_path, directory)) {
      getDb().prepare("UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ?").run(directory, new Date().toISOString(), task.id);
    }
    const workspaceId = live.workspaceId;
    if (launcher.listWorkspaces && !workspaceId) {
      throw new KanbanError("workspace_missing", t("dispatch.worktreeNoWorkspace"));
    }
    return { cwd: directory, workspaceId, name: saved.name ?? directory };
  }
  const root = assertDirectory(task.workspace_path);
  if (!launcher.createWorktree) throw new KanbanError("workspace_missing", t("dispatch.noCreateWorktree"));
  const listed = launcher.listWorkspaces ? await launcher.listWorkspaces() : [];
  const main = pickWorkspace(listed, root);
  const temp = Boolean(asTemp) || isTempWorkspace(task.id);
  const code = cardMark(task.id);
  const readOnly = asTemp?.readOnly === true;
  const branch = readOnly ? readOnlyBranchName(task.id) : temp ? tempBranchName(code, task.title) : branchName(task.id, task.title);
  const base = asTemp?.base ?? (task.workspace_base || "main");
  let resolved = asTemp?.ref ? { ref: asTemp.ref } : await resolveWorktreeBase(root, base);
  // An inspection may proceed against the local base when origin is unavailable.
  if (readOnly && "error" in resolved) resolved = { ref: base };
  if ("error" in resolved) throw new KanbanError("fetch_failed", resolved.error);
  const created = await launcher.createWorktree({
    cwd: root,
    branchName: branch,
    baseBranch: resolved.ref,
    projectId: main?.projectId,
    ...(temp ? { title: code } : {}),
    ...(readOnly ? { readOnly: true } : {}),
  });
  const directory = assertDirectory(await actualWorktreeDirectory(root, branch, created.directory));
  if (temp && (samePath(directory, root) || (main && created.workspaceId === main.id))) {
    throw new KanbanError("workspace_missing", t("dispatch.tempIsMain"));
  }
  const head = readOnly ? created.head ?? (await runGit(directory, ["rev-parse", "HEAD"])).stdout.trim() : undefined;
  if (launcher.listWorkspaces && !created.workspaceId) {
    throw new KanbanError("workspace_missing", t("dispatch.noWorkspaceId"));
  }
  const recorded = commitWorktree({
    taskId: task.id,
    token: claimToken,
    directory,
    data: {
      directory,
      branch,
      base,
      ref: resolved.ref,
      root,
      workspaceId: created.workspaceId ?? null,
      name: temp ? code : (created.name ?? null),
      projectId: main?.projectId ?? null,
      ...(temp ? { temp: true } : {}),
      ...(readOnly ? { readOnly: true, head } : {}),
    },
    temp: asTemp ? { base: asTemp.base, actor: asTemp.actor, holderId: asTemp.holderId, code, root, directory } : null,
  });
  if (!recorded.ok) {
    await dropRival(
      task.id,
      launcher,
      { directory, branch, root, base, workspaceId: created.workspaceId ?? null, readOnly, head },
      true,
    );
    throw new KanbanError("start_lost", alreadyStarting());
  }
  for (const intruder of recorded.intruders) await dropRival(task.id, launcher, intruder, false);
  return { cwd: directory, workspaceId: created.workspaceId, name: temp ? code : (created.name ?? directory) };
}

async function ensurePlacement(task: TaskRow, launcher: AgentLauncher, claimToken: string): Promise<Placement | { hold: string }> {
  if (task.workspace_kind === "worktree") return placeWorktree(task, launcher, claimToken);
  if (task.workspace_kind === "lane") return placeLane(task, launcher);
  return placeDirectory(assertDirectory(task.workspace_path), launcher);
}

/** A takeover must use the existing directory, even when the worktree creation event is missing. */
async function reworkPlacement(task: TaskRow, launcher: AgentLauncher, claimToken: string): Promise<Placement | { hold: string }> {
  const saved = task.workspace_kind === "worktree" ? savedWorktree(task.id) : task.workspace_kind === "lane" ? laneBinding(task.id) : null;
  if (task.workspace_kind === "worktree" && worktreeDirectoryLost(saved)) {
    return recreateWorkspace({ task, launcher, claimToken, actor: "scheduler", reason: t("dispatch.reworkCopyMissing", { path: String(saved?.directory) }) });
  }
  const cwd = assertDirectory(saved?.directory ?? task.workspace_path);
  let workspaceId = saved?.workspaceId ?? task.paseo_workspace_id ?? undefined;
  if (task.workspace_kind === "worktree") {
    // Paseo may be archiving this workspace (merge auto-archive): no new agent in it until the directory is gone.
    const live = await liveWorkspace({ taskId: task.id, workspaceId, directory: cwd, launcher, actor: "scheduler" });
    if ("hold" in live) return live;
    if (launcher.listWorkspaces && !live.workspaceId) throw new KanbanError("workspace_missing", t("dispatch.reworkNoWorkspace"));
    workspaceId = live.workspaceId;
  } else if (launcher.listWorkspaces) {
    const picked = pickWorkspace(await launcher.listWorkspaces(), cwd);
    if (!picked) throw new KanbanError("workspace_missing", t("dispatch.reworkNoWorkspace"));
    workspaceId = picked.id;
  }
  return { cwd, workspaceId, name: saved?.name ?? task.paseo_workspace_name ?? cwd };
}

/** Recheck the selected copy, rather than using a later workspace list only to look for main. */
async function refreshStartPlacement(task: TaskRow, placement: Placement, launcher: AgentLauncher, claimToken: string, actor: string,
  listed?: ListedWorkspace[]): Promise<Placement | { hold: string }> {
  const own = readWorktreeCreated(task.id);
  const ownCopy = own && samePath(own.directory, placement.cwd);
  const worktree = task.workspace_kind === "worktree" || ownCopy || listed?.some(entry => entry.id === placement.workspaceId && entry.kind === "worktree");
  if (!worktree) {
    assertDirectory(placement.cwd);
    // Directory registration can lag an active-list response. The missing-record/rebuild rule belongs to recorded worktrees.
    if (!listed?.some(entry => entry.id === placement.workspaceId && entry.archived)) return placement;
  }
  const rebuild = () => recreateWorkspace({ task: getTask(task.id), launcher, claimToken, actor, reason: t("dispatch.reworkCopyMissing", { path: placement.cwd }) });
  if (worktree && (worktreeDirectoryLost({ directory: placement.cwd }) || !existsSync(join(placement.cwd, ".git")))) {
    if (ownCopy) return rebuild();
    if (task.review_of) return recreateReviewCopy({ task: getTask(task.id), original: getTask(task.review_of), lostDirectory: placement.cwd, launcher, claimToken, actor });
    throw new KanbanError("workspace_missing", t("dispatch.cwdMissingNoAgent", { path: placement.cwd }));
  }
  assertDirectory(placement.cwd);
  const live = await liveWorkspace({ taskId: task.id, workspaceId: placement.workspaceId, directory: placement.cwd, launcher, actor, listed });
  // The directory may disappear during the list await. Rebuild now and reread the binding before create.
  if ("hold" in live) {
    if (ownCopy && worktreeDirectoryLost({ directory: placement.cwd })) return rebuild();
    return live;
  }
  return { ...placement, workspaceId: live.workspaceId };
}

/** A late placement that may wait on Paseo's archive (hold), or block when that archive left the directory behind. */
async function placeOrStop(
  id: number,
  actor: string,
  place: () => Promise<Placement | { hold: string }>,
): Promise<Placement | { message: string }> {
  try {
    const placed = await place();
    if (!("hold" in placed)) return placed;
    setHold(id, placed.hold);
    return { message: placed.hold };
  } catch (err) {
    if (!(err instanceof KanbanError) || (err.code !== PASEO_ARCHIVED && err.code !== RECREATE_FAILED)) throw err;
    blockTask(id, "needs_human", err.message, actor);
    return { message: err.message };
  }
}

function rememberPlacement(taskId: number, placement: Placement, actor: string): void {
  if (!placement.workspaceId) return;
  bindPaseoWorkspace(taskId, placement.workspaceId, placement.name?.trim() || placement.cwd, actor);
}

function missingCardWorkspace(task: TaskRow): string | null {
  if (task.workspace_kind === "worktree" || task.workspace_kind === "lane") {
    const saved = task.workspace_kind === "lane" ? laneBinding(task.id) : savedWorktree(task.id);
    // A worktree card rebuilds its own copy at placement time; only lanes are shared and must stay put.
    if (task.workspace_kind === "worktree" && worktreeDirectoryLost(saved)) return null;
    if (saved?.directory && (!existsSync(saved.directory) || !statSync(saved.directory).isDirectory())) {
      return t("dispatch.cwdMissingNoAgent", { path: saved.directory });
    }
    if (saved?.directory) return null;
    if (task.workspace_kind === "lane") {
      if (!task.workspace_path || task.workspace_path === "lane") return null;
      if (!existsSync(task.workspace_path) || !statSync(task.workspace_path).isDirectory()) {
        return t("dispatch.cwdMissingNoAgent", { path: task.workspace_path });
      }
      return null;
    }
    return null;
  }
  if (task.workspace_kind !== "dir") return null;
  const path = task.workspace_path;
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) {
    return t("dispatch.cwdMissingNoAgent", { path: path ?? t("dispatch.notFilled") });
  }
  return null;
}

const FRESH_WORK_ROLES = new Set(["executor", "batch", "reader", "decision"]);

/**
 * Low capacity queues only a brand-new card's first ready→running work start.
 * Review cards, rework (including a reopened ready card), resume of the original
 * agent, and in_review / reviewing progress still start. Holding those too would
 * keep finished work from being reviewed, accepted, and cleaned up.
 */
export function freshStartCapacityReason(task: { id: number; status: string; role: string; executor_agent_id: string | null }): string | null {
  const reason = capacityHoldReason();
  if (!reason || task.status !== "ready" || !FRESH_WORK_ROLES.has(task.role) || task.executor_agent_id) return null;
  if (pendingReworkReplacement(task.id) || latestReworkKind(task.id)) return null;
  const prior = getDb().prepare("SELECT 1 AS ok FROM runs WHERE task_id = ? AND role != 'reviewer' LIMIT 1").get(task.id);
  if (prior) return null;
  return reason;
}

function phaseOf(task: TaskRow): "resume" | "review" | "work" {
  if (task.status === "rework" && task.executor_agent_id) return "resume";
  if (task.status === "rework") return "work";
  if (task.status === "in_review" || (task.role === "reviewer" && (task.status === "ready" || task.status === "draft"))) return "review";
  return "work";
}

function returnPhrase(taskId: number): string {
  if (latestReworkKind(taskId) === "leader_rework") return t("dispatch.return.leaderRework");
  const row = getDb()
    .prepare(`SELECT kind FROM events WHERE task_id = ? AND kind IN ('rejected', 'request_changes') ORDER BY id DESC LIMIT 1`)
    .get(taskId) as { kind: string } | undefined;
  return row?.kind === "rejected" ? t("dispatch.return.leaderRejected") : t("dispatch.return.reviewRejected");
}

/** Error code for a start refused because the card is waiting on the user. The scheduler skips it quietly. */
export const WAITING_USER = "waiting_user";

type OpenedAgent = { id: string; workspaceId?: string | null; recovered?: boolean };

/**
 * agents.create can outlive the caller's socket. After the recover delay, one
 * live record labeled for this card counts as the create result. A later
 * response that names a different agent is archived.
 */
async function openCreatedAgent(
  launcher: AgentLauncher,
  options: Parameters<AgentLauncher["create"]>[0],
  taskId: number,
  role: string,
  actor: string,
  claimedAt: string,
  beforeCreate?: () => void,
): Promise<OpenedAgent> {
  let submitted = false;
  const pending = Promise.resolve().then(() => beforeCreate
    ? withConfigLock(() => { beforeCreate(); submitted = true; return launcher.create(options); })
    : (submitted = true, launcher.create(options)));
  const guarded = pending.then(
    (value) => ({ kind: "rpc" as const, value }),
    (err: unknown) => ({ kind: "error" as const, err }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const recovered = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), createRecoverAfterMs());
  });
  const oneMatch = (): OpenedAgent | null => {
    const found = findLostCardAgents(taskId, role, options.cwd, claimedAt);
    if (found === "unreadable" || found.length !== 1) return null;
    const agent = found[0]!;
    return { id: agent.id, workspaceId: agent.workspaceId, recovered: true };
  };
  // The daemon can finish create about a second after the caller's socket dies.
  const pollMatch = async (): Promise<OpenedAgent | null> => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const found = oneMatch();
      if (found) return found;
    }
    return oneMatch();
  };
  const watchLate = (value: OpenedAgent): OpenedAgent => {
    void guarded.then((late) => {
      if (late.kind !== "rpc" || late.value.id === value.id) return;
      void discardOpenedAgent(taskId, late.value.id, actor, role, t("dispatch.lateCreate"), launcher).catch((err: unknown) => {
        console.error("[paseo-kanban] late create", err instanceof Error ? err.message : err);
      });
    });
    return value;
  };
  try {
    const first = await Promise.race([guarded, recovered]);
    if (first !== "timeout" && first.kind === "rpc") return first.value;
    const found = oneMatch();
    if (first !== "timeout" && first.kind === "error") {
      // Admission refusal never sent a create request; it cannot recover a lost response.
      if (!submitted) throw first.err;
      const settled = found ?? await pollMatch();
      if (settled) return watchLate(settled);
      throw first.err instanceof Error ? first.err : new Error(String(first.err));
    }
    if (found) return watchLate(found);
    const rest = await guarded;
    if (rest.kind === "rpc") return rest.value;
    const again = oneMatch();
    if (again) return watchLate(again);
    throw rest.err instanceof Error ? rest.err : new Error(String(rest.err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { PASEO_ARCHIVE_SETTLE_MS } from "./paseo-archiving";

function claim(id: number, from: Status, to: Status): void {
  assertTransition(from, to);
  const info = getDb()
    .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND wait_decision IS NULL")
    .run(to, new Date().toISOString(), id, from);
  if (info.changes !== 1) {
    const waiting = getTask(id).wait_decision;
    if (waiting) throw new KanbanError(WAITING_USER, t("dispatch.waitingUser", { decision: waiting }), { id });
    throw new KanbanError("conflict", t("dispatch.startedByOther", { card: cardMark(id) }), { id, from, to });
  }
  if (to === "running") clearExternalWait(id);
}

/** Undo our own claim. If someone else already moved the card on, leave their status alone. */
function revert(id: number, status: Status, claimed: Status, claimToken?: string): void {
  getDb()
    .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?
      ${claimToken ? "AND EXISTS (SELECT 1 FROM start_claims WHERE task_id = tasks.id AND token = ?)" : ""}`)
    .run(status, new Date().toISOString(), id, claimed, ...(claimToken ? [claimToken] : []));
}

/** The card left the status we claimed while the agent was being opened, so this start does not count. */
function lostClaim(id: number, claimed: Status): KanbanError {
  const now = getTask(id).status;
  return new KanbanError("conflict", t("dispatch.lostClaim", { card: cardMark(id), status: statusLabel(now) }), { id, claimed, now });
}

/** Bound the discard archive so a hung Paseo call cannot hold the start lock. */
function archiveWithTimeout(taskId: number, agentId: string, archive: (id: string) => Promise<void>): Promise<"ok" | "timeout" | { error: string }> {
  const ms = loadConfig().archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS;
  let timedOut = false;
  startArchives.add(agentId);
  const job = Promise.resolve().then(() => archive(agentId));
  trackCleanupWork(taskId, job);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, ms);
    job.then(
      () => {
        startArchives.delete(agentId);
        clearTimeout(timer);
        if (!timedOut) resolve("ok");
      },
      (err: unknown) => {
        startArchives.delete(agentId);
        clearTimeout(timer);
        if (timedOut) return;
        resolve({ error: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}

/**
 * The agent exists, but this start does not count. Archive it immediately.
 * Paseo archive interrupts a running agent and drops it from the active list.
 *
 * Lane and temporary workspaces are not collected here. Both are recorded
 * before the agent is created. A lane is shared, so archiving it would take
 * other cards with it. A temporary worktree stays when the card is still open,
 * so the next start can reuse it. When the card is already archived or done,
 * cleanup owns that workspace; this path only stops the agent that appeared
 * after that cleanup ran.
 */
async function discardOpenedAgent(
  taskId: number,
  agentId: string,
  actor: string,
  role: string,
  reason: string,
  launcher: AgentLauncher,
): Promise<boolean> {
  const boundary = cleanupGeneration(taskId);
  rememberOpenedAgent(taskId, agentId, actor);
  await prepareNativeSession(taskId, agentId);
  let archived = false;
  let error: string | undefined;
  let outcome: "timeout" | "error" | undefined;
  if (!launcher.archiveAgent) {
    error = t("dispatch.noArchive");
    outcome = "error";
  } else {
    const result = await archiveWithTimeout(taskId, agentId, (id) => launcher.archiveAgent!(id));
    if (result === "ok") archived = true;
    else if (result === "timeout") {
      error = t("dispatch.timeout");
      outcome = "timeout";
    } else {
      error = result.error;
      outcome = "error";
    }
  }
  try {
    appendEvent(taskId, "agent_discarded", null, null, actor, {
      agentId,
      reason,
      archived,
      ...(error ? { error } : {}),
    });
  } catch (err) {
    console.error("[paseo-kanban] agent_discarded", err instanceof Error ? err.message : err);
  }
  if (archived) {
    try {
      appendEvent(taskId, "cleanup", null, null, "kanban", {
        action: "archive_agent",
        cleanupGeneration: boundary,
        agentId,
        ok: true,
        reason: t("dispatch.archivedAfterFailedStart"),
      });
    } catch (err) {
      console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
    }
    nativeSessionAfterArchive(taskId, agentId);
    return true;
  }
  // A real archive attempt backs off before the next try. Skipping the attempt
  // (no archive method) must not delay cleanup: the opened-agent event is enough
  // for a card that is not finished cleaning. A card whose cleanup already
  // finished needs the failure row, or nothing will retry it.
  const current = getTask(taskId);
  const closed = current.status === "done" || current.status === "archived";
  if (launcher.archiveAgent || (closed && cleanupFinished(taskId))) {
    try {
      const events = readCleanupEvents(taskId);
      appendEvent(taskId, "cleanup", null, null, "kanban", {
        action: "archive_agent",
        cleanupGeneration: boundary,
        agentId,
        ok: false,
        outcome: outcome ?? "error",
        error: error ?? t("dispatch.archiveFailed"),
        retryAt: nextRetryAt(events, "archive_agent", agentId, new Date()),
      });
    } catch (err) {
      console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
    }
  }
  try {
    requestAgentReleases(taskId, [{ agentId, role: role === "reviewer" ? "reviewer" : "executor" }]);
  } catch (err) {
    console.error("[paseo-kanban] cleanup", err instanceof Error ? err.message : err);
  }
  return false;
}

/** Retire the old writer before creating its replacement, with the same retry bookkeeping as a failed start. */
async function retireReworkExecutor(taskId: number, reassign: ReworkReassignment, actor: string, launcher: AgentLauncher): Promise<boolean> {
  if (!reassign.oldAgentId) return true;
  let archived: boolean;
  if (reassign.oldAgentState === "missing" || reassign.oldAgentState === "archived") {
    appendEvent(taskId, "cleanup", null, null, "kanban", {
      action: "archive_agent", agentId: reassign.oldAgentId, ok: true, reason: t("dispatch.reworkTakeoverGone"),
    });
    archived = true;
  } else {
    if (startArchives.has(reassign.oldAgentId) || archiveInFlight("agent", reassign.oldAgentId) ||
      !retryReady(readCleanupEvents(taskId), "archive_agent", reassign.oldAgentId, new Date(reassign.evaluatedAt))) return false;
    archived = await discardOpenedAgent(taskId, reassign.oldAgentId, actor, "executor", t("dispatch.reworkReassign", { reason: reassign.reason }), launcher);
  }
  // This mark also prevents a failed create or a recovering pool from resuming the retired writer.
  requestAgentReleases(taskId, [{ agentId: reassign.oldAgentId, role: "executor" }]);
  return archived;
}

/** A file miss can reclaim a live writer. Never create its replacement before retiring it. */
async function retireReclaimedAgents(taskId: number, role: string, actor: string, launcher: AgentLauncher): Promise<boolean> {
  const rows = getDb().prepare(
    "SELECT DISTINCT agent_id FROM runs WHERE task_id = ? AND role = ? AND end_kind = 'reclaimed' AND agent_id IS NOT NULL",
  ).all(taskId, role) as Array<{ agent_id: string }>;
  for (const { agent_id: agentId } of rows) {
    // Lightweight launchers without a daemon adapter retain the record check.
    // The production launcher always has inspectAgent; an API failure there
    // archives conservatively instead of treating the missing file as proof.
    const state = launcher.inspectAgent
      ? await inspectAgentState(agentId, launcher.inspectAgent)
      : agentLiveness(agentId);
    if (state === "missing" || state === "archived") continue;
    if (startArchives.has(agentId) || archiveInFlight("agent", agentId) ||
      !retryReady(readCleanupEvents(taskId), "archive_agent", agentId, new Date())) return false;
    const archived = await discardOpenedAgent(taskId, agentId, actor, role, t("dispatch.reclaimed", { state }), launcher);
    if (!archived) return false;
  }
  return true;
}

function rememberOpenedAgent(taskId: number, agentId: string, actor: string): void {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'agent_opened'").all(taskId) as unknown as Array<{
    data_json: string;
  }>;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: string };
      if (data.agentId === agentId) return;
    } catch {
      // keep looking
    }
  }
  try {
    appendEvent(taskId, "agent_opened", null, null, actor, { agentId });
  } catch (err) {
    console.error("[paseo-kanban] agent_opened", err instanceof Error ? err.message : err);
  }
}

function parentsHandoff(taskId: number): string {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.title, t.handoff_json FROM links l JOIN tasks t ON t.id = l.parent_id WHERE l.task_id = ? ORDER BY t.id`,
    )
    .all(taskId) as unknown as Array<{ id: number; title: string; handoff_json: string | null }>;
  if (rows.length === 0) return "";
  return rows.map((row) => `${cardMark(row.id)} ${row.title}\n${row.handoff_json ?? t("dispatch.noHandoff")}`).join("\n\n");
}

function commentText(taskId: number): string {
  const rows = getDb().prepare("SELECT author, body FROM comments WHERE task_id = ? ORDER BY id").all(taskId) as unknown as Array<{
    author: string;
    body: string;
  }>;
  if (rows.length === 0) return "";
  return rows.map((row) => `${row.author}: ${row.body}`).join("\n");
}

function previousAgentNote(task: TaskRow, nextProfile: string): string {
  const prior = getDb()
    .prepare(
      `SELECT profile_name, end_kind FROM runs WHERE task_id = ? AND ended_at IS NOT NULL AND profile_name IS NOT NULL AND profile_name != ? ORDER BY id DESC LIMIT 1`,
    )
    .get(task.id, nextProfile) as { profile_name: string; end_kind: string | null } | undefined;
  if (!prior) return "";
  const event = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'requeued' ORDER BY id DESC LIMIT 1")
    .get(task.id) as { data_json: string } | undefined;
  let why = "";
  if (event) {
    try {
      const data = JSON.parse(event.data_json) as { message?: string; kind?: string };
      why = data.message || data.kind || "";
    } catch {
      why = "";
    }
  }
  const lines = [t("dispatch.prev.profile", { profile: prior.profile_name }), t("dispatch.prev.ended", { kind: prior.end_kind ?? t("dispatch.notRecorded") })];
  if (why) lines.push(t("dispatch.prev.reason", { reason: why }));
  if (task.handoff_json) lines.push(t("dispatch.prev.handoff", { handoff: task.handoff_json }));
  return t("dispatch.prev.heading", { lines: lines.join("\n") });
}

function openingPrompt(profile: Profile, task: TaskRow, role: string, reassignment?: ReworkReassignment): string {
  const parts: string[] = [];
  if (profile.notes) parts.push(profile.notes);
  if (!holdsWorkspace(role)) parts.push(t("dispatch.prompt.readOnly"));
  const replacement = pendingReworkReplacement(task.id);
  const fresh = task.status !== "rework" && !replacement && isTempWorkspace(task.id) && holdsWorkspace(role) ? `\n\n${freshCopyNote()}` : "";
  parts.push(t("dispatch.prompt.brief", { brief: `${task.brief || t("dispatch.prompt.noBrief")}${fresh}` }));
  if (reassignment) {
    const takeover = t("dispatch.prompt.takeover", { note: reworkTakeoverNote(), profile: reassignment.oldProfile ?? t("dispatch.notRecorded") });
    parts.push(`${takeover}\n${t("dispatch.prompt.takeoverReason", { reason: reassignment.reason })}`);
    parts.push(t("dispatch.prompt.lastReview", { feedback: latestReworkFeedback(task.id) || t("dispatch.prompt.readReview") }));
    if (task.handoff_json) parts.push(t("dispatch.prompt.lastHandoff", { handoff: task.handoff_json }));
  }
  if (replacement) {
    parts.push(t("dispatch.prompt.takeover", { note: reworkTakeoverNote(), profile: replacement.oldProfile ?? t("dispatch.notRecorded") }));
    if (task.handoff_json) parts.push(t("dispatch.prompt.lastHandoff", { handoff: task.handoff_json }));
  }
  const prior = previousAgentNote(task, profile.name);
  if (prior) parts.push(prior);
  const reclaimed = reclaimedAgentNote(task.id, role);
  if (reclaimed) parts.push(reclaimed);
  const handoff = parentsHandoff(task.id);
  if (handoff) parts.push(t("dispatch.prompt.parentsHandoff", { handoff }));
  const comments = commentText(task.id);
  if (comments) parts.push(t("dispatch.prompt.comments", { comments }));
  if (role === "reviewer") {
    const target = resolveReviewTarget(task, true);
    if (target?.ok && target.authorization) {
      const a = target.authorization;
      parts.push(t("reviewRecovery.prompt", { card: target.card, leader: a.authorizedBy, profile: a.profileName, provider: a.provider, model: a.model, reason: a.reason }));
    }
    const submission = getDb().prepare(
      "SELECT kind FROM events WHERE task_id = ? AND kind IN ('complete', 'auto_complete') ORDER BY id DESC LIMIT 1",
    ).get(task.review_of ?? task.id) as { kind: string } | undefined;
    if (submission?.kind === "auto_complete") {
      parts.push(t("dispatch.prompt.autoComplete"));
    }
    const conflict = conflictReviewNote(task.id);
    if (conflict) parts.push(t("dispatch.prompt.conflict", { note: conflict }));
  }
  const finish = role === "reviewer" ? t("dispatch.prompt.finishReviewer") : role === "supervisor" ? "kanban_accept" : "kanban_complete";
  parts.push(t("dispatch.prompt.footer", { card: cardMark(task.id), role: roleLabel(role), round: task.review_round, finish }));
  return parts.join("\n\n");
}

/** Another running card that may change files in this directory. Reviewers and readers do not count. */
function directoryHolder(task: TaskRow, role: string): { id: number; title: string } | null {
  if (task.workspace_kind !== "dir" || !task.workspace_path || !holdsWorkspace(role)) return null;
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.title, t.workspace_path, t.role AS task_role, r.role
       FROM tasks t
       LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE task_id = t.id ORDER BY id DESC LIMIT 1)
       WHERE t.status = 'running' AND t.workspace_kind = 'dir' AND t.id != ?`,
    )
    .all(task.id) as unknown as Array<{ id: number; title: string; workspace_path: string | null; task_role: string; role: string | null }>;
  for (const row of rows) {
    const who = row.role ?? row.task_role;
    if (!holdsWorkspace(who)) continue;
    if (!samePath(row.workspace_path, task.workspace_path)) continue;
    return { id: row.id, title: row.title };
  }
  return null;
}

/**
 * Open a temporary worktree instead of working in the main directory.
 * The busy-directory path runs when parallel is on and someone else already holds the directory.
 * alwaysTemp uses that same path even when the directory is free: the main checkout may be the
 * live CLI, and a half-written file there breaks every agent's command. Nothing is written here.
 * The mark is stored only after the worktree exists.
 * A rework card stays on its current directory so a new executor can see the earlier commits.
 */
function tempDiversion(task: TaskRow, role: string): { base: string; holderId: number | null } | null {
  if (pendingReworkReplacement(task.id)) return null;
  if (task.status === "rework") return null;
  if (task.status === "ready" && latestReworkKind(task.id) === "leader_rework") return null;
  if (!holdsWorkspace(role) || task.workspace_kind !== "dir" || !task.workspace_path) return null;
  const always = projectAlwaysTemp(task.project);
  const holder = directoryHolder(task, role);
  if (!always && (!projectParallel(task.project) || !holder)) return null;
  const base = loadConfig().projects?.[task.project]?.baseBranch || "main";
  return { base: base.trim() || "main", holderId: holder?.id ?? null };
}

/** Borrow a reviewed temporary copy. Directory cards need their own inspection snapshot. */
function reviewedPlacement(task: TaskRow, allowDirectory = false): Placement | null {
  if (task.role !== "reviewer" || !task.review_of) return null;
  let original: TaskRow;
  try {
    original = getTask(task.review_of);
  } catch {
    return null;
  }
  if (!original.workspace_path || (original.workspace_kind === "dir" && !allowDirectory)) return null;
  return {
    cwd: original.workspace_path,
    workspaceId: original.paseo_workspace_id ?? undefined,
    name: original.paseo_workspace_name ?? original.workspace_path,
  };
}

function reviewSource(task: TaskRow): TaskRow | null {
  if (!task.review_of) return null;
  try { return getTask(task.review_of); } catch { return null; }
}

function submissionRef(task: TaskRow, preferCurrent = false): string | undefined {
  const observed = readBranchObserved(task.id);
  const submitted = observed?.head && /^[0-9a-f]{40,64}$/i.test(observed.head) ? observed.head : undefined;
  if (submitted && !preferCurrent) return submitted;
  if (!task.workspace_path) return undefined;
  const head = runGitSync(task.workspace_path, ["rev-parse", "HEAD"]);
  return head.code === 0 && /^[0-9a-f]{40,64}$/i.test(head.stdout.trim()) ? head.stdout.trim() : submitted;
}

/** True when this start is overriding a card that already holds the directory. */
function assertDirectoryFree(task: TaskRow, role: string, force: boolean): boolean {
  const holder = directoryHolder(task, role);
  if (!holder) return false;
  if (!force) throw new KanbanError("conflict", t("dispatch.sameWorkspaceBusy", { card: cardMark(holder.id), title: holder.title }));
  return true;
}

export async function startTask(
  id: number,
  launcher: AgentLauncher,
  actor: string,
  options?: {
    profiles?: Profile[];
    chosen?: Profile;
    reason?: string;
    force?: boolean;
    /** Explicit leader-only recovery for missing historical execution models. */
    reviewRecovery?: { profile: string; reason: string; leaderAgentId?: string | null };
    /** Depth chosen by matrix routing. Missing means use the card-or-profile rule from #71. */
    effort?: string | null;
    effortSource?: EffortSource;
    allowDowngrade?: boolean;
    /** Exact roster, matrix, quota and scope context selected by this tick. */
    routing?: RouteInput;
    /** Snapshot this start actually routed with. Omitted means the event records nulls. */
    snapshot?: PoolSnapshot | null;
    matrixGeneratedAt?: string | null;
    /** Trusted dependency readers for explicit compatibility fixtures; not public command input. */
    readMatrix?: () => MatrixLoad;
    readSnapshot?: () => PoolSnapshot;
    /** Scheduler-approved takeover after the old executor's wait threshold. */
    reworkReassign?: ReworkReassignment;
  },
): Promise<{ message: string; agentId?: string }> {
  await launcher.beforeStart?.();
  return withStartLock(id, async () => {
  let task = getTask(id);
  assertProjectInPaseo(task.project);
  if (task.status === "waiting") {
    const parents = taskParents(id);
    recordMergeCardDependencies(task, parents, actor);
    const blocked = parents.length > 0 && parentsBlockReason(parents, Date.now(), task) !== null
      ? await refreshStartBlockReason(parents, task)
      : parents.length > 0 ? null : t("dispatch.parentsNotDone");
    // The refresh awaited gh; a background check may have released the card meanwhile.
    task = getTask(id);
    if (task.status === "waiting") {
      if (blocked !== null) throw new KanbanError("not_ready", t("dispatch.cannotStart", { reason: blocked }));
      try {
        task = claimStatus(id, "waiting", "ready", actor);
      } catch (err) {
        if (!(err instanceof KanbanError) || err.code !== "conflict") throw err;
        task = getTask(id);
      }
    }
  }
  if (task.status === "blocked" && !options?.reviewRecovery) throw new KanbanError("blocked", [t("dispatch.blocked"), legacyReviewRecoveryHint(task)].filter(Boolean).join("\n\n"));
  if (task.status === "running" || task.status === "reviewing") throw new KanbanError("conflict", `${t("dispatch.inProgress")} ${cardMark(id)}`);
  if (task.status === "done" || task.status === "archived") throw new KanbanError("illegal_transition", t("dispatch.finished"));
  if (task.status === "acceptance") assertTransition(task.status, "running");
  if (task.wait_decision) throw new KanbanError(WAITING_USER, t("dispatch.waitingUser", { decision: task.wait_decision }));
  if (task.status === "rework" && awaitingLeaderHold(id)) throw new KanbanError("not_ready", t("dispatch.awaitingLeader"));
  if (task.status === "rework" && task.role === "reviewer" && !task.executor_agent_id && !task.review_of) {
    const handed = recoverStandaloneReview(id, actor);
    if (handed || getTask(id).status === "acceptance") return { message: t("dispatch.reviewHanded", { card: cardMark(id) }) };
  }
  const claimToken = acquireStartClaim(id);
  if (!claimToken) return { message: alreadyStarting() };
  try {
  task = getTask(id);
  if (options?.reviewRecovery) {
    const recovery = options.reviewRecovery;
    task = authorizeReviewRecovery(id, recovery.profile, recovery.reason, options.profiles ?? readProfiles(), actor, recovery.leaderAgentId);
  }
  if (task.status === "running" || task.status === "reviewing") throw new KanbanError("conflict", `${t("dispatch.inProgress")} ${cardMark(id)}`);
  if (task.status === "done" || task.status === "archived") throw new KanbanError("illegal_transition", t("dispatch.finished"));
  if (task.status === "blocked") throw new KanbanError("blocked", [t("dispatch.blocked"), legacyReviewRecoveryHint(task)].filter(Boolean).join("\n\n"));
  if (task.status === "waiting") throw new KanbanError("not_ready", t("dispatch.parentsNotDoneStart"));
  if (task.wait_decision) throw new KanbanError(WAITING_USER, t("dispatch.waitingUser", { decision: task.wait_decision }));
  if (task.status === "rework" && awaitingLeaderHold(id)) throw new KanbanError("not_ready", t("dispatch.awaitingLeader"));
  if (task.status === "ready") {
    const startupRecovery = await recoverReworkStartup(task, launcher, { actor, claimToken });
    if (startupRecovery !== "unhandled") return { message: getTask(id).hold_reason ?? alreadyStarting() };
    task = getTask(id);
    if (task.status !== "ready") throw new KanbanError("start_lost", alreadyStarting());
  }
  const capacity = freshStartCapacityReason(task);
  if (capacity) throw new KanbanError("not_ready", capacity);
  if (cloudExecutionEnabled(task)) {
    const profiles = options?.profiles ?? readProfiles();
    const settings = loadConfig();
    const matrix = options?.readMatrix?.() ?? loadDispatchMatrix();
    const snapshot = options?.snapshot ?? options?.readSnapshot?.() ?? readPoolSnapshot();
    const occupancy = currentOccupancy(profiles);
    const input: RouteInput = {
      ...options?.routing, profiles, role: "executor", review: false,
      profileOverride: options?.chosen?.id ?? task.profile_override,
      byPool: occupancy.byPool, poolLimits: settings.concurrency.pools, snapshot,
      matrix: matrix.state === "ok" ? matrix.matrix : null,
      tier: task.tier, cardEffort: effortForOwnRole(task, false),
      ...cardRouteContext(task, settings.profileRules),
    };
    const decision = routeProfile(input);
    if (!decision.ok) {
      if (decision.action === "block" && decision.kind !== "quota") blockTask(id, decision.kind, decision.reason, actor);
      else setHold(id, decision.reason);
      return { message: decision.reason };
    }
    const effort = options?.effortSource ? options.effort ?? decision.profile.thinkingOptionId ?? null
      : decision.effort ?? task.effort ?? decision.profile.thinkingOptionId ?? null;
    return await launchCloudTask({ task, profile: decision.profile, profiles, effort, guard: () => {
      if (!holdsStartClaim(id, claimToken) || getTask(id).status !== task.status) throw new KanbanError("start_lost", alreadyStarting());
      const stamp = snapshot.policy;
      if (stamp) {
        const policy = readPolicy();
        if (policy.state !== "ok" || policy.snapshot.revision !== stamp.revision || policy.snapshot.policyDigest !== stamp.digest) throw new KanbanError("policy_changed", t("dispatch.policyChanged"));
      }
    } });
  }
  // Cloud implementations are artifacts in a bare mirror. Local reviewers inspect
  // a disposable copy at the submitted commit, never the mirror's default HEAD.
  const cloudSource = (task.status === "in_review" || task.role === "reviewer") ? cloudDelivery(task.review_of ?? task.id) : null;
  const cloudCopy = cloudSource ? readWorktreeCreated(task.id) : null;
  if (cloudSource && cloudCopy?.directory && cloudCopy.head !== cloudSource.head) {
    await dropRival(id, launcher, { directory: cloudCopy.directory, branch: cloudCopy.branch ?? "", root: cloudCopy.root ?? cloudSource.mirror,
      base: cloudCopy.base ?? cloudSource.base, workspaceId: cloudCopy.workspaceId ?? null, readOnly: cloudCopy.readOnly, head: cloudCopy.head }, false);
    if (readWorktreeCreated(id)) {
      const reason = t("cloud.reviewCleanup");
      setHold(id, reason); return { message: reason };
    }
  }
  if (cloudSource && !readWorktreeCreated(task.id)) {
    await placeWorktree({ ...task, workspace_path: cloudSource.mirror, workspace_kind: "dir" }, launcher, claimToken,
      { base: cloudSource.base, holderId: null, actor, readOnly: true, ref: cloudSource.head });
    task = getTask(id);
  }
  const allowMain = options?.force === true || !projectAlwaysTemp(task.project);
  const reviewedEarly = task.role === "reviewer" ? reviewedPlacement(task, allowMain) : null;
  const missingWorkspace = reviewedEarly ? null : missingCardWorkspace(task);
  if (missingWorkspace) {
    blockTask(id, "capability", missingWorkspace, actor);
    return { message: missingWorkspace };
  }
  const reassignment = options?.reworkReassign;
  if (reassignment && (task.status !== "rework" || task.executor_agent_id !== reassignment.expectedExecutorAgentId ||
    (task.executor_profile && task.executor_profile !== reassignment.oldProfile))) {
    throw new KanbanError("conflict", t("dispatch.reassignChanged"));
  }
  let phase = reassignment ? "work" : phaseOf(task);
  const lostCopy = task.workspace_kind === "worktree" ? savedWorktree(id) : null;
  const lostDirectory = worktreeDirectoryLost(lostCopy) ? lostCopy?.directory : undefined;
  if (phase === "resume" && task.executor_agent_id && (agentCwdMissing(task.executor_agent_id) || lostDirectory)) {
    const cwd = agentCwdMissing(task.executor_agent_id) ?? lostDirectory ?? "";
    appendRejectBrief(getTask(id), latestChangeNote(id) || t("dispatch.executorCwdMissing", { path: cwd }));
    getDb().prepare("UPDATE tasks SET agent_id = NULL, executor_agent_id = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    // The card forgets this executor, so queue it for the normal archive flow; otherwise it idles forever.
    requestAgentReleases(id, [{ agentId: task.executor_agent_id, role: "executor" }]);
    appendEvent(id, "wake_skipped_missing_cwd", "rework", "rework", actor, { agentId: task.executor_agent_id, cwd, kind: "resume" });
    task = getTask(id);
    phase = phaseOf(task);
  }
  let reviewed = phase === "review" || task.role === "reviewer" ? reviewedPlacement(getTask(id), allowMain) : null;
  // Same rule as the card's own copy: a checkout with .git is live even if it tracks a placeholder-named file.
  // The review card's own workspace_path may be that same path; a lost directory still gets a read-only copy.
  const lostBorrowed = reviewed && task.review_of && worktreeDirectoryLost({ directory: reviewed.cwd }) ? reviewed.cwd : null;
  const source = reviewSource(task);
  const initialRole = phase === "review" ? "reviewer" : task.role;
  assertReviewStartAvailable(getTask(id), initialRole === "reviewer");
  const sourceDirectory = source?.workspace_kind === "dir" ? source.workspace_path : task.workspace_path;
  const needsInspection = !reviewed && !holdsWorkspace(initialRole) &&
    task.workspace_kind === "dir" && projectAlwaysTemp(task.project) && options?.force !== true;
  let placed: Placement | { hold: string };
  try {
    if (reviewed && lostBorrowed) {
      reviewed = await recreateReviewCopy({ task, original: getTask(task.review_of!), lostDirectory: lostBorrowed, launcher, claimToken, actor });
    } else if (reviewed && source?.workspace_kind === "worktree") {
      // The borrowed copy may be the one Paseo is archiving; wait, then the lost-directory path builds a read-only copy.
      const live = await liveWorkspace({ taskId: id, workspaceId: reviewed.workspaceId, directory: reviewed.cwd, launcher, actor });
      if ("hold" in live) {
        setHold(id, live.hold);
        return { message: live.hold };
      }
      // A record that moved to another live id at the same path: the reviewer goes there, not to the archived id.
      reviewed = { ...reviewed, workspaceId: live.workspaceId };
    }
    placed = needsInspection
    ? await placeWorktree({ ...task, workspace_path: sourceDirectory }, launcher, claimToken, {
        base: loadConfig().projects?.[task.project]?.baseBranch || "main", holderId: null, actor,
        // Inline reviews belong to the executor card's lifecycle. Move that whole
        // card onto an execution copy, so a later rework keeps the submitted commits.
        readOnly: !holdsWorkspace(task.role),
        ...((source || (phase === "review" && task.role !== "reviewer")) ? { ref: submissionRef(source ?? task) } : {}),
      })
    : reviewed ?? (reassignment || pendingReworkReplacement(task.id) ? await reworkPlacement(task, launcher, claimToken) : await ensurePlacement(getTask(id), launcher, claimToken));
  } catch (err) {
    if (err instanceof KanbanError && err.code === PASEO_ARCHIVED) {
      blockTask(id, "needs_human", err.message, actor);
      return { message: err.message };
    }
    if (!(err instanceof KanbanError) || err.code !== RECREATE_FAILED) throw err;
    const reason = t("dispatch.tempLost", { path: savedWorktree(id)?.directory ?? lostBorrowed ?? t("dispatch.notRecorded"), error: err.message });
    blockTask(id, "needs_human", reason, actor);
    return { message: reason };
  }
  if ("hold" in placed) {
    setHold(id, placed.hold);
    return { message: placed.hold };
  }
  let placement = placed;
  rememberPlacement(id, placement, actor);
  task = getTask(id);
  let cwd = placement.cwd;
  if (!existsSync(cwd)) {
    const reason = t("dispatch.cwdMissingNoAgent", { path: cwd });
    blockTask(id, "capability", reason, actor);
    return { message: reason };
  }
  if (phase === "resume") {
    if (!task.executor_agent_id) throw new KanbanError("missing_agent", t("dispatch.noExecutorAgent"));
    // Resume checks this card's own worker, including standalone reviewers. Automatic review
    // routing separately resolves the target delivery and must not supply its run here.
    const resumedRun = deliveryRun(task);
    const facts = resumedRun ? { executorProvider: resumedRun.provider, executorModel: resumedRun.model } : {};
    const supplied = options?.profiles?.find(p => p.name === task.executor_profile);
    if (task.executor_family === "google" || (facts.executorProvider && isGoogleProfile({ provider: facts.executorProvider, model: facts.executorModel ?? undefined })) || (supplied && isGoogleProfile(supplied))) {
      const opened = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started' AND json_extract(data_json, '$.agentId') = ? ORDER BY id DESC LIMIT 1").get(id, task.executor_agent_id) as { data_json: string } | undefined;
      if (!opened || JSON.parse(opened.data_json).googleDispatchPolicy !== GOOGLE_DISPATCH_POLICY) {
        setHold(id, t("routing.google.profile"));
        return { message: t("routing.google.profile") };
      }
      const profiles = options?.profiles ?? readProfiles();
      const previous = task.executor_profile ? findProfile(profiles, task.executor_profile) : undefined;
      if (!previous || (facts.executorProvider && (previous.provider !== facts.executorProvider || previous.model !== facts.executorModel))) {
        setHold(id, t("routing.google.profile"));
        return { message: t("routing.google.profile") };
      }
      const matrix = options?.readMatrix?.() ?? loadDispatchMatrix();
      const checked = routeProfile({ profiles, role: task.role, review: false, profileOverride: previous.id,
        tier: task.tier, ...cardRouteContext(task, loadConfig().profileRules), byPool: currentOccupancy(profiles).byPool,
        poolLimits: loadConfig().concurrency.pools, snapshot: options?.snapshot ?? options?.readSnapshot?.() ?? readPoolSnapshot(),
        matrix: matrix.state === "ok" ? matrix.matrix : null });
      if (!checked.ok) { setHold(id, checked.reason); return { message: checked.reason }; }
    }
    const resumedTarget = resolveReviewTarget(getTask(id), task.role === "reviewer");
    if (task.role === "reviewer" && task.review_of != null) {
      const target = resumedTarget;
      const run = deliveryRun(task);
      const why = reviewFamilyBlock(run?.agent_id === task.executor_agent_id ? run : {}, target);
      if (why) {
        blockTask(id, "needs_human", why, actor);
        return { message: why };
      }
      appendEvent(id, "review_target_checked", null, null, actor, { reviewTarget: target, reviewerRunId: run?.id ?? null, path: "resume" });
    }
    assertReviewStartAvailable(getTask(id), task.role === "reviewer");
    claim(id, "rework", "running");
    getDb().prepare("UPDATE tasks SET agent_id = ?, nudge_count = 0 WHERE id = ?").run(task.executor_agent_id, id);
    let forced = false;
    try {
      forced = assertDirectoryFree(getTask(id), task.role, options?.force === true);
    } catch (err) {
      revert(id, "rework", "running", claimToken);
      throw err;
    }
    const note = latestChangeNote(id);
    const intro =
      latestReworkKind(id) === "land_conflict"
        ? t("dispatch.landConflictIntro")
        : t("dispatch.reworkIntro", { phrase: returnPhrase(id), round: task.review_round });
    try {
      // Resume reuses the original agent's TMPDIR; rotate its generation before sending work.
      prepareTaskTmpEnv(getTask(id), actor);
      await launcher.send(task.executor_agent_id, `${intro}\n\n${note}`);
    } catch (err) {
      revert(id, "rework", "running", claimToken);
      throw new KanbanError("send_failed", err instanceof Error ? err.message : String(err));
    }
    if (getTask(id).status !== "running") throw lostClaim(id, "running");
    // Keep the old failure through claim/send; clear it only once the worker resumes.
    const resumed = getDb().prepare(`UPDATE tasks SET hold_reason = NULL,
      blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, cooldown_until = NULL
      WHERE id = ? AND status = 'running' AND agent_id = ?`).run(id, task.executor_agent_id);
    if (resumed.changes !== 1) throw lostClaim(id, "running");
    openExecutorRun(id);
    appendEvent(id, "resumed", "rework", "running", actor, { agentId: task.executor_agent_id,
      ...(resumedTarget ? { reviewTarget: resumedTarget, reviewerRunId: deliveryRun(getTask(id))?.id ?? null } : {}),
      ...(forced ? { forced: true } : {}) });
    return { message: t("dispatch.sentBack", { agent: task.executor_agent_id }), agentId: task.executor_agent_id };
  }
  const review = phase === "review";
  const reviewing = review || task.role === "reviewer";
  const role = review ? "reviewer" : task.role;
  const profiles = options?.profiles ?? readProfiles();
  let chosen = options?.chosen;
  let pickReason = options?.reason ?? "";
  let routedEffort: string | null | undefined = options?.effort;
  let routedSource: EffortSource | undefined = options?.effortSource;
  let seenSnapshot = options?.snapshot ?? null;
  const recheckPolicy = () => {
    const stamp = seenSnapshot?.policy;
    if (!stamp) return; // Explicit trusted compatibility/dependency injection only.
    const current = readPolicy();
    if (current.state !== "ok" || current.snapshot.revision !== stamp.revision || current.snapshot.policyDigest !== stamp.digest) {
      throw new KanbanError("policy_changed", t("dispatch.policyChanged"));
    }
    const pool = readPoolSnapshot().entry(chosen!.pool ?? null);
    if (!pool.dispatchable || onlyRolesBlock(pool, chosen!.pool ?? null, profilePoolRole(chosen!, reviewing))) {
      throw new KanbanError("policy_changed", t("dispatch.policyChanged"));
    }
  };
  let matrixGeneratedAt = options?.matrixGeneratedAt ?? null;
  const briefFor = (pool: string | null): QuotaBrief =>
    quotaBrief({ snapshot: seenSnapshot, pool, matrixGeneratedAt });
  let routing = options?.routing;
  const routingInput = (): RouteInput => {
    if (routing) return { ...routing, review: reviewing, role, reviewTarget: resolveReviewTarget(getTask(id), review) };
    const occ = currentOccupancy(profiles);
    const settings = loadConfig();
    const matrix = options?.readMatrix?.() ?? loadDispatchMatrix();
    seenSnapshot ??= options?.readSnapshot?.() ?? readPoolSnapshot();
    matrixGeneratedAt = matrix.state === "ok" ? matrix.matrix.generatedAt : null;
    routing = {
      profiles: reassignment ? profiles.filter((profile) =>
        !((profile.role === role || (profile.role === "candidate" && profile.candidateFor === role)) &&
          (profile.name === reassignment.oldProfile || (reassignment.oldPool && profile.pool === reassignment.oldPool)))) : profiles,
      role,
      review: reviewing,
      profileOverride: reassignment ? null : reviewing ? (task.role === "reviewer" ? task.profile_override : null) : task.profile_override,
      executorFamily: task.executor_family,
      executorProfile: task.executor_profile,
      ...recordedExecutorFacts(task.review_of ?? task.id),
      reviewsExecutor: review && task.role !== "reviewer",
      reviewTarget: resolveReviewTarget(getTask(id), review),
      avoidPools: avoidedPools(id),
      byPool: occ.byPool,
      poolLimits: settings.concurrency.pools,
      snapshot: seenSnapshot,
      matrix: matrix.state === "ok" ? matrix.matrix : null,
      tier: task.tier,
      cardEffort: effortForOwnRole(task, review),
      ...cardRouteContext(task, settings.profileRules),
    };
    return routing!;
  };
  // Both security boundaries recheck scheduler selections before launch.
  const facts = recordedExecutorFacts(task.review_of ?? task.id);
  const needsCheck = chosen && (isGoogleProfile(chosen) || (reviewing &&
    (task.executor_family === "google" || (facts.executorProvider && isGoogleProfile({ provider: facts.executorProvider, model: facts.executorModel ?? undefined })) ||
      profiles.some(p => p.name === task.executor_profile && isGoogleProfile(p)))));
  if (!chosen || (reviewing && resolveReviewTarget(getTask(id), review)) || needsCheck) {
    const input = { ...routingInput(), ...facts, role, review: reviewing, tier: task.tier };
    const preselected = Boolean(chosen);
    const decision = routeProfile(chosen ? { ...input, profileOverride: chosen.id, profiles: [chosen, ...input.profiles.filter(p => p.id !== chosen!.id)] } : input);
    if (!decision.ok) {
      const quotaWait = decision.quotaWait === true || (decision.kind === "quota" && decision.action === "block");
      if (quotaWait || decision.kind === "quota") {
        const reason = quotaWait ? quotaWaitLabel(decision.pool, decision.reason) : decision.reason;
        const current = getTask(id);
        if (decision.concurrencyWait) noteQueueHold(current, "concurrency", reason, actor);
        else noteQueueHold(current, "quota", reason, actor, { quotaWait, quota: briefFor(decision.pool ?? null) });
        return { message: reason };
      }
      if (decision.action === "block") {
        blockTask(id, decision.kind, decision.reason, actor);
        return { message: decision.reason };
      }
      throw new KanbanError("not_ready", decision.reason);
    }
    chosen = decision.profile;
    if (!preselected || !pickReason) pickReason = decision.reason;
    if (decision.effortSource && !routedSource) {
      routedEffort = decision.effort ?? null;
      routedSource = decision.effortSource;
    }
  }
  // Card effort overrides thinkingOptionId only for this card's own role (executor on an
  // executor card, reviewer on a standalone review card, reader, decision, batch).
  // The review opened after an executor delivers is not affected: it keeps the reviewer
  // profile's thinkingOptionId, unless the dispatch matrix names a depth for that review.
  // A resumed rework keeps its original depth; a takeover uses normal routing for the new executor.
  const ownEffort = effortForOwnRole(task, review);
  const rejected = new Set<string>();
  const key = (profile: Profile, depth: string) => JSON.stringify([profile.id, profile.provider, profile.model, depth]);
  const holdEffort = (reason: string, notify = false): { message: string } => {
    if (getTask(id).hold_reason !== reason) appendEvent(id, "held", task.status, task.status, actor, { kind: "effort", reason });
    setHold(id, reason);
    if (notify) wakeKanbanSupervisor({ taskId: id, kind: "effort_unsupported", detail: reason });
    return { message: reason };
  };
  while (true) {
    if (reassignment && (chosen.name === reassignment.oldProfile || (reassignment.oldPool && chosen.pool === reassignment.oldPool))) {
      throw new KanbanError("not_ready", t("dispatch.reassignSameProfile"));
    }
    const depth = routedSource ? routedEffort : ownEffort;
    // A null matrix entry retains the profile default and does not require a catalog read.
    if (!depth || routedSource === "profile") break;
    const confirmed = await confirmEffort(launcher.listModels?.bind(launcher), chosen, depth);
    if (confirmed === "supported") break;
    if (confirmed === "unavailable") return holdEffort(effortCatalogHold());
    rejected.add(key(chosen, depth));
    const input = routingInput();
    const decision = routeProfile({ ...input, supportsEffort: (profile, effort) =>
      !rejected.has(key(profile, effort)) && (input.supportsEffort?.(profile, effort) ?? true) });
    if (!decision.ok) return holdEffort(decision.reason, decision.unsupportedEffort === true);
    chosen = decision.profile;
    pickReason = decision.reason;
    routedEffort = decision.effort;
    routedSource = decision.effortSource;
  }
  const diversion = tempDiversion(getTask(id), role);
  if (diversion && options?.force !== true) {
    const diverted = await placeOrStop(id, actor, () => placeWorktree(getTask(id), launcher, claimToken, { ...diversion, actor }));
    if ("message" in diverted) return diverted;
    placement = diverted;
    rememberPlacement(id, placement, actor);
    cwd = placement.cwd;
    task = getTask(id);
  }
  // Last boundary before create. allowMain is the same predicate as the check after
  // create: only --force or alwaysTemp off may bind an agent to the project main
  // workspace, and that stay records main_workspace_exception. An existing temporary
  // copy is reused. An old main-directory card, including leader rework and a takeover,
  // otherwise gets a copy at the commit already in that directory.
  const listed = launcher.listWorkspaces ? await launcher.listWorkspaces() : [];
  const checked = await placeOrStop(id, actor, () => refreshStartPlacement(getTask(id), placement, launcher, claimToken, actor, listed));
  if ("message" in checked) return checked;
  placement = checked;
  rememberPlacement(id, placement, actor);
  cwd = placement.cwd;
  task = getTask(id);
  const main = listed.find((entry) => isProjectMain(entry) && (entry.id === placement.workspaceId || samePath(entry.directory, cwd)));
  const mainDirectory = main?.directory ?? (getTask(id).workspace_kind === "dir" && !reviewed ? cwd : null);
  const separateCopy = getTask(id).workspace_kind === "worktree" && !samePath(cwd, main?.directory);
  const replacement = pendingReworkReplacement(id);
  const carryHead = holdsWorkspace(role) && (task.status === "rework" || Boolean(reassignment) || Boolean(replacement) || latestReworkKind(id) === "leader_rework");
  if (!allowMain && mainDirectory && !separateCopy) {
    const rootTask = { ...getTask(id), workspace_path: mainDirectory, workspace_kind: "dir" };
    const diverted = await placeOrStop(id, actor, () => placeWorktree(rootTask, launcher, claimToken, {
      base: loadConfig().projects?.[task.project]?.baseBranch || "main", holderId: null, actor,
      ...(!holdsWorkspace(role) ? { readOnly: !holdsWorkspace(task.role), ref: submissionRef(source ?? task) } :
        carryHead ? { ref: submissionRef(task, true) } : {}),
    }));
    if ("message" in diverted) return diverted;
    placement = diverted;
    rememberPlacement(id, placement, actor);
    cwd = placement.cwd;
    task = getTask(id);
  } else if (!separateCopy && (main || (getTask(id).workspace_kind === "dir" && !reviewed))) {
    appendEvent(id, "main_workspace_exception", null, null, actor, {
      workspaceId: placement.workspaceId ?? null, directory: cwd,
      reason: options?.force === true ? "force" : "alwaysTemp_off", role,
    });
  }
  const recordedEffort = routedSource ? (routedEffort ?? chosen.thinkingOptionId ?? null) : (ownEffort ?? chosen.thinkingOptionId ?? null);
  const effortSource = ownEffort ? "card" : chosen.thinkingOptionId ? "profile" : null;
  const startedReason = routedSource ? pickReason : effortReason(pickReason, recordedEffort, effortSource);
  const thinkingOverride = routedSource ? (routedSource === "profile" ? undefined : routedEffort ?? undefined) : (ownEffort ?? undefined);
  const from = task.status;
  const to: Status = review ? "reviewing" : "running";
  const token = issueToken(role, id, null);
  claim(id, from, to);
  const autoAccept = !["reader", "decision", "reviewer"].includes(role) && chosen.featureValues?.auto_accept === true ? 1 : 0;
  // Before create: a binding recovered after a lost create response reuses this
  // profile, and only agents created after this claim count as its result.
  let reviewTarget = resolveReviewTarget(getTask(id), review);
  const creating: CreatingRecord = {
    role, profile: chosen.name, family: actualFamily(chosen), provider: chosen.provider,
    model: chosen.model ?? null, autoAccept, effort: recordedEffort,
  };
  const claimedAt = new Date().toISOString();
  appendEvent(id, AGENT_CREATING, null, null, actor, { ...creating, ...(reviewTarget ? { reviewTarget } : {}) }, claimedAt);
  const config = buildAgentConfig(chosen, thinkingOverride);
  if (["reader", "decision", "reviewer"].includes(role) && (isGoogleProfile(chosen) || config.featureValues?.auto_accept === true)) {
    config.featureValues = { ...config.featureValues, auto_accept: false };
  }
  if (isGoogleProfile(chosen)) config.modeId = "default";
  let openedId: string | null = null;
  let forced = false;
  let createAttempted = false;
  let startup = recordReworkStartup(getTask(id), claimToken, from, cwd, placement.workspaceId, replacement, actor);
  try {
    forced = assertDirectoryFree(getTask(id), role, options?.force === true);
    if (reassignment) {
      const retired = await retireReworkExecutor(id, reassignment, actor, launcher);
      if (!retired) throw new KanbanError("not_ready", t("dispatch.reassignWaitArchive"));
      if (getTask(id).status !== to) throw lostClaim(id, to);
    }
    if (!await retireReclaimedAgents(id, role, actor, launcher)) {
      throw new KanbanError("not_ready", t("dispatch.reclaimWaitArchive"));
    }
    if (getTask(id).status !== to) throw lostClaim(id, to);
    // Re-read after awaited workspace/retirement operations. Scheduler selections and cached
    // route input cannot authorize a reviewer against a target that has changed meanwhile.
    assertReviewStartAvailable(getTask(id), role === "reviewer");
    reviewTarget = resolveReviewTarget(getTask(id), review);
    const targetBlock = reviewFamilyBlock(chosen, reviewTarget);
    if (targetBlock) throw new KanbanError("not_ready", targetBlock);
    if (reviewTarget) appendEvent(id, "review_target_checked", null, null, actor, { reviewTarget, path: "create" });
    const finalPlacement = await placeOrStop(id, actor, () => refreshStartPlacement(getTask(id), placement, launcher, claimToken, actor));
    if ("message" in finalPlacement) {
      deleteToken(token);
      revert(id, from, to, claimToken);
      return finalPlacement;
    }
    placement = finalPlacement;
    cwd = placement.cwd;
    rememberPlacement(id, placement, actor);
    task = getTask(id);
    if (!startup || startup.workspaceId !== placement.workspaceId || !samePath(startup.directory, cwd)) {
      startup = recordReworkStartup(task, claimToken, from, cwd, placement.workspaceId, replacement, actor);
    }
    const finalGuard = () => {
      recheckPolicy();
      const current = getTask(id);
      if (!holdsStartClaim(id, claimToken) || current.status !== to || current.paseo_workspace_id !== task.paseo_workspace_id || current.agent_id !== task.agent_id) {
        throw new KanbanError("start_lost", alreadyStarting());
      }
      assertDirectory(cwd);
      if (current.workspace_kind === "worktree" && !existsSync(join(cwd, ".git"))) {
        throw new KanbanError("workspace_missing", t("dispatch.cwdMissingNoAgent", { path: cwd }));
      }
      createAttempted = true;
    };
    const created = await openCreatedAgent(launcher, {
      cwd,
      workspaceId: placement.workspaceId,
      title: `【${roleLabel(role)}】${cardMark(id)} ${task.title}`,
      prompt: openingPrompt(chosen, task, role, reassignment),
      labels: { role, kanban: "1", kanban_task: String(id), ...(startup ? { kanban_start_generation: claimToken } : {}) },
      env: {
        [BOARD_AGENT_ENV]: "1",
        KANBAN_TOKEN: token,
        KANBAN_TASK: String(id),
        KANBAN_ROLE: role,
        ...prepareTaskTmpEnv(getTask(id), actor),
        ...((task.workspace_kind === "worktree" || task.workspace_kind === "lane") && role === "executor" ? { KANBAN_WORKTREE: "1" } : {}),
      },
      config,
    }, id, role, actor, claimedAt, finalGuard);
    openedId = created.id;
    // Keep this before post-create proof: cleanup must know the agent even when it never gets a successful run.
    appendEvent(id, "agent_opened", null, null, actor, {
      agentId: created.id,
      ...(created.recovered ? { recovered: "lost_create_response" } : {}),
    });
    if (startup) {
      appendEvent(id, "rework_startup_agent", null, null, actor, { generation: startup.generation, agentId: created.id, workspaceId: created.workspaceId ?? placement.workspaceId });
      const afterCreate = getTask(id);
      if (afterCreate.status !== to || afterCreate.paseo_workspace_id !== task.paseo_workspace_id ||
        (afterCreate.agent_id !== task.agent_id && afterCreate.agent_id !== created.id)) throw new KanbanError("start_lost", alreadyStarting());
      const fate = await workspaceFateReader(launcher)({ paseo_workspace_id: created.workspaceId ?? placement.workspaceId ?? null });
      if (fate === "gone" || worktreeDirectoryLost({ directory: cwd }) || !existsSync(join(cwd, ".git"))) {
        const recovered = await recoverReworkStartup(afterCreate, launcher, { startup, agentId: created.id, actor });
        if (recovered === "stale") throw new KanbanError("start_lost", alreadyStarting());
        if (recovered === "retry" || recovered === "blocked") {
          deleteToken(token);
          return { message: getTask(id).hold_reason ?? t("paseoArchiving.hold.archiving", { workspaceId: startup.workspaceId, state: t("paseoArchiving.state.archiving") }) };
        }
      }
      const current = getTask(id);
      if (!holdsStartClaim(id, claimToken) || current.status !== afterCreate.status || current.agent_id !== afterCreate.agent_id ||
        current.paseo_workspace_id !== afterCreate.paseo_workspace_id) throw new KanbanError("start_lost", alreadyStarting());
    }
    // A recover path may already have bound this same agent. A new id that
    // collides with the previous worker (tests reuse short ids) still has to
    // write its own run, so require an open run for this role.
    const alreadyBound = getDb()
      .prepare("SELECT id FROM runs WHERE task_id = ? AND agent_id = ? AND role = ? AND ended_at IS NULL")
      .get(id, created.id, role);
    if (getTask(id).status === to && getTask(id).agent_id === created.id && alreadyBound) {
      return { message: t("dispatch.started", { card: cardMark(id), agent: created.id }), agentId: created.id };
    }
    if (!allowMain && created.workspaceId && listed.some((entry) => entry.id === created.workspaceId && isProjectMain(entry))) {
      throw new KanbanError("workspace_missing", t("dispatch.boundToMain"));
    }
    if (getTask(id).status !== to) throw lostClaim(id, to);
    const now = new Date().toISOString();
    // Only write back while the card is still in the status we claimed. Otherwise a 'started'
    // event would say running while the card sits elsewhere (an archived demo card).
    // Capture every prior executor before overwriting the binding. Some recovery paths
    // clear executor_agent_id, leaving runs as the only record of the old worker.
    const supersededExecutors = new Set<string>();
    if (!review) {
      const previous = getTask(id).executor_agent_id;
      if (previous && previous !== created.id) supersededExecutors.add(previous);
      const runs = getDb().prepare("SELECT DISTINCT agent_id FROM runs WHERE task_id = ? AND role = ?").all(id, role) as Array<{ agent_id: string | null }>;
      for (const run of runs) {
        if (run.agent_id && run.agent_id !== created.id) supersededExecutors.add(run.agent_id);
      }
    }
    const bound = review
      ? getDb()
          .prepare(`UPDATE tasks SET agent_id = ?, hold_reason = NULL, nudge_count = 0, updated_at = ?,
            blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, cooldown_until = NULL
            WHERE id = ? AND status = ? AND agent_id IS ?
            AND EXISTS (SELECT 1 FROM start_claims WHERE task_id = tasks.id AND token = ?)`)
          .run(created.id, now, id, to, task.agent_id, claimToken)
      : getDb()
          .prepare(
            `UPDATE tasks SET agent_id = ?, executor_agent_id = ?, executor_profile = ?, executor_family = ?, hold_reason = NULL, nudge_count = 0, updated_at = ?,
             blocked_kind = NULL, blocked_reason = NULL, blocked_from = NULL, blocked_at = NULL, cooldown_until = NULL
             WHERE id = ? AND status = ? AND agent_id IS ?
             AND EXISTS (SELECT 1 FROM start_claims WHERE task_id = tasks.id AND token = ?)`,
          )
          .run(created.id, created.id, chosen.name, actualFamily(chosen), now, id, to, task.agent_id, claimToken);
    if (bound.changes !== 1) throw lostClaim(id, to);
    bindTokenAgent(token, created.id);
    revokeOtherRoleTokens(id, role, created.id);
    // Release only after a successful binding: cleanup must see the new current
    // worker, and a lost claim must never release another start's executor.
    if (!review) requestAgentReleases(id, [...supersededExecutors].map(agentId => ({ agentId, role: "executor" })));
    if (review && holdsWorkspace(task.role) && task.executor_agent_id &&
      task.workspace_kind === "worktree" && needsInspection) {
      requestAgentReleases(id, [{ agentId: task.executor_agent_id, role: "executor" }]);
      getDb().prepare("UPDATE tasks SET executor_agent_id = NULL WHERE id = ?").run(id);
      appendEvent(id, "executor_relocated", null, null, actor, { agentId: task.executor_agent_id, directory: cwd });
    }
    const openedRun = getDb()
      .prepare(
        `INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, effort, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, created.id, role, chosen.name, chosen.provider, chosen.model ?? null, actualFamily(chosen), autoAccept, recordedEffort, recordedEffort, now);
    const workspaceId = created.workspaceId ?? placement.workspaceId;
    if (workspaceId) rememberPlacement(id, { cwd, workspaceId, name: placement.name }, actor);
    appendEvent(id, "started", from, to, actor, {
      agentId: created.id,
      ...(startup ? { startupGeneration: startup.generation } : {}),
      profile: chosen.name,
      role,
      ...(reviewTarget ? { reviewTarget, reviewerRunId: Number(openedRun.lastInsertRowid) } : {}),
      reason: startedReason,
      workspaceId: workspaceId ?? null,
      quota: briefFor(chosen.pool ?? null),
      ...(isGoogleProfile(chosen) ? { googleDispatchPolicy: GOOGLE_DISPATCH_POLICY } : {}),
      ...(forced ? { forced: true } : {}),
    });
    if (replacement) appendEvent(id, "rework_reopened", null, null, actor, {
      ...replacement, newAgentId: created.id, newProfile: chosen.name, directory: cwd, workspaceId: workspaceId ?? null,
    });
    if (reassignment) {
      getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = 'rework_reassigned' WHERE task_id = ? AND agent_id = ? AND ended_at IS NULL").run(now, id, reassignment.oldAgentId);
      appendEvent(id, "rework_reassigned", from, to, actor, {
        oldAgentId: reassignment.oldAgentId, oldProfile: reassignment.oldProfile, oldPool: reassignment.oldPool,
        newAgentId: created.id, newProfile: chosen.name, reason: reassignment.reason, waitSince: reassignment.waitSince,
      });
    }
    return { message: t("dispatch.startedWithProfile", { card: cardMark(id), agent: created.id, profile: chosen.name }), agentId: created.id };
  } catch (err) {
    if (openedId) {
      const reason = err instanceof Error ? err.message : String(err);
      await discardOpenedAgent(id, openedId, actor, role, reason, launcher);
    }
    deleteToken(token);
    revert(id, from, to, claimToken);
    if (!createAttempted && replacement && err instanceof KanbanError && err.code === "workspace_missing" && holdsStartClaim(id, claimToken)) {
      const message = err.message;
      setHold(id, message);
      appendEvent(id, "rework_startup_deferred", null, null, actor, { generation: claimToken, directory: cwd, workspaceId: placement.workspaceId, reason: message });
      return { message };
    }
    throw err instanceof KanbanError ? err : new KanbanError("start_failed", err instanceof Error ? err.message : String(err));
  }
  } catch (err) {
    if (err instanceof KanbanError && err.code === "start_lost") return { message: alreadyStarting() };
    throw err;
  } finally {
    releaseStartClaim(id, claimToken);
  }
  });
}
