/// <reference types="node" />
// What board.snapshot answers. Opening AFC used to wait for a full round (agent list, two `paseo` CLI
// calls, files): 1–5 s measured on 2026-10-07. Now the last snapshot comes back at once and the next one
// is built in the background; the panel asks again within seconds when what it got is old.
import type { PaseoApi } from "./paseo-api";
import type { BoardSnapshot } from "../../shared/fleet/board";
import { withOwnDaemonClient } from "./pool-refresh";
import { buildSnapshot } from "./snapshot";
import { createStaleCache, type StaleCache } from "./stale-cache";
import { createStepTimer, logIfSlow } from "./timing";
import { logSwallowed } from "./util";

/** Two panels (desktop and phone) polling together share one round inside this window. */
export const SNAPSHOT_FRESH_MS = 5_000;
/** After a plugin load, build one snapshot after this delay so the first open is not cold. */
export const SNAPSHOT_WARM_DELAY_MS = 15_000;

const cache: StaleCache<BoardSnapshot> = createStaleCache<BoardSnapshot>({
  freshMs: SNAPSHOT_FRESH_MS,
  onError: (error) => logSwallowed("snapshot: background refresh failed, keeping the previous one", error),
});

async function timedBuild(paseo: PaseoApi, nudge: boolean): Promise<BoardSnapshot> {
  const timer = createStepTimer();
  const snapshot = await buildSnapshot(paseo, { timer, nudge });
  logIfSlow("snapshot", timer);
  return snapshot;
}

/** Last snapshot at once (rebuilt in the background when older than SNAPSHOT_FRESH_MS); `force` waits for a new one. */
export function readBoardSnapshot(paseo: PaseoApi, force = false): Promise<BoardSnapshot> {
  return cache.get(() => timedBuild(paseo, true), { force });
}

/** An action changed what the board shows (a decision answered, a switch flipped): the next read waits for a new round. */
export function invalidateBoardSnapshot(): void {
  cache.invalidate();
}

/** `work`, then mark the snapshot out of date, whether it worked or not. */
export function changesBoard<T>(work: T | Promise<T>): Promise<T> {
  return Promise.resolve(work).finally(invalidateBoardSnapshot);
}

/** Schedules the one warm-up. The real clock uses `setTimeout`; tests pass a queue and flush it. */
export type SnapshotWarmSchedule = (run: () => void, delayMs: number) => () => void;

const realSchedule: SnapshotWarmSchedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/**
 * One warm-up round after the plugin loads. No leader nudges from it: those only go out while
 * someone has the panel open, as before. Uses its own daemon connection when no handle has come in yet.
 */
export function startSnapshotWarm(
  handle: () => PaseoApi | null,
  delayMs = SNAPSHOT_WARM_DELAY_MS,
  schedule: SnapshotWarmSchedule = realSchedule,
  allowOwnClient = true,
): () => void {
  return schedule(() => {
    if (cache.builtAt() !== null) return;
    const paseo = handle();
    if (!paseo && !allowOwnClient) return;
    cache.warm(() => (paseo ? timedBuild(paseo, false) : withOwnDaemonClient("afc-snapshot-warm", (own) => timedBuild(own, false))));
  }, delayMs);
}
