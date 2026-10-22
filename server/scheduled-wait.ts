/// <reference types="node" />
import { randomUUID } from "node:crypto";
import type { PaseoAgentSendOptions } from "@getpaseo/client";
import { t } from "../shared/i18n";
import { deliverWake, hasWakeSender } from "./bus";
import { getDb } from "./db";
import { EXTERNAL_CALL_TIMEOUT_MS, guardCard, withTimeout } from "./guard";
import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";
import { appendEvent, getTask, releaseSameScheduled, resumableAgentId } from "./store";
import { releaseSameBackground } from "./task-lifecycle";
import type { TaskRow } from "./task-record";

type Send = (agentId: string, text: string, options?: PaseoAgentSendOptions) => Promise<void>;
export const SCHEDULED_CLAIM_MS = 60_000;

/** Durable deadlines and message IDs survive restarts; a lease serializes asynchronous ticks. */
export async function resumeScheduledWaits(now: Date, send?: Send): Promise<void> {
  return resumePersistedWaits("scheduled", now, send);
}

/** Background completion shares scheduled waits' durable receipt, lease and compare-and-set release. */
export async function resumePersistedWaits(
  kind: "scheduled" | "background", now: Date, send?: Send, completion?: (task: TaskRow) => string | null,
): Promise<void> {
  const rows = getDb().prepare(`SELECT id FROM tasks WHERE status = 'blocked' AND blocked_kind = ?
    AND (? = 'background' OR scheduled_until <= ?) ORDER BY id`).all(kind, kind, now.toISOString()) as Array<{ id: number }>;
  for (const { id } of rows) {
    await guardCard(id, `tick.${kind}Wait`, async () => {
      const task = getTask(id);
      if (task.status !== "blocked" || task.blocked_kind !== kind || !task.scheduled_wake_id) return;
      if (kind === "scheduled" && (!task.scheduled_until || Date.parse(task.scheduled_until) > now.getTime())) return;
      const resultText = completion ? completion(task) : task.scheduled_wake_text;
      if (!resultText) return;
      const agentId = resumableAgentId(task);
      if (agentId) {
        const missing = agentCwdMissing(agentId);
        if (missing) {
          noteWakeSkipped(id, agentId, missing, `${kind}_wait`);
          return;
        }
        if (!send && !hasWakeSender()) return;
      }
      const claim = randomUUID();
      const clock = Date.now();
      const lease = new Date(clock + Math.max(SCHEDULED_CLAIM_MS, EXTERNAL_CALL_TIMEOUT_MS * 2)).toISOString();
      const claimed = getDb().prepare(`UPDATE tasks SET scheduled_claim_id = ?, scheduled_claim_until = ?
        WHERE id = ? AND status = 'blocked' AND blocked_kind = ? AND scheduled_wake_id = ?
        AND (scheduled_claim_until IS NULL OR scheduled_claim_until <= ?)`)
        .run(claim, lease, id, kind, task.scheduled_wake_id, new Date(clock).toISOString());
      if (claimed.changes !== 1) return;
      try {
        // Freeze the exact result before sending. Retries keep both receipt and text after a restart.
        getDb().prepare("UPDATE tasks SET scheduled_wake_text = COALESCE(scheduled_wake_text, ?) WHERE id = ? AND scheduled_claim_id = ?")
          .run(resultText, id, claim);
        const text = getTask(id).scheduled_wake_text!;
        if (agentId) {
          // The daemon deduplicates messageId. After an interrupted/ambiguous send a retry uses
          // the same persisted ID, including across board restarts, rather than starting a new turn.
          const options = { messageId: task.scheduled_wake_id };
          const accepted = await withTimeout(async () => {
            if (send) { await send(agentId, text, options); return true; }
            return deliverWake(agentId, text, options);
          }, t("scheduled.timeout.send"));
          if (!accepted) return;
        }
        const release = kind === "scheduled" ? releaseSameScheduled : releaseSameBackground;
        const after = release(id, "scheduler", {
          blockedAt: task.blocked_at ?? "", agentId: task.agent_id, wakeId: task.scheduled_wake_id,
        }, { via: `${kind}_wait`, until: task.scheduled_until, messageId: task.scheduled_wake_id });
        if (after) appendEvent(id, `${kind}_resumed`, "blocked", after.status, "scheduler", {
          until: task.scheduled_until, messageId: task.scheduled_wake_id, agentId, sent: Boolean(agentId),
        });
      } finally {
        getDb().prepare(`UPDATE tasks SET scheduled_claim_id = NULL, scheduled_claim_until = NULL
          WHERE id = ? AND scheduled_claim_id = ?`).run(id, claim);
      }
    }, now);
  }
}
