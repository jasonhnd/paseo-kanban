/// <reference types="node" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { runDoctor, type DoctorFinding } from "../server/doctor";
import { checkMigration, MIGRATION_FILE, readMigrationRecord, sha256File, type MigrationRecord } from "../server/doctor-migration";
import { finishMigration, formatStamp, migrate, rollbackMigration, type MigrateDeps } from "../server/migrate";
import { KanbanError } from "../server/errors";
import { chooseDataDir } from "../server/paths";
import { countRows, insertCards, migrateFixture, tree, type MigrateFixture } from "./helpers/migrate-fixture";

const root = realpathSync(mkdtempSync(join(tmpdir(), "migrate-")));
// Board code under test must never fall back to a real data directory.
process.env.KANBAN_DATA_DIR = join(root, "unused-board");
after(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const fixture = (options: { targetFiles?: Record<string, string> } = {}): MigrateFixture => migrateFixture(root, options);

function deps(calls: string[], at: string, over: Partial<MigrateDeps> = {}): MigrateDeps {
  return {
    plugin: { disable: () => void calls.push("disable"), enable: () => void calls.push("enable") },
    listHolders: () => [],
    now: () => new Date(at),
    sleep: () => undefined,
    ...over,
  };
}

function findings(dir: string, board: DatabaseSync | "skip" = "skip"): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  checkMigration(item => out.push(item), dir, board);
  return out;
}

function boardFindings(dir: string): DoctorFinding[] {
  const db = new DatabaseSync(join(dir, "kanban.db"), { readOnly: true });
  try {
    return findings(dir, db);
  } finally {
    db.close();
  }
}

function chosen(f: MigrateFixture): string {
  return chooseDataDir({ env: f.env, home: f.home, pluginRoot: f.pluginRoot, exists: existsSync }).dir;
}

/** Finish refused: the old directory, the record and the backups are exactly as before. */
function assertFinishRefused(f: MigrateFixture, stamp: string, pattern: RegExp): void {
  const before = { legacy: tree(f.legacy), backups: readdirSync(join(f.target, "backups")).sort() };
  assert.throws(() => finishMigration({ to: f.target, stamp }, deps([], "2026-10-15T00:00:00Z")), pattern);
  assert.deepEqual({ legacy: tree(f.legacy), backups: readdirSync(join(f.target, "backups")).sort() }, before);
  assert.equal(readMigrationRecord(f.target)?.state, "active");
}

/** Cards, events and a comment written by the plugin after the switch. */
function useMigratedBoard(dir: string): void {
  process.env.KANBAN_DATA_DIR = dir;
  const db = getDb();
  insertCards(db, 6, 1, 2);
  db.prepare("INSERT INTO comments(task_id, author, body, created_at) VALUES (6, 'tester', 'after the switch', '2026-10-09T00:00:00.000Z')").run();
  db.prepare("UPDATE tasks SET status = 'archived', updated_at = '2026-10-09T00:00:00.000Z' WHERE id = 2").run();
  closeDb();
  process.env.KANBAN_DATA_DIR = join(root, "unused-board");
}

describe("migrate --dry-run", () => {
  it("lists files, sizes, target paths and conflicts, and writes nothing", () => {
    const f = fixture({ targetFiles: { "supervisor.token": "other" } });
    const before = { legacy: tree(f.legacy), target: tree(f.target) };
    const calls: string[] = [];
    const result = migrate({ from: f.legacy, to: f.target, dryRun: true }, deps(calls, "2026-10-08T07:00:00Z"));
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.plan.conflicts.map(item => item.path), ["supervisor.token"]);
    assert.match(result.text, /^Dry run: nothing was written\./);
    assert.match(result.text, /kanban\.db {2}[\d.]+ (B|KB|MB) {2}-> .*plugin-data\/paseo-kanban\/kanban\.db {2}\(snapshot via VACUUM INTO\)/);
    assert.match(result.text, /notes-unknown\.txt .*\(unknown file\)/);
    assert.match(result.text, /kanban\.db-wal {2}\(folded into the kanban\.db snapshot\)/);
    assert.match(result.text, /Conflicts \(a real run refuses until these are moved away\):\n {2}supervisor\.token/);
    assert.ok(!result.plan.conflicts.some(item => item.path.startsWith("exports/")));
    assert.deepEqual(calls, []);
    assert.deepEqual({ legacy: tree(f.legacy), target: tree(f.target) }, before);
  });

  it("does not create a missing target", () => {
    const f = fixture();
    rmSync(join(f.home, "paseo"), { recursive: true });
    const result = migrate({ from: f.legacy, to: f.target, dryRun: true }, deps([], "2026-10-08T07:00:00Z"));
    assert.deepEqual(result.plan.conflicts, []);
    assert.equal(existsSync(join(f.home, "paseo")), false);
  });

  it("refuses directories inside each other and a source without a board", () => {
    const f = fixture();
    assert.throws(() => migrate({ from: f.legacy, to: join(f.legacy, "next"), dryRun: true }, deps([], "2026-10-08T07:00:00Z")), /neither inside the other/);
    assert.throws(() => migrate({ from: f.target, to: join(root, "elsewhere"), dryRun: true }, deps([], "2026-10-08T07:00:00Z")), /has no kanban\.db/);
  });
});

