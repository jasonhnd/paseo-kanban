import { getDb } from "../../server/db";

/** Completed anonymous work evidence for fixtures that put an executor into review directly. */
export function recordFixtureDelivery(id: number, model: string): void {
  const db = getDb();
  const task = db.prepare("SELECT role, executor_agent_id FROM tasks WHERE id = ?").get(id) as { role: string; executor_agent_id: string | null };
  if (db.prepare("SELECT id FROM runs WHERE task_id = ? AND role = ? AND model IS NOT NULL").get(id, task.role)) return;
  db.prepare("INSERT INTO runs (task_id, agent_id, role, provider, model, started_at, ended_at, end_kind) VALUES (?, ?, ?, 'demo', ?, ?, ?, 'complete')")
    .run(id, task.executor_agent_id ?? `fixture-worker-${id}`, task.role, model, "2026-10-01T00:00:00Z", "2026-10-01T00:01:00Z");
}
