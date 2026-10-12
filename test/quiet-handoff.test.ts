/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { applyFailure, classifyFailure } from "../server/failures";
import { applyNudge, settleQuietHandoff } from "../server/flow";
import { HANDOFF_TEXT_LIMIT, lastAssistantText, truncateHandoff } from "../server/nudge";
import { appendEvent, claimStatus, createTask, getTask } from "../server/store";
import { cardMark } from "../server/card-ref";
import { wipCommitMessage } from "../server/temp-workspace";

const dir = mkdtempSync(join(tmpdir(), "quiet-handoff-"));
const trees = join(dir, "worktrees");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_WORKTREES_ROOT = trees;
mkdirSync(trees, { recursive: true });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function running(title: string, role: string, status: "running" | "reviewing" = "running"): number {
  const task = createTask({ project: "quiet", title, role, workspacePath: dir });
  claimStatus(task.id, "ready", status, "test");
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(`agent-${title}`, task.id);
  return task.id;
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("quiet handoff text", () => {
  it("keeps the newest assistant message and cuts the rest", () => {
    const timeline = [
      { type: "assistant_message", text: "Written first" },
      { item: { type: "assistant_message", text: "  Written later  " } },
      { type: "user_message", text: "Later text does not count; user" },
      { type: "tool_call", name: "Bash", status: "completed" },
    ];
    assert.equal(lastAssistantText(timeline), "Written later");
    assert.equal(lastAssistantText([{ type: "user_message", text: (zhCNPart("taskLifecycle.error.notBlocked", 0, 2) + zhCN("labels.assigner.user")) }]), null);
    const long = zhCNPart("prefsControls.font.label", 0, 1).repeat(HANDOFF_TEXT_LIMIT + 20);
    const cut = truncateHandoff(long);
    assert.equal(cut.length, HANDOFF_TEXT_LIMIT + ("…" + zhCNPart("nudge.truncated", 7, 12)).length);
    assert.ok(cut.endsWith(("…" + zhCNPart("nudge.truncated", 7, 12))));
  });
});

describe("quiet handoff does not replace a real failure", () => {
  it("leaves quota, login, and crash cards on the failure path", () => {
    assert.equal(classifyFailure("quota exceeded, billing"), "quota");
    assert.equal(classifyFailure("Please run /login"), "credential");
    assert.equal(classifyFailure("worker crashed"), "other");
    const quota = running(zhCNPart("boardView.quota.headline", 1, 3), "executor");
    applyFailure(quota, "quota exceeded, billing", "quota");
    assert.equal(settleQuietHandoff(quota, { lastText: (zhCNPart("blocked.kind.quota", 0, 3) + zhCNPart("blocked.kind.capability", 3, 4)) }), "skip");
    assert.equal(getTask(quota).status, "ready");
    const login = running(zhCNPart("settings.thresholds.loginBlipRetryMs", 0, 2), "executor");
    applyFailure(login, "Not logged in", "credential");
    assert.equal(settleQuietHandoff(login, { lastText: "Not logged in" }), "skip");
    assert.equal(getTask(login).status, "blocked");
    const crash = running(zhCNPart("missingCwd.placeholder.intro", 44, 46), "executor");
    applyFailure(crash, "worker crashed", "other");
    assert.equal(settleQuietHandoff(crash, { lastText: "worker crashed" }), "skip");
    assert.notEqual(getTask(crash).status, "in_review");
    const autos = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'auto_complete'").get() as { n: number };
    assert.equal(autos.n, 0);
  });

  it("asks for a ruling instead of approving a quiet review", () => {
    const id = running(zhCN("labels.role.reviewer"), "executor", "reviewing");
    const start = Date.parse("2026-10-02T00:00:00.000Z");
    const gap = 10 * 60_000;
    const timeline = [{ type: "assistant_message", text: "Missing one test; no verdict" }];
    assert.equal(applyNudge(id, false, { nowMs: start, timeline }).action, "remind");
    assert.equal(applyNudge(id, false, { nowMs: start + gap - 1, timeline }).action, "none");
    assert.equal(applyNudge(id, false, { nowMs: start + gap, timeline }).action, "ruling");
    assert.equal(getTask(id).status, "reviewing");
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'review_ruling'").get(id) as { data_json: string };
    assert.equal(JSON.parse(row.data_json).lastMessage, "Missing one test; no verdict");
    const approved = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'approve'").get(id) as { n: number };
    assert.equal(approved.n, 0);
    assert.equal(applyNudge(id, false, { nowMs: start + 2 * gap, timeline }).action, "none");
    const again = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'review_ruling'").get(id) as { n: number };
    assert.equal(again.n, 1);
  });
});

describe("quiet handoff saves a dirty workspace before review", () => {
  function repoAt(name: string): string {
    const repo = join(dir, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "quiet@example.com"]);
    git(repo, ["config", "user.name", "Quiet"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    return repo;
  }

  /** A worktree the board opened for this card: under the worktrees root, on the card's own branch. */
  function ownedCopy(name: string, title: string): { repo: string; copy: string; branch: string; id: number } {
    const repo = repoAt(name);
    const task = createTask({ project: "quiet", title, role: "executor", workspacePath: repo });
    const branch = `kanban/${task.id}-wip`;
    const copy = join(trees, name);
    git(repo, ["worktree", "add", "-b", branch, copy, "main"]);
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_path = ? WHERE id = ?").run(copy, task.id);
    appendEvent(task.id, "worktree_created", null, null, "test", { directory: copy, branch, base: "main", root: repo, temp: true });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(`agent-${name}`, task.id);
    return { repo, copy, branch, id: task.id };
  }

  function handOff(id: number, at: string, text: string): void {
    const start = Date.parse(at);
    assert.equal(applyNudge(id, false, { nowMs: start }).action, "remind");
    assert.equal(applyNudge(id, false, { nowMs: start + 10 * 60_000, timeline: [{ type: "assistant_message", text }] }).action, "handoff");
    assert.equal(getTask(id).status, "in_review");
  }

  function autoData(id: number): { wipCommitted?: boolean; wipError?: string | null; wipSkipped?: string | null; lastMessage?: string } {
    return JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'auto_complete'").get(id) as { data_json: string }).data_json,
    );
  }

  it("commits the board's own temporary worktree on the card branch, and nothing outside it", () => {
    const { repo, copy, branch, id } = ownedCopy("owned", "Dirty workspace");
    writeFileSync(join(copy, "dirty.txt"), "saved\n");
    writeFileSync(join(repo, "outside.txt"), "leave me\n");
    handOff(id, "2026-10-02T01:00:00.000Z", (zhCNPart("readonlyWorktree.leftovers.sentence", 13, 16) + "dirty.txt"));
    assert.equal(git(repo, ["log", "-1", "--format=%s", branch]).trim(), wipCommitMessage(id));
    assert.match(git(repo, ["show", "--name-only", "--format=", branch]), /dirty\.txt/);
    assert.equal(git(repo, ["log", "-1", "--format=%s", "main"]).trim(), "base");
    assert.equal(git(repo, ["status", "--porcelain", "--", "outside.txt"]).trim(), "?? outside.txt");
    const data = autoData(id);
    assert.equal(data.wipCommitted, true);
    assert.equal(data.wipSkipped ?? null, null);
  });

  it("never commits a main-directory card when its agent dies, and records why", () => {
    const repo = repoAt("main-dir");
    writeFileSync(join(repo, "base.txt"), "user edit in progress\n");
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    const task = createTask({ project: "quiet", title: "Sample text", role: "executor", workspacePath: repo });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-main-dir", task.id);
    handOff(task.id, "2026-10-02T01:30:00.000Z", ("Sample text" + zhCNPart("readonlyWorktree.leftovers.sentence", 12, 15)));
    assert.equal(git(repo, ["log", "-1", "--format=%s"]).trim(), "base");
    assert.equal(git(repo, ["rev-list", "--count", "HEAD"]).trim(), "1");
    assert.match(git(repo, ["status", "--porcelain"]), /\.env/);
    assert.match(git(repo, ["status", "--porcelain"]), /base\.txt/);
    const data = autoData(task.id);
    assert.equal(data.wipCommitted, false);
    assert.equal(data.wipError, null);
    assert.match(data.wipSkipped ?? "", new RegExp(localePattern(zhCNPart("tempWorkspace.wip.notGitRoot", 6, 10))));
  });

  for (const protectedName of ["main", "preview", "develop", "release"]) {
    it(`does not commit an owned worktree that is checked out on ${protectedName}`, () => {
      const { repo, copy, branch, id } = ownedCopy(`protected-${protectedName}`, `${zhCNPart("worktreeGc.pushed.protectedBranch", 7, 10)} ${protectedName}`);
      // Free main for the copy, the way an executor could move its checkout.
      git(repo, ["checkout", "-b", "side"]);
      git(copy, protectedName === "main" ? ["checkout", "main"] : ["checkout", "-b", protectedName]);
      writeFileSync(join(copy, "dirty.txt"), "not on a protected branch\n");
      const before = git(repo, ["rev-parse", protectedName]).trim();
      handOff(id, "2026-10-02T02:00:00.000Z", `${zhCNPart("worktreeGc.basis.inBase", 1, 3)}${protectedName} edited on`);
      assert.equal(git(repo, ["rev-parse", protectedName]).trim(), before);
      assert.equal(git(repo, ["log", "-1", "--format=%s", branch]).trim(), "base");
      assert.match(git(copy, ["status", "--porcelain"]), /dirty\.txt/);
      const data = autoData(id);
      assert.equal(data.wipCommitted, false);
      assert.match(data.wipSkipped ?? "", new RegExp(protectedName));
    });
  }

  for (const foreign of ["docs/team-notes", "kanban/99999-other-card"]) {
    it(`does not commit an owned worktree checked out on ${foreign}, a branch this card did not create`, () => {
      const name = `foreign-${foreign.replace(/\W+/g, "-")}`;
      const { repo, copy, branch, id } = ownedCopy(name, `${zhCNPart("tempLand.refuse.mainOnOtherBranch", 27, 30)}${zhCNPart("labels.workspace.branch", 0, 3)}${foreign}`);
      git(repo, ["branch", foreign, "main"]);
      const before = git(repo, ["rev-parse", foreign]).trim();
      git(copy, ["checkout", foreign]);
      writeFileSync(join(copy, "dirty.txt"), "must not land on someone else's branch\n");
      handOff(id, "2026-10-02T02:15:00.000Z", `${zhCNPart("worktreeGc.basis.inBase", 1, 3)}${foreign} edited on`);
      assert.equal(git(repo, ["rev-parse", foreign]).trim(), before);
      assert.equal(git(repo, ["log", "-1", "--format=%s", branch]).trim(), "base");
      assert.match(git(copy, ["status", "--porcelain"]), /dirty\.txt/);
      const data = autoData(id);
      assert.equal(data.wipCommitted, false);
      assert.equal(data.wipError, null);
      assert.match(data.wipSkipped ?? "", new RegExp(localePattern(zhCNPart("tempWorkspace.wip.foreignBranch", 15, 23))));
    });
  }

  it("still commits a detached HEAD in an owned worktree without moving any named branch", () => {
    const { repo, copy, branch, id } = ownedCopy("detached", "detached");
    const main = git(repo, ["rev-parse", "main"]).trim();
    git(copy, ["checkout", "--detach"]);
    writeFileSync(join(copy, "dirty.txt"), "saved on HEAD\n");
    handOff(id, "2026-10-02T02:20:00.000Z", "detached edited on");
    assert.equal(git(copy, ["log", "-1", "--format=%s", "HEAD"]).trim(), wipCommitMessage(id));
    assert.equal(git(repo, ["rev-parse", "main"]).trim(), main);
    assert.equal(git(repo, ["log", "-1", "--format=%s", branch]).trim(), "base");
    assert.equal(autoData(id).wipCommitted, true);
  });

  it("does not commit a read-only copy", () => {
    const repo = repoAt("readonly");
    const task = createTask({ project: "quiet", title: "demo fixture", role: "executor", workspacePath: repo });
    const branch = `kanban-readonly/${cardMark(task.id)}`;
    const copy = join(trees, "readonly");
    git(repo, ["worktree", "add", "-b", branch, copy, "main"]);
    const head = git(repo, ["rev-parse", "main"]).trim();
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_path = ? WHERE id = ?").run(copy, task.id);
    appendEvent(task.id, "worktree_created", null, null, "test", { directory: copy, branch, base: "main", root: repo, temp: true, readOnly: true, head });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-readonly", task.id);
    writeFileSync(join(copy, "dirty.txt"), "read-only\n");
    handOff(task.id, "2026-10-02T02:30:00.000Z", zhCNPart("readonlyWorktree.leftovers.sentence", 8, 15));
    assert.equal(git(repo, ["rev-parse", branch]).trim(), head);
    const data = autoData(task.id);
    assert.equal(data.wipCommitted, false);
    assert.match(data.wipSkipped ?? "", new RegExp(localePattern(zhCNPart("readonlyWorktree.branch.unreadable", 3, 5))));
  });

  it("hands off a clean tree without committing", () => {
    const { repo, branch, id } = ownedCopy("clean-repo", (zhCNPart("doctor.land.waitingSuggestion", 4, 6) + zhCNPart("cardParts.event.worktreeCreated", 2, 5)));
    const evidencePr = "https://github.com/other/project/pull/264";
    handOff(id, "2026-10-02T03:00:00.000Z", `Evidence ${evidencePr}`);
    assert.equal(git(repo, ["log", "-1", "--format=%s", branch]).trim(), "base");
    const data = autoData(id) as ReturnType<typeof autoData> & { ignoredPr?: Array<{ url: string; reason: string }> };
    assert.equal(data.wipCommitted, false);
    assert.equal(data.wipError, null);
    assert.equal(JSON.parse(getTask(id).contract_json!).pr, null);
    assert.deepEqual(data.ignoredPr, [{ url: evidencePr, reason: "project_repository_unknown_or_no_origin" }]);
  });

  it("still hands off when the owned copy is no longer a git worktree", () => {
    const repo = repoAt("not-git-root");
    const task = createTask({ project: "quiet", title: "Not a repository", role: "executor", workspacePath: repo });
    const place = join(trees, "not-git");
    mkdirSync(place, { recursive: true });
    writeFileSync(join(place, "note.txt"), "leave me uncommitted\n");
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_path = ? WHERE id = ?").run(place, task.id);
    appendEvent(task.id, "worktree_created", null, null, "test", { directory: place, branch: `kanban/${task.id}-x`, base: "main", root: repo, temp: true });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-nogit", task.id);
    handOff(task.id, "2026-10-02T04:00:00.000Z", "Written note.txt");
    assert.equal(git(repo, ["log", "-1", "--format=%s"]).trim(), "base");
    assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
    const data = autoData(task.id);
    assert.equal(data.wipCommitted, false);
    assert.ok(data.wipError || data.wipSkipped, "a copy that is not its own git top level is not committed");
    assert.equal(data.lastMessage, "Written note.txt");
  });
});
