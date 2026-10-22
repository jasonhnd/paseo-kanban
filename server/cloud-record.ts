import { getDb } from "./db";
import type { TaskRow } from "./task-record";

export interface CloudRunRecord {
  generation: number;
  machine: string;
  branch: string;
  repo: string;
  base: string;
  mirror: string;
  originalPath: string | null;
  originalKind: string | null;
  runId: number;
  ownerPid?: number;
}

export function cloudEvent<T>(id: number, kind: string): T | null {
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(id, kind) as { data_json: string } | undefined;
  try { return row ? JSON.parse(row.data_json) as T : null; } catch { return null; }
}

export function cloudRunRecord(id: number): CloudRunRecord | null { return cloudEvent(id, "cloud_run_started"); }
export function isCloudRunning(task: Pick<TaskRow, "id" | "status">): boolean {
  if (task.status !== "running") return false;
  const run = cloudRunRecord(task.id);
  if (!run || cloudEvent<{ generation: number }>(task.id, "cloud_run_settled")?.generation === run.generation) return false;
  const current = getDb().prepare("SELECT agent_id FROM tasks WHERE id = ?").get(task.id) as { agent_id: string | null } | undefined;
  const latest = getDb().prepare("SELECT id FROM runs WHERE task_id = ? AND role = 'executor' ORDER BY id DESC LIMIT 1").get(task.id) as { id: number } | undefined;
  return current?.agent_id === null && latest?.id === run.runId;
}

export interface CloudDelivery extends CloudRunRecord { head: string; baseHead: string; pr: string; files: string[]; verification?: string[] }
export function cloudDelivery(id: number): CloudDelivery | null { return cloudEvent(id, "cloud_delivery"); }

/** A host-stamped delivery binds a non-Paseo run to exactly the reviewed model and commit. */
export function isCloudDeliveryRun(id: number, runId: number): boolean {
  const delivery = cloudDelivery(id);
  return delivery?.runId === runId && /^[0-9a-f]{40,64}$/.test(delivery.head) &&
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(delivery.pr);
}
