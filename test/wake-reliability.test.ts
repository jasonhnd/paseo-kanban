/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { approveTask } from "../server/flow";
import { noteWakeSkipped, resetMissingCwdForTests } from "../server/missing-cwd";
import { appendEvent, createTask, getTask } from "../server/store";
import {
  forgetBoardWakesInMemoryForTests,
  resetAgentAliveCheck,
  resetBoardWakeForTests,
  retryUnattended,
  setAgentAliveCheck,
  wakeKanbanSupervisor,
} from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "wake-reliability-"));
process.env.KANBAN_DATA_DIR = dir;

const sent: Array<{ id: string; text: string }> = [];

function config(supervisors: Record<string, string>, kanban = "kanban-boss"): void {
  const saved: KanbanConfig = {
    autoStart: { wake: false, chain: false },
    supervisorAgentId: kanban,
    supervisors,
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
  saveConfig(saved);
}

function wakeEvents(taskId: number, kind = "wake_acceptance"): Array<Record<string, unknown>> {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

function inReview(project: string, agent = "creator"): number {
  const task = createTask({ project, title: `Review ${project}`, role: "executor", workspacePath: dir, createdByAgent: agent });
  getDb().prepare("UPDATE tasks SET status = 'reviewing', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "Finished" }), task.id);
  return task.id;
}

/** The card leaves acceptance for rework and comes back through review. */
function reworkAndReapprove(id: number): void {
  getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(id);
  appendEvent(id, "request_changes", "acceptance", "rework", "supervisor", {});
  getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(id);
  approveTask(id, "Second round passed");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

after(() => {
  resetWakeSender();
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("P1-3 wake is recorded only after it was sent", () => {
  beforeEach(() => {
    sent.length = 0;
    resetBoardWakeForTests();
    getDb().exec("DELETE FROM events; DELETE FROM tasks;");
    setAgentAliveCheck(() => true);
    setWakeSender((id, text) => {
      sent.push({ id, text });
    });
  });

  it("with no wake sender (CLI in the same process) nothing is recorded as woken and the card stays unattended", async () => {
    config({ cli: "cli-leader" });
    resetWakeSender();
    const id = inReview("cli");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    assert.equal(getTask(id).status, "acceptance");
    assert.equal(wakeEvents(id).length, 0);
    assert.ok(getTask(id).unattended_at);

    // The plugin comes up with a sender; the next retry really sends it.
    setWakeSender((agent, text) => {
      sent.push({ id: agent, text });
    });
    retryUnattended();
    await flush();
    assert.equal(sent.filter((item) => item.id === "cli-leader").length, 1);
    const events = wakeEvents(id);
    assert.equal(events.length, 1);
    assert.equal(events[0].delivered, true);
    assert.equal(getTask(id).unattended_at, null);
  });

  it("a rejected send is not a wake; the retry sends again and only then records delivered", async () => {
    config({ rej: "rej-leader" });
    setWakeSender(() => Promise.reject(new Error("socket closed")));
    const id = inReview("rej");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await flush();
    assert.equal(wakeEvents(id).filter((event) => event.delivered === true).length, 0);
    assert.ok(getTask(id).unattended_at);

    setWakeSender((agent, text) => {
      sent.push({ id: agent, text });
    });
    retryUnattended();
    await flush();
    assert.equal(sent.filter((item) => item.id === "rej-leader").length, 1);
    assert.equal(wakeEvents(id).filter((event) => event.delivered === true).length, 1);
    assert.equal(getTask(id).unattended_at, null);

    retryUnattended();
    await flush();
    assert.equal(sent.filter((item) => item.id === "rej-leader").length, 1);
  });

  it("repeated failed retries do not pile up one event per tick", async () => {
    config({ spam: "spam-leader" });
    setWakeSender(() => Promise.reject(new Error("down")));
    const id = inReview("spam");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await flush();
    for (let i = 0; i < 4; i += 1) {
      retryUnattended();
      await flush();
    }
    assert.ok(wakeEvents(id).length <= 1);
  });

  it("a round-1 primary wake does not hide round 2: a lost wake is retried after rework", async () => {
    config({ round: "round-leader" });
    const id = inReview("round");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await flush();
    assert.equal(wakeEvents(id).filter((event) => event.delivered === true).length, 1);

    // Round 2: the sender is not available when the card re-enters acceptance.
    resetWakeSender();
    reworkAndReapprove(id);
    assert.ok(getTask(id).unattended_at);
    sent.length = 0;
    setWakeSender((agent, text) => {
      sent.push({ id: agent, text });
    });
    retryUnattended();
    await flush();
    assert.equal(sent.filter((item) => item.id === "round-leader").length, 1);
    assert.equal(getTask(id).unattended_at, null);
  });

  it("the Kanban fallback wake fires again in a new round", async () => {
    config({ fb: "dead-leader" });
    setAgentAliveCheck((agent) => agent === "kanban-boss");
    const id = inReview("fb", "dead-creator");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await flush();
    assert.equal(sent.filter((item) => item.id === "kanban-boss").length, 1);

    reworkAndReapprove(id);
    await flush();
    assert.equal(sent.filter((item) => item.id === "kanban-boss").length, 2);
    // Same round: no repeat.
    retryUnattended();
    await flush();
    assert.equal(sent.filter((item) => item.id === "kanban-boss").length, 2);
  });
});

describe("P2-18 board wake dedupe survives a plugin reload", () => {
  beforeEach(() => {
    sent.length = 0;
    resetBoardWakeForTests();
    setAgentAliveCheck(() => true);
    setWakeSender((id, text) => {
      sent.push({ id, text });
    });
    config({});
  });

  it("does not resend pool_stale / tick_error after memory is lost, and resends after the condition cleared", () => {
    assert.equal(wakeKanbanSupervisor({ taskId: null, kind: "pool_stale", subject: "snap-1", detail: "Stale quota snapshot" }), true);
    assert.equal(wakeKanbanSupervisor({ taskId: null, kind: "tick_error", detail: "boom" }), true);
    assert.equal(sent.length, 2);

    forgetBoardWakesInMemoryForTests();
    assert.equal(wakeKanbanSupervisor({ taskId: null, kind: "pool_stale", subject: "snap-1", detail: "Stale quota snapshot" }), false);
    assert.equal(wakeKanbanSupervisor({ taskId: null, kind: "tick_error", detail: "boom" }), false);
    assert.equal(sent.length, 2);

    // A different snapshot is a new problem.
    assert.equal(wakeKanbanSupervisor({ taskId: null, kind: "pool_stale", subject: "snap-2", detail: "Stale again" }), true);
    assert.equal(sent.length, 3);
  });

  it("releasing the kind removes the persisted mark too", async () => {
    const { releaseBoardWake } = await import("../server/wake");
    wakeKanbanSupervisor({ taskId: null, kind: "scheduler_idle", detail: "idle" });
    forgetBoardWakesInMemoryForTests();
    releaseBoardWake("scheduler_idle");
    forgetBoardWakesInMemoryForTests();
    assert.equal(wakeKanbanSupervisor({ taskId: null, kind: "scheduler_idle", detail: "idle again" }), true);
  });
});

describe("P2-18 missing-cwd skip notes survive a plugin reload", () => {
  it("writes one wake_skipped_missing_cwd per card, agent and kind even after memory is lost", () => {
    getDb().exec("DELETE FROM events; DELETE FROM tasks;");
    const task = createTask({ project: "cwd", title: "Directory missing", role: "executor", workspacePath: dir });
    const count = () =>
      (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'wake_skipped_missing_cwd'").get(task.id) as { n: number }).n;
    noteWakeSkipped(task.id, "agent-x", "/gone", "wake");
    noteWakeSkipped(task.id, "agent-x", "/gone", "wake");
    assert.equal(count(), 1);
    resetMissingCwdForTests();
    noteWakeSkipped(task.id, "agent-x", "/gone", "wake");
    assert.equal(count(), 1);
    noteWakeSkipped(task.id, "agent-x", "/gone", "stall");
    assert.equal(count(), 2);
  });
});

describe("board wake is marked as sent only after the send succeeded", () => {
  const problem = { taskId: null, kind: "scheduler_idle" as const, detail: "idle" };
  const good = (id: string, text: string) => {
    sent.push({ id, text });
  };
  beforeEach(() => {
    sent.length = 0;
    resetBoardWakeForTests();
    setAgentAliveCheck(() => true);
    config({});
  });

  it("a rejected async send leaves no mark: after reload with a working sender it is sent, and then not again", async () => {
    setWakeSender(() => Promise.reject(new Error("socket closed")));
    assert.equal(wakeKanbanSupervisor(problem), true);
    await flush();
    assert.equal(sent.length, 0);

    forgetBoardWakesInMemoryForTests();
    setWakeSender(good);
    assert.equal(wakeKanbanSupervisor(problem), true);
    await flush();
    assert.equal(sent.length, 1);

    forgetBoardWakesInMemoryForTests();
    assert.equal(wakeKanbanSupervisor(problem), false);
    assert.equal(sent.length, 1);
  });

  it("a sender that throws synchronously reports false and leaves no mark", () => {
    setWakeSender(() => {
      throw new Error("no client");
    });
    assert.equal(wakeKanbanSupervisor(problem), false);
    forgetBoardWakesInMemoryForTests();
    setWakeSender(good);
    assert.equal(wakeKanbanSupervisor(problem), true);
    assert.equal(sent.length, 1);
  });

  it("while the send is in flight the same problem is not sent twice; a refusal is retried after the delay", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let release: (() => void) | null = null;
    let calls = 0;
    setWakeSender(
      () =>
        new Promise((_resolve, reject) => {
          calls += 1;
          release = () => reject(new Error("down"));
        }),
    );
    assert.equal(wakeKanbanSupervisor(problem), true);
    assert.equal(wakeKanbanSupervisor(problem), false);
    assert.equal(calls, 1);
    release!();
    await flush();
    assert.equal(wakeKanbanSupervisor(problem), false);
    t.mock.timers.tick(5 * 60_000 + 1);
    setWakeSender(good);
    assert.equal(wakeKanbanSupervisor(problem), true);
    await flush();
    assert.equal(sent.length, 1);
  });

  it("a card-bound board wake writes its board_wake event only after the send succeeded", async () => {
    getDb().exec("DELETE FROM events; DELETE FROM tasks;");
    const task = createTask({ project: "bw", title: "Cannot start", role: "executor", workspacePath: dir });
    const count = () => (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'board_wake'").get(task.id) as { n: number }).n;
    setWakeSender(() => Promise.reject(new Error("down")));
    wakeKanbanSupervisor({ taskId: task.id, kind: "start_failed", detail: "boom" });
    await flush();
    assert.equal(count(), 0);
    forgetBoardWakesInMemoryForTests();
    setWakeSender(good);
    wakeKanbanSupervisor({ taskId: task.id, kind: "start_failed", detail: "boom" });
    await flush();
    assert.equal(count(), 1);
    wakeKanbanSupervisor({ taskId: task.id, kind: "start_failed", detail: "boom" });
    assert.equal(sent.length, 1);
  });
});
