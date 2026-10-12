/// <reference types="node" />
import { getDb } from "./db";
import { appendEvent, blockTask, getTask, setHold, type TaskRow } from "./store";
import type { ReclaimEvidence } from "./reclaim-note";
import { revokeAgentToken } from "./tokens";
import type { Status } from "../shared/labels";
import { t } from "../shared/i18n";

export type FailureClass = "rate_limit" | "quota" | "credential" | "transient" | "other";

const COOLDOWN_MS = 5 * 60 * 1000;
const SUCCESS_END = new Set(["complete", "approve"]);

/** How many times a first-turn login blip may reopen the same profile. The next one blocks. */
export const LOGIN_BLIP_REOPENS = 2;

/** Keychain read failed at startup. Other authentication errors stay credentials. */
export function isLoginBlipSignal(text: string): boolean {
  return /not logged in/i.test(text) || /please run \/login/i.test(text) || /authentication_failed/i.test(text);
}

export interface ClassifyContext {
  /** This turn is the first round, or it ended inside nudgeGraceMs. */
  opening?: boolean;
  /** login_blip events already recorded in this streak, before the one being classified. */
  priorBlips?: number;
}

export function classifyFailure(message: string, code?: string, context?: ClassifyContext): FailureClass {
  const blob = `${code ?? ""} ${message}`;
  if (isLoginBlipSignal(blob)) {
    const prior = context?.priorBlips ?? 0;
    if (context?.opening === true && prior < LOGIN_BLIP_REOPENS) return "transient";
    return "credential";
  }
  const text = blob.toLowerCase();
  // Provider messages may be Chinese: \u9650\u6d41 "rate limited", \u51ed\u8bc1 "credentials", \u989d\u5ea6 "quota".
  if (/rate[\s_-]?limit|too many requests|\b429\b|resource exhausted|\u9650\u6d41/.test(text)) return "rate_limit";
  if (/unauthorized|invalid api key|authentication|\b401\b|forbidden|\b403\b|model[_\s-]?not[_\s-]?found|unknown model|does not exist|\u51ed\u8bc1|invalid_model/.test(text)) {
    return "credential";
  }
  if (/quota|insufficient|billing|credit|usage limit|spend limit|payment|\u989d\u5ea6/.test(text)) return "quota";
  return "other";
}

export function cooldownLabel(until: string, now: number): string {
  const ms = Date.parse(until) - now;
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return t("failures.cooldown", { minutes });
}

function endOpenRun(taskId: number, endKind: string, now: string): void {
  const open = getDb()
    .prepare(`SELECT id, agent_id FROM runs WHERE task_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get(taskId) as { id: number; agent_id: string | null } | undefined;
  if (!open) return;
  getDb().prepare(`UPDATE runs SET ended_at = ?, end_kind = ? WHERE id = ?`).run(now, endKind, open.id);
  revokeAgentToken(open.agent_id);
}

function queueTarget(task: TaskRow): Status {
  return task.status === "reviewing" ? "in_review" : "ready";
}

export function applyFailure(taskId: number, message: string, kind: FailureClass, now = new Date(), pool: string | null = null): "requeue" | "block" | "skip" {
  const task = getTask(taskId);
  if (task.status !== "running" && task.status !== "reviewing") return "skip";
  const ts = now.toISOString();
  endOpenRun(taskId, kind, ts);
  if (kind === "rate_limit" || kind === "quota") {
    const until = new Date(now.getTime() + COOLDOWN_MS).toISOString();
    const target = queueTarget(task);
    const agentId = target === "in_review" ? task.executor_agent_id : null;
    getDb()
      .prepare(
        `UPDATE tasks SET status = ?, agent_id = ?, blocked_kind = ?, blocked_reason = ?, cooldown_until = ?, hold_reason = ?, nudge_count = 0, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(target, agentId, kind, message, until, cooldownLabel(until, now.getTime()), ts, taskId, task.status);
    appendEvent(taskId, "requeued", task.status, target, "scheduler", { kind, cooldownUntil: until, counted: false, pool, message });
    return "requeue";
  }
  if (kind === "credential") {
    blockTask(taskId, "needs_human", message, "scheduler");
    appendEvent(taskId, "fused", task.status, "blocked", "scheduler", { kind, counted: false });
    return "block";
  }
  const nextCount = (task.fail_count ?? 0) + 1;
  getDb().prepare("UPDATE tasks SET fail_count = ? WHERE id = ?").run(nextCount, taskId);
  const limit = task.max_retries;
  if (nextCount >= limit) {
    blockTask(taskId, "needs_human", message, "scheduler");
    appendEvent(taskId, "fused", task.status, "blocked", "scheduler", { kind, failCount: nextCount, maxRetries: limit });
    return "block";
  }
  const target = queueTarget(task);
  const agentId = target === "in_review" ? task.executor_agent_id : null;
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, agent_id = ?, blocked_kind = NULL, blocked_reason = NULL, cooldown_until = NULL, hold_reason = ?, nudge_count = 0, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .run(target, agentId, t("failures.hold.requeued", { count: nextCount, limit }), ts, taskId, task.status);
  appendEvent(taskId, "requeued", task.status, target, "scheduler", { kind, failCount: nextCount, maxRetries: limit });
  return "requeue";
}