describe("migrate → rollback → migrate → finish", () => {
  const f = fixture();
  const original = tree(f.legacy);
  const calls: string[] = [];
  let first: MigrationRecord;
  let second: MigrationRecord;

  it("migrates with the plugin disabled and leaves the old directory as it was", () => {
    const result = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps(calls, "2026-10-08T07:00:00.250Z"));
    first = result.record as MigrationRecord;
    assert.deepEqual(calls, ["disable", "enable"]);
    assert.equal(first.timestamp, "20261008T070000Z");
    assert.equal(first.state, "active");
    assert.deepEqual(tree(f.legacy), original);
    assert.equal(chosen(f), f.target);
    // Rows that were only in the WAL made it, and the record matches SELECT COUNT(*).
    for (const table of ["tasks", "events", "comments"]) assert.equal(countRows(join(f.target, "kanban.db"), table), first.rows[table]?.count);
    assert.deepEqual([first.rows.tasks?.count, first.rows.tasks?.maxId, first.rows.events?.count], [5, 5, 18]);
    assert.equal(readMigrationRecord(f.target)?.timestamp, first.timestamp);
    assert.equal(countRows(join(f.target, first.backup, "kanban.db"), "tasks"), 5);
  });

  it("copies every other file byte for byte, recreates symlinks and lists unknown files", () => {
    for (const entry of first.files.filter(item => item.kind === "file")) {
      assert.equal(sha256File(join(f.target, entry.path)), sha256File(join(f.legacy, entry.path)), entry.path);
      assert.equal(entry.sha256, sha256File(join(f.legacy, entry.path)));
    }
    assert.equal(readlinkSync(join(f.target, "config-link")), "kanban.config.json");
    assert.deepEqual(first.unknownFiles, ["config-link", "notes-unknown.txt"]);
    assert.deepEqual(first.skipped.map(item => item.path), ["kanban.db-shm", "kanban.db-wal"]);
    assert.deepEqual(first.database.present, ["kanban.db", "kanban.db-wal", "kanban.db-shm"]);
    assert.ok(first.files.some(entry => entry.path === "readonly-leftovers/DEMO_0001/note.txt"));
    assert.equal(readFileSync(join(f.target, "exports", "kanban.json"), "utf8"), "{\"schema\":\"demo\"}");
    assert.deepEqual(first.targetBefore, ["exports"]);
  });

  it("doctor reports the observation as info while the board only grows", () => {
    assert.deepEqual(boardFindings(f.target).map(item => [item.id, item.severity]), [["migration:observing", "info"]]);
    useMigratedBoard(f.target);
    assert.deepEqual(boardFindings(f.target).map(item => [item.id, item.severity]), [["migration:observing", "info"]]);
  });

  it("rolls back: exports what was added, moves the new files away, the plugin uses the old directory", () => {
    const result = rollbackMigration({ to: f.target, stamp: first.timestamp }, deps(calls, "2026-10-09T08:00:00Z"));
    assert.deepEqual(calls, ["disable", "enable", "disable", "enable"]);
    assert.equal(chosen(f), f.target);
    assert.deepEqual(tree(f.legacy), original);
    const exported = JSON.parse(readFileSync(result.exportFile, "utf8")) as { newRows: Record<string, Array<{ id: number }>>; changedTasks: Array<{ id: number; status: string }> };
    assert.deepEqual(exported.newRows.tasks?.map(row => row.id), [6]);
    assert.equal(exported.newRows.events?.length, 2);
    assert.equal(exported.newRows.comments?.length, 1);
    assert.deepEqual(exported.changedTasks.map(row => [row.id, row.status]), [[2, "archived"]]);
    assert.equal(existsSync(join(f.target, "kanban.db")), false);
    assert.equal(existsSync(join(f.target, MIGRATION_FILE)), false);
    assert.deepEqual(readdirSync(f.target).sort(), ["backups", "exports"]);
    assert.equal(countRows(join(result.movedTo, "kanban.db"), "tasks"), 6);
    assert.equal(readMigrationRecord(result.movedTo)?.state, "rolled-back");
    assert.deepEqual(findings(f.target), []);
  });

  it("migrates again over the leftover exports/ and backups/", () => {
    const result = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps(calls, "2026-10-10T09:00:00Z"));
    second = result.record as MigrationRecord;
    assert.equal(second.timestamp, "20261010T090000Z");
    assert.deepEqual(second.targetBefore, ["backups", "exports"]);
    assert.equal(countRows(join(f.target, "kanban.db"), "tasks"), 5);
    assert.equal(chosen(f), f.target);
    assert.deepEqual(tree(f.legacy), original);
  });

  it("refuses to finish or roll back another timestamp", () => {
    assert.throws(() => finishMigration({ to: f.target, stamp: first.timestamp }, deps([], "2026-10-11T00:00:00Z")), /is 20261010T090000Z, not 20261008T070000Z/);
    assert.throws(() => rollbackMigration({ to: f.target, stamp: "../x" }, deps([], "2026-10-11T00:00:00Z")), /Not a migration timestamp/);
  });

  it("finishes: archives the old directory and deletes only the migrated files", () => {
    writeFileSync(join(f.legacy, "late.txt"), "written after the migration");
    const callsBefore = calls.length;
    const result = finishMigration({ to: f.target, stamp: second.timestamp }, deps(calls, "2026-10-17T09:00:00Z"));
    assert.equal(calls.length, callsBefore);
    assert.match(result.archive, /backups\/legacy-20261010T090000Z\.tar(\.zst)?$/);
    assert.ok(existsSync(result.archive));
    const listed = result.archive.endsWith(".zst")
      ? spawnSync("sh", ["-c", "zstd -dc \"$1\" | tar -tf -", "sh", result.archive], { encoding: "utf8" }).stdout
      : spawnSync("tar", ["-tf", result.archive], { encoding: "utf8" }).stdout;
    for (const name of ["data/kanban.db", "data/kanban.db-wal", "data/supervisor.token", "data/readonly-leftovers/DEMO_0001/note.txt", "data/late.txt"]) {
      assert.ok(listed.split("\n").includes(name), `${name} in the archive`);
    }
    assert.deepEqual(readdirSync(f.legacy), ["late.txt"]);
    assert.deepEqual(result.left, ["late.txt"]);
    assert.equal(readMigrationRecord(f.target)?.state, "finished");
    assert.deepEqual(findings(f.target), []);
    assert.equal(chosen(f), f.target);
    assert.throws(() => finishMigration({ to: f.target, stamp: second.timestamp }, deps([], "2026-10-18T00:00:00Z")), /already finished/);
    assert.throws(() => rollbackMigration({ to: f.target, stamp: second.timestamp }, deps([], "2026-10-18T00:00:00Z")), /already finished/);
  });
});

