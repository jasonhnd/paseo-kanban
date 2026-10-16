/// <reference types="node" />
import { deliverWake } from "./bus";
import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";
import { DEFAULT_STALL_IDLE_MS, DEFAULT_STALL_INTERVAL_MS, type KanbanConfig } from "./config";
import { getDb } from "./db";
import { cliFallback } from "./fallback";
import { noWaitNudge } from "./protocol";
import { quietHandoffEligible, settleQuietHandoff } from "./flow";
import { appendEvent, getTask, stallNoteFor, type TaskRow } from "./store";
import { roundStartId, wakeKanbanSupervisor } from "./wake";
import { guardCard, safeParse, withTimeout } from "./guard";
import { isProjectDormant } from "./paused";
import { t } from "../shared/i18n";

export interface AgentActivity {
  state: "busy" | "idle" | "archived" | "unknown";
  /** When this idle period started. Missing means we cannot tell, so the card is left alone. */
  since?: string | null;
  /** Newest activity clock, including while the agent still looks busy. */
  lastAt?: string | null;
  /** Newest assistant message, when the caller already read the timeline. */
  lastAssistant?: string | null;
}

export interface AgentClock {
  status?: string | null;
  activeTurn?: unknown;
  archivedAt?: string | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
}

function turnStartedAt(turn: unknown): string | null {
  if (!turn || typeof turn !== "object") return null;
  const started = (turn as { startedAt?: unknown }).startedAt;
  return typeof started === "string" ? started : null;
}

/** Later of two stamps. An unreadable value is ignored. */
export function newerStamp(current: string | null | undefined, next: string | null | undefined): string | null {
  const currentMs = typeof current === "string" ? Date.parse(current) : Number.NaN;
  const nextMs = typeof next === "string" ? Date.parse(next) : Number.NaN;
  const currentOk = !Number.isNaN(currentMs);
  const nextOk = !Number.isNaN(nextMs);
  if (currentOk && nextOk) return nextMs > currentMs ? next! : current!;
  if (nextOk) return next!;
  if (currentOk) return current!;
  return null;
}

/** Newest clock we can read. A busy agent still has one; a missing clock stays null. */
export function activityInstant(agent: AgentClock | null | undefined, timelineAt?: string | null): string | null {
  return [agent?.attentionTimestamp, agent?.lastActivityAt, agent?.updatedAt, turnStartedAt(agent?.activeTurn), timelineAt].reduce<string | null>(
    (best, value) => newerStamp(best, value),
    null,
  );
}

/** Move lastAt forward. An idle clock's since moves with it, and never backward. */
export function advanceActivity(activity: AgentActivity, stamp: string | null | undefined): AgentActivity {
  const lastAt = newerStamp(activity.lastAt, stamp);
  if (activity.state !== "idle") return lastAt ? { ...activity, lastAt } : activity;
  const since = newerStamp(activity.since, stamp);
  return { ...activity, ...(lastAt ? { lastAt } : {}), ...(since ? { since } : {}) };
}

/** Newest timestamp on a timeline page. Entries are not assumed to be ordered. */
export function lastTimelineStamp(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  return newestStamp(entries);
}

function newestStamp(entries: unknown[]): string | null {
  let bestMs = Number.NEGATIVE_INFINITY;
  let best: string | null = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    if (typeof timestamp !== "string") continue;
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms) || ms < bestMs) continue;
    bestMs = ms;
    best = timestamp;
  }
  return best;
}

/**
 * Busy while a turn is open. Closed, missing, or unreadable clocks are not idle.
 * Idle starts at the newest of attentionTimestamp, lastActivityAt, updatedAt, the open turn, and timelineAt.
 * A finished attention stamp does not win when a later clock exists.
 */
