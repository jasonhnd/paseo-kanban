/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import { leaderActionNote } from "../server/protocol";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { kanbanHelp, runKanban } from "../server/cli";
import { lanesDisabledMessage, loadConfig, projectWorkspace, setProjectCode, setProjectSupervisor, setProjectWorkspace } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { AgentLauncher } from "../server/dispatch";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { runTick } from "./helpers/compat-schedule";
import { appendEvent, createTask, getTask } from "../server/store";
import { handleTool } from "../server/tools";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "lanes-off-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_POOL_STATUS = join(dir, "pool-status.json");
writeFileSync(process.env.KANBAN_POOL_STATUS, JSON.stringify({ generatedAt: new Date().toISOString(), pools: { alternate: { dispatchable: true } } }));

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  pool: "alternate",
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

const pools: PoolSnapshot = {
  state: "fresh",
  message: "test",
  generatedAt: null,
  updatedAt: new Date().toISOString(),
  ageMs: 0,
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};

const supervisor = { role: "supervisor", taskId: null, agentId: "boss" };
const supervisorEnv = { PASEO_AGENT_ID: "" };
const wakes: Array<{ id: string; text: string }> = [];

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

function countingLauncher(): { launcher: AgentLauncher; worktrees: string[] } {
  const worktrees: string[] = [];
  const launcher: AgentLauncher = {
    async create() {
      return { id: "should-not-open" };
    },
    async send() {},
    async createWorktree(options) {
      worktrees.push(options.branchName);
      const path = join(dir, `${options.branchName}-${worktrees.length}`);
      await git(options.cwd, ["worktree", "add", "-b", options.branchName, path, options.baseBranch]);
      return { directory: path, workspaceId: `ws-${options.branchName}`, name: options.branchName };
    },
  };
  return { launcher, worktrees };
}