describe("the observation check", () => {
  it("is red when the old database changes, and finish and rollback refuse", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    utimesSync(join(f.legacy, "kanban.db"), new Date("2026-10-12T00:00:00Z"), new Date("2026-10-12T00:00:00Z"));
    const reds = boardFindings(f.target);
    assert.deepEqual(reds.map(item => [item.id, item.severity]), [["migration:old-board", "red"]]);
    assert.match(reds[0]!.evidence, /kanban\.db changed/);
    const calls: string[] = [];
    assert.throws(() => finishMigration({ to: f.target, stamp: record.timestamp }, deps(calls, "2026-10-15T00:00:00Z")), /observation check did not pass/);
    assert.throws(() => rollbackMigration({ to: f.target, stamp: record.timestamp }, deps(calls, "2026-10-15T00:00:00Z")), /no longer as the migration left it/);
    assert.deepEqual(calls, []);
    assert.ok(existsSync(join(f.legacy, "supervisor.token")));
    assert.equal(readMigrationRecord(f.target)?.state, "active");
  });

  it("is red when the new board lost cards, and finish refuses without touching the old directory", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    const db = new DatabaseSync(join(f.target, "kanban.db"));
    db.prepare("DELETE FROM tasks WHERE id = 2").run();
    db.close();
    assert.deepEqual(boardFindings(f.target).map(item => [item.id, item.severity]), [["migration:new-board", "red"]]);
    assertFinishRefused(f, record.timestamp, /observation check did not pass[\s\S]*tasks went from 5 to 4 rows/);
  });

  it("is red when events were deleted even though MAX(id) did not go down, and finish refuses", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    const db = new DatabaseSync(join(f.target, "kanban.db"));
    db.prepare("DELETE FROM events WHERE id IN (1, 2)").run();
    db.close();
    const reds = boardFindings(f.target);
    assert.deepEqual(reds.map(item => [item.id, item.severity]), [["migration:new-board", "red"]]);
    assert.match(reds[0]!.evidence, /events went from 18 to 16 rows/);
    assertFinishRefused(f, record.timestamp, /events went from 18 to 16 rows/);
  });

  it("is red when the new board cannot be read, and finish refuses", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    writeFileSync(join(f.target, "kanban.db"), "not a database");
    assertFinishRefused(f, record.timestamp, /cannot read .*kanban\.db/);
  });

  it("is wired into doctor for the data directory in use", async () => {
    const f = fixture();
    migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z"));
    process.env.KANBAN_DATA_DIR = f.target;
    try {
      closeDb();
      const report = await runDoctor({ now: new Date("2026-10-09T07:00:00Z"), sources: {}, persist: false });
      const item = report.findings.find(finding => finding.id === "migration:observing");
      assert.ok(item, JSON.stringify(report.findings.map(finding => finding.id)));
      assert.match(item.symptom, /Migration 20261008T070000Z under observation \(1\.0 days\)/);
    } finally {
      closeDb();
      process.env.KANBAN_DATA_DIR = join(root, "unused-board");
    }
  });

  it("reports nothing without a record", () => {
    assert.deepEqual(findings(join(root, "no-such-board")), []);
  });
});

