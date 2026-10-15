/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { formatAudit, performAudit, type AuditView } from "../server/audit";
import { readCleanupEvents } from "../server/archive-book";
import { drainCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { assertSafeGit, runGit, squashDeleteArgs, type GitRunner } from "../server/git";
import { projectRoot } from "../server/paths";
import { cleanupOps } from "../server/paseo";
import type { PaseoApi } from "@getpaseo/client";
import { prMergeState, resetMergeCache, setGhRunner, writeContract } from "../server/pr";
import { appendEvent, createTask, getTask } from "../server/store";
import { branchName } from "../server/workspace";
import { PLACEHOLDER_NAME, resetMissingCwdForTests, setMissingCwdHooks, type CwdAgent } from "../server/missing-cwd";
import { isUnderWorktrees, ownedWorktree, resetWorktreeRemovalForTests, settleOwnedWorktree } from "../server/worktree-gc";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "wt-gc-"));
const trees = join(dir, "paseo-worktrees");
mkdirSync(trees, { recursive: true });
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_WORKTREES_ROOT = trees;

const PR = "https://github.com/acme/widgets/pull/8";
const view: AuditView = {
  async listActiveAgents() {
    return [];
  },
  async inspectWorkspace() {
    return null;
  },
};
const ops: CleanupOps = {
  async archiveAgent() {},
  async archiveWorkspace() {},
  async listAgents() {
    return [];
  },
  async inspectWorkspace() {
    return null;
  },
};

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(String(stdout));
    });
  });
}