export function activityFromSnapshot(agent: AgentClock | null | undefined, timelineAt?: string | null): AgentActivity {
  const lastAt = activityInstant(agent, timelineAt);
  const stamped = lastAt ? { lastAt } : {};
  if (!agent) return { state: "unknown" };
  if (agent.archivedAt) {
    const since = lastAt ?? agent.archivedAt;
    return { state: "archived", since, lastAt: since };
  }
  const turn = agent.activeTurn;
  const busy = agent.status === "running" || agent.status === "initializing" || (turn != null && typeof turn === "object");
  if (busy) return { state: "busy", ...stamped };
  if (agent.status !== "idle") return { state: "unknown", ...stamped };
  if (!lastAt) return { state: "unknown", ...stamped };
  return { state: "idle", since: lastAt, lastAt };
}

export function stallLabel(idleMs: number): string {
  const minutes = Math.max(1, Math.floor(idleMs / 60_000));
  return t("stall.label", { minutes });
}

let lastStallAt = Number.NEGATIVE_INFINITY;

export function resetStallScanForTests(): void {
  lastStallAt = Number.NEGATIVE_INFINITY;
}

function clockOf(row: { at: string; data_json: string }, agentId: string): string | null {
  const data = safeParse<{ agentId?: string; at?: string }>(row.data_json);
  if (!data || data.agentId !== agentId) return null;
  return typeof data.at === "string" ? data.at : row.at;
}

function dataAgentId(dataJson: string): string | null {
  const data = safeParse<{ agentId?: unknown }>(dataJson);
  return typeof data?.agentId === "string" && data.agentId ? data.agentId : null;
}

/**
 * Card events that count as this agent still being on the job.
 * Counted: this agent's comment (including a reply after nudge or stall_nudge), unblocked, resumed for this agent.
 * Not counted: nudge and stall_nudge themselves — those are the board asking, not the agent answering.
 */
function cardActivity(taskId: number, agentId: string): { at: string | null; id: number } {
  const rows = getDb()
    .prepare(
      `SELECT id, at, kind, actor, data_json FROM events WHERE task_id = ? AND kind IN ('comment', 'unblocked', 'resumed') ORDER BY id`,
    )
    .all(taskId) as unknown as Array<{ id: number; at: string; kind: string; actor: string | null; data_json: string }>;
  let best: string | null = null;
  let bestId = 0;
  for (const row of rows) {
    const named = dataAgentId(row.data_json);
    const owns = row.actor === agentId || named === agentId;
    if (row.kind === "comment" && !owns) continue;
    if (row.kind === "resumed" && !owns) continue;
    best = newerStamp(best, row.at);
    bestId = Math.max(bestId, row.id);
  }
  return { at: best, id: bestId };
}

export function cardActivityAt(taskId: number, agentId: string): string | null {
  return cardActivity(taskId, agentId).at;
}

/** Idle nudges (and failed sends) allowed per card and agent before the board escalates instead. */
export const STALL_NUDGE_LIMIT = 2;

/**
 * Nudges and failed nudge sends for this agent since its last real progress (its own comment,
 * unblock or resume) or since the card entered its current status, whichever is later.
 * A reply that ends in another idle turn is not progress.
 */
function nudgeAttempts(task: TaskRow, agentId: string): { count: number; lastMs: number } {
  const floor = Math.max(cardActivity(task.id, agentId).id, roundStartId(task));
  const rows = getDb()
    .prepare(`SELECT at, data_json FROM events WHERE task_id = ? AND id > ? AND kind IN ('stall_nudge', 'stall_nudge_failed') ORDER BY id`)
    .all(task.id, floor) as unknown as Array<{ at: string; data_json: string }>;
  let count = 0;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const at = clockOf(row, agentId);
    if (!at) continue;
    count += 1;
    const ms = Date.parse(at);
    if (!Number.isNaN(ms)) lastMs = Math.max(lastMs, ms);
  }
  return { count, lastMs };
}

