/// <reference types="node" />
import { t } from "../shared/i18n";
import { DEFAULT_LOGIN_BLIP_RETRY_MS, loadConfig } from "./config";
import { getDb } from "./db";
import { cooldownLabel, isLoginBlipSignal, LOGIN_BLIP_REOPENS } from "./failures";
import { turnIsOpening } from "./flow";
import { blockTask, appendEvent, getTask } from "./store";
import { revokeAgentToken } from "./tokens";

export function loginBlipReason(): string {
  return t("loginBlip.reason");
}

function unwrapTimelineItem(entry: unknown): unknown {
  if (entry && typeof entry === "object" && "item" in entry) return (entry as { item: unknown }).item;
  return entry;
}

function errorText(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (!error || typeof error !== "object") return null;
  const record = error as { message?: unknown; code?: unknown };
  const message = typeof record.message === "string" ? record.message : "";
  const code = typeof record.code === "string" ? record.code : "";
  const text = `${code} ${message}`.trim();
  return text || null;
}

/** Text of one timeline item. User messages are skipped: the opening prompt can quote these phrases. */
function timelineItemText(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as { type?: unknown; message?: unknown; text?: unknown; status?: unknown; error?: unknown };
  if (record.type === "user_message") return null;
  if (record.type === "error" || record.type === "notification") {
    return typeof record.message === "string" && record.message.trim() ? record.message.trim() : null;
  }
  if (record.type === "assistant_message") {
    return typeof record.text === "string" && record.text.trim() ? record.text.trim() : null;
  }
  if (record.type === "tool_call" && record.status === "failed") return errorText(record.error);
  return null;
}

/**
 * Last non-user line on this turn's timeline.
 * Entries may be timeline items or `{ item }` rows from a timeline page.
 */
export function endNoteFromTimeline(timeline: unknown): string | null {
  if (!Array.isArray(timeline)) return null;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const text = timelineItemText(unwrapTimelineItem(timeline[i]));
    if (text) return text;
  }
  return null;
}

/** `outcome.error` from agent.turn_ended. A completed turn has none. */
export function endNoteFromOutcome(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object" || !("error" in outcome)) return null;
  return errorText((outcome as { error?: unknown }).error);
}

/** End reason already on this turn. Null means it was not on the outcome or the timeline. */
export function endNoteOf(outcome: unknown, timeline: unknown): string | null {
  return endNoteFromOutcome(outcome) ?? endNoteFromTimeline(timeline);
}

