/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { CARD_ERROR_LIMIT, cardErrorBlocks, readCleanupEvents, RETRY_ATTEMPT_LIMIT } from "../server/archive-book";
import { runKanban } from "../server/cli";
import { cardDue, cleanupScheduledCountForTests, drainCleanups, enqueueCleanups, flushCleanups, installCleanup, recordCardError, type CleanupOps } from "../server/cleanup";
import { DEFAULT_CONCURRENCY, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { createTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const dir = mkdtempSync(join("/tmp", "cleanup-stop-"));
mkdirSync(join(dir, "agents"), { recursive: true });
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const sent: string[] = [];

after(() => {
  installCleanup(null);
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  setWakeSender(() => {});
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_DATA_DIR;
  delete process.env.KANBAN_AGENTS_DIR;
});

beforeEach(() => {
  sent.length = 0;
  installCleanup(null);
  const db = getDb();
  for (const table of ["events", "runs", "tasks", "links"]) db.exec(`DELETE FROM ${table}`);
  saveConfig({
    autoStart: {},
    supervisorAgentId: "kanban-boss",
    supervisors: {},
    concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
  });
  setAgentAliveCheck((id) => id === "kanban-boss");
  setWakeSender((_id, text) => {
    sent.push(text);
  });
  resetBoardWakeForTests();
});

function failingOps(calls: { archive: number }): CleanupOps {
  return {
    archiveAgent: async () => {
      calls.archive += 1;
      throw new Error("archive down");
    },
    archiveWorkspace: async () => {},
    listAgents: async () => [],
    inspectWorkspace: async () => null,
    // Never archived, never busy: the agent stays there for the reconcile pass to try again.
    inspectAgent: async () => ({ archived: false, busy: false }),
  };
}

function card(agentId: string, finished: boolean): number {
  const ago = new Date(Date.now() - 600 * MIN).toISOString();
  const db = getDb();
  const task = createTask({ project: "stop", title: agentId, role: "executor", workspacePath: dir });
  db.prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, task.id);
  db.prepare(
    ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n     VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
  ).run(task.id, agentId, ago);
  const insert = db.prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, ?, 'kanban', ?)");
  insert.run(task.id, ago, "agent_opened", JSON.stringify({ agentId }));
  if (finished) insert.run(task.id, ago, "cleanup_finished", "{}");
  return task.id;
}

async function ticks(count: number, from: number, step: number): Promise<number> {
  let at = from;
  for (let i = 0; i < count; i += 1) {
    at += step;
    await drainCleanups(new Date(at));
    await flushCleanups();
  }
  return at;
}

describe("a step that failed RETRY_ATTEMPT_LIMIT times is not retried by any tick until a day passes or it is resumed", () => {
  it("cleanup xyz: stops calling the target, survives a restart, wakes once, and resumes on request", async () => {
    const taskId = card("stuck-cleanup", false);
    const calls = { archive: 0 };
    installCleanup(failingOps(calls), { keepSweepClock: false });
    let at = await ticks(RETRY_ATTEMPT_LIMIT + 6, Date.now(), 31 * MIN);
    assert.equal(calls.archive, RETRY_ATTEMPT_LIMIT, "exactly the limit, then nothing");
    const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cleanup' AND json_extract(data_json, '$.action') = 'archive_agent'").all(taskId) as Array<{ data_json: string }>;
    assert.equal(rows.length, 1, "one row, updated in place");
    assert.equal((JSON.parse(rows[0]!.data_json) as { stopped?: boolean }).stopped, true);

    at = await ticks(3, at, 4 * 60 * MIN);
    assert.equal(calls.archive, RETRY_ATTEMPT_LIMIT, "hours later it is still not called");
    // A restart: new state, same database.
    installCleanup(null);
    installCleanup(failingOps(calls), { keepSweepClock: false });
    at = await ticks(3, at, 31 * MIN);
    assert.equal(calls.archive, RETRY_ATTEMPT_LIMIT, "a restart does not clear the stop");
    assert.equal(sent.filter((text) => text.includes("archive_agent")).length, 1, "the supervisor was told once");

    const resumed = (await runKanban(["resume-cleanup", String(taskId)], {})) as { text: string; resumed: number };
    assert.equal(resumed.resumed, 1);
    assert.equal(((await runKanban(["resume-cleanup", String(taskId)], {})) as { resumed: number }).resumed, 0, "nothing left to resume the second time");
    await ticks(1, at, 1000);
    assert.equal(calls.archive, RETRY_ATTEMPT_LIMIT + 1, "resume lets the next tick try again");
  });

  it("reconcile pass: a finished card whose archive keeps failing stops too", async () => {
    const taskId = card("stuck-reconcile", true);
    const calls = { archive: 0 };
    installCleanup(failingOps(calls), { keepSweepClock: false });
    const at = await ticks(RETRY_ATTEMPT_LIMIT + 6, Date.now(), 31 * MIN);
    assert.equal(calls.archive, RETRY_ATTEMPT_LIMIT, "the sweep stopped calling archive at the limit");
    await ticks(3, at, 4 * 60 * MIN);
    assert.equal(calls.archive, RETRY_ATTEMPT_LIMIT);
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'cleanup' AND json_extract(data_json, '$.action') = 'archive_agent'").get(taskId) as { n: number };
    assert.equal(rows.n, 1);
  });
});

