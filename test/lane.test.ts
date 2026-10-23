/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { installCleanup, flushCleanups } from "../server/cleanup";
import { setProjectWorkspace } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { acceptTask } from "../server/flow";
import type { CleanupRecord } from "../server/archive-book";
import { runGit, type GitRunner } from "../server/git";
import { laneBranchDue, placeLane, resetLaneLocksForTests, settleLaneBranch } from "../server/lane";
import type { ListedWorkspace } from "../server/placement";
import type { Profile } from "../server/profiles";
import { createTask, getDetail, getTask } from "../server/store";
import { laneBranchName } from "../server/workspace";
import { workspaceLine } from "../shared/labels";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "lane-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  pool: "alternate",
};

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(String(stdout));
      },
    );
  });
}

async function initRepo(name: string): Promise<string> {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README"), "a\n");
  await git(repo, ["add", "README"]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

function laneLauncher(label: string): {
  launcher: AgentLauncher;
  calls: Array<{ branchName: string; baseBranch: string; cwd: string }>;
  opened: Array<{ cwd: string; workspaceId?: string }>;
} {
  const calls: Array<{ branchName: string; baseBranch: string; cwd: string }> = [];
  const opened: Array<{ cwd: string; workspaceId?: string }> = [];
  const launcher: AgentLauncher = {
    async create(options) {
      opened.push({ cwd: options.cwd, workspaceId: options.workspaceId });
      return { id: `agent-${label}-${opened.length}` };
    },
    async send() {},
    async createWorktree(options) {
      calls.push({ branchName: options.branchName, baseBranch: options.baseBranch, cwd: options.cwd });
      const path = join(dir, `${label}-${options.branchName}`);
      await git(options.cwd, ["worktree", "add", "-b", options.branchName, path, options.baseBranch]);
      return { directory: path, workspaceId: `ws-${options.branchName}`, name: options.branchName };
    },
  };
  return { launcher, calls, opened };
}

function start(id: number, launcher: AgentLauncher) {
  return startTask(id, launcher, "test", { profiles: [executor], chosen: executor, reason: "Test" });
}

function allowLanes(project: string, patch: { baseBranch?: string; worktreeLanes?: number } = {}): void {
  setProjectWorkspace(project, { ...patch, lanesEnabled: true });
}

after(() => {
  installCleanup(null);
  resetLaneLocksForTests();
  setWakeSender(() => {});
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

describe("fixed worktree lanes", () => {
  it("names the card branch with ASCII only", () => {
    const repo = join(dir, "names");
    mkdirSync(repo, { recursive: true });
    allowLanes("names");
    const chinese = createTask({ project: "names", title: zhCN("language.selfName"), role: "executor", workspacePath: `lane:${repo}` });
    assert.equal(chinese.workspace_kind, "lane");
    assert.equal(getDetail(chinese.id).task.branch, laneBranchName(chinese.id, zhCN("language.selfName")));
    assert.equal(getDetail(chinese.id).task.branch, `kanban/${chinese.id}-task`);
    const mixed = createTask({ project: "names", title: `Hello ${zhCN("language.selfName")}!`, role: "executor", workspacePath: `lane:${repo}@main` });
    assert.equal(getDetail(mixed.id).task.branch, `kanban/${mixed.id}-Hello`);
    assert.equal(
      workspaceLine({
        kind: "lane",
        path: repo,
        base: "main",
        branch: getDetail(mixed.id).task.branch,
        lane: "kanban-lane-1",
      }),
      `${zhCNPart("labels.workspace.none", 0, 4)}${(zhCN("labels.workspace.lane") + " ")}· kanban-lane-1 · ${zhCNPart("labels.workspace.branch", 0, 3)}${getDetail(mixed.id).task.branch} · ${zhCNPart("labels.workspace.base", 0, 3)}main · ${repo}`,
    );
  });

  it("creates the lane for the first card, then reuses it for a clean second card", async () => {
    const repo = await initRepo("reuse");
    allowLanes("reuse", { baseBranch: "main" });
    const { launcher, calls, opened } = laneLauncher("reuse");
    const first = createTask({ project: "reuse", title: "lane-one", role: "executor", workspacePath: `lane:${repo}` });
    await start(first.id, launcher);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.branchName, "kanban-lane-1");
    assert.equal(calls[0]?.baseBranch, "main");
    const laneDir = getTask(first.id).workspace_path;
    assert.ok(laneDir);
    assert.notEqual(laneDir, repo);
    assert.equal(existsSync(laneDir!), true);
    assert.equal((await git(laneDir!, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), `kanban/${first.id}-lane-one`);
    assert.equal(opened[0]?.cwd, laneDir);
    assert.equal(opened[0]?.workspaceId, "ws-kanban-lane-1");
    assert.equal(getTask(first.id).paseo_workspace_id, "ws-kanban-lane-1");
    assert.equal(getDetail(first.id).task.lane, "kanban-lane-1");

    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.id);
    const second = createTask({ project: "reuse", title: "lane-two", role: "executor", workspacePath: `lane:${repo}` });
    await start(second.id, launcher);
    assert.equal(calls.length, 1);
    assert.equal(getTask(second.id).workspace_path, laneDir);
    assert.equal((await git(laneDir!, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), `kanban/${second.id}-lane-two`);
    assert.equal(getTask(second.id).status, "running");
    assert.equal(getTask(second.id).paseo_workspace_id, "ws-kanban-lane-1");
  });

  it("queues the next card with a hold reason when the lane is busy, dirty, or the branch is not pushed", async () => {
    const repo = await initRepo("hold");
    const origin = join(dir, "hold.git");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "origin", "main"]);
    allowLanes("hold", { baseBranch: "main" });
    const { launcher, calls } = laneLauncher("hold");

    const first = createTask({ project: "hold", title: "holder", role: "executor", workspacePath: `lane:${repo}` });
    await start(first.id, launcher);
    const laneDir = getTask(first.id).workspace_path!;
    const queued = createTask({ project: "hold", title: "queued", role: "executor", workspacePath: `lane:${repo}` });
    const busy = await start(queued.id, launcher);
    assert.match(busy.message, new RegExp(`${(zhCN("labels.workspace.lane") + " ")}kanban-lane-1 ${zhCNPart("lane.busy", 10, 12)}${cardMark(first.id)} ${zhCNPart("lane.busy", 19, 21)}`));
    assert.equal(getTask(queued.id).status, "ready");
    assert.match(getTask(queued.id).hold_reason ?? "", new RegExp(zhCN("lane.busy", {"lane":"kanban-lane-1","card":"[A-Z0-9]+_\\d+"})));
    assert.equal(calls.length, 1);

    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.id);
    writeFileSync(join(laneDir, "dirty.txt"), "x\n");
    const dirty = await start(queued.id, launcher);
    const dirtyText = `${(zhCN("labels.workspace.lane") + " ")}kanban-lane-1 ${zhCNPart("lane.prev", 0, 4)}${cardMark(first.id)} ${zhCNPart("lane.prevWithBranch", 11, 15)}kanban/${first.id}-holder ${zhCNPart("wake.missingPr.dirty", 5, 11)}`;
    assert.equal(dirty.message, dirtyText);
    assert.equal(getTask(queued.id).status, "ready");
    assert.equal(getTask(queued.id).hold_reason, dirtyText);

    unlinkSync(join(laneDir, "dirty.txt"));
    writeFileSync(join(laneDir, "kept.txt"), "y\n");
    await git(laneDir, ["add", "kept.txt"]);
    await git(laneDir, ["commit", "-m", "keep"]);
    const unpushed = await start(queued.id, launcher);
    const unpushedText = `${(zhCN("labels.workspace.lane") + " ")}kanban-lane-1 ${zhCNPart("lane.prev", 0, 4)}${cardMark(first.id)} ${zhCNPart("lane.prevWithBranch", 11, 15)}kanban/${first.id}-holder ${zhCNPart("lane.unpushed", 16, 23)}`;
    assert.equal(unpushed.message, unpushedText);
    assert.equal(getTask(queued.id).status, "ready");
    assert.equal(getTask(queued.id).hold_reason, unpushedText);
    assert.equal(calls.length, 1);
    assert.equal(existsSync(laneDir), true);
  });

  it("refuses to checkout over work that appeared in the lane after the owner check", async () => {
    const repo = await initRepo("unsaved");
    allowLanes("unsaved", { baseBranch: "main" });
    const { launcher } = laneLauncher("unsaved");
    const first = createTask({ project: "unsaved", title: "owner", role: "executor", workspacePath: `lane:${repo}` });
    await start(first.id, launcher);
    const laneDir = getTask(first.id).workspace_path!;
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.id);
    const second = createTask({ project: "unsaved", title: "next", role: "executor", workspacePath: `lane:${repo}` });
    let wrote = false;
    const run: GitRunner = async (cwd, args) => {
      const result = await runGit(cwd, args);
      if (!wrote && cwd === laneDir && args[0] === "status") {
        wrote = true;
        writeFileSync(join(laneDir, "README"), "unsaved edit\n");
      }
      return result;
    };
    await assert.rejects(placeLane(getTask(second.id), launcher, run), new RegExp(localePattern(zhCNPart("lane.uncommitted", 1, 7))));
    assert.equal((await git(laneDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), `kanban/${first.id}-owner`);
    assert.equal((await git(laneDir, ["status", "--porcelain"])).includes("README"), true);
  });

  it("runs two cards at once when the project has two lanes", async () => {
    const repo = await initRepo("two");
    allowLanes("two", { worktreeLanes: 2, baseBranch: "main" });
    const { launcher, calls } = laneLauncher("two");
    const left = createTask({ project: "two", title: "left", role: "executor", workspacePath: `lane:${repo}` });
    const right = createTask({ project: "two", title: "right", role: "executor", workspacePath: `lane:${repo}` });
    await Promise.all([start(left.id, launcher), start(right.id, launcher)]);
    assert.equal(getTask(left.id).status, "running");
    assert.equal(getTask(right.id).status, "running");
    assert.notEqual(getTask(left.id).workspace_path, getTask(right.id).workspace_path);
    assert.deepEqual(calls.map((call) => call.branchName).sort(), ["kanban-lane-1", "kanban-lane-2"]);
    assert.equal(existsSync(getTask(left.id).workspace_path!), true);
    assert.equal(existsSync(getTask(right.id).workspace_path!), true);
  });

  it("keeps the lane directory and workspace after the card is accepted and cleaned up", async () => {
    const repo = await initRepo("stay");
    allowLanes("stay", { baseBranch: "main" });
    const { launcher } = laneLauncher("stay");
    const archivedWorkspaces: string[] = [];
    const archivedAgents: string[] = [];
    const view: { snapshot: ListedWorkspace | null } = { snapshot: null };
    installCleanup({
      async archiveAgent(agentId) {
        archivedAgents.push(agentId);
      },
      async archiveWorkspace(workspaceId) {
        archivedWorkspaces.push(workspaceId);
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return view.snapshot;
      },
    });
    const task = createTask({ project: "stay", title: "stay-lane", role: "executor", workspacePath: `lane:${repo}` });
    await start(task.id, launcher);
    const laneDir = getTask(task.id).workspace_path!;
    const workspaceId = getTask(task.id).paseo_workspace_id!;
    view.snapshot = {
      id: workspaceId,
      name: "kanban-lane-1",
      directory: laneDir,
      projectRoot: repo,
      projectId: "stay-project",
      kind: "worktree",
      archived: false,
    };
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.equal(existsSync(laneDir), true);
    assert.equal(archivedWorkspaces.includes(workspaceId), false);
    assert.equal(archivedWorkspaces.length, 0);
    assert.ok(archivedAgents.length > 0);
    const cleanup = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cleanup'").all(task.id) as unknown as Array<{
      data_json: string;
    }>;
    const actions = cleanup.map((row) => JSON.parse(row.data_json) as { action?: string; reason?: string; ok?: boolean });
    assert.equal(actions.some((event) => event.action === "skip_workspace" && event.reason === "lane"), true);
    assert.equal(actions.some((event) => event.action === "remove_worktree"), false);
    assert.equal(actions.some((event) => event.action === "delete_lane_branch" && event.ok === true), true);
    assert.equal((await git(laneDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "kanban-lane-1");
    assert.equal((await git(repo, ["branch", "--list", `kanban/${task.id}-stay-lane`])).trim(), "");
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cleanup_finished'").get(task.id) != null, true);
  });

  it("holds the lane lock while deleting the card branch so the next claim cannot checkout yet", async () => {
    const repo = await initRepo("lock");
    allowLanes("lock", { baseBranch: "main" });
    const { launcher } = laneLauncher("lock");
    const first = createTask({ project: "lock", title: "lock-one", role: "executor", workspacePath: `lane:${repo}` });
    await start(first.id, launcher);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.id);

    const steps: string[] = [];
    let releaseSettle: () => void = () => {};
    const settlePaused = new Promise<void>((resolve) => {
      releaseSettle = () => {
        steps.push("settle-release");
        resolve();
      };
    });
    let markPaused: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    const settleRun: GitRunner = async (cwd, args) => {
      if (args[0] === "checkout" && args[1] === "kanban-lane-1") {
        steps.push("settle-checkout");
        markPaused();
        await settlePaused;
      }
      return runGit(cwd, args);
    };
    const events: CleanupRecord[] = [];
    const settling = settleLaneBranch({
      task: getTask(first.id),
      events,
      now: new Date(),
      timeoutMs: 20_000,
      record: (data) => {
        events.push({ ...data, at: new Date().toISOString() });
      },
      run: settleRun,
    });
    await paused;

    const second = createTask({ project: "lock", title: "lock-two", role: "executor", workspacePath: `lane:${repo}` });
    let claimGit = false;
    const claimRun: GitRunner = async (cwd, args) => {
      claimGit = true;
      if (args[0] === "checkout" && args[1] === "-B") steps.push("claim-checkout");
      return runGit(cwd, args);
    };
    const claiming = placeLane(second, launcher, claimRun);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(claimGit, false);
    assert.deepEqual(steps, ["settle-checkout"]);

    releaseSettle();
    assert.equal(await settling, "settled");
    const placed = await claiming;
    assert.equal("hold" in placed, false);
    assert.ok(steps.indexOf("claim-checkout") > steps.indexOf("settle-release"));
    assert.equal(existsSync(getTask(first.id).workspace_path!), true);
  });

  it("keeps going when the local base is missing: no origin follows the local rule, origin still checks the tip", async () => {
    const localOnly = await initRepo("missing-local");
    await git(localOnly, ["branch", "pre"]);
    allowLanes("missing-local", { baseBranch: "pre" });
    const localLauncher = laneLauncher("missing-local");
    const localFirst = createTask({
      project: "missing-local",
      title: "local-first",
      role: "executor",
      workspacePath: `lane:${localOnly}@pre`,
    });
    await start(localFirst.id, localLauncher.launcher);
    const localLane = getTask(localFirst.id).workspace_path!;
    writeFileSync(join(localLane, "local.txt"), "x\n");
    await git(localLane, ["add", "local.txt"]);
    await git(localLane, ["commit", "-m", "local only"]);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(localFirst.id);
    await git(localOnly, ["branch", "-d", "pre"]);
    const localSecond = createTask({
      project: "missing-local",
      title: "local-second",
      role: "executor",
      workspacePath: `lane:${localOnly}@pre`,
    });
    await assert.rejects(() => start(localSecond.id, localLauncher.launcher), /pre/);
    assert.equal(getTask(localSecond.id).status, "ready");
    assert.equal(getTask(localSecond.id).blocked_kind, null);
    assert.equal(getTask(localSecond.id).hold_reason, null);

    const repo = await initRepo("missing-origin");
    await git(repo, ["branch", "pre"]);
    const origin = join(dir, "missing-origin.git");
    await git(dir, ["init", "--bare", "-b", "main", origin]);
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "origin", "main"]);
    await git(repo, ["push", "origin", "pre"]);
    allowLanes("missing-origin", { baseBranch: "pre" });
    const { launcher } = laneLauncher("missing-origin");
    const first = createTask({
      project: "missing-origin",
      title: "origin-first",
      role: "executor",
      workspacePath: `lane:${repo}@pre`,
    });
    await start(first.id, launcher);
    const laneDir = getTask(first.id).workspace_path!;
    const branch = `kanban/${first.id}-origin-first`;
    writeFileSync(join(laneDir, "kept.txt"), "y\n");
    await git(laneDir, ["add", "kept.txt"]);
    await git(laneDir, ["commit", "-m", "keep"]);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.id);
    await git(repo, ["branch", "-d", "pre"]);
    const queued = createTask({
      project: "missing-origin",
      title: "origin-second",
      role: "executor",
      workspacePath: `lane:${repo}@pre`,
    });
    const held = await start(queued.id, launcher);
    assert.equal(held.message, `${(zhCN("labels.workspace.lane") + " ")}kanban-lane-1 ${zhCNPart("lane.prev", 0, 4)}${cardMark(first.id)} ${zhCNPart("lane.prevWithBranch", 11, 15)}kanban/${first.id}-origin-first ${zhCNPart("lane.unpushed", 16, 23)}`);
    assert.doesNotMatch(held.message, new RegExp(localePattern(zhCNPart("lane.cannotReadBranch", 10, 19))));
    assert.equal(getTask(queued.id).status, "ready");
    assert.equal(getTask(queued.id).blocked_kind, null);

    await git(laneDir, ["push", "origin", branch]);
    const reused = await start(queued.id, launcher);
    assert.match(reused.message, new RegExp(localePattern(zhCNPart("dispatch.started", 0, 3))));
    assert.equal(getTask(queued.id).status, "running");
    assert.equal((await git(laneDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), `kanban/${queued.id}-origin-second`);
  });

  it("treats a missing lane branch as deleted", async () => {
    const repo = await initRepo("gone-branch");
    allowLanes("gone-branch", { baseBranch: "main" });
    const { launcher } = laneLauncher("gone-branch");
    const task = createTask({ project: "gone-branch", title: "gone-branch", role: "executor", workspacePath: `lane:${repo}` });
    await start(task.id, launcher);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    const calls: string[][] = [];
    const run: GitRunner = async (cwd, args) => {
      calls.push(args);
      if (args[0] === "remote") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "branch" && args[1] === "--list") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "branch" && (args[1] === "-d" || args[1] === "-D")) return { code: 1, stdout: "", stderr: "branch not found" };
      return runGit(cwd, args);
    };
    const events: CleanupRecord[] = [];
    const record = (data: Omit<CleanupRecord, "at">) => {
      events.push({ ...data, at: new Date().toISOString() });
    };
    assert.equal(await settleLaneBranch({ task: getTask(task.id), events, now: new Date(), timeoutMs: 15_000, record, run }), "settled");
    assert.equal(calls.some((args) => args[0] === "branch" && args[1] === "-d"), false);
    assert.equal(events.some((event) => event.action === "delete_lane_branch" && event.ok === false), false);
    assert.equal(events.some((event) => event.action === "delete_lane_branch" && event.ok === true && event.branch === laneBranchName(task.id, task.title)), true);
  });

  it("backs off after a failed lane branch delete instead of retrying on every reconcile", async () => {
    const repo = await initRepo("backoff");
    allowLanes("backoff", { baseBranch: "main" });
    const { launcher } = laneLauncher("backoff");
    const task = createTask({ project: "backoff", title: "backoff-lane", role: "executor", workspacePath: `lane:${repo}` });
    await start(task.id, launcher);
    const laneDir = getTask(task.id).workspace_path!;
    writeFileSync(join(laneDir, "dirty.txt"), "x\n");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    const events: CleanupRecord[] = [];
    const record = (data: Omit<CleanupRecord, "at">) => {
      events.push({ ...data, at: new Date().toISOString() });
    };
    const now = new Date("2026-09-28T00:00:00.000Z");
    const row = getTask(task.id);
    assert.equal(await settleLaneBranch({ task: row, events, now, timeoutMs: 15_000, record }), "pending");
    const failed = events.filter((event) => event.action === "delete_lane_branch" && event.ok === false);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.error, zhCN("lane.uncommitted"));
    assert.ok(failed[0]?.retryAt);
    const retryAt = Date.parse(String(failed[0]?.retryAt));
    assert.equal(laneBranchDue(task.id, events, new Date(retryAt - 1000)), false);
    assert.equal(
      await settleLaneBranch({ task: row, events, now: new Date(retryAt - 1000), timeoutMs: 15_000, record }),
      "pending",
    );
    assert.equal(events.filter((event) => event.action === "delete_lane_branch").length, 1);
    const later = new Date(retryAt + 1000);
    assert.equal(laneBranchDue(task.id, events, later), true);
    assert.equal(await settleLaneBranch({ task: row, events, now: later, timeoutMs: 15_000, record }), "pending");
    assert.equal(events.filter((event) => event.action === "delete_lane_branch" && event.ok === false).length, 2);
    assert.equal(existsSync(laneDir), true);
  });
});