async function makeRepo(name: string): Promise<string> {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  await git(root, ["init", "-b", "pre"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "README"), "a\n");
  await git(root, ["add", "README"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

async function addWorktree(root: string, branch: string, directory: string, start = "pre"): Promise<void> {
  mkdirSync(dirname(directory), { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, directory, start]);
}

async function commitIn(directory: string, file: string): Promise<void> {
  writeFileSync(join(directory, file), "x\n");
  await git(directory, ["add", file]);
  await git(directory, ["commit", "-m", file]);
}

function openCard(root: string, title: string, contract?: string): number {
  const task = createTask({
    project: "gc",
    title,
    role: "executor",
    workspacePath: root,
    ...(contract ? { contract } : {}),
  });
  getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'pre' WHERE id = ?").run(task.id);
  return task.id;
}

function remember(id: number, root: string, branch: string, directory: string): void {
  appendEvent(id, "worktree_created", null, null, "test", { directory, branch, base: "pre", root });
}

function finish(id: number, status: "done" | "archived"): void {
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
}

async function cleanup(): Promise<void> {
  const release = installCleanup(ops, { timeoutMs: 5_000 });
  try {
    await drainCleanups();
  } finally {
    release();
  }
}

after(() => {
  setGhRunner(null);
  resetMergeCache();
  resetWorktreeRemovalForTests();
  resetMissingCwdForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("remove a board worktree only after it is merged", () => {
  it("removes the copy and the branch with -d, never --force or -D", async () => {
    const root = await makeRepo("merged");
    const id = openCard(root, "note");
    const branch = branchName(id, "note");
    const directory = join(trees, "merged-card");
    await addWorktree(root, branch, directory);
    await commitIn(directory, "note");
    await git(root, ["merge", branch]);
    remember(id, root, branch, directory);
    finish(id, "done");
    await cleanup();
    assert.equal(existsSync(directory), false);
    assert.equal((await git(root, ["branch", "--list", branch])).trim(), "");
    const removed = readCleanupEvents(id).find((event) => event.action === "remove_worktree" && event.ok === true);
    assert.ok(removed);
    assert.equal(readCleanupEvents(id).some((event) => event.action === "cleanup" && String(event.error ?? "").includes("--force")), false);
  });

  it("archives the Paseo worktree workspace and still removes the git copy", async () => {
    const root = await makeRepo("both");
    const id = openCard(root, "both");
    const branch = branchName(id, "both");
    const directory = join(trees, "both-card");
    await addWorktree(root, branch, directory);
    await commitIn(directory, "both");
    await git(root, ["merge", branch]);
    remember(id, root, branch, directory);
    getDb().prepare("UPDATE tasks SET paseo_workspace_id = ? WHERE id = ?").run("wks-kanban-60", id);
    finish(id, "done");
    const archived: string[] = [];
    const local: CleanupOps = {
      async archiveAgent() {},
      async listAgents() {
        return [];
      },
      async archiveWorkspace(workspaceId) {
        archived.push(workspaceId);
      },
      async inspectWorkspace(workspaceId) {
        return {
          id: workspaceId,
          name: "kanban/60-demo",
          directory,
          projectRoot: root,
          projectId: "parent",
          kind: "worktree",
          archived: false,
        };
      },
    };
    const release = installCleanup(local, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.deepEqual(archived, ["wks-kanban-60"]);
    assert.equal(existsSync(directory), false);
    assert.equal(
      readCleanupEvents(id).some((event) => event.action === "archive_workspace" && event.ok === true && event.workspaceId === "wks-kanban-60"),
      true,
    );
    assert.equal(readCleanupEvents(id).some((event) => event.action === "remove_worktree" && event.ok === true), true);
  });

  it("leaves an unmerged, dirty, foreign, or off-tree copy alone", async () => {
    const root = await makeRepo("keep");
    const unmerged = openCard(root, "open");
    const unmergedBranch = branchName(unmerged, "open");
    const unmergedDir = join(trees, "open-card");
    await addWorktree(root, unmergedBranch, unmergedDir);
    await commitIn(unmergedDir, "open");
    remember(unmerged, root, unmergedBranch, unmergedDir);
    finish(unmerged, "done");
    await cleanup();
    assert.equal(existsSync(unmergedDir), true);
    const whileDone = await performAudit(view);
    assert.equal(whileDone.cards.some((card) => card.id === unmerged), false);
    finish(unmerged, "archived");
    const listed = await performAudit(view);
    assert.match(formatAudit(listed), new RegExp(zhCN("audit.gitWorktree", {"line":zhCN("worktreeGc.leftover.notMerged")})));
    assert.equal(existsSync(unmergedDir), true);

    const dirtyRoot = await makeRepo("dirty");
    const dirty = openCard(dirtyRoot, "dirty");
    const dirtyBranch = branchName(dirty, "dirty");
    const dirtyDir = join(trees, "dirty-card");
    await addWorktree(dirtyRoot, dirtyBranch, dirtyDir);
    await commitIn(dirtyDir, "dirty");
    await git(dirtyRoot, ["merge", dirtyBranch]);
    writeFileSync(join(dirtyDir, "local"), "nope\n");
    remember(dirty, dirtyRoot, dirtyBranch, dirtyDir);
    finish(dirty, "archived");
    await cleanup();
    assert.equal(existsSync(dirtyDir), true);
    assert.match(formatAudit(await performAudit(view)), new RegExp(zhCN("audit.gitWorktree", {"line":zhCN("lane.uncommitted")})));

    const foreign = openCard(root, "foreign");
    const foreignDir = join(trees, "foreign-card");
    await addWorktree(root, "feature/other", foreignDir);
    remember(foreign, root, "feature/other", foreignDir);
    finish(foreign, "archived");
    await cleanup();
    assert.equal(existsSync(foreignDir), true);
    assert.equal((await git(root, ["branch", "--list", "feature/other"])).includes("feature/other"), true);

    const outside = openCard(root, "outside");
    const outsideBranch = branchName(outside, "outside");
    const outsideDir = join(dir, "outside-card");
    await addWorktree(root, outsideBranch, outsideDir);
    remember(outside, root, outsideBranch, outsideDir);
    finish(outside, "archived");
    await cleanup();
    assert.equal(existsSync(outsideDir), true);
    assert.equal((await git(root, ["branch", "--list", outsideBranch])).includes(outsideBranch), true);
  });

  it("does not delete when the repo has a remote and the card is not a merged PR", async () => {
    const root = await makeRepo("remote");
    const origin = join(dir, "remote.git");
    await git(dir, ["init", "--bare", "-b", "pre", origin]);
    await git(root, ["remote", "add", "origin", origin]);
    await git(root, ["push", "origin", "pre"]);
    const id = openCard(root, "remote-card");
    const branch = branchName(id, "remote-card");
    const directory = join(trees, "remote-card");
    await addWorktree(root, branch, directory);
    await commitIn(directory, "remote");
    await git(root, ["merge", branch]);
    remember(id, root, branch, directory);
    finish(id, "archived");
    await cleanup();
    assert.equal(existsSync(directory), true);
    assert.match(formatAudit(await performAudit(view)), new RegExp(`${cardMark(id)}`));
  });

  it("removes a merged PR's worktree and stops at -d when the local branch is not merged", async () => {
    resetMergeCache();
    setGhRunner(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-09-27T00:00:00Z" }));
    await prMergeState(PR);
    const root = await makeRepo("pr");
    const contract = writeContract({ kind: "github", repo: "acme/widgets", pr: PR, awaiting: false });
    const id = openCard(root, "pr", contract);
    const branch = branchName(id, "pr");
    const directory = join(trees, "pr-card");
    await addWorktree(root, branch, directory);
    await commitIn(directory, "pr");
    remember(id, root, branch, directory);
    finish(id, "done");
    await cleanup();
    assert.equal(existsSync(directory), false);
    assert.equal((await git(root, ["branch", "--list", branch])).includes(branch), true);
    const failed = readCleanupEvents(id).find((event) => event.action === "remove_worktree" && event.ok === false);
    assert.match(failed?.error ?? "", new RegExp(localePattern(zhCNPart("worktreeGc.branch.forceRefused", 0, 5))));
    assert.equal(getTask(id).status, "done");
  });

  it("asks gh about the recorded PR number and never about the card branch name", async () => {
    resetMergeCache();
    const asked: string[] = [];
    setGhRunner(async (args) => {
      asked.push(args.join(" "));
      return JSON.stringify({ state: "OPEN", mergedAt: null });
    });
    const root = await makeRepo("pr-open");
    const contract = writeContract({ kind: "local-only", repo: null, pr: PR, awaiting: false });
    const id = openCard(root, "pr-open", contract);
    const branch = branchName(id, "pr-open");
    const directory = join(trees, "pr-open-card");
    await addWorktree(root, branch, directory);
    await commitIn(directory, "pr-open");
    remember(id, root, branch, directory);
    finish(id, "done");
    await cleanup();
    assert.ok(asked.length > 0);
    assert.ok(asked.every((line) => line.startsWith(`pr view ${PR.split("/").at(-1)} `) && !line.includes(branch)), asked.join("\n"));
  });

  it("asks git to remove without --force and backs off after a timeout", async () => {
    const root = await makeRepo("fake");
    const id = openCard(root, "fake");
    const branch = branchName(id, "fake");
    const directory = join(trees, "fake-card");
    mkdirSync(directory, { recursive: true });
    remember(id, root, branch, directory);
    const calls: string[][] = [];
    const run: GitRunner = async (_cwd, args) => {
      calls.push(args);
      if (args.includes("--force") || args.includes("push")) return { code: 9, stdout: "", stderr: "banned" };
      if (args[0] === "remote") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "worktree") return { code: 0, stdout: "", stderr: "" };
      if (args[1] === "--list") return { code: 0, stdout: `  ${branch}\n`, stderr: "" };
      if (args[1] === "-D") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: args.join(" ") };
    };
    const events = readCleanupEvents(id);
    const task = getTask(id);
    await settleOwnedWorktree({ task, events, now: new Date(), timeoutMs: 5_000, record: (data) => events.push({ ...data, at: new Date().toISOString() }), run });
    assert.deepEqual(calls, [
      ["branch", "--list", branch],
      ["remote"],
      ["merge-base", "--is-ancestor", `refs/heads/${branch}`, "refs/heads/pre"],
      ["status", "--porcelain"],
      ["worktree", "remove", directory],
      ["branch", "--list", branch],
      ["remote"],
      ["merge-base", "--is-ancestor", `refs/heads/${branch}`, "refs/heads/pre"],
      ["branch", "-D", branch],
    ]);

    const hung = openCard(root, "hung");
    const hungBranch = branchName(hung, "hung");
    const hungDir = join(trees, "hung-card");
    mkdirSync(hungDir, { recursive: true });
    remember(hung, root, hungBranch, hungDir);
    let hits = 0;
    const hang: GitRunner = () => {
      hits += 1;
      return new Promise(() => {});
    };
    const hungEvents = readCleanupEvents(hung);
    // The removal timer is unref'd so a hung git does not hold the process open.
    // This hang promise has no handle of its own, so the test keeps one until the timeout fires.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const first = await settleOwnedWorktree({
        task: getTask(hung),
        events: hungEvents,
        now: new Date(0),
        timeoutMs: 30,
        record: (data) => hungEvents.push({ ...data, at: new Date(0).toISOString() }),
        run: hang,
      });
      assert.equal(first, "pending");
      assert.equal(hungEvents.some((event) => event.outcome === "timeout" && event.error === zhCN("audit.timeout")), true);
      resetWorktreeRemovalForTests();
      const second = await settleOwnedWorktree({
        task: getTask(hung),
        events: hungEvents,
        now: new Date(1_000),
        timeoutMs: 30,
        record: (data) => hungEvents.push({ ...data, at: new Date(1_000).toISOString() }),
        run: hang,
      });
      assert.equal(second, "pending");
      assert.equal(hits, 1);
    } finally {
      clearInterval(keepAlive);
    }
  });
});

function squashGh(pr: string, merged: boolean, head: string | Error): void {
  setGhRunner(async (args) => {
    if (!args.includes(pr.split("/").pop() ?? "")) throw new Error(`unexpected gh ${args.join(" ")}`);
    const fields = args[args.indexOf("--json") + 1] ?? "";
    if (fields === "headRefOid") {
      if (head instanceof Error) throw head;
      return JSON.stringify({ headRefOid: head });
    }
    return JSON.stringify(merged ? { state: "MERGED", mergedAt: "2026-09-27T00:00:00Z" } : { state: "OPEN", mergedAt: null });
  });
}

function prContract(pr: string, kind: "github" | "local-only"): string {
  return kind === "github"
    ? writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false })
    : writeContract({ kind: "local-only", repo: null, pr, awaiting: false });
}

