/// <reference types="node" />
import { deliverWake } from "./bus";
import { DEFAULT_RESTART_STALL_GRACE_MS, DEFAULT_STALL_IDLE_MS, DEFAULT_STALL_INTERVAL_MS, type KanbanConfig } from "./config";
import { currentEpisode, markRestartApplied, observeDaemon, rememberEpisode, restartWasApplied, type DaemonEpisode } from "./daemon-log";
import { getDb } from "./db";
import { reclaimTask } from "./failures";
import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";
import { isProjectDormant } from "./paused";
import { stallLabel } from "./stall";
import { appendEvent, getTask, stallNoteFor } from "./store";
import { wakeKanbanSupervisor } from "./wake";
import { guardCard, withTimeout } from "./guard";
import { t } from "../shared/i18n";

/** Sent to an agent whose turn a daemon restart cut off. */
export function restartInterrupt(): string {
  return t("restartStall.interrupt");
}
/** The board banner goes away an hour after the restart. */
export const RESTART_BOARD_TTL_MS = 60 * 60 * 1000;

let lastRestartScanAt = Number.NEGATIVE_INFINITY;

export function resetRestartScanForTests(): void {
  lastRestartScanAt = Number.NEGATIVE_INFINITY;
}

interface PriorRestart {
  sent: boolean;
  at: string;
}

