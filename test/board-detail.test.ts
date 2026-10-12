/// <reference types="node" />
import { zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { readBoardTab, saveBoardTab } from "../server/panel-prefs";
import { projectRows } from "../server/project-rows";
import { appendEvent, createTask, getDetail, listBoard } from "../server/store";
import { loadConfig } from "../server/config";
import { taskDetailSchema, boardRpc } from "../shared/rpc";

const dir = mkdtempSync(join(tmpdir(), "board-detail-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

function setStatus(id: number, status: string) {
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
}

describe("card detail for the drawer", () => {
  it("returns the latest review verdict and a PR with its latest check", () => {
    const task = createTask({ project: "detail", title: "yes PR", role: "executor", workspacePath: dir, brief: "## demo fixture" });
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(JSON.stringify({ kind: "github", repo: "o/r", pr: "https://github.com/o/r/pull/7", awaiting: true }), task.id);
    appendEvent(task.id, "request_changes", "reviewing", "rework", "reviewer", { reason: "demo fixture Demo text", summary: "Reviewer demo fixture Demo text" });
    appendEvent(task.id, "approve", "reviewing", "acceptance", "reviewer", { summary: "Second round passed REVIEW-OK" });
    appendEvent(task.id, "pr_wait", null, "acceptance", "scheduler", { summary: "demo fixture Finished running" });
    const detail = getDetail(task.id);
    assert.equal(detail.review?.kind, "approve");
    assert.equal(detail.review?.summary, "Second round passed REVIEW-OK");
    assert.equal(detail.review?.actor, "reviewer");
    assert.deepEqual(detail.pr, {
      url: "https://github.com/o/r/pull/7", repo: "o/r", awaiting: true,
      check: { kind: "pr_wait", at: detail.pr!.check!.at, summary: "demo fixture Finished running" },
    });
    assert.equal(detail.reviewHold, null);
    assert.ok(taskDetailSchema.parse(JSON.parse(JSON.stringify(detail))));
  });

  it("has no review and no PR for a plain new card", () => {
    const task = createTask({ project: "detail", title: "Nothing available", role: "executor", workspacePath: dir });
    const detail = getDetail(task.id);
    assert.equal(detail.review, null);
    assert.equal(detail.pr, null);
  });

  it("marks a round-2 hold and hands the drawer the three-way ruling text", () => {
    const task = createTask({ project: "detail", title: "Second round", role: "executor", workspacePath: dir });
    setStatus(task.id, "rework");
    assert.equal(getDetail(task.id).task.leaderHold, false);
    appendEvent(task.id, "review_leader_hold", "reviewing", "rework", "reviewer", { lead: zhCNPart("reviewHold.lead.title", 0, 14), next: (zhCNPart("reviewHold.next.rework", 0, 23) + "X") });
    const detail = getDetail(task.id);
    assert.equal(detail.task.leaderHold, true);
    assert.equal(detail.reviewHold, (zhCNPart("reviewHold.next.rework", 0, 23) + "X"));
    appendEvent(task.id, "leader_rework", "rework", "rework", "supervisor", { reason: "Edit it" });
    assert.equal(getDetail(task.id).task.leaderHold, false);
  });

  it("flags a card tagged leader-unresponsive on the board list", () => {
    const task = createTask({ project: "detail", title: "Nobody accepting", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET tags = ? WHERE id = ?").run(JSON.stringify(["leader-unresponsive"]), task.id);
    const card = listBoard("detail").tasks.find((item) => item.id === task.id);
    assert.equal(card?.leaderUnresponsive, true);
    assert.equal(listBoard("detail").tasks.find((item) => item.title === "Nothing available")?.leaderUnresponsive, false);
  });
});

describe("project rows", () => {
  it("counts each bucket per project, ignoring archived cards, and names the leader", () => {
    mkdirSync(join(dir, "agents", "bucket"), { recursive: true });
    writeFileSync(join(dir, "agents", "bucket", "lead-1.json"), JSON.stringify({ id: "lead-1", title: "<leader> · rows", cwd: dir, labels: {}, archivedAt: null, lastStatus: "idle" }));
    const make = (status: string) => setStatus(createTask({ project: "rows", title: status, role: "executor", workspacePath: dir }).id, status);
    for (const status of ["running", "reviewing", "acceptance", "acceptance", "blocked", "waiting", "ready", "done", "archived"]) make(status);
    const row = projectRows({ ...loadConfig(), supervisors: { rows: "lead-1", quiet: "lead-2" } }).find((item) => item.project === "rows");
    assert.ok(row);
    assert.deepEqual([row.running, row.acceptance, row.blocked, row.waiting, row.done], [2, 2, 1, 2, 1]);
    assert.equal(row.leaderAgentId, "lead-1");
    assert.equal(row.leaderTitle, "<leader> · rows");
    assert.ok(row.lastLeaderActionAt, "cards created by the leader count as leader actions");
    const quiet = projectRows({ ...loadConfig(), supervisors: { rows: "lead-1", quiet: "lead-2" } }).find((item) => item.project === "quiet");
    assert.equal(quiet?.leaderAgentId, "lead-2");
    assert.deepEqual([quiet?.running, quiet?.acceptance], [0, 0]);
    assert.equal(quiet?.lastLeaderActionAt, null);
  });

  it("reports the newest event written by the project's leader", () => {
    const task = createTask({ project: "acting", title: "t", role: "executor", workspacePath: dir });
    appendEvent(task.id, "comment", null, null, "supervisor", {});
    appendEvent(task.id, "comment", null, null, "scheduler", {});
    const row = projectRows({ ...loadConfig(), supervisors: {} }).find((item) => item.project === "acting");
    assert.ok(row?.lastLeaderActionAt);
  });

  it("matches the board RPC output shape", () => {
    const row = projectRows({ ...loadConfig(), supervisors: {} })[0];
    const parsed = boardRpc.output.shape.projectRows.parse([row]);
    assert.equal(parsed.length, 1);
  });
});

describe("board tab preference", () => {
  const tabFile = join(dir, "kanban-board-tab.json");
  const shared = join(dir, "panel-prefs.json");

  it("defaults to the overview and ignores a bad value", async () => {
    assert.equal(await readBoardTab(tabFile), "overview");
    writeFileSync(tabFile, JSON.stringify({ boardTab: "nope" }));
    assert.equal(await readBoardTab(tabFile), "overview");
    writeFileSync(tabFile, "{ broken");
    assert.equal(await readBoardTab(tabFile), "overview");
  });

  it("saves into its own file and never touches the shared prefs file", async () => {
    writeFileSync(shared, JSON.stringify({ fontStep: "lg", colorMode: "dark" }));
    assert.equal(await saveBoardTab("attention", tabFile), "attention");
    assert.deepEqual(JSON.parse(readFileSync(tabFile, "utf8")), { boardTab: "attention" });
    assert.deepEqual(JSON.parse(readFileSync(shared, "utf8")), { fontStep: "lg", colorMode: "dark" });
    assert.equal(await readBoardTab(tabFile), "attention");
  });

  it("keeps the saved tab when the other app rewrites the shared file with only its own fields", async () => {
    await saveBoardTab("projects", tabFile);
    // EX replaces the whole shared file with { fontStep, colorMode, tab } on every tab or font change.
    writeFileSync(shared, JSON.stringify({ fontStep: "sm", colorMode: "light", tab: "quota" }));
    assert.equal(await readBoardTab(tabFile), "projects");
  });

  it("recovers from a broken tab file on the next save", async () => {
    writeFileSync(tabFile, "{ broken");
    assert.equal(await saveBoardTab("decisions", tabFile), "decisions");
    assert.equal(await readBoardTab(tabFile), "decisions");
  });

  it("lives beside panel-prefs.json, not inside it", async () => {
    const { boardTabPath, panelPrefsPath } = await import("../server/panel-prefs");
    assert.notEqual(boardTabPath(), panelPrefsPath());
    assert.equal(dirname(boardTabPath()), dirname(panelPrefsPath()));
  });
});
