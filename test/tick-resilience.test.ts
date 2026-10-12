/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";
import { resetAcceptanceBackoffForTests, scanAcceptance } from "../server/acceptance-watch";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { resetGuardForTests, safeParse, setExternalTimeoutForTests, withTimeout } from "../server/guard";
import { bindScheduler, resetSchedulerForTests } from "../server/loop";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { pollAwaitingPr } from "../server/flow";
import { promoteWaiting } from "../server/promote";
import { setGhRunner, type GhRunner } from "../server/pr";
import { resetReconcileForTests, type TickOptions } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { resetStallScanForTests, scanStalled, type AgentActivity } from "../server/stall";
import { appendEvent, createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const dir = mkdtempSync(join(tmpdir(), "test0194-resilience-"));
process.env.KANBAN_DATA_DIR = dir;

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

function baseConfig(autoStart: Record<string, boolean>): KanbanConfig {
  return {
    autoStart,
    supervisorAgentId: null,
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
}

/** A config whose per-project lookup throws for one project, like any unreadable per-card state would. */
function configThatThrowsFor(bad: string, good: string): KanbanConfig {
  const autoStart = new Proxy({ [good]: true } as Record<string, boolean>, {
    getOwnPropertyDescriptor(target, key) {
      if (key === bad) throw new Error("Bad card: unreadable");
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return baseConfig(autoStart);
}

function launcher(): { opened: string[]; api: TickOptions["launcher"] } {
  const opened: string[] = [];
  return {
    opened,
    api: {
      async create() {
        const id = `agent-${opened.length + 1}`;
        opened.push(id);
        return { id };
      },
      async send() {},
    },
  };
}

function eventCount(taskId: number, kind: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number }).n;
}

async function settles(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    work.then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  return outcome;
}

beforeEach(() => {
  // Earlier cases leave running cards that would fill the executor cap.
  getDb().prepare("UPDATE tasks SET status = 'archived', agent_id = NULL").run();
  resetGuardForTests();
  resetReconcileForTests();
  resetStallScanForTests();
  resetAcceptanceBackoffForTests();
  resetBoardWakeForTests();
  resetSchedulerForTests();
  setAgentAliveCheck(() => true);
  setWakeSender(() => {});
});

// External-call timeouts are unref'd so a hung Paseo call does not hold the plugin open.
// Node's test runner cancels a test that is waiting only on an unref'd timer.
const keepAlive = setInterval(() => {}, 60_000);

after(() => {
  clearInterval(keepAlive);
  resetSchedulerForTests();
  resetWakeSender();
  resetAgentAliveCheck();
  resetGuardForTests();
  setGhRunner(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("P1-1 one bad card does not stop the round", () => {
  it("starts the next card, records card_error once per hour, and still runs later phases", async () => {
    const bad = createTask({ project: "boom", title: "Bad card", role: "executor", workspacePath: join(dir, "boom") });
    const good = createTask({ project: "fine", title: "Healthy card", role: "executor", workspacePath: join(dir, "fine") });
    mkdirSync(join(dir, "boom"), { recursive: true });
    mkdirSync(join(dir, "fine"), { recursive: true });
    const config = configThatThrowsFor("boom", "fine");
    const opened = launcher();
    const now = new Date("2026-10-03T00:00:00.000Z");
    const tick = (at: Date) => runTick({ now: at, profiles, config, pools, launcher: opened.api, agentState: () => "alive" });

    await tick(now);
    assert.equal(getTask(good.id).status, "running");
    assert.equal(eventCount(bad.id, "card_error"), 1);
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'card_error'").get(bad.id) as { data_json: string };
    assert.match(row.data_json, new RegExp("Bad card: unreadable"));
    // Phases after startLoop still ran: fillMissingHolds gives the stuck card a reason.
    assert.ok(getTask(bad.id).hold_reason);

    await tick(new Date(now.getTime() + 60_000));
    assert.equal(eventCount(bad.id, "card_error"), 1, "same card and same error inside one hour is not written again");
    await tick(new Date(now.getTime() + 61 * 60_000));
    assert.equal(eventCount(bad.id, "card_error"), 2);
  });

  it("a card whose stored event JSON is broken does not stop the others", async () => {
    const bad = createTask({ project: "badjson", title: "Sample text JSON", role: "executor", workspacePath: join(dir, "badjson") });
    const good = createTask({ project: "goodjson", title: "Healthy card", role: "executor", workspacePath: join(dir, "goodjson") });
    mkdirSync(join(dir, "badjson"), { recursive: true });
    mkdirSync(join(dir, "goodjson"), { recursive: true });
    getDb().prepare(
      "INSERT INTO events(task_id, at, kind, actor, data_json) VALUES (?, ?, 'rework_reopen_pending', 'scheduler', '{broken')",
    ).run(bad.id, new Date().toISOString());
    getDb().prepare(
      "INSERT INTO events(task_id, at, kind, actor, data_json) VALUES (?, ?, 'prerequisite_idle_started', 'scheduler', 'nope')",
    ).run(bad.id, new Date().toISOString());
    const opened = launcher();
    await runTick({
      profiles, pools, launcher: opened.api, agentState: () => "alive",
      config: baseConfig({ badjson: true, goodjson: true }),
    });
    assert.equal(getTask(good.id).status, "running");
    assert.ok(["ready", "running"].includes(getTask(bad.id).status), "an unreadable event leaves the card queued or started, never crashed");
  });

  it("safeParse returns null for broken, empty and non-object JSON", () => {
    assert.equal(safeParse("{broken"), null);
    assert.equal(safeParse(""), null);
    assert.equal(safeParse(null), null);
    assert.equal(safeParse("42"), null);
    assert.equal(safeParse("null"), null);
    assert.deepEqual(safeParse<{ a: number }>('{"a":1}'), { a: 1 });
  });
});

describe("P1-2 external calls time out", () => {
  it("withTimeout rejects a call that never returns and passes real results through", async () => {
    await assert.rejects(withTimeout(() => new Promise(() => undefined), (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("compat.daemon.methodsOk", 7, 9)), 30), new RegExp(localePattern(zhCNPart("wake.board.poolStale", 4, 7)) + "0 " + localePattern(zhCNPart("guard.timeout", 21, 26))));
    assert.equal(await withTimeout(async () => 7, (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("compat.daemon.methodsOk", 7, 9)), 30), 7);
    await assert.rejects(withTimeout(() => { throw new Error(zhCNPart("settings.projects.workspace.kept", 18, 20)); }, (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("compat.daemon.methodsOk", 7, 9)), 30), new RegExp(localePattern(zhCNPart("settings.projects.workspace.kept", 18, 20))));
  });

  it("a stall check that never returns does not stop the round", async () => {
    setExternalTimeoutForTests(40);
    mkdirSync(join(dir, "hang-a"), { recursive: true });
    mkdirSync(join(dir, "hang-b"), { recursive: true });
    const stuck = createTask({ project: "hang", title: "Hung activity query", role: "executor", workspacePath: join(dir, "hang-a") });
    const next = createTask({ project: "hang", title: "Later card", role: "executor", workspacePath: join(dir, "hang-b") });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'hung-agent' WHERE id = ?").run(stuck.id);
    const opened = launcher();
    const work = runTick({
      profiles, pools, launcher: opened.api, agentState: () => "alive", config: baseConfig({ hang: true }),
      stallIntervalMs: 0, stallIdleMs: 1,
      agentActivity: () => new Promise<AgentActivity>(() => undefined),
    });
    assert.equal(await settles(work, 4_000), true, "the round must finish");
    assert.equal(getTask(next.id).status, "running", "the start loop after the stalled scan still ran");
  });

  it("a wake send that never returns does not stop the round", async () => {
    setExternalTimeoutForTests(40);
    const triage = createTask({ project: "hangsend", title: "Triage", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'triage' WHERE id = ?").run(triage.id);
    saveConfig({ ...baseConfig({ hangsend: true }), supervisorAgentId: "boss", supervisors: { hangsend: "boss" } });
    const opened = launcher();
    const work = runTick({
      profiles, pools, launcher: opened.api, agentState: () => "alive",
      config: { ...baseConfig({ hangsend: true }), supervisorAgentId: "boss", supervisors: { hangsend: "boss" } },
      send: () => new Promise<void>(() => undefined),
    });
    assert.equal(await settles(work, 4_000), true);
    assert.equal(eventCount(triage.id, "triage_woke"), 0, "a send that timed out was not delivered");
  });
});

describe("P1-2 / P2-16 scheduler loop", () => {
  const stuckLauncher = (counter: { starts: number; hangFirst: boolean }): TickOptions["launcher"] => ({
    async create() { return { id: "never" }; },
    async send() {},
    async beforeStart() {
      counter.starts += 1;
      if (counter.hangFirst && counter.starts === 1) await new Promise<void>(() => undefined);
    },
  });

  it("a watchdog drops a round that never finishes so the next kick runs", async () => {
    const counter = { starts: 0, hangFirst: true };
    const handle = bindScheduler({
      ready: () => ({ launcher: stuckLauncher(counter), profiles, config: baseConfig({}), pools, agentState: () => "alive" as const }),
      intervalMs: 3_600_000,
      watchdogMs: 600,
      minRerunMs: 0,
    });
    void handle.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(counter.starts, 1);
    const second = handle.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(counter.starts, 1, "before the watchdog limit the hung round still counts as running");
    await new Promise((resolve) => setTimeout(resolve, 650));
    const third = handle.kick();
    assert.equal(await settles(third, 3_000), true, "kick after the watchdog limit runs a fresh round");
    assert.equal(counter.starts, 2);
    void second;
    handle.release();
  });

  it("a kick during a round reruns it only after the minimum gap", async () => {
    const starts: number[] = [];
    const slow: TickOptions["launcher"] = {
      async create() { return { id: "x" }; },
      async send() {},
      async beforeStart() {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    };
    const handle = bindScheduler({
      ready: () => ({ launcher: slow, profiles, config: baseConfig({}), pools, agentState: () => "alive" as const }),
      intervalMs: 3_600_000,
      minRerunMs: 250,
    });
    const first = handle.kick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    void handle.kick();
    await first;
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 240, `rerun came after ${starts[1] - starts[0]}ms`);
    handle.release();
  });
});

describe("P2-17 promote", () => {
  it("a parent whose contract cannot be read does not leave an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown): void => { seen.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      const parent = createTask({ project: "promo17", title: "Parent", role: "executor", workspacePath: dir });
      createTask({ project: "promo17", title: "Child", role: "executor", workspacePath: dir, parentIds: [parent.id] });
      getDb().prepare("UPDATE tasks SET contract_json = 'github:not a repo' WHERE id = ?").run(parent.id);
      promoteWaiting("scheduler");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(seen, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("promoteWaiting runs once per tick", async () => {
    const db = getDb();
    const prepare = mock.method(db, "prepare");
    try {
      await runTick({
        profiles, pools, launcher: launcher().api, agentState: () => "alive", config: baseConfig({ once: true }),
      });
      const calls = prepare.mock.calls.filter((call) => String(call.arguments[0]).includes("WHERE status = 'waiting' ORDER BY priority DESC"));
      assert.equal(calls.length, 1);
    } finally {
      prepare.mock.restore();
    }
  });
});

describe("P1-1 same-phase cards are isolated", () => {
  it("a waiting card with an unreadable parent contract does not hold back other waiting cards or triage promotion", async () => {
    const badParent = createTask({ project: "wait-bad", title: "Broken contract parent", role: "executor", workspacePath: join(dir, "wb") });
    const badChild = createTask({ project: "wait-bad", title: "Child of broken parent", role: "executor", workspacePath: join(dir, "wb"), parentIds: [badParent.id] });
    getDb().prepare("UPDATE tasks SET status = 'done', contract_json = 'github:not a repo' WHERE id = ?").run(badParent.id);
    const goodParent = createTask({ project: "wait-ok", title: "Healthy parent", role: "executor", workspacePath: join(dir, "wo") });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(goodParent.id);
    const goodChild = createTask({ project: "wait-ok", title: "Healthy child", role: "executor", workspacePath: join(dir, "wo"), parentIds: [goodParent.id] });
    const triage = createTask({ project: "wait-ok", title: "Triage parent", role: "executor", workspacePath: join(dir, "wt") });
    const kid = createTask({ project: "wait-ok", title: "Completed child", role: "executor", workspacePath: join(dir, "wt"), parentIds: [triage.id] });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(kid.id);
    getDb().prepare("UPDATE tasks SET status = 'triage' WHERE id = ?").run(triage.id);
    mkdirSync(join(dir, "wo"), { recursive: true });

    const now = new Date("2026-10-03T00:00:00.000Z");
    const opened = launcher();
    const tick = (at: Date) => runTick({ now: at, profiles, pools, launcher: opened.api, agentState: () => "alive", config: baseConfig({ "wait-bad": true, "wait-ok": true }) });
    await tick(now);
    assert.notEqual(getTask(goodChild.id).status, "waiting", "the healthy waiting card is promoted in the same round");
    assert.equal(getTask(triage.id).status, "acceptance", "promoteParents still ran");
    assert.equal(getTask(badChild.id).status, "waiting");
    assert.equal(eventCount(badChild.id, "card_error"), 1);
    await tick(new Date(now.getTime() + 60_000));
    assert.equal(eventCount(badChild.id, "card_error"), 1, "limited to one per hour");
  });

  it("an awaiting-checks pass: a card with an unreadable contract does not starve the next awaiting card", async () => {
    const pr = "https://github.com/acme/widgets/pull/7";
    const gh: GhRunner = async (args) => {
      const line = args.join(" ");
      if (line.startsWith("pr view")) return JSON.stringify({ url: pr, headRefOid: "abc", headRefName: "feature" });
      if (line.includes("/protection")) return JSON.stringify({ required_status_checks: { contexts: ["ci"] } });
      if (line.includes("/rules/")) return "[]";
      if (line.includes("/statuses")) return "[]";
      if (line.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success", html_url: "https://x/1" }] });
      throw new Error(line);
    };
    setGhRunner(gh);
    const bad = createTask({ project: "await", title: "Broken contract", role: "decision", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', contract_json = 'github:not a repo' WHERE id = ?").run(bad.id);
    const good = createTask({ project: "await", title: "Healthy wait CI", role: "decision", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', contract_json = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "github", repo: "acme/widgets", pr, awaiting: true }), good.id);
    const moved = await pollAwaitingPr();
    assert.deepEqual(moved, [good.id]);
    assert.equal(getTask(good.id).status, "acceptance");
    assert.equal(eventCount(bad.id, "card_error"), 1);
    await pollAwaitingPr();
    assert.equal(eventCount(bad.id, "card_error"), 1);
  });
});


describe("TEST_0195 conflict preservation", () => {
  it("a timed-out acceptance wake preserves backoff and does not starve the next project", async () => {
    setExternalTimeoutForTests(40);
    const now = new Date("2026-10-03T03:00:00.000Z");
    const old = new Date(now.getTime() - 45 * 60_000).toISOString();
    const bad = createTask({ project: "accept-hung", title: "Timeout project", role: "reader", workspacePath: dir });
    const good = createTask({ project: "accept-good", title: "Healthy project", role: "reader", workspacePath: dir });
    for (const task of [bad, good]) {
      getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
      appendEvent(task.id, "approve", "reviewing", "acceptance", "reviewer", {}, old);
      getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'created'").run(old, task.id);
    }
    const config = { ...baseConfig({}), supervisors: { "accept-hung": "hung-leader", "accept-good": "good-leader" } };
    let calls = 0;
    setWakeSender((agent) => {
      if (agent === "hung-leader") {
        calls += 1;
        return new Promise<void>(() => undefined);
      }
    });
    const scan = (minutes: number) => scanAcceptance({
      now: new Date(now.getTime() + minutes * 60_000), config, decisionsPath: join(dir, "absent-decisions.json"),
    });
    assert.equal(await settles(scan(0), 4_000), true, "a stuck project must not hold the whole acceptance scan");
    assert.equal(eventCount(bad.id, "wake_acceptance_repeat"), 0);
    assert.equal(eventCount(good.id, "wake_acceptance_repeat"), 1);
    await scan(1);
    assert.equal(calls, 1, "timeout enters the same five-minute backoff as refusal");
    await scan(6);
    assert.equal(calls, 2);
    await scan(10);
    assert.equal(calls, 2, "the second timeout doubles backoff to ten minutes");
    setWakeSender(() => {});
    await scan(17);
    assert.equal(eventCount(bad.id, "wake_acceptance_repeat"), 1, "successful retry consumes exactly one delivery");
  });

  it("timed-out fallback stall sends remain capped and do not starve later cards", async () => {
    setExternalTimeoutForTests(40);
    const now = new Date("2026-10-03T03:00:00.000Z");
    const bad = createTask({ project: "stall-conflict", title: "Send timeout", role: "decision", workspacePath: dir });
    const good = createTask({ project: "stall-conflict", title: "Later card", role: "decision", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'hung-send' WHERE id = ?").run(bad.id);
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'good-send' WHERE id = ?").run(good.id);
    let calls = 0;
    setWakeSender((agent) => {
      if (agent === "hung-send") {
        calls += 1;
        return new Promise<void>(() => undefined);
      }
    });
    const scan = (minutes: number) => scanStalled({
      now: new Date(now.getTime() + minutes * 60_000), config: baseConfig({}), intervalMs: 0, idleMs: 60_000,
      agentActivity: () => ({ state: "idle", since: "2026-10-03T02:00:00.000Z" }),
    });
    assert.equal(await settles(scan(0), 4_000), true, "fallback delivery is also bounded");
    assert.equal(eventCount(bad.id, "stall_nudge_failed"), 1);
    assert.equal(eventCount(bad.id, "stall_nudge"), 0, "a timeout is not a successful send");
    assert.equal(eventCount(good.id, "stall_nudge"), 1);
    await scan(2);
    assert.equal(eventCount(bad.id, "stall_nudge_failed"), 2);
    await scan(4);
    assert.equal(calls, 2, "timeouts count towards main's two-attempt cap");
    assert.equal(eventCount(bad.id, "stalled"), 1);
  });

  it("a card that changes hands during a timed-out send receives no stale nudge or failure", async () => {
    setExternalTimeoutForTests(40);
    const task = createTask({ project: "stall-recheck", title: "Agent changed during send", role: "reader", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'old-agent' WHERE id = ?").run(task.id);
    const work = scanStalled({
      now: new Date("2026-10-03T03:00:00.000Z"), config: baseConfig({}), intervalMs: 0, idleMs: 60_000,
      agentActivity: () => ({ state: "idle", since: "2026-10-03T02:00:00.000Z" }),
      send: () => {
        getDb().prepare("UPDATE tasks SET agent_id = 'new-agent' WHERE id = ?").run(task.id);
        return new Promise<void>(() => undefined);
      },
    });
    assert.equal(await settles(work, 4_000), true);
    assert.equal(getTask(task.id).agent_id, "new-agent");
    assert.equal(eventCount(task.id, "stall_nudge"), 0);
    assert.equal(eventCount(task.id, "stall_nudge_failed"), 0);
    assert.equal(eventCount(task.id, "stalled"), 0);
  });
});
