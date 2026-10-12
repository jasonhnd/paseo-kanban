/// <reference types="node" />
import { t } from "../shared/i18n";
import { deliverWake, hasWakeSender } from "./bus";
import { cardMark } from "./card-ref";
import {
  DEFAULT_TRANSIENT_RETRY_LIMIT,
  DEFAULT_TRANSIENT_RETRY_MINUTES,
  type KanbanConfig,
} from "./config";
import { getDb } from "./db";
import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";
import { appendEvent, getTask, releaseSameTransient, resumableAgentId, type TaskRow } from "./store";
import { triageRecipient } from "./wake";
import { withTimeout } from "./guard";

/** Sent back to the agent that is still on the card. */
export function transientReviewPrompt(): string {
  return t("transientRetry.reviewPrompt");
}

/** Later waits never grow past this. */
export const TRANSIENT_RETRY_CAP_MS = 2 * 60 * 60 * 1000;

type Send = (agentId: string, text: string) => Promise<void> | void;

interface EventRow {
  kind: string;
  data_json: string;
}

function readData(raw: string): { kind?: unknown; via?: unknown } {
  try {
    const data = JSON.parse(raw) as { kind?: unknown; via?: unknown };
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/**
 * Retries already handed back in this waiting episode, and whether the leader was already told.
 * A replacement agent (`started` / `claim` / `resumed`) does not end the episode.
 * A manual unblock, or a block of another kind, does.
 */
export function transientStreak(rowsNewestFirst: EventRow[]): { retries: number; exhausted: boolean } {
  let retries = 0;
  let exhausted = false;
  for (const row of rowsNewestFirst) {
    const data = readData(row.data_json);
    if (row.kind === "transient_retry") {
      retries += 1;
      continue;
    }
    if (row.kind === "transient_exhausted") {
      exhausted = true;
      continue;
    }
    if (row.kind === "blocked") {
      if (data.kind === "transient") continue;
      break;
    }
    if (row.kind === "unblocked") {
      if (data.via === "transient_retry") continue;
      break;
    }
  }
  return { retries, exhausted };
}

export function transientRetryMinutesOf(config: KanbanConfig): number {
  const value = config.transientRetryMinutes;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_TRANSIENT_RETRY_MINUTES;
}

export function transientRetryLimitOf(config: KanbanConfig): number {
  const value = config.transientRetryLimit;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : DEFAULT_TRANSIENT_RETRY_LIMIT;
}

/** Wait before the next check. `priorRetries` is how many times this streak was already handed back. */
export function transientRetryDelayMs(priorRetries: number, baseMinutes: number): number {
  const attempt = Math.max(0, Math.floor(priorRetries));
  if (attempt >= 16) return TRANSIENT_RETRY_CAP_MS;
  const baseMs = baseMinutes * 60_000;
  return Math.min(baseMs * 2 ** attempt, TRANSIENT_RETRY_CAP_MS);
}

function streakOf(taskId: number): { retries: number; exhausted: boolean } {
  const rows = getDb()
    .prepare(`SELECT kind, data_json FROM events WHERE task_id = ? ORDER BY id DESC`)
    .all(taskId) as unknown as EventRow[];
  return transientStreak(rows);
}

function leaderText(task: TaskRow, limit: number): string {
  return [
    `${cardMark(task.id)} ${task.title}`,
    t("transientRetry.leader.project", { project: task.project }),
    t("transientRetry.leader.rechecked", { limit }),
    t("transientRetry.leader.reason", { reason: task.blocked_reason ?? "" }),
    t("transientRetry.leader.look"),
  ].join("\n");
}

async function deliver(agentId: string, text: string, send?: Send): Promise<void> {
  if (send) {
    await withTimeout(() => send(agentId, text), t("transientRetry.timeout.send"));
    return;
  }
  deliverWake(agentId, text);
}

async function escalate(task: TaskRow, config: KanbanConfig, limit: number, send?: Send): Promise<void> {
  const who = triageRecipient(task.project, config);
  if (!who) return;
  const missing = agentCwdMissing(who);
  if (missing) {
    noteWakeSkipped(task.id, who, missing, "transient_exhausted");
    return;
  }
  if (!send && !hasWakeSender()) return;
  const text = leaderText(task, limit);
  try {
    await deliver(who, text, send);
  } catch (err) {
    console.error("[paseo-kanban] transient retry", err instanceof Error ? err.message : err);
    return;
  }
  // Delivery can yield while someone unblocks, reblocks, or replaces the agent.
  // The old notification must not exhaust the new waiting episode.
  const current = getTask(task.id);
  if (current.status !== "blocked" || current.blocked_kind !== "transient") return;
  if (current.blocked_at !== task.blocked_at || current.agent_id !== task.agent_id) return;
  appendEvent(task.id, "transient_exhausted", "blocked", "blocked", "scheduler", {
    agentId: who,
    limit,
    reason: task.blocked_reason,
    text,
  });
}

async function handBack(task: TaskRow, attempt: number, send?: Send): Promise<void> {
  const held = { blockedAt: task.blocked_at ?? "", agentId: task.agent_id ?? null };
  if (!held.blockedAt) return;
  const agentId = resumableAgentId(task);
  if (agentId) {
    const missing = agentCwdMissing(agentId);
    if (missing) {
      noteWakeSkipped(task.id, agentId, missing, "transient_retry");
      return;
    }
    if (!send && !hasWakeSender()) return;
    try {
      await deliver(agentId, transientReviewPrompt(), send);
    } catch (err) {
      console.error("[paseo-kanban] transient retry", err instanceof Error ? err.message : err);
      return;
    }
  }
  const after = releaseSameTransient(task.id, "scheduler", held, { via: "transient_retry", attempt });
  if (!after) return;
  appendEvent(after.id, "transient_retry", "blocked", after.status, "scheduler", {
    attempt,
    agentId: agentId ?? null,
    sent: Boolean(agentId),
  });
}

/** Due transient blocks are handed back, or the project leader is woken once the limit is spent. */
export async function retryTransientBlocks(now: Date, config: KanbanConfig, send?: Send): Promise<void> {
  const rows = getDb()
    .prepare(`SELECT id FROM tasks WHERE status = 'blocked' AND blocked_kind = 'transient' ORDER BY id ASC`)
    .all() as unknown as Array<{ id: number }>;
  const minutes = transientRetryMinutesOf(config);
  const limit = transientRetryLimitOf(config);
  for (const row of rows) {
    const task = getTask(row.id);
    if (task.status !== "blocked" || task.blocked_kind !== "transient") continue;
    const blockedAt = Date.parse(task.blocked_at ?? "");
    if (Number.isNaN(blockedAt)) continue;
    const streak = streakOf(task.id);
    if (streak.exhausted) continue;
    const delay = transientRetryDelayMs(streak.retries, minutes);
    if (now.getTime() < blockedAt + delay) continue;
    try {
      if (streak.retries >= limit) {
        await escalate(task, config, limit, send);
        continue;
      }
      await handBack(task, streak.retries + 1, send);
    } catch (err) {
      console.error("[paseo-kanban] transient retry", err instanceof Error ? err.message : err);
    }
  }
}
