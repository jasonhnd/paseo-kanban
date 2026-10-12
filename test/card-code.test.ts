/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parentIdsFromArgs } from "../server/argv";
import { cardMark, lookupCard, resolveTaskId } from "../server/card-ref";
import { runKanban } from "../server/cli";
import { ConfigFileError, projectCode, setProjectCode } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { createTask, getTask } from "../server/store";
import { formatResult } from "../server/tools";
import { formatCardCode } from "../shared/card-code";
import { seedFixtureProjects } from "./helpers/seed-projects";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "card-code-"));
process.env.KANBAN_DATA_DIR = dir;
seedFixtureProjects(dir);

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const supervisorEnv = { PASEO_AGENT_ID: "" };

describe("project card codes", () => {
  it("formats four digits and grows past 9999", () => {
    assert.equal(formatCardCode("DEMO", 1), "DEMO_0001");
    assert.equal(formatCardCode("DEMO", 31), "DEMO_0031");
    assert.equal(formatCardCode("TEST", 9999), "TEST_9999");
    assert.equal(formatCardCode("TEST", 10000), "TEST_10000");
  });

  it("writes the known codes, including demo_portal before it has a card", () => {
    getDb();
    assert.equal(projectCode("demo_library"), "DEMO");
    assert.equal(projectCode("demo_board"), "TEST");
    assert.equal(projectCode("demo_fleet"), "EX");
    assert.equal(projectCode("demo.example.com"), "TEST9");
    assert.equal(projectCode("demo_tasks"), "XYZ");
    assert.equal(projectCode("demo_web"), "DEMO2");
    assert.equal(projectCode("demo_portal"), "TEST2");
    assert.equal(projectCode("demo_test3"), "EX2");
    assert.equal(projectCode("demo_sandbox"), "ABC2");
    assert.equal(projectCode("demo_quota"), "XYZ2");
  });

  it("numbers new cards inside each project", () => {
    const first = createTask({ project: "demo_tasks", title: "First card", role: "executor" });
    const other = createTask({ project: "demo_web", title: "Another project", role: "executor" });
    const second = createTask({ project: "demo_tasks", title: "Second card", role: "executor" });
    assert.equal(first.code_seq, 1);
    assert.equal(other.code_seq, 1);
    assert.equal(second.code_seq, 2);
    assert.equal(cardMark(first.id), "XYZ_0001");
    assert.equal(cardMark(other.id), "DEMO2_0001");
    assert.equal(cardMark(second.id), "XYZ_0002");
    assert.equal(formatResult(second), `XYZ_0002 ${second.title}\n${zhCN("tools.result.status", { status: zhCN("labels.status.ready") })}\n${zhCN("tools.result.project", { project: "demo_tasks" })}`);
  });

  it("lookupCard finds archived and other-project cards and explains a missing one instead of throwing", () => {
    const old = createTask({ project: "demo_tasks", title: "archived", role: "executor" });
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(old.id);
    assert.deepEqual(lookupCard(cardMark(old.id)), { id: old.id, message: null });
    const missing = lookupCard("XYZ_9999");
    assert.equal(missing.id, null);
    assert.ok(missing.message);
    assert.equal(lookupCard("TEST4_0001").id, null);
  });

  it("finds one card by display code or the old global id", () => {
    const task = createTask({ project: "demo_library", title: "Two references", role: "executor" });
    const mark = cardMark(task.id);
    assert.equal(mark, "DEMO_0001");
    assert.equal(resolveTaskId(mark), task.id);
    assert.equal(resolveTaskId(mark.toLowerCase()), task.id);
    assert.equal(resolveTaskId("demo_1"), task.id);
    assert.equal(resolveTaskId(`#${mark}`), task.id);
    assert.equal(resolveTaskId(task.id), task.id);
    assert.equal(resolveTaskId(String(task.id)), task.id);
    assert.equal(resolveTaskId(`#${task.id}`), task.id);
    assert.deepEqual(parentIdsFromArgs([mark.toLowerCase(), `#${task.id}`]), [task.id, task.id]);
  });

  it("rejects a duplicate short code and keeps the sequence when the code changes", () => {
    const task = createTask({ project: "demo_portal", title: "Portal", role: "executor" });
    assert.equal(task.code_seq, 1);
    assert.equal(cardMark(task.id), "TEST2_0001");
    assert.throws(() => setProjectCode("demo_tasks", "TEST2"), new RegExp(zhCN("config.codeTaken", {"code":"TEST2","project":"demo_portal"})));
    setProjectCode("demo_portal", "demo3");
    assert.equal(getTask(task.id).code_seq, 1);
    assert.equal(cardMark(task.id), "DEMO3_0001");
    assert.equal(resolveTaskId("demo3_0001"), task.id);
    assert.throws(() => resolveTaskId("TEST2_0001"), new RegExp(zhCN("cardRef.error.noCode", {"code":"TEST2"})));
  });

  it("shows a derived code without storing it, refuses an ambiguous one, and falls back to #id on a taken code (TEST_0273)", () => {
    const path = join(process.env.KANBAN_DATA_DIR ?? "", "kanban.config.json");
    const before = readFileSync(path);
    const one = createTask({ project: "abc-one", title: "sample", role: "executor" });
    const two = createTask({ project: "abc-two", title: "sample", role: "executor" });
    assert.equal(projectCode("abc-one"), null);
    assert.equal(projectCode("abc-two"), null);
    assert.deepEqual(readFileSync(path), before, "nothing is written back");
    assert.equal(cardMark(one.id), "ABC_0001");
    assert.equal(cardMark(two.id), "ABC_0001");
    assert.throws(() => resolveTaskId("ABC_0001"), new RegExp(localePattern(zhCNPart("cardRef.error.codeAmbiguousDerived", 10, 23)) + "abc-one、abc-two"));
    setProjectCode("abc-two", "ABC");
    assert.equal(cardMark(two.id), "ABC_0001");
    assert.equal(resolveTaskId("ABC_0001"), two.id);
    assert.equal(cardMark(one.id), `#${one.id}`, "ABC now belongs to abc-two");
    assert.equal(resolveTaskId(`#${one.id}`), one.id);
    assert.equal(getTask(one.id).code_seq, 1);
  });

  it("assigns contiguous sequences on a copied library", () => {
    const src = mkdtempSync(join(tmp, "card-src-"));
    const dest = mkdtempSync(join(tmp, "card-dst-"));
    const prev = process.env.KANBAN_DATA_DIR;
    closeDb();
    try {
      process.env.KANBAN_DATA_DIR = src;
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO tasks (project, title, role, status, created_at, updated_at, code_seq) VALUES (?, ?, 'executor', 'ready', ?, ?, NULL)`,
      );
      const stamp = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-02T00:00:00.000Z";
      insert.run("beta", "b-late", later, later);
      insert.run("alpha", "a-first", stamp, stamp);
      insert.run("alpha", "a-same-time", stamp, stamp);
      insert.run("beta", "b-early", stamp, stamp);
      insert.run("alpha", "a-last", later, later);
      db.exec("PRAGMA wal_checkpoint(FULL)");
      closeDb();
      copyFileSync(join(src, "kanban.db"), join(dest, "kanban.db"));
      process.env.KANBAN_DATA_DIR = dest;
      const migrated = getDb();
      const rows = migrated
        .prepare("SELECT id, project, title, code_seq FROM tasks ORDER BY project, code_seq")
        .all() as unknown as Array<{ id: number; project: string; title: string; code_seq: number }>;
      const alpha = rows.filter((row) => row.project === "alpha");
      const beta = rows.filter((row) => row.project === "beta");
      assert.deepEqual(
        alpha.map((row) => row.title),
        ["a-first", "a-same-time", "a-last"],
      );
      assert.deepEqual(
        alpha.map((row) => row.code_seq),
        [1, 2, 3],
      );
      assert.deepEqual(
        beta.map((row) => row.title),
        ["b-early", "b-late"],
      );
      assert.deepEqual(
        beta.map((row) => row.code_seq),
        [1, 2],
      );
      const dupes = migrated
        .prepare("SELECT project, code_seq, COUNT(*) AS n FROM tasks GROUP BY project, code_seq HAVING n > 1")
        .all() as unknown as unknown[];
      assert.deepEqual(dupes, []);
      // A library with cards and no config file is a board whose config was lost: no file is generated (TEST_0273).
      assert.equal(existsSync(join(dest, "kanban.config.json")), false);
      assert.throws(() => projectCode("alpha"), ConfigFileError);
    } finally {
      closeDb();
      process.env.KANBAN_DATA_DIR = prev;
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
      getDb();
    }
  });

  it("changes a code from the command line and still shows the old id", async () => {
    const task = createTask({ project: "demo_test3", title: "Chat", role: "executor" });
    const changed = (await runKanban(["project", "--project", "demo_test3", "--code", "test3"], supervisorEnv)) as { text: string };
    assert.match(changed.text, new RegExp((zhCN("settings.projects.code") + " ") + "TEST3"));
    assert.equal(getTask(task.id).code_seq, 1);
    const byCode = (await runKanban(["show", "test3_1"], supervisorEnv)) as { task: { id: number; code: string } };
    const byId = (await runKanban(["show", `#${task.id}`], supervisorEnv)) as { task: { id: number; code: string } };
    assert.equal(byCode.task.id, task.id);
    assert.equal(byCode.task.code, "TEST3_0001");
    assert.equal(byId.task.id, task.id);
    assert.equal(byId.task.code, "TEST3_0001");
    await assert.rejects(() => runKanban(["project", "--project", "demo_tasks", "--code", "TEST3"], supervisorEnv), new RegExp(localePattern(zhCNPart("config.codeTaken", 10, 15)) + "demo_test3 " + localePattern(zhCNPart("settings.projects.alwaysTemp", 2, 4))));
  });
});
