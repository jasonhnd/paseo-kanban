import { getDb } from "./db";
import type { TaskRow } from "./task-record";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadConfig } from "./config";
import { LOCAL_MIRROR_PROJECTS } from "./cloud-config";

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
  source?: "publicGithub" | "localMirror";
  project?: string;
  repoRoot?: string;
  sourceBase?: string;
  snapshotCommit?: string;
  tree?: string;
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

/** Existing public events have no kind discriminator and still require their PR receipt. */
export interface CloudDelivery extends CloudRunRecord { kind?: "public"; head: string; baseHead: string; pr: string; files: string[]; verification?: string[] }
export interface LocalCloudReceipt {
  kind: "local";
  project: string;
  repoRoot: string;
  sourceBase: string;
  snapshotCommit: string;
  tree: string;
  cloudHead: string;
  /** The replayed commit on the real local base, never the anonymous cloud commit. */
  localHead: string;
  runId: number;
  generation: number;
}
export type CloudReceipt = CloudDelivery | LocalCloudReceipt;
const hash = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const localReceiptSchema = z.object({
  kind: z.literal("local"), project: z.string().refine(value => LOCAL_MIRROR_PROJECTS.some(project => project === value)),
  repoRoot: z.string().refine(value => isAbsolute(value) && !value.includes("\0") && resolve(value) === value),
  sourceBase: hash, snapshotCommit: hash, tree: hash, cloudHead: hash, localHead: hash, runId: positive, generation: positive,
}).strict().refine(value => value.cloudHead !== value.snapshotCommit && value.localHead !== value.cloudHead &&
  [value.snapshotCommit, value.tree, value.cloudHead, value.localHead].every(id => id.length === value.sourceBase.length));
const publicReceiptSchema = z.object({
  kind: z.literal("public").optional(), generation: positive, runId: positive, head: hash, baseHead: hash,
  pr: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/),
  machine: z.string(), branch: z.string(), repo: z.string(), base: z.string(), mirror: z.string(),
  originalPath: z.string().nullable(), originalKind: z.string().nullable(), ownerPid: positive.optional(),
  files: z.array(z.string()), verification: z.array(z.string()).optional(),
}).passthrough();

/** Parse untrusted/restarted events without upgrading legacy public events into local authority. */
export function parseCloudReceipt(value: unknown): CloudReceipt | null {
  if (value && typeof value === "object" && "kind" in value && value.kind === "local") {
    const parsed = localReceiptSchema.safeParse(value); return parsed.success ? parsed.data : null;
  }
  const parsed = publicReceiptSchema.safeParse(value); return parsed.success ? parsed.data : null;
}
export function cloudReceipt(id: number): CloudReceipt | null { return parseCloudReceipt(cloudEvent(id, "cloud_delivery")); }
/** Kept public-only so old runner consumers cannot accidentally review cloudHead as a local delivery. */
export function cloudDelivery(id: number): CloudDelivery | null {
  const receipt = cloudReceipt(id); return receipt?.kind !== "local" ? receipt : null;
}
export function localCloudReceipt(id: number): LocalCloudReceipt | null {
  const receipt = cloudReceipt(id); return receipt?.kind === "local" ? receipt : null;
}

/** A host-stamped delivery binds a non-Paseo run to exactly the reviewed model and commit. */
export function isCloudDeliveryRun(id: number, runId: number): boolean {
  const delivery = cloudReceipt(id);
  if (!delivery || delivery.runId !== runId) return false;
  if (delivery.kind !== "local") return true;
  // Local authority is host-stamped, fenced by the latest executor and its exact source mapping.
  const event = getDb().prepare("SELECT id, actor FROM events WHERE task_id = ? AND kind = 'cloud_delivery' ORDER BY id DESC LIMIT 1").get(id) as { id: number; actor: string } | undefined;
  const started = getDb().prepare("SELECT id, actor, data_json FROM events WHERE task_id = ? AND kind = 'cloud_run_started' ORDER BY id DESC LIMIT 1").get(id) as { id: number; actor: string; data_json: string } | undefined;
  const latest = getDb().prepare("SELECT id, agent_id FROM runs WHERE task_id = ? AND role = 'executor' ORDER BY id DESC LIMIT 1").get(id) as { id: number; agent_id: string | null } | undefined;
  const task = getDb().prepare("SELECT project, role FROM tasks WHERE id = ?").get(id) as { project: string; role: string } | undefined;
  if (event?.actor !== "scheduler" || started?.actor !== "scheduler" || started.id >= event.id ||
      latest?.id !== runId || latest.agent_id !== null || task?.role !== "executor" || task.project !== delivery.project) return false;
  try {
    const mapping = JSON.parse(started.data_json);
    if (mapping.source !== "localMirror" || !["runId", "generation", "project", "repoRoot", "sourceBase", "snapshotCommit", "tree"]
      .every(key => mapping[key] === delivery[key as keyof LocalCloudReceipt])) return false;
    const registered = loadConfig().projects?.[delivery.project]?.workspacePath;
    return !!registered && resolve(registered) === registered && realpathSync(registered) === registered &&
      realpathSync(delivery.repoRoot) === delivery.repoRoot && registered === delivery.repoRoot;
  } catch { return false; }
}