describe("migrate failures", () => {
  it("stops before writing anything when the plugin cannot be disabled", () => {
    const f = fixture();
    const before = tree(f.target);
    const calls: string[] = [];
    const failing = deps(calls, "2026-10-08T07:00:00Z", {
      plugin: { disable: () => { calls.push("disable"); throw new Error("The paseo command was not found on PATH."); }, enable: () => void calls.push("enable") },
    });
    assert.throws(() => migrate({ from: f.legacy, to: f.target, dryRun: false }, failing), /not found on PATH\. Stopped before changing any data\./);
    // The daemon may have disabled it before the command failed, so it is enabled to be sure.
    assert.deepEqual(calls, ["disable", "enable"]);
    assert.deepEqual(tree(f.target), before);
  });

  it("does not try to enable when there is no paseo command at all", () => {
    const f = fixture();
    const calls: string[] = [];
    const noPaseo = deps(calls, "2026-10-08T07:00:00Z", {
      plugin: { disable: () => { calls.push("disable"); throw new KanbanError("paseo_missing", "The paseo command was not found on PATH."); }, enable: () => void calls.push("enable") },
    });
    assert.throws(() => migrate({ from: f.legacy, to: f.target, dryRun: false }, noPaseo), /Stopped before changing any data\.$/);
    assert.deepEqual(calls, ["disable"]);
  });

  it("refuses conflicts before touching the plugin", () => {
    const f = fixture({ targetFiles: { "kanban.db-wal": "stale" } });
    const calls: string[] = [];
    assert.throws(() => migrate({ from: f.legacy, to: f.target, dryRun: false }, deps(calls, "2026-10-08T07:00:00Z")), /kanban\.db-wal {2}\(leftover database file/);
    assert.deepEqual(calls, []);
  });

  it("enables the plugin again when the old database stays open", () => {
    const f = fixture();
    const before = tree(f.target);
    const calls: string[] = [];
    const busy = deps(calls, "2026-10-08T07:00:00Z", { listHolders: () => [{ pid: 4242, command: "writer" }] });
    assert.throws(() => migrate({ from: f.legacy, to: f.target, dryRun: false }, busy), /still open by writer \(pid 4242\).*The old directory was not changed\./s);
    assert.deepEqual(calls, ["disable", "enable"]);
    assert.deepEqual(tree(f.target), before);
  });

  it("removes what it installed when a late step fails, and keeps the old directory as it was", () => {
    const f = fixture();
    const original = tree(f.legacy);
    // The database's temporary name is taken by a directory, so the very last copy fails.
    mkdirSync(join(f.target, `kanban.db.migrating-${process.pid}`));
    const calls: string[] = [];
    assert.throws(() => migrate({ from: f.legacy, to: f.target, dryRun: false }, deps(calls, "2026-10-08T07:00:00Z")), /partial backup stays in .*migration-20261008T070000Z/);
    assert.deepEqual(calls, ["disable", "enable"]);
    assert.deepEqual(readdirSync(f.target).sort(), ["backups", "exports", `kanban.db.migrating-${process.pid}`]);
    assert.equal(chosen(f), f.target);
    assert.deepEqual(tree(f.legacy), original);
  });
});

describe("timestamps", () => {
  it("are UTC to the second", () => {
    assert.equal(formatStamp(new Date("2026-10-08T07:05:09.999Z")), "20261008T070509Z");
  });
});

describe("migrate after review: files, links, records", () => {
  it("refuses a target whose exports/ or backups/ is a link into the old directory", () => {
    const f = fixture();
    mkdirSync(join(f.legacy, "exports"));
    writeFileSync(join(f.legacy, "exports", "kanban.json"), "{\"schema\":\"old\"}");
    rmSync(join(f.target, "exports"), { recursive: true });
    symlinkSync(join(f.legacy, "exports"), join(f.target, "exports"));
    symlinkSync(f.legacy, join(f.target, "backups"));
    const original = tree(f.legacy);
    const plan = migrate({ from: f.legacy, to: f.target, dryRun: true }, deps([], "2026-10-08T07:00:00Z")).plan;
    assert.deepEqual(plan.conflicts.map(item => item.path), ["exports/kanban.json", "backups/"]);
    assert.match(plan.conflicts[0]!.reason, /link out of the target/);
    const calls: string[] = [];
    assert.throws(() => migrate({ from: f.legacy, to: f.target, dryRun: false }, deps(calls, "2026-10-08T07:00:00Z")), /exports\/kanban\.json {2}\(a directory on the way is a link out of the target\)/);
    assert.deepEqual(calls, []);
    assert.deepEqual(tree(f.legacy), original);
  });

  it("lists the files again once the plugin has stopped, and skips interrupted temp files", () => {
    const f = fixture();
    writeFileSync(join(f.legacy, "doctor-report.json.4242.1.ab.tmp"), "half a report");
    const calls: string[] = [];
    // The plugin writes one more file while it shuts down.
    const lastWrite = deps(calls, "2026-10-08T07:00:00Z", {
      plugin: { disable: () => { calls.push("disable"); writeFileSync(join(f.legacy, "board-wake-marks.json"), "{}"); }, enable: () => void calls.push("enable") },
    });
    const result = migrate({ from: f.legacy, to: f.target, dryRun: false }, lastWrite);
    const record = result.record as MigrationRecord;
    assert.ok(record.files.some(entry => entry.path === "board-wake-marks.json"));
    assert.equal(readFileSync(join(f.target, "board-wake-marks.json"), "utf8"), "{}");
    assert.deepEqual(record.skipped.find(item => item.path.endsWith(".tmp")), { path: "doctor-report.json.4242.1.ab.tmp", reason: "temporary file of an interrupted write" });
    assert.equal(existsSync(join(f.target, "doctor-report.json.4242.1.ab.tmp")), false);
  });

  it("points copied symlinks at the migrated file inside, and at the same file outside", () => {
    const f = fixture();
    writeFileSync(join(f.pluginRoot, "outside.txt"), "outside");
    symlinkSync(join(f.legacy, "kanban.config.json"), join(f.legacy, "abs-inside"));
    symlinkSync("../outside.txt", join(f.legacy, "rel-outside"));
    mkdirSync(join(f.legacy, "nested"));
    symlinkSync("../kanban.config.json", join(f.legacy, "nested", "rel-up"));
    migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z"));
    assert.equal(readlinkSync(join(f.target, "abs-inside")), join(f.target, "kanban.config.json"));
    assert.equal(readlinkSync(join(f.target, "rel-outside")), join(f.pluginRoot, "outside.txt"));
    assert.equal(readlinkSync(join(f.target, "nested", "rel-up")), "../kanban.config.json");
    assert.equal(readFileSync(join(f.target, "nested", "rel-up"), "utf8"), readFileSync(join(f.legacy, "kanban.config.json"), "utf8"));
  });

  it("refuses a record that names paths outside the migrated directories", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    const original = tree(f.legacy);
    const edited = { ...record, files: [...record.files, { ...record.files[0]!, path: "../escape.txt" }] };
    writeFileSync(join(f.target, MIGRATION_FILE), JSON.stringify(edited));
    assert.throws(() => readMigrationRecord(f.target), /outside the migrated directories: \.\.\/escape\.txt/);
    assert.throws(() => finishMigration({ to: f.target, stamp: record.timestamp }, deps([], "2026-10-15T00:00:00Z")), /outside the migrated directories/);
    assert.deepEqual(findings(f.target).map(item => [item.id, item.severity]), [["migration:record", "yellow"]]);
    assert.deepEqual(tree(f.legacy), original);
  });
});

