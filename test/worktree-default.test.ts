/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, loadConfig, saveConfig, setProjectWorkspace, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { assertSafeGit } from "../server/git";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getDetail, getTask } from "../server/store";
import { setAgentAliveCheck } from "../server/wake";
import { workspaceLine } from "../shared/labels";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "wt-default-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function rememberWorktreeDefault(project: string, baseBranch: string): void {
  const config = loadConfig();
  config.projects = {
    ...(config.projects ?? {}),
    [project]: { defaultWorkspace: "worktree", baseBranch, worktreeLanes: 1, lanesEnabled: true },
  };
  saveConfig(config);
}

/** Cards already stored as a per-card worktree keep that path. New creates do not. */
function asLegacyWorktree(id: number, root: string, base: string): void {
  getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_path = ?, workspace_base = ? WHERE id = ?").run(root, base, id);
}

describe("project default workspace", () => {
  it("keeps a card in the directory when the project file still says worktree, unless the card asks for a lane", () => {
    const repo = join(dir, "demo");
    mkdirSync(repo, { recursive: true });
    rememberWorktreeDefault("demo_library", "pre");

    const executor = createTask({ project: "demo_library", title: "Edit documentation", role: "executor", workspacePath: repo });
    assert.equal(executor.workspace_kind, "dir");
    assert.equal(executor.workspace_path, repo);
    assert.equal(executor.workspace_base, null);
    assert.equal(getDetail(executor.id).task.branch, null);

    const batch = createTask({ project: "demo_library", title: "Batch", role: "batch", workspacePath: repo });
    assert.equal(batch.workspace_kind, "dir");

    const pinned = createTask({ project: "demo_library", title: "Explicit directory", role: "executor", workspacePath: `dir:${repo}` });
    assert.equal(pinned.workspace_kind, "dir");
    assert.equal(pinned.workspace_path, repo);
    assert.equal(pinned.workspace_base, null);
    assert.equal(workspaceLine({ kind: "dir", path: repo, base: null, branch: null }), `${(zhCN("labels.workspace.dir") + " ")}${repo}`);

    const reader = createTask({ project: "demo_library", title: "Reader", role: "reader", workspacePath: repo });
    assert.equal(reader.workspace_kind, "dir");
    const decision = createTask({ project: "demo_library", title: "Decision", role: "decision", workspacePath: repo });
    assert.equal(decision.workspace_kind, "dir");

    const lane = createTask({ project: "demo_library", title: "Use lane", role: "executor", workspacePath: `lane:${repo}@main` });
    assert.equal(lane.workspace_kind, "lane");
    assert.equal(lane.workspace_path, repo);
    assert.equal(lane.workspace_base, "main");

    assert.throws(
      () => createTask({ project: "demo_library", title: "worktree One word", role: "executor", workspacePath: "worktree" }),
      new RegExp(localePattern(zhCNPart("lane.needsRepo", 0, 8))),
    );
    assert.throws(
      () => createTask({ project: "demo_library", title: "lane One word", role: "executor", workspacePath: "lane" }),
      new RegExp(localePattern(zhCNPart("lane.needsRepo", 0, 8))),
    );
    assert.throws(
      () => createTask({ project: "demo_library", title: "Empty lane", role: "executor", workspacePath: "lane:" }),
      new RegExp(localePattern(zhCNPart("lane.needsRepo", 0, 8))),
    );

    const plain = createTask({ project: "plugin", title: "plugin", role: "executor", workspacePath: repo });
    assert.equal(plain.workspace_kind, "dir");
    assert.equal(plain.workspace_base, null);
    assert.equal(getDetail(plain.id).task.branch, null);
  });

  it("uses the project's baseBranch for lane:<path> and worktree:<path> without @, and main only when the project has none", () => {
    const repo = join(dir, "no-at");
    mkdirSync(repo, { recursive: true });
    setProjectWorkspace("gixyz2ar", { baseBranch: "pre", lanesEnabled: true });

    const bare = createTask({ project: "gixyz2ar", title: "No base branch", role: "executor", workspacePath: `lane:${repo}` });
    assert.equal(bare.workspace_kind, "lane");
    assert.equal(bare.workspace_path, repo);
    assert.equal(bare.workspace_base, "pre");

    const inline = createTask({ project: "gixyz2ar", title: "Recorded base", role: "executor", workspacePath: `worktree:${repo}@main` });
    assert.equal(inline.workspace_kind, "lane");
    assert.equal(inline.workspace_base, "main");

    const flag = createTask({ project: "gixyz2ar", title: "Argument base", role: "executor", workspacePath: `lane:${repo}`, workspaceBase: "dev" });
    assert.equal(flag.workspace_base, "dev");

    setProjectWorkspace("dir-project", { defaultWorkspace: "dir", baseBranch: "release", lanesEnabled: true });
    const dirProject = createTask({ project: "dir-project", title: "Directory project", role: "executor", workspacePath: `worktree:${repo}` });
    assert.equal(dirProject.workspace_kind, "lane");
    assert.equal(dirProject.workspace_base, "release");

    setProjectWorkspace("plain-lanes", { lanesEnabled: true });
    const unconfigured = createTask({ project: "plain-lanes", title: "No base branch", role: "executor", workspacePath: `lane:${repo}` });
    assert.equal(unconfigured.workspace_kind, "lane");
    assert.equal(unconfigured.workspace_base, "main");

    const omitted = createTask({ project: "gixyz2ar", title: "Sample text workspace", role: "executor" });
    assert.equal(omitted.workspace_kind, "none");
    assert.equal(omitted.workspace_path, null);
    const blank = createTask({ project: "gixyz2ar", title: "Empty string workspace", role: "executor", workspacePath: "  " });
    assert.equal(blank.workspace_kind, "none");
    assert.equal(blank.workspace_path, null);
  });

  it("starts an omitted workspace as none and does not capability-block it", async () => {
    const docs = join(dir, "omit-docs");
    mkdirSync(docs, { recursive: true });
    const omitted = createTask({ project: "omit-ws", title: "Sample text workspace", role: "executor" });
    assert.equal(omitted.workspace_kind, "none");
    assert.equal(omitted.workspace_path, null);
    const explicit = createTask({ project: "omit-ws", title: "Explicit none", role: "executor", workspacePath: "none" });
    assert.equal(explicit.workspace_kind, "none");
    assert.equal(explicit.workspace_path, null);

    const cwds: string[] = [];
    const launcher: AgentLauncher = {
      async create(options) {
        cwds.push(options.cwd);
        return { id: `omit-${cwds.length}` };
      },
      async send() {},
    };
    const options = { profiles: [executor], chosen: executor, reason: "Test" };
    await assert.rejects(() => startTask(omitted.id, launcher, "test", options), new RegExp(localePattern(zhCNPart("dispatch.executorCwdMissing", 5, 12))));
    assert.equal(getTask(omitted.id).status, "ready");
    assert.equal(getTask(omitted.id).blocked_kind, null);
    assert.equal(cwds.length, 0);

    const readable = createTask({ project: "omit-ws", title: "With directory none", role: "executor", workspacePath: `none:${docs}` });
    assert.equal(readable.workspace_kind, "none");
    await startTask(readable.id, launcher, "test", options);
    assert.equal(getTask(readable.id).status, "running");
    assert.equal(getTask(readable.id).blocked_kind, null);
    assert.deepEqual(cwds, [docs]);
  });
});

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, _stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve();
    });
  });
}

