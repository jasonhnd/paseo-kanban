/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { flushMergeChecks, resetMergeChecks } from "../server/auto-archive";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { AgentLauncher } from "../server/dispatch";
import { setWakeSender } from "../server/bus";
import "../server/promote";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { noteMergeError, resetMergeCache, setGhRunner, writeContract, type GhRunner } from "../server/pr";
import { startTask } from "./helpers/compat-dispatch";
import { handlingGuide } from "../shared/board-view";
import { createTask, getTask } from "../server/store";
import { promoteWaiting } from "../server/promote";

const dir = mkdtempSync(join(tmpdir(), "start-refresh-"));
process.env.KANBAN_DATA_DIR = dir;

const PR = "https://github.com/acme/widgets/pull/7";

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
};
const reviewer: Profile = {
  id: "rv",
  name: zhCN("labels.role.reviewer"),
  role: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "sonnet",
  pool: "claude-max",
};
const pools: PoolSnapshot = {
  state: "fresh",
  message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
  generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};
const config: KanbanConfig = {
  autoStart: { gate: true },
  supervisorAgentId: null,
  supervisors: {},
  concurrency: {
    global: 5,
    pools: { ...DEFAULT_CONCURRENCY.pools, cursor: 5, "claude-max": 5 },
    roles: { ...DEFAULT_CONCURRENCY.roles, executor: 5 },
  },
};

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function launcher(): AgentLauncher {
  let n = 0;
  return {
    async create() {
      n += 1;
      return { id: `start-refresh-${n}` };
    },
    async send() {},
  };
}

function gh(state: { merged: boolean; closed?: boolean; fail?: boolean }): { run: GhRunner; calls: string[] } {
  const calls: string[] = [];
  const run: GhRunner = async (args) => {
    calls.push(args.join(" "));
    if (state.fail) throw new Error(("gh " + zhCNPart("compat.daemon.connectFailed", 0, 3)));
    return JSON.stringify({ state: state.merged ? "MERGED" : state.closed ? "CLOSED" : "OPEN", mergedAt: state.merged ? "2026-09-27T01:00:00Z" : null });
  };
  return { run, calls };
}

function doneParent(title: string): number {
  const task = createTask({
    project: "gate",
    title,
    role: "executor",
    workspacePath: room(title),
    contract: writeContract({ kind: "github", repo: "acme/widgets", pr: PR, awaiting: false }),
  });
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  return task.id;
}

function waitingChild(title: string, parent: number): number {
  const child = createTask({ project: "gate", title, role: "executor", workspacePath: room(title), parentIds: [parent] });
  assert.equal(child.status, "waiting");
  return child.id;
}

beforeEach(() => {
  resetMergeCache();
  resetMergeChecks();
  setGhRunner(null);
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE status != 'archived'").run();
  saveConfig(config);
  setAgentAliveCheck(() => false);
  setWakeSender(() => {});
});

