/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { cleanupScheduledCountForTests, enqueueCleanups, flushCleanups, installCleanup } from "../server/cleanup";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { Profile } from "../server/profiles";
import { resetReconcileForTests, type TickOptions } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getTask } from "../server/store";
import { notifyTask, resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { WAKE_SUMMARY_MAX } from "../server/wake-summary";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "noise-"));
process.env.KANBAN_DATA_DIR = dir;
const poolFile = join(dir, "pool-status.json");
process.env.KANBAN_POOL_STATUS = poolFile;

const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];

function lockAuto(project: string, poolCap?: number): KanbanConfig {
  const config: KanbanConfig = {
    autoStart: { [project]: true },
    supervisorAgentId: null,
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools, ...(poolCap == null ? {} : { cursor: poolCap }) },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
  saveConfig(config);
  return config;
}

function launcher(): TickOptions["launcher"] {
  let n = 0;
  return {
    async create() {
      n += 1;
      return { id: `agent-${Date.now()}-${n}` };
    },
    async send() {},
  };
}

function writePools(cursorDispatchable: boolean): void {
  writeFileSync(poolFile, JSON.stringify({ generatedAt: "2026-10-01T00:00:00.000Z", pools: { cursor: { dispatchable: cursorDispatchable }, "claude-max": { dispatchable: true } } }));
}

function count(taskId: number, kind: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number }).n;
}

beforeEach(() => {
  resetReconcileForTests();
  // Earlier cases leave running cards behind; they would fill the pool for the next one.
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE status IN ('running', 'ready')").run();
  setWakeSender(() => {});
  setAgentAliveCheck(() => true);
  writePools(true);
});

after(() => {
  resetAgentAliveCheck();
  installCleanup(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("event noise (TEST_0185 P1-5, P2-20)", () => {
  it("writes one held event for an unchanged quota wait even when hold_reason was rewritten", async () => {
    writePools(false);
    const task = createTask({ project: "quota-dedupe", title: "Waiting for quota", role: "executor", workspacePath: dir });
    const config = lockAuto("quota-dedupe");
    await runTick({ profiles, launcher: launcher(), config });
    assert.equal(count(task.id, "held"), 1);
    // Another path rewrites the visible reason between ticks; the next tick must not log the same wait again.
    getDb().prepare("UPDATE tasks SET hold_reason = 'Reason overwritten elsewhere' WHERE id = ?").run(task.id);
    await runTick({ profiles, launcher: launcher(), config });
    assert.equal(count(task.id, "held"), 1);
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp(zhCN("boardView.quota.headline")));
  });

  it("records one structured capacity hold without repeating it every tick", async () => {
    const left = join(dir, "left");
    const right = join(dir, "right");
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });
    createTask({ project: "pool-full", title: "sample", role: "executor", workspacePath: left });
    const second = createTask({ project: "pool-full", title: "sample", role: "executor", workspacePath: right });
    const config = lockAuto("pool-full", 1);
    await runTick({ profiles, launcher: launcher(), config });
    await runTick({ profiles, launcher: launcher(), config });
    assert.match(getTask(second.id).hold_reason ?? "", new RegExp(zhCN("schedule.roleFull", {"role":zhCNPart("blocked.quota.noPool", 2, 3)})));
    assert.equal(count(second.id, "held"), 1);
    const held = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'held'").get(second.id) as { data_json: string };
    assert.equal(JSON.parse(held.data_json).kind, "concurrency");
  });

  it("writes downstream_dispatched only when something waits behind the started card", async () => {
    const lone = createTask({ project: "lone", title: "Nobody waiting", role: "executor", workspacePath: dir });
    await runTick({ profiles, launcher: launcher(), config: lockAuto("lone") });
    assert.equal(getTask(lone.id).status, "running", getTask(lone.id).hold_reason ?? "");
    assert.equal(count(lone.id, "downstream_dispatched"), 0);
  });

  it("stores a short summary, not the whole handoff, in wake events", () => {
    const task = createTask({ project: "wake-size", title: "Large handoff", role: "executor", workspacePath: dir });
    const big = (zhCNPart("cardDrawer.handoff.title", 2, 4) + zhCNPart("relatedView.end", 4, 6)).repeat(5000);
    getDb().prepare("UPDATE tasks SET status = 'acceptance', handoff_json = ? WHERE id = ?")
      .run(JSON.stringify({ summary: "demo fixture", handoff: big }), task.id);
    notifyTask(getTask(task.id), "acceptance", zhCNPart("wake.acceptance.next", 0, 3));
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_acceptance'").get(task.id) as { data_json: string } | undefined;
    assert.ok(row, "wake event written");
    const data = JSON.parse(row.data_json) as { text?: string; taskId?: number };
    assert.ok((data.text ?? "").length <= WAKE_SUMMARY_MAX);
    assert.equal(data.taskId, task.id);
    assert.ok(row.data_json.length < 2000);
  });

  it("forgets a card's cleanup stamp once its cleanup finished", async () => {
    installCleanup({
      async archiveAgent() {},
      async archiveWorkspace() {},
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    });
    const task = createTask({ project: "stamp", title: "demo fixture", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    enqueueCleanups(new Date());
    assert.ok(cleanupScheduledCountForTests() >= 1, "card was enqueued");
    await flushCleanups();
    assert.equal(cleanupScheduledCountForTests(), 0);
  });
});