/** Squash-merge the card's branch into pre, the way GitHub does it, so the branch is not an ancestor of pre. */
async function squashCard(root: string, name: string): Promise<{ id: number; branch: string; directory: string; head: string }> {
  const pr = `https://github.com/acme/widgets/pull/${name.length + 100}`;
  const id = openCard(root, name);
  const branch = branchName(id, name);
  const directory = join(trees, `${name}-card`);
  await addWorktree(root, branch, directory);
  await commitIn(directory, `${name}-1`);
  await commitIn(directory, `${name}-2`);
  await git(root, ["merge", "--squash", branch]);
  await git(root, ["commit", "-m", `squash ${name}`]);
  remember(id, root, branch, directory);
  return { id, branch, directory, head: (await git(root, ["rev-parse", branch])).trim() };
}

function recorder(inner?: GitRunner): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const real: GitRunner = (cwd, args) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr || (err?.message ?? "")) });
      });
    });
  return {
    calls,
    run: (cwd, args) => {
      calls.push(args);
      return (inner ?? real)(cwd, args);
    },
  };
}

async function settleOnce(id: number, run: GitRunner): Promise<Array<Record<string, unknown>>> {
  resetWorktreeRemovalForTests();
  const events = readCleanupEvents(id);
  const start = events.length;
  await settleOwnedWorktree({
    task: getTask(id),
    events,
    now: new Date(),
    timeoutMs: 5_000,
    record: (data) => {
      appendEvent(id, "cleanup", null, null, "kanban", { ...data });
      events.push({ ...data, at: new Date().toISOString() });
    },
    run,
  });
  return events.slice(start) as unknown as Array<Record<string, unknown>>;
}