after(() => {
  resetAgentAliveCheck();
  setGhRunner(null);
  resetMergeCache();
  resetMergeChecks();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

// This fixture checks PR refresh races; host quota policy must not decide whether its fake agent starts.
const start = (id: number) => startTask(id, launcher(), "leader", { profiles: [executor, reviewer], snapshot: pools });

describe("start refreshes the parent PR on the spot", () => {
  it("a merged PR behind a stale cache lets the card start", async () => {
    const parent = doneParent("stale");
    const child = waitingChild("stale-child", parent);
    setGhRunner(gh({ merged: false }).run);
    promoteWaiting("test", Date.now());
    await flushMergeChecks();
    assert.equal(getTask(child).status, "waiting");
    const merged = gh({ merged: true });
    setGhRunner(merged.run);
    const result = await start(child);
    assert.equal(merged.calls.length, 1);
    assert.notEqual(getTask(child).status, "waiting");
    assert.ok(result.message);
  });

  it("a PR that is still open reports the PR number and what gh said", async () => {
    const parent = doneParent("open");
    const child = waitingChild("open-child", parent);
    setGhRunner(gh({ merged: false }).run);
    await assert.rejects(start(child), (err: Error) => {
      assert.ok(err.message.includes(`${zhCNPart("cardDrawer.pr.awaiting", 0, 2)}${cardMark(parent)} ${zhCNPart("parents.block.waitingPr", 9, 14)}#7 ${zhCNPart("worktreeGc.leftover.notMerged", 1, 3)}${zhCNPart("missingCwd.none", 0, 1)}${zhCNPart("parents.refresh.checked", 0, 4)}OPEN${zhCNPart("missingCwd.none", 3, 4)}`), err.message);
      assert.ok(!err.message.includes(zhCN("dispatch.parentsNotDone")));
      return true;
    });
    setGhRunner(gh({ merged: false, closed: true }).run);
    await assert.rejects(start(child), new RegExp(zhCN("parents.refresh.checked", {"state":"CLOSED"})));
    assert.equal(getTask(child).status, "waiting");
  });

  it("inside the error backoff it uses the cache, says so and does not call gh", async () => {
    const parent = doneParent("backoff");
    const child = waitingChild("backoff-child", parent);
    noteMergeError(PR, ("gh " + zhCNPart("compat.daemon.connectFailed", 0, 3)));
    const mock = gh({ merged: true });
    setGhRunner(mock.run);
    await assert.rejects(start(child), new RegExp(zhCN("parents.refresh.failed", {"error":("gh " + zhCNPart("pr.gh.backoff", 3, 13) + "gh " + zhCNPart("compat.daemon.connectFailed", 0, 3))})));
    assert.equal(mock.calls.length, 0);
    assert.equal(getTask(child).status, "waiting");
  });

  it("a merge seen by a background check releases the waiting child in the same round", async () => {
    const parent = doneParent("same-round");
    const child = waitingChild("same-round-child", parent);
    setGhRunner(gh({ merged: true }).run);
    promoteWaiting("test", Date.now());
    await flushMergeChecks();
    assert.equal(getTask(child).status, "ready");
  });

  it("the detail page tells how often the PR is checked and how to refresh now", () => {
    const guide = handlingGuide(
      { status: "waiting", code: "XYZ_0001", title: "t", project: "demo_tasks" } as never,
      { parents: [{ code: "XYZ_0000", title: "Parent", status: "done" }] },
    );
    const body = guide.steps.join("\n");
    assert.match(body, new RegExp(localePattern(zhCNPart("boardView.waiting.prPoll", 2, 18))));
    assert.ok(guide.commands.includes("bin/kanban start XYZ_0001"));
  });
});

describe("start races with a background check", () => {
  it("a background check releases the card while start awaits gh: start still launches it", async () => {
    const parent = doneParent("race");
    const child = waitingChild("race-child", parent);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setGhRunner(async () => {
      await gate;
      return JSON.stringify({ state: "MERGED", mergedAt: "2026-09-27T01:00:00Z" });
    });
    const started = start(child);
    promoteWaiting("test", Date.now());
    release();
    await started;
    await flushMergeChecks();
    assert.equal(getTask(child).status, "running");
  });

  it("backoff keeps the cached closed reason in the message", async () => {
    const parent = doneParent("closed-backoff");
    const child = waitingChild("closed-backoff-child", parent);
    setGhRunner(gh({ merged: false, closed: true }).run);
    promoteWaiting("test", Date.now());
    await flushMergeChecks();
    noteMergeError(PR, ("gh " + zhCNPart("compat.daemon.connectFailed", 0, 3)));
    await assert.rejects(start(child), new RegExp(zhCN("boardView.parentPr.closed") + ".*" + localePattern(zhCNPart("parents.refresh.failed", 0, 5)) + "gh " + localePattern(zhCNPart("wake.board.tickError", 8, 12))));
  });
});
