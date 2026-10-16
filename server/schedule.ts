/// <reference types="node" />
import { resolveReviewTarget } from "./review-target";
import { t } from "../shared/i18n";
import { leaderActionNote } from "./protocol";
import { autoArchiveDone } from "./auto-archive";
import { isAgentAlive } from "./alive";
import { agentReleaseRequested } from "./archive-book";
import { inspectAgentState, type AgentApiState, type AgentInspector } from "./agent-check";
import { deliverWake, hasWakeSender } from "./bus";
import { agentCwdMissing, missingCwdMessage, noteWakeSkipped } from "./missing-cwd";
import { lanesDisabledMessage, loadConfig, projectAlwaysTemp, projectAutoStart, projectParallel, projectWorkspace, roleLimit, type KanbanConfig } from "./config";
import { cardMark } from "./card-ref";
import { getDb } from "./db";
import { decisionBoardExtras } from "./decisions";
import { downstreamCounts, orderByDownstream } from "./downstream";
import { scanPrerequisiteAttention } from "./dependency-attention";
import { effortForOwnRole } from "./effort";
import { loadDispatchMatrix, matrixFailMessage, type MatrixLoad } from "./matrix";
import { startTask, WAITING_USER, type AgentLauncher } from "./dispatch";
import { pendingReworkReplacement, pollAwaitingPr, quietHandoffEligible, recoverStandaloneReview, reopenDepartedRework } from "./flow";
import { resumePendingLands } from "./temp-land";
import { KanbanError } from "./errors";
import { avoidedPools, cooldownLabel, noteStartFailure, recentSuccess, reclaimTask, TRANSIENT_START_LIMIT } from "./failures";
import { loginBlipProfile } from "./login-blip";
import { recoverLostCreate } from "./lost-agent";
import { blockLostWorkspace, workspaceFateReader } from "./lost-workspace";
import { agentLiveness, agentsDir, readAgentRecord, type AgentLiveness } from "./open";
import { isQuotaWaitReason, quotaWaitLabel } from "../shared/blocked";
import { onlyRolesBlock, quotaBrief, readPoolSnapshot, STALE_WAKE_MS, staleMinutes, type PoolSnapshot, type QuotaBrief } from "./pools";
import { cardRouteContext } from "./profile-rules";
import type { Profile } from "./profiles";
import { parentsBlockReason, taskParents } from "./parents";
import { promoteParents, promoteWaiting } from "./promote";
import { currentOccupancy, familyDispatchBlock, poolUnseenReason, holdsWorkspace, poolFullReason, profilePoolRole, recordedExecutorFacts, routeProfile, type Occupancy, type RouteInput } from "./routing";
import { noteQueueHold } from "./queue-hold";
import { latestReworkFeedback, planReworkReassignment, type ReworkReassignment } from "./rework-reassign";
import { type DaemonEpisode } from "./daemon-log";
import { restartBoardMessage, scanRestartStalls } from "./restart-stall";
import { isProjectPaused } from "./paused";
import { scanStalled, type AgentActivity } from "./stall";
import { waitUserHold } from "./wait-user";
import { appendEvent, blockTask, getTask, setHold, unblockTask, type TaskRow } from "./store";
import { resumeScheduledWaits } from "./scheduled-wait";
import type { PaseoAgentSendOptions } from "@getpaseo/client";
import { retryTransientBlocks } from "./transient-retry";
import { tempWorkspaceMessage } from "./temp-workspace";
import { awaitingLeaderHold, leaderHoldReason } from "./review-hold";
import { scanAcceptance } from "./acceptance-watch";
import { retryReviewHolds, retryUnattended, triageRecipient, wakeKanbanSupervisor } from "./wake";
import { alarmConfigProblem } from "./config-alarm";
import { roleLabel, type Status } from "../shared/labels";
import { stage } from "./perf";
import { guardCard, guardStage, withTimeout } from "./guard";

export interface TickOptions {
  now?: Date;
  profiles?: Profile[];
  launcher: AgentLauncher;
  agentState?: (agentId: string | null) => AgentLiveness;
  send?: (agentId: string, text: string, options?: PaseoAgentSendOptions) => Promise<void>;
  pools?: PoolSnapshot;
  config?: KanbanConfig;
  /** How often to look for idle agents. Zero checks on every tick. */
  stallIntervalMs?: number;
  /** How long an agent must sit idle before the card counts as stalled. */
  stallIdleMs?: number;
  /** Missing means this tick cannot see agent activity, so stalled cards are left alone. */
  agentActivity?: (agentId: string) => Promise<AgentActivity> | AgentActivity;
  /** Read daemon.log and look for agents interrupted by a restart. Tests leave this off. */
  watchDaemonRestart?: boolean;
  /** When set, do not read daemon.log. Null means no restart was seen. */
  daemonEpisode?: DaemonEpisode | null;
  /** Missing means read the immutable policy for this tick. */
  matrix?: MatrixLoad;
}

export interface TickResult {
  started: number[];
  held: Array<{ id: number; reason: string }>;
  /** One line per phase that threw. The round still ran every later phase. */
  errors: string[];
}

const GONE = new Set<AgentLiveness>(["closed", "error", "archived", "missing"]);