function latestNudgeAt(taskId: number, agentId: string): { at: string; restart: boolean } | null {
  const rows = getDb()
    .prepare(
      `SELECT at, kind, data_json FROM events WHERE task_id = ? AND kind IN ('stall_nudge', 'stalled_after_restart') ORDER BY id DESC`,
    )
    .all(taskId) as unknown as Array<{ at: string; kind: string; data_json: string }>;
  for (const row of rows) {
    if (row.kind === "stalled_after_restart") {
      if (safeParse<{ sent?: boolean }>(row.data_json)?.sent !== true) continue;
    }
    const at = clockOf(row, agentId);
    if (at) return { at, restart: row.kind === "stalled_after_restart" };
  }
  return null;
}

/** The later of the idle nudge and the turn-ended remind. A restart nudge stays a restart. */
function latestQuietNudgeAt(taskId: number, agentId: string): { at: string; restart: boolean } | null {
  const stall = latestNudgeAt(taskId, agentId);
  const turn = getDb()
    .prepare(`SELECT at FROM events WHERE task_id = ? AND kind = 'nudge' AND actor = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId, agentId) as { at: string } | undefined;
  if (!turn) return stall;
  if (!stall) return { at: turn.at, restart: false };
  const turnMs = Date.parse(turn.at);
  const stallMs = Date.parse(stall.at);
  if (!Number.isNaN(turnMs) && (Number.isNaN(stallMs) || turnMs > stallMs)) return { at: turn.at, restart: false };
  return stall;
}

function nudgeText(task: TaskRow): string {
  if (task.status === "reviewing") {
    return t("stall.nudge.review", { noWait: noWaitNudge(), cli: cliFallback() });
  }
  if (quietHandoffEligible(task)) {
    const next = task.role === "executor" ? t("stall.nudge.next.review") : t("stall.nudge.next.accept");
    return t("stall.nudge.quiet", { noWait: noWaitNudge(), cli: cliFallback(), next });
  }
  return t("stall.nudge.plain", { noWait: noWaitNudge(), cli: cliFallback() });
}

/** Round ended and the card is still waiting on that agent. */
function roundEnded(activity: AgentActivity): boolean {
  return activity.state === "idle" || activity.state === "archived";
}

function alreadyNoted(taskId: number, agentId: string): boolean {
  return stallNoteFor({ id: taskId, status: "running", agent_id: agentId }) != null;
}

type StallScan = {
  now: Date;
  config: KanbanConfig;
  intervalMs?: number;
  idleMs?: number;
  agentActivity?: (agentId: string) => Promise<AgentActivity> | AgentActivity;
  send?: (agentId: string, text: string) => Promise<void>;
};

async function checkStalledCard(rowId: number, input: StallScan, nowMs: number, idleLimit: number): Promise<void> {
  let task = getTask(rowId);
  if ((task.status !== "running" && task.status !== "reviewing") || !task.agent_id) return;
  if (isProjectDormant(task.project)) return;
  let activity: AgentActivity;
  try {
    activity = await withTimeout(() => input.agentActivity!(task.agent_id!), t("stall.call.activity"));
  } catch (err) {
    console.error("[paseo-kanban] stall", err instanceof Error ? err.message : err);
    return;
  }
  // The read can take a while: the card may have finished or changed hands meanwhile.
  const fresh = getTask(rowId);
  if ((fresh.status !== "running" && fresh.status !== "reviewing") || fresh.agent_id !== task.agent_id) return;
  task = fresh;
  if (!roundEnded(activity)) return;
  const agentId = task.agent_id!;
  const since = newerStamp(activity.since, cardActivityAt(task.id, agentId));
  if (!since) return;
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return;
  const idleFor = nowMs - sinceMs;
  if (idleFor < idleLimit) return;
  const nudge = latestQuietNudgeAt(task.id, agentId);
  const nudgedMs = nudge ? Date.parse(nudge.at) : Number.NaN;
  const attempts = nudgeAttempts(task, agentId);
  const exhausted = attempts.count >= STALL_NUDGE_LIMIT;
  if (!exhausted && (!nudge || Number.isNaN(nudgedMs) || nudgedMs < sinceMs)) {
    const missing = agentCwdMissing(agentId);
    const text = nudgeText(task);
    let sent = false;
    let failure: string | null = null;
    const roundAtSend = roundStartId(task);
    if (missing) {
      noteWakeSkipped(task.id, agentId, missing, "stall");
      if (activity.state !== "archived") return;
    } else {
      try {
        if (input.send) await withTimeout(() => input.send!(agentId, text), t("stall.call.send"));
        else if (!(await withTimeout(() => deliverWake(agentId, text), t("stall.call.send")))) throw new Error(t("stall.error.notDelivered"));
        sent = true;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        console.error("[paseo-kanban] stall", failure);
      }
    }
    // The send can take a while too: a card that finished, changed hands or started a new round
    // meanwhile must not get a nudge or a failure written against the old agent and round.
    const after = getTask(task.id);
    if (
      (after.status !== "running" && after.status !== "reviewing") ||
      after.status !== task.status ||
      after.agent_id !== agentId ||
      roundStartId(after) !== roundAtSend
    ) {
      return;
    }
    if (failure != null && activity.state !== "archived") {
      // A refused send is an attempt too: it is counted, so a dead agent is escalated, not retried forever.
      appendEvent(task.id, "stall_nudge_failed", task.status, task.status, "scheduler", {
        agentId,
        error: failure,
        attempt: attempts.count + 1,
        since,
        at: input.now.toISOString(),
      });
      return;
    }
    appendEvent(task.id, "stall_nudge", task.status, task.status, "scheduler", {
      agentId,
      text,
      since,
      sent,
      archived: activity.state === "archived",
      at: input.now.toISOString(),
    });
    return;
  }
  const lastMs = Math.max(Number.isNaN(nudgedMs) ? Number.NEGATIVE_INFINITY : nudgedMs, attempts.lastMs);
  if (!Number.isFinite(lastMs) || nowMs - lastMs < idleLimit) return;
  if (nudge?.restart) {
    const label = stallLabel(idleFor);
    if (!alreadyNoted(task.id, agentId)) {
      appendEvent(task.id, "stalled", task.status, task.status, "scheduler", {
        agentId,
        text: label,
        at: input.now.toISOString(),
      });
    }
    return;
  }
  if (quietHandoffEligible(task)) {
    settleQuietHandoff(task.id, {
      now: input.now,
      lastText: activity.lastAssistant ?? null,
      source: "stall",
    });
    return;
  }
  const label = stallLabel(idleFor);
  if (!alreadyNoted(task.id, agentId)) {
    appendEvent(task.id, "stalled", task.status, task.status, "scheduler", {
      agentId,
      text: label,
      at: input.now.toISOString(),
    });
  }
  wakeKanbanSupervisor({ taskId: task.id, kind: "stalled", detail: label, subject: agentId });
}

export async function scanStalled(input: StallScan): Promise<void> {
  if (!input.agentActivity) return;
  const interval = input.intervalMs ?? input.config.stallIntervalMs ?? DEFAULT_STALL_INTERVAL_MS;
  const idleLimit = input.idleMs ?? input.config.stallIdleMs ?? DEFAULT_STALL_IDLE_MS;
  const nowMs = input.now.getTime();
  if (nowMs - lastStallAt < interval) return;
  lastStallAt = nowMs;
  const rows = getDb()
    .prepare(`SELECT id FROM tasks WHERE status IN ('running', 'reviewing') AND agent_id IS NOT NULL ORDER BY id`)
    .all() as unknown as Array<{ id: number }>;
  for (const row of rows) {
    await guardCard(row.id, "tick.stall", () => checkStalledCard(row.id, input, nowMs, idleLimit), input.now);
  }
}
