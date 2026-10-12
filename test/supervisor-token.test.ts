/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SUBPROCESS_TIMEOUT_MS } from "./helpers/subprocess-timeout";
import { after, beforeEach, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { ensureSupervisorToken } from "../server/tokens";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const root = mkdtempSync(join(tmp, "supervisor-token-"));
const saved = process.env.KANBAN_DATA_DIR;
let dir = "";
let serial = 0;

beforeEach(() => {
  closeDb();
  dir = join(root, String(++serial));
  mkdirSync(dir, { recursive: true });
  process.env.KANBAN_DATA_DIR = dir;
});

after(() => {
  closeDb();
  if (saved === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

function supervisorRows(): string[] {
  const rows = getDb().prepare("SELECT token FROM tokens WHERE role = 'supervisor' AND task_id IS NULL").all() as Array<{ token: string }>;
  return rows.map((row) => row.token);
}

function ensureInChild(dataDir: string, onStarting?: () => void): Promise<string> {
  const code = `import { ensureSupervisorToken } from ${JSON.stringify(join(process.cwd(), "server/tokens.ts"))}; ${onStarting ? 'console.log("starting");' : ""} console.log(ensureSupervisorToken());`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: { ...process.env, KANBAN_DATA_DIR: dataDir } });
    let out = "";
    let err = "";
    let spawnError: Error | undefined;
    const timeout = setTimeout(() => child.kill("SIGKILL"), SUBPROCESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (onStarting && out.startsWith("starting\n")) {
        out = out.slice("starting\n".length);
        const started = onStarting;
        onStarting = undefined;
        started();
      }
    });
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      if (spawnError) reject(spawnError);
      else if (status === 0) resolve(out.trim());
      else reject(new Error(`child exit ${status ?? signal}: ${err}`));
    });
  });
}

async function concurrentTokens(): Promise<string[]> {
  // Fail only after every child has closed; after() may now safely remove the fixture.
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => ensureInChild(dir)));
  const errors = results.filter(result => result.status === "rejected");
  assert.deepEqual(errors, [], errors.map(result => String(result.reason)).join("\n"));
  return results.map(result => (result as PromiseFulfilledResult<string>).value);
}

function assertAgreedTokens(tokens: string[]): void {
  assert.equal(new Set(tokens).size, 1, tokens.join(","));
  assert.equal(readFileSync(join(dir, "supervisor.token"), "utf8").trim(), tokens[0]);
  assert.deepEqual(supervisorRows(), [tokens[0]]);
  assert.equal(tokens[0].length, 64);
}

describe("ensureSupervisorToken", () => {
  it("creates the file with mode 0600 and one matching row, leaving no temp file behind", () => {
    const token = ensureSupervisorToken();
    const file = join(dir, "supervisor.token");
    assert.equal(readFileSync(file, "utf8").trim(), token);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(supervisorRows(), [token]);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp")), []);
  });

  it("treats an empty token file as an error and replaces neither the file nor the row", () => {
    const first = ensureSupervisorToken();
    const file = join(dir, "supervisor.token");
    writeFileSync(file, "\n");
    assert.throws(() => ensureSupervisorToken(), new RegExp("supervisor\\.token.*" + zhCN("boardViews.column.empty")));
    assert.equal(readFileSync(file, "utf8"), "\n");
    assert.deepEqual(supervisorRows(), [first]);
  });

  it("registers a token that is in the file but not in the database, and drops stale supervisor rows", () => {
    const stale = ensureSupervisorToken();
    const file = join(dir, "supervisor.token");
    writeFileSync(file, "operator-chosen-token\n", { mode: 0o600 });
    assert.equal(ensureSupervisorToken(), "operator-chosen-token");
    assert.deepEqual(supervisorRows(), ["operator-chosen-token"]);
    assert.equal(supervisorRows().includes(stale), false);
  });

  it("regenerates the file when the row is gone from a database that still has the file", () => {
    const first = ensureSupervisorToken();
    getDb().prepare("DELETE FROM tokens WHERE role = 'supervisor'").run();
    assert.equal(ensureSupervisorToken(), first);
    assert.deepEqual(supervisorRows(), [first]);
  });

  it("rolls the database back when the token file cannot be written", () => {
    // A directory where the file should be makes both the read and the rename fail.
    mkdirSync(join(dir, "supervisor.token"));
    assert.throws(() => ensureSupervisorToken());
    assert.deepEqual(supervisorRows(), []);
  });

  it("concurrent first starts in separate processes agree on one token", async () => {
    // Reopening a running board must also wait for WAL/migration locks.
    getDb();
    closeDb();
    assertAgreedTokens(await concurrentTokens());
  });

  it("concurrent first starts create an empty board and agree on one token", async () => {
    assertAgreedTokens(await concurrentTokens());
  });

  it("concurrent opens migrate an old board once and preserve its rows", async () => {
    const db = getDb();
    db.exec("ALTER TABLE native_session_queue DROP COLUMN last_error");
    db.exec(`INSERT INTO native_session_queue(agent_id, task_id, home, attempts) VALUES ('retry', 42, '/fixture', 1);
      INSERT INTO events(task_id, at, kind, data_json) VALUES (42, 'now', 'native_session_archive_failed', '{"agentId":"retry","error":"old failure"}')`);
    closeDb();
    assertAgreedTokens(await concurrentTokens());
    assert.deepEqual(getDb().prepare("SELECT last_error, attempts FROM native_session_queue WHERE agent_id = 'retry'").get(),
      Object.assign(Object.create(null), { last_error: "old failure", attempts: 1 }));
  });

  it("waits for a lock before switching a rollback-journal board to WAL", async () => {
    const blocker = new DatabaseSync(join(dir, "kanban.db"));
    blocker.exec("CREATE TABLE fixture(value TEXT); BEGIN EXCLUSIVE");
    let release: ReturnType<typeof setTimeout> | undefined;
    let locked = true;
    try {
      const token = await ensureInChild(dir, () => {
        release = setTimeout(() => { blocker.exec("COMMIT"); locked = false; }, 250);
      });
      assertAgreedTokens([token]);
      assert.equal((getDb().prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    } finally {
      clearTimeout(release);
      if (locked) blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

});