function usedForce(calls: string[][]): boolean {
  return calls.some((args) => args.includes("-D") || args.includes("--force"));
}

describe("delete a squash-merged board branch", () => {
  it("uses -D once the PR is merged and the local tip equals the PR head", async () => {
    for (const kind of ["local-only", "github"] as const) {
      resetMergeCache();
      const root = await makeRepo(`squash-${kind}`);
      const card = await squashCard(root, `sq-${kind}`);
      const pr = `https://github.com/acme/widgets/pull/${`sq-${kind}`.length + 100}`;
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(prContract(pr, kind), card.id);
      squashGh(pr, true, card.head);
      await prMergeState(pr);
      const { run, calls } = recorder();
      const added = await settleOnce(card.id, run);
      assert.equal(existsSync(card.directory), false, kind);
      assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "", kind);
      assert.deepEqual(calls.filter((args) => args[0] === "branch" && args[1] !== "--list"), [
        ["branch", "-D", card.branch],
      ]);
      assert.equal(calls.some((args) => args.includes("--force")), false);
      assert.equal(added.some((event) => event.action === "remove_worktree" && event.ok === true), true);
    }
  });

  it("keeps the branch when the local tip is ahead of the PR head, and lists it in the audit", async () => {
    resetMergeCache();
    const root = await makeRepo("squash-ahead");
    const card = await squashCard(root, "sq-ahead");
    const pr = `https://github.com/acme/widgets/pull/${"sq-ahead".length + 100}`;
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(prContract(pr, "local-only"), card.id);
    squashGh(pr, true, card.head);
    await prMergeState(pr);
    await commitIn(card.directory, "late-local");
    const { run, calls } = recorder();
    const added = await settleOnce(card.id, run);
    assert.equal(existsSync(card.directory), false);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(usedForce(calls), false);
    const failed = added.find((event) => event.action === "remove_worktree" && event.ok === false);
    assert.match(String(failed?.error ?? ""), new RegExp(zhCN("worktreeGc.branch.forceRefused", {"reason":zhCN("lane.localAhead")})));
    finish(card.id, "archived");
    assert.match(formatAudit(await performAudit(view)), new RegExp(zhCN("lane.localAhead")));
  });

  it("does not use -D when gh fails on the PR head", async () => {
    resetMergeCache();
    const root = await makeRepo("squash-gh");
    const card = await squashCard(root, "sq-gh");
    const pr = `https://github.com/acme/widgets/pull/${"sq-gh".length + 100}`;
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(prContract(pr, "github"), card.id);
    squashGh(pr, true, new Error("HTTP 502"));
    await prMergeState(pr);
    const { run, calls } = recorder();
    const added = await settleOnce(card.id, run);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(usedForce(calls), false);
    assert.match(String(added.find((event) => event.ok === false)?.error ?? ""), new RegExp(zhCN("worktreeGc.branch.forceRefused", {"reason":zhCN("worktreeGc.pr.headFailed", {error:"HTTP 502"})})));
  });

  it("does not touch the branch while the PR is not merged", async () => {
    resetMergeCache();
    const root = await makeRepo("squash-open");
    const card = await squashCard(root, "sq-open");
    const pr = `https://github.com/acme/widgets/pull/${"sq-open".length + 100}`;
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(prContract(pr, "local-only"), card.id);
    squashGh(pr, false, card.head);
    await prMergeState(pr);
    const { run, calls } = recorder();
    const added = await settleOnce(card.id, run);
    assert.equal(existsSync(card.directory), true);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(calls.some((args) => args[0] === "branch" && args[1] !== "--list"), false);
    assert.equal(added.some((event) => event.action === "skip_worktree" && event.reason === "not_merged"), true);
  });

  it("does not use -D for a branch the board did not open", async () => {
    resetMergeCache();
    const root = await makeRepo("squash-foreign");
    const card = await squashCard(root, "sq-foreign");
    const pr = `https://github.com/acme/widgets/pull/${"sq-foreign".length + 100}`;
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(prContract(pr, "local-only"), card.id);
    squashGh(pr, true, card.head);
    await prMergeState(pr);
    // Same branch and PR, but the recorded copy is outside the Paseo worktrees folder.
    getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'worktree_created'").run(card.id);
    appendEvent(card.id, "worktree_created", null, null, "test", { directory: join(dir, "elsewhere"), branch: card.branch, base: "pre", root });
    const { run, calls } = recorder();
    const added = await settleOnce(card.id, run);
    assert.deepEqual(calls, []);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(added.some((event) => event.action === "skip_worktree" && event.reason === "not_ours"), true);
  });

  it("keeps -D and --force out of every other git call", async () => {
    assert.throws(() => assertSafeGit(["branch", "-D", "kanban/1-x"]), new RegExp(localePattern(zhCNPart("git.refused.args", 0, 10))));
    assert.throws(() => assertSafeGit(["worktree", "remove", "--force", "/tmp/x"]), new RegExp(localePattern(zhCNPart("git.refused.args", 0, 10))));
    await assert.rejects(async () => runGit(dir, ["branch", "-D", "kanban/1-x"]), new RegExp(localePattern(zhCNPart("git.refused.args", 0, 10))));
    assert.deepEqual(squashDeleteArgs(7, "kanban/7-x"), ["branch", "-D", "kanban/7-x"]);
    assert.throws(() => squashDeleteArgs(7, "kanban/8-x"), new RegExp(localePattern(zhCNPart("git.refused.deleteBranch", 0, 8))));
    assert.throws(() => squashDeleteArgs(7, "kanban/70-x"), new RegExp(localePattern(zhCNPart("git.refused.deleteBranch", 0, 8))));
    assert.throws(() => squashDeleteArgs(7, "feature/x"), new RegExp(localePattern(zhCNPart("git.refused.deleteBranch", 0, 8))));
    // An observed checkout the card did not create has no -D path of its own (TEST_0184 P2-15).
    assert.throws(() => squashDeleteArgs(7, "docs/readme-notes"), new RegExp(localePattern(zhCNPart("git.refused.deleteBranch", 0, 8))));
    assert.throws(() => squashDeleteArgs(7, "develop"), new RegExp(localePattern(zhCNPart("git.refused.deleteBranch", 0, 8))));
    assert.throws(() => squashDeleteArgs(7, "--force"), new RegExp(localePattern(zhCNPart("git.refused.deleteBranch", 0, 8))));
    assert.throws(() => squashDeleteArgs(0, "kanban/0-x"), new RegExp(localePattern(zhCNPart("git.refused.deleteBranch", 0, 8))));
    const serverDir = join(projectRoot(), "server");
    for (const file of readdirSync(serverDir).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(serverDir, file), "utf8");
      if (file === "git.ts") {
        assert.equal(text.match(/"-D"/g)?.length, 2, "git.ts: assertSafeGit and squashDeleteArgs");
        continue;
      }
      assert.equal(/"-D"|'-D'/.test(text), false, `${file} must not pass -D`);
      assert.equal(/"--force"|'--force'/.test(text), false, `${file} must not pass --force`);
    }
  });
});

