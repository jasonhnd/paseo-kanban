import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, beforeEach, it } from "node:test";
import { setLanguage } from "../shared/i18n";
import { cardSchema } from "../shared/rpc";
import { cardMark } from "../server/card-ref";
import { saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { KanbanError } from "../server/errors";
import { completeTask, settleQuietHandoff } from "../server/flow";
import { assertReviewStartAvailable, loadReviewAssignments } from "../server/review-assignment";
import { createTask, getTask, listBoard, getDetail, appendEvent, type TaskRow } from "../server/store";
import { formatResult, handleTool } from "../server/tools";
import { startTask } from "./helpers/compat-dispatch";
import { selectedReviewRoute } from "./helpers/selected-review";

const root = mkdtempSync(join(tmpdir(), "review-scheduling-"));
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_PASEO_CONFIG = join(root, "paseo.json");
process.env.KANBAN_TMP_ROOT = join(root, "cards");
const work = join(root, "work"); mkdirSync(work);
writeFileSync(process.env.KANBAN_PASEO_CONFIG, JSON.stringify({ daemon: { agentProfiles: [] } }));
const reviewer = { id: "review", name: "Independent reviewer", role: "reviewer", provider: "claude", family: "anthropic", model: "review-model" };
beforeEach(() => {
  setLanguage("en");
  saveConfig({ supervisorAgentId: null, supervisors: {}, autoStart: { demo: true }, projects: {
    demo: { code: "DEMO", defaultWorkspace: "dir", baseBranch: "main", alwaysTemp: false, lanesEnabled: false, worktreeLanes: 1 },
  }, concurrency: { global: 10, roles: { executor: 10, reviewer: 10 }, pools: {} } });
  getDb().prepare("UPDATE tasks SET status = 'archived'").run();
});
after(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

function working(role = "executor", provider = "codex"): TaskRow {
  const task = createTask({ project: "demo", title: "Delivery", role, workspacePath: work });
  getDb().prepare("UPDATE tasks SET status = 'running', executor_agent_id = 'worker', agent_id = 'worker' WHERE id = ?").run(task.id);
  getDb().prepare(`INSERT INTO runs(task_id, agent_id, role, profile_name, provider, model, started_at)
    VALUES (?, 'worker', ?, 'Worker', ?, 'work-model', ?)`).run(task.id, task.role, provider, new Date().toISOString());
  return getTask(task.id);
}
function delivered(automatic = false): TaskRow {
  const task = working(automatic ? "executor" : "batch");
  completeTask(task.id, automatic ? "executor" : "batch", "Delivered", { files: [], verification: "fixture", risks: [] });
  return getTask(task.id);
}
function linked(target: TaskRow, extra: Record<string, unknown> = {}) {
  return createTask({ project: "demo", title: "Review", role: "reviewer", workspacePath: work, reviewOf: target.id, ...extra });
}
function duplicateOf(id: number) {
  return (err: unknown) => err instanceof KanbanError && err.code === "conflict" && err.message.includes(cardMark(id));
}

it("shows an automatic review reservation in board, detail, RPC and plain/JSON leader list output", async () => {
  const task = delivered(true);
  const board = listBoard("demo").tasks.find(card => card.id === task.id)!;
  assert.match(board.reviewStatus!, /Review scheduled/);
  assert.ok(board.reviewStatus!.includes(cardMark(task.id)));
  assert.match(board.reviewStatus!, /automatic/);
  assert.equal(getDetail(task.id).task.reviewStatus, board.reviewStatus);
  assert.equal(cardSchema.parse(board).reviewStatus, board.reviewStatus);
  const list = await handleTool("kanban_list", { project: "demo" }, null, { role: "supervisor", taskId: null, agentId: null });
  assert.ok(formatResult(list).includes(board.reviewStatus!));
  assert.ok(JSON.stringify(list).includes(board.reviewStatus!));
  getDb().prepare("INSERT INTO runs(task_id, agent_id, role, profile_name, provider, model, started_at) VALUES (?, 'review-agent', 'reviewer', ?, 'claude', 'review-model', ?)")
    .run(task.id, reviewer.name, new Date().toISOString());
  getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'review-agent' WHERE id = ?").run(task.id);
  const running = getDetail(task.id).task.reviewStatus!;
  assert.match(running, /Review in progress/); assert.ok(running.includes(reviewer.name));
});

it("refuses linked duplicates of an automatic queued, running or blocked review before inserting anything", () => {
  for (const status of ["in_review", "reviewing", "blocked"]) {
    const task = delivered(true);
    getDb().prepare("UPDATE tasks SET status = ?, blocked_from = 'in_review' WHERE id = ?").run(status, task.id);
    const count = () => (getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    const before = count();
    assert.throws(() => linked(task), duplicateOf(task.id));
    assert.equal(count(), before);
  }
});

it("reserves every unfinished linked review state and displays its card and selected profile", () => {
  for (const status of ["draft", "triage", "waiting", "ready", "running", "in_review", "reviewing", "rework", "blocked"]) {
    const target = delivered();
    const review = linked(target, { profileOverride: reviewer.name });
    getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, review.id);
    assert.throws(() => linked(target), duplicateOf(review.id));
    assert.ok(getDetail(target.id).task.reviewStatus!.includes(cardMark(review.id)));
    assert.equal(loadReviewAssignments(target.id).get(target.id)?.length, 1);
  }
});

it("permits another review after a verdict, completion or archive and preserves idempotent create retries", () => {
  for (const status of ["acceptance", "done", "archived"]) {
    const target = delivered();
    const review = linked(target, { idempotencyKey: `review-${target.id}` });
    assert.equal(linked(target, { idempotencyKey: `review-${target.id}` }).id, review.id);
    getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, review.id);
    assert.notEqual(linked(target).id, review.id);
  }
});

it("does not infer a linked reservation from an independent review title", () => {
  const task = delivered(true);
  const review = createTask({ project: "demo", title: `Review ${cardMark(task.id)}`, role: "reviewer", workspacePath: work });
  assert.equal(review.review_of, null);
  assert.doesNotThrow(() => assertReviewStartAvailable(review, true));
});

it("refuses to launch a pre-existing duplicate and names the earlier owner", async () => {
  const target = delivered();
  const first = linked(target);
  const duplicate = createTask({ project: "demo", title: "Imported duplicate", role: "reviewer", workspacePath: work });
  getDb().prepare("UPDATE tasks SET review_of = ? WHERE id = ?").run(target.id, duplicate.id);
  let creates = 0;
  await assert.rejects(startTask(duplicate.id, { create: async () => { creates++; return { id: "unexpected" }; }, send: async () => {} }, "supervisor",
    { profiles: [reviewer], chosen: reviewer, routing: selectedReviewRoute([reviewer]) }), duplicateOf(first.id));
  assert.equal(creates, 0);
});

function submissionState(id: number) {
  return {
    task: getTask(id),
    runs: getDb().prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id").all(id),
    events: getDb().prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id").all(id),
    comments: getDb().prepare("SELECT * FROM comments WHERE task_id = ? ORDER BY id").all(id),
  };
}

it("refuses normal executor completion when a linked review was reserved first", () => {
  for (const status of ["ready", "reviewing", "blocked"]) {
    const target = working();
    const review = linked(target);
    getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, review.id);
    const before = submissionState(target.id);
    assert.throws(() => completeTask(target.id, "executor", "Delivered after review reservation", {
      files: [], verification: "fixture", risks: [],
    }), duplicateOf(review.id));
    assert.deepEqual(submissionState(target.id), before);
    assert.deepEqual(loadReviewAssignments(target.id).get(target.id)?.map(row => row.taskId), [review.id]);
    assert.ok(getDetail(target.id).task.reviewStatus!.includes(cardMark(review.id)));
  }
});