function poolOf(profiles: Profile[], profileName: string | null): string | null {
  if (!profileName) return null;
  return profiles.find((profile) => profile.name === profileName)?.pool ?? null;
}

/** The directory this start must wait for. Read-only roles run alongside whoever holds it. */
function exclusiveWorkspace(task: TaskRow, role: string): string | null {
  if (task.workspace_kind === "worktree" || task.workspace_kind === "lane" || task.workspace_kind === "none") return null;
  if (!holdsWorkspace(role)) return null;
  return task.workspace_path;
}

/** "Waiting to auto-start: <reason>", the hold a card shows while it queues. */
function waitingAutoStart(reason: string): string {
  return t("schedule.waitingAutoStart", { reason });
}

type GateInput = {
  auto: boolean;
  pool: string | null;
  role: string;
  workspace: string | null;
  occupancy: Occupancy;
  limits: KanbanConfig["concurrency"];
  dispatchable: boolean;
  /** Specific pool stop or onlyRoles reason. Used instead of the generic closed-pool sentence. */
  poolReason?: string | null;
  cooldownUntil: string | null;
  recent: boolean;
  now: number;
};
function gateHold(input: GateInput): { reason: string; concurrency?: true } | null {
  if (!input.auto) return { reason: t("schedule.autoStartOff") };
  if (input.cooldownUntil && Date.parse(input.cooldownUntil) > input.now) return { reason: cooldownLabel(input.cooldownUntil, input.now) };
  if (input.recent) return { reason: t("schedule.recentlyDone") };
  if (!input.dispatchable && input.pool) return { reason: input.poolReason ?? waitingAutoStart(t("schedule.poolClosed", { pool: input.pool })) };
  if (input.occupancy.global >= input.limits.global) return { reason: waitingAutoStart(t("schedule.globalFull")), concurrency: true };
  const roleCap = roleLimit(input.limits, input.role);
  if ((input.occupancy.byRole[input.role] ?? 0) >= roleCap) return { reason: waitingAutoStart(t("schedule.roleFull", { role: roleLabel(input.role) })), concurrency: true };
  if (input.pool) {
    const cap = input.limits.pools[input.pool];
    if (cap != null && (input.occupancy.byPool[input.pool] ?? 0) >= cap) return { reason: waitingAutoStart(poolFullReason(input.pool)), concurrency: true };
  }
  if (input.workspace && input.occupancy.workspaces.has(input.workspace)) return { reason: waitingAutoStart(t("schedule.sameWorkspace")), concurrency: true };
  return null;
}

export function gateReason(input: GateInput): string | null { return gateHold(input)?.reason ?? null; }

