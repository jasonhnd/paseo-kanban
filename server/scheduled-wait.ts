/// <reference types="node" />
import { randomUUID } from "node:crypto";
import type { PaseoAgentSendOptions } from "@getpaseo/client";
import { t } from "../shared/i18n";
import { deliverWake, hasWakeSender } from "./bus";
import { getDb } from "./db";
import { EXTERNAL_CALL_TIMEOUT_MS, guardCard, withTimeout } from "./guard";
import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";
import { appendEvent, getTask, releaseSameScheduled, resumableAgentId } from "./store";

type Send = (agentId: string, text: string, options?: PaseoAgentSendOptions) => Promise<void>;
export const SCHEDULED_CLAIM_MS = 60_000;

/** Durable deadlines and message IDs survive restarts; a lease serializes asynchronous ticks. */
export async function resumeScheduledWaits(now: Date, send?: Send): Promise<void> {
  const rows = getDb().prepare(`SELECT id FROM tasks WHERE status = 'blocked' AND blocked_kind = 'scheduled'
    AND scheduled_until <= ? ORDER BY id`).all(now.toISOString()) as Array<{ id: number }>;
  for (const { id } of rows) {
    await guardCard(id, "tick.scheduledWait", async () => {
      const task = getTask(id);
      if (task.status !== "blocked" || task.blocked_kind !== "scheduled" || !task.scheduled_wake_id || !task.scheduled_until) return;
      if (Date.parse(task.scheduled_until) > now.getTime()) return;
      const agentId = resumableAgentId(task);
      if (agentId) {
        const missing = agentCwdMissing(agentId);
        if (missing) {
          noteWakeSkipped(id, agentId, missing, "scheduled_wait");
          return;
        }
        if (!send && !hasWakeSender()) return;
      }
      const claim = randomUUID();
      const clock = Date.now();
      const lease = new Date(clock + Math.max(SCHEDULED_CLAIM_MS, EXTERNAL_CALL_TIMEOUT_MS * 2)).toISOString();
      const claimed = getDb().prepare(`UPDATE tasks SET scheduled_claim_id = ?, scheduled_claim_until = ?
        WHERE id = ? AND status = 'blocked' AND blocked_kind = 'scheduled' AND scheduled_wake_id = ?
        AND (scheduled_claim_until IS NULL OR scheduled_claim_until <= ?)`)
        .run(claim, lease, id, task.scheduled_wake_id, new Date(clock).toISOString());
      if (claimed.changes !== 1) return;
      try {
        if (agentId) {
          // The daemon deduplicates messageId. After an interrupted/ambiguous send a retry uses
          // the same persisted ID, including across board restarts, rather than starting a new turn.
          const options = { messageId: task.scheduled_wake_id };
          const text = t("scheduled.wake", { until: task.scheduled_until });
          const accepted = await withTimeout(async () => {
            if (send) { await send(agentId, text, options); return true; }
            return deliverWake(agentId, text, options);
          }, t("scheduled.timeout.send"));
          if (!accepted) return;
        }
        const after = releaseSameScheduled(id, "scheduler", {
          blockedAt: task.blocked_at ?? "", agentId: task.agent_id, wakeId: task.scheduled_wake_id,
        }, { via: "scheduled_wait", until: task.scheduled_until, messageId: task.scheduled_wake_id });
        if (after) appendEvent(id, "scheduled_resumed", "blocked", after.status, "scheduler", {
          until: task.scheduled_until, messageId: task.scheduled_wake_id, agentId, sent: Boolean(agentId),
        });
      } finally {
        getDb().prepare(`UPDATE tasks SET scheduled_claim_id = NULL, scheduled_claim_until = NULL
          WHERE id = ? AND scheduled_claim_id = ?`).run(id, claim);
      }
    }, now);
  }
}
