/// <reference types="node" />
import { useConfigMemoryFallback, type KanbanConfig } from "./config";
import { t } from "../shared/i18n";
import { enqueueCleanups } from "./cleanup";
import type { AgentLiveness } from "./open";
import { readProfiles, type Profile } from "./profiles";
import { noteSchedulerTick } from "./liveness";
import { scheduleSessionCleanup } from "./tmp-sessions";
import { scheduleTmpCleanup } from "./tmp-cleanup";
import { runTick, type TickOptions } from "./schedule";
import type { AgentActivity } from "./stall";
import { noteTickFailure, noteTickSuccess } from "./wake";
import type { PoolSnapshot } from "./pools";
import { refreshHookObjects } from "./hook-objects";
import { round, stage } from "./perf";

/** A round still pending after this long is abandoned so the scheduler cannot stay stopped. */
export const TICK_WATCHDOG_MS = 10 * 60_000;
/** A kick that lands during a round reruns it no sooner than this after the round started. */
export const MIN_RERUN_MS = 5_000;

export interface SchedulerDeps {
  launcher: TickOptions["launcher"];
  send?: TickOptions["send"];
  profiles?: Profile[];
  config?: KanbanConfig;
  agentState?: (agentId: string | null) => AgentLiveness;
  agentActivity?: (agentId: string) => Promise<AgentActivity> | AgentActivity;
  agentBudget?: TickOptions["agentBudget"];
  interruptAgent?: TickOptions["interruptAgent"];
  backgroundWaiting?: TickOptions["backgroundWaiting"];
  now?: Date;
  pools?: PoolSnapshot;
  matrix?: TickOptions["matrix"];
}

interface ActiveLoop {
  ready: () => SchedulerDeps | null;
  refs: number;
  kick: () => Promise<void>;
  stop: () => void;
}

let active: ActiveLoop | null = null;

function releaseOne(): void {
  if (!active) return;
  active.refs -= 1;
  if (active.refs > 0) return;
  active.stop();
  active = null;
}

/** One scheduler loop per process. A second bind replaces the client and reuses the loop. */
export function bindScheduler(options: {
  ready: () => SchedulerDeps | null;
  intervalMs?: number;
  watchdogMs?: number;
  minRerunMs?: number;
}): {
  kick: () => Promise<void>;
  reused: boolean;
  release: () => void;
} {
  // This process runs the board: a config file that goes missing or breaks is served from the last good copy (DEMO_0001).
  useConfigMemoryFallback(true);
  if (active) {
    active.ready = options.ready;
    active.refs += 1;
    let released = false;
    return {
      kick: () => active?.kick() ?? Promise.resolve(),
      reused: true,
      release() {
        if (released) return;
        released = true;
        releaseOne();
      },
    };
  }

  const watchdogMs = options.watchdogMs ?? TICK_WATCHDOG_MS;
  const minRerunMs = options.minRerunMs ?? MIN_RERUN_MS;
  let again = false;
  let pending: Promise<void> | null = null;
  let pendingSince = 0;
  const kick = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (pending) {
      const stuckMs = Date.now() - pendingSince;
      if (stuckMs < watchdogMs) {
        again = true;
        return pending;
      }
      // The old round never came back (a call that never returns). Abandon it; its finally must not clear the new one.
      const message = t("loop.tickStuck", { minutes: Math.round(stuckMs / 60_000) });
      console.error("[paseo-kanban] tick", message);
      noteTickFailure(message);
      pending = null;
    }
    const mine: { promise: Promise<void> | null; finished: boolean } = { promise: null, finished: false };
    pendingSince = Date.now();
    mine.promise = (async () => {
      try {
        let roundStartedAt = Date.now();
        do {
          again = false;
          const deps = active?.ready() ?? null;
          if (!deps) return;
          roundStartedAt = Date.now();
          await round("tick", async () => {
            await stage("tick.beforeStart", async () => deps.launcher.beforeStart?.());
            let profiles = deps.profiles;
            if (!profiles) {
              try {
                profiles = stage("tick.profiles", () => readProfiles());
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error("[paseo-kanban] profiles", message);
                noteTickFailure(message);
                noteSchedulerTick(new Date());
                return;
              }
            }
            const result = await runTick({
              profiles,
              launcher: deps.launcher,
              send: deps.send,
              config: deps.config,
              agentState: deps.agentState,
              agentActivity: deps.agentActivity,
              agentBudget: deps.agentBudget,
              interruptAgent: deps.interruptAgent,
              backgroundWaiting: deps.backgroundWaiting,
              now: deps.now,
              pools: deps.pools,
              matrix: deps.matrix,
              watchDaemonRestart: true,
            });
            if (result.errors.length > 0) noteTickFailure(result.errors[0]);
            else noteTickSuccess();
            stage("tick.enqueueCleanups", () => enqueueCleanups(deps.now ?? new Date()));
            stage("tick.scheduleTmpCleanup", () => scheduleTmpCleanup({ now: deps.now ?? new Date() }));
            stage("tick.scheduleSessionCleanup", () => scheduleSessionCleanup({ now: deps.now ?? new Date() }));
            noteSchedulerTick(deps.now ?? new Date());
          });
          if (again && active) {
            const wait = roundStartedAt + minRerunMs - Date.now();
            if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
          }
        } while (again && active);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[paseo-kanban] tick", message);
        noteTickFailure(message);
        noteSchedulerTick(new Date());
      } finally {
        mine.finished = true;
        if (pending === mine.promise) pending = null;
        if (!process.env.NODE_TEST_CONTEXT) {
          void import("./doctor-live")
            .then((mod) => round("doctor", () => mod.maybeRunScheduledDoctor()))
            .catch((err) => {
              console.error("[paseo-kanban] doctor", err instanceof Error ? err.message : err);
            });
        }
      }
    })();
    // An early return finishes before the assignment above; it must not leave a settled promise parked as pending.
    if (!mine.finished) pending = mine.promise;
    return mine.promise;
  };

  const timer = setInterval(() => {
    // CLI register/rework may bind unlabelled existing agents in another process.
    // Keep this read on the periodic timer, outside lifecycle-triggered kick().
    try {
      refreshHookObjects();
    } catch {
      console.error("[paseo-kanban] lifecycle identity refresh unavailable; keeping known IDs");
    }
    void kick();
  }, options.intervalMs ?? 60_000);
  const handle = timer as unknown as { unref?: () => void };
  handle.unref?.();
  active = { ready: options.ready, refs: 1, kick, stop: () => clearInterval(timer) };
  let released = false;
  return {
    kick,
    reused: false,
    release() {
      if (released) return;
      released = true;
      releaseOne();
    },
  };
}

export function resetSchedulerForTests(): void {
  if (!active) return;
  active.stop();
  active = null;
}
