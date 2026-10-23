/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_CONCURRENCY, type KanbanConfig } from "../server/config";
import { closeDb } from "../server/db";
import { resetSchedulerForTests } from "../server/loop";
import { bindScheduler } from "./helpers/compat-loop";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "loop-"));
process.env.KANBAN_DATA_DIR = dir;

const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "x-ultra" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];
const pools: PoolSnapshot = {
  state: "fresh",
  message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
  generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};

function config(project: string): KanbanConfig {
  return {
    autoStart: { [project]: true },
    supervisorAgentId: null,
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
}

function countingLauncher(): { createCount: () => number; launcher: { create: () => Promise<{ id: string }>; send: () => Promise<void> } } {
  let n = 0;
  return {
    createCount: () => n,
    launcher: {
      async create() {
        n += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { id: `loop-agent-${n}` };
      },
      async send() {},
    },
  };
}

beforeEach(() => {
  resetSchedulerForTests();
});

after(() => {
  resetSchedulerForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("scheduler singleton", () => {
  it("reuses the loop when bound twice, and two overlapping kicks start one agent", async () => {
    const root = join(dir, "bind");
    mkdirSync(root, { recursive: true });
    const counter = countingLauncher();
    const task = createTask({ project: "bind", title: "Create just one", role: "executor", workspacePath: root });
    const ready = () => ({
      launcher: counter.launcher,
      profiles,
      config: config("bind"),
      pools,
      agentState: () => "alive" as const,
    });
    const first = bindScheduler({ ready, intervalMs: 3_600_000, minRerunMs: 20 });
    const second = bindScheduler({ ready, intervalMs: 3_600_000, minRerunMs: 20 });
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    await Promise.all([first.kick(), second.kick()]);
    assert.equal(counter.createCount(), 1);
    assert.equal(getTask(task.id).status, "running");
    first.release();
    await second.kick();
    assert.equal(counter.createCount(), 1);
    second.release();
    const third = bindScheduler({ ready, intervalMs: 3_600_000, minRerunMs: 20 });
    assert.equal(third.reused, false);
    third.release();
  });

  it("starts one agent when two ticks run at the same time", async () => {
    const root = join(dir, "tick");
    mkdirSync(root, { recursive: true });
    const counter = countingLauncher();
    const task = createTask({ project: "tick", title: "Concurrency", role: "executor", workspacePath: root });
    const options = {
      profiles,
      launcher: counter.launcher,
      config: config("tick"),
      pools,
      agentState: () => "alive" as const,
    };
    await Promise.all([runTick(options), runTick(options)]);
    assert.equal(counter.createCount(), 1);
    assert.equal(getTask(task.id).agent_id?.startsWith("loop-agent-"), true);
    assert.equal(getTask(task.id).status, "running");
  });
});
