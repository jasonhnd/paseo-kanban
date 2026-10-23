/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import {
  agentStuck,
  CARD_ERROR_LIMIT,
  cardErrorBlocks,
  failureCount,
  nextRetryAt,
  readCleanupEvents,
  resumeCleanup,
  retryReady,
  RETRY_ATTEMPT_LIMIT,
  type CleanupRecord,
} from "../server/archive-book";
import { cardDue, record, recordCardError } from "../server/cleanup";
import { DEFAULT_CONCURRENCY, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { createTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const dir = mkdtempSync(join(tmpdir(), "cleanup-retry-rows-"));
const previousDataDir = process.env.KANBAN_DATA_DIR;
process.env.KANBAN_DATA_DIR = dir;
const MIN = 60_000;
const sent: Array<{ id: string; text: string }> = [];

after(() => {
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  setWakeSender(() => {});
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = previousDataDir;
});

beforeEach(() => {
  sent.length = 0;
  saveConfig({
    autoStart: {},
    supervisorAgentId: "kanban-boss",
    supervisors: {},
    concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
  });
  setAgentAliveCheck((id) => id === "kanban-boss");
  setWakeSender((id, text) => {
    sent.push({ id, text });
  });
  resetBoardWakeForTests();
});

function doneCard(title: string): number {
  const task = createTask({ project: "retry", title, role: "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  return task.id;
}

function rows(taskId: number, action: string): Array<Record<string, unknown>> {
  const found = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cleanup' ORDER BY id").all(taskId) as unknown as Array<{ data_json: string }>;
  return found.map((row) => JSON.parse(row.data_json) as Record<string, unknown>).filter((data) => data.action === action);
}

const DIRECTORY = "/tmp/retry-dir";

function failPurge(taskId: number, events: CleanupRecord[], agentId: string | undefined, now: Date, error = zhCNPart("tempWorkspace.branch.notDeleted", 0, 3)): void {
  record(
    taskId,
    {
      action: "purge_agents",
      ...(agentId ? { agentId } : {}),
      directory: DIRECTORY,
      ok: false,
      outcome: "error",
      error,
      retryAt: nextRetryAt(events, "purge_agents", DIRECTORY, now),
    },
    events,
  );
}

describe("a step that keeps failing costs one row, not one per retry", () => {
  it("updates a purge failure in place and counts the attempts", () => {
    const taskId = doneCard("purge keeps failing");
    const events: CleanupRecord[] = [];
    const start = new Date("2026-10-03T00:00:00.000Z");
    for (let i = 0; i < 5; i += 1) failPurge(taskId, events, "agent-a", new Date(start.getTime() + i * 40 * MIN), `try ${i}`);
    const stored = rows(taskId, "purge_agents");
    assert.equal(stored.length, 1, "five failures are one row");
    assert.equal(stored[0]?.attempts, 5);
    assert.equal(stored[0]?.error, "try 4", "the row shows the latest error");
    assert.equal(failureCount(events, "purge_agents", DIRECTORY), 5, "the backoff still counts every attempt");
    const fresh = readCleanupEvents(taskId);
    assert.equal(failureCount(fresh, "purge_agents", DIRECTORY), 5, "and so does a round that re-reads the log");
    assert.ok(!retryReady(fresh, "purge_agents", DIRECTORY, new Date(start.getTime() + 4 * 40 * MIN + 1)), "the new retryAt is in force");
  });

  it("does not merge across another event about the same agent, or across agents", () => {
    const taskId = doneCard("interleaved");
    const events: CleanupRecord[] = [];
    const now = new Date("2026-10-03T00:00:00.000Z");
    failPurge(taskId, events, "agent-a", now);
    failPurge(taskId, events, "agent-b", now);
    failPurge(taskId, events, "agent-a", new Date(now.getTime() + 40 * MIN));
    failPurge(taskId, events, "agent-b", new Date(now.getTime() + 40 * MIN));
    const stored = rows(taskId, "purge_agents");
    assert.equal(stored.length, 2, "one row per agent");
    assert.deepEqual(stored.map((row) => row.attempts), [2, 2]);
    record(taskId, { action: "purge_agents", agentId: "agent-a", directory: DIRECTORY, ok: true }, events);
    failPurge(taskId, events, "agent-a", new Date(now.getTime() + 80 * MIN));
    assert.equal(rows(taskId, "purge_agents").length, 4, "after a success the next failure is a new row");
  });

  it("keeps counting timeouts row by row, because three in a row make an agent stuck", () => {
    const taskId = doneCard("timeouts");
    const events: CleanupRecord[] = [];
    const now = new Date("2026-10-03T00:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      record(taskId, { action: "archive_agent", agentId: "slow", ok: false, outcome: "timeout", error: zhCN("audit.timeout"), retryAt: nextRetryAt(events, "archive_agent", "slow", new Date(now.getTime() + i * 40 * MIN)) }, events);
    }
    assert.equal(rows(taskId, "archive_agent").length, 3);
    assert.ok(agentStuck(events, "slow"));
  });

  it("merges archive_agent errors and a repeated wait_turn", () => {
    const taskId = doneCard("errors and waits");
    const events: CleanupRecord[] = [];
    const now = new Date("2026-10-03T00:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(now.getTime() + i * 40 * MIN);
      record(taskId, { action: "archive_agent", agentId: "a", ok: false, outcome: "error", error: "down", retryAt: nextRetryAt(events, "archive_agent", "a", at) }, events);
    }
    for (let i = 0; i < 4; i += 1) {
      const at = new Date(now.getTime() + (i + 3) * 40 * MIN);
      record(taskId, { action: "wait_turn", agentId: "b", directory: DIRECTORY, ok: false, reason: "Waiting for this turn to end", retryAt: nextRetryAt(events, "archive_agent", "b", at) }, events);
    }
    assert.equal(rows(taskId, "archive_agent").length, 1);
    assert.equal(rows(taskId, "wait_turn").length, 1);
    assert.equal(rows(taskId, "wait_turn")[0]?.attempts, 4);
  });

  it("stops at the cap, wakes once, and waits a day (or an explicit resume) before trying again", () => {
    const taskId = doneCard("cap");
    const events: CleanupRecord[] = [];
    const start = new Date("2026-10-03T00:00:00.000Z");
    for (let i = 0; i < RETRY_ATTEMPT_LIMIT; i += 1) failPurge(taskId, events, "agent-a", new Date(start.getTime() + i * 40 * MIN));
    const stored = rows(taskId, "purge_agents");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.attempts, RETRY_ATTEMPT_LIMIT);
    assert.equal(stored[0]?.stopped, true);
    assert.equal(sent.filter((message) => message.text.includes("purge_agents")).length, 1, "one wake");
    const fresh = readCleanupEvents(taskId);
    const stoppedAt = start.getTime() + (RETRY_ATTEMPT_LIMIT - 1) * 40 * MIN;
    for (const hours of [1, 10, 23]) {
      assert.equal(retryReady(fresh, "purge_agents", DIRECTORY, new Date(stoppedAt + hours * 60 * MIN)), false, `still stopped after ${hours} hours`);
    }
    assert.equal(retryReady(fresh, "purge_agents", DIRECTORY, new Date(stoppedAt + 25 * 60 * MIN)), true, "the daily retry");
    assert.equal(resumeCleanup(taskId, new Date(start.getTime() + 3 * 24 * 60 * MIN)), 1);
    const resumed = readCleanupEvents(taskId);
    assert.ok(retryReady(resumed, "purge_agents", DIRECTORY, new Date(start.getTime() + 3 * 24 * 60 * MIN)));
    assert.equal(failureCount(resumed, "purge_agents", DIRECTORY), 1, "counting restarts from one attempt");
    assert.equal(resumeCleanup(taskId), 0, "nothing left to resume");
  });

  it("does not update an old failure across a success on the same directory (A fails, B succeeds, A keeps failing)", () => {
    const taskId = doneCard("multi agent purge");
    const events: CleanupRecord[] = [];
    const start = new Date("2026-10-03T00:00:00.000Z");
    failPurge(taskId, events, "agent-a", start);
    record(taskId, { action: "purge_agents", agentId: "agent-b", directory: DIRECTORY, ok: true }, events);
    let at = start.getTime();
    for (let i = 0; i < RETRY_ATTEMPT_LIMIT + 2; i += 1) {
      at += 40 * MIN;
      const now = new Date(at);
      if (!retryReady(events, "purge_agents", DIRECTORY, now)) continue;
      failPurge(taskId, events, "agent-a", now);
    }
    const stored = rows(taskId, "purge_agents").filter((row) => row.ok === false);
    assert.equal(stored.length, 2, "the failure before B's success stays as it was; the later ones are one new row");
    assert.equal(stored[0]?.attempts, undefined);
    assert.equal(stored[1]?.attempts, RETRY_ATTEMPT_LIMIT, "counted from B's success, stopped at the limit");
    assert.equal(stored[1]?.stopped, true);
    assert.equal(failureCount(readCleanupEvents(taskId), "purge_agents", DIRECTORY), RETRY_ATTEMPT_LIMIT, "the count a fresh read sees matches the row");
    assert.equal(retryReady(readCleanupEvents(taskId), "purge_agents", DIRECTORY, new Date(at + 2 * 60 * MIN)), false);
    assert.equal(sent.filter((message) => message.text.includes("purge_agents")).length, 1, "one wake");
  });
});

describe("a cleanup that throws is one backed-off row, not a row a minute", () => {
  it("updates the error row in place, backs off, then stops and wakes once at the limit", () => {
    const taskId = doneCard("throws");
    const start = new Date("2026-10-03T00:00:00.000Z");
    recordCardError(taskId, "bad contract_json", start);
    recordCardError(taskId, "bad contract_json", new Date(start.getTime() + 1 * MIN));
    recordCardError(taskId, "still bad", new Date(start.getTime() + 6 * MIN));
    const stored = rows(taskId, "error");
    assert.equal(stored.length, 1, "three throws are one row");
    assert.equal(stored[0]?.attempts, 3);
    assert.equal(stored[0]?.error, "still bad");
    const events = readCleanupEvents(taskId, { verify: false });
    const asked = new Date(start.getTime() + 7 * MIN);
    assert.ok(cardErrorBlocks(events, asked), "inside the backoff the card is left alone");
    assert.equal(cardDue(taskId, asked), false, "and is not due");
    assert.ok(!cardErrorBlocks(events, new Date(start.getTime() + 6 * MIN + 31 * MIN)), "after the backoff it is tried again");
    assert.equal(sent.length, 0);

    for (let i = 3; i < CARD_ERROR_LIMIT; i += 1) recordCardError(taskId, "still bad", new Date(start.getTime() + (10 + i) * 40 * MIN));
    assert.equal(rows(taskId, "error").length, 1);
    assert.equal(rows(taskId, "error")[0]?.stopped, true);
    assert.equal(sent.filter((message) => message.text.includes(zhCNPart("cleanup.wake.cardStopped", 6, 10))).length, 1, "the supervisor hears once at the limit");
    const stopped = readCleanupEvents(taskId, { verify: false });
    const later = new Date(start.getTime() + (10 + CARD_ERROR_LIMIT) * 40 * MIN + 2 * 60 * MIN);
    assert.ok(cardErrorBlocks(stopped, later), "a stopped card stays blocked for the day");
    assert.equal(cardDue(taskId, later), false);
    assert.equal(resumeCleanup(taskId, later), 1);
    assert.ok(!cardErrorBlocks(readCleanupEvents(taskId, { verify: false }), later), "resume lets it run again");
  });

  it("starts a new row once something else was recorded after the error", () => {
    const taskId = doneCard("recovers");
    const start = new Date("2026-10-03T00:00:00.000Z");
    recordCardError(taskId, "boom", start);
    const events = readCleanupEvents(taskId, { verify: false });
    record(taskId, { action: "skip_workspace", reason: "lane", ok: true }, events);
    recordCardError(taskId, "boom again", new Date(start.getTime() + 2 * MIN));
    assert.equal(rows(taskId, "error").length, 2);
  });
});
