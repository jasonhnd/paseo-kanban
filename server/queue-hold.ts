import { getDb } from "./db";
import { appendEvent, setHold, type TaskRow } from "./store";

/** Record a producer-confirmed queue fact once per reason/kind and current status entry. */
export function noteQueueHold(task: TaskRow, kind: "quota" | "concurrency", reason: string,
  actor: string, details: Record<string, unknown> = {}): void {
  setHold(task.id, reason);
  const last = getDb().prepare(`SELECT h.id, h.data_json, COALESCE(s.id, c.id, 0) AS entry_id
    FROM tasks task
    LEFT JOIN events h ON h.id = (SELECT id FROM events WHERE task_id = task.id AND kind = 'held' ORDER BY id DESC LIMIT 1)
    LEFT JOIN events s ON s.id = (SELECT id FROM events WHERE task_id = task.id AND to_status = task.status
      AND from_status IS NOT NULL AND from_status != to_status ORDER BY id DESC LIMIT 1)
    LEFT JOIN events c ON c.id = (SELECT id FROM events WHERE task_id = task.id AND kind = 'created' ORDER BY id LIMIT 1)
    WHERE task.id = ?`).get(task.id) as { id: number | null; data_json: string | null; entry_id: number };
  if (last.id != null && last.id >= last.entry_id) {
    try {
      const prior = JSON.parse(last.data_json ?? '{}');
      if (prior.kind === kind && prior.reason === reason && prior.quotaWait === details.quotaWait) return;
    } catch { /* Replace unreadable evidence with the newly confirmed fact. */ }
  }
  appendEvent(task.id, "held", task.status, task.status, actor, { ...details, kind, reason });
}
