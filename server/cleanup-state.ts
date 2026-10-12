/// <reference types="node" />
import { setInterval, clearInterval } from "node:timers";
import { getDb } from "./db";
import { acquireStartClaim, holdsStartClaim, releaseStartClaim } from "./start-claim";

/** Existing successful rebuild evidence is the boundary, including records written by older versions.
 * Failed creates and rework requests never open a generation. No history is deleted or rewritten.
 */
export function cleanupGenerationSql(taskId: string): string {
  return `COALESCE((SELECT MAX(g.id) FROM events g WHERE g.task_id = ${taskId}
    AND (g.kind = 'temp_workspace_recreated' OR
      (g.kind = 'worktree_created' AND json_extract(g.data_json, '$.recreated') = 1))
    AND json_type(g.data_json, '$.directory') = 'text'
    AND json_extract(g.data_json, '$.directory') != ''), 0)`;
}

export function cleanupGeneration(taskId: number): number {
  return (getDb().prepare(`SELECT ${cleanupGenerationSql("?")} AS generation`).get(taskId) as { generation: number }).generation;
}

/** Tagged late replies belong to the generation that launched them, not their later insertion time. */
export function currentCleanupSql(event: string, taskId: string): string {
  const boundary = cleanupGenerationSql(taskId);
  return `${event}.id > ${boundary} AND COALESCE(json_extract(${event}.data_json, '$.cleanupGeneration'), ${boundary}) = ${boundary}`;
}

export function cleanupMark(taskId: number, kinds: readonly string[]): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM events c WHERE c.task_id = ?
    AND c.kind IN (${kinds.map(() => "?").join(",")}) AND ${currentCleanupSql("c", "c.task_id")} LIMIT 1`).get(taskId, ...kinds));
}

// Use the existing cross-process start claim as well as the in-process writer gate.
// A physical archive/Git call retains this gate after its logical timeout, until it actually settles.
const held = new Set<number>();
const waiters = new Map<number, Set<() => void>>();
const physical = new Map<number, Set<Promise<unknown>>>();
const claims = new Map<number, { token: string; heartbeat: ReturnType<typeof setInterval> }>();

function wakeCard(taskId: number): void {
  for (const wake of waiters.get(taskId) ?? []) wake();
}
function releaseIdleClaim(taskId: number): void {
  if (held.has(taskId) || physical.get(taskId)?.size) return;
  const claim = claims.get(taskId);
  if (!claim) return;
  clearInterval(claim.heartbeat);
  releaseStartClaim(taskId, claim.token);
  claims.delete(taskId);
  wakeCard(taskId);
}

export function trackCleanupWork(taskId: number, work: Promise<unknown>): void {
  const jobs = physical.get(taskId) ?? new Set();
  jobs.add(work); physical.set(taskId, jobs);
  const clear = () => { jobs.delete(work); if (!jobs.size) physical.delete(taskId); releaseIdleClaim(taskId); };
  void work.then(clear, clear);
}

export function tryHoldCleanupCard(taskId: number, borrowedClaim?: string): (() => void) | null {
  if (held.has(taskId) || (borrowedClaim && physical.get(taskId)?.size)) return null;
  const retained = claims.get(taskId)?.token;
  // Releasing an old reviewer on an active card must not stop dispatch from resuming
  // the executor. It has no workspace/Git obligation; rebuild still waits on held/physical.
  const status = (getDb().prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined)?.status;
  if (!borrowedClaim && !retained && status !== "done" && status !== "archived") {
    held.add(taskId);
    return () => { held.delete(taskId); wakeCard(taskId); };
  }
  const claim = borrowedClaim ?? retained ?? acquireStartClaim(taskId);
  if (!claim || !holdsStartClaim(taskId, claim)) return null;
  held.add(taskId);
  if (!borrowedClaim && !retained) {
    // Fence a live physical call against the normal five-minute start-claim TTL.
    const heartbeat = setInterval(() => getDb().prepare("UPDATE start_claims SET at = ? WHERE task_id = ? AND token = ?")
      .run(new Date().toISOString(), taskId, claim), 60_000);
    (heartbeat as unknown as { unref(): void }).unref();
    claims.set(taskId, { token: claim, heartbeat });
  }
  return () => {
    held.delete(taskId);
    // Logical retry writers remain serialized, but can record the existing inflight/backoff
    // state. Only a starter/rebuilder is fenced until the physical operation finishes.
    if (!borrowedClaim) releaseIdleClaim(taskId);
    wakeCard(taskId);
  };
}

export async function holdCleanupCard(taskId: number, waitMs: number, borrowedClaim?: string): Promise<(() => void) | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = tryHoldCleanupCard(taskId, borrowedClaim);
    if (release) return release;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise<void>(resolve => {
      const list = waiters.get(taskId) ?? new Set();
      const wake = () => { clearTimeout(timer); list.delete(wake); if (!list.size) waiters.delete(taskId); resolve(); };
      const timer = setTimeout(wake, Math.min(left, 100)); // Also observes a different process releasing its claim.
      list.add(wake); waiters.set(taskId, list);
    });
  }
}
