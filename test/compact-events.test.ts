/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it, mock } from "node:test";
import { readCleanupEvents } from "../server/archive-book";
import { kanbanHelp, runKanban } from "../server/cli";
import { compactVerifyEvents } from "../server/compact-events";
import { setSupervisorAgentId } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { appendEvent, createTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "compact-"));
process.env.KANBAN_DATA_DIR = dir;

function verifyRows(taskId: number, agentId: string): Array<{ id: number }> {
  return getDb()
    .prepare(
      `SELECT id FROM events
       WHERE task_id = ? AND kind = 'cleanup' AND json_extract(data_json, '$.action') = 'verify_agent'
         AND json_extract(data_json, '$.agentId') = ?
       ORDER BY id`,
    )
    .all(taskId, agentId) as unknown as Array<{ id: number }>;
}

// Old enough for the default 30-day retention, whenever the suite runs.
const OLD_BASE = Date.now() - 60 * 86_400_000;

function stamp(index: number): string {
  return new Date(OLD_BASE + index * 1000).toISOString();
}

function finished<T extends { id: number }>(task: T): T {
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  return task;
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("compact verify_agent events", () => {
  it("dry-run counts middle rows, and apply keeps the first and last per agent", async () => {
    assert.match(kanbanHelp(), /compact-events/);
    assert.match(kanbanHelp(), /write_audits.*30/);
    const task = finished(createTask({ project: "compact", title: "Verify again", role: "executor", workspacePath: dir }));
    const other = finished(createTask({ project: "compact", title: "Sample text", role: "executor", workspacePath: dir }));
    const keep = appendIds(task.id, "agent-a", 5);
    const pair = appendIds(task.id, "agent-b", 2);
    const single = appendIds(task.id, "agent-c", 1);
    const otherKeep = appendIds(other.id, "agent-a", 4);
    appendEvent(task.id, "cleanup", null, null, "kanban", { action: "archive_agent", agentId: "agent-a", ok: true }, stamp(0));
    appendEvent(task.id, "comment", null, null, "kanban", { action: "verify_agent", agentId: "agent-a", ok: true }, stamp(50));

    const loaded = readCleanupEvents(task.id).filter((event) => event.action === "verify_agent" && event.agentId === "agent-a");
    assert.equal(loaded.length, 1, ("Cleanup events include each agent " + zhCNPart("cardDrawer.handoff.title", 0, 2) + zhCNPart("compat.workspaces.notObject", 1, 3) + zhCNPart("compat.run.noChecks", 4, 6)));

    const preview = (await runKanban(["compact-events", "--dry-run"], {})) as { dryRun: boolean; remove: number; before: number; text: string };
    assert.equal(preview.dryRun, true);
    assert.equal(preview.before, 5 + 2 + 1 + 4);
    assert.equal(preview.remove, 3 + 0 + 0 + 2);
    assert.match(preview.text, /dry-run/);
    assert.match(preview.text, new RegExp((zhCN("compactEvents.verb.planned") + " ") + "5 " + localePattern(zhCNPart("labels.role.executor", 1, 2))));
    assert.equal(verifyRows(task.id, "agent-a").length, 5);

    const implicit = (await runKanban(["compact-events"], {})) as { dryRun: boolean; remove: number };
    assert.equal(implicit.dryRun, true);
    assert.equal(implicit.remove, 5);
    assert.equal(verifyRows(task.id, "agent-a").length, 5);

    const worker = "compact-worker";
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(worker, task.id);
    await assert.rejects(() => runKanban(["compact-events", "--apply"], { PASEO_AGENT_ID: worker }), new RegExp(localePattern(zhCNPart("compactEvents.error.forbidden", 0, 15))));
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = NULL WHERE id = ?").run(task.id);

    const applied = (await runKanban(["compact-events", "--apply"], {})) as { dryRun: boolean; remove: number; after: number; text: string };
    assert.equal(applied.dryRun, false);
    assert.equal(applied.remove, 5);
    assert.equal(applied.after, 7);
    assert.match(applied.text, new RegExp((zhCN("compactEvents.verb.deleted") + " ") + "5 " + localePattern(zhCNPart("labels.role.executor", 1, 2))));

    const leftA = verifyRows(task.id, "agent-a").map((row) => row.id);
    assert.deepEqual(leftA, [keep[0], keep[4]]);
    assert.deepEqual(verifyRows(task.id, "agent-b").map((row) => row.id), pair);
    assert.deepEqual(verifyRows(task.id, "agent-c").map((row) => row.id), single);
    assert.deepEqual(
      verifyRows(other.id, "agent-a").map((row) => row.id),
      [otherKeep[0], otherKeep[3]],
    );

    const comment = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'comment'").get(task.id) as { n: number };
    assert.equal(comment.n, 1);
    const archive = getDb()
      .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'cleanup' AND json_extract(data_json, '$.action') = 'archive_agent'")
      .get(task.id) as { n: number };
    assert.equal(archive.n, 1);

    const second = (await runKanban(["compact-events", "--apply"], {})) as { remove: number };
    assert.equal(second.remove, 0);
    assert.equal(verifyRows(task.id, "agent-a").length, 2);
  });

  it("dry-run leaves an old schema, its events, and its tokens untouched", async () => {
    const prev = process.env.KANBAN_DATA_DIR;
    const isolated = mkdtempSync(join(tmp, "compact-old-"));
    process.env.KANBAN_DATA_DIR = isolated;
    closeDb();
    try {
      const task = finished(createTask({ project: "compact", title: "Legacy database", role: "executor", workspacePath: isolated }));
      appendEvent(task.id, "cleanup", null, null, "kanban", { action: "verify_agent", agentId: "old-agent", ok: true }, stamp(1));
      appendEvent(task.id, "cleanup", null, null, "kanban", { action: "verify_agent", agentId: "old-agent", ok: true }, stamp(2));
      appendEvent(task.id, "cleanup", null, null, "kanban", { action: "verify_agent", agentId: "old-agent", ok: true }, stamp(3));
      getDb()
        .prepare("INSERT INTO tokens (token, task_id, role, agent_id, created_at) VALUES (?, NULL, 'supervisor', NULL, ?)")
        .run("fixture-token", stamp(0));
      for (const name of NEW_INDEXES) getDb().exec(`DROP INDEX IF EXISTS ${name}`);
      closeDb();
      // TEST_0188: only a registered <leader> (or the terminal) may compact; register the fixture leader in config.
      setSupervisorAgentId("fixture-leader");

      const before = snapshot(isolated);
      assert.equal(before.newIndexes, 0);
      const result = (await runKanban(["compact-events", "--dry-run"], { PASEO_AGENT_ID: "fixture-leader" })) as {
        dryRun: boolean;
        remove: number;
      };
      const after = snapshot(isolated);
      assert.equal(result.dryRun, true);
      assert.equal(result.remove, 1);
      assert.equal(after.newIndexes, 0);
      assert.deepEqual(after, before);
      assert.equal(existsSync(join(isolated, "supervisor.token")), false);

      const applied = (await runKanban(["compact-events", "--apply"], { PASEO_AGENT_ID: "fixture-leader" })) as {
        dryRun: boolean;
        remove: number;
        backup: string | null;
      };
      assert.equal(applied.dryRun, false);
      assert.equal(applied.remove, 1);
      assert.ok(applied.backup);
      const backup = snapshotFile(applied.backup as string);
      assert.equal(backup.newIndexes, 0);
      assert.equal(backup.events, before.events);
      assert.deepEqual(backup.tokens, before.tokens);
      const live = snapshot(isolated);
      assert.equal(live.newIndexes, NEW_INDEXES.length);
      assert.equal(live.events, before.events - 1);
      assert.deepEqual(live.tokens, before.tokens);
    } finally {
      closeDb();
      process.env.KANBAN_DATA_DIR = prev;
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("only deletes backed-up middle IDs when another connection commits after backup", () => {
    const prev = process.env.KANBAN_DATA_DIR;
    const isolated = mkdtempSync(join(tmp, "compact-after-backup-"));
    process.env.KANBAN_DATA_DIR = isolated;
    closeDb();
    let writer: DatabaseSync | null = null;
    try {
      const task = finished(createTask({ project: "compact", title: "Concurrency verify", role: "executor", workspacePath: isolated }));
      const originalIds = appendIds(task.id, "concurrent-agent", 3);
      const live = getDb();
      writer = new DatabaseSync(join(isolated, "kanban.db"));
      const lateIds: number[] = [];
      const exec = live.exec.bind(live);
      const hook = mock.method(live, "exec", (sql: string) => {
        if (sql === "BEGIN" && lateIds.length === 0) {
          for (let i = 0; i < 2; i++) {
            const result = writer!.prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'cleanup', 'test', ?)")
              .run(task.id, stamp(10 + i), JSON.stringify({ action: "verify_agent", agentId: "concurrent-agent", ok: true }));
            lateIds.push(Number(result.lastInsertRowid));
          }
          assert.equal(verifyRows(task.id, "concurrent-agent").length, 5, "actualBeforeDelete");
        }
        return exec(sql);
      });
      let result;
      try { result = compactVerifyEvents({ apply: true, env: {} }); }
      finally { hook.mock.restore(); }
      assert.equal(result.before, 3, "reportedBefore comes from the backup");
      assert.equal(result.remove, 1, "DELETE changes, not a stale estimate");
      assert.equal(result.after, 4, "report the live remaining count including later commits");
      assert.deepEqual(verifyRows(task.id, "concurrent-agent").map((row) => row.id), [originalIds[0], originalIds[2], ...lateIds]);
      const backup = new DatabaseSync(result.backup!, { readOnly: true });
      try {
        assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'cleanup'").get()?.n, 3);
        for (const id of lateIds) assert.equal(backup.prepare("SELECT id FROM events WHERE id = ?").get(id), undefined);
      } finally { backup.close(); }
      assert.equal(compactVerifyEvents({ apply: true, env: {} }).remove, 2, "later commits are considered next run");
    } finally {
      writer?.close();
      closeDb();
      process.env.KANBAN_DATA_DIR = prev;
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("backs up commits that landed while a reader held an older snapshot", () => {
    const prev = process.env.KANBAN_DATA_DIR;
    const isolated = mkdtempSync(join(tmp, "compact-wal-"));
    process.env.KANBAN_DATA_DIR = isolated;
    closeDb();
    let reader: DatabaseSync | null = null;
    try {
      const task = finished(createTask({ project: "compact", title: "Before snapshot", role: "executor", workspacePath: isolated }));
      appendIds(task.id, "pinned-agent", 3);
      getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
      reader = new DatabaseSync(join(isolated, "kanban.db"), { readOnly: true });
      reader.exec("BEGIN");
      const pinned = reader.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };

      const fourth = appendIds(task.id, "pinned-agent", 1)[0];
      const extra = finished(createTask({ project: "compact", title: "New card after snapshot", role: "executor", workspacePath: isolated }));
      const liveBefore = (getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      assert.ok(pinned.n < liveBefore);
      assert.ok(fourth);

      const applied = compactVerifyEvents({ apply: true, env: {} });
      assert.equal(applied.dryRun, false);
      assert.ok(applied.backup);
      const backup = new DatabaseSync(applied.backup as string, { readOnly: true });
      try {
        const integrity = backup.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
        assert.deepEqual(
          integrity.map((row) => row.integrity_check),
          ["ok"],
        );
        assert.ok(backup.prepare("SELECT id FROM tasks WHERE id = ?").get(extra.id), (zhCNPart("compactEvents.dryRun.noBackups", 6, 8) + "Demo text"));
        assert.ok(backup.prepare("SELECT id FROM events WHERE id = ?").get(fourth), (zhCNPart("compactEvents.dryRun.noBackups", 6, 8) + "Demo text verify"));
        const backupEvents = (backup.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
        assert.equal(backupEvents, liveBefore);
      } finally {
        backup.close();
      }
      const left = verifyRows(task.id, "pinned-agent").map((row) => row.id);
      assert.equal(left.length, 2);
      assert.equal(left[left.length - 1], fourth);
      assert.ok(getDb().prepare("SELECT id FROM tasks WHERE id = ?").get(extra.id));
    } finally {
      reader?.close();
      closeDb();
      process.env.KANBAN_DATA_DIR = prev;
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

const NEW_INDEXES = ["events_task_kind", "events_kind", "events_task_to_status", "events_cleanup_verify", "events_cleanup_other"];

function snapshot(dataDir: string): { schema: string[]; events: number; tokens: string[]; newIndexes: number } {
  return snapshotFile(join(dataDir, "kanban.db"));
}

function snapshotFile(file: string): { schema: string[]; events: number; tokens: string[]; newIndexes: number } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = (
      db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as Array<{
        type: string;
        name: string;
        sql: string;
      }>
    ).map((row) => `${row.type}:${row.name}:${row.sql}`);
    const events = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const tokens = (
      db.prepare("SELECT token, task_id, role, agent_id, created_at FROM tokens ORDER BY token").all() as Array<{
        token: string;
        task_id: number | null;
        role: string;
        agent_id: string | null;
        created_at: string;
      }>
    ).map((row) => JSON.stringify(row));
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    return { schema, events, tokens, newIndexes: NEW_INDEXES.filter((name) => present.has(name)).length };
  } finally {
    db.close();
  }
}

function appendIds(taskId: number, agentId: string, count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    appendEvent(taskId, "cleanup", null, null, "kanban", { action: "verify_agent", agentId, ok: true }, stamp(taskId * 100 + ids.length + 1));
    const row = getDb().prepare("SELECT MAX(id) AS id FROM events WHERE task_id = ?").get(taskId) as { id: number };
    ids.push(row.id);
  }
  return ids;
}
