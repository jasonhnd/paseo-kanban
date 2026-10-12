/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import { runKanban } from "../server/cli";
import { compactVerifyEvents, EXPIRING_EVENT_KINDS } from "../server/compact-events";
import { closeDb, getDb } from "../server/db";
import { cleanupNoteFor, overdueAgentIds } from "../server/archive-book";
import { cardDue } from "../server/cleanup";
import { cleanupFinished } from "../server/archive-book";
import { vacuumKanbanDb } from "../server/vacuum";
import { appendEvent, createTask } from "../server/store";

const root = mkdtempSync(join(tmpdir(), "compact-retention-"));
const NOW = new Date("2026-11-15T00:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

let dir = "";
let counter = 0;

beforeEach(() => {
  dir = join(root, `case-${counter++}`);
  mkdirSync(dir, { recursive: true });
  process.env.KANBAN_DATA_DIR = dir;
  closeDb();
});

afterEach(() => closeDb());

after(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function kindsLeft(taskId: number): string[] {
  return (getDb().prepare("SELECT kind FROM events WHERE task_id = ? ORDER BY id").all(taskId) as Array<{ kind: string }>).map((row) => row.kind);
}

function finish(taskId: number, status: string): void {
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
}

function seed(taskId: number, kinds: string[], at: string): void {
  for (const kind of kinds) appendEvent(taskId, kind, null, null, "kanban", kind === "cleanup" ? { action: "archive_agent" } : {}, at);
}

function fakeBackups(names: string[], baseAgeDays: number): string[] {
  return names.map((name, index) => {
    const file = join(dir, name);
    writeFileSync(file, `snapshot ${name}`);
    const when = new Date(NOW.getTime() - (baseAgeDays - index) * DAY);
    utimesSync(file, when, when);
    return file;
  });
}

const OLD_FLOW = ["held", "downstream_dispatched", "stall_nudge", "nudge", "nudge_reset", "tmp_cleaned", "native_session_skipped", "native_session_project_dir_removed", "native_session_archive_failed", "native_session_claimed", "native_session_claim_released", "wake_acceptance", "wake_acceptance_repeat", "wake_blocked", "wake_children", "wake_review_hold"];
// Summary-style kinds (TEST_0254) expire after 7 days, so their 29-day-old copies go too.
const SHORT_FLOW = ["tmp_cleaned", "native_session_skipped", "native_session_project_dir_removed"];
// State that cleanup, native-session retirement, audit and wake de-duplication read back, plus the card trail.
const KEEP_ALWAYS = [
  "created", "started", "complete", "approve", "request_changes", "accept", "rework_reopened", "leader_pass", "comment", "reject", "rejected", "blocked", "link", "landed", "release_agent", "workspace_bound",
  "cleanup", "cleanup_finished", "temp_workspace_cleaned", "agent_purged", "native_session_identified", "native_session_ready", "native_session_archived",
  "wake_parent_merge", "wake_land", "wake_missing_pr", "wake_prerequisite", "wake_skipped_missing_cwd", "board_wake",
  "wakeup", "native-session-x", "nativesession", "wake", "native_session",
];

describe("compact-events retention", () => {
  it("deletes old whitelisted flow events on a finished card and nothing else", () => {
    const task = createTask({ project: "ret", title: "Old sample", role: "executor", workspacePath: dir });
    finish(task.id, "done");
    seed(task.id, [...OLD_FLOW, ...KEEP_ALWAYS], daysAgo(45));

    const result = compactVerifyEvents({ apply: true, env: {}, now: NOW });

    assert.equal(result.expired, OLD_FLOW.length);
    assert.equal(result.duplicateVerify, 0);
    const left = kindsLeft(task.id);
    for (const kind of KEEP_ALWAYS) assert.ok(left.includes(kind), `${kind} must stay`);
    for (const kind of OLD_FLOW) assert.ok(!left.includes(kind), `${kind} must go`);
    assert.ok(left.includes("created"), "events the card's own creation made also stay");
  });

  it("previews and deletes only write audits older than 30 days, including taskless and open-card calls", () => {
    const task = createTask({ project: "ret", title: "audit retention", role: "executor" });
    finish(task.id, "running");
    const db = getDb();
    const ids: number[] = [];
    for (const age of [1, 29, 30, 31]) {
      const row = db.prepare(`INSERT INTO write_audits (at, operation, task_id, role, source_json, outcome)
        VALUES (?, 'kanban_complete', ?, 'executor', '{}', 'returned')`).run(daysAgo(age), task.id);
      ids.push(Number(row.lastInsertRowid));
    }
    const orphan = Number(db.prepare(`INSERT INTO write_audits (at, operation, task_id, role, source_json, outcome)
      VALUES (?, 'kanban_comment', NULL, 'unauthenticated', '{}', 'threw')`).run(daysAgo(45)).lastInsertRowid);
    const rows = () => (db.prepare("SELECT id FROM write_audits ORDER BY id").all() as Array<{ id: number }>).map(row => row.id);
    const all = rows();
    const preview = compactVerifyEvents({ apply: false, env: {}, now: NOW });
    assert.equal(preview.writeAuditsBefore, 5);
    assert.equal(preview.expiredWriteAudits, 2);
    assert.equal(preview.writeAuditsAfter, 5);
    assert.match(preview.text, /write_audits.*2/);
    assert.deepEqual(rows(), all, "dry-run must not mutate audits");
    assert.equal(preview.remove, 0, "existing remove counter remains event-only");

    const applied = compactVerifyEvents({ apply: true, env: {}, now: NOW });
    assert.equal(applied.expiredWriteAudits, 2);
    assert.equal(applied.writeAuditsAfter, 3);
    assert.deepEqual(rows(), ids.slice(0, 3), "exactly 30 days is still retained");
    assert.match(applied.text, /write_audits.*2/);
    const backup = new DatabaseSync(applied.backup!, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM write_audits").get()?.n, 5);
      assert.ok(backup.prepare("SELECT id FROM write_audits WHERE id = ?").get(orphan));
    } finally { backup.close(); }
    assert.equal(compactVerifyEvents({ apply: true, env: {}, now: NOW }).expiredWriteAudits, 0);
  });

  it("--days adjusts write-audit retention and snapshot IDs protect later audit inserts", () => {
    const db = getDb();
    const insert = (age: number) => Number(db.prepare(`INSERT INTO write_audits (at, operation, role, source_json, outcome)
      VALUES (?, 'complete', 'executor', '{}', 'started')`).run(daysAgo(age)).lastInsertRowid);
    const original = insert(8);
    const boundary = insert(7);
    assert.equal(compactVerifyEvents({ apply: false, env: {}, now: NOW }).expiredWriteAudits, 0);
    assert.equal(compactVerifyEvents({ apply: false, env: {}, now: NOW, retentionDays: 7 }).expiredWriteAudits, 1);
    const exec = db.exec.bind(db);
    let late = 0;
    const hook = mock.method(db, "exec", (sql: string) => {
      if (sql === "BEGIN" && !late) late = insert(9);
      return exec(sql);
    });
    let result;
    try { result = compactVerifyEvents({ apply: true, env: {}, now: NOW, retentionDays: 7 }); }
    finally { hook.mock.restore(); }
    assert.equal(result.expiredWriteAudits, 1);
    assert.equal(result.writeAuditsBefore, 2);
    assert.equal(result.writeAuditsAfter, 2);
    assert.equal(db.prepare("SELECT id FROM write_audits WHERE id = ?").get(original), undefined);
    assert.ok(db.prepare("SELECT id FROM write_audits WHERE id = ?").get(boundary));
    assert.ok(db.prepare("SELECT id FROM write_audits WHERE id = ?").get(late));
    assert.equal(compactVerifyEvents({ apply: true, env: {}, now: NOW, retentionDays: 7 }).expiredWriteAudits, 1);
  });

  it("an old schema without write_audits stays untouched in dry-run and is backed up before migration", () => {
    const db = getDb();
    db.exec("DROP TABLE write_audits");
    const before = db.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
    const preview = compactVerifyEvents({ apply: false, env: {}, now: NOW });
    assert.equal(preview.expiredWriteAudits, 0);
    assert.equal(preview.writeAuditsBefore, 0);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(), before);
    closeDb();
    const applied = compactVerifyEvents({ apply: true, env: {}, now: NOW });
    assert.equal(applied.expiredWriteAudits, 0);
    const backup = new DatabaseSync(applied.backup!, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'write_audits'").get(), undefined); }
    finally { backup.close(); }
    assert.ok(getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'write_audits'").get());
  });

  it("repeated verify_agent rows obey the retention period too", () => {
    const task = createTask({ project: "ret", title: "Verify again", role: "executor", workspacePath: dir });
    finish(task.id, "done");
    const verify = (agent: string, ages: number[]) => {
      for (const age of ages) appendEvent(task.id, "cleanup", null, null, "kanban", { action: "verify_agent", agentId: agent, ok: true }, daysAgo(age));
    };
    verify("recent", [3, 2, 1]);
    verify("boundary", [40, 30, 29]);
    verify("justOver", [40, 31, 29]);
    verify("old", [60, 50, 40, 31]);
    const rows = (agent: string) => (getDb().prepare("SELECT at FROM events WHERE kind = 'cleanup' AND json_extract(data_json, '$.agentId') = ? ORDER BY id").all(agent) as Array<{ at: string }>).length;

    const preview = compactVerifyEvents({ apply: false, env: {}, now: NOW });
    assert.equal(preview.duplicateVerify, 3, "justOver loses its 31-day row, old loses two, recent and boundary lose none");
    assert.equal(rows("recent"), 3);

    compactVerifyEvents({ apply: true, env: {}, now: NOW });

    assert.equal(rows("recent"), 3, "1 and 2 days old stay");
    assert.equal(rows("boundary"), 3, "exactly 30 days old is not older than the cutoff");
    assert.equal(rows("justOver"), 2);
    assert.equal(rows("old"), 2, "first and last are always kept");
  });

  it("no deletion branch removes an event that carries a commentId", () => {
    const task = createTask({ project: "ret", title: "Every branch", role: "executor", workspacePath: dir });
    finish(task.id, "done");
    const comment = (age: number): number => {
      getDb().prepare("INSERT INTO comments (task_id, author, body, created_at) VALUES (?, 'supervisor', 'c', ?)").run(task.id, daysAgo(age));
      return (getDb().prepare("SELECT MAX(id) AS id FROM comments").get() as { id: number }).id;
    };
    // Duplicate verify_agent branch: first and last stay anyway, the linked middle row must stay too.
    const verify = (age: number, extra: object = {}) => appendEvent(task.id, "cleanup", null, null, "kanban", { action: "verify_agent", agentId: "linked", ok: true, ...extra }, daysAgo(age));
    verify(60);
    const linkedComment = comment(50);
    verify(50, { commentId: linkedComment });
    verify(49);
    verify(48);
    verify(1);
    // Whitelist branch: every expiring kind, once with a commentId (kept) and once without (deleted).
    for (const kind of EXPIRING_EVENT_KINDS) {
      appendEvent(task.id, kind, null, null, "scheduler", { commentId: comment(45), marker: "linked" }, daysAgo(45));
      appendEvent(task.id, kind, null, null, "scheduler", { marker: "plain" }, daysAgo(45));
    }
    const commentsBefore = (getDb().prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;

    const preview = compactVerifyEvents({ apply: false, env: {}, now: NOW });
    assert.equal(preview.expired, EXPIRING_EVENT_KINDS.length, "only the plain copies are candidates");
    assert.equal(preview.duplicateVerify, 2, "the linked middle row is not a candidate");

    const applied = compactVerifyEvents({ apply: true, env: {}, now: NOW });

    assert.equal(applied.remove, EXPIRING_EVENT_KINDS.length + 2);
    const linked = (getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? AND json_extract(data_json, '$.commentId') IS NOT NULL").all(task.id) as Array<{ kind: string; data_json: string }>);
    assert.equal(linked.length, EXPIRING_EVENT_KINDS.length + 1, "every linked event, verify_agent included, is still there");
    assert.ok(linked.some((row) => row.kind === "cleanup" && JSON.parse(row.data_json).commentId === linkedComment));
    for (const kind of EXPIRING_EVENT_KINDS) assert.equal(linked.filter((row) => row.kind === kind).length, 1, kind);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n, commentsBefore);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND json_extract(data_json, '$.marker') = 'plain'").get(task.id)?.n, 0);
  });

  it("the final DELETE re-checks commentId: a row linked after the snapshot survives", () => {
    const task = createTask({ project: "ret", title: "Link after snapshot", role: "executor", workspacePath: dir });
    finish(task.id, "done");
    seed(task.id, ["held", "held"], daysAgo(60));
    const ids = (getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'held' ORDER BY id").all(task.id) as Array<{ id: number }>).map((row) => row.id);
    const live = getDb();
    const exec = live.exec.bind(live);
    const hook = mock.method(live, "exec", (sql: string) => {
      if (sql === "BEGIN") live.prepare("UPDATE events SET data_json = ? WHERE id = ?").run(JSON.stringify({ commentId: 7 }), ids[0]);
      return exec(sql);
    });
    let result;
    try { result = compactVerifyEvents({ apply: true, env: {}, now: NOW }); } finally { hook.mock.restore(); }
    assert.equal(result.remove, 1, "the snapshot chose both; the guard spared the linked one");
    assert.deepEqual((getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'held'").all(task.id) as Array<{ id: number }>).map((row) => row.id), [ids[0]]);
  });

  it("closing cleanup state survives: the card is not due again and nothing turns overdue", () => {
    const task = createTask({ project: "ret", title: "Cleanup finished", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    appendEvent(task.id, "agent_opened", null, null, "kanban", { agentId: "old-agent" }, daysAgo(46));
    appendEvent(task.id, "accept", "acceptance", "done", "supervisor", {}, daysAgo(45));
    appendEvent(task.id, "cleanup", null, null, "kanban", { action: "verify_agent", agentId: "old-agent", ok: true }, daysAgo(45));
    appendEvent(task.id, "cleanup", null, null, "kanban", { action: "archive_agent", agentId: "old-agent", ok: true }, daysAgo(45));
    appendEvent(task.id, "cleanup_finished", null, null, "kanban", {}, daysAgo(45));
    appendEvent(task.id, "temp_workspace_cleaned", null, null, "kanban", {}, daysAgo(45));
    appendEvent(task.id, "held", "done", "done", "scheduler", { kind: "quota" }, daysAgo(45));
    const state = () => ({
      due: cardDue(task.id, NOW),
      overdue: overdueAgentIds(task.id, NOW),
      note: cleanupNoteFor(task.id, NOW),
      finished: cleanupFinished(task.id),
      cleanup: (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind IN ('cleanup', 'cleanup_finished', 'temp_workspace_cleaned')").get(task.id) as { n: number }).n,
    });
    const before = state();
    assert.equal(before.due, false);
    assert.deepEqual(before.overdue, []);

    const result = compactVerifyEvents({ apply: true, env: {}, now: NOW });

    assert.equal(result.remove, 1, "only the held line");
    assert.deepEqual(state(), before);
  });

  it("keeps events that carry a commentId, and the comment they point at", () => {
    const task = createTask({ project: "ret", title: "Comment link", role: "executor", workspacePath: dir });
    finish(task.id, "done");
    getDb().prepare("INSERT INTO comments (task_id, author, body, created_at) VALUES (?, 'scheduler', 'c', ?)").run(task.id, daysAgo(45));
    const commentId = (getDb().prepare("SELECT MAX(id) AS id FROM comments").get() as { id: number }).id;
    appendEvent(task.id, "wake_parent_merge", null, "done", "scheduler", { parentId: task.id, commentId }, daysAgo(45));
    appendEvent(task.id, "wake_blocked", null, "done", "scheduler", { commentId }, daysAgo(45));
    appendEvent(task.id, "wake_blocked", null, "done", "scheduler", {}, daysAgo(45));

    const result = compactVerifyEvents({ apply: true, env: {}, now: NOW });

    assert.equal(result.expired, 1, "only the wake_blocked without a commentId");
    assert.equal(kindsLeft(task.id).filter((kind) => kind === "wake_parent_merge").length, 1);
    assert.equal(kindsLeft(task.id).filter((kind) => kind === "wake_blocked").length, 1);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM comments WHERE id = ?").get(commentId) as { n: number }).n, 1);
  });

  it("keeps whitelisted events inside the retention period, and a dry-run deletes nothing", () => {
    const task = createTask({ project: "ret", title: "New sample", role: "executor", workspacePath: dir });
    finish(task.id, "archived");
    seed(task.id, OLD_FLOW, daysAgo(29));
    seed(task.id, OLD_FLOW, daysAgo(31));
    const total = kindsLeft(task.id).length;

    const preview = compactVerifyEvents({ apply: false, env: {}, now: NOW });

    assert.equal(preview.dryRun, true);
    assert.equal(preview.expired, OLD_FLOW.length + SHORT_FLOW.length, "the 31-day-old copy, plus the 29-day-old copy of the 7-day kinds");
    assert.match(preview.text, /dry-run/);
    assert.equal(kindsLeft(task.id).length, total);

    const applied = compactVerifyEvents({ apply: true, env: {}, now: NOW });
    assert.equal(applied.remove, OLD_FLOW.length + SHORT_FLOW.length);
    assert.equal(kindsLeft(task.id).length, total - OLD_FLOW.length - SHORT_FLOW.length);
    const oldest = getDb().prepare("SELECT MIN(at) AS at FROM events WHERE kind = 'wake_review_hold'").get() as { at: string };
    assert.equal(oldest.at, daysAgo(29));
  });

  it("honours --days from the CLI", async () => {
    const task = createTask({ project: "ret", title: "Day count", role: "executor", workspacePath: dir });
    finish(task.id, "done");
    seed(task.id, ["held"], new Date(Date.now() - 10 * DAY).toISOString());

    const wide = (await runKanban(["compact-events", "--dry-run"], {})) as { expired: number; retentionDays: number };
    assert.equal(wide.retentionDays, 30);
    assert.equal(wide.expired, 0);
    const narrow = (await runKanban(["compact-events", "--dry-run", "--days", "7"], {})) as { expired: number; retentionDays: number };
    assert.equal(narrow.retentionDays, 7);
    assert.equal(narrow.expired, 1);
    await assert.rejects(() => runKanban(["compact-events", "--days", "0"], {}), new RegExp(localePattern(zhCNPart("settings.error.global", 7, 12))));
    await assert.rejects(() => runKanban(["compact-events", "--days", "abc"], {}), new RegExp(localePattern(zhCNPart("settings.error.global", 7, 12))));
  });

  it("never deletes events of a card that is still open", () => {
    const task = createTask({ project: "ret", title: "Unfinished", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(task.id);
    seed(task.id, OLD_FLOW, daysAgo(90));

    const result = compactVerifyEvents({ apply: true, env: {}, now: NOW });

    assert.equal(result.expired, 0);
    assert.equal(kindsLeft(task.id).filter((kind) => OLD_FLOW.includes(kind)).length, OLD_FLOW.length);
  });

  it("keeps only the newest two kanban.db backups and leaves other databases alone", () => {
    const task = createTask({ project: "ret", title: "demo fixture", role: "executor", workspacePath: dir });
    finish(task.id, "done");
    const old = fakeBackups(["kanban.db.bak-a", "kanban.db.bak-b", "kanban.db.bak-c", "kanban.db.bak-d"], 20);
    const other = join(dir, "codex-state_5.sqlite.backup-2026-10-02");
    writeFileSync(other, "codex");
    writeFileSync(join(dir, "kanban.db.bak-a-wal"), "sidecar");

    const preview = compactVerifyEvents({ apply: false, env: {}, now: NOW });
    assert.deepEqual(preview.prunedBackups.sort(), [old[0], old[1], old[2]].sort(), "dry-run lists everything but the newest one");
    assert.ok(old.every((file) => existsSync(file)), "dry-run deletes nothing");

    const applied = compactVerifyEvents({ apply: true, env: {}, now: NOW });

    const names = readdirSync(dir).filter((name) => name.startsWith("kanban.db.bak-"));
    assert.equal(names.length, 2, names.join(","));
    assert.ok(names.includes("kanban.db.bak-d"), "the newest old one stays");
    assert.ok(applied.backup && names.includes(applied.backup.split("/").pop() as string), "the new backup stays");
    assert.equal(applied.prunedBackups.length, 3);
    assert.ok(existsSync(other), "codex backups are not kanban backups");
    assert.equal(existsSync(join(dir, "kanban.db.bak-a-wal")), false, "a pruned backup takes its sidecar along");
  });
});

describe("vacuum", () => {
  const nobody = () => [];

  function bulkAndShrink(): { events: number } {
    const task = createTask({ project: "vac", title: "Large database", role: "executor", workspacePath: dir });
    const insert = getDb().prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'cleanup', 'test', ?)");
    getDb().exec("BEGIN");
    for (let i = 0; i < 6000; i++) insert.run(task.id, daysAgo(1), JSON.stringify({ action: "archive_agent", pad: "x".repeat(200) }));
    getDb().exec("COMMIT");
    getDb().prepare("DELETE FROM events WHERE kind = 'cleanup'").run();
    getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { events: (getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n };
  }

  it("refuses while another process holds the database, and changes nothing", () => {
    bulkAndShrink();
    closeDb();
    const sizeBefore = statSync(join(dir, "kanban.db")).size;
    const holder = () => [{ pid: 4242, command: "paseo-daemon" }];

    assert.throws(() => vacuumKanbanDb({ apply: true, env: {}, listHolders: holder }), (err: Error) => {
      assert.match(err.message, /paseo-daemon\(pid 4242\)/);
      assert.match(err.message, /paseo plugin disable paseo-kanban/);
      return true;
    });

    assert.equal(statSync(join(dir, "kanban.db")).size, sizeBefore);
    assert.equal(readdirSync(dir).filter((name) => name.startsWith("kanban.db.bak-")).length, 0, "no backup is made for a refused run");
    const preview = vacuumKanbanDb({ apply: false, env: {}, listHolders: holder });
    assert.equal(preview.dryRun, true);
    assert.match(preview.text, new RegExp("--apply " + localePattern(zhCNPart("vacuum.dry.holders", 29, 32))));
  });

  it("only the leader may vacuum", async () => {
    createTask({ project: "vac", title: "Compaction permissions", role: "executor", workspacePath: dir });
    const task = getDb().prepare("SELECT id FROM tasks LIMIT 1").get() as { id: number };
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'vac-worker' WHERE id = ?").run(task.id);
    closeDb();
    await assert.rejects(() => runKanban(["vacuum", "--apply"], { PASEO_AGENT_ID: "vac-worker" }), new RegExp(localePattern(zhCNPart("vacuum.leaderOnly", 0, 16))));
  });

  it("vacuums with the plugin stopped: backup, smaller file, identical row counts", () => {
    const { events } = bulkAndShrink();
    const rowsBefore = getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    closeDb();
    const sizeBefore = statSync(join(dir, "kanban.db")).size;
    assert.ok(sizeBefore > 500_000, "fixture must have free pages to reclaim");

    const preview = vacuumKanbanDb({ apply: false, env: {}, listHolders: nobody });
    assert.equal(preview.dryRun, true);
    assert.ok(preview.freePercent > 50);
    assert.equal(statSync(join(dir, "kanban.db")).size, sizeBefore, "dry-run changes nothing");

    const result = vacuumKanbanDb({ apply: true, env: {}, listHolders: nobody });

    assert.equal(result.dryRun, false);
    assert.ok(result.sizeAfter! < sizeBefore / 2, `${result.sizeAfter} should be much smaller than ${sizeBefore}`);
    assert.ok(result.backup && existsSync(result.backup));
    assert.match(result.text, new RegExp(localePattern(zhCNPart("vacuum.done", 70, 76))));
    assert.match(result.text, /paseo plugin enable paseo-kanban/);
    assert.equal(result.tables.events, events);
    assert.equal(result.tables.tasks, rowsBefore.n);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, events);
    assert.equal((getDb().prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
  });

});
