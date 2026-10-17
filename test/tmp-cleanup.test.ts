/// <reference types="node" />
import assert from "node:assert/strict";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import fsPromises from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import childProcess from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it, mock, type TestContext } from "node:test";
import { closeDb, getDb } from "../server/db";
import { execFileSync } from "node:child_process";
import { runDoctor } from "../server/doctor";
import { resetMissingCwdForTests, setMissingCwdHooks } from "../server/missing-cwd";
import * as cleanup from "../server/tmp-cleanup";
import { cleanTmpDirs, flushTmpCleanup, resetTmpCleanupForTests, scheduleTmpCleanup, tmpNamesFor } from "../server/tmp-cleanup";
import { cardMark } from "../server/card-ref";
import { cardTmpEnv } from "../server/card-tmp";
import { unifiedDataRoot } from "../server/storage/root";
import { createTask } from "../server/store";
import { loadConfig, saveConfig } from "../server/config";
import { prepareTaskTmpEnv } from "../server/card-tmp-record";
import { getTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "tmpclean-data-"));
process.env.KANBAN_DATA_DIR = dir;
const madeDirs: string[] = [dir];

const HOUR = 60 * 60_000;
const T0 = new Date("2026-10-01T00:00:00.000Z");
let root = "";

function card(status: string, endedAt: Date | null): { id: number; code: string } {
  const task = createTask({ project: "tmpc", title: "t", role: "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
  if (endedAt) {
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'accept', 'acceptance', ?, 'test', '{}')")
      .run(task.id, endedAt.toISOString(), status);
  }
  return { id: task.id, code: cardMark(task.id) };
}

function mk(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "kanban.db"), "x".repeat(2048));
  return path;
}

function events(id: number): string[] {
  const rows = getDb().prepare("SELECT kind FROM events WHERE task_id = ? AND kind = 'tmp_cleaned'").all(id) as unknown as Array<{ kind: string }>;
  return rows.map((r) => r.kind);
}

