/// <reference types="node" />
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import fsPromises from "node:fs/promises";
import fs from "node:fs";
import childProcess from "node:child_process";
import { join } from "node:path";
import { after, beforeEach, describe, it, mock, type TestContext } from "node:test";
import { closeDb, getDb } from "../server/db";
import { execFileSync } from "node:child_process";
import { resetMissingCwdForTests, setMissingCwdHooks } from "../server/missing-cwd";
import { cleanTmpDirs, flushTmpCleanup, resetTmpCleanupForTests, scheduleTmpCleanup, tmpNamesFor } from "../server/tmp-cleanup";
import { cardMark } from "../server/card-ref";
import { cardTmpEnv } from "../server/card-tmp";
import { createTask } from "../server/store";

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

  it("deletes dirs of a card done 24 hours ago and records tmp_cleaned", async () => {
    const c = card("done", T0);
    const paths = [mk(c.code), mk(c.code.toLowerCase().replace("_", "-")), mk(c.code.toLowerCase().replace("_", ""))];
    const out = await cleanTmpDirs({ now: new Date(T0.getTime() + 24 * HOUR), roots: [root] });
    assert.equal(out.length, 3);
    for (const p of paths) assert.equal(existsSync(p), false);
    assert.equal(events(c.id).length, 3);
    assert.ok(out.every((o) => o.bytes >= 2048));
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
    assert.equal((await cleanTmpDirs({ now: new Date(T0.getTime() + 101 * HOUR), roots: [root] })).length, 0);
    assert.equal(existsSync(p), true);
    assert.equal((await cleanTmpDirs({ now: new Date(T0.getTime() + 124 * HOUR), roots: [root] })).length, 1);
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
    await cleanTmpDirs({ now: new Date(T0.getTime() + 25 * HOUR), roots: [root] });
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

  it("keeps new activity in an existing nested file while du is waiting", { timeout: 30_000 }, async (t) => {
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
    assert.equal((await cleaning).length, 0);
    assert.equal(existsSync(file), true);
    assert.deepEqual(events(c.id), []);
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
    assert.equal((await cleanTmpDirs({ now, roots: [root] })).length, 1);
    assert.equal(existsSync(retired), false);
    assert.equal(existsSync(join(p, "new-run.txt")), true);
    assert.equal(events(c.id).length, 1);
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

  it("keeps dirs under 24 hours, running cards and unknown names", async () => {
    const fresh = card("done", T0);
    const live = card("running", null);
    const p1 = mk(fresh.code);
    const p2 = mk(live.code);
    const p3 = mk("TEST_9999");
    const p4 = mk("other-program");
    const p5 = mk(`${fresh.code}-extra`);
    const out = await cleanTmpDirs({ now: new Date(T0.getTime() + 23 * HOUR), roots: [root] });
    assert.equal(out.length, 0);
    const later = await cleanTmpDirs({ now: new Date(T0.getTime() + 100 * HOUR), roots: [root] });
    assert.equal(later.length, 1);
    for (const p of [p2, p3, p4, p5]) assert.equal(existsSync(p), true);
    assert.equal(existsSync(p1), false);
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

  it("scheduler hook is throttled and does not block", async () => {
    const c = card("done", T0);
    const p = mk(c.code);
    const now = new Date(T0.getTime() + 48 * HOUR);
    scheduleTmpCleanup({ now, roots: [root] });
    await flushTmpCleanup();
    assert.equal(existsSync(p), false);
    const again = mk(c.code);
    scheduleTmpCleanup({ now: new Date(now.getTime() + 60_000), roots: [root] });
    await flushTmpCleanup();
    assert.equal(existsSync(again), true);
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

    it("skips a git directory with unpushed commits and deletes a clean one", async () => {
      const dirty = card("done", T0);
      const p = mk(dirty.code);
      const git = (...args: string[]) => execFileSync("git", ["-C", p, "-c", "user.email=a@b", "-c", "user.name=t", ...args], { stdio: "ignore" });
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "wip");
      assert.equal((await cleanTmpDirs({ now: later, roots: [root] })).length, 0);
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
