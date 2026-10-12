/// <reference types="node" />
import { signature } from "./native-agent-index";
import { readFileSync, statSync } from "./perf-fs";

/**
 * Parsed agent records keyed by path and the same stat signature native-agent-index uses.
 * A listing still stats every record, but only re-reads and parses one whose signature moved.
 * Failures are never cached: an unreadable or half-written file is looked at again next time.
 */
const parsed = new Map<string, { signature: string; value: unknown }>();

export function readCachedRecord<T>(path: string, parse: (data: unknown) => T): T {
  const stamp = signature(statSync(path, { bigint: true }));
  const saved = parsed.get(path);
  if (saved?.signature === stamp) return saved.value as T;
  const value = parse(JSON.parse(readFileSync(path, "utf8")));
  parsed.set(path, { signature: stamp, value });
  return value;
}

/** Forget records no longer present, so a long-running host does not keep every purged agent. */
export function pruneCachedRecords(keep: Set<string>): void {
  for (const path of parsed.keys()) if (!keep.has(path)) parsed.delete(path);
}

export function resetAgentSnapshotForTests(): void {
  parsed.clear();
}