function parseData(raw: string): { agentId?: string; attempt?: number; profile?: string } {
  try {
    const data = JSON.parse(raw) as { agentId?: unknown; attempt?: unknown; profile?: unknown };
    return {
      agentId: typeof data.agentId === "string" ? data.agentId : undefined,
      attempt: typeof data.attempt === "number" ? data.attempt : undefined,
      profile: typeof data.profile === "string" ? data.profile : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Which occurrence this blip is.
 * The streak continues only when the current agent is the single reopen after the previous blip.
 * Any other start in between begins again at 1.
 */
export function nextLoginBlipAttempt(taskId: number, agentId: string): number {
  const rows = getDb()
    .prepare(
      `SELECT kind, data_json FROM events WHERE task_id = ? AND kind IN ('login_blip', 'started', 'resumed') ORDER BY id DESC`,
    )
    .all(taskId) as Array<{ kind: string; data_json: string }>;
  let starts = 0;
  let startAgent: string | null = null;
  for (const row of rows) {
    const data = parseData(row.data_json);
    if (row.kind === "started" || row.kind === "resumed") {
      starts += 1;
      if (starts === 1) startAgent = data.agentId ?? null;
      continue;
    }
    const attempt = data.attempt && data.attempt > 0 ? data.attempt : 1;
    if (starts === 1 && startAgent === agentId) return attempt + 1;
    return 1;
  }
  return 1;
}

/** Profile to reopen with, until that reopen has started. The blocking blip does not pin one. */
export function loginBlipProfile(taskId: number): string | null {
  const row = getDb()
    .prepare(`SELECT id, data_json FROM events WHERE task_id = ? AND kind = 'login_blip' ORDER BY id DESC LIMIT 1`)
    .get(taskId) as { id: number; data_json: string } | undefined;
  if (!row) return null;
  const data = parseData(row.data_json);
  if (!data.profile) return null;
  if ((data.attempt ?? 1) > LOGIN_BLIP_REOPENS) return null;
  const started = getDb()
    .prepare(`SELECT id FROM events WHERE task_id = ? AND kind IN ('started', 'resumed') AND id > ? LIMIT 1`)
    .get(taskId, row.id);
  if (started) return null;
  return data.profile;
}

function runProfile(taskId: number, agentId: string): string | null {
  const row = getDb()
    .prepare(`SELECT profile_name FROM runs WHERE task_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId, agentId) as { profile_name: string | null } | undefined;
  return row?.profile_name ?? null;
}

function endOpenRun(taskId: number, now: string): void {
  const open = getDb()
    .prepare(`SELECT id, agent_id FROM runs WHERE task_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get(taskId) as { id: number; agent_id: string | null } | undefined;
  if (!open) return;
  getDb().prepare(`UPDATE runs SET ended_at = ?, end_kind = ? WHERE id = ?`).run(now, "transient", open.id);
  revokeAgentToken(open.agent_id);
}

/**
 * Record this opening login blip.
 * The first two reopen after loginBlipRetryMs. The third blocks and the blocked listener wakes the supervisor.
 */
export function applyLoginBlip(taskId: number, agentId: string, attempt: number, now = new Date()): "requeue" | "block" | "skip" {
  const task = getTask(taskId);
  if (task.status !== "running" && task.status !== "reviewing") return "skip";
  const ts = now.toISOString();
  const profile = runProfile(taskId, agentId);
  endOpenRun(taskId, ts);
  const block = attempt > LOGIN_BLIP_REOPENS;
  const target = block ? "blocked" : task.status === "reviewing" ? "in_review" : "ready";
  appendEvent(taskId, "login_blip", task.status, target, "scheduler", {
    agentId,
    attempt,
    ...(profile ? { profile } : {}),
  });
  if (block) {
    blockTask(taskId, "needs_human", loginBlipReason(), "scheduler");
    return "block";
  }
  const retryMs = loadConfig().loginBlipRetryMs ?? DEFAULT_LOGIN_BLIP_RETRY_MS;
  const until = new Date(now.getTime() + retryMs).toISOString();
  const nextAgent = target === "in_review" ? task.executor_agent_id : null;
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, agent_id = ?, blocked_kind = ?, blocked_reason = ?, cooldown_until = ?, hold_reason = ?, nudge_count = 0, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .run(
      target,
      nextAgent,
      "transient",
      t("loginBlip.reopenLater"),
      until,
      cooldownLabel(until, now.getTime()),
      ts,
      taskId,
      task.status,
    );
  return "requeue";
}

export async function settleOpeningLoginBlip(input: {
  taskId: number;
  agentId: string;
  outcome?: unknown;
  timeline?: unknown;
  /** Undefined reads the agent file. Null means this agent has no user message yet. */
  lastUserMessageAt?: string | null;
  now?: Date;
  /** Used only when the turn itself has no end note. */
  readNote?: () => Promise<string | null> | string | null;
  archive?: (agentId: string) => Promise<void>;
}): Promise<"requeue" | "block" | "ignore"> {
  let note = endNoteOf(input.outcome, input.timeline);
  if (!note && input.readNote) note = await input.readNote();
  if (!note || !isLoginBlipSignal(note)) return "ignore";
  const now = input.now ?? new Date();
  if (!turnIsOpening(input.taskId, input.lastUserMessageAt, now.getTime())) return "ignore";
  const result = applyLoginBlip(input.taskId, input.agentId, nextLoginBlipAttempt(input.taskId, input.agentId), now);
  if (result === "skip") return "ignore";
  if (result === "requeue" && input.archive) {
    try {
      await input.archive(input.agentId);
    } catch (err) {
      console.error("[paseo-kanban] login", err instanceof Error ? err.message : err);
    }
  }
  return result;
}
