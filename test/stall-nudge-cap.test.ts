/// <reference types="node" />
import { zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { resetStallScanForTests, scanStalled, type AgentActivity } from "../server/stall";
import { appendEvent, createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "stall-cap-"));
process.env.KANBAN_DATA_DIR = dir;

const IDLE_MS = 10 * 60_000;
const minute = 60_000;
const base = new Date("2026-10-03T00:00:00.000Z").getTime();
const at = (minutes: number) => new Date(base + minutes * minute);
const sent: Array<{ id: string; text: string }> = [];

function config(): KanbanConfig {
  const saved: KanbanConfig = {
    autoStart: { stall: false },
    supervisorAgentId: "kanban-boss",
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
  saveConfig(saved);
  return saved;
}

function card(agentId: string): number {
  const task = createTask({ project: "cap", title: agentId, role: "decision", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(agentId, task.id);
  return task.id;
}

function count(taskId: number, kind: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number }).n;
}

function scan(now: Date, activity: (agentId: string) => AgentActivity | Promise<AgentActivity>, send?: (id: string, text: string) => Promise<void>) {
  resetStallScanForTests();
  return scanStalled({
    now,
    config: config(),
    intervalMs: 0,
    idleMs: IDLE_MS,
    agentActivity: activity,
    send: send ?? (async (id, text) => { sent.push({ id, text }); }),
  });
}

after(() => {
  resetStallScanForTests();
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("P1-4 stall nudges are capped per card and agent", () => {
  beforeEach(() => {
    sent.length = 0;
    resetBoardWakeForTests();
    getDb().exec("DELETE FROM events; DELETE FROM tasks;");
    setAgentAliveCheck(() => true);
    setWakeSender((id, text) => { sent.push({ id, text }); });
  });

  it("an agent that keeps replying without finishing gets two nudges, then the escalation", async () => {
    const id = card("test3ty");
    await scan(at(11), () => ({ state: "idle", since: at(0).toISOString() }));
    assert.equal(count(id, "stall_nudge"), 1);
    // The agent answered the nudge (a new idle period) but still did not finish.
    await scan(at(30), () => ({ state: "idle", since: at(15).toISOString() }));
    assert.equal(count(id, "stall_nudge"), 2);
    await scan(at(50), () => ({ state: "idle", since: at(35).toISOString() }));
    assert.equal(count(id, "stall_nudge"), 2);
    assert.equal(count(id, "stalled"), 1);
    assert.equal(count(id, "board_wake"), 1);
    assert.equal(sent.filter((item) => item.id === "test3ty").length, 2);
    await scan(at(80), () => ({ state: "idle", since: at(60).toISOString() }));
    assert.equal(count(id, "stall_nudge"), 2);
    assert.equal(count(id, "board_wake"), 1);
  });

  it("a real progress comment from the agent starts the count again", async () => {
    const id = card("worker");
    await scan(at(11), () => ({ state: "idle", since: at(0).toISOString() }));
    await scan(at(30), () => ({ state: "idle", since: at(15).toISOString() }));
    assert.equal(count(id, "stall_nudge"), 2);
    appendEvent(id, "comment", null, "running", "worker", {}, at(32).toISOString());
    await scan(at(50), () => ({ state: "idle", since: at(35).toISOString() }));
    assert.equal(count(id, "stall_nudge"), 3);
    assert.equal(count(id, "stalled"), 0);
  });

  it("a card that finished while the activity read was pending is not nudged", async () => {
    const id = card("racer");
    await scan(at(11), async () => {
      getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(id);
      return { state: "idle", since: at(0).toISOString() };
    });
    assert.equal(count(id, "stall_nudge"), 0);
    assert.equal(sent.length, 0);
    assert.equal(getTask(id).status, "acceptance");
  });

  it("a card whose agent changed while the activity read was pending is not nudged", async () => {
    const id = card("old-agent");
    await scan(at(11), async () => {
      getDb().prepare("UPDATE tasks SET agent_id = 'new-agent' WHERE id = ?").run(id);
      return { state: "idle", since: at(0).toISOString() };
    });
    assert.equal(count(id, "stall_nudge"), 0);
    assert.equal(sent.length, 0);
  });

  it("failed sends are counted and recorded, stop after two, then escalate once", async () => {
    const id = card("unreachable");
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error(("agent " + zhCNPart("cleanup.reason.gone", 2, 4) + zhCNPart("compat.name.offlineTest", 1, 2)));
    };
    const idle = () => ({ state: "idle" as const, since: at(0).toISOString() });
    await scan(at(11), idle, failing);
    await scan(at(12), idle, failing);
    assert.equal(calls, 2);
    assert.equal(count(id, "stall_nudge_failed"), 2);
    await scan(at(13), idle, failing);
    assert.equal(calls, 2);
    assert.equal(count(id, "stall_nudge_failed"), 2);
    assert.equal(count(id, "stalled"), 0);
    await scan(at(23), idle, failing);
    assert.equal(calls, 2);
    assert.equal(count(id, "stalled"), 1);
    assert.equal(count(id, "board_wake"), 1);
    await scan(at(40), idle, failing);
    assert.equal(calls, 2);
    assert.equal(count(id, "board_wake"), 1);
  });
});