describe("rollback and finish after review", () => {
  it("puts everything back when a rollback fails partway, and the rollback can run again", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    useMigratedBoard(f.target);
    // A directory the plugin made after the switch that cannot be moved.
    const locked = join(f.target, "zz-locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "file.txt"), "x");
    chmodSync(locked, 0o500);
    const calls: string[] = [];
    try {
      assert.throws(() => rollbackMigration({ to: f.target, stamp: record.timestamp }, deps(calls, "2026-10-09T00:00:00Z")), /Everything it moved was put back; the migrated board is still the one in use\./);
    } finally {
      chmodSync(locked, 0o700);
    }
    assert.deepEqual(calls, ["disable", "enable"]);
    assert.equal(chosen(f), f.target);
    assert.equal(countRows(join(f.target, "kanban.db"), "tasks"), 6);
    assert.equal(readMigrationRecord(f.target)?.state, "active");
    assert.equal(existsSync(join(f.target, "backups", `rollback-${record.timestamp}.json`)), false);
    assert.equal(existsSync(join(f.target, "backups", `rollback-${record.timestamp}`)), false);
    const again = rollbackMigration({ to: f.target, stamp: record.timestamp }, deps(calls, "2026-10-09T00:00:01Z"));
    assert.deepEqual(again.newRows.tasks, 1);
    assert.equal(chosen(f), f.target);
  });

  it("rolls back a migration that stopped before its database was renamed in", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    rmSync(join(f.target, "kanban.db"));
    const result = rollbackMigration({ to: f.target, stamp: record.timestamp }, deps([], "2026-10-08T07:05:00Z"));
    assert.deepEqual(result.newRows, {});
    assert.deepEqual(readdirSync(f.target).sort(), ["backups", "exports"]);
    assert.equal(chosen(f), f.target);
  });

  it("refuses a rollback onto a changed old directory, and onto one without a board", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    utimesSync(join(f.legacy, "kanban.db"), new Date("2026-10-12T00:00:00Z"), new Date("2026-10-12T00:00:00Z"));
    const calls: string[] = [];
    assert.throws(() => rollbackMigration({ to: f.target, stamp: record.timestamp }, deps(calls, "2026-10-13T00:00:00Z")), /no longer as the migration left it[\s\S]*kanban\.db changed/);
    assert.deepEqual(calls, []);
    assert.equal(chosen(f), f.target);
    assert.equal(readMigrationRecord(f.target)?.state, "active");

    const g = fixture();
    const second = migrate({ from: g.legacy, to: g.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    rmSync(join(g.legacy, "kanban.db"));
    assert.throws(() => rollbackMigration({ to: g.target, stamp: second.timestamp }, deps(calls, "2026-10-13T00:00:00Z")), /no kanban\.db any more .* empty board/);
    assert.deepEqual(calls, []);
    assert.equal(chosen(g), g.target);
  });

  it("refuses to finish when a migrated old file changed, and leaves the old directory as it was", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    writeFileSync(join(f.legacy, "notes-unknown.txt"), "edited after the migration");
    assert.deepEqual(boardFindings(f.target).map(item => [item.id, item.severity]), [["migration:old-files", "yellow"]]);
    assertFinishRefused(f, record.timestamp, /notes-unknown\.txt changed/);
  });

  it("does not finish while a process still has the old board open", () => {
    const f = fixture();
    const record = migrate({ from: f.legacy, to: f.target, dryRun: false }, deps([], "2026-10-08T07:00:00Z")).record as MigrationRecord;
    const original = tree(f.legacy);
    const busy = deps([], "2026-10-15T00:00:00Z", { listHolders: files => (files.some(file => file.startsWith(f.legacy)) ? [{ pid: 4343, command: "stale-board" }] : []) });
    assert.throws(() => finishMigration({ to: f.target, stamp: record.timestamp }, busy), /still open by stale-board \(pid 4343\)/);
    assert.deepEqual(tree(f.legacy), original);
    assert.deepEqual(readdirSync(join(f.target, "backups")).filter(name => name.startsWith("legacy-")), []);
  });
});