after(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("lanes off by default", () => {
  it("rejects lane and worktree on createTask, the CLI, and kanban_create", async () => {
    // TEST_0273: a card no longer configures its project by writing a short code; configure it first.
    setProjectCode("closed", "CLO");
    assert.equal(projectWorkspace("closed").lanesEnabled, false);
    const forms = ["lane", "worktree", "lane:/tmp/repo", "worktree:/tmp/repo@main"];
    for (const workspacePath of forms) {
      assert.throws(
        () => createTask({ project: "closed", title: workspacePath, role: "executor", workspacePath }),
        new RegExp(lanesDisabledMessage()),
      );
    }
    const kept = createTask({ project: "closed", title: "Directory", role: "executor", workspacePath: `dir:${dir}` });
    assert.equal(kept.workspace_kind, "dir");
    // TEST_0188: an agent-bound <leader> creates only in a project it is registered for.
    setProjectSupervisor("closed", supervisor.agentId);

    await assert.rejects(
      () => runKanban(["create", "--project", "closed", "--title", zhCNPart("compat.name.cliToken", 0, 3), "--role", "executor", "--workspace", "lane:/tmp/repo"], supervisorEnv),
      new RegExp(lanesDisabledMessage()),
    );
    await assert.rejects(
      () =>
        handleTool(
          "kanban_create",
          { project: "closed", title: "demo fixture", role: "executor", workspace: "worktree:/tmp/repo" },
          null,
          supervisor,
        ),
      new RegExp(lanesDisabledMessage()),
    );
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE project = 'closed' AND workspace_kind = 'lane'").get() as { n: number };
    assert.equal(row.n, 0);
  });

  it("holds a ready lane card and wakes the creator once, without opening a lane", async () => {
    const repo = await initRepo("ready-repo");
    setProjectWorkspace("ready-lane", { lanesEnabled: true });
    const task = createTask({
      project: "ready-lane",
      title: "already-lane",
      role: "executor",
      workspacePath: `lane:${repo}`,
      createdByAgent: "creator-ready",
    });
    assert.equal(task.status, "ready");
    setProjectWorkspace("ready-lane", { lanesEnabled: false });
    setAgentAliveCheck(() => true);
    setWakeSender((id, text) => {
      wakes.push({ id, text });
    });
    const { launcher, worktrees } = countingLauncher();
    const first = await runTick({ profiles: [executor], pools, matrix: { state: "missing" }, launcher, agentState: () => "alive" });
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).hold_reason, lanesDisabledMessage());
    assert.equal(worktrees.length, 0);
    assert.equal(first.held.find((item) => item.id === task.id)?.reason, lanesDisabledMessage());
    assert.deepEqual(
      wakes.filter((item) => item.id === "creator-ready").map((item) => item.text),
      [[`${cardMark(task.id)} already-lane`, (zhCNPart("relatedView.field.project", 0, 3) + "ready-lane"), lanesDisabledMessage(), leaderActionNote()].join("\n")],
    );
    await runTick({ profiles: [executor], pools, matrix: { state: "missing" }, launcher, agentState: () => "alive" });
    assert.equal(wakes.filter((item) => item.id === "creator-ready").length, 1);
    assert.equal(worktrees.length, 0);
    const woke = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'lanes_disabled_woke'").get(task.id) as { n: number };
    assert.equal(woke.n, 1);
  });

  it("holds a waiting lane card with the same reason and does not open a lane", async () => {
    const repo = await initRepo("wait-repo");
    setProjectWorkspace("wait-lane", { lanesEnabled: true });
    const parent = createTask({ project: "wait-lane", title: "Parent", role: "executor", workspacePath: repo });
    const child = createTask({
      project: "wait-lane",
      title: "Still waiting",
      role: "executor",
      workspacePath: `lane:${repo}`,
      parentIds: [parent.id],
      createdByAgent: "creator-wait",
    });
    assert.equal(child.status, "waiting");
    setProjectWorkspace("wait-lane", { lanesEnabled: false });
    const { launcher, worktrees } = countingLauncher();
    await runTick({ profiles: [], pools, matrix: { state: "missing" }, launcher, agentState: () => "alive" });
    assert.equal(getTask(child.id).status, "waiting");
    assert.equal(getTask(child.id).hold_reason, lanesDisabledMessage());
    assert.equal(worktrees.length, 0);
    assert.equal(wakes.filter((item) => item.id === "creator-wait").length, 1);
  });

  it("leaves a running lane card alone, and still resumes one that is already bound", async () => {
    const room = join(dir, "running-room");
    mkdirSync(room, { recursive: true });
    setProjectWorkspace("live", { lanesEnabled: true });
    const running = createTask({
      project: "live",
      title: "Running",
      role: "executor",
      workspacePath: `lane:${room}`,
      createdByAgent: "creator-live",
    });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run("agent-live", running.id);
    const rework = createTask({
      project: "live",
      title: "Rework",
      role: "executor",
      workspacePath: `lane:${room}`,
      createdByAgent: "creator-live",
    });
    appendEvent(rework.id, "lane_bound", null, null, "scheduler", {
      lane: "kanban-lane-1",
      directory: room,
      branch: `kanban/${rework.id}-rework`,
      base: "main",
      root: room,
    });
    getDb()
      .prepare("UPDATE tasks SET status = 'rework', executor_agent_id = ?, executor_profile = ?, agent_id = NULL WHERE id = ?")
      .run("agent-rework", executor.name, rework.id);
    setProjectWorkspace("live", { lanesEnabled: false });
    const sent: string[] = [];
    const worktrees: string[] = [];
    const launcher: AgentLauncher = {
      async create() {
        throw new Error((zhCNPart("boardView.note.accept", 42, 44) + "Demo text agent"));
      },
      async send(agentId) {
        sent.push(agentId);
      },
      async createWorktree() {
        worktrees.push("created");
        throw new Error((zhCNPart("boardView.note.accept", 42, 44) + "Demo text"));
      },
    };
    await runTick({ profiles: [executor], pools, matrix: { state: "missing" }, launcher, agentState: () => "alive" });
    assert.equal(getTask(running.id).status, "running");
    assert.notEqual(getTask(running.id).hold_reason, lanesDisabledMessage());
    assert.equal(getTask(rework.id).status, "running");
    assert.deepEqual(sent, ["agent-rework"]);
    assert.equal(worktrees.length, 0);
  });

  it("opens a lane again after lanesEnabled is turned on", async () => {
    const repo = await initRepo("on-repo");
    setProjectWorkspace("lanes-on", { lanesEnabled: true, baseBranch: "main" });
    const task = createTask({ project: "lanes-on", title: "lane-on", role: "executor", workspacePath: `lane:${repo}` });
    assert.equal(task.workspace_kind, "lane");
    assert.equal(task.workspace_path, repo);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id != ? AND status NOT IN ('done', 'archived')").run(task.id);
    const { launcher, worktrees } = countingLauncher();
    const result = await runTick({ profiles: [executor, reviewer], pools, matrix: { state: "missing" }, launcher, agentState: () => "alive" });
    assert.ok(result.started.includes(task.id), JSON.stringify({ started: result.started, held: result.held, hold: getTask(task.id).hold_reason }));
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0], "kanban-lane-1");
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).paseo_workspace_id, "ws-kanban-lane-1");
  });

  it("changes lane count without turning lanes on, and records consent on --allow-lanes", async () => {
    assert.match(kanbanHelp(), /\u6253\u5f00\u4f1a\u65b0\u5efa\u4e00\u4e2a Paseo workspace\uff0c\u9700\u8981\u7528\u6237\u540c\u610f/);
    assert.match(String(await runKanban(["project", "--help"])), /\u6253\u5f00\u4f1a\u65b0\u5efa\u4e00\u4e2a Paseo workspace\uff0c\u9700\u8981\u7528\u6237\u540c\u610f/);
    const counted = (await runKanban(["project", "--project", "count-only", "--lanes", "4"], supervisorEnv)) as {
      worktreeLanes: number;
      lanesEnabled: boolean;
    };
    assert.equal(counted.worktreeLanes, 4);
    assert.equal(counted.lanesEnabled, false);
    assert.equal(loadConfig().projects?.["count-only"]?.lanesEnabled, false);
    await assert.rejects(
      () => runKanban(["project", "--project", "count-only", "--allow-lanes", "maybe"], supervisorEnv),
      new RegExp(zhCN("cli.project.onOff.allowLanes")),
    );
    const opened = (await runKanban(["project", "--project", "count-only", "--allow-lanes", "on"], supervisorEnv)) as {
      text: string;
      lanesEnabled: boolean;
      worktreeLanes: number;
    };
    assert.equal(opened.lanesEnabled, true);
    assert.equal(opened.worktreeLanes, 4);
    assert.match(opened.text, new RegExp(zhCN("cli.project.lanesAllowed")));
    const closed = (await runKanban(["project", "--project", "count-only", "--allow-lanes", "off"], supervisorEnv)) as {
      lanesEnabled: boolean;
      worktreeLanes: number;
    };
    assert.equal(closed.lanesEnabled, false);
    assert.equal(closed.worktreeLanes, 4);

    const file = JSON.parse(readFileSync(join(dir, "kanban.config.json"), "utf8")) as {
      projects: Record<string, { lanesEnabled?: boolean; worktreeLanes?: number; defaultWorkspace?: string; baseBranch?: string }>;
    };
    file.projects.legacy = { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 3 };
    writeFileSync(join(dir, "kanban.config.json"), `${JSON.stringify(file, null, 2)}\n`);
    assert.equal(projectWorkspace("legacy").lanesEnabled, false);
    assert.equal(projectWorkspace("legacy").worktreeLanes, 3);
  });
});