/** Hold the real cleaner at its du callback, without a timer or a fake cleanup implementation. */
function holdDu(t: TestContext) {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const original = childProcess.execFile;
  const mocked = mock.method(childProcess, "execFile", (command: string, ...args: unknown[]) => {
    if (command !== "du") return Reflect.apply(original, childProcess, [command, ...args]);
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
    release = () => callback(null, "2\tcard\n", "");
    entered();
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return { started, release: () => release() };
}

function openProblems(): Array<{ taskId: number; path: string; reason: string }> {
  const fn = (cleanup as { tmpCleanupProblems?: () => Array<{ taskId: number; path: string; reason: string }> }).tmpCleanupProblems;
  assert.equal(typeof fn, "function");
  return fn!();
}

function setProcessCwds(list: (() => string[] | null) | null): void {
  const fn = (cleanup as { setTmpCleanupHooks?: (hooks: { listProcessCwds?: () => string[] | null } | null) => void }).setTmpCleanupHooks;
  assert.equal(typeof fn, "function");
  fn!(list ? { listProcessCwds: list } : null);
}

/** A stand-in lsof that prints the given process cwds in `-F pn` form. */
function fakeLsof(directory: string, cwds: string[]): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "lsof");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${["p1", ...cwds.map((cwd) => `n${cwd}`)].map((line) => `'${line}'`).join(" ")}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Run the body with PATH set to the given directories only, then restore it. */
async function withPath<T>(dirs: string[], body: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = dirs.join(":");
  try { return await body(); } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
}

function setLsofFallbacks(paths: string[]): void {
  const fn = (cleanup as { setTmpCleanupHooks?: (hooks: { lsofFallbacks?: string[] } | null) => void }).setTmpCleanupHooks;
  assert.equal(typeof fn, "function");
  fn!({ lsofFallbacks: paths });
}

async function until(check: () => boolean, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  do {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return check();
}

function processCwdVisible(path: string): boolean {
  const out = childProcess.spawnSync("lsof", ["-d", "cwd", "-F", "pn"], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  return String(out.stdout ?? "").includes(path);
}

describe("tmp cleanup", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tmpclean-root-"));
    madeDirs.push(root);
    resetTmpCleanupForTests();
  });
  after(() => { closeDb(); for (const made of madeDirs) rmSync(made, { recursive: true, force: true }); });

  it("builds the four strict names", () => {
    assert.deepEqual(tmpNamesFor("TEST_0136"), ["TEST_0136", "test_0136", "test-0136", "test0136"]);
  });

  it("deletes dirs of a finished card immediately and records tmp_cleaned", async () => {
    const c = card("done", T0);
    const paths = [mk(c.code), mk(c.code.toLowerCase().replace("_", "-")), mk(c.code.toLowerCase().replace("_", ""))];
    const out = await cleanTmpDirs({ now: T0, roots: [root] });
    assert.equal(out.length, 3);
    for (const p of paths) assert.equal(existsSync(p), false);
    assert.equal(events(c.id).length, 3);
    assert.ok(out.every((o) => o.bytes >= 2048));
  });

  it("cleans project and fallback roots by default, including a recorded root after configuration changes", async () => {
    const home = join(root, "home");
    const repo = join(root, "project");
    execFileSync("git", ["init", "-q", repo]);
    const prior = process.env.KANBAN_TMP_ROOT;
    const homeMock = mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    delete process.env.KANBAN_TMP_ROOT;
    setMissingCwdHooks({ listAgents: () => [] });
    try {
      saveConfig({ ...loadConfig(), projects: { tmpc: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, workspacePath: repo } } });
      const a = card("done", T0);
      const projectEnv = prepareTaskTmpEnv(getTask(a.id), "test");
      assert.equal(projectEnv.KANBAN_TMP, join(realpathSync(repo), ".kanban-work", a.code));
      saveConfig({ ...loadConfig(), projects: { tmpc: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, workspacePath: root } } });
      const b = card("done", T0);
      const fallbackEnv = prepareTaskTmpEnv(getTask(b.id), "test");
      assert.equal(fallbackEnv.KANBAN_TMP, join(unifiedDataRoot(process.env, home), "work", "tmpc", b.code));
      const active = card("running", null);
      const activeEnv = prepareTaskTmpEnv(getTask(active.id), "test");
      const out = await cleanTmpDirs({ now: new Date(T0.getTime() + 24 * HOUR) });
      assert.ok(out.some(row => row.path === projectEnv.KANBAN_TMP));
      assert.ok(out.some(row => row.path === fallbackEnv.KANBAN_TMP));
      assert.equal(existsSync(projectEnv.KANBAN_TMP), false);
      assert.equal(existsSync(fallbackEnv.KANBAN_TMP), false);
      assert.equal(existsSync(activeEnv.KANBAN_TMP), true);
    } finally {
      if (prior === undefined) delete process.env.KANBAN_TMP_ROOT; else process.env.KANBAN_TMP_ROOT = prior;
      homeMock.mock.restore(); syncBuiltinESMExports(); resetMissingCwdForTests();
    }
  });

  it("cleaning the same card path again folds into one tmp_cleaned summary and keeps every retirement id", async () => {
    const c = card("done", T0);
    const now = new Date(T0.getTime() + 24 * HOUR);
    const path = mk(c.code);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 1);
    mk(c.code);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 1);
    mk(c.code);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 1);
    assert.equal(existsSync(path), false);
    const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tmp_cleaned'").all(c.id) as unknown as Array<{ data_json: string }>;
    assert.equal(rows.length, 1);
    const data = JSON.parse(rows[0]!.data_json) as { count: number; path: string; retirementIds: number[]; retirementId: number };
    assert.equal(data.count, 3);
    assert.equal(data.path, path);
    assert.equal(data.retirementIds.length, 3);
    assert.equal(data.retirementIds.at(-1), data.retirementId);
    const open = getDb().prepare(`SELECT COUNT(*) AS n FROM events e WHERE e.kind = 'tmp_retirement_prepared' AND NOT EXISTS (
      SELECT 1 FROM events f WHERE f.task_id = e.task_id AND f.kind IN ('tmp_cleaned', 'tmp_retirement_cancelled')
      AND (json_extract(f.data_json, '$.retirementId') = e.id OR EXISTS (SELECT 1 FROM json_each(f.data_json, '$.retirementIds') j WHERE j.value = e.id)))`).get() as { n: number };
    assert.equal(open.n, 0, "every journaled retirement of the card is settled by the one summary row");
  });

  it("counts from the latest entry into the end state, not an old done", async () => {
    const c = card("archived", null);
    const ev = (at: Date, from: string, to: string) =>
      getDb()
        .prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'x', ?, ?, 'test', '{}')")
        .run(c.id, at.toISOString(), from, to);
    ev(T0, "acceptance", "done");
    ev(new Date(T0.getTime() + 10 * HOUR), "done", "rework");
    ev(new Date(T0.getTime() + 100 * HOUR), "rework", "archived");
    const p = mk(c.code);
    assert.equal((await cleanTmpDirs({ now: new Date(T0.getTime() + 101 * HOUR), roots: [root] })).length, 1);
    assert.equal(existsSync(p), false);
  });

  async function failedRetirement(t: TestContext): Promise<{ c: { id: number; code: string }; p: string; retired: string; now: Date }> {
    const c = card("done", T0);
    const p = mk(c.code);
    const mocked = mock.method(fsPromises, "rm", async () => { throw new Error("simulated rm failure"); });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const now = new Date(T0.getTime() + 48 * HOUR);
    await cleanTmpDirs({ now, roots: [root] });
    const record = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tmp_retirement_prepared' ORDER BY id DESC LIMIT 1").get(c.id) as { data_json: string };
    const retired = JSON.parse(record.data_json).retiredPath as string;
    mocked.mock.restore();
    syncBuiltinESMExports();
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("cannot remove directory")));
    return { c, p, retired, now };
  }

  function failureAttempt(taskId: number): number {
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tmp_cleanup_failed' ORDER BY id DESC LIMIT 1").get(taskId) as { data_json: string };
    return JSON.parse(row.data_json).attempt as number;
  }

  it("clears the red when the retired directory is already gone on retry", async (t) => {
    const { c, p, retired, now } = await failedRetirement(t);
    rmSync(retired, { recursive: true, force: true });
    assert.equal((await cleanTmpDirs({ now: new Date(now.getTime() + 60_000), roots: [root] })).length, 0);
    assert.equal(openProblems().some((item) => item.path === p), false);
    assert.equal(events(c.id).length, 1);
    const report = await runDoctor({ persist: false, wake: false, sources: {} });
    assert.equal(report.findings.some((item) => item.taskId === c.id && item.id.startsWith("tmp-cleanup:")), false);
  });

  it("names an inode mismatch as the red reason and reports it once", async (t) => {
    const { c, p, retired, now } = await failedRetirement(t);
    fs.renameSync(retired, join(root, "saved-old-directory"));
    mkdirSync(retired);
    writeFileSync(join(retired, "keep.txt"), "other directory");
    await cleanTmpDirs({ now: new Date(now.getTime() + 60_000), roots: [root] });
    const shown = openProblems().filter((item) => item.path === p);
    assert.equal(shown.length, 1);
    assert.match(shown[0].reason, /inode/);
    assert.doesNotMatch(shown[0].reason, /cannot remove directory/);
    const attempt = failureAttempt(c.id);
    const errors = mock.method(console, "error", () => {});
    t.after(() => errors.mock.restore());
    await cleanTmpDirs({ now: new Date(now.getTime() + 3 * 3_600_000), roots: [root] });
    assert.equal(failureAttempt(c.id), attempt, "the same reason is not written again");
    assert.equal(errors.mock.calls.length, 0, "and not logged again");
    assert.equal(existsSync(join(retired, "keep.txt")), true);
  });

  it("names an owner mismatch as the red reason and does not delete", async (t) => {
    const { p, retired, now } = await failedRetirement(t);
    await cleanTmpDirs({ now: new Date(now.getTime() + 60_000), roots: [root], ownerUid: (process.getuid?.() ?? 0) + 1 });
    const shown = openProblems().filter((item) => item.path === p);
    assert.equal(shown.length, 1);
    assert.match(shown[0].reason, /owner/);
    assert.equal(existsSync(retired), true);
  });

  it("clears the red when the directory vanishes while an agent held it", async (t) => {
    t.after(() => resetMissingCwdForTests());
    const c = card("done", T0);
    const p = mk(c.code);
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-live", c.id);
    const agent = { id: "agent-live", cwd: root, provider: "x", title: "t", archived: false, lastActivityAt: null, labels: {} };
    setMissingCwdHooks({ listAgents: () => [agent] });
    const now = new Date(T0.getTime() + 48 * HOUR);
    await cleanTmpDirs({ now, roots: [root] });
    assert.ok(openProblems().some((item) => item.path === p));
    rmSync(p, { recursive: true, force: true });
    await cleanTmpDirs({ now, roots: [root] });
    assert.equal(openProblems().some((item) => item.path === p), false);
  });

  it("keeps a rework or blocked card", async () => {
    for (const status of ["rework", "blocked"]) {
      const c = card(status, null);
      const p = mk(c.code);
      assert.equal((await cleanTmpDirs({ now: new Date(T0.getTime() + 100 * HOUR), roots: [root] })).length, 0);
      assert.equal(existsSync(p), true);
    }
  });

  it("done then auto-archived counts from done", async () => {
    const c = card("archived", null);
    const ev = (at: Date, from: string, to: string) =>
      getDb()
        .prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'x', ?, ?, 'test', '{}')")
        .run(c.id, at.toISOString(), from, to);
    ev(T0, "acceptance", "done");
    ev(new Date(T0.getTime() + 20 * HOUR), "done", "archived");
    const p = mk(c.code);
    assert.equal((await cleanTmpDirs({ now: new Date(T0.getTime() + 24 * HOUR), roots: [root] })).length, 1);
    assert.equal(existsSync(p), false);
  });

  it("deletes archived cards too", async () => {
    const c = card("archived", T0);
    const p = mk(c.code);
    await cleanTmpDirs({ now: T0, roots: [root] });
    assert.equal(existsSync(p), false);
  });

  it("keeps a reopened card and its new file while du is waiting", { timeout: 30_000 }, async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    const du = holdDu(t);
    const cleaning = cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] });
    await du.started;
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(c.id);
    writeFileSync(join(p, "new-run.txt"), "must survive");
    du.release();
    assert.equal((await cleaning).length, 0);
    assert.equal(existsSync(join(p, "new-run.txt")), true);
    assert.deepEqual(events(c.id), []);
  });

  it("rechecks the terminal event when a reopened card ends again during du", { timeout: 30_000 }, async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    const du = holdDu(t);
    const cleaning = cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] });
    await du.started;
    getDb().prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor) VALUES (?, ?, 'accept', 'running', 'done', 'test')")
      .run(c.id, new Date(T0.getTime() + 47 * HOUR).toISOString());
    du.release();
    assert.equal((await cleaning).length, 0);
    assert.equal(existsSync(p), true);
    assert.deepEqual(events(c.id), []);
  });

  it("rejects a different terminal generation even with the same timestamp", { timeout: 30_000 }, async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    const du = holdDu(t);
    const cleaning = cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] });
    await du.started;
    getDb().prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor) VALUES (?, ?, 'accept', 'running', 'done', 'test')")
      .run(c.id, T0.toISOString());
    du.release();
    assert.equal((await cleaning).length, 0);
    assert.equal(existsSync(p), true);
  });

  it("uses event order rather than the largest timestamp for terminal age", async () => {
    const c = card("done", new Date(T0.getTime() + 100 * HOUR));
    const p = mk(c.code);
    getDb().prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor) VALUES (?, ?, 'accept', 'running', 'done', 'test')")
      .run(c.id, T0.toISOString());
    assert.equal((await cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] })).length, 1);
    assert.equal(existsSync(p), false);
  });

  it("keeps a rotated directory generation while du is waiting", { timeout: 30_000 }, async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    process.env.KANBAN_TMP_ROOT = root;
    t.after(() => { delete process.env.KANBAN_TMP_ROOT; });
    cardTmpEnv(c.code);
    const du = holdDu(t);
    const cleaning = cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] });
    await du.started;
    cardTmpEnv(c.code);
    du.release();
    assert.equal((await cleaning).length, 0);
    assert.equal(existsSync(p), true);
  });

  it("still deletes when an existing nested file changes while du is waiting", { timeout: 30_000 }, async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    mkdirSync(join(p, "nested"));
    const file = join(p, "nested", "active.txt");
    writeFileSync(file, "old");
    const du = holdDu(t);
    const cleaning = cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] });
    await du.started;
    writeFileSync(file, "new activity");
    du.release();
    assert.equal((await cleaning).length, 1);
    assert.equal(existsSync(file), false);
    assert.equal(events(c.id).length, 1);
  });

  it("refreshes agent cwd protection after du", { timeout: 30_000 }, async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    setMissingCwdHooks({ listAgents: () => [] });
    t.after(() => resetMissingCwdForTests());
    const du = holdDu(t);
    const cleaning = cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] });
    await du.started;
    setMissingCwdHooks({ listAgents: () => [{ id: "new-agent", cwd: p, provider: "x", title: "t", archived: false, lastActivityAt: null, labels: {} }] });
    du.release();
    assert.equal((await cleaning).length, 0);
    assert.equal(existsSync(p), true);
  });

  it("does not delete a new run's canonical directory while recursive removal is pending", { timeout: 30_000 }, async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const original = fsPromises.rm;
    const mocked = mock.method(fsPromises, "rm", async (...args: Parameters<typeof original>) => {
      entered();
      await released;
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const cleaning = cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] });
    await started;
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(c.id);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "new-run.txt"), "must survive");
    release();
    await cleaning;
    assert.equal(existsSync(join(p, "new-run.txt")), true);
  });

  it("holds a cross-process database write lock through the final rename", async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    const original = fs.renameSync;
    let attempts = 0;
    const mocked = mock.method(fs, "renameSync", (...args: Parameters<typeof original>) => {
      attempts++;
      const child = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA busy_timeout = 0');
        try { db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(Number(process.argv[2])); }
        catch (err) { if (err.errcode === 5) process.exit(23); throw err; }
      `, join(dir, "kanban.db"), String(c.id)], { encoding: "utf8", timeout: 30_000 });
      assert.equal(child.status, 23, child.stderr);
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    assert.equal((await cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] })).length, 1);
    assert.equal(attempts, 1);
    assert.equal(existsSync(p), false);
  });

  it("retries failed removal only on the retired inode after the card reopens", async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    const mocked = mock.method(fsPromises, "rm", async () => { throw new Error("simulated rm failure"); });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0);
    assert.equal(existsSync(p), false, "the old directory was retired before rm failed");
    const record = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tmp_retirement_prepared' ORDER BY id DESC LIMIT 1").get(c.id) as { data_json: string };
    const retired = JSON.parse(record.data_json).retiredPath as string;
    assert.equal(existsSync(retired), true);
    mocked.mock.restore();
    syncBuiltinESMExports();
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(c.id);
    mkdirSync(p);
    writeFileSync(join(p, "new-run.txt"), "must survive");
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0, "the same timestamp stays in backoff");
    assert.equal(existsSync(retired), true);
    assert.equal(existsSync(join(p, "new-run.txt")), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("cannot remove directory")));
    const report = await runDoctor({ persist: false, wake: false, sources: {} });
    const finding = report.findings.find((item) => item.taskId === c.id && item.severity === "red" && item.id.startsWith("tmp-cleanup:"));
    if (!finding) assert.fail("doctor reports the failed removal");
    assert.match(finding.evidence, /cannot remove directory/);
    assert.equal(finding.object, p);
    const later = new Date(now.getTime() + 60_000);
    assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 1);
    assert.equal(existsSync(retired), false);
    assert.equal(existsSync(join(p, "new-run.txt")), true);
    assert.equal(events(c.id).length, 1);
    assert.equal(openProblems().some((item) => item.path === p), false);
    const cleared = await runDoctor({ persist: false, wake: false, sources: {} });
    assert.equal(cleared.findings.some((item) => item.taskId === c.id && item.id.startsWith("tmp-cleanup:")), false);
  });

  it("retries a partial removal after the generation marker is already gone", async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    writeFileSync(join(p, ".kanban-tmp-generation"), "gen-1");
    writeFileSync(join(p, "leftover.txt"), "still here");
    let fail = true;
    const original = fsPromises.rm;
    const mocked = mock.method(fsPromises, "rm", async (...args: Parameters<typeof original>) => {
      if (!fail) return original(...args);
      rmSync(join(String(args[0]), ".kanban-tmp-generation"), { force: true });
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0);
    const record = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tmp_retirement_prepared' ORDER BY id DESC LIMIT 1").get(c.id) as { data_json: string };
    const retired = JSON.parse(record.data_json).retiredPath as string;
    assert.equal(existsSync(retired), true);
    assert.equal(existsSync(join(retired, ".kanban-tmp-generation")), false);
    assert.equal(existsSync(join(retired, "leftover.txt")), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("cannot remove directory")));
    const reported = await runDoctor({ persist: false, wake: false, sources: {} });
    assert.ok(reported.findings.some((item) => item.taskId === c.id && item.severity === "red" && item.id.startsWith("tmp-cleanup:")));
    fail = false;
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0, "the same timestamp stays in backoff");
    assert.equal(existsSync(retired), true);
    const later = new Date(now.getTime() + 60_000);
    assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 1);
    assert.equal(existsSync(retired), false);
    assert.equal(existsSync(p), false);
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".kanban-tmp-retired-")), false);
    assert.equal(openProblems().some((item) => item.path === p), false);
    const cleared = await runDoctor({ persist: false, wake: false, sources: {} });
    assert.equal(cleared.findings.some((item) => item.taskId === c.id && item.id.startsWith("tmp-cleanup:")), false);
  });

  it("does not retry a retired directory whose generation marker changed", async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    writeFileSync(join(p, ".kanban-tmp-generation"), "gen-1");
    const mocked = mock.method(fsPromises, "rm", async () => { throw new Error("simulated rm failure"); });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0);
    const record = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tmp_retirement_prepared' ORDER BY id DESC LIMIT 1").get(c.id) as { data_json: string };
    const retired = JSON.parse(record.data_json).retiredPath as string;
    writeFileSync(join(retired, ".kanban-tmp-generation"), "gen-2");
    mocked.mock.restore();
    syncBuiltinESMExports();
    const later = new Date(now.getTime() + 60_000);
    assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 0);
    assert.equal(fs.readFileSync(join(retired, ".kanban-tmp-generation"), "utf8"), "gen-2");
    assert.ok(openProblems().some((item) => item.path === p));
  });

  it("does not retry a retirement path that has been replaced by a different inode", async (t) => {
    const c = card("done", T0);
    mk(c.code);
    const mocked = mock.method(fsPromises, "rm", async () => { throw new Error("simulated rm failure"); });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const now = new Date(T0.getTime() + 48 * HOUR);
    await cleanTmpDirs({ now, roots: [root] });
    const record = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tmp_retirement_prepared' ORDER BY id DESC LIMIT 1").get(c.id) as { data_json: string };
    const retired = JSON.parse(record.data_json).retiredPath as string;
    fs.renameSync(retired, join(root, "saved-old-directory"));
    mkdirSync(retired);
    writeFileSync(join(retired, "keep.txt"), "different owner of the path");
    mocked.mock.restore();
    syncBuiltinESMExports();
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0);
    assert.equal(existsSync(join(retired, "keep.txt")), true);
    assert.deepEqual(events(c.id), []);
  });

  it("deletes a finished card before 24 hours and keeps running cards and unknown names", async () => {
    const fresh = card("done", T0);
    const live = card("running", null);
    const p1 = mk(fresh.code);
    const p2 = mk(live.code);
    const p3 = mk("TEST_9999");
    const p4 = mk("other-program");
    const p5 = mk(`${fresh.code}-extra`);
    const out = await cleanTmpDirs({ now: new Date(T0.getTime() + 23 * HOUR), roots: [root] });
    assert.equal(out.length, 1);
    assert.equal(existsSync(p1), false);
    for (const p of [p2, p3, p4, p5]) assert.equal(existsSync(p), true);
  });

  it("does not follow symlinks", async () => {
    const c = card("done", T0);
    const outside = mkdtempSync(join(tmpdir(), "tmpclean-outside-"));
    madeDirs.push(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(root, c.code));
    const out = await cleanTmpDirs({ now: new Date(T0.getTime() + 48 * HOUR), roots: [root] });
    assert.equal(out.length, 0);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    assert.equal(existsSync(join(root, c.code)), true);
  });

  it("stops at the per-round limit and finishes next round", async () => {
    const cards = Array.from({ length: 5 }, () => card("done", T0));
    for (const c of cards) mk(c.code);
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await cleanTmpDirs({ now, roots: [root], limit: 2 })).length, 2);
    assert.equal((await cleanTmpDirs({ now, roots: [root], limit: 2 })).length, 2);
    assert.equal((await cleanTmpDirs({ now, roots: [root], limit: 2 })).length, 1);
  });

  it("scheduler hook runs on the next round and does not block", async () => {
    const c = card("done", T0);
    const p = mk(c.code);
    const now = new Date(T0.getTime() + 48 * HOUR);
    const started = Date.now();
    scheduleTmpCleanup({ now, roots: [root] });
    assert.ok(Date.now() - started < 1000);
    await flushTmpCleanup();
    assert.equal(existsSync(p), false);
    const again = mk(c.code);
    scheduleTmpCleanup({ now: new Date(now.getTime() + 60_000), roots: [root] });
    await flushTmpCleanup();
    assert.equal(existsSync(again), false);
  });

  it("deletes every finished card in one round", async () => {
    const cards = Array.from({ length: 25 }, () => card("done", T0));
    for (const c of cards) mk(c.code);
    assert.equal((await cleanTmpDirs({ now: T0, roots: [root] })).length, 25);
  });

  it("deletes a finished card whose generation marker is unchanged", async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    process.env.KANBAN_TMP_ROOT = root;
    t.after(() => { delete process.env.KANBAN_TMP_ROOT; });
    cardTmpEnv(c.code);
    assert.equal((await cleanTmpDirs({ now: T0, roots: [root] })).length, 1);
    assert.equal(existsSync(p), false);
  });

  it("keeps the directory while an agent this card opened is still present", async (t) => {
    t.after(() => resetMissingCwdForTests());
    const c = card("done", T0);
    const p = mk(c.code);
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-live", c.id);
    const agent = { id: "agent-live", cwd: root, provider: "x", title: "t", archived: false, lastActivityAt: null, labels: {} };
    setMissingCwdHooks({ listAgents: () => [agent] });
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0);
    assert.equal(existsSync(p), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("an agent is still in use")));
    setMissingCwdHooks({ listAgents: () => [{ ...agent, archived: true }] });
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 1);
    assert.equal(existsSync(p), false);
    assert.equal(openProblems().some((item) => item.path === p), false);
  });

  it("keeps a directory a process is using as its cwd and doctor shows red until the retry", { timeout: 120_000 }, async (t) => {
    const c = card("done", T0);
    const p = mk(c.code);
    setMissingCwdHooks({ listAgents: () => [] });
    t.after(() => resetMissingCwdForTests());
    const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { cwd: p, stdio: "ignore" });
    t.after(() => { if (child.exitCode == null) child.kill("SIGKILL"); });
    const real = realpathSync(p);
    assert.equal(await until(() => processCwdVisible(real) || processCwdVisible(p), 8_000), true, "lsof sees the child cwd");
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0);
    assert.equal(existsSync(p), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("process working directory")));
    const report = await runDoctor({ persist: false, wake: false, sources: {} });
    const finding = report.findings.find((item) => item.taskId === c.id && item.severity === "red" && item.id.startsWith("tmp-cleanup:"));
    if (!finding) assert.fail("doctor reports the live process");
    assert.match(finding.evidence, /process working directory/);
    assert.equal(finding.object, p);
    child.kill("SIGKILL");
    assert.equal(await until(() => !processCwdVisible(real) && !processCwdVisible(p), 8_000), true);
    assert.equal((await cleanTmpDirs({ now: new Date(now.getTime() + 1000), roots: [root] })).length, 1);
    assert.equal(existsSync(p), false);
    assert.equal(openProblems().some((item) => item.path === p), false);
    const cleared = await runDoctor({ persist: false, wake: false, sources: {} });
    assert.equal(cleared.findings.some((item) => item.taskId === c.id && item.id.startsWith("tmp-cleanup:")), false);
  });

  it("reports red when process working directories cannot be listed", async (t) => {
    t.after(() => { resetMissingCwdForTests(); resetTmpCleanupForTests(); });
    const c = card("done", T0);
    const p = mk(c.code);
    setMissingCwdHooks({ listAgents: () => [] });
    setProcessCwds(() => null);
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 0);
    assert.equal(existsSync(p), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("could not be listed")));
    setProcessCwds(() => []);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 1);
    assert.equal(openProblems().some((item) => item.path === p), false);
  });

  it("finds lsof in a fallback location when PATH has none", async (t) => {
    t.after(() => { resetMissingCwdForTests(); resetTmpCleanupForTests(); });
    const c = card("done", T0);
    const p = mk(c.code);
    setMissingCwdHooks({ listAgents: () => [] });
    const bare = join(root, "bare-path");
    mkdirSync(bare);
    const busy = fakeLsof(join(root, "fallback-busy"), [realpathSync(p)]);
    const idle = fakeLsof(join(root, "fallback-idle"), ["/"]);
    const now = new Date(T0.getTime() + 48 * HOUR);
    setLsofFallbacks([busy]);
    assert.equal((await withPath([bare], () => cleanTmpDirs({ now, roots: [root] }))).length, 0);
    assert.equal(existsSync(p), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("process working directory")));
    setLsofFallbacks([join(root, "missing", "lsof"), idle]);
    assert.equal((await withPath([bare], () => cleanTmpDirs({ now: new Date(now.getTime() + 1000), roots: [root] }))).length, 1);
    assert.equal(existsSync(p), false);
    assert.equal(openProblems().some((item) => item.path === p), false);
  });

  it("uses the lsof on PATH before any fallback", async (t) => {
    t.after(() => { resetMissingCwdForTests(); resetTmpCleanupForTests(); });
    const c = card("done", T0);
    const p = mk(c.code);
    setMissingCwdHooks({ listAgents: () => [] });
    fakeLsof(join(root, "on-path"), [realpathSync(p)]);
    const idle = fakeLsof(join(root, "fallback-idle"), ["/"]);
    setLsofFallbacks([idle]);
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await withPath([join(root, "on-path")], () => cleanTmpDirs({ now, roots: [root] }))).length, 0);
    assert.equal(existsSync(p), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("process working directory")));
  });

  it("with no lsof anywhere, deletes once the agent list confirms and writes an info line", async (t) => {
    t.after(() => { resetMissingCwdForTests(); resetTmpCleanupForTests(); });
    const c = card("done", T0);
    const p = mk(c.code);
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-gone", c.id);
    const archived = { id: "agent-gone", cwd: p, provider: "x", title: "t", archived: true, lastActivityAt: null, labels: {} };
    setMissingCwdHooks({ listAgents: () => [archived] });
    setLsofFallbacks([]);
    const bare = join(root, "bare-path");
    mkdirSync(bare);
    const lines: string[] = [];
    const info = mock.method(console, "info", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    t.after(() => info.mock.restore());
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await withPath([bare], () => cleanTmpDirs({ now, roots: [root] }))).length, 1);
    assert.equal(existsSync(p), false);
    assert.equal(openProblems().some((item) => item.path === p), false);
    assert.equal(lines.filter((line) => line.includes("lsof was not found") && line.includes("agent list")).length, 1);
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'tmp_cleaned'").get(c.id) as { data_json: string };
    assert.equal(JSON.parse(row.data_json).confirmedBy, "agent-list");
  });

  it("with no lsof anywhere, keeps the directory and reports red while an agent cwd is inside it", async (t) => {
    t.after(() => { resetMissingCwdForTests(); resetTmpCleanupForTests(); });
    const c = card("done", T0);
    const p = mk(c.code);
    const other = { id: "agent-other", cwd: join(p, "work"), provider: "x", title: "t", archived: false, lastActivityAt: null, labels: {} };
    setMissingCwdHooks({ listAgents: () => [other] });
    setLsofFallbacks([]);
    const bare = join(root, "bare-path");
    mkdirSync(bare);
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await withPath([bare], () => cleanTmpDirs({ now, roots: [root] }))).length, 0);
    assert.equal(existsSync(p), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("an agent is still in use")));
    setMissingCwdHooks({ listAgents: () => [] });
    assert.equal((await withPath([bare], () => cleanTmpDirs({ now: new Date(now.getTime() + 1000), roots: [root] }))).length, 1);
    assert.equal(existsSync(p), false);
    assert.equal(openProblems().some((item) => item.path === p), false);
  });

  it("with no lsof anywhere, still keeps the directory when the agent list cannot be read", async (t) => {
    t.after(() => { resetMissingCwdForTests(); resetTmpCleanupForTests(); });
    const c = card("done", T0);
    const p = mk(c.code);
    setMissingCwdHooks({ listAgents: () => null });
    setLsofFallbacks([]);
    const bare = join(root, "bare-path");
    mkdirSync(bare);
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await withPath([bare], () => cleanTmpDirs({ now, roots: [root] }))).length, 0);
    assert.equal(existsSync(p), true);
    assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("agent list could not be read")));
  });

  it("does not delete evidence or a card directory stored inside it", async () => {
    const c = card("done", T0);
    const beside = join(root, ".local-evidence");
    mkdirSync(beside);
    writeFileSync(join(beside, "keep.txt"), "keep");
    const p = mk(c.code);
    const now = new Date(T0.getTime() + 48 * HOUR);
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 1);
    assert.equal(existsSync(p), false);
    assert.equal(existsSync(join(beside, "keep.txt")), true);
    const buried = card("done", T0);
    const evidence = join(root, ".local-evidence");
    const inside = join(evidence, buried.code);
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, "keep.txt"), "keep");
    assert.equal((await cleanTmpDirs({ now, roots: [evidence] })).length, 0);
    assert.equal(existsSync(join(inside, "keep.txt")), true);
  });

  it("cleans a card that finishes while a round is still running", { timeout: 30_000 }, async (t) => {
    const first = card("done", T0);
    const p1 = mk(first.code);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const original = fsPromises.rm;
    let calls = 0;
    const mocked = mock.method(fsPromises, "rm", async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await released;
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const now = new Date(T0.getTime() + 48 * HOUR);
    scheduleTmpCleanup({ now, roots: [root] });
    await started;
    const second = card("done", T0);
    const p2 = mk(second.code);
    scheduleTmpCleanup({ now, roots: [root] });
    release();
    await flushTmpCleanup();
    assert.equal(existsSync(p1), false);
    assert.equal(existsSync(p2), false);
  });

  it("deletes a finished directory with more than a million nodes", { timeout: 600_000 }, async (t) => {
    const base = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cleanup-million");
    rmSync(base, { recursive: true, force: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const c = card("done", T0);
    const p = join(base, c.code);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "kanban.db"), "x");
    const filesPerDir = 1000;
    const dirCount = 1000;
    for (let bucket = 0; bucket < dirCount; bucket += 1) {
      const sub = join(p, `n${bucket}`);
      mkdirSync(sub);
      for (let i = 0; i < filesPerDir; i += 1) closeSync(openSync(join(sub, String(i)), "w"));
    }
    const nodes = 1 + dirCount + dirCount * filesPerDir + 1;
    assert.ok(nodes > 1_000_000);
    try {
      const out = await cleanTmpDirs({ now: T0, roots: [base] });
      assert.equal(out.length, 1);
      assert.equal(existsSync(p), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  describe("keeps directories it must not delete", () => {
    const later = new Date(T0.getTime() + 48 * HOUR);
    beforeEach(() => resetMissingCwdForTests());
    after(() => resetMissingCwdForTests());

    it("skips a directory owned by another user", async () => {
      const c = card("done", T0);
      const p = mk(c.code);
      const me = process.getuid?.() ?? 0;
      assert.equal((await cleanTmpDirs({ now: later, roots: [root], ownerUid: me + 1 })).length, 0);
      assert.equal(existsSync(p), true);
      assert.equal((await cleanTmpDirs({ now: later, roots: [root], ownerUid: me })).length, 1);
    });

    it("skips a git directory with unpushed commits", async () => {
      const dirty = card("done", T0);
      const p = mk(dirty.code);
      const git = (...args: string[]) => execFileSync("git", ["-C", p, "-c", "user.email=a@b", "-c", "user.name=t", ...args], { stdio: "ignore" });
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "wip");
      assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 0);
      assert.equal(existsSync(p), true);
    });

    it("keeps a card directory that is itself a git repository", async () => {
      const published = card("done", T0);
      const p = mk(published.code);
      const git = (...args: string[]) => execFileSync("git", ["-C", p, "-c", "user.email=a@b", "-c", "user.name=t", ...args], { stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-qm", "base");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 0);
      assert.equal(existsSync(p), true);
      const nested = card("done", T0);
      const n = mk(nested.code);
      mkdirSync(join(n, "inner"));
      execFileSync("git", ["init", "-q", "-b", "main", join(n, "inner")], { stdio: "ignore" });
      assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 1);
      assert.equal(existsSync(n), false);
      assert.equal(existsSync(p), true);
    });

    it("skips a directory an agent still has as its cwd", async () => {
      const c = card("done", T0);
      const p = mk(c.code);
      setMissingCwdHooks({
        listAgents: () => [{ id: "a1", cwd: join(p, "sub"), provider: "x", title: "t", archived: false, lastActivityAt: null, labels: {} }],
      });
      assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 0);
      assert.equal(existsSync(p), true);
      setMissingCwdHooks({ listAgents: () => [] });
      assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 1);
    });

    it("skips everything when the agent list cannot be read", async () => {
      const c = card("done", T0);
      const p = mk(c.code);
      setMissingCwdHooks({ listAgents: () => null });
      assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 0);
      assert.equal(existsSync(p), true);
      assert.ok(openProblems().some((item) => item.path === p && item.reason.includes("agent list")));
    });

    it("skips a git directory whose only unpushed commit is on a detached HEAD", async () => {
      const c = card("done", T0);
      const p = mk(c.code);
      const git = (...args: string[]) => execFileSync("git", ["-C", p, "-c", "user.email=a@b", "-c", "user.name=t", ...args], { stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-qm", "base");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("checkout", "-q", "--detach");
      writeFileSync(join(p, "only.txt"), "only here");
      git("add", "-A");
      git("commit", "-qm", "detached only");
      assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 0);
      assert.equal(existsSync(p), true);
    });

    it("matches an agent cwd through /tmp and /private/tmp aliases and symlinks", async () => {
      const c = card("done", T0);
      const alias = mkdtempSync(join(tmpdir(), "tmpclean-alias-"));
      madeDirs.push(alias);
      const p = join(alias, c.code);
      mkdirSync(p);
      writeFileSync(join(p, "kanban.db"), "x");
      const real = realpathSync(p);
      const link = join(root, "link-to-card");
      symlinkSync(p, link);
      for (const cwd of [real, join(link, "sub")]) {
        setMissingCwdHooks({ listAgents: () => [{ id: "a1", cwd, provider: "x", title: "t", archived: false, lastActivityAt: null, labels: {} }] });
        assert.equal((await cleanTmpDirs({ now: later, roots: [alias] })).length, 0, cwd);
        assert.equal(existsSync(p), true);
      }
    });
  });
});