function reworkDepth(task: TaskRow, profile: Profile): string | null {
  const agentId = task.executor_agent_id;
  const row = agentId
    ? (getDb()
        .prepare(
          `SELECT effort, thinking_option_id FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(task.id, agentId) as { effort: string | null; thinking_option_id: string | null } | undefined)
    : undefined;
  if (row?.effort) return row.effort;
  if (row?.thinking_option_id) return row.thinking_option_id;
  if (task.effort) return task.effort;
  return profile.thinkingOptionId ?? null;
}

function plannedRole(task: TaskRow): string {
  const status = task.status === "blocked" ? (task.blocked_from ?? task.status) : task.status;
  if (status === "in_review" || status === "reviewing") return "reviewer";
  return task.role;
}

function routeFor(task: TaskRow, profiles: Profile[], pools: PoolSnapshot, config: KanbanConfig, matrix: MatrixLoad, now = Date.now(), reassignment?: ReworkReassignment) {
  const role = plannedRole(task);
  const review = role === "reviewer";
  const occ = currentOccupancy(profiles);
  const replacement = pendingReworkReplacement(task.id);
  const input: RouteInput = {
    // avoidPools only deprioritizes a pool. Reassignment must exclude the old pool entirely,
    // while retaining reviewer profiles so the usual cross-family reservation still runs.
    profiles: reassignment ? profiles.filter((profile) =>
      !((profile.role === role || (profile.role === "candidate" && profile.candidateFor === role)) &&
        (profile.name === reassignment.oldProfile || (reassignment.oldPool && profile.pool === reassignment.oldPool)))) : profiles,
    role,
    review,
    profileOverride: reassignment ? null : replacement ? replacement.oldProfile : review ? (task.role === "reviewer" ? task.profile_override : null) : task.profile_override,
    executorFamily: task.executor_family,
    executorProfile: task.executor_profile,
    ...recordedExecutorFacts(task.review_of ?? task.id),
    reviewsExecutor: review && task.role !== "reviewer",
    reviewTarget: resolveReviewTarget(task, review),
    avoidPools: avoidedPools(task.id),
    byPool: occ.byPool,
    poolLimits: config.concurrency.pools,
    snapshot: pools,
    matrix: matrix.state === "ok" ? matrix.matrix : null,
    tier: task.tier,
    cardEffort: effortForOwnRole(task, review),
    ...cardRouteContext(task, config.profileRules, now),
  };
  let decision = routeProfile(input);
  if (replacement && !decision.ok && input.profileOverride) {
    input.profileOverride = null;
    decision = routeProfile(input);
  }
  return { occ, input, decision };
}

function clearCooldown(id: number): void {
  getDb()
    .prepare(
      `UPDATE tasks SET blocked_kind = NULL, blocked_reason = NULL, cooldown_until = NULL
       WHERE id = ? AND status IN ('ready', 'in_review', 'rework') AND blocked_kind IN ('rate_limit', 'quota', 'transient')`,
    )
    .run(id);
}

function lanesClosed(task: TaskRow, config: KanbanConfig): boolean {
  return task.workspace_kind === "lane" && !projectWorkspace(task.project, config).lanesEnabled;
}

/** Tell the card's creator once. A later tick does not send again. */
async function wakeLaneCreator(task: TaskRow, send?: TickOptions["send"]): Promise<void> {
  if (isProjectPaused(task.project)) return;
  const who = task.created_by_agent?.trim();
  if (!who) return;
  const woken = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'lanes_disabled_woke' LIMIT 1").get(task.id);
  if (woken) return;
  if (!isAgentAlive(who)) return;
  const missing = agentCwdMissing(who);
  if (missing) {
    noteWakeSkipped(task.id, who, missing, "lanes_disabled");
    return;
  }
  if (!send && !hasWakeSender()) return;
  const text = [`${cardMark(task.id)} ${task.title}`, t("schedule.project", { project: task.project }), lanesDisabledMessage(), leaderActionNote()].join("\n");
  try {
    if (send) await withTimeout(() => send(who, text), t("schedule.timeout.wakeCreator"));
    else deliverWake(who, text);
  } catch {
    return;
  }
  appendEvent(task.id, "lanes_disabled_woke", task.status, task.status, "scheduler", { agentId: who });
}

function matrixStamp(matrix: MatrixLoad): string | null {
  return matrix.state === "ok" ? matrix.matrix.generatedAt : null;
}

function poolBrief(pools: PoolSnapshot, matrix: MatrixLoad, pool: string | null): QuotaBrief {
  return quotaBrief({ snapshot: pools, pool, matrixGeneratedAt: matrixStamp(matrix) });
}

function noteQuotaHold(task: TaskRow, reason: string, quota: QuotaBrief, quotaWait = false): void {
  noteQueueHold(task, "quota", reason, "scheduler", { quota, quotaWait });
}

async function tryStart(
  task: TaskRow,
  options: TickOptions,
  profiles: Profile[],
  pools: PoolSnapshot,
  config: KanbanConfig,
  matrix: MatrixLoad,
  held: TickResult["held"],
  started: number[],
): Promise<void> {
  const now = (options.now ?? new Date()).getTime();
  const role = plannedRole(task);
  let checkedExecutor: { id: string; state: AgentLiveness } | null = null;
  if (task.status === "ready" && lanesClosed(task, config)) {
    setHold(task.id, lanesDisabledMessage());
    held.push({ id: task.id, reason: lanesDisabledMessage() });
    await wakeLaneCreator(task, options.send);
    return;
  }
  if (!projectAutoStart(task.project, config)) {
    setHold(task.id, t("schedule.autoStartOff"));
    held.push({ id: task.id, reason: t("schedule.autoStartOff") });
    return;
  }
  if (task.status === "rework" && task.role !== "reviewer") {
    // A round-2 hold stays parked even when the old executor has left. Departed-executor
    // recovery would clear the hold and open a new agent before the leader rules.
    if (awaitingLeaderHold(task.id)) {
      if (task.hold_reason !== leaderHoldReason()) setHold(task.id, leaderHoldReason());
      held.push({ id: task.id, reason: leaderHoldReason() });
      return;
    }
    // Rejection may already have cleared the columns. Keep the last run as evidence.
    const prior = getDb().prepare("SELECT agent_id FROM runs WHERE task_id = ? AND role = ? ORDER BY id DESC LIMIT 1")
      .get(task.id, task.role) as { agent_id: string | null } | undefined;
    const oldId = task.executor_agent_id ?? prior?.agent_id ?? null;
    const state = oldId ? (options.agentState ? options.agentState(oldId) : isAgentAlive(oldId) ? "alive" : agentLiveness(oldId)) : "missing";
    const retired = Boolean(oldId && agentReleaseRequested(task.id, oldId));
    if (!task.executor_agent_id || retired || state === "archived" || state === "missing") {
      // A missing file during a reload is not a deletion. Production confirms via Paseo.
      const confirmed = oldId && options.launcher.inspectAgent ? await inspectAgentState(oldId, options.launcher.inspectAgent) :
        oldId && !options.agentState && state === "missing" ? "unknown" : state;
      // Every result can arrive after a leader verdict, including alive/unknown.
      const current = getTask(task.id);
      if (current.status !== task.status || current.updated_at !== task.updated_at || current.executor_agent_id !== task.executor_agent_id) return;
      if (confirmed === "unknown") {
        const reason = t("schedule.executorUnknown");
        setHold(task.id, reason);
        held.push({ id: task.id, reason });
        return;
      }
      if (confirmed === "archived" || confirmed === "missing") {
        if (awaitingLeaderHold(current.id)) {
          if (current.hold_reason !== leaderHoldReason()) setHold(current.id, leaderHoldReason());
          held.push({ id: current.id, reason: leaderHoldReason() });
          return;
        }
        task = reopenDepartedRework(current, oldId, confirmed, latestReworkFeedback(task.id) || t("schedule.readLastRejection"), new Date(now).toISOString());
      } else if (oldId && confirmed === "alive") checkedExecutor = { id: oldId, state: "alive" };
    }
  }
  const pinnedName = loginBlipProfile(task.id);
  const pinned = pinnedName ? (profiles.find((item) => item.name === pinnedName) ?? null) : null;
  if (pinnedName && !pinned) {
    const reason = t("schedule.loginProfileGone", { profile: pinnedName });
    setHold(task.id, reason);
    held.push({ id: task.id, reason });
    return;
  }
  const rework = planReworkReassignment(task, profiles, pools, config, now, (id) =>
    checkedExecutor?.id === id ? checkedExecutor.state : options.agentState ? options.agentState(id) : isAgentAlive(id) ? "alive" : agentLiveness(id));
  if (rework?.state === "waiting") {
    if (rework.kind === "quota") {
      noteQuotaHold(task, rework.reason, poolBrief(pools, matrix, poolOf(profiles, task.executor_profile)), isQuotaWaitReason(rework.reason));
    } else {
      setHold(task.id, rework.reason);
      if (task.hold_reason !== rework.reason) appendEvent(task.id, "held", task.status, task.status, "scheduler", { kind: rework.kind, reason: rework.reason });
    }
    held.push({ id: task.id, reason: rework.reason });
    return;
  }
  const reassignment = rework?.state === "reassign" ? rework.assignment : undefined;
  const sendBack = !reassignment && task.status === "rework" && Boolean(task.executor_agent_id);
  const routed = sendBack || pinned ? null : routeFor(task, profiles, pools, config, matrix, now, reassignment);
  if (routed && !routed.decision.ok) {
    const decision = routed.decision;
    // A closed pool used to block. Keep the card in ready, rework, or in_review and do not wake anyone.
    const quotaWait = decision.quotaWait === true || (decision.kind === "quota" && decision.action === "block");
    const reason = quotaWait ? quotaWaitLabel(decision.pool, decision.reason) : decision.reason;
    // A pending reassignment stays in rework when the replacement itself cannot start yet.
    if (decision.concurrencyWait) {
      noteQueueHold(task, "concurrency", reason, "scheduler");
    } else if (quotaWait || decision.kind === "quota") {
      noteQuotaHold(task, reason, poolBrief(pools, matrix, decision.pool ?? null), quotaWait);
    } else if (decision.action === "block" && !reassignment && !pendingReworkReplacement(task.id)) {
      try {
        blockTask(task.id, decision.kind, decision.reason, "scheduler");
      } catch (err) {
        setHold(task.id, err instanceof Error ? err.message : String(err));
      }
    } else {
      setHold(task.id, decision.reason);
    }
    held.push({ id: task.id, reason });
    return;
  }
  const profile = pinned
    ? pinned
    : sendBack
      ? profiles.find((item) => item.name === task.executor_profile) ?? null
      : routed && routed.decision.ok
        ? routed.decision.profile
        : null;
  if (sendBack && profile) {
    const why = familyDispatchBlock(profile, reworkDepth(task, profile), pools);
    if (why) {
      if (why === poolUnseenReason()) noteQuotaHold(task, quotaWaitLabel(profile.pool, why), poolBrief(pools, matrix, profile.pool ?? null), true);
      else {
        try {
          blockTask(task.id, "needs_human", why, "scheduler");
        } catch (err) {
          setHold(task.id, err instanceof Error ? err.message : String(err));
        }
      }
      held.push({ id: task.id, reason: why });
      return;
    }
  }
  const pickReason = pinned
    ? t("schedule.loginReopen", { profile: pinned.name })
    : sendBack
      ? t("schedule.sendBack")
      : routed && routed.decision.ok
        ? routed.decision.reason
        : "";
  const pool = profile?.pool ?? poolOf(profiles, task.executor_profile);
  const occ = routed?.occ ?? currentOccupancy(profiles);
  const avoid = avoidedPools(task.id);
  const switching = Boolean(pool && avoid.length > 0 && !avoid.includes(pool));
  const startRole = sendBack ? task.role : role;
  const locked = exclusiveWorkspace(task, startRole);
  // Rework stays on its current directory. A new worktree would be cut from the base and drop the earlier commits.
  const replacement = pendingReworkReplacement(task.id);
  const resumeInPlace = task.status === "rework" || Boolean(replacement) || (sendBack && task.workspace_kind !== "worktree" && task.workspace_kind !== "lane");
  // alwaysTemp uses the same diversion as a busy main directory, including when that directory is free.
  const divert = Boolean(
    locked &&
      !resumeInPlace &&
      (projectAlwaysTemp(task.project, config) || (occ.workspaces.has(locked) && projectParallel(task.project, config))),
  );
  // Rework and a login reopen skip the matrix. The pool-wide flag is not enough: onlyRoles still applies.
  const direct = Boolean(sendBack || pinned);
  const entry = pools.entry(pool);
  const limited = direct && entry.dispatchable ? onlyRolesBlock(entry, pool, profilePoolRole(profile, !sendBack && role === "reviewer")) : null;
  const gate = gateHold({
    auto: true,
    pool,
    role: startRole,
    workspace: divert ? null : locked,
    occupancy: occ,
    limits: config.concurrency,
    dispatchable: direct ? entry.dispatchable && limited == null : true,
    poolReason: direct && !entry.dispatchable && entry.reason
      ? waitingAutoStart(entry.reason)
      : limited ? waitingAutoStart(limited) : null,
    cooldownUntil: switching ? null : task.cooldown_until,
    recent: sendBack || replacement ? false : recentSuccess(task.id, role, now),
    now,
  });
  if (gate) {
    const reason = gate.reason;
    if (direct && pool && (!entry.dispatchable || limited)) noteQuotaHold(task, quotaWaitLabel(pool, reason), poolBrief(pools, matrix, pool), true);
    else if (gate.concurrency) noteQueueHold(task, "concurrency", reason, "scheduler");
    else setHold(task.id, reason);
    held.push({ id: task.id, reason });
    return;
  }
  clearCooldown(task.id);
  try {
    const decision = routed?.decision;
    await startTask(task.id, options.launcher, "scheduler", {
      profiles,
      chosen: profile ?? undefined,
      reason: pickReason,
      snapshot: pools,
      reworkReassign: reassignment,
      matrixGeneratedAt: matrixStamp(matrix),
      routing: pinned ? {
        ...routeFor(task, profiles, pools, config, { state: "missing" }, now).input,
        profileOverride: pinned.name,
      } : routed?.input,
      ...(decision && decision.ok && decision.effortSource
        ? { effort: decision.effort ?? null, effortSource: decision.effortSource, allowDowngrade: decision.allowDowngrade === true }
        : {}),
    });
    const after = getTask(task.id);
    if (after.status === "running" || after.status === "reviewing") {
      setHold(task.id, null);
      started.push(task.id);
    } else if (after.hold_reason) {
      held.push({ id: task.id, reason: after.hold_reason });
    }
  } catch (err) {
    const after = getTask(task.id);
    if (after.status === "running" || after.status === "reviewing") return;
    // wait-user landed inside the start window. The card is correctly parked: no failure, no hold rewrite, no wake.
    if (err instanceof KanbanError && err.code === WAITING_USER) return;
    const message = err instanceof KanbanError ? err.message : err instanceof Error ? err.message : String(err);
    if (err instanceof KanbanError && err.code === "policy_changed") {
      // No provider request was sent. Queue for a fresh revision without failure alarms.
      setHold(task.id, message);
      held.push({ id: task.id, reason: message });
      return;
    }
    const streak = noteStartFailure(task.id, message);
    if (streak > 0 && streak < TRANSIENT_START_LIMIT) {
      // The plugin is closing or reconnecting. The card is back in the queue; try again next tick.
      const reason = t("schedule.pluginReloading", { streak, limit: TRANSIENT_START_LIMIT, message });
      setHold(task.id, reason);
      held.push({ id: task.id, reason });
      return;
    }
    setHold(task.id, message);
    if (!(err instanceof KanbanError) || err.code !== "fetch_failed") {
      const detail = streak > 0 ? t("schedule.pluginClosingStreak", { streak, message }) : message;
      wakeKanbanSupervisor({ taskId: task.id, kind: "start_failed", detail });
    }
    held.push({ id: task.id, reason: message });
  }
}

async function wakeTriage(task: TaskRow, config: KanbanConfig, send?: TickOptions["send"]): Promise<void> {
  if (isProjectPaused(task.project)) return;
  const who = triageRecipient(task.project, config);
  if (!who) {
    setHold(task.id, t("schedule.noLeader"));
    return;
  }
  const missing = agentCwdMissing(who);
  if (missing) {
    noteWakeSkipped(task.id, who, missing, "triage");
    setHold(task.id, t("schedule.leaderCwdMissing", { path: missing }));
    return;
  }
  const woken = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'triage_woke' LIMIT 1").get(task.id);
  if (woken) {
    setHold(task.id, t("schedule.triageWoken"));
    return;
  }
  const text = [
    t("schedule.triage.head", { card: cardMark(task.id), title: task.title }),
    t("schedule.project", { project: task.project }),
    t("schedule.triage.need", { brief: task.brief || task.title }),
    t("schedule.triage.howTo"),
    leaderActionNote(),
  ].join("\n");
  try {
    if (send) await withTimeout(() => send(who, text), t("schedule.timeout.wakeTriage"));
    else deliverWake(who, text);
  } catch (err) {
    setHold(task.id, err instanceof Error ? err.message : String(err));
    return;
  }
  appendEvent(task.id, "triage_woke", task.status, task.status, "scheduler", { agentId: who });
  setHold(task.id, t("schedule.triageWoken"));
}

const START_GRACE_MS = 120_000;

/**
 * How long an assigned agent's record must stay unreadable before reconcile
 * treats that agent as gone.
 *
 * `paseo reload` rewrites files under ~/.paseo/agents. A tick that lands while
 * a file is absent or half-written used to reclaim the card (`agent_gone`)
 * even though the agent was still running. "missing" has to be seen twice,
 * at least this far apart, then a bounded Paseo API check gets the last word:
 * an existing, unarchived agent clears the miss and stays assigned. API failures
 * retain the file-only rule. A later tick that can read the file clears the miss.
 * Closed, error, and archived get the same API veto without the missing-file
 * delay. Paseo 0.10.2 reloadAgentSession persists a closed snapshot before it
 * resumes the same unarchived agent; that snapshot is not proof of departure.
 * If the API cannot be asked, these states still reclaim on the first read.
 * A card with no agent id yet stays through the start grace. After that, one
 * live agent record labeled for this card (kanban_task, role, same cwd) is
 * bound in place instead of reclaimed. Several matches, or an agents
 * directory that cannot be listed, skip the reclaim for that tick. No
 * matching record still reclaims on the next tick.
 * The miss clock is in memory. A plugin reload clears it, which waits another
 * round instead of reclaiming off a single miss.
 */
export const MISSING_CONFIRM_MS = 60_000;

const missingSince = new Map<number, { agentId: string; since: number }>();

export function resetReconcileForTests(): void {
  missingSince.clear();
}

async function reconcile(
  now: Date,
  agentState: (agentId: string | null) => AgentLiveness,
  inspect?: AgentInspector,
  launcher?: Pick<AgentLauncher, "inspectWorkspace" | "listWorkspaces">,
): Promise<void> {
  const rows = getDb().prepare("SELECT id, agent_id, updated_at FROM tasks WHERE status IN ('running', 'reviewing')").all() as unknown as Array<{
    id: number;
    agent_id: string | null;
    updated_at: string;
  }>;
  const workspaceFate = workspaceFateReader(launcher ?? {});
  const running = new Set<number>();
  for (const row of rows) {
    running.add(row.id);
    const task = getTask(row.id);
    if ((task.status !== "running" && task.status !== "reviewing") || task.agent_id !== row.agent_id) continue;
    // Before start grace and before the lost-agent reclaim. A dead workspace
    // must not grow a replacement agent. Unknown listings keep the old rule.
    const fate = await workspaceFate(task);
    const freshWorkspace = getTask(row.id);
    // A handoff or a new binding can land while the host lookup is in flight.
    // Discard every stale result, including live/unknown results before reclaim.
    if (freshWorkspace.status !== task.status || freshWorkspace.agent_id !== task.agent_id
      || freshWorkspace.paseo_workspace_id !== task.paseo_workspace_id) {
      missingSince.delete(row.id);
      continue;
    }
    if (fate === "gone") {
      blockLostWorkspace(freshWorkspace, agentState(freshWorkspace.agent_id));
      missingSince.delete(row.id);
      continue;
    }
    if (!row.agent_id && now.getTime() - Date.parse(row.updated_at) < START_GRACE_MS) continue;
    // agents.create can finish in the daemon after the caller's socket is gone.
    // The card is already running and the id was never stored. Bind that record
    // instead of treating the empty id as agent_gone.
    if (!row.agent_id && recoverLostCreate(row.id, now) !== "absent") continue;
    const state = agentState(row.agent_id);
    if (!GONE.has(state)) {
      missingSince.delete(row.id);
      continue;
    }
    if (row.agent_id && state === "missing") {
      const miss = missingSince.get(row.id);
      const first = miss?.agentId === row.agent_id ? miss.since : null;
      if (first == null || now.getTime() - first < MISSING_CONFIRM_MS) {
        if (first == null) missingSince.set(row.id, { agentId: row.agent_id, since: now.getTime() });
        continue;
      }
    }
    missingSince.delete(row.id);
    let apiState: AgentApiState | undefined;
    if (row.agent_id) {
      apiState = await inspectAgentState(row.agent_id, inspect);
      // Completion, unblock, or another start can change this card during the API await.
      const fresh = getTask(row.id);
      if (fresh.agent_id !== row.agent_id || (fresh.status !== "running" && fresh.status !== "reviewing")) continue;
      if (apiState === "alive") {
        appendEvent(row.id, "liveness_mismatch", fresh.status, fresh.status, "scheduler", {
          agentId: row.agent_id, fileState: state, recordState: readAgentRecord(row.agent_id).state, apiState, agentsDir: agentsDir(),
        }, now.toISOString());
        continue;
      }
      if (apiState === "archived" && quietHandoffEligible(fresh)) continue;
    }
    reclaimTask(row.id, now, { fileState: state, apiState });
  }
  for (const id of missingSince.keys()) {
    if (!running.has(id)) missingSince.delete(id);
  }
}

function listStatus(status: Status): TaskRow[] {
  return getDb().prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, id ASC").all(status) as unknown as TaskRow[];
}

/** A matrix that has stayed unreadable for 6 hours wakes the Kanban supervisor once per file mtime. */
function wakeOnBadMatrix(matrix: MatrixLoad): void {
  if (matrix.state !== "invalid" || matrix.ageMs == null || matrix.ageMs <= STALE_WAKE_MS) return;
  const hours = Math.floor(matrix.ageMs / 3_600_000);
  wakeKanbanSupervisor({
    taskId: null,
    kind: "matrix_invalid",
    subject: matrix.updatedAt ?? "unknown",
    detail: t("schedule.matrixInvalid", { hours, minutes: staleMinutes(matrix.ageMs), path: matrix.path }),
  });
}

/** A snapshot that has not been updated for 6 hours wakes the Kanban supervisor, once per snapshot. */
function wakeOnStalePools(pools: PoolSnapshot): void {
  if (pools.state !== "stale" || pools.ageMs == null || pools.ageMs <= STALE_WAKE_MS) return;
  const hours = Math.floor(pools.ageMs / 3_600_000);
  wakeKanbanSupervisor({
    taskId: null,
    kind: "pool_stale",
    subject: pools.updatedAt ?? "unknown",
    detail: t("schedule.poolsStale", { hours, minutes: staleMinutes(pools.ageMs) }),
  });
}

/** Before the round reads the config: a lost or broken file is reported even when the round cannot go on. */
function checkConfigFile(now: Date): void {
  try {
    alarmConfigProblem(now.getTime());
  } catch (err) {
    console.error("[paseo-kanban] config check", err instanceof Error ? err.message : err);
  }
}

export async function runTick(options: TickOptions): Promise<TickResult> {
  const now = options.now ?? new Date();
  const profiles = options.profiles ?? [];
  stage("tick.configFile", () => checkConfigFile(now));
  const { config, pools, matrix } = stage("tick.inputs", () => ({
    config: options.config ?? loadConfig(),
    pools: options.pools ?? readPoolSnapshot(now.getTime()),
    matrix: options.matrix ?? loadDispatchMatrix(now.getTime()),
  }));
  const agentState = options.agentState ?? agentLiveness;
  const started: number[] = [];
  const held: TickResult["held"] = [];
  const errors: string[] = [];
  // Every phase is its own failure domain: one that throws is recorded and the rest of the round still runs.
  const phase = (name: string, fn: () => Promise<unknown> | unknown): Promise<void> =>
    stage(name, () => guardStage(name, errors, fn, now.getTime()));
  await phase("tick.wakeStale", () => {
    wakeOnStalePools(pools);
    wakeOnBadMatrix(matrix);
  });
  await phase("tick.promote", () => {
    promoteWaiting("scheduler", now.getTime());
    promoteParents("scheduler");
  });
  await phase("tick.pendingLands", async () => {
    try {
      await resumePendingLands();
    } catch (err) {
      console.error("[paseo-kanban] land", err instanceof Error ? err.message : err);
    }
  });
  await phase("tick.reconcile", () => reconcile(now, agentState, options.launcher.inspectAgent, options.launcher));
  await phase("tick.stall", () => scanStalled({
    now,
    config,
    intervalMs: options.stallIntervalMs,
    idleMs: options.stallIdleMs,
    agentActivity: options.agentActivity,
    send: options.send,
  }));
  if (options.watchDaemonRestart) {
    await phase("tick.restartStall", () => scanRestartStalls({
      now,
      config,
      intervalMs: options.stallIntervalMs,
      idleMs: options.stallIdleMs,
      episode: options.daemonEpisode,
      send: options.send,
      lastActivity: async (agentId) => {
        if (!options.agentActivity) return null;
        try {
          const activity = await withTimeout(() => options.agentActivity!(agentId), t("schedule.timeout.agentActivity"));
          return activity.lastAt ?? null;
        } catch (err) {
          console.error("[paseo-kanban] restart", err instanceof Error ? err.message : err);
          return null;
        }
      },
    }));
  }
  await phase("tick.triage", async () => {
    for (const task of listStatus("triage")) {
      await guardCard(task.id, "tick.triage", async () => {
        const fresh = getTask(task.id);
        if (fresh.status !== "triage") return;
        const children = getDb().prepare("SELECT COUNT(*) AS n FROM links WHERE parent_id = ?").get(task.id) as { n: number };
        if (children.n > 0) {
          setHold(task.id, t("schedule.waitingChildren"));
          return;
        }
        await wakeTriage(fresh, config, options.send);
      }, now);
    }
  });
  await phase("tick.quotaUnblock", () => {
    for (const task of listStatus("blocked")) {
      if (task.blocked_kind !== "quota") continue;
      const fresh = getTask(task.id);
      if (fresh.status !== "blocked" || fresh.blocked_kind !== "quota") continue;
      // A quota block from an older build goes back to its queue. The start loop below
      // either starts it or marks it as waiting for quota. Running and reviewing are not rewritten here.
      if (fresh.blocked_from === "running" || fresh.blocked_from === "reviewing") continue;
      try {
        unblockTask(fresh.id, "scheduler", { via: "quota_wait" });
      } catch (err) {
        console.error("[paseo-kanban] quota unblock", err instanceof Error ? err.message : err);
      }
    }
  });
  await phase("tick.scheduledWait", () => resumeScheduledWaits(now, options.send));
  await phase("tick.transientRetry", async () => {
    try {
      await retryTransientBlocks(now, config, options.send);
    } catch (err) {
      console.error("[paseo-kanban] transient retry", err instanceof Error ? err.message : err);
    }
  });
  let downstream = new Map<number, number>();
  await phase("tick.downstream", () => {
    downstream = downstreamCounts();
  });
  await phase("tick.startLoop", async () => {
    for (const status of ["ready", "in_review", "rework"] as const) {
      for (const task of orderByDownstream(listStatus(status), downstream)) {
        await guardCard(task.id, "tick.startLoop", async () => {
          const fresh = getTask(task.id);
          if (fresh.status !== status) return;
          if (status === "rework" && fresh.role === "reviewer" && !fresh.executor_agent_id && !fresh.review_of) {
            recoverStandaloneReview(fresh.id, "scheduler");
            return;
          }
          if (status === "rework" && awaitingLeaderHold(fresh.id)) {
            if (fresh.hold_reason !== leaderHoldReason()) setHold(fresh.id, leaderHoldReason());
            return;
          }
          if (fresh.wait_decision) {
            const reason = waitUserHold(fresh.wait_decision);
            if (fresh.hold_reason !== reason) setHold(fresh.id, reason);
            held.push({ id: fresh.id, reason });
            return;
          }
          const before = started.length;
          await tryStart(fresh, options, profiles, pools, config, matrix, held, started);
          if (started.length > before && (downstream.get(task.id) ?? 0) > 0) {
            appendEvent(task.id, "downstream_dispatched", null, null, "scheduler", {
              policy: "priority-downstream-stable-v1", downstreamCount: downstream.get(task.id) ?? 0,
              priority: task.priority, status,
            });
          }
        }, now);
      }
    }
  });
  await phase("tick.waiting", async () => {
    // promoteWaiting already ran once at the top of this round; this phase only explains who is still waiting.
    for (const task of listStatus("waiting")) {
      await guardCard(task.id, "tick.waiting", async () => {
        if (lanesClosed(task, config)) {
          setHold(task.id, lanesDisabledMessage());
          await wakeLaneCreator(task, options.send);
          return;
        }
        setHold(task.id, parentsBlockReason(taskParents(task.id), now.getTime(), task) ?? t("schedule.waitingParents"));
      }, now);
    }
  });
  await phase("tick.awaitingPr", () => pollAwaitingPr());
  await phase("tick.prerequisiteWake", () => scanPrerequisiteAttention({ now, config, agentState: options.agentState, inspectAgent: options.launcher.inspectAgent, send: options.send }));
  // Reads merge results from earlier background checks; never waits on gh.
  await phase("tick.autoArchive", () => autoArchiveDone({ now, config }));
  await phase("tick.reviewHolds", () => {
    retryReviewHolds();
    retryUnattended();
  });
  await phase("tick.acceptanceWake", () => scanAcceptance({ now, config }));
  await phase("tick.fillHolds", () => fillMissingHolds());
  return { started, held, errors };
}

/** Every ready or in_review card that did not start this tick needs a reason. */
function fillMissingHolds(): void {
  const rows = getDb().prepare("SELECT id, status, hold_reason FROM tasks WHERE status IN ('ready', 'in_review') ORDER BY id").all() as unknown as Array<{
    id: number;
    status: string;
    hold_reason: string | null;
  }>;
  for (const row of rows) {
    if (row.hold_reason && row.hold_reason.trim()) continue;
    setHold(row.id, row.status === "in_review" ? t("schedule.noReviewThisRound") : t("schedule.noStartThisRound"));
  }
}

export function attentionCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE status = 'acceptance' OR (status = 'blocked' AND blocked_kind IN ('needs_human', 'capability'))`,
    )
    .get() as { n: number };
  return row.n;
}

export function unattendedCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE unattended_at IS NOT NULL`).get() as { n: number };
  return row.n;
}

export function boardExtras(project?: string): {
  decisions: ReturnType<typeof decisionBoardExtras>["decisions"];
  leaders: ReturnType<typeof decisionBoardExtras>["leaders"];
  attention: number;
  pool: { state: PoolSnapshot["state"]; message: string };
  autoStart: boolean | null;
  concurrency: KanbanConfig["concurrency"];
  supervisorAgentId: string | null;
  projectSupervisorId: string | null;
  unattended: number;
  /** Null when the matrix is missing or valid. The fixed sentence when it cannot be read. */
  matrixMessage: string | null;
  /** Set when some agent cwd is missing and Kanban will not create that directory. */
  missingCwdMessage: string | null;
  /** Set when a temporary workspace is still open after the cleanup deadline. */
  tempWorkspaceMessage: string | null;
  /** Set after a daemon restart has been checked against running cards. */
  restartMessage: string | null;
} {
  const config = loadConfig();
  const pool = readPoolSnapshot();
  const matrix = loadDispatchMatrix();
  return {
    ...decisionBoardExtras(config.supervisors, project),
    attention: attentionCount(),
    pool: { state: pool.state, message: pool.message },
    autoStart: project ? projectAutoStart(project, config) : null,
    concurrency: config.concurrency,
    supervisorAgentId: config.supervisorAgentId,
    projectSupervisorId: project ? (config.supervisors[project] ?? null) : null,
    unattended: unattendedCount(),
    matrixMessage: matrix.state === "invalid" ? matrixFailMessage() : null,
    missingCwdMessage: missingCwdMessage(),
    tempWorkspaceMessage: tempWorkspaceMessage(),
    restartMessage: restartBoardMessage(),
  };
}
