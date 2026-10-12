/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { completeTask } from "../server/flow";
import { claimStatus, createTask, getTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "kanban-complete-workspace-"));
process.env.KANBAN_DATA_DIR = join(dir, "data");
after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function repo(name: string): string {
  const path = join(dir, name);
  mkdirSync(path);
  git(path, ["init"]);
  writeFileSync(join(path, "tracked.txt"), "initial\n");
  git(path, ["add", "tracked.txt"]);
  git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  return path;
}

function git(path: string, args: string[]): void {
  execFileSync("git", args, { cwd: path, stdio: "pipe" });
}

async function complete(path: string | null, role = "executor") {
  const task = createTask({ project: "sandbox", title: "workspace handoff", role });
  getDb().prepare("UPDATE tasks SET workspace_path = ? WHERE id = ?").run(path, task.id);
  claimStatus(task.id, "ready", "running", "test");
  const handoff = { files: ["tracked.txt"], verification: "passed", risks: [], pr: "https://github.com/example/repo/pull/1" };
  const result = await completeTask(task.id, role, zhCN("labels.status.done"), handoff);
  const stored = JSON.parse(getTask(task.id).handoff_json!);
  assert.deepEqual(stored.handoff, handoff);
  assert.equal(result.status, role === "executor" ? "in_review" : "acceptance");
  return stored;
}

it("warns in the persisted handoff about untracked files without blocking executor complete", async () => {
  const path = repo("untracked");
  writeFileSync(join(path, "verification.tmp"), "temporary evidence");
  const stored = await complete(path);
  assert.match(stored.summary, new RegExp(localePattern(zhCNPart("flow.workspace.warning", 0, 5))));
  assert.match(stored.summary, /\?\? verification\.tmp/);
});

it("includes staged and unstaged changes, limits the list, and warns for batch too", async () => {
  const path = repo("modified");
  writeFileSync(join(path, "tracked.txt"), "modified\n");
  writeFileSync(join(path, "staged.txt"), "staged\n");
  git(path, ["add", "staged.txt"]);
  for (let i = 0; i < 6; i++) writeFileSync(join(path, `untracked-${i}.tmp`), "temp");
  const stored = await complete(path, "batch");
  assert.match(stored.summary, /A  staged\.txt/);
  assert.match(stored.summary, / M tracked\.txt/);
  assert.match(stored.summary, /\?\? untracked-0\.tmp/);
  assert.match(stored.summary, new RegExp(localePattern(zhCNPart("doctor.wake.more", 0, 3)) + "3 " + localePattern(zhCNPart("board.intake.projectPlaceholder", 0, 1))));
  assert.doesNotMatch(stored.summary, /untracked-3\.tmp/);
});

it("leaves clean handoffs unchanged and does not block missing or non-git directories", async () => {
  const nonGit = join(dir, "non-git");
  mkdirSync(nonGit);
  for (const path of [repo("clean"), null, join(dir, "missing"), nonGit]) {
    assert.equal((await complete(path)).summary, zhCN("labels.status.done"));
  }
});