it("permits executor completion after the earlier linked review is archived", () => {
  const target = working();
  const review = linked(target);
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(review.id);
  assert.equal(completeTask(target.id, "executor", "Delivered", {}).status, "in_review");
  assert.deepEqual(loadReviewAssignments(target.id).get(target.id)?.map(row => row.taskId), [target.id]);
});

it("refuses Google batch completion when a linked review was reserved first", () => {
  const target = working("batch", "gemini");
  const review = linked(target);
  const before = submissionState(target.id);
  assert.throws(() => completeTask(target.id, "batch", "Delivered", {}), duplicateOf(review.id));
  assert.deepEqual(submissionState(target.id), before);
  assert.deepEqual(loadReviewAssignments(target.id).get(target.id)?.map(row => row.taskId), [review.id]);
});

it("skips quiet automatic completion and names the earlier linked review without changing the delivery", context => {
  const target = working();
  const review = linked(target);
  const before = submissionState(target.id);
  const logs: string[] = [];
  context.mock.method(console, "error", (...args: unknown[]) => logs.push(args.join(" ")));
  assert.equal(settleQuietHandoff(target.id, { lastText: "Finished without submitting" }), "skip");
  assert.ok(logs.some(line => line.includes(cardMark(review.id)) && line.includes("already assigned")));
  assert.deepEqual(submissionState(target.id), before);
  assert.deepEqual(loadReviewAssignments(target.id).get(target.id)?.map(row => row.taskId), [review.id]);
});

