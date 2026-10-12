/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { record } from "../server/cleanup";
import type { CleanupRecord } from "../server/archive-book";
import { compactVerifyEvents } from "../server/compact-events";
import { closeDb, getDb } from "../server/db";
import { upsertSummaryEvent } from "../server/event-summary";
import { prepareNativeSession } from "../server/native-sessions";
import { appendEvent, createTask } from "../server/store";
import { summaryCount } from "../shared/event-summary";

const root = mkdtempSync(join(tmpdir(), "event-summary-"));
const NOW = new Date("2026-11-15T00:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
let counter = 0;
let dir = "";
const original = { ...process.env };

beforeEach(() => {
  closeDb();
  dir = join(root, `case-${counter++}`);
  mkdirSync(join(dir, "agents", "test"), { recursive: true });
  process.env.KANBAN_DATA_DIR = join(dir, "db");
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  process.env.HOME = dir;
});
afterEach(() => closeDb());
after(() => {
  closeDb();
  process.env = original;
  rmSync(root, { recursive: true, force: true });
});

function rows(taskId: number, kind: string): Array<Record<string, any> & { rowAt: string }> {
  return (getDb().prepare("SELECT at, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{ at: string; data_json: string }>)
    .map((row) => ({ ...JSON.parse(row.data_json), rowAt: row.at }));
}

function newCard(): number {
  return createTask({ project: "summary", title: "Summary", role: "executor", workspacePath: dir }).id;
}

describe("summary events: one row per card and kind", () => {
  it("upsertSummaryEvent folds repeats of the same key into one row with a count", () => {
    const id = newCard();
    upsertSummaryEvent(id, "tmp_cleaned", "scheduler", "/tmp/A_1", { path: "/tmp/A_1", bytes: 1 }, { at: "2026-11-01T00:00:00.000Z" });
    upsertSummaryEvent(id, "tmp_cleaned", "scheduler", "/tmp/A_1", { path: "/tmp/A_1", bytes: 2 }, { at: "2026-11-02T00:00:00.000Z" });
    upsertSummaryEvent(id, "tmp_cleaned", "scheduler", "/tmp/A_1", { path: "/tmp/A_1", bytes: 3 }, { at: "2026-11-03T00:00:00.000Z" });
    upsertSummaryEvent(id, "tmp_cleaned", "scheduler", "/tmp/B_1", { path: "/tmp/B_1", bytes: 9 }, { at: "2026-11-03T00:00:00.000Z" });
    const found = rows(id, "tmp_cleaned");
    assert.equal(found.length, 2, "one row per distinct key");
    const a = found.find((row) => row.path === "/tmp/A_1")!;
    assert.equal(a.count, 3);
    assert.equal(a.firstAt, "2026-11-01T00:00:00.000Z");
    assert.equal(a.lastAt, "2026-11-03T00:00:00.000Z");
    assert.equal(a.bytes, 3, "the latest detail wins");
    assert.equal(a.rowAt, "2026-11-03T00:00:00.000Z", "the row's own time follows the last occurrence so retention counts from it");
    assert.equal(summaryCount(a), 3);
    assert.equal(summaryCount({ count: 5 }), null, "an ordinary row with a stray count field is not a summary");
  });

  it("different cards never share a summary row", () => {
    const first = newCard();
    const second = newCard();
    upsertSummaryEvent(first, "native_session_project_dir_removed", "kanban", "/d", { directory: "/d" });
    upsertSummaryEvent(second, "native_session_project_dir_removed", "kanban", "/d", { directory: "/d" });
    assert.equal(rows(first, "native_session_project_dir_removed").length, 1);
    assert.equal(rows(second, "native_session_project_dir_removed").length, 1);
  });

  it("list entries accumulate without duplicates", () => {
    const id = newCard();
    const list = (entry: string) => ({ list: { field: "sessions", entry: { agentId: entry }, cap: 10 } });
    for (const agent of ["a", "b", "a", "c"]) upsertSummaryEvent(id, "native_session_skipped", "kanban", "r", { reason: "r" }, list(agent));
    const [row] = rows(id, "native_session_skipped");
    assert.equal(row!.count, 4);
    assert.deepEqual(row!.sessions, [{ agentId: "a" }, { agentId: "b" }, { agentId: "c" }]);
  });

  it("native_session_skipped for several agents of one card leaves one row per reason, keeping every agent", async () => {
    const id = newCard();
    const agents = ["grok-1", "grok-2", "grok-3"];
    for (const agentId of agents) {
      fs.writeFileSync(join(dir, "agents", "test", `${agentId}.json`), JSON.stringify({ id: agentId, provider: "grok", cwd: "/work/x", title: "Executor", labels: {}, persistence: { sessionId: `s-${agentId}` } }));
      appendEvent(id, "agent_opened", null, null, "kanban", { agentId });
      await prepareNativeSession(id, agentId);
    }
    const leader = "leader-1";
    fs.writeFileSync(join(dir, "agents", "test", `${leader}.json`), JSON.stringify({ id: leader, provider: "claude", cwd: "/work/x", title: "<leader> · summary", labels: {}, persistence: { sessionId: "s-l" } }));
    appendEvent(id, "agent_opened", null, null, "kanban", { agentId: leader });
    await prepareNativeSession(id, leader);

    const found = rows(id, "native_session_skipped");
    assert.equal(found.length, 2, (zhCN("nativeSessions.skip.noNativeSession") + " and leader " + zhCNPart("nativeSessions.kept.leader", 7, 11) + " are two reasons, so two rows"));
    const provider = found.find((row) => row.reason === zhCN("nativeSessions.skip.noNativeSession"))!;
    assert.equal(provider.count, 3);
    assert.deepEqual(provider.sessions.map((s: { agentId: string }) => s.agentId), agents);
    assert.equal(provider.agentId, "grok-3", "top-level agentId stays readable for old readers");
    assert.equal(found.find((row) => row.reason === zhCN("nativeSessions.kept.leader"))!.count, 1);
  });
});

describe("cleanup rows: repeated confirmations fold, failures stay one by one", () => {
  it("a repeated successful verify_agent for the same agent is one row with a count", () => {
    const id = newCard();
    const events: CleanupRecord[] = [];
    record(id, { action: "verify_agent", agentId: "a1", ok: true }, events);
    record(id, { action: "verify_agent", agentId: "a1", ok: true }, events);
    record(id, { action: "verify_agent", agentId: "a1", ok: true }, []);
    const found = rows(id, "cleanup").filter((row) => row.action === "verify_agent");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.count, 3);
    assert.ok(found[0]!.firstAt && found[0]!.lastAt);
  });

  it("a verify_agent after another step on the same agent is a new row, so verifyRecorded stays correct", () => {
    const id = newCard();
    const events: CleanupRecord[] = [];
    record(id, { action: "verify_agent", agentId: "a1", ok: true }, events);
    record(id, { action: "archive_agent", agentId: "a1", ok: true }, events);
    record(id, { action: "verify_agent", agentId: "a1", ok: true }, events);
    record(id, { action: "verify_agent", agentId: "a2", ok: true }, events);
    const verify = rows(id, "cleanup").filter((row) => row.action === "verify_agent");
    assert.deepEqual(verify.map((row) => [row.agentId, row.count ?? 1]), [["a1", 1], ["a1", 1], ["a2", 1]]);
  });

  it("failed cleanup steps are still written one by one", () => {
    const id = newCard();
    const events: CleanupRecord[] = [];
    for (let n = 0; n < 3; n += 1) record(id, { action: "drop_directory", directory: "/x", ok: false, error: `e${n}` }, events);
    record(id, { action: "verify_agent", agentId: "a1", ok: false, error: "nope" }, events);
    record(id, { action: "verify_agent", agentId: "a1", ok: false, error: "nope" }, events);
    const found = rows(id, "cleanup");
    assert.equal(found.length, 5, "no merging for ok:false rows");
    assert.ok(found.every((row) => row.count == null));
  });
});

describe("compact-events: summary kinds expire after 7 days", () => {
  const SHORT = ["native_session_skipped", "native_session_project_dir_removed", "tmp_cleaned"];

  function seed(taskId: number, at: string): void {
    for (const kind of SHORT) appendEvent(taskId, kind, null, null, "kanban", { marker: at }, at);
  }

  it("dry-run lists the three kinds once they are older than 7 days on a finished card", () => {
    const old = newCard();
    const fresh = newCard();
    const running = newCard();
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id IN (?, ?)").run(old, fresh);
    seed(old, daysAgo(8));
    seed(fresh, daysAgo(6));
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(running);
    seed(running, daysAgo(40));

    const result = compactVerifyEvents({ apply: false, env: {}, now: NOW });
    assert.equal(result.retentionDays, 30, "the global default stays 30");
    assert.deepEqual(
      result.expiredByKind.filter((item) => SHORT.includes(item.kind)).map((item) => [item.kind, item.count]).sort(),
      SHORT.map((kind) => [kind, 1]).sort(),
      "only the 8-day-old rows of the finished card, one per kind",
    );

    compactVerifyEvents({ apply: true, env: {}, now: NOW });
    for (const kind of SHORT) {
      assert.equal(rows(old, kind).length, 0, `${kind} gone from the old finished card`);
      assert.equal(rows(fresh, kind).length, 1, `${kind} kept at 6 days`);
      assert.equal(rows(running, kind).length, 1, `${kind} kept on a running card`);
    }
  });

  it("other whitelist kinds keep the 30-day period and --days still narrows everything", () => {
    const id = newCard();
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    appendEvent(id, "stall_nudge", null, null, "kanban", {}, daysAgo(20));
    appendEvent(id, "tmp_cleaned", null, null, "kanban", {}, daysAgo(4));
    const wide = compactVerifyEvents({ apply: false, env: {}, now: NOW });
    assert.deepEqual(wide.expiredByKind, []);
    const narrow = compactVerifyEvents({ apply: false, env: {}, now: NOW, retentionDays: 3 });
    assert.deepEqual(narrow.expiredByKind.map((item) => item.kind).sort(), ["stall_nudge", "tmp_cleaned"]);
  });
});