describe("worktree gc keeps a directory while another card's agent is running or unreadable", () => {
  function finishedNeighbor(directory: string, title: string): { id: number; agentId: string } {
    const other = createTask({ project: "gc", title, role: "reviewer", workspacePath: directory });
    const agentId = `neighbor-${other.id}`;
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ? WHERE id = ?").run(agentId, other.id);
    return { id: other.id, agentId };
  }

  async function mergedCopy(name: string): Promise<{ id: number; root: string; directory: string }> {
    const root = await makeRepo(name);
    const id = openCard(root, name);
    const branch = branchName(id, name);
    const directory = join(trees, `${name}-card`);
    await addWorktree(root, branch, directory);
    await commitIn(directory, `${name}.txt`);
    await git(root, ["merge", branch]);
    remember(id, root, branch, directory);
    finish(id, "done");
    return { id, root, directory };
  }

  async function sweep(
    id: number,
    agents: CwdAgent[],
    inspect: NonNullable<CleanupOps["inspectAgent"]>,
    now = new Date(),
  ): Promise<void> {
    const removed = new Set<string>();
    setMissingCwdHooks({
      listAgents: () => agents.filter((agent) => !removed.has(agent.id)),
      deleteAgent: async (agentId) => {
        removed.add(agentId);
      },
    });
    const local: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {},
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
      inspectAgent: inspect,
    };
    const release = installCleanup(local, { timeoutMs: 5_000 });
    try {
      await drainCleanups(now);
    } finally {
      release();
    }
  }

  it("does not delete the worktree while another card's agent is still running", async () => {
    const card = await mergedCopy("running-neighbor");
    const neighbor = finishedNeighbor(card.directory, "Just ended but still running");
    const agent: CwdAgent = {
      id: neighbor.agentId,
      cwd: card.directory,
      provider: "cursor",
      title: "still running",
      archived: false,
      lastActivityAt: "2026-10-01T00:00:00.000Z",
      labels: { kanban: "1", kanban_task: String(neighbor.id) },
    };
    try {
      await sweep(card.id, [agent], async (agentId) => ({ archived: false, busy: agentId === neighbor.agentId }));
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(join(card.directory, PLACEHOLDER_NAME)), false);
      const waits = readCleanupEvents(card.id).filter((event) => event.action === "wait_turn" && event.agentId === neighbor.agentId);
      assert.equal(waits.length, 0);
      const failed = readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(JSON.stringify(readCleanupEvents(card.id)).includes(neighbor.agentId), false);
      assert.equal(readCleanupEvents(card.id).some((event) => event.action === "remove_worktree" && event.ok === true), false);
    } finally {
      resetMissingCwdForTests();
    }
  });

  it("keeps the worktree while another card's agent points at it, without querying that agent", async () => {
    const card = await mergedCopy("query-neighbor");
    const neighbor = finishedNeighbor(card.directory, zhCNPart("cardParts.event.prError", 2, 6));
    const agent: CwdAgent = {
      id: neighbor.agentId,
      cwd: card.directory,
      provider: "cursor",
      title: "Unclear",
      archived: false,
      lastActivityAt: "2026-10-01T00:00:00.000Z",
      labels: { kanban: "1", kanban_task: String(neighbor.id) },
    };
    const start = new Date("2026-10-01T03:00:00.000Z");
    let broken = true;
    try {
      await sweep(card.id, [agent], async (agentId) => {
        if (broken && agentId === neighbor.agentId) throw new Error((zhCNPart("cardParts.event.prError", 2, 4) + zhCNPart("wake.board.tickError", 10, 12)));
        return { archived: false, busy: false };
      }, start);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(join(card.directory, PLACEHOLDER_NAME)), false);
      const failed = readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(JSON.stringify(readCleanupEvents(card.id)).includes(neighbor.agentId), false);
      assert.equal(typeof failed[0]?.retryAt, "string");
      await sweep(card.id, [agent], async () => ({ archived: false, busy: false }), new Date(start.getTime() + 30_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false).length, 1);
      broken = false;
      await sweep(card.id, [agent], async () => ({ archived: false, busy: false }), new Date(start.getTime() + 61_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(readCleanupEvents(card.id).some((event) => event.action === "remove_worktree" && event.ok === true), false);
    } finally {
      resetMissingCwdForTests();
    }
  });

  it("keeps a merged worktree when another card's idle agent still points at it", async () => {
    const card = await mergedCopy("idle-neighbor");
    const neighbor = finishedNeighbor(card.directory, (zhCNPart("cleanup.reason.gone", 0, 2) + "Demo text"));
    const agent: CwdAgent = {
      id: neighbor.agentId,
      cwd: card.directory,
      provider: "cursor",
      title: "demo fixture",
      archived: false,
      lastActivityAt: "2026-10-01T00:00:00.000Z",
      labels: { kanban: "1", kanban_task: String(neighbor.id) },
    };
    let deleted = false;
    try {
      setMissingCwdHooks({
        listAgents: () => (deleted ? [] : [agent]),
        deleteAgent: async () => {
          deleted = true;
        },
      });
      const local: CleanupOps = {
        async archiveAgent() {},
        async archiveWorkspace() {},
        async listAgents() {
          return [];
        },
        async inspectWorkspace() {
          return null;
        },
        async inspectAgent() {
          return { archived: false, busy: false };
        },
      };
      const release = installCleanup(local, { timeoutMs: 5_000 });
      try {
        await drainCleanups();
      } finally {
        release();
      }
      assert.equal(deleted, false);
      assert.equal(existsSync(card.directory), true);
      const failed = readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(JSON.stringify(readCleanupEvents(card.id)).includes(agent.id), false);
      assert.equal(readCleanupEvents(card.id).some((event) => event.action === "remove_worktree" && event.ok === true), false);
    } finally {
      resetMissingCwdForTests();
    }
  });

  async function sweepList(id: number, list: () => CwdAgent[] | null, now: Date): Promise<void> {
    setMissingCwdHooks({
      listAgents: list,
      deleteAgent: async () => {},
    });
    const local: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {},
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const release = installCleanup(local, { timeoutMs: 5_000 });
    try {
      await drainCleanups(now);
    } finally {
      release();
    }
  }

  for (const kind of ["null", "throw"] as const) {
    it(`keeps the worktree when the agent list ${kind === "null" ? "cannot be read" : "throws"}, then removes it once the list works`, async () => {
      const card = await mergedCopy(`list-${kind}`);
      const start = new Date("2026-10-01T04:00:00.000Z");
      let open = false;
      const list = (): CwdAgent[] | null => {
        if (open) return [];
        if (kind === "throw") throw new Error((zhCNPart("compat.name.modelEfforts", 4, 6) + zhCN("doctorLive.unreadable")));
        return null;
      };
      try {
        await sweepList(card.id, list, start);
        assert.equal(existsSync(card.directory), true);
        assert.equal(existsSync(join(card.directory, PLACEHOLDER_NAME)), false);
        const failed = readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false);
        assert.equal(failed.length, 1);
        assert.match(failed[0]?.error ?? "", new RegExp(localePattern(zhCNPart("missingCwd.unreadAgentList", 0, 12))));
        assert.equal(typeof failed[0]?.retryAt, "string");
        await sweepList(card.id, list, new Date(start.getTime() + 30_000));
        assert.equal(existsSync(card.directory), true);
        assert.equal(readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false).length, 1);
        open = true;
        await sweepList(card.id, list, new Date(start.getTime() + 61_000));
        assert.equal(existsSync(card.directory), false);
        assert.equal(readCleanupEvents(card.id).some((event) => event.action === "remove_worktree" && event.ok === true), true);
      } finally {
        resetMissingCwdForTests();
      }
    });
  }

  it("keeps the worktree while another card's agent file is present, even when Paseo cannot be asked", async () => {
    const agentsRoot = join(dir, "gc-agents-inspect");
    const previous = process.env.KANBAN_AGENTS_DIR;
    process.env.KANBAN_AGENTS_DIR = agentsRoot;
    const card = await mergedCopy("inspect-adapter");
    const neighbor = finishedNeighbor(card.directory, "Disk appears idle");
    mkdirSync(join(agentsRoot, "bucket"), { recursive: true });
    writeFileSync(
      join(agentsRoot, "bucket", `${neighbor.agentId}.json`),
      JSON.stringify({
        id: neighbor.agentId,
        cwd: card.directory,
        title: "Disk idle",
        provider: "cursor",
        labels: { kanban: "1", kanban_task: String(neighbor.id) },
        lastActivityAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    const start = new Date("2026-10-01T05:00:00.000Z");
    let broken = true;
    const inspect = cleanupOps({
      agents: {
        ref(agentId: string) {
          return {
            async refresh() {
              if (broken && agentId === neighbor.agentId) throw new Error("connect ECONNREFUSED");
              return { agent: { id: agentId, status: "idle", archivedAt: null, activeTurn: null } };
            },
            current() {
              return null;
            },
          };
        },
      },
    } as unknown as PaseoApi).inspectAgent;
    if (!inspect) throw new Error("cleanupOps did not provide inspectAgent");
    try {
      setMissingCwdHooks({
        deleteAgent: async (agentId) => {
          rmSync(join(agentsRoot, "bucket", `${agentId}.json`), { force: true });
        },
      });
      const local: CleanupOps = {
        async archiveAgent() {},
        async archiveWorkspace() {},
        async listAgents() {
          return [];
        },
        async inspectWorkspace() {
          return null;
        },
        inspectAgent: inspect,
      };
      const run = async (now: Date) => {
        const release = installCleanup(local, { timeoutMs: 5_000 });
        try {
          await drainCleanups(now);
        } finally {
          release();
        }
      };
      await run(start);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(join(card.directory, PLACEHOLDER_NAME)), false);
      assert.equal(existsSync(join(agentsRoot, "bucket", `${neighbor.agentId}.json`)), true);
      const failed = readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(JSON.stringify(readCleanupEvents(card.id)).includes(neighbor.agentId), false);
      assert.equal(typeof failed[0]?.retryAt, "string");
      await run(new Date(start.getTime() + 30_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(join(agentsRoot, "bucket", `${neighbor.agentId}.json`)), true);
      assert.equal(readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false).length, 1);
      broken = false;
      await run(new Date(start.getTime() + 61_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(join(agentsRoot, "bucket", `${neighbor.agentId}.json`)), true);
      assert.equal(readCleanupEvents(card.id).some((event) => event.action === "remove_worktree" && event.ok === true), false);
    } finally {
      if (previous === undefined) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = previous;
      resetMissingCwdForTests();
      rmSync(agentsRoot, { recursive: true, force: true });
    }
  });

  async function sweepDisk(id: number, agentsRoot: string, now: Date): Promise<void> {
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        rmSync(join(agentsRoot, "bucket", `${agentId}.json`), { force: true });
      },
    });
    const local: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {},
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
      async inspectAgent() {
        return { archived: false, busy: false };
      },
    };
    const release = installCleanup(local, { timeoutMs: 5_000 });
    try {
      await drainCleanups(now);
    } finally {
      release();
    }
  }

  it("still removes a worktree when the agent root has a plain file and a dangling symlink", async () => {
    const agentsRoot = join(dir, "gc-agents-plain");
    const previous = process.env.KANBAN_AGENTS_DIR;
    process.env.KANBAN_AGENTS_DIR = agentsRoot;
    mkdirSync(agentsRoot, { recursive: true });
    writeFileSync(join(agentsRoot, "not-a-bucket"), "plain\n");
    symlinkSync("already-gone", join(agentsRoot, "dangling"));
    const card = await mergedCopy("plain-agents");
    try {
      await sweepDisk(card.id, agentsRoot, new Date());
      assert.equal(existsSync(card.directory), false);
      assert.equal(readCleanupEvents(card.id).some((event) => event.action === "remove_worktree" && event.ok === true), true);
    } finally {
      if (previous === undefined) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = previous;
      resetMissingCwdForTests();
      rmSync(agentsRoot, { recursive: true, force: true });
    }
  });

  it("keeps the worktree when an agent bucket cannot be read, then removes it once the bucket can", async () => {
    const agentsRoot = join(dir, "gc-agents-bucket");
    const locked = join(agentsRoot, "locked");
    const previous = process.env.KANBAN_AGENTS_DIR;
    process.env.KANBAN_AGENTS_DIR = agentsRoot;
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "hidden.json"), "{}\n");
    chmodSync(locked, 0o000);
    const card = await mergedCopy("locked-bucket");
    const start = new Date("2026-10-01T06:00:00.000Z");
    try {
      await sweepDisk(card.id, agentsRoot, start);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(join(card.directory, PLACEHOLDER_NAME)), false);
      const failed = readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false);
      assert.equal(failed.length, 1);
      assert.match(failed[0]?.error ?? "", new RegExp(localePattern(zhCNPart("missingCwd.unreadAgentList", 0, 12))));
      assert.equal(typeof failed[0]?.retryAt, "string");
      await sweepDisk(card.id, agentsRoot, new Date(start.getTime() + 30_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false).length, 1);
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
      await sweepDisk(card.id, agentsRoot, new Date(start.getTime() + 61_000));
      assert.equal(existsSync(card.directory), false);
      assert.equal(readCleanupEvents(card.id).some((event) => event.action === "remove_worktree" && event.ok === true), true);
    } finally {
      try {
        chmodSync(locked, 0o755);
      } catch {
        // already removed
      }
      if (previous === undefined) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = previous;
      resetMissingCwdForTests();
      rmSync(agentsRoot, { recursive: true, force: true });
    }
  });

  it("keeps the worktree when another card's agent file cannot be read, and still keeps it once the file can", async () => {
    const agentsRoot = join(dir, "gc-agents-file");
    const previous = process.env.KANBAN_AGENTS_DIR;
    process.env.KANBAN_AGENTS_DIR = agentsRoot;
    const card = await mergedCopy("locked-file");
    const neighbor = finishedNeighbor(card.directory, (zhCNPart("missingCwd.report.listFile", 2, 4) + zhCN("doctorLive.unreadable")));
    const file = join(agentsRoot, "bucket", `${neighbor.agentId}.json`);
    mkdirSync(join(agentsRoot, "bucket"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        id: neighbor.agentId,
        cwd: card.directory,
        title: "cannot be read",
        provider: "cursor",
        labels: { kanban: "1", kanban_task: String(neighbor.id) },
        lastActivityAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    chmodSync(file, 0o000);
    const start = new Date("2026-10-01T07:00:00.000Z");
    try {
      await sweepDisk(card.id, agentsRoot, start);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(join(card.directory, PLACEHOLDER_NAME)), false);
      const failed = readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false);
      assert.equal(failed.length, 1);
      assert.match(failed[0]?.error ?? "", new RegExp(localePattern(zhCNPart("missingCwd.unreadAgentList", 0, 12))));
      assert.equal(typeof failed[0]?.retryAt, "string");
      await sweepDisk(card.id, agentsRoot, new Date(start.getTime() + 30_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false).length, 1);
      chmodSync(file, 0o644);
      await sweepDisk(card.id, agentsRoot, new Date(start.getTime() + 61_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(file), true);
      const opened = readCleanupEvents(card.id).filter((event) => event.action === "remove_worktree" && event.ok === false);
      assert.equal(opened.length, 1);
      assert.equal(opened[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(JSON.stringify(readCleanupEvents(card.id)).includes(neighbor.agentId), false);
      assert.equal(readCleanupEvents(card.id).some((event) => event.action === "remove_worktree" && event.ok === true), false);
    } finally {
      try {
        chmodSync(file, 0o644);
      } catch {
        // already removed
      }
      if (previous === undefined) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = previous;
      resetMissingCwdForTests();
      rmSync(agentsRoot, { recursive: true, force: true });
    }
  });
});

describe("worktree root check follows symlinks (TEST_0184 P2-18)", () => {
  it("rejects a path under the root that is a symlink leading outside it", () => {
    const base = mkdtempSync(join(dir, "realpath-"));
    const root = join(base, "worktrees");
    const outside = join(base, "user-repo");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(outside, "src"), { recursive: true });
    symlinkSync(outside, join(root, "escape"));
    assert.equal(isUnderWorktrees(join(root, "escape"), root), false);
    assert.equal(isUnderWorktrees(join(root, "escape", "src"), root), false);
    assert.equal(isUnderWorktrees(join(root, "escape", "..", "..", "user-repo"), root), false);
    assert.equal(ownedWorktree(7, { directory: join(root, "escape"), branch: "kanban/7-x", root: outside }, root), null);
  });

  it("accepts real children, missing children, and a symlinked root", () => {
    const base = mkdtempSync(join(dir, "realpath-ok-"));
    const root = join(base, "worktrees");
    mkdirSync(join(root, "card"), { recursive: true });
    symlinkSync(root, join(base, "root-link"));
    assert.equal(isUnderWorktrees(join(root, "card"), root), true);
    assert.equal(isUnderWorktrees(join(root, "not-yet"), root), true);
    assert.equal(isUnderWorktrees(join(root, "card"), join(base, "root-link")), true);
    assert.equal(isUnderWorktrees(join(base, "root-link", "card"), root), true);
    assert.equal(isUnderWorktrees(root, root), false);
  });
});