describe("the daily retry of a stopped step", () => {
  it("calls the target once a day after the stop, and stays quiet and unwoken when it fails again", async () => {
    const taskId = card("daily", false);
    const calls = { archive: 0 };
    installCleanup(failingOps(calls), { keepSweepClock: false });
    const at = await ticks(RETRY_ATTEMPT_LIMIT + 6, Date.now(), 31 * MIN);
    assert.equal(calls.archive, RETRY_ATTEMPT_LIMIT);
    await ticks(3, at + 30 * 60 * MIN + DAY, 1000);
    assert.equal(calls.archive, RETRY_ATTEMPT_LIMIT + 1, "one try, not one per tick");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'cleanup' AND json_extract(data_json, '$.action') = 'archive_agent'").get(taskId) as { n: number };
    assert.equal(rows.n, 1, "still one row");
    assert.equal(sent.filter((text) => text.includes("archive_agent")).length, 1, "woken once");
  });
});

describe("a card-level stop survives what the reconcile pass writes after it", () => {
  it("an agent that comes back unarchived is re-archived by reconcile, yet the card stays stopped, quiet and unwoken", async () => {
    const taskId = card("card-stop", false);
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'cleanup', 'kanban', ?)")
      .run(taskId, new Date(Date.now() - 300 * MIN).toISOString(), JSON.stringify({ action: "archive_agent", agentId: "card-stop", ok: true, verifyAt: new Date(Date.now() - 200 * MIN).toISOString() }));
    const start = Date.now();
    for (let i = 0; i < CARD_ERROR_LIMIT; i += 1) recordCardError(taskId, "boom", new Date(start));
    assert.equal(sent.filter((text) => text.includes(zhCNPart("cleanup.wake.cardStopped", 6, 10))).length, 1);
    const calls = { archive: 0 };
    const ops: CleanupOps = { ...failingOps(calls), archiveAgent: async () => { calls.archive += 1; } };
    installCleanup(ops, { keepSweepClock: false });
    const at = await ticks(6, start, 31 * MIN);
    assert.ok(calls.archive >= 1, "reconcile did re-archive the agent, writing a success row behind the stop");
    const lastRows = readCleanupEvents(taskId, { verify: false });
    assert.notEqual(lastRows.at(-1)?.action, "error", "the stop is no longer the latest row");
    assert.ok(cardErrorBlocks(lastRows, new Date(at)), "and still holds");
    assert.equal(cardDue(taskId, new Date(at)), false);
    installCleanup(null);
    installCleanup(ops, { keepSweepClock: false });
    await ticks(3, at, 31 * MIN);
    assert.ok(cardErrorBlocks(readCleanupEvents(taskId, { verify: false }), new Date(at + 3 * 31 * MIN)), "a restart does not lift it");
    assert.equal(sent.filter((text) => text.includes(zhCNPart("cleanup.wake.cardStopped", 6, 10))).length, 1, "woken once");
    await runKanban(["resume-cleanup", String(taskId)], {});
    assert.ok(!cardErrorBlocks(readCleanupEvents(taskId, { verify: false }), new Date(at)), "resume lifts it");
  });
});

describe("the schedule stamp of a card that finished while a rerun was pending", () => {
  it("is dropped, not kept for ever", async () => {
    const taskId = card("rerun-finished", false);
    let first = true;
    const ops: CleanupOps = {
      ...failingOps({ archive: 0 }),
      archiveAgent: async () => {
        if (!first) return;
        first = false;
        // Another tick asks for this card while its cleanup runs, and the cleanup then closes.
        enqueueCleanups(new Date(Date.now() + MIN));
        getDb().prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'cleanup_finished', 'kanban', '{}')").run(taskId, new Date().toISOString());
      },
    };
    installCleanup(ops, { keepSweepClock: false });
    await drainCleanups(new Date());
    await flushCleanups();
    assert.equal(cleanupScheduledCountForTests(), 0);
  });
});
