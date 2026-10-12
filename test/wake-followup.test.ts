/// <reference types="node" />
import { zhCNPart } from "./helpers/locale";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { forgetBoardWakeMarkCache } from "../server/board-wake-marks";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { approveTask } from "../server/flow";
import { noteWakeSkipped, resetMissingCwdForTests, setMissingCwdHooks } from "../server/missing-cwd";
import { resetStallScanForTests, scanStalled, type AgentActivity } from "../server/stall";
import { appendEvent, createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, retryUnattended, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "wake-followup-"));
process.env.KANBAN_DATA_DIR = dir;

const minute = 60_000;
const IDLE_MS = 10 * minute;
const base = new Date("2026-10-03T00:00:00.000Z").getTime();
const at = (minutes: number) => new Date(base + minutes * minute);
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function config(supervisors: Record<string, string> = {}): KanbanConfig {
  const saved: KanbanConfig = {
    autoStart: { wake: false, chain: false, stall: false },
    supervisorAgentId: "kanban-boss",
    supervisors,
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
  saveConfig(saved);
  return saved;
}

function count(taskId: number, kind: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number }).n;
}

function wakeEvents(taskId: number, kind = "wake_acceptance"): Array<Record<string, unknown>> {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

beforeEach(() => {
  resetBoardWakeForTests();
  resetStallScanForTests();
  resetMissingCwdForTests();
  getDb().exec("DELETE FROM events; DELETE FROM tasks;");
  setAgentAliveCheck(() => true);
});

after(() => {
  resetWakeSender();
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  resetMissingCwdForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("F2 stall nudge rechecks the card after the send", () => {
  function runningCard(agentId: string): number {
    const task = createTask({ project: "f2", title: agentId, role: "reader", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(agentId, task.id);
    return task.id;
  }

  function scan(send: (id: string, text: string) => Promise<void>) {
    resetStallScanForTests();
    return scanStalled({
      now: at(11),
      config: config(),
      intervalMs: 0,
      idleMs: IDLE_MS,
      agentActivity: (): AgentActivity => ({ state: "idle", since: at(0).toISOString() }),
      send,
    });
  }

  it("a successful send while the card moved to acceptance writes no nudge", async () => {
    const id = runningCard("mover");
    await scan(async () => {
      getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(id);
    });
    assert.equal(count(id, "stall_nudge"), 0);
  });

  it("a successful send while the card changed agent writes no nudge", async () => {
    const id = runningCard("old-agent");
    await scan(async () => {
      getDb().prepare("UPDATE tasks SET agent_id = 'new-agent' WHERE id = ?").run(id);
    });
    assert.equal(count(id, "stall_nudge"), 0);
  });

  it("a failed send while the card changed hands writes no failure against the old agent", async () => {
    const id = runningCard("old-failer");
    await scan(async () => {
      getDb().prepare("UPDATE tasks SET agent_id = 'new-agent' WHERE id = ?").run(id);
      throw new Error("socket closed");
    });
    assert.equal(count(id, "stall_nudge_failed"), 0);
    assert.equal(count(id, "stall_nudge"), 0);
  });

  it("a send while the card went back through a new round writes no nudge", async () => {
    const id = runningCard("rounder");
    await scan(async () => {
      appendEvent(id, "request_changes", "running", "rework", "supervisor", {});
      appendEvent(id, "start", "rework", "running", "scheduler", {});
    });
    assert.equal(count(id, "stall_nudge"), 0);
  });

  it("an untouched card still records its nudge", async () => {
    const id = runningCard("steady");
    await scan(async () => {});
    assert.equal(count(id, "stall_nudge"), 1);
  });
});

describe("F3 an in-flight wake from an earlier round does not affect the new round", () => {
  it("round two is sent on its own and the stale round-one result is not counted for it", async () => {
    config({ f3: "f3-leader" });
    const sent: string[] = [];
    const pending: Array<() => void> = [];
    setWakeSender((id) => {
      sent.push(id);
      if (sent.length > 1) return;
      return new Promise<void>((resolve) => pending.push(resolve));
    });
    const task = createTask({ project: "f3", title: "demo fixture", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "Finished" }), task.id);
    approveTask(task.id, (zhCNPart("profileRules.tag.highRisk", 62, 64) + zhCNPart("reviewHold.lead.rounds", 1, 2)));
    assert.equal(sent.length, 1);

    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
    appendEvent(task.id, "request_changes", "acceptance", "rework", "supervisor", {});
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
    approveTask(task.id, "Second round");
    await flush();
    assert.equal(sent.length, 2, "round two must not be swallowed by round one's in-flight send");
    assert.equal(wakeEvents(task.id).filter((event) => event.delivered === true).length, 1);

    pending[0]();
    await flush();
    assert.equal(wakeEvents(task.id).filter((event) => event.delivered === true).length, 1, "stale round-one success writes nothing");
    assert.equal(getTask(task.id).unattended_at, null);
  });

  it("a stale round-one success does not clear the unattended mark of round two", async () => {
    config({ f3b: "f3b-leader" });
    const pending: Array<() => void> = [];
    let calls = 0;
    setWakeSender(() => {
      calls += 1;
      if (calls > 1) return Promise.reject(new Error("socket closed"));
      return new Promise<void>((resolve) => pending.push(resolve));
    });
    const task = createTask({ project: "f3b", title: "demo fixture", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "Finished" }), task.id);
    approveTask(task.id, (zhCNPart("profileRules.tag.highRisk", 62, 64) + zhCNPart("reviewHold.lead.rounds", 1, 2)));
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
    appendEvent(task.id, "request_changes", "acceptance", "rework", "supervisor", {});
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
    approveTask(task.id, "Second round");
    await flush();
    assert.ok(getTask(task.id).unattended_at, "round two was refused, so it is unattended");

    pending[0]();
    await flush();
    assert.ok(getTask(task.id).unattended_at, "round one's late success must not clear it");
    assert.equal(wakeEvents(task.id).filter((event) => event.delivered === true).length, 0);

    setWakeSender(() => {});
    retryUnattended();
    await flush();
    assert.equal(wakeEvents(task.id).filter((event) => event.delivered === true).length, 1);
  });
});

describe("F4 board-level skip notes survive a plugin reload", () => {
  it("a skip without a card is logged once per agent and kind, also after memory is lost", () => {
    const lines: string[] = [];
    setMissingCwdHooks({ log: (line) => lines.push(line) });
    noteWakeSkipped(null, "agent-b", "/gone", "deliver");
    noteWakeSkipped(null, "agent-b", "/gone", "deliver");
    assert.equal(lines.length, 1);

    resetMissingCwdForTests();
    forgetBoardWakeMarkCache();
    setMissingCwdHooks({ log: (line) => lines.push(line) });
    noteWakeSkipped(null, "agent-b", "/gone", "deliver");
    assert.equal(lines.length, 1);

    noteWakeSkipped(null, "agent-b", "/gone", "stall");
    assert.equal(lines.length, 2);
  });
});