it("gives an earlier linked reservation priority over an imported duplicate automatic reservation", () => {
  const target = createTask({ project: "demo", title: "Working", role: "executor", workspacePath: work });
  const review = linked(target);
  getDb().prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(target.id);
  appendEvent(target.id, "complete", "running", "in_review", "executor");
  assert.throws(() => assertReviewStartAvailable(getTask(target.id), true), duplicateOf(review.id));
  assert.doesNotThrow(() => assertReviewStartAvailable(review, true));
});

it("serializes independent CLI-process reservations for one target", async () => {
  const target = delivered();
  const source = `import { createTask } from ${JSON.stringify(new URL("../server/store.ts", import.meta.url).href)};
    try { const row = createTask({ project: 'demo', title: 'Concurrent review', role: 'reviewer', reviewOf: Number(process.argv[1]) });
      console.log(JSON.stringify({ id: row.id })); }
    catch (err) { console.log(JSON.stringify({ code: err.code, message: err.message })); }`;
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const outputs = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source, String(target.id)], { env: { ...env, KANBAN_LANGUAGE: "en" }, timeout: 30_000 })));
  const results = outputs.map(out => JSON.parse(out.stdout.trim()));
  assert.equal(results.filter(row => row.id).length, 1);
  assert.equal(results.filter(row => row.code === "conflict").length, 1);
  assert.ok(results.find(row => row.code === "conflict").message.includes(cardMark(results.find(row => row.id).id)));
});

it("serializes executor completion against linked review creation in independent processes", async () => {
  const source = `import { createTask } from ${JSON.stringify(new URL("../server/store.ts", import.meta.url).href)};
    import { completeTask } from ${JSON.stringify(new URL("../server/flow.ts", import.meta.url).href)};
    try {
      const id = Number(process.argv[2]);
      const row = process.argv[1] === 'complete' ? completeTask(id, 'executor', 'Delivered', {})
        : createTask({ project: 'demo', title: 'Concurrent review', role: 'reviewer', reviewOf: id });
      console.log(JSON.stringify({ id: row.id }));
    } catch (err) { console.log(JSON.stringify({ code: err.code, message: err.message })); }`;
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  for (let attempt = 0; attempt < 3; attempt++) {
    const target = working();
    const outputs = await Promise.all(["complete", "create"].map(mode => promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source, mode, String(target.id)], { env: { ...env, KANBAN_LANGUAGE: "en" }, timeout: 30_000 })));
    const results = outputs.map(out => JSON.parse(out.stdout.trim()));
    assert.equal(results.filter(row => row.id).length, 1);
    assert.equal(results.filter(row => row.code === "conflict").length, 1);
    const owner = results.find(row => row.id).id;
    assert.ok(results.find(row => row.code === "conflict").message.includes(cardMark(owner)));
    assert.deepEqual(loadReviewAssignments(target.id).get(target.id)?.map(row => row.taskId), [owner]);
    assert.equal(getTask(target.id).status, owner === target.id ? "in_review" : "running");
  }
});


it("rechecks old competing reservations after an awaited model catalog read", async () => {
  const target = delivered();
  const older = createTask({ project: "demo", title: "Older imported review", role: "reviewer", workspacePath: work });
  const current = linked(target);
  let creates = 0;
  await assert.rejects(startTask(current.id, {
    create: async () => { creates++; return { id: "unexpected" }; }, send: async () => {},
    listModels: async () => {
      await Promise.resolve();
      getDb().prepare("UPDATE tasks SET review_of = ? WHERE id = ?").run(target.id, older.id);
      return { models: [{ id: reviewer.model, thinkingOptions: [{ id: "high" }] }] };
    },
  }, "supervisor", { profiles: [reviewer], chosen: reviewer, routing: selectedReviewRoute([reviewer]), effort: "high", effortSource: "matrix" }), duplicateOf(older.id));
  assert.equal(creates, 0);
});

it("names the existing card when review is triggered again by start or complete", async () => {
  const task = delivered(true);
  assert.throws(() => completeTask(task.id, "executor", "Duplicate handoff", {}), duplicateOf(task.id));
  getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
  await assert.rejects(startTask(task.id, { create: async () => { throw new Error("unexpected"); }, send: async () => {} }, "supervisor"), duplicateOf(task.id));
});