async function repoWithOrigin(name: string): Promise<{ local: string; origin: string }> {
  const local = join(dir, name);
  const origin = join(dir, `${name}.git`);
  mkdirSync(local, { recursive: true });
  await git(local, ["init", "-b", "pre"]);
  await git(local, ["config", "user.email", "t@example.com"]);
  await git(local, ["config", "user.name", "t"]);
  writeFileSync(join(local, "README"), "a\n");
  await git(local, ["add", "README"]);
  await git(local, ["commit", "-m", "init"]);
  await git(dir, ["init", "--bare", "-b", "pre", origin]);
  await git(local, ["remote", "add", "origin", origin]);
  await git(local, ["push", "origin", "pre"]);
  return { local, origin };
}

const pools: PoolSnapshot = {
  state: "fresh",
  message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
  generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
};
const reviewer: Profile = {
  id: "rv",
  name: zhCN("labels.role.reviewer"),
  role: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "sonnet",
  pool: "claude-max",
};

describe("fetch the base before a worktree", () => {
  it("rejects a forced delete or a push before git runs", () => {
    assert.throws(() => assertSafeGit(["worktree", "remove", "--force", "/tmp/x"]), new RegExp(localePattern(zhCNPart("git.refused.args", 0, 10))));
    assert.throws(() => assertSafeGit(["branch", "-D", "kanban/1-x"]), new RegExp(localePattern(zhCNPart("git.refused.args", 0, 10))));
    assert.throws(() => assertSafeGit(["push", "origin", "kanban/1-x"]), new RegExp(localePattern(zhCNPart("git.refused.args", 0, 10))));
  });

  it("fetches origin and branches from origin/pre, and does not start when fetch fails", async () => {
    const { local } = await repoWithOrigin("fetch-ok");
    await git(local, ["update-ref", "-d", "refs/remotes/origin/pre"]);
    const bases: string[] = [];
    const envs: Array<Record<string, string> | undefined> = [];
    const launcher: AgentLauncher = {
      async create(options) {
        envs.push(options.env);
        return { id: "agent-fetch" };
      },
      async send() {},
      async createWorktree(options) {
        bases.push(options.baseBranch);
        const path = join(dir, "made-wt");
        mkdirSync(path, { recursive: true });
        mkdirSync(join(path, ".git"));
        return { directory: path, workspaceId: "ws-fetch" };
      },
    };
    const task = createTask({ project: "fetch", title: "From remote", role: "executor", workspacePath: local });
    asLegacyWorktree(task.id, local, "pre");
    await startTask(task.id, launcher, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    assert.deepEqual(bases, ["origin/pre"]);
    assert.equal(envs[0]?.KANBAN_WORKTREE, "1");
    assert.equal(envs[0]?.KANBAN_ROLE, "executor");
    await git(local, ["rev-parse", "origin/pre"]);
    const created = getDetail(task.id).events.find((event) => event.kind === "worktree_created");
    assert.match(created?.data ?? "", /"ref":"origin\/pre"/);

    const broken = join(dir, "fetch-bad");
    mkdirSync(broken, { recursive: true });
    await git(broken, ["init", "-b", "pre"]);
    await git(broken, ["config", "user.email", "t@example.com"]);
    await git(broken, ["config", "user.name", "t"]);
    writeFileSync(join(broken, "README"), "b\n");
    await git(broken, ["add", "README"]);
    await git(broken, ["commit", "-m", "init"]);
    await git(broken, ["remote", "add", "origin", join(dir, "missing.git")]);
    const calls: string[] = [];
    const failing: AgentLauncher = {
      async create() {
        return { id: "should-not" };
      },
      async send() {},
      async createWorktree() {
        calls.push("create");
        return { directory: broken };
      },
    };
    const held = createTask({ project: "fetch", title: "Fetch fails", role: "executor", workspacePath: broken });
    asLegacyWorktree(held.id, broken, "pre");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE status = 'ready' AND id != ?").run(held.id);
    setAgentAliveCheck(() => true);
    setWakeSender(() => {
      throw new Error(("fetch " + zhCNPart("doctor.check.retry", 8, 11) + "Demo text<leader>"));
    });
    const config: KanbanConfig = {
      autoStart: { fetch: true },
      supervisorAgentId: "boss",
      supervisors: {},
      concurrency: { global: 5, pools: { ...DEFAULT_CONCURRENCY.pools, cursor: 5 }, roles: { ...DEFAULT_CONCURRENCY.roles, executor: 5 } },
    };
    const result = await runTick({
      profiles: [executor, reviewer],
      launcher: failing,
      config,
      pools,
      agentState: () => "alive",
    });
    assert.equal(result.started.includes(held.id), false);
    assert.equal(getTask(held.id).status, "ready");
    assert.deepEqual(calls, []);
    assert.match(getTask(held.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("readonlyWorktree.origin.fetchFailed", 0, 9)) + "\\/pre " + zhCN("compat.run.failed")));
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'board_wake'").get(held.id), undefined);
  });
});
