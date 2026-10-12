/// <reference types="node" />
import { zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import {
  CARD_ERROR_LIMIT,
  cardErrorBlocks,
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

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "cleanup-auto-retry-"));
process.env.KANBAN_DATA_DIR = dir;
const MIN = 60_000;
const HOUR = 60 * MIN;
const sent: Array<{ id: string; text: string }> = [];
const DIRECTORY = "/tmp/auto-retry-dir";
const START = new Date("2026-10-03T00:00:00.000Z");

after(() => {
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  setWakeSender(() => {});
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_DATA_DIR;
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
  const task = createTask({ project: "auto", title, role: "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  return task.id;
}

function rows(taskId: number, action: string): Array<Record<string, unknown>> {
  const found = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cleanup' ORDER BY id").all(taskId) as unknown as Array<{ data_json: string }>;
  return found.map((row) => JSON.parse(row.data_json) as Record<string, unknown>).filter((data) => data.action === action);
}

function failPurge(taskId: number, events: CleanupRecord[], now: Date): void {
  record(
    taskId,
    { action: "purge_agents", agentId: "agent-a", directory: DIRECTORY, ok: false, outcome: "error", error: zhCNPart("tempWorkspace.branch.notDeleted", 0, 3), retryAt: nextRetryAt(events, "purge_agents", DIRECTORY, now) },
    events,
  );
}

function stopPurge(taskId: number): Date {
  const events: CleanupRecord[] = [];
  let at = START;
  for (let i = 0; i < RETRY_ATTEMPT_LIMIT; i += 1) {
    at = new Date(START.getTime() + i * 40 * MIN);
    failPurge(taskId, events, at);
  }
  return at;
}

describe("a stopped step tries again by itself every 24 hours", () => {
  it("is not due inside the day, is due after it, and a failing retry stops again without waking twice", () => {
    const taskId = doneCard("auto step");
    const stoppedAt = stopPurge(taskId);
    assert.equal(rows(taskId, "purge_agents")[0]?.stopped, true);
    assert.equal(sent.filter((message) => message.text.includes("purge_agents")).length, 1);
    const fresh = readCleanupEvents(taskId);
    assert.equal(retryReady(fresh, "purge_agents", DIRECTORY, new Date(stoppedAt.getTime() + 20 * HOUR)), false, "quiet inside the day");
    const due = new Date(stoppedAt.getTime() + 25 * HOUR);
    assert.equal(retryReady(fresh, "purge_agents", DIRECTORY, due), true, "one try a day after the stop");

    failPurge(taskId, fresh, due);
    assert.equal(rows(taskId, "purge_agents").length, 1, "still one row");
    assert.equal(rows(taskId, "purge_agents")[0]?.stopped, true, "stopped again");
    assert.equal(sent.filter((message) => message.text.includes("purge_agents")).length, 1, "the supervisor is not woken again");
    const again = readCleanupEvents(taskId);
    assert.equal(retryReady(again, "purge_agents", DIRECTORY, new Date(due.getTime() + 20 * HOUR)), false);
    assert.equal(retryReady(again, "purge_agents", DIRECTORY, new Date(due.getTime() + 25 * HOUR)), true);
  });

  it("resume-cleanup still retries at once", () => {
    const taskId = doneCard("resume now");
    const stoppedAt = stopPurge(taskId);
    const soon = new Date(stoppedAt.getTime() + 2 * HOUR);
    assert.equal(retryReady(readCleanupEvents(taskId), "purge_agents", DIRECTORY, soon), false);
    assert.equal(resumeCleanup(taskId, soon), 1);
    assert.equal(retryReady(readCleanupEvents(taskId), "purge_agents", DIRECTORY, soon), true);
  });
});

describe("a card-level stop does not depend on the last row", () => {
  function stopCard(taskId: number): Date {
    let at = START;
    for (let i = 0; i < CARD_ERROR_LIMIT; i += 1) {
      at = new Date(START.getTime() + i * 40 * MIN);
      recordCardError(taskId, "boom", at);
    }
    return at;
  }

  it("a reconcile success row written afterwards does not lift the stop", () => {
    const taskId = doneCard("card stop survives");
    const stoppedAt = stopCard(taskId);
    const events = readCleanupEvents(taskId, { verify: false });
    record(taskId, { action: "archive_agent", agentId: "late", ok: true }, events);
    const later = new Date(stoppedAt.getTime() + 2 * HOUR);
    const after = readCleanupEvents(taskId, { verify: false });
    assert.ok(cardErrorBlocks(after, later), "still stopped");
    assert.equal(cardDue(taskId, later), false);
  });

  it("is lifted by the daily retry, a failing retry stops again without waking twice, and resume clears it", () => {
    const taskId = doneCard("card daily");
    const stoppedAt = stopCard(taskId);
    const events = readCleanupEvents(taskId, { verify: false });
    record(taskId, { action: "archive_agent", agentId: "late", ok: true }, events);
    const due = new Date(stoppedAt.getTime() + 25 * HOUR);
    assert.ok(!cardErrorBlocks(readCleanupEvents(taskId, { verify: false }), due), "a day later it is tried");
    recordCardError(taskId, "boom", due);
    assert.equal(rows(taskId, "error").length, 1, "the same row, not a fresh count");
    assert.equal(rows(taskId, "error")[0]?.stopped, true);
    assert.equal(sent.filter((message) => message.text.includes(zhCNPart("cleanup.wake.cardStopped", 6, 10))).length, 1, "woken once");
    assert.ok(cardErrorBlocks(readCleanupEvents(taskId, { verify: false }), new Date(due.getTime() + 2 * HOUR)));
    assert.equal(resumeCleanup(taskId, due), 1);
    assert.ok(!cardErrorBlocks(readCleanupEvents(taskId, { verify: false }), due));
  });
});
