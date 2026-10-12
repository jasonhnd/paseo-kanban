/// <reference types="node" />
import { join } from "node:path";
import { readdirSync, statSync } from "./perf-fs";

/**
 * Which bucket directory under ~/.paseo/agents holds each agent's record.
 *
 * Looking an agent up used to list every bucket and test each one for `<id>.json`.
 * An agent whose record is gone (purged, or never written) paid that full scan every
 * time, hundreds of times per scheduler round. This index lists the buckets once,
 * re-reading a bucket only when its directory mtime moved, and answers every
 * lookup from memory.
 *
 * Record contents are never cached here; callers still read the file. Only the
 * answer to "which bucket has it" can be stale, and only for a record created
 * within the last INDEX_TTL_MS. Tests run with a zero TTL so a file written a
 * moment ago is always visible.
 */
const DEFAULT_TTL_MS = 1_000;
/** A bucket touched this recently is re-read even when its mtime matches the cached one. */
const RECENT_BUCKET_MS = 2_000;

interface Bucket {
  mtimeMs: number;
  ids: string[];
}

interface RootIndex {
  checkedAt: number;
  buckets: Map<string, Bucket>;
  owners: Map<string, string[]>;
}

const roots = new Map<string, RootIndex>();
/** Bumped whenever callers ask for a fresh look, so snapshots built on this index can drop themselves. */
let generation = 0;
export function agentIndexGeneration(): number { return generation; }

export function agentIndexTtlMs(): number {
  const raw = process.env.KANBAN_AGENT_INDEX_TTL_MS;
  if (raw != null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return process.env.NODE_TEST_CONTEXT ? 0 : DEFAULT_TTL_MS;
}

function readBucket(root: string, dir: string, previous: Bucket | undefined, now: number): Bucket | null {
  const path = join(root, dir);
  let mtimeMs: number;
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return null;
    mtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }
  if (previous && previous.mtimeMs === mtimeMs && now - mtimeMs > RECENT_BUCKET_MS) return previous;
  try {
    const ids = readdirSync(path)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    return { mtimeMs, ids };
  } catch {
    return null;
  }
}

function refresh(root: string, previous: RootIndex | undefined, now: number): RootIndex | null {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    roots.delete(root);
    return null;
  }
  const buckets = new Map<string, Bucket>();
  const owners = new Map<string, string[]>();
  for (const dir of dirs) {
    const bucket = readBucket(root, dir, previous?.buckets.get(dir), now);
    if (!bucket) continue;
    buckets.set(dir, bucket);
    for (const id of bucket.ids) {
      const held = owners.get(id);
      if (held) held.push(dir);
      else owners.set(id, [dir]);
    }
  }
  const next = { checkedAt: now, buckets, owners };
  roots.set(root, next);
  return next;
}

function indexFor(root: string): RootIndex | null {
  const now = Date.now();
  const held = roots.get(root);
  if (held && now - held.checkedAt < agentIndexTtlMs()) return held;
  return refresh(root, held, now);
}

/** Buckets that list this agent's record, or null when the agents root itself cannot be read. */
export function bucketsHolding(root: string, agentId: string): string[] | null {
  const index = indexFor(root);
  return index ? (index.owners.get(agentId) ?? []) : null;
}

/** Every `<id>.json` under the root as [bucket, id], or null when the root cannot be read. */
export function listAgentRecords(root: string): Array<{ dir: string; id: string }> | null {
  const index = indexFor(root);
  if (!index) return null;
  const out: Array<{ dir: string; id: string }> = [];
  for (const [dir, bucket] of index.buckets) for (const id of bucket.ids) out.push({ dir, id });
  return out;
}

/**
 * Make the next lookup list the buckets again, whatever the TTL. The cleanup pass calls this
 * before it decides an agent is gone, so a record written a moment ago is never reported missing.
 */
export function invalidateAgentIndex(): void {
  generation += 1;
  invalidations += 1;
  for (const index of roots.values()) index.checkedAt = 0;
}

/**
 * A record was just deleted: drop it from the answers without listing anything again. Each bucket it was in
 * keeps its cached mtime, which the deletion moved, so the next refresh reads just that bucket. Anything
 * else the index holds is untouched; unlike invalidateAgentIndex() this does not make the next lookup list
 * every bucket.
 */
export function forgetAgentRecord(agentId: string): void {
  for (const index of roots.values()) {
    const dirs = index.owners.get(agentId);
    if (!dirs) continue;
    index.owners.delete(agentId);
    for (const dir of dirs) {
      const bucket = index.buckets.get(dir);
      if (bucket) index.buckets.set(dir, { ...bucket, ids: bucket.ids.filter((id) => id !== agentId) });
    }
  }
}

let invalidations = 0;

/** How many times the listing was forced to refresh. Tests and the perf notes use it to see a pass that refreshes too eagerly. */
export function agentIndexInvalidations(): number {
  return invalidations;
}

export function resetAgentIndexForTests(): void {
  generation += 1;
  roots.clear();
}
