/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cardMark as cardCode } from "../server/card-ref";
import { setWakeSender } from "../server/bus";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import type { ListedWorkspace } from "../server/placement";
import type { Profile } from "../server/profiles";
import { appendEvent, createTask, getTask } from "../server/store";
import { PLACEHOLDER_NAME } from "../server/missing-cwd";
import { readWorktreeCreated } from "../server/worktree-record";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "ws-recreate-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_WORKTREES_ROOT = join(dir, "paseo-worktrees");
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
setWakeSender(() => Promise.resolve());

const batch: Profile = { id: "bt", name: zhCN("labels.role.batch"), role: "batch", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
const reviewer: Profile = { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" };
const pick = { profiles: [batch], chosen: batch, reason: "Test" };
const pickReviewer = { profiles: [reviewer], chosen: reviewer, reason: "Test" };

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(name: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

interface Box extends AgentLauncher {
  cwds: string[];
  archived: string[];
  sent: string[];
  readOnlyTrees: boolean[];
  workspaces: ListedWorkspace[];
  failCreate: string | null;
}

/** A launcher that builds real git worktrees, like Paseo's branch-off, and remembers its workspace records. */
function launcher(root: string): Box {
  let n = 0;
  const box: Box = {
    cwds: [],
    archived: [],
    sent: [],
    readOnlyTrees: [],
    workspaces: [{ id: "main-ws", name: "main", directory: root, projectRoot: root, projectId: "prj", kind: "local_checkout", archived: false }],
    failCreate: null,
    async create(options) {
      box.cwds.push(options.cwd);
      return { id: `agent-${box.cwds.length}`, workspaceId: options.workspaceId };
    },
    async send(id) {
      box.sent.push(id);
    },
    async listWorkspaces() {
      return box.workspaces;
    },
    async createWorktree(options) {
      if (box.failCreate) throw new Error(box.failCreate);
      box.readOnlyTrees.push(options.readOnly === true);
      n += 1;
      const directory = join(dir, "trees", `${root.split("/").pop()}-${n}`);
      git(options.cwd, "worktree", "add", "-q", "-b", options.branchName, directory, options.baseBranch);
      const id = `ws-${root.split("/").pop()}-${n}`;
      box.workspaces.push({ id, name: options.title ?? null, directory, projectRoot: root, projectId: "prj", kind: "worktree", archived: false });
      return { directory, workspaceId: id, name: options.title ?? null };
    },
    async archiveWorkspace(id) {
      box.archived.push(id);
      box.workspaces = box.workspaces.map((entry) => (entry.id === id ? { ...entry, archived: true } : entry));
    },
  };
  return box;
}

/** Start a worktree card once, then put it back to ready with its directory deleted behind the board's back. */
async function lostCard(name: string, opts: { commit: boolean; dropBranch?: boolean; temp?: boolean }) {
  const root = repo(name);
  const box = launcher(root);
  const task = createTask({ project: name, title: "demo fixture", role: "batch", workspacePath: root });
  getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main' WHERE id = ?").run(task.id);
  await startTask(task.id, box, "test", pick);
  const first = readWorktreeCreated(task.id)!;
  if (opts.temp) appendEvent(task.id, "temp_workspace", null, null, "test", { name: "x", root, base: "main", directory: first.directory });
  if (opts.commit) {
    writeFileSync(join(first.directory!, "work.txt"), "kept\n");
    git(first.directory!, "add", "-A");
    git(first.directory!, "commit", "-q", "-m", "work");
  }
  const tip = git(root, "rev-parse", first.branch!);
  // Paseo's auto-archive-on-merge removes the directory and the workspace record.
  box.workspaces = box.workspaces.map((entry) => (entry.id === first.workspaceId ? { ...entry, archived: true } : entry));
  rmSync(first.directory!, { recursive: true, force: true });
  if (opts.dropBranch) {
    git(root, "worktree", "prune");
    git(root, "branch", "-D", first.branch!);
  }
  getDb().prepare("UPDATE tasks SET status = 'ready', agent_id = NULL WHERE id = ?").run(task.id);
  box.cwds.length = 0;
  return { root, box, task, first, tip };
}

function events(id: number, kind: string): Array<Record<string, unknown>> {
  return (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json));
}

describe("rebuilding a card's workspace whose directory is gone", () => {
  it("start rebuilds on the card branch and keeps its commits", async () => {
    const { box, task, first, tip, root } = await lostCard("branch-kept", { commit: true, temp: true });
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    const now = readWorktreeCreated(task.id)!;
    assert.notEqual(now.directory, first.directory);
    assert.equal(now.branch, first.branch);
    assert.equal(box.cwds[0], now.directory);
    assert.equal(readFileSync(join(now.directory!, "work.txt"), "utf8"), "kept\n");
    assert.equal(git(root, "rev-parse", first.branch!), tip);
    assert.equal(getTask(task.id).workspace_path, now.directory);
    const [recreated] = events(task.id, "temp_workspace_recreated");
    assert.equal(recreated.oldDirectory, first.directory);
    assert.equal(recreated.directory, now.directory);
    assert.equal(recreated.usedRef, "branch");
    assert.match(String(recreated.reason), new RegExp(localePattern(zhCNPart("lane.createdNoDirectory", 6, 11))));
    assert.equal(getTask(task.id).blocked_reason, null);
  });

  it("start rebuilds from the card base when the branch is gone", async () => {
    const { box, task, first } = await lostCard("branch-gone", { commit: false, dropBranch: true });
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    const now = readWorktreeCreated(task.id)!;
    assert.equal(existsSync(now.directory!), true);
    assert.equal(now.branch, first.branch);
    assert.equal(events(task.id, "temp_workspace_recreated")[0].usedRef, "base");
  });

  it("archives the old Paseo workspace record and leaves one live copy", async () => {
    const { box, task, first } = await lostCard("one-copy", { commit: false, temp: true });
    await startTask(task.id, box, "test", pick);
    assert.deepEqual(box.archived, [first.workspaceId]);
    const live = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind IN ('worktree_created', 'temp_workspace') ORDER BY id").all(task.id) as Array<{ data_json: string }>;
    const kept = live.map((row) => JSON.parse(row.data_json)).filter((data) => data.discarded !== true);
    assert.equal(kept.filter((data) => data.directory === first.directory).length, 0);
    assert.equal(kept.length, 2);
    assert.equal(getTask(task.id).paseo_workspace_id, readWorktreeCreated(task.id)!.workspaceId);
  });

  for (const foreign of ["develop", "release", "kanban/99999-other-card", "docs/team-notes"]) {
    it(`never releases ${foreign} with update-ref -d when the record names a branch the card does not own`, async () => {
      const name = `foreign-${foreign.replace(/\W+/g, "-")}`;
      const { box, task, root } = await lostCard(name, { commit: false, temp: true });
      git(root, "branch", foreign, "main");
      const tip = git(root, "rev-parse", foreign);
      getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.branch', ?) WHERE task_id = ? AND kind = 'worktree_created'").run(foreign, task.id);
      const archivedBefore = box.archived.length;
      await startTask(task.id, box, "test", pick);
      assert.equal(git(root, "rev-parse", foreign), tip);
      assert.equal(getTask(task.id).status, "blocked");
      assert.equal(getTask(task.id).blocked_kind, "needs_human");
      assert.match(getTask(task.id).blocked_reason ?? "", new RegExp(zhCN("missingCwd.purge.notThisCard") + "|" + localePattern(zhCNPart("worktreeGc.pushed.protectedBranch", 7, 10))));
      assert.equal(box.cwds.length, 0);
      assert.equal(box.archived.length, archivedBefore, "no side effect before the ownership check");
      assert.equal(events(task.id, "temp_workspace_recreated").length, 0);
    });
  }

  it("a rework card starts again in a rebuilt copy", async () => {
    const { box, task } = await lostCard("rework", { commit: true });
    getDb().prepare("UPDATE tasks SET status = 'rework', review_round = 1 WHERE id = ?").run(task.id);
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(events(task.id, "temp_workspace_recreated").length, 1);
    assert.equal(readFileSync(join(box.cwds[0], "work.txt"), "utf8"), "kept\n");
  });

  it("blocks needs_human with the reason when Paseo cannot make the worktree", async () => {
    const { box, task, tip, first, root } = await lostCard("create-fails", { commit: true });
    box.failCreate = ("paseo " + zhCNPart("settings.families.noFast", 0, 2) + zhCNPart("doctorLive.unreadable", 2, 3));
    await startTask(task.id, box, "test", pick);
    const after = getTask(task.id);
    assert.equal(after.status, "blocked");
    assert.equal(after.blocked_kind, "needs_human");
    assert.match(after.blocked_reason ?? "", new RegExp(localePattern(zhCNPart("workspaceRecreate.baseFailed", 17, 21)) + ".*paseo " + localePattern(zhCNPart("settings.families.noFast", 0, 2)) + localePattern(zhCNPart("doctorLive.unreadable", 2, 3))));
    assert.equal(box.cwds.length, 0);
    assert.equal(git(root, "rev-parse", first.branch!), tip);
    assert.equal(events(task.id, "temp_workspace_recreated").length, 0);
  });

  it("blocks needs_human when neither the branch nor the base is left", async () => {
    const { box, task, root } = await lostCard("no-base", { commit: false, dropBranch: true });
    getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.base', 'nowhere') WHERE task_id = ? AND kind = 'worktree_created'").run(task.id);
    git(root, "branch", "-m", "main", "trunk");
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "blocked");
    assert.equal(getTask(task.id).blocked_kind, "needs_human");
    assert.match(getTask(task.id).blocked_reason ?? "", new RegExp(localePattern(zhCNPart("workspaceRecreate.baseFailed", 17, 21))));
  });

  it("a rework card whose executor's directory is gone opens a new agent and does not message the old one", async () => {
    const { box, task } = await lostCard("rework-agent", { commit: true });
    getDb().prepare("UPDATE tasks SET status = 'rework', review_round = 1, executor_agent_id = 'old-agent', agent_id = 'old-agent' WHERE id = ?").run(task.id);
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(box.cwds.length, 1);
    assert.deepEqual(box.sent, []);
    assert.notEqual(getTask(task.id).executor_agent_id, "old-agent");
    assert.equal(events(task.id, "temp_workspace_recreated").length, 1);
  });

  for (const kind of ["placeholder", "missing"] as const) {
    it(`an independent review borrowing a ${kind} directory gets its own read-only copy`, async () => {
      const { box, task, first, root, tip } = await lostCard(`review-${kind}`, { commit: true });
      if (kind === "placeholder") {
        mkdirSync(first.directory!, { recursive: true });
        writeFileSync(join(first.directory!, PLACEHOLDER_NAME), "placeholder\n");
      }
      const review = createTask({ project: `review-${kind}`, title: "sample", role: "reviewer", workspacePath: root, reviewOf: task.id });
      box.readOnlyTrees.length = 0;
      await startTask(review.id, box, "test", pickReviewer);
      assert.equal(getTask(review.id).status, "reviewing");
      assert.equal(getTask(review.id).blocked_kind, null);
      assert.equal(box.cwds.length, 1);
      assert.notEqual(box.cwds[0], first.directory);
      assert.equal(readFileSync(join(box.cwds[0], "work.txt"), "utf8"), "kept\n");
      assert.deepEqual(box.readOnlyTrees, [true]);
      assert.equal(git(root, "rev-parse", first.branch!), tip);
      assert.equal(events(review.id, "temp_workspace_recreated").length, 1);
    });
  }

  it("a read-only copy is rebuilt on the branch tip, not the older recorded head", async () => {
    const { box, task, root } = await lostCard("readonly-tip", { commit: true });
    const own = readWorktreeCreated(task.id)!;
    void own;
    const old = git(root, "rev-parse", "main");
    const readonlyBranch = `kanban-readonly/${cardCode(task.id)}`;
    git(root, "branch", readonlyBranch, "HEAD");
    const tipSha = git(root, "rev-parse", "main");
    git(root, "worktree", "prune");
    const gone = join(dir, "gone-readonly");
    getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'worktree_created'").run(task.id);
    appendEvent(task.id, "worktree_created", null, null, "test", { directory: gone, branch: readonlyBranch, base: "main", root, workspaceId: "old-ro", readOnly: true, head: old, temp: true });
    appendEvent(task.id, "temp_workspace", null, null, "test", { name: "x", root, base: "main", directory: gone });
    writeFileSync(join(root, "b.txt"), "newer\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "newer");
    git(root, "branch", "-f", readonlyBranch, "main");
    const newTip = git(root, "rev-parse", readonlyBranch);
    assert.notEqual(newTip, tipSha);
    box.readOnlyTrees.length = 0;
    await startTask(task.id, box, "test", pick);
    assert.equal(git(root, "rev-parse", readonlyBranch), newTip);
    assert.deepEqual(box.readOnlyTrees, [true]);
    assert.equal(readFileSync(join(box.cwds[0], "b.txt"), "utf8"), "newer\n");
  });
  it("a first-time review copy that fails to build names the borrowed directory in the block reason", async () => {
    const { box, task, first, root } = await lostCard("review-fail", { commit: true });
    mkdirSync(first.directory!, { recursive: true });
    writeFileSync(join(first.directory!, PLACEHOLDER_NAME), "placeholder\n");
    const review = createTask({ project: "review-fail", title: "sample", role: "reviewer", workspacePath: root, reviewOf: task.id });
    assert.equal(readWorktreeCreated(review.id), null);
    box.failCreate = "boom";
    await startTask(review.id, box, "test", pickReviewer);
    const row = getTask(review.id);
    assert.equal(row.status, "blocked");
    assert.equal(row.blocked_kind, "needs_human");
    assert.ok(row.blocked_reason?.includes(first.directory!), row.blocked_reason ?? "");
    assert.ok(!row.blocked_reason?.includes(zhCN("labels.model.unrecorded")));
    assert.equal(box.cwds.length, 0);
  });
});