function priorRestart(taskId: number, agentId: string, episodeId: string): PriorRestart | null {
  const rows = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'stalled_after_restart' ORDER BY id DESC`)
    .all(taskId) as unknown as Array<{ data_json: string }>;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { agentId?: string; restartAt?: string; sent?: boolean; at?: string };
      if (data.agentId !== agentId || data.restartAt !== episodeId) continue;
      return { sent: data.sent === true, at: typeof data.at === "string" ? data.at : "" };
    } catch {
      continue;
    }
  }
  return null;
}

function handledCount(episodeId: string): number {
  const rows = getDb().prepare(`SELECT task_id, data_json FROM events WHERE kind = 'stalled_after_restart'`).all() as unknown as Array<{
    task_id: number;
    data_json: string;
  }>;
  const ids = new Set<number>();
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { restartAt?: string };
      if (data.restartAt === episodeId) ids.add(row.task_id);
    } catch {
      continue;
    }
  }
  return ids.size;
}

export function formatRestartClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "--:--";
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function restartBoardText(at: string, count: number): string {
  return t("restartStall.board", { clock: formatRestartClock(at), count });
}

/** Shown after the grace has passed and at least one card was handled. Hidden again after an hour. */
export function restartBoardMessage(now = Date.now()): string | null {
  const episode = currentEpisode();
  if (!episode || !restartWasApplied(episode.id)) return null;
  const atMs = Date.parse(episode.at);
  if (Number.isNaN(atMs) || now < atMs || now >= atMs + RESTART_BOARD_TTL_MS) return null;
  const count = handledCount(episode.id);
  if (count === 0) return null;
  return restartBoardText(episode.at, count);
}

async function clockOf(read: (agentId: string) => Promise<string | null> | string | null, agentId: string): Promise<string | null> {
  try {
    const value = await read(agentId);
    return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
  } catch (err) {
    console.error("[paseo-kanban] restart", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * After a daemon restart, a card still marked running can be dead.
 * One restart and one card are handled once: nudge when the directory is
 * still there, otherwise reclaim or wake. Ten quiet minutes after the nudge
 * follows the same stall escalation.
 */
export async function scanRestartStalls(input: {
  now: Date;
  config: KanbanConfig;
  graceMs?: number;
  idleMs?: number;
  lastActivity: (agentId: string) => Promise<string | null> | string | null;
  send?: (agentId: string, text: string) => Promise<void>;
  /** Same cadence as the idle stall scan. Defaults to stallIntervalMs. */
  intervalMs?: number;
  /** Undefined reads the daemon log. Null means no restart was seen. */
  episode?: DaemonEpisode | null;
  cwdMissing?: (agentId: string) => string | null;
}): Promise<void> {
  const episode = input.episode === undefined ? observeDaemon().episode : input.episode;
  if (!episode) return;
  if (input.episode !== undefined) rememberEpisode(episode);
  const restartMs = Date.parse(episode.at);
  if (Number.isNaN(restartMs)) return;
  const grace = input.graceMs ?? input.config.restartStallGraceMs ?? DEFAULT_RESTART_STALL_GRACE_MS;
  const idleLimit = input.idleMs ?? input.config.stallIdleMs ?? DEFAULT_STALL_IDLE_MS;
  const nowMs = input.now.getTime();
  if (nowMs < restartMs + grace) return;
  const interval = input.intervalMs ?? input.config.stallIntervalMs ?? DEFAULT_STALL_INTERVAL_MS;
  if (nowMs - lastRestartScanAt < interval) return;
  lastRestartScanAt = nowMs;
  markRestartApplied(episode.id);
  const rows = getDb()
    .prepare(`SELECT id FROM tasks WHERE status IN ('running', 'reviewing') AND agent_id IS NOT NULL ORDER BY id`)
    .all() as unknown as Array<{ id: number }>;
  const missingOf = input.cwdMissing ?? agentCwdMissing;
  const scanOne = async (rowId: number): Promise<void> => {
    const task = getTask(rowId);
    if ((task.status !== "running" && task.status !== "reviewing") || !task.agent_id) return;
    if (isProjectDormant(task.project)) return;
    const agentId = task.agent_id;
    const prior = priorRestart(task.id, agentId, episode.id);
    const lastAt = await clockOf(input.lastActivity, agentId);
    const lastMs = lastAt ? Date.parse(lastAt) : Number.NaN;
    if (prior) {
      if (!prior.sent) return;
      const nudgedMs = Date.parse(prior.at);
      if (Number.isNaN(nudgedMs) || nowMs - nudgedMs < idleLimit) return;
      if (!lastAt || Number.isNaN(lastMs) || lastMs > nudgedMs) return;
      const label = stallLabel(nowMs - lastMs);
      if (stallNoteFor({ id: task.id, status: task.status, agent_id: agentId }) == null) {
        appendEvent(task.id, "stalled", task.status, task.status, "scheduler", {
          agentId,
          text: label,
          at: input.now.toISOString(),
        });
      }
      wakeKanbanSupervisor({ taskId: task.id, kind: "stalled", detail: label, subject: `${agentId}:${episode.id}` });
      return;
    }
    if (!lastAt || Number.isNaN(lastMs) || lastMs >= restartMs) return;
    const missing = missingOf(agentId);
    if (missing) {
      noteWakeSkipped(task.id, agentId, missing, "restart");
      const outcome = reclaimTask(task.id, input.now);
      appendEvent(task.id, "stalled_after_restart", task.status, getTask(task.id).status, "scheduler", {
        agentId,
        restartAt: episode.id,
        at: input.now.toISOString(),
        sent: false,
        action: outcome,
        missingCwd: missing,
      });
      if (outcome !== "reclaimed") {
        wakeKanbanSupervisor({
          taskId: task.id,
          kind: "stalled",
          detail: t("restartStall.wake.cwdMissing"),
          subject: `${agentId}:${episode.id}`,
        });
      }
      return;
    }
    try {
      if (input.send) await withTimeout(() => input.send!(agentId, restartInterrupt()), t("restartStall.call.send"));
      else deliverWake(agentId, restartInterrupt());
    } catch (err) {
      console.error("[paseo-kanban] restart", err instanceof Error ? err.message : err);
      return;
    }
    appendEvent(task.id, "stalled_after_restart", task.status, task.status, "scheduler", {
      agentId,
      restartAt: episode.id,
      text: restartInterrupt(),
      at: input.now.toISOString(),
      sent: true,
    });
  };
  for (const row of rows) {
    await guardCard(row.id, "tick.restartStall", () => scanOne(row.id), input.now);
  }
}
