/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_CONCURRENCY, type KanbanConfig } from "../server/config";
import { closeDb } from "../server/db";
import { EARLY_BIND_DELAYS_MS, EARLY_BIND_STEADY_MS, startEarlyBind } from "../server/early-bind";
import { bindScheduler, resetSchedulerForTests } from "../server/loop";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { createTask, getTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "early-bind-"));
process.env.KANBAN_DATA_DIR = dir;

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function timerQueue(): { setTimer: (fn: () => void, ms: number) => { clear: () => void }; pending: () => Timer | undefined; fire: () => Promise<void> } {
  const timers: Timer[] = [];
  return {
    setTimer(fn, ms) {
      const timer: Timer = { fn, ms, cleared: false };
      timers.push(timer);
      return {
        clear() {
          timer.cleared = true;
        },
      };
    },
    pending: () => timers.filter((timer) => !timer.cleared).at(-1),
    async fire() {
      const timer = timers.filter((item) => !item.cleared).at(-1);
      assert.ok(timer);
      timer.cleared = true;
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

after(() => {
  resetSchedulerForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("early bind retry", () => {
  it("retries on the backoff schedule, then binds and the scheduler ticks", async () => {
    resetSchedulerForTests();
    const root = join(dir, "work");
    mkdirSync(root, { recursive: true });
    const task = createTask({ project: "early", title: "Wait for binding", role: "executor", workspacePath: root });
    const profiles: Profile[] = [
      { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
      { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
    ];
    const pools: PoolSnapshot = {
      state: "fresh",
      message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
      generatedAt: new Date().toISOString(),
      dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
    };
    const config: KanbanConfig = {
      autoStart: { early: true },
      supervisorAgentId: null,
      supervisors: {},
      concurrency: {
        global: DEFAULT_CONCURRENCY.global,
        pools: { ...DEFAULT_CONCURRENCY.pools, cursor: 5, "claude-max": 5 },
        roles: { ...DEFAULT_CONCURRENCY.roles },
      },
    };
    const bound: { client: { id: string } | null } = { client: null };
    const scheduler = bindScheduler({
      ready: () =>
        bound.client
          ? {
              launcher: {
                async create() {
                  return { id: "early-agent" };
                },
                async send() {},
              },
              profiles,
              config,
              pools,
              agentState: () => "alive" as const,
            }
          : null,
      intervalMs: 3_600_000,
    });
    const clock = timerQueue();
    const logs: string[] = [];
    let connects = 0;
    const early = startEarlyBind({
      alreadyBound: () => bound.client != null,
      async connect() {
        connects += 1;
        if (connects < 3) throw new Error(`connection refused ${connects}`);
        return { id: "client" };
      },
      onBound(next) {
        bound.client = next;
        void scheduler.kick();
      },
      log(message) {
        logs.push(message);
      },
      setTimer: clock.setTimer,
    });
    await flush();
    assert.equal(connects, 1);
    assert.deepEqual(logs, ["connection refused 1"]);
    assert.equal(clock.pending()?.ms, EARLY_BIND_DELAYS_MS[0]);
    await clock.fire();
    assert.equal(connects, 2);
    assert.deepEqual(logs, ["connection refused 1", "connection refused 2"]);
    assert.equal(clock.pending()?.ms, EARLY_BIND_DELAYS_MS[1]);
    await clock.fire();
    await flush();
    assert.equal(connects, 3);
    assert.equal(logs.length, 2);
    assert.equal(bound.client?.id, "client");
    assert.equal(clock.pending(), undefined);
    await scheduler.kick();
    assert.equal(getTask(task.id).status, "running");
    early.stop();
    scheduler.release();
  });

  it("stops retrying when the plugin unloads, and when an event binds first", async () => {
    const clock = timerQueue();
    const logs: string[] = [];
    let connects = 0;
    let bound = false;
    const unloaded = startEarlyBind({
      alreadyBound: () => bound,
      async connect() {
        connects += 1;
        throw new Error("down");
      },
      onBound() {
        bound = true;
      },
      log(message) {
        logs.push(message);
      },
      setTimer: clock.setTimer,
    });
    await flush();
    assert.equal(connects, 1);
    const waiting = clock.pending();
    assert.equal(waiting?.ms, 2_000);
    unloaded.stop();
    assert.equal(waiting?.cleared, true);
    assert.equal(clock.pending(), undefined);
    await flush();
    assert.equal(connects, 1);
    assert.equal(logs.length, 1);

    const later = timerQueue();
    let attempts = 0;
    let eventBound = false;
    startEarlyBind({
      alreadyBound: () => eventBound,
      async connect() {
        attempts += 1;
        throw new Error("still down");
      },
      onBound() {},
      log() {},
      setTimer: later.setTimer,
    });
    await flush();
    assert.equal(attempts, 1);
    eventBound = true;
    await later.fire();
    assert.equal(attempts, 1);
    assert.equal(later.pending(), undefined);
  });

  it("waits 60 seconds after the fourth failure", () => {
    assert.equal(EARLY_BIND_DELAYS_MS.length, 4);
    assert.equal(EARLY_BIND_STEADY_MS, 60_000);
  });
});
