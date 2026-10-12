/// <reference types="node" />
import type { IoKind } from "./perf";

/**
 * The counting hook, kept free of imports so low-level modules (paths, perf-fs, db) can call it
 * without an import cycle. perf.ts installs the real sink when it loads; until then calls are dropped.
 */
let sink: ((kind: IoKind) => void) | null = null;

export function setIoSink(next: ((kind: IoKind) => void) | null): void {
  sink = next;
}

export function countIo(kind: IoKind): void {
  sink?.(kind);
}