/** The pool that just rate-limited or ran out of quota, so the next start can leave it. */
export function avoidedPools(taskId: number): string[] {
  const row = getDb()
    .prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'requeued' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { data_json: string } | undefined;
  if (!row) return [];
  try {
    const data = JSON.parse(row.data_json) as { kind?: string; pool?: string | null };
    if ((data.kind === "rate_limit" || data.kind === "quota") && data.pool) return [data.pool];
  } catch {
    return [];
  }
  return [];
}

export function recentSuccess(taskId: number, role: string, now: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT ended_at, end_kind FROM runs WHERE task_id = ? AND role = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, role) as { ended_at: string; end_kind: string | null } | undefined;
  if (!row?.ended_at || !row.end_kind || !SUCCESS_END.has(row.end_kind)) return false;
  return now - Date.parse(row.ended_at) < COOLDOWN_MS;
}

/**
 * Agent vanished while the card is still running or in review. Does not count as a failure.
 * The evidence (who reclaimed, what the agent last ran) goes on the event; the next start quotes it (reclaim-note.ts).
 */
export function reclaimTask(taskId: number, now = new Date(), evidence?: ReclaimEvidence): "reclaimed" | "guarded" | "skip" {
  const task = getTask(taskId);
  if (task.status !== "running" && task.status !== "reviewing") return "skip";
  const role = task.status === "reviewing" ? "reviewer" : task.role;
  if (recentSuccess(taskId, role, now.getTime())) {
    setHold(taskId, t("failures.hold.recentSuccess"));
    appendEvent(taskId, "respawn_guarded", task.status, task.status, "scheduler", { reason: "recent_success" });
    return "guarded";
  }
  const ts = now.toISOString();
  endOpenRun(taskId, "reclaimed", ts);
  const target: Status = task.status === "reviewing" ? "in_review" : "ready";
  const agentId = target === "in_review" ? task.executor_agent_id : null;
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, agent_id = ?, cooldown_until = NULL, hold_reason = NULL, nudge_count = 0, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .run(target, agentId, ts, taskId, task.status);
  appendEvent(taskId, "reclaimed", task.status, target, "scheduler", { reason: "agent_gone", agentId: task.agent_id, ...evidence });
  return "reclaimed";
}

/**
 * Paseo is closing or reconnecting this plugin, for example during a reload:
 * the old instance says "Transport not connected (status: disposed)". The next tick usually starts fine.
 */
const PLUGIN_CLOSING = /transport (?:is )?not connected|transport (?:is )?closed|status:\s*(?:disposed|disposing|closing|reconnecting)|\bdisposed\b/i;

/** This many plugin-closing start errors in a row count as a real start failure. */
export const TRANSIENT_START_LIMIT = 3;

export function isPluginClosingError(message: string): boolean {
  return PLUGIN_CLOSING.test(message);
}

const START_KINDS = ["started", "resumed", "start_transient", "start_failed"] as const;

function lastStartEvent(taskId: number): { kind: string; streak: number } | null {
  const row = getDb()
    .prepare(`SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN (${START_KINDS.map(() => "?").join(", ")}) ORDER BY id DESC LIMIT 1`)
    .get(taskId, ...START_KINDS) as { kind: string; data_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.data_json) as { streak?: unknown };
    return { kind: row.kind, streak: typeof data.streak === "number" ? data.streak : 0 };
  } catch {
    return { kind: row.kind, streak: 0 };
  }
}

/**
 * Record a start that failed. A plugin-closing error adds one start_transient event and returns
 * how many came in a row since the last start or other failure. Any other error returns 0 and
 * adds one start_failed event per run of failures, so a card retried every tick does not flood events.
 */
export function noteStartFailure(taskId: number, message: string): number {
  const last = lastStartEvent(taskId);
  if (!isPluginClosingError(message)) {
    if (last?.kind !== "start_failed") appendEvent(taskId, "start_failed", null, null, "scheduler", { message });
    return 0;
  }
  const streak = (last?.kind === "start_transient" ? last.streak : 0) + 1;
  appendEvent(taskId, "start_transient", null, null, "scheduler", { message, streak, limit: TRANSIENT_START_LIMIT });
  return streak;
}
