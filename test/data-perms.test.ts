/// <reference types="node" />
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { backupKanbanDb, closeDb, getDb } from "../server/db";
import { runDoctor } from "../server/doctor";
import { appendPerfSummary } from "../server/perf";
import { tightenDataDir } from "../server/data-perms";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "data-perms-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("data directory permissions", () => {
  it("tightens an existing loose data directory and its files, idempotently", () => {
    const loose = mkdtempSync(join(tmp, "data-perms-loose-"));
    try {
      writeFileSync(join(loose, "kanban.db"), "x");
      writeFileSync(join(loose, "kanban.db-wal"), "x");
      writeFileSync(join(loose, "doctor-report.json"), "{}");
      chmodSync(loose, 0o755);
      for (const f of ["kanban.db", "kanban.db-wal", "doctor-report.json"]) chmodSync(join(loose, f), 0o644);
      tightenDataDir(loose);
      tightenDataDir(loose);
      assert.equal(mode(loose), 0o700);
      for (const f of ["kanban.db", "kanban.db-wal", "doctor-report.json"]) assert.equal(mode(join(loose, f)), 0o600, f);
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });

  it("opening the database, backups, doctor reports and perf files leave only owner access", async () => {
    chmodSync(dir, 0o755);
    getDb().prepare("SELECT 1").get();
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, "kanban.db")), 0o600);
    const backup = backupKanbanDb();
    assert.equal(mode(backup), 0o600);
    await runDoctor({ sources: {}, wake: false, persist: true });
    assert.equal(mode(join(dir, "doctor-report.json")), 0o600);
    appendPerfSummary({ windowMs: 1 } as never);
    assert.equal(mode(join(dir, "perf-summary.json")), 0o600);
  });
});
