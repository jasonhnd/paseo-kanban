/// <reference types="node" />
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { closeDb } from "../server/db";
import { clearDoctorSafetyCache, runDoctor } from "../server/doctor";
import { isProjectRemoved, removedProjects, resetPaseoProjects } from "../server/paseo-projects";

// A board that has no database yet, or an older one, must only be read: the doctor and the project
// check never create, migrate or write it. The data directory is disposable.
const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "paseo-project-readonly-")));
process.env.KANBAN_DATA_DIR = dir;
const ALPHA = join(dir, "repos", "alpha");
mkdirSync(ALPHA, { recursive: true });
const configPath = join(dir, "kanban.config.json");
const storedPath = join(dir, "paseo-projects.json");
const dbPath = join(dir, "kanban.db");

function seed(): void {
  writeFileSync(configPath, JSON.stringify({
    language: "system", autoStart: {}, supervisorAgentId: null, supervisors: { alpha: "alpha-leader" },
    concurrency: { global: 5, pools: {}, roles: {} },
    projects: { alpha: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, workspacePath: ALPHA } },
  }));
  writeFileSync(storedPath, JSON.stringify({ readAt: "2026-10-01T00:00:00.000Z", projects: [{ id: "p", name: "Other", path: join(dir, "repos", "other") }] }));
}

async function doctor(): Promise<void> {
  clearDoctorSafetyCache();
  await runDoctor({ now: new Date("2026-10-01T03:00:00.000Z"), wake: false, persist: false, sources: {} });
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("project ownership reads the board without writing", () => {
  it("does not create the database when the doctor runs against a cold board", async () => {
    seed();
    resetPaseoProjects();
    const before = readFileSync(configPath);
    assert.equal(existsSync(dbPath), false);
    await doctor();
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(`${dbPath}-wal`), false);
    assert.equal(isProjectRemoved("alpha"), true);
    assert.deepEqual([...removedProjects()], ["alpha"]);
    assert.deepEqual(readFileSync(configPath), before);
  });

  it("leaves an older database byte for byte and schema for schema alone", async () => {
    seed();
    resetPaseoProjects();
    const old = new DatabaseSync(dbPath);
    old.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, project TEXT NOT NULL); INSERT INTO tasks (project) VALUES ('alpha');");
    old.close();
    const bytes = readFileSync(dbPath);
    const before = readFileSync(configPath);
    await doctor();
    assert.equal(isProjectRemoved("alpha"), true);
    assert.deepEqual(removedProjects().has("alpha"), true);
    assert.deepEqual(readFileSync(dbPath), bytes);
    assert.deepEqual(readFileSync(configPath), before);
    assert.equal(existsSync(`${dbPath}-wal`), false);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    check.close();
    assert.deepEqual(tables, ["tasks"]);
  });
});
