import { selectedReviewRoute } from "./helpers/selected-review";
/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { invalidateAgentIndex } from "../server/agent-index";
import { formatAudit, performAudit, type AuditView } from "../server/audit";
import { runKanban } from "../server/cli";
import { setWakeSender } from "../server/bus";
import { cardMark } from "../server/card-ref";
import { drainCleanups, installCleanup, noteOverdueArchives, type CleanupOps } from "../server/cleanup";
import { DEFAULT_ARCHIVE_DEADLINE_MS, DEFAULT_CONCURRENCY, loadConfig, saveConfig, setProjectWorkspace } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { acceptTask, completeTask, rejectTask } from "../server/flow";
import { refOk, runGit, squashDeleteArgs } from "../server/git";
import { PLACEHOLDER_NAME, loadCwdAgents, pathWithin, resetMissingCwdForTests, setMissingCwdHooks } from "../server/missing-cwd";
import { cleanupOps } from "../server/paseo";
import { resetMergeCache, setGhRunner, writeContract } from "../server/pr";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { boardExtras } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { appendEvent, createTask, getDetail, getTask, listBoard } from "../server/store";
import { CLEANUP_BACKOFF_MS, readCleanupEvents } from "../server/archive-book";
import { listTempWorkspaces, overdueTempWorkspaces, settleTempWorkspace, suppressTempArchiveStuck, wipCommitMessage } from "../server/temp-workspace";
import { createdWorktree, deleteOwnedBranch, ownedWorktree, worktreeLanded } from "../server/worktree-gc";
import { formatResult } from "../server/tools";
import { actualWorktreeDirectory } from "../server/worktree-record";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";
import { freshCopyNote, tempBranchName } from "../server/workspace";

const tmp = realpathSync(tmpdir());
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "temp-ws-"));
const trees = join(dir, "paseo-worktrees");
const agents = join(dir, "agents");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_WORKTREES_ROOT = trees;
process.env.KANBAN_AGENTS_DIR = agents;
mkdirSync(dir, { recursive: true });
mkdirSync(trees, { recursive: true });
mkdirSync(agents, { recursive: true });

const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" };
const batch: Profile = { id: "bt", name: zhCN("labels.role.batch"), role: "batch", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" };
const reader: Profile = { id: "rd", name: zhCN("labels.role.reader"), role: "reader", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
const decision: Profile = { id: "dc", name: zhCN("labels.role.decision"), role: "decision", family: "anthropic", provider: "claude", model: "opus", pool: "claude-max" };
const reviewer: Profile = { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };

/** These ticks must not read the live pool file. A paused claude-max pool would hide the workspace assertion. */
const openPools: PoolSnapshot = {
  state: "fresh",
  message: "test",
  generatedAt: null,
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function launcher(): AgentLauncher & {
  prompts: string[];
  cwds: string[];
  trees: Array<{ branchName: string; baseBranch: string; title?: string; cwd: string }>;
} {
  const prompts: string[] = [];
  const cwds: string[] = [];
  const trees: Array<{ branchName: string; baseBranch: string; title?: string; cwd: string }> = [];
  let n = 0;
  return {
    prompts,
    cwds,
    trees,
    async create(options) {
      n += 1;
      prompts.push(options.prompt ?? "");
      cwds.push(options.cwd);
      return { id: `agent-${n}`, workspaceId: options.workspaceId };
    },
    async send() {},
    async createWorktree(options) {
      trees.push({ branchName: options.branchName, baseBranch: options.baseBranch, title: options.title, cwd: options.cwd });
      const path = join(dir, "trees", `${trees.length}`);
      mkdirSync(path, { recursive: true });
      return { directory: path, workspaceId: `ws-${trees.length}`, name: options.title ?? null, head: "a".repeat(40) };
    },
  };
}

function pick(role: Profile) {
  return { profiles: [executor, batch, reader, decision, reviewer], chosen: role, reason: "Test",
    ...(role.role === "reviewer" ? { routing: selectedReviewRoute([executor, batch, reader, decision, reviewer]) } : {}) };
}

after(() => {
  resetMissingCwdForTests();
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("temporary workspace at start", () => {
  it("uses the main directory when it is free, and does not add the fresh-copy line", async () => {
    const path = room("free");
    const box = launcher();
    const task = createTask({ project: "solo", title: "Edit separately", role: "executor", workspacePath: path });
    await startTask(task.id, box, "test", pick(executor));
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).workspace_kind, "dir");
    assert.equal(getTask(task.id).workspace_path, path);
    assert.equal(box.trees.length, 0);
    assert.equal(box.prompts.some((text) => text.includes(freshCopyNote())), false);
    assert.equal(getDetail(task.id).task.tempNote, null);
  });

  it("opens a temporary workspace named the card code when the main directory is taken", async () => {
    setProjectWorkspace("busy", { baseBranch: "develop" });
    const path = room("busy");
    const box = launcher();
    const holder = createTask({ project: "busy", title: "demo fixture", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const second = createTask({ project: "busy", title: "Parallel edit", role: "executor", workspacePath: path });
    const chore = createTask({ project: "busy", title: "Batch Demo text", role: "batch", workspacePath: path });
    await startTask(second.id, box, "test", pick(executor));
    await startTask(chore.id, box, "test", pick(batch));
    const code = cardMark(second.id);
    assert.equal(getTask(holder.id).workspace_kind, "dir");
    assert.equal(getTask(second.id).status, "running");
    assert.equal(getTask(second.id).workspace_kind, "worktree");
    assert.equal(getTask(second.id).paseo_workspace_name, code);
    assert.equal(getDetail(second.id).task.tempNote, `${zhCNPart("tempWorkspace.audit.latePrefix", 4, 17)}${code}${zhCNPart("tempMark.note.temp", 19, 28)}`);
    assert.equal(box.trees[0]?.title, code);
    assert.equal(box.trees[0]?.baseBranch, "develop");
    assert.equal(box.trees[0]?.branchName, `kanban/${code}-Parallel-edit`);
    assert.match(box.prompts.at(-2) ?? "", new RegExp(freshCopyNote()));
    assert.equal(getTask(chore.id).workspace_kind, "worktree");
    assert.equal(box.trees[1]?.title, cardMark(chore.id));
    assert.doesNotMatch(box.prompts[0] ?? "", new RegExp(freshCopyNote()));
  });

  it("does not open a workspace for a reader, a decision, or a reviewer", async () => {
    const path = room("read");
    const box = launcher();
    const holder = createTask({ project: "read", title: "Editing", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const copy = createTask({ project: "read", title: "demo fixture", role: "executor", workspacePath: path });
    await startTask(copy.id, box, "test", pick(executor));
    const copyDir = getTask(copy.id).workspace_path;
    const reading = createTask({ project: "read", title: "Reader", role: "reader", workspacePath: path });
    const deciding = createTask({ project: "read", title: "demo fixture", role: "decision", workspacePath: path });
    const review = createTask({ project: "read", title: "Sample text", role: "reviewer", workspacePath: path, reviewOf: copy.id });
    await startTask(reading.id, box, "test", pick(reader));
    await startTask(deciding.id, box, "test", pick(decision));
    await startTask(review.id, box, "test", pick(reviewer));
    assert.equal(box.trees.length, 1);
    assert.equal(getTask(reading.id).workspace_kind, "dir");
    assert.equal(getTask(reading.id).status, "running");
    assert.equal(getTask(deciding.id).status, "running");
    assert.equal(getTask(review.id).status, "reviewing");
    assert.equal(getTask(review.id).workspace_kind, "dir");
    assert.equal(box.cwds.at(-1), copyDir);
  });

  it("lets the scheduler open a temporary workspace instead of queueing", async () => {
    const path = room("tick");
    const box = launcher();
    const first = createTask({ project: "tick", title: "Edit first", role: "executor", workspacePath: path });
    const second = createTask({ project: "tick", title: "Edit later", role: "executor", workspacePath: path });
    const result = await runTick({
      profiles: [executor, reviewer],
      pools: openPools,
      launcher: box,
      config: {
        autoStart: { tick: true },
        supervisorAgentId: null,
        supervisors: {},
        concurrency: { global: 50, pools: { cursor: 50, "claude-max": 50 }, roles: { executor: 50, reviewer: 50 } },
        projects: { tick: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: true } },
      },
    });
    assert.ok(result.started.includes(first.id));
    assert.ok(result.started.includes(second.id));
    assert.equal(getTask(first.id).workspace_kind, "dir");
    assert.equal(getTask(second.id).workspace_kind, "worktree");
    assert.equal(box.trees[0]?.title, cardMark(second.id));
    assert.equal(box.trees[0]?.branchName, `kanban/${cardMark(second.id)}-Edit-later`);
  });

  it("queues when parallel is off", async () => {
    setProjectWorkspace("queued", { parallel: false });
    const path = room("queued");
    const box = launcher();
    const holder = createTask({ project: "queued", title: "demo fixture", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const second = createTask({ project: "queued", title: "demo fixture", role: "executor", workspacePath: path });
    await assert.rejects(() => startTask(second.id, box, "test", pick(executor)), new RegExp(zhCN("schedule.sameWorkspace")));
    assert.equal(getTask(second.id).status, "ready");
    assert.equal(box.trees.length, 0);
    const ticked = await runTick({
      profiles: [executor, reviewer],
      pools: openPools,
      launcher: box,
      config: {
        autoStart: { queued: true },
        supervisorAgentId: null,
        supervisors: {},
        concurrency: { global: 50, pools: { cursor: 50, "claude-max": 50 }, roles: { executor: 50, reviewer: 50 } },
        projects: { queued: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: false } },
      },
    });
    assert.equal(ticked.started.includes(second.id), false);
    assert.match(getTask(second.id).hold_reason ?? "", new RegExp(zhCN("schedule.sameWorkspace")));
  });

  it("stays on the directory when the worktree cannot be created", async () => {
    const path = room("fail-tree");
    const box = launcher();
    const holder = createTask({ project: "fail-tree", title: "demo fixture", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const second = createTask({ project: "fail-tree", title: "Sample text", role: "executor", workspacePath: path });
    box.createWorktree = async () => {
      throw new Error((zhCNPart("workspaceRecreate.claimLost", 15, 17) + zhCNPart("doctorLive.unreadable", 2, 3)));
    };
    await assert.rejects(() => startTask(second.id, box, "test", pick(executor)), new RegExp(localePattern(zhCNPart("workspaceRecreate.claimLost", 15, 17)) + localePattern(zhCNPart("doctorLive.unreadable", 2, 3))));
    assert.equal(getTask(second.id).status, "ready");
    assert.equal(getTask(second.id).workspace_kind, "dir");
    assert.equal(getTask(second.id).workspace_path, path);
    assert.equal(eventRows(second.id).some((row) => row.kind === "temp_workspace"), false);
    assert.equal(listTempWorkspaces().some((row) => row.id === second.id), false);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(holder.id);
    await startTask(second.id, box, "test", pick(executor));
    assert.equal(getTask(second.id).status, "running");
    assert.equal(getTask(second.id).workspace_kind, "dir");
    assert.equal(getTask(second.id).workspace_path, path);
  });

  it("does not divert a rework card onto a new worktree", async () => {
    const path = room("rework-busy");
    const box = launcher();
    const holder = createTask({ project: "rework-busy", title: "demo fixture", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const again = createTask({ project: "rework-busy", title: "Rework", role: "executor", workspacePath: path });
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(again.id);
    await assert.rejects(() => startTask(again.id, box, "test", pick(executor)), new RegExp(zhCN("schedule.sameWorkspace")));
    assert.equal(getTask(again.id).status, "rework");
    assert.equal(getTask(again.id).workspace_kind, "dir");
    assert.equal(box.trees.length, 0);
    const ticked = await runTick({
      profiles: [executor, reviewer],
      pools: openPools,
      launcher: box,
      config: {
        autoStart: { tick: true },
        supervisorAgentId: null,
        supervisors: {},
        concurrency: { global: 50, pools: { cursor: 50, "claude-max": 50 }, roles: { executor: 50, reviewer: 50 } },
        projects: { "rework-busy": { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: true } },
      },
    });
    assert.equal(ticked.started.includes(again.id), false);
    assert.equal(getTask(again.id).workspace_kind, "dir");
    assert.equal(box.trees.length, 0);
  });

  it("opens a temporary workspace when alwaysTemp is on even though the main directory is free", async () => {
    await runKanban(["project", "--project", "always-free", "--always-temp", "on"], { PASEO_AGENT_ID: "" });
    const path = room("always-free");
    const box = launcher();
    const task = createTask({ project: "always-free", title: "Temporary copy even when main is free", role: "executor", workspacePath: path });
    const chore = createTask({ project: "always-free", title: "Batch Demo text", role: "batch", workspacePath: path });
    await startTask(task.id, box, "test", pick(executor));
    await startTask(chore.id, box, "test", pick(batch));
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).workspace_kind, "worktree");
    assert.notEqual(getTask(task.id).workspace_path, path);
    assert.equal(getTask(task.id).paseo_workspace_name, cardMark(task.id));
    assert.equal(box.trees[0]?.cwd, path);
    assert.equal(box.trees[0]?.title, cardMark(task.id));
    assert.match(box.prompts[0] ?? "", new RegExp(freshCopyNote()));
    assert.equal(getTask(chore.id).workspace_kind, "worktree");
    assert.notEqual(getTask(chore.id).workspace_path, path);
    const reading = createTask({ project: "always-free", title: "Reader uses read-only copy", role: "reader", workspacePath: path });
    const review = createTask({
      project: "always-free",
      title: "Review stays in target directory",
      role: "reviewer",
      workspacePath: path,
      reviewOf: task.id,
    });
    await startTask(reading.id, box, "test", pick(reader));
    await startTask(review.id, box, "test", pick(reviewer));
    assert.equal(box.trees.length, 3);
    assert.equal(getTask(reading.id).workspace_kind, "worktree");
    assert.notEqual(getTask(reading.id).workspace_path, path);
    assert.equal(box.cwds.at(-2), getTask(reading.id).workspace_path);
    assert.equal(getTask(review.id).workspace_kind, "dir");
    assert.equal(box.cwds.at(-1), getTask(task.id).workspace_path);
  });

  it("keeps the main directory when alwaysTemp is off", async () => {
    await runKanban(["project", "--project", "always-off", "--always-temp", "off"], { PASEO_AGENT_ID: "" });
    const path = room("always-off");
    const box = launcher();
    const task = createTask({ project: "always-off", title: "Use main when disabled", role: "executor", workspacePath: path });
    await startTask(task.id, box, "test", pick(executor));
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).workspace_kind, "dir");
    assert.equal(getTask(task.id).workspace_path, path);
    assert.equal(box.trees.length, 0);
  });

  it("reuses the temporary directory on rework and isolates a legacy directory takeover", async () => {
    await runKanban(["project", "--project", "always-rework", "--always-temp", "on"], { PASEO_AGENT_ID: "" });
    const path = room("always-rework");
    const box = launcher();
    const task = createTask({ project: "always-rework", title: "Rework stays in temporary copy", role: "executor", workspacePath: path });
    await startTask(task.id, box, "test", pick(executor));
    const tempPath = getTask(task.id).workspace_path;
    assert.equal(getTask(task.id).workspace_kind, "worktree");
    assert.notEqual(tempPath, path);
    assert.equal(box.trees.length, 1);
    getDb().prepare("UPDATE tasks SET status = 'rework', agent_id = NULL, executor_agent_id = NULL WHERE id = ?").run(task.id);
    await startTask(task.id, box, "test", pick(executor));
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).workspace_kind, "worktree");
    assert.equal(getTask(task.id).workspace_path, tempPath);
    assert.equal(box.trees.length, 1);

    const mainBox = launcher();
    const stayed = createTask({ project: "rework-stay-dir", title: "Originally in main", role: "executor", workspacePath: path });
    await startTask(stayed.id, mainBox, "test", pick(executor));
    assert.equal(getTask(stayed.id).workspace_path, path);
    await runKanban(["project", "--project", "rework-stay-dir", "--always-temp", "on"], { PASEO_AGENT_ID: "" });
    getDb().prepare("UPDATE tasks SET status = 'rework', agent_id = NULL, executor_agent_id = NULL WHERE id = ?").run(stayed.id);
    await startTask(stayed.id, mainBox, "test", pick(executor));
    assert.equal(getTask(stayed.id).workspace_kind, "worktree");
    assert.notEqual(getTask(stayed.id).workspace_path, path);
    assert.equal(mainBox.trees.length, 1);
  });

  it("lets the scheduler open a temporary workspace when the main directory is free and alwaysTemp is on", async () => {
    await runKanban(["project", "--project", "always-tick", "--always-temp", "on", "--base", "develop"], { PASEO_AGENT_ID: "" });
    const path = room("always-tick");
    const box = launcher();
    const task = createTask({ project: "always-tick", title: "Scheduler uses temporary copy", role: "executor", workspacePath: path });
    const result = await runTick({
      profiles: [executor, reviewer],
      pools: openPools,
      launcher: box,
      config: {
        autoStart: { "always-tick": true },
        supervisorAgentId: null,
        supervisors: {},
        concurrency: { global: 50, pools: { cursor: 50, "claude-max": 50 }, roles: { executor: 50, reviewer: 50 } },
        projects: {
          "always-tick": { defaultWorkspace: "dir", baseBranch: "develop", worktreeLanes: 1, lanesEnabled: false, parallel: true, alwaysTemp: true },
        },
      },
    });
    assert.ok(result.started.includes(task.id));
    assert.equal(getTask(task.id).workspace_kind, "worktree");
    assert.notEqual(getTask(task.id).workspace_path, path);
    assert.equal(box.trees[0]?.baseBranch, "develop");
    assert.equal(box.trees[0]?.title, cardMark(task.id));
  });

  it("records the explicit --force exception even when alwaysTemp is on", async () => {
    await runKanban(["project", "--project", "always-force", "--always-temp", "on"], { PASEO_AGENT_ID: "" });
    const path = room("always-force");
    const box = launcher();
    const task = createTask({ project: "always-force", title: "demo fixture Demo text", role: "executor", workspacePath: path });
    await startTask(task.id, box, "test", { ...pick(executor), force: true });
    assert.equal(getTask(task.id).workspace_kind, "dir");
    assert.equal(getTask(task.id).workspace_path, path);
    assert.equal(startedForced(task.id), undefined);
    const second = createTask({ project: "always-force", title: "Forced temporary copy while occupied", role: "executor", workspacePath: path });
    await startTask(second.id, box, "test", { ...pick(executor), force: true });
    assert.equal(getTask(second.id).workspace_kind, "dir");
    assert.equal(getTask(second.id).workspace_path, path);
    assert.equal(startedForced(second.id), true);
    assert.equal(box.trees.length, 0);
    const exceptions = getDb().prepare("SELECT data_json FROM events WHERE task_id IN (?, ?) AND kind = 'main_workspace_exception'").all(task.id, second.id) as Array<{ data_json: string }>;
    assert.equal(exceptions.length, 2);
    assert.ok(exceptions.every((row) => JSON.parse(row.data_json).reason === "force"));
  });

  it("lets --force enter the main directory only when alwaysTemp is off", async () => {
    await runKanban(["project", "--project", "force-main", "--always-temp", "off", "--parallel", "off"], { PASEO_AGENT_ID: "" });
    const path = room("force-main");
    const box = launcher();
    const free = createTask({ project: "force-main", title: "Force main when free", role: "executor", workspacePath: path });
    await startTask(free.id, box, "test", { ...pick(executor), force: true });
    assert.equal(getTask(free.id).workspace_kind, "dir");
    assert.equal(getTask(free.id).workspace_path, path);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(free.id);
    const holder = createTask({ project: "force-main", title: "Main occupied", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const squeezed = createTask({ project: "force-main", title: "demo fixture Demo text", role: "executor", workspacePath: path });
    await startTask(squeezed.id, box, "test", { ...pick(executor), force: true });
    assert.equal(getTask(squeezed.id).workspace_kind, "dir");
    assert.equal(getTask(squeezed.id).workspace_path, path);
    assert.equal(startedForced(squeezed.id), true);
    assert.equal(box.trees.length, 0);
  });
});

const auditView: AuditView = {
  async listActiveAgents() {
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
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "README"), "a\n");
  await git(root, ["add", "README"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

function writeAgent(id: string, cwd: string, taskId = id.replace(/^agent-/, "")): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(
    join(agents, "bucket", `${id}.json`),
    JSON.stringify({
      id,
      cwd,
      title: id,
      provider: "cursor",
      labels: { kanban: "1", kanban_task: taskId },
      lastActivityAt: "2026-09-29T00:00:00.000Z",
    }),
  );
}

function agentFile(id: string): string {
  return join(agents, "bucket", `${id}.json`);
}

/** Missing agent file is reported as null. A thrown inspect is a failed query, covered separately. */
function inspectAgentFile(agentId: string): Promise<{ archived: boolean; busy: boolean } | null> {
  if (!existsSync(agentFile(agentId))) return Promise.resolve(null);
  return Promise.resolve({ archived: false, busy: false });
}

/** Paseo 0.10.1: refresh throws "Agent not found" for a deleted agent. It never returns a null agent. */
function daemonInspect(busy: (agentId: string) => boolean = () => false): NonNullable<CleanupOps["inspectAgent"]> {
  const ops = cleanupOps({
    agents: {
      ref(agentId: string) {
        return {
          async refresh() {
            if (!existsSync(agentFile(agentId))) throw new Error(`Agent not found: ${agentId}`);
            const running = busy(agentId);
            return {
              agent: {
                id: agentId,
                status: running ? "running" : "idle",
                archivedAt: null,
                activeTurn: running ? { id: "turn" } : null,
              },
            };
          },
          current() {
            return null;
          },
        };
      },
    },
  } as unknown as PaseoApi);
  if (!ops.inspectAgent) throw new Error("cleanupOps did not provide inspectAgent");
  return ops.inspectAgent;
}

/** The cleanup adapter. A connection error stays a failure even when the agent file looks idle. */
function connectionInspect(fail: (agentId: string) => boolean): NonNullable<CleanupOps["inspectAgent"]> {
  const ops = cleanupOps({
    agents: {
      ref(agentId: string) {
        return {
          async refresh() {
            if (fail(agentId)) throw new Error("connect ECONNREFUSED");
            if (!existsSync(agentFile(agentId))) throw new Error(`Agent not found: ${agentId}`);
            return { agent: { id: agentId, status: "idle", archivedAt: null, activeTurn: null } };
          },
          current() {
            return null;
          },
        };
      },
    },
  } as unknown as PaseoApi);
  if (!ops.inspectAgent) throw new Error("cleanupOps did not provide inspectAgent");
  return ops.inspectAgent;
}

function rememberTemp(id: number, root: string, branch: string, directory: string): void {
  const code = cardMark(id);
  getDb()
    .prepare(
      `UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main', workspace_path = ?, paseo_workspace_id = ?, paseo_workspace_name = ?, agent_id = ?, executor_agent_id = ? WHERE id = ?`,
    )
    .run(directory, `ws-${id}`, code, `agent-${id}`, `agent-${id}`, id);
  appendEvent(id, "temp_workspace", null, null, "test", { name: code, root, base: "main" });
  appendEvent(id, "worktree_created", null, null, "test", { directory, branch, base: "main", root, temp: true });
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(id, `agent-${id}`, new Date().toISOString());
  writeAgent(`agent-${id}`, directory);
}

function worktreeView(directory: string, root: string): CleanupOps["inspectWorkspace"] {
  return async (workspaceId) => ({
    id: workspaceId,
    name: workspaceId,
    directory,
    projectRoot: root,
    projectId: "p",
    kind: "worktree",
    archived: false,
  });
}

function quietTickConfig() {
  const config = loadConfig();
  const projects = getDb().prepare("SELECT DISTINCT project FROM tasks").all() as Array<{ project: string }>;
  const autoStart = { ...config.autoStart };
  for (const row of projects) autoStart[row.project] = false;
  return { ...config, autoStart, supervisorAgentId: config.supervisorAgentId, supervisors: { ...config.supervisors } };
}

function startedForced(id: number): boolean | undefined {
  const row = eventRows(id).find((item) => item.kind === "started");
  if (!row) return undefined;
  const data = JSON.parse(row.data_json) as { forced?: boolean };
  return data.forced;
}

function eventRows(id: number): Array<{ id: number; kind: string; data_json: string }> {
  return getDb().prepare("SELECT id, kind, data_json FROM events WHERE task_id = ? ORDER BY id").all(id) as Array<{
    id: number;
    kind: string;
    data_json: string;
  }>;
}

function cleanupAction(id: number, action: string, ok: boolean): number | undefined {
  return eventRows(id).find((row) => {
    if (row.kind !== "cleanup") return false;
    const data = JSON.parse(row.data_json) as { action?: string; ok?: boolean };
    return data.action === action && data.ok === ok;
  })?.id;
}

function cleanupRows(id: number): Array<Record<string, unknown>> {
  return eventRows(id)
    .filter((row) => row.kind === "cleanup")
    .map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

function markDone(id: number): void {
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
  appendEvent(id, "accept", "acceptance", "done", "test", {});
}

function observedBranch(id: number): { branch?: string; head?: string; pushed?: boolean } | null {
  const row = eventRows(id).filter((item) => item.kind === "branch_observed").at(-1);
  if (!row) return null;
  return JSON.parse(row.data_json) as { branch?: string; head?: string; pushed?: boolean };
}

/** Executor complete reads the worktree checkout. The card must already be running. */
function deliver(id: number): void {
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id);
  completeTask(id, "executor", "Submitted", { files: ["notes.txt"], verification: ["npm test"], risks: [(zhCN("doctor.object.plugin") + "Demo text")] });
}

function writePlaceholder(directory: string, agentId: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, PLACEHOLDER_NAME),
    [
      zhCN("missingCwd.placeholder.intro"),
      (zhCNPart("reclaimNote.cause", 0, 3) + zhCN("missingCwd.patrol.placed")),
      `agent${zhCN("common.colon")}${agentId}`,
      zhCN("missingCwd.placeholder.keep"),
      "",
    ].join("\n"),
  );
}

/** Workspace already gone, same as the cleanup skip that left only a placeholder behind. */
function goneWorkspace(): CleanupOps {
  return {
    async archiveAgent() {},
    async archiveWorkspace() {
      throw new Error(("workspace " + zhCN("cleanup.reason.gone") + zhCNPart("missingCwd.placeholder.blocks", 5, 7) + "Demo text"));
    },
    async listAgents() {
      return [];
    },
    async inspectWorkspace() {
      return null;
    },
  };
}

/** Squash onto main, then add another base commit so the branch tree is not the base tree. */
async function squashTemp(project: string, title: string): Promise<{ root: string; id: number; branch: string; directory: string; head: string }> {
  const root = await makeRepo(project);
  await git(root, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  const task = createTask({ project, title, role: "executor", workspacePath: root });
  const branch = tempBranchName(cardMark(task.id), title);
  const directory = join(trees, `${project}-card`);
  await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
  writeFileSync(join(directory, "feature.txt"), "x\n");
  await git(directory, ["add", "feature.txt"]);
  await git(directory, ["commit", "-m", "feature"]);
  await git(root, ["merge", "--squash", branch]);
  await git(root, ["commit", "-m", `squash ${project}`]);
  writeFileSync(join(root, "later.txt"), "y\n");
  await git(root, ["add", "later.txt"]);
  await git(root, ["commit", "-m", "later"]);
  rememberTemp(task.id, root, branch, directory);
  return { root, id: task.id, branch, directory, head: (await git(root, ["rev-parse", branch])).trim() };
}

/** Main has a commit the side branch does not. origin/main is that main tip until a later local commit. */
async function originAndSide(name: string): Promise<{ root: string; origin: string }> {
  const root = await makeRepo(name);
  const origin = join(dir, `${name}.git`);
  await git(dir, ["init", "--bare", "-b", "main", origin]);
  await git(root, ["checkout", "-b", "side"]);
  writeFileSync(join(root, "side.txt"), "s\n");
  await git(root, ["add", "side.txt"]);
  await git(root, ["commit", "-m", "side"]);
  await git(root, ["checkout", "main"]);
  writeFileSync(join(root, "main2.txt"), "m\n");
  await git(root, ["add", "main2.txt"]);
  await git(root, ["commit", "-m", "main2"]);
  await git(root, ["remote", "add", "origin", origin]);
  await git(root, ["push", "origin", "main"]);
  return { root, origin };
}

async function commitFile(directory: string, file: string, message: string): Promise<void> {
  writeFileSync(join(directory, file), `${message}\n`);
  await git(directory, ["add", file]);
  await git(directory, ["commit", "-m", message]);
}

async function cardOnMain(root: string, project: string, title: string): Promise<{ id: number; branch: string; directory: string }> {
  const task = createTask({ project, title, role: "executor", workspacePath: root });
  const branch = tempBranchName(cardMark(task.id), title);
  const directory = join(trees, `${project}-card`);
  await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
  rememberTemp(task.id, root, branch, directory);
  return { id: task.id, branch, directory };
}

async function landedTemp(project: string, title: string): Promise<{ root: string; id: number; branch: string; directory: string; agentId: string }> {
  const root = await makeRepo(project);
  const task = createTask({ project, title, role: "executor", workspacePath: root });
  const branch = tempBranchName(cardMark(task.id), title);
  const directory = join(trees, `${project}-card`);
  await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
  writeFileSync(join(directory, "landed.txt"), "x\n");
  await git(directory, ["add", "landed.txt"]);
  await git(directory, ["commit", "-m", "landed"]);
  await git(root, ["merge", "--ff-only", branch]);
  rememberTemp(task.id, root, branch, directory);
  return { root, id: task.id, branch, directory, agentId: `agent-${task.id}` };
}

function settlingOps(directory: string, root: string, inspect: CleanupOps["inspectAgent"]): { ops: CleanupOps; archives: () => number } {
  let archives = 0;
  return {
    archives: () => archives,
    ops: {
      async archiveAgent() {},
      async archiveWorkspace() {
        archives += 1;
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
      inspectAgent: inspect,
    },
  };
}

async function assertCleaned(root: string, id: number, branch: string, directory: string, archives: number): Promise<void> {
  assert.equal(archives, 1);
  assert.equal(existsSync(directory), false);
  assert.equal((await git(root, ["branch", "--list", branch])).trim(), "");
  assert.equal(
    loadCwdAgents().some((agent) => pathWithin(directory, agent.cwd)),
    false,
  );
  assert.ok(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"));
}

describe("temporary workspace pre-WIP safety", () => {
  before(() => {
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        rmSync(agentFile(agentId), { force: true });
      },
    });
  });

  async function dirtyCopy(name: string) {
    const card = await landedTemp(name, "safety");
    await git(card.directory, ["switch", "-c", `review-${name}`]);
    writeFileSync(join(card.directory, "README"), "staged review edit\n");
    await git(card.directory, ["add", "README"]);
    writeFileSync(join(card.directory, "README"), "unstaged review edit\n");
    writeFileSync(join(card.directory, "review-output.txt"), "untracked review output\n");
    markDone(card.id);
    return card;
  }

  async function snapshot(card: Awaited<ReturnType<typeof dirtyCopy>>) {
    // --no-optional-locks keeps this assertion's status read from refreshing the index.
    const status = await git(card.directory, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
    const index = (await git(card.directory, ["rev-parse", "--git-path", "index"])).trim();
    return {
      head: await git(card.directory, ["rev-parse", "HEAD"]),
      cardHead: await git(card.root, ["rev-parse", card.branch]),
      branch: await git(card.directory, ["symbolic-ref", "HEAD"]),
      status,
      index: readFileSync(index),
      tracked: readFileSync(join(card.directory, "README")),
      untracked: readFileSync(join(card.directory, "review-output.txt")),
    };
  }

  function borrowingReview(card: Awaited<ReturnType<typeof dirtyCopy>>, status = "reviewing") {
    const review = createTask({ project: getTask(card.id).project, title: "Borrow reviewer", role: "reviewer", workspacePath: card.directory });
    getDb().prepare("UPDATE tasks SET status = ?, paseo_workspace_id = ? WHERE id = ?").run(status, `ws-${card.id}`, review.id);
    return review.id;
  }

  function settleCopy(
    card: Awaited<ReturnType<typeof dirtyCopy>>,
    activity: NonNullable<Parameters<typeof settleTempWorkspace>[0]["agentActivity"]>,
    options: { task?: ReturnType<typeof getTask>; run?: Parameters<typeof settleTempWorkspace>[0]["run"] } = {},
  ) {
    const events = readCleanupEvents(card.id);
    const now = new Date();
    return settleTempWorkspace({
      task: options.task ?? getTask(card.id), events, now,
      record(data) {
        appendEvent(card.id, "cleanup", null, null, "test", data);
        events.push({ ...data, at: now.toISOString() });
      },
      agentActivity: activity,
      async archiveWorkspace() {
        rmSync(card.directory, { recursive: true, force: true });
      },
      decideWorkspace: async () => ({ action: "archive", workspaceId: `ws-${card.id}`, directory: card.directory }),
      run: options.run,
    });
  }

  async function assertUntouched(card: Awaited<ReturnType<typeof dirtyCopy>>, before: Awaited<ReturnType<typeof snapshot>>) {
    assert.deepEqual(await snapshot(card), before, "HEAD, checkout, index and file bytes must stay unchanged");
    assert.equal(existsSync(agentFile(card.agentId)), true);
    assert.equal(cleanupAction(card.id, "wip_commit", true), undefined);
    assert.equal(eventRows(card.id).some(row => row.kind === "temp_workspace_cleaned"), false);
  }

  it("leaves a dirty done owner's checkout untouched while a reviewing card borrows it", async () => {
    const card = await dirtyCopy("safety-borrowed");
    borrowingReview(card);
    const before = await snapshot(card);
    assert.equal(await settleCopy(card, async () => "idle"), "pending");
    await assertUntouched(card, before);
    assert.ok(cleanupRows(card.id).some(row => row.reason === "shared"));
  });

  for (const activity of ["busy", "unknown"] as const) {
    it(`leaves a dirty done owner's checkout untouched when its agent is ${activity}`, async () => {
      const card = await dirtyCopy(`safety-${activity}`);
      const before = await snapshot(card);
      assert.equal(await settleCopy(card, async () => activity), "pending");
      await assertUntouched(card, before);
      assert.ok(cleanupRows(card.id).some(row => row.action === (activity === "busy" ? "wait_turn" : "archive_agent")));
    });
  }

  it("rereads the owner instead of cleaning a stale done task snapshot", async () => {
    const card = await dirtyCopy("safety-stale-owner");
    const task = getTask(card.id);
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(card.id);
    const before = await snapshot(card);
    assert.equal(await settleCopy(card, async () => "idle", { task }), "pending");
    await assertUntouched(card, before);
  });

  for (const change of ["borrower", "owner"] as const) {
    it(`rereads ${change} state after awaiting the owner's agent activity`, async () => {
      const card = await dirtyCopy(`safety-activity-${change}`);
      const borrower = change === "borrower" ? borrowingReview(card, "done") : null;
      const before = await snapshot(card);
      assert.equal(await settleCopy(card, async () => {
        await Promise.resolve();
        if (borrower != null) getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(borrower);
        else getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(card.id);
        return "idle";
      }), "pending");
      await assertUntouched(card, before);
    });
  }

  for (const change of ["borrower", "owner"] as const) {
    it(`rereads ${change} state after the WIP checkout inspection before switching branches`, async () => {
      const card = await dirtyCopy(`safety-checkout-${change}`);
      const before = await snapshot(card);
      let changed = false;
      assert.equal(await settleCopy(card, async () => "idle", {
        async run(cwd, args) {
          const result = await runGit(cwd, args);
          if (!changed && args[0] === "branch" && args[1] === "--show-current") {
            changed = true;
            if (change === "borrower") borrowingReview(card);
            else getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(card.id);
          }
          return result;
        },
      }), "pending");
      assert.equal(changed, true);
      await assertUntouched(card, before);
    });
  }

  it("still saves a WIP and settles a dirty done copy when the owner is idle and nobody borrows it", async () => {
    const card = await dirtyCopy("safety-idle");
    let checked = false;
    assert.equal(await settleCopy(card, async () => {
      checked = true;
      return "idle";
    }, {
      async run(cwd, args) {
        if (["switch", "add", "commit"].includes(args[0]!)) assert.equal(checked, true, "agent activity must precede WIP writes");
        return runGit(cwd, args);
      },
    }), "settled");
    assert.equal(existsSync(card.directory), false);
    assert.equal(existsSync(agentFile(card.agentId)), false);
    assert.equal((await git(card.root, ["log", "-1", "--format=%s", card.branch])).trim(), wipCommitMessage(card.id));
    assert.equal(await git(card.root, ["show", `${card.branch}:README`]), "unstaged review edit\n");
    assert.equal(await git(card.root, ["show", `${card.branch}:review-output.txt`]), "untracked review output\n");
    assert.ok(eventRows(card.id).some(row => row.kind === "temp_workspace_cleaned"));
  });
});

describe("temporary workspace cleanup", () => {
  let blockDelete = false;
  const failOnce = new Set<string>();

  before(() => {
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        if (blockDelete || failOnce.delete(agentId)) throw new Error(zhCNPart("tempWorkspace.branch.notDeleted", 0, 3));
        rmSync(join(agents, "bucket", `${agentId}.json`), { force: true });
      },
    });
  });

  it("purges agents, archives, deletes the merged branch, then records the event", async () => {
    const root = await makeRepo("landed");
    const task = createTask({ project: "tidy", title: "landed", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "landed");
    const directory = join(trees, "landed-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "landed.txt"), "x\n");
    await git(directory, ["add", "landed.txt"]);
    await git(directory, ["commit", "-m", "landed"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    const agentFile = join(agents, "bucket", `agent-${task.id}.json`);
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        assert.equal(existsSync(agentFile), false);
        assert.match(await git(root, ["branch", "--list", branch]), new RegExp(branch));
        const bodies = getDb().prepare("SELECT body FROM comments WHERE task_id = ?").all(task.id) as Array<{ body: string }>;
        assert.ok(bodies.some((row) => row.body.includes(zhCNPart("missingCwd.purge.notesWritten", 0, 2))));
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
      const started = Date.now();
      await acceptTask(task.id);
      await drainCleanups();
      assert.ok(Date.now() - started < DEFAULT_ARCHIVE_DEADLINE_MS);
    } finally {
      release();
    }
    const purged = eventRows(task.id).find((row) => row.kind === "agent_purged")?.id;
    const archived = cleanupAction(task.id, "archive_workspace", true);
    const deleted = cleanupAction(task.id, "delete_branch", true);
    const cleaned = eventRows(task.id).find((row) => row.kind === "temp_workspace_cleaned")?.id;
    assert.ok(purged != null && archived != null && deleted != null && cleaned != null);
    assert.ok(purged < archived && archived < deleted && deleted < cleaned);
    assert.equal(existsSync(directory), false);
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), false);
    assert.equal((await git(root, ["branch", "--list", branch])).trim(), "");
    assert.equal(existsSync(agentFile), false);
    assert.equal(loadCwdAgents().some((agent) => agent.cwd === directory), false);
    assert.equal(getDetail(task.id).task.tempNote, null);
    const doneAt = getDb().prepare("SELECT at FROM events WHERE task_id = ? AND to_status = 'done'").get(task.id) as { at: string };
    assert.ok(Date.now() - Date.parse(doneAt.at) < DEFAULT_ARCHIVE_DEADLINE_MS);
    assert.equal(formatAudit(await performAudit(auditView)).includes(`${zhCN("tempWorkspace.audit.latePrefix")}${cardMark(task.id)}`), false);
  });

  it("deletes a placeholder directory after its agents are purged and finishes cleanup", async () => {
    const { root, id, directory, agentId } = await landedTemp("ph-purged", (zhCN("missingCwd.report.placeholder") + zhCNPart("compactEvents.verb.deleted", 0, 2)));
    await git(root, ["worktree", "remove", directory]);
    writePlaceholder(directory, agentId);
    appendEvent(id, "cwd_placeholder", null, null, "test", { agentId, path: directory, reason: "demo fixture" });
    markDone(id);
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(directory), false);
    assert.equal(existsSync(agentFile(agentId)), false);
    assert.equal(cleanupAction(id, "drop_directory", true) != null, true);
    assert.equal(eventRows(id).some((row) => row.kind === "cleanup_finished"), true);
    assert.equal(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });

  it("keeps a placeholder directory that holds anything besides its README", async () => {
    const { root, id, directory, agentId } = await landedTemp("ph-extra", (zhCNPart("tempWorkspace.drop.placeholderAgentsDeleted", 0, 3) + zhCNPart("wake.missingPr.dirty", 4, 6) + zhCNPart("paseoArchiving.error.directoryLeft", 91, 93)));
    await git(root, ["worktree", "remove", directory]);
    writePlaceholder(directory, agentId);
    writeFileSync(join(directory, "keep.txt"), "someone's work\n");
    appendEvent(id, "cwd_placeholder", null, null, "test", { agentId, path: directory, reason: "demo fixture" });
    markDone(id);
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(readFileSync(join(directory, "keep.txt"), "utf8"), "someone's work\n");
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), true);
    assert.equal(cleanupAction(id, "drop_directory", true), undefined);
    const failed = cleanupRows(id).find((row) => row.action === "drop_directory" && row.ok === false);
    assert.match(String(failed?.error ?? ""), new RegExp(localePattern(zhCNPart("tempWorkspace.placeholder.otherFiles", 0, 9))));
    assert.equal(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("keeps a placeholder reached through a symlink out of the worktrees root", async () => {
    const { root, id, directory, agentId } = await landedTemp("ph-link", (zhCN("missingCwd.report.placeholder") + "Demo text"));
    await git(root, ["worktree", "remove", directory]);
    const elsewhere = join(dir, "ph-link-elsewhere");
    writePlaceholder(elsewhere, agentId);
    symlinkSync(elsewhere, directory);
    appendEvent(id, "cwd_placeholder", null, null, "test", { agentId, path: directory, reason: "demo fixture" });
    markDone(id);
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(join(elsewhere, PLACEHOLDER_NAME)), true);
    assert.equal(cleanupAction(id, "drop_directory", true), undefined);
    assert.equal(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("cleans a missing .git worktree without touching another worktree (TEST_0276)", async () => {
    const { root, id, directory } = await landedTemp("missing-git", "missing git");
    const other = join(trees, "missing-git-other");
    await git(root, ["worktree", "add", "-b", "other-missing-git", other, "main"]);
    const otherGit = readFileSync(join(other, ".git"), "utf8");
    // The archive timed out after the clean/landed proof, then lost only .git.
    appendEvent(id, "cleanup", null, null, "test", {
      action: "wip_commit", directory, ok: true, landed: true, committed: false,
    });
    rmSync(join(directory, ".git"));
    markDone(id);
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(directory), false);
    assert.equal(readFileSync(join(other, ".git"), "utf8"), otherGit);
    const registered = await git(root, ["worktree", "list", "--porcelain"]);
    assert.equal(registered.includes(`worktree ${directory}\n`), false);
    assert.equal(registered.includes(`worktree ${other}\n`), true);
    assert.equal((await git(other, ["status", "--porcelain"])).trim(), "");
    assert.equal(cleanupRows(id).find(row => row.action === "drop_directory" && row.ok === true)?.reason, "missing_git");
    assert.equal(eventRows(id).some(row => row.kind === "cleanup_finished"), true);
  });

  for (const hazard of ["open card", "live agent", "restored git", "locked registration"] as const) {
    it(`keeps a missing .git directory with ${hazard} (TEST_0276)`, async (t) => {
      if (hazard === "live agent") {
        const previousTtl = process.env.KANBAN_AGENT_INDEX_TTL_MS;
        process.env.KANBAN_AGENT_INDEX_TTL_MS = "60000";
        invalidateAgentIndex();
        t.after(() => {
          if (previousTtl === undefined) delete process.env.KANBAN_AGENT_INDEX_TTL_MS;
          else process.env.KANBAN_AGENT_INDEX_TTL_MS = previousTtl;
          invalidateAgentIndex();
        });
      }
      const card = await landedTemp(`missing-git-${hazard.replaceAll(" ", "-")}`, "safety");
      const gitFile = readFileSync(join(card.directory, ".git"), "utf8");
      if (hazard === "locked registration") await git(card.root, ["worktree", "lock", card.directory]);
      appendEvent(card.id, "cleanup", null, null, "test", {
        action: "wip_commit", directory: card.directory, ok: true, landed: true, committed: false,
      });
      appendEvent(card.id, "cleanup", null, null, "test", { action: "purge_agents", ok: true });
      rmSync(agentFile(card.agentId));
      rmSync(join(card.directory, ".git"));
      markDone(card.id);
      const events = readCleanupEvents(card.id);
      const now = new Date();
      const result = await settleTempWorkspace({
        task: getTask(card.id), events, now,
        record(data) {
          appendEvent(card.id, "cleanup", null, null, "test", data);
          events.push({ ...data, at: now.toISOString() });
        },
        decideWorkspace: async () => ({ action: "skip", reason: "gone" }),
        async archiveWorkspace() { assert.fail("gone workspace must not archive"); },
        async run(cwd, args) {
          const result = await runGit(cwd, args);
          if (args[0] === "worktree" && args[1] === "prune") {
            if (hazard === "open card") createTask({ project: "missing-git-user", title: "borrow", role: "reader", workspacePath: card.directory });
            if (hazard === "live agent") writeAgent(`new-agent-${card.id}`, card.directory);
            if (hazard === "restored git") writeFileSync(join(card.directory, ".git"), gitFile);
          }
          return result;
        },
      });
      assert.equal(existsSync(card.directory), true);
      assert.equal(result, "pending");
      assert.equal(readFileSync(join(card.directory, "landed.txt"), "utf8"), "x\n");
      assert.equal(cleanupAction(card.id, "drop_directory", true), undefined);
      assert.equal(eventRows(card.id).some(row => row.kind === "temp_workspace_cleaned"), false);
    });
  }

  it("finishes cleanup when the worktree directory and the branch are already gone", async () => {
    const { root, id, branch, directory } = await landedTemp("gone-copy", "Gone");
    await git(root, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    await git(root, ["worktree", "remove", directory]);
    await git(root, ["branch", "-d", branch]);
    markDone(id);
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    const gone = cleanupRows(id).find((row) => row.action === "skip_worktree" && row.reason === "gone");
    assert.equal(gone?.ok, true);
    assert.equal(cleanupRows(id).some((row) => row.reason === "not_merged"), false);
    assert.equal(eventRows(id).some((row) => row.kind === "cleanup_finished"), true);
    assert.equal(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });

  it("does not archive the workspace of a card reopened while cleanup waited on Paseo (TEST_0268)", async () => {
    const { root, id, directory } = await landedTemp("reopen-before-archive", zhCNPart("flow.rework.unreadable", 2, 4));
    markDone(id);
    const box = settlingOps(directory, root, daemonInspect());
    const view = worktreeView(directory, root);
    const ops: CleanupOps = {
      ...box.ops,
      async inspectWorkspace(workspaceId) {
        // The leader reworks the card while cleanup is asking Paseo about its workspace.
        getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(id);
        return view(workspaceId);
      },
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(box.archives(), 0);
    assert.equal(existsSync(directory), true);
    assert.equal(cleanupRows(id).some((row) => row.action === "drop_directory"), false);
    assert.equal(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("does not remove the directory of a card reopened while its workspace was being archived (TEST_0268)", async () => {
    const { root, id, directory } = await landedTemp("reopen-before-drop", (zhCNPart("flow.rework.unreadable", 2, 4) + zhCNPart("doctor.cleanup.dropDirectory", 0, 3)));
    markDone(id);
    const box = settlingOps(directory, root, daemonInspect());
    const ops: CleanupOps = {
      ...box.ops,
      async archiveWorkspace() {
        // Paseo keeps the directory (another workspace still uses it) and the card is reopened meanwhile.
        getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(id);
      },
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(directory), true);
    assert.equal(cleanupRows(id).some((row) => row.action === "drop_directory"), false);
    assert.equal(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("removes the real copy when the recorded directory differs by a -1 suffix (TEST_0224)", async () => {
    const { root, id, branch, directory } = await landedTemp("suffix-copy", zhCNPart("nativeSessions.archive.badSuffix", 2, 4));
    const recordedDir = `${directory}-1`;
    getDb().prepare("UPDATE events SET data_json = ? WHERE task_id = ? AND kind = 'worktree_created'").run(
      JSON.stringify({ directory: recordedDir, branch, base: "main", root, temp: true }),
      id,
    );
    markDone(id);
    const box = settlingOps(directory, root, daemonInspect());
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(directory), false);
    assert.equal((await git(root, ["worktree", "list", "--porcelain"])).includes(directory), false);
    assert.equal((await git(root, ["branch", "--list", branch])).includes(branch), false);
    assert.equal(cleanupRows(id).some((row) => row.action === "skip_worktree" && row.reason === "gone"), false);
    assert.equal(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });

  it("archives the workspace in order when Paseo still reports the suffixed directory (TEST_0224)", async () => {
    const { root, id, branch, directory } = await landedTemp("suffix-snapshot", zhCNPart("schedule.poolsStale", 52, 55));
    const recordedDir = `${directory}-1`;
    getDb().prepare("UPDATE events SET data_json = ? WHERE task_id = ? AND kind = 'worktree_created'").run(
      JSON.stringify({ directory: recordedDir, branch, base: "main", root, temp: true }),
      id,
    );
    markDone(id);
    const box = settlingOps(directory, root, daemonInspect());
    const order: string[] = [];
    const ops: CleanupOps = {
      ...box.ops,
      async archiveWorkspace(workspaceId) {
        order.push("archive");
        await box.ops.archiveWorkspace(workspaceId);
      },
      inspectWorkspace: worktreeView(recordedDir, root),
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(box.archives(), 1);
    assert.equal(cleanupRows(id).some((row) => row.action === "skip_workspace"), false);
    assert.equal(existsSync(directory), false);
    const rows = eventRows(id);
    const archivedAt = rows.findIndex((row) => row.kind === "cleanup" && row.data_json.includes('"archive_workspace"') && row.data_json.includes('"ok":true'));
    const cleanedAt = rows.findIndex((row) => row.kind === "temp_workspace_cleaned");
    assert.ok(archivedAt >= 0 && cleanedAt > archivedAt);
  });

  it("still treats a suffixed record as gone when no worktree holds the branch (TEST_0224)", async () => {
    const { root, id, branch, directory } = await landedTemp("suffix-gone", (zhCNPart("nativeSessions.archive.badSuffix", 2, 4) + "Gone"));
    await git(root, ["worktree", "remove", directory]);
    await git(root, ["branch", "-d", branch]);
    getDb().prepare("UPDATE events SET data_json = ? WHERE task_id = ? AND kind = 'worktree_created'").run(
      JSON.stringify({ directory: `${directory}-1`, branch, base: "main", root, temp: true }),
      id,
    );
    markDone(id);
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(cleanupRows(id).find((row) => row.action === "skip_worktree" && row.reason === "gone")?.ok, true);
    assert.equal(eventRows(id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });

  it("records the directory git created when Paseo reports a -1 suffix (TEST_0224)", async () => {
    const { root, branch, directory } = await landedTemp("suffix-record", zhCNPart("dispatch.notRecorded", 1, 3));
    assert.equal(await actualWorktreeDirectory(root, branch, `${directory}-1`), directory);
    assert.equal(await actualWorktreeDirectory(root, branch, directory), directory);
    assert.equal(await actualWorktreeDirectory(root, "kanban/no-such-branch", `${directory}-1`), `${directory}-1`);
  });

  /** An unmerged card branch with one unique commit; the copy directory is then removed by hand. */
  async function unmergedTemp(project: string, title: string) {
    const root = await makeRepo(project);
    const task = createTask({ project, title, role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), title);
    const directory = join(trees, `${project}-card`);
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "unique.txt"), "x\n");
    await git(directory, ["add", "unique.txt"]);
    await git(directory, ["commit", "-m", "unique"]);
    rememberTemp(task.id, root, branch, directory);
    return { root, id: task.id, branch, directory };
  }

  for (const status of ["done", "archived"] as const) {
    it(`archives the workspace and keeps the unmerged branch when the copy directory is gone (${status})`, async () => {
      const card = await unmergedTemp(`dir-gone-${status}`, (zhCNPart("doctor.land.waitingSuggestion", 15, 18) + zhCNPart("doctorLive.unreadable", 2, 3)));
      await git(card.root, ["worktree", "remove", "--force", card.directory]);
      if (status === "done") markDone(card.id);
      else getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, card.id);
      // An earlier not_merged failure must not keep the card waiting or red in doctor.
      appendEvent(card.id, "cleanup", null, null, "kanban", {
        action: "skip_worktree", directory: card.directory, branch: card.branch, ok: false, reason: "not_merged",
        retryAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const box = settlingOps(card.directory, card.root, daemonInspect());
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      try {
        await drainCleanups();
      } finally {
        release();
      }
      assert.equal(box.archives(), 1);
      assert.equal((await git(card.root, ["branch", "--list", card.branch])).includes(card.branch), true);
      const keep = cleanupRows(card.id).find((row) => row.action === "keep_branch");
      assert.equal(keep?.reason, "directory_gone");
      assert.equal(keep?.branch, card.branch);
      assert.equal(cleanupRows(card.id).filter((row) => row.action === "skip_worktree").at(-1)?.ok, true);
      const cleaned = eventRows(card.id).find((row) => row.kind === "temp_workspace_cleaned");
      assert.ok(cleaned);
      assert.equal((JSON.parse(cleaned.data_json) as { keptBranch?: boolean }).keptBranch, true);
    });
  }

  it("archives the workspace when both the copy directory and the branch are gone and never merged", async () => {
    const card = await unmergedTemp("dir-branch-gone", (zhCNPart("doctor.agent.missing.nowhere", 8, 10) + zhCNPart("doctorLive.unreadable", 2, 3)));
    await git(card.root, ["worktree", "remove", "--force", card.directory]);
    await git(card.root, ["branch", "-D", card.branch]);
    markDone(card.id);
    const box = settlingOps(card.directory, card.root, daemonInspect());
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(box.archives(), 1);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "keep_branch"), false);
    assert.equal(cleanupRows(card.id).some((row) => row.reason === "not_merged"), false);
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });

  for (const variant of ["branch-kept", "branch-deleted", "branch-in-base"] as const) {
    it(`still backs off when the copy directory cannot be read (${variant})`, async () => {
      const card = await unmergedTemp(`dir-unreadable-${variant}`, zhCN("doctorLive.unreadable"));
      if (variant === "branch-in-base") await git(card.root, ["merge", "--ff-only", card.branch]);
      if (variant === "branch-deleted") {
        await git(card.root, ["worktree", "remove", "--force", card.directory]);
        await git(card.root, ["branch", "-D", card.branch]);
      }
      markDone(card.id);
      const box = settlingOps(card.directory, card.root, daemonInspect());
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      chmodSync(trees, 0o000);
      try {
        await drainCleanups();
      } finally {
        chmodSync(trees, 0o755);
        release();
      }
      assert.equal(box.archives(), 0);
      assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      assert.equal(cleanupRows(card.id).some((row) => row.ok === true && (row.reason === "directory_gone" || row.reason === "gone")), false);
      const failed = cleanupRows(card.id).find((row) => row.action === "skip_worktree" && row.ok === false);
      assert.equal(typeof failed?.retryAt, "string");
    });
  }

  it("keeps the old not_merged rule while the copy directory is still there", async () => {
    const card = await unmergedTemp("dir-present", zhCNPart("reclaimNote.result.running", 0, 2));
    markDone(card.id);
    const box = settlingOps(card.directory, card.root, daemonInspect());
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(box.archives(), 0);
    assert.equal(existsSync(card.directory), true);
    assert.equal(cleanupRows(card.id).some((row) => row.reason === "not_merged"), true);
    assert.equal(cleanupRows(card.id).some((row) => row.reason === "directory_gone"), false);
  });

  it("finishes cleanup without asking gh when the copy is gone and the contract already names a PR", async () => {
    const pr = "https://github.com/acme/widgets/pull/156";
    for (const kind of ["local-only", "github"] as const) {
      resetMergeCache();
      const { root, id, branch, directory } = await landedTemp(`gone-pr-${kind}`, (zhCNPart("boardView.done.prBrief", 7, 9) + zhCNPart("nativeSessions.skipLabel.excluded", 0, 2)));
      const contract =
        kind === "github"
          ? writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false })
          : writeContract({ kind: "local-only", repo: null, pr, awaiting: false });
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(contract, id);
      await git(root, ["worktree", "remove", directory]);
      await git(root, ["branch", "-d", branch]);
      let ghCalls = 0;
      setGhRunner(async () => {
        ghCalls += 1;
        throw new Error("mock gh unavailable");
      });
      markDone(id);
      const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
      try {
        await drainCleanups();
      } finally {
        setGhRunner(null);
        resetMergeCache();
        release();
      }
      assert.equal(ghCalls, 0, kind);
      const gone = cleanupRows(id).find((row) => row.action === "skip_worktree" && row.reason === "gone");
      assert.equal(gone?.ok, true, kind);
      assert.equal(cleanupRows(id).some((row) => row.reason === "not_merged"), false, kind);
      assert.equal(eventRows(id).some((row) => row.kind === "cleanup_finished"), true, kind);
    }
  });

  it("deletes a squash-merged branch when gh reports the pull request merged", async () => {
    resetMergeCache();
    const card = await squashTemp("squash-merged", "Squash");
    setGhRunner(async () =>
      JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-10-01T02:55:32Z",
        url: "https://github.com/acme/widgets/pull/156",
        headRefOid: card.head,
      }),
    );
    const box = settlingOps(card.directory, card.root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      setGhRunner(null);
      resetMergeCache();
      release();
    }
    assert.equal((await git(card.root, ["branch", "--list", card.branch])).trim(), "");
    assert.equal(cleanupRows(card.id).some((row) => row.reason === "not_merged"), false);
    assert.equal(cleanupAction(card.id, "delete_branch", true) != null, true);
    assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true);
  });

  it("keeps the branch and can retry when gh cannot say whether the pull request merged", async () => {
    resetMergeCache();
    const card = await squashTemp("squash-gh-down", zhCNPart("worktreeRecord.skip.commitsUnknown", 0, 3));
    let calls = 0;
    setGhRunner(async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP 502");
      return JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-10-01T02:55:32Z",
        url: "https://github.com/acme/widgets/pull/156",
        headRefOid: card.head,
      });
    });
    const box = settlingOps(card.directory, card.root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal((await git(card.root, ["branch", "--list", card.branch])).includes(card.branch), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), false);
      const skipped = cleanupRows(card.id).find((row) => row.action === "skip_worktree" && row.reason === "not_merged");
      assert.equal(skipped?.ok, false);
      assert.match(String(skipped?.error ?? ""), /HTTP 502/);
      assert.ok(skipped?.retryAt);
      await drainCleanups(new Date(start.getTime() + 61_000));
    } finally {
      setGhRunner(null);
      resetMergeCache();
      release();
    }
    assert.equal((await git(card.root, ["branch", "--list", card.branch])).trim(), "");
    assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true);
  });

  it("deletes a branch already in origin/<base> while the main directory is on another branch", async () => {
    const { root } = await originAndSide("origin-base");
    const card = await cardOnMain(root, "origin-base", "Base point");
    writeFileSync(join(root, "local-only.txt"), "later\n");
    await git(root, ["add", "local-only.txt"]);
    await git(root, ["commit", "-m", "local only"]);
    await git(root, ["checkout", "side"]);
    await assert.rejects(git(root, ["merge-base", "--is-ancestor", card.branch, "HEAD"]));
    await git(root, ["merge-base", "--is-ancestor", card.branch, "origin/main"]);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "side");
    assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "");
    const deleted = cleanupRows(card.id).find((row) => row.action === "delete_branch" && row.ok === true);
    assert.match(String(deleted?.reason ?? ""), new RegExp(localePattern(zhCNPart("worktreeGc.basis.inOriginBase", 0, 9)) + "\\/main"));
    assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true);
  });

  it("deletes a starting-point branch in origin/<base> when the merged PR head is a different commit", async () => {
    const otherHead = "a".repeat(40);
    for (const kind of ["local-only", "github"] as const) {
      resetMergeCache();
      const name = `pr-start-${kind}`;
      const { root } = await originAndSide(name);
      const card = await cardOnMain(root, name, "Base point");
      const tip = (await git(root, ["rev-parse", card.branch])).trim();
      assert.notEqual(tip, otherHead);
      writeFileSync(join(root, "local-only.txt"), "later\n");
      await git(root, ["add", "local-only.txt"]);
      await git(root, ["commit", "-m", "local only"]);
      await git(root, ["checkout", "side"]);
      await assert.rejects(git(root, ["merge-base", "--is-ancestor", card.branch, "HEAD"]));
      await git(root, ["merge-base", "--is-ancestor", card.branch, "origin/main"]);
      const pr = "https://github.com/acme/widgets/pull/684";
      const contract =
        kind === "github"
          ? writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false })
          : writeContract({ kind: "local-only", repo: null, pr, awaiting: false });
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(contract, card.id);
      setGhRunner(async (args) => {
        const fields = args[args.indexOf("--json") + 1] ?? "";
        if (fields === "headRefOid") return JSON.stringify({ headRefOid: otherHead });
        return JSON.stringify({ state: "MERGED", mergedAt: "2026-10-01T03:41:00Z" });
      });
      const box = settlingOps(card.directory, root, inspectAgentFile);
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      try {
        markDone(card.id);
        await drainCleanups();
      } finally {
        setGhRunner(null);
        resetMergeCache();
        release();
      }
      assert.equal((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "side", kind);
      assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "", kind);
      const deleted = cleanupRows(card.id).find((row) => row.action === "delete_branch" && row.ok === true);
      assert.match(String(deleted?.reason ?? ""), new RegExp(localePattern(zhCNPart("worktreeGc.basis.inOriginBase", 0, 9)) + "\\/main"), kind);
      assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true, kind);
    }
  });

  it("keeps unique commits when a merged PR head is a different commit", async () => {
    const otherHead = "b".repeat(40);
    for (const kind of ["local-only", "github"] as const) {
      resetMergeCache();
      const name = `pr-unique-${kind}`;
      const { root } = await originAndSide(name);
      const card = await cardOnMain(root, name, zhCNPart("worktreeGc.basis.noUniqueCommits", 2, 4));
      writeFileSync(join(card.directory, "only.txt"), "only\n");
      await git(card.directory, ["add", "only.txt"]);
      await git(card.directory, ["commit", "-m", "only"]);
      await git(root, ["checkout", "side"]);
      const pr = "https://github.com/acme/widgets/pull/685";
      const contract =
        kind === "github"
          ? writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false })
          : writeContract({ kind: "local-only", repo: null, pr, awaiting: false });
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(contract, card.id);
      setGhRunner(async (args) => {
        const fields = args[args.indexOf("--json") + 1] ?? "";
        if (fields === "headRefOid") return JSON.stringify({ headRefOid: otherHead });
        return JSON.stringify({ state: "MERGED", mergedAt: "2026-10-01T03:41:00Z" });
      });
      const box = settlingOps(card.directory, root, inspectAgentFile);
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      try {
        markDone(card.id);
        await drainCleanups();
      } finally {
        setGhRunner(null);
        resetMergeCache();
        release();
      }
      assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true, kind);
      assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch" && row.ok === true), false, kind);
      assert.equal(cleanupRows(card.id).some((row) => row.action === "keep_branch" && row.ok === true), true, kind);
    }
  });

  it("keeps a branch that matches an unpushed local squash but not origin/<base>", async () => {
    const { root } = await originAndSide("local-squash");
    const card = await cardOnMain(root, "local-squash", "Squash");
    writeFileSync(join(card.directory, "feature.txt"), "x\n");
    await git(card.directory, ["add", "feature.txt"]);
    await git(card.directory, ["commit", "-m", "feature"]);
    await git(root, ["merge", "--squash", card.branch]);
    await git(root, ["commit", "-m", "squash"]);
    await git(root, ["checkout", "side"]);
    await git(root, ["diff", "--quiet", "main", card.branch]);
    await assert.rejects(git(root, ["diff", "--quiet", "origin/main", card.branch]));
    assert.notEqual((await git(root, ["rev-list", "--count", `origin/main..${card.branch}`])).trim(), "0");
    const task = getTask(card.id);
    const owned = ownedWorktree(card.id, createdWorktree(card.id));
    assert.ok(owned);
    const landed = await worktreeLanded(task, owned, runGit);
    assert.equal(landed.landed, false);
    const deleted = await deleteOwnedBranch(task, owned, runGit);
    assert.equal(deleted.ok, false);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "side");
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    const skipped = cleanupRows(card.id).find((row) => row.action === "skip_worktree" && row.reason === "not_merged");
    assert.equal(skipped?.ok, false);
    assert.ok(skipped?.retryAt);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch" && row.ok === true), false);
    assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), false);
  });

  it("keeps a branch HEAD already contains when that tip is not the merged PR head and not in origin/<base>", async () => {
    resetMergeCache();
    const { root } = await originAndSide("head-extra");
    const card = await cardOnMain(root, "head-extra", "Extra");
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    await git(root, ["checkout", "side"]);
    await git(root, ["merge", card.branch]);
    await git(root, ["merge-base", "--is-ancestor", card.branch, "HEAD"]);
    assert.equal((await git(root, ["rev-list", "--count", `origin/main..${card.branch}`])).trim(), "1");
    const prHead = (await git(root, ["rev-parse", "origin/main"])).trim();
    const tip = (await git(root, ["rev-parse", card.branch])).trim();
    assert.notEqual(tip, prHead);
    const pr = "https://github.com/acme/widgets/pull/686";
    getDb()
      .prepare("UPDATE tasks SET contract_json = ? WHERE id = ?")
      .run(writeContract({ kind: "local-only", repo: null, pr, awaiting: false }), card.id);
    setGhRunner(async (args) => {
      const fields = args[args.indexOf("--json") + 1] ?? "";
      if (fields === "headRefOid") return JSON.stringify({ headRefOid: prHead });
      return JSON.stringify({ state: "MERGED", mergedAt: "2026-10-01T03:41:00Z" });
    });
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      setGhRunner(null);
      resetMergeCache();
      release();
    }
    assert.equal((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "side");
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch" && row.ok === true), false);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "keep_branch" && row.ok === true), true);
  });

  it("keeps a branch HEAD contains when fetch of origin/<base> fails", async () => {
    resetMergeCache();
    const { root } = await originAndSide("fetch-head");
    const card = await cardOnMain(root, "fetch-head", (zhCN("labels.identity.current") + zhCNPart("config.badCode", 8, 9)));
    await git(root, ["merge-base", "--is-ancestor", card.branch, "HEAD"]);
    await git(root, ["remote", "set-url", "origin", join(dir, "fetch-head-missing.git")]);
    const pr = "https://github.com/acme/widgets/pull/687";
    getDb()
      .prepare("UPDATE tasks SET contract_json = ? WHERE id = ?")
      .run(writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false }), card.id);
    setGhRunner(async (args) => {
      const fields = args[args.indexOf("--json") + 1] ?? "";
      if (fields === "headRefOid") return JSON.stringify({ headRefOid: "c".repeat(40) });
      return JSON.stringify({ state: "MERGED", mergedAt: "2026-10-01T03:41:00Z" });
    });
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      setGhRunner(null);
      resetMergeCache();
      release();
    }
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch" && row.ok === true), false);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "keep_branch" && row.ok === true), true);
  });

  it("deletes a branch already in origin/<base> while the pull request is still open", async () => {
    for (const kind of ["local-only", "github"] as const) {
      resetMergeCache();
      const name = `pr-open-${kind}`;
      const { root } = await originAndSide(name);
      const card = await cardOnMain(root, name, zhCNPart("worktreeGc.leftover.notMerged", 0, 2));
      await git(root, ["checkout", "side"]);
      await assert.rejects(git(root, ["merge-base", "--is-ancestor", card.branch, "HEAD"]));
      await git(root, ["merge-base", "--is-ancestor", card.branch, "origin/main"]);
      const pr = "https://github.com/acme/widgets/pull/688";
      const contract =
        kind === "github"
          ? writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false })
          : writeContract({ kind: "local-only", repo: null, pr, awaiting: false });
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(contract, card.id);
      setGhRunner(async () => JSON.stringify({ state: "OPEN", mergedAt: null, headRefOid: "d".repeat(40) }));
      const box = settlingOps(card.directory, root, inspectAgentFile);
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      try {
        markDone(card.id);
        await drainCleanups();
      } finally {
        setGhRunner(null);
        resetMergeCache();
        release();
      }
      assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "", kind);
      const deleted = cleanupRows(card.id).find((row) => row.action === "delete_branch" && row.ok === true);
      assert.match(String(deleted?.reason ?? ""), new RegExp(localePattern(zhCNPart("worktreeGc.basis.inOriginBase", 0, 9)) + "\\/main"), kind);
      assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true, kind);
    }
  });

  it("deletes a branch already in origin/<base> when gh cannot read the pull request", async () => {
    for (const kind of ["local-only", "github"] as const) {
      resetMergeCache();
      const name = `pr-gh-${kind}`;
      const { root } = await originAndSide(name);
      const card = await cardOnMain(root, name, zhCNPart("worktreeRecord.skip.commitsUnknown", 0, 3));
      await git(root, ["checkout", "side"]);
      const pr = "https://github.com/acme/widgets/pull/689";
      const contract =
        kind === "github"
          ? writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false })
          : writeContract({ kind: "local-only", repo: null, pr, awaiting: false });
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(contract, card.id);
      setGhRunner(async () => {
        throw new Error("HTTP 502");
      });
      const box = settlingOps(card.directory, root, inspectAgentFile);
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      try {
        markDone(card.id);
        await drainCleanups();
      } finally {
        setGhRunner(null);
        resetMergeCache();
        release();
      }
      assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "", kind);
      const deleted = cleanupRows(card.id).find((row) => row.action === "delete_branch" && row.ok === true);
      assert.match(String(deleted?.reason ?? ""), new RegExp(localePattern(zhCNPart("worktreeGc.basis.inOriginBase", 0, 9)) + "\\/main"), kind);
      assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true, kind);
    }
  });

  it("keeps a branch that still has commits origin/<base> does not", async () => {
    const { root } = await originAndSide("origin-unique");
    const card = await cardOnMain(root, "origin-unique", zhCNPart("worktreeGc.basis.noUniqueCommits", 2, 4));
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    await git(root, ["checkout", "side"]);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch"), false);
    const skipped = cleanupRows(card.id).find((row) => row.action === "skip_worktree" && row.reason === "not_merged");
    assert.equal(skipped?.ok, false);
    assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), false);
  });

  it("does not delete when fetch of origin/<base> fails, and retries after fetch works", async () => {
    const { root, origin } = await originAndSide("origin-fetch");
    const card = await cardOnMain(root, "origin-fetch", zhCNPart("settings.projects.waitParentPr", 4, 6));
    await git(root, ["remote", "set-url", "origin", join(dir, "origin-fetch-missing.git")]);
    await git(root, ["checkout", "side"]);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), false);
      const skipped = cleanupRows(card.id).find((row) => row.action === "skip_worktree" && row.reason === "not_merged");
      assert.equal(skipped?.ok, false);
      assert.match(String(skipped?.error ?? ""), new RegExp(localePattern(zhCNPart("readonlyWorktree.origin.fetchFailed", 0, 9)) + "\\/main"));
      assert.ok(skipped?.retryAt);
      await git(root, ["remote", "set-url", "origin", origin]);
      await drainCleanups(new Date(start.getTime() + 61_000));
    } finally {
      release();
    }
    assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "");
    const deleted = cleanupRows(card.id).find((row) => row.action === "delete_branch" && row.ok === true);
    assert.match(String(deleted?.reason ?? ""), new RegExp(localePattern(zhCNPart("worktreeGc.basis.inOriginBase", 0, 9)) + "\\/main"));
    assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true);
  });

  it("keeps a placeholder directory while a registered agent is still in Paseo", async () => {
    const { root, id, directory, agentId } = await landedTemp("ph-live", (zhCN("missingCwd.report.placeholder") + zhCNPart("reclaimNote.result.running", 0, 2)));
    await git(root, ["worktree", "remove", directory]);
    writePlaceholder(directory, agentId);
    appendEvent(id, "cwd_placeholder", null, null, "test", { agentId, path: directory, reason: "demo fixture" });
    appendEvent(id, "cleanup", null, null, "test", { action: "purge_agents", directory, ok: true });
    markDone(id);
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), true);
    assert.equal(existsSync(agentFile(agentId)), true);
    assert.equal(eventRows(id).some((row) => row.kind === "cleanup_finished"), false);
    const refused = cleanupRows(id).find((row) => row.action === "drop_directory" && row.ok === false);
    assert.match(String(refused?.error), new RegExp(zhCN("missingCwd.report.placeholder")));
  });

  it("keeps the workspace when the card goes back to rework", async () => {
    const root = await makeRepo("rework");
    const task = createTask({ project: "tidy", title: "rework", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "rework");
    const directory = join(trees, "rework-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    rememberTemp(task.id, root, branch, directory);
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    rejectTask(task.id, (zhCNPart("tempWorkspace.branch.keptAfterRetriesComment", 32, 34) + zhCNPart("cardParts.event.tierChanged", 0, 1)));
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        throw new Error((zhCN("labels.status.rework") + "Do not archive"));
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const release = installCleanup(ops);
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(getTask(task.id).status, "rework");
    assert.equal(existsSync(directory), true);
    assert.equal(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
    assert.equal((await git(root, ["branch", "--list", branch])).includes(branch), true);
  });

  it("commits a WIP and keeps the branch when an archived card has not landed", async () => {
    const root = await makeRepo("wip");
    const task = createTask({ project: "tidy", title: "wip", role: "executor", workspacePath: root });
    const code = cardMark(task.id);
    const branch = tempBranchName(code, "wip");
    const directory = join(trees, "wip-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "dirty.txt"), "not committed\n");
    rememberTemp(task.id, root, branch, directory);
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(task.id);
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(await git(root, ["log", branch, "-1", "--format=%s"]), `WIP: ${code} ${zhCNPart("tempWorkspace.wip.commitMessage", 12, 17)}\n`);
    assert.equal((await git(root, ["branch", "--list", branch])).includes(branch), true);
    const bodies = getDb().prepare("SELECT body FROM comments WHERE task_id = ?").all(task.id) as Array<{ body: string }>;
    assert.ok(bodies.some((row) => row.body.includes(branch)));
    assert.equal(existsSync(directory), false);
    assert.equal(cleanupAction(task.id, "delete_branch", true), undefined);
    const cleaned = eventRows(task.id).find((row) => row.kind === "temp_workspace_cleaned");
    assert.ok(cleaned);
    assert.equal((JSON.parse(cleaned.data_json) as { keptBranch?: boolean }).keptBranch, true);
  });

  it("keeps an archived GitHub branch with a WIP when no pull request exists", async () => {
    const { root } = await originAndSide("arch-gh-dirty");
    const card = await cardOnMain(root, "arch-gh-dirty", (zhCNPart("boardView.parentPr.archivedUnmerged", 4, 6) + "Dirty"));
    writeFileSync(join(card.directory, "dirty.txt"), "not committed\n");
    getDb()
      .prepare("UPDATE tasks SET status = 'archived', contract_json = ? WHERE id = ?")
      .run(writeContract({ kind: "github", repo: "acme/widgets", pr: null, awaiting: false }), card.id);
    setGhRunner(async () => {
      throw new Error(`no pull requests found for branch ${card.branch}`);
    });
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      setGhRunner(null);
      resetMergeCache();
      release();
    }
    assert.equal(await git(root, ["log", card.branch, "-1", "--format=%s"]), `WIP: ${cardMark(card.id)} ${zhCNPart("tempWorkspace.wip.commitMessage", 12, 17)}\n`);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(existsSync(card.directory), false);
    assert.equal(box.archives(), 1);
    assert.equal(cleanupRows(card.id).some((row) => row.reason === "not_merged"), false);
    const kept = cleanupRows(card.id).find((row) => row.action === "keep_branch" && row.ok === true);
    assert.equal(kept?.reason, "archived_keep_branch");
    const cleaned = JSON.parse(eventRows(card.id).find((row) => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}") as { reason?: string; keptBranch?: boolean };
    assert.equal(cleaned.reason, "archived_keep_branch");
    assert.equal(cleaned.keptBranch, true);
    assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true);
  });

  it("keeps a clean archived GitHub branch when no pull request exists", async () => {
    const { root } = await originAndSide("arch-gh-clean");
    const card = await cardOnMain(root, "arch-gh-clean", (zhCNPart("boardView.parentPr.archivedUnmerged", 4, 6) + zhCNPart("doctor.land.waitingSuggestion", 5, 6)));
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    const tip = (await git(root, ["rev-parse", card.branch])).trim();
    getDb()
      .prepare("UPDATE tasks SET status = 'archived', contract_json = ? WHERE id = ?")
      .run(writeContract({ kind: "github", repo: "acme/widgets", pr: null, awaiting: false }), card.id);
    setGhRunner(async () => {
      throw new Error(`no pull requests found for branch ${card.branch}`);
    });
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      setGhRunner(null);
      resetMergeCache();
      release();
    }
    assert.equal((await git(root, ["rev-parse", card.branch])).trim(), tip);
    assert.equal((await git(root, ["log", card.branch, "-1", "--format=%s"])).includes("WIP:"), false);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(existsSync(card.directory), false);
    assert.equal(box.archives(), 1);
    assert.equal(cleanupRows(card.id).some((row) => row.reason === "not_merged"), false);
    const kept = cleanupRows(card.id).find((row) => row.action === "keep_branch" && row.ok === true);
    assert.equal(kept?.reason, "archived_keep_branch");
    const wip = cleanupRows(card.id).find((row) => row.action === "wip_commit" && row.ok === true);
    assert.equal(wip?.committed, false);
    assert.equal(wip?.reason, "archived_keep_branch");
    assert.equal(eventRows(card.id).some((row) => row.kind === "cleanup_finished"), true);
  });

  it("keeps an archived branch and drops the directory when origin cannot be read", async () => {
    const { root } = await originAndSide("arch-fetch-fail");
    const card = await cardOnMain(root, "arch-fetch-fail", (zhCNPart("boardView.parentPr.archivedUnmerged", 4, 6) + zhCNPart("settings.projects.waitParentPr", 4, 6) + zhCN("compat.run.failed")));
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    const tip = (await git(root, ["rev-parse", card.branch])).trim();
    await git(root, ["remote", "set-url", "origin", join(dir, "arch-fetch-fail-missing.git")]);
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(card.id);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["rev-parse", card.branch])).trim(), tip);
    assert.equal(existsSync(card.directory), false);
    assert.equal(box.archives(), 1);
    assert.equal(cleanupRows(card.id).find((row) => row.action === "keep_branch" && row.ok === true)?.reason, "archived_keep_branch");
    assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch"), false);
    const cleaned = JSON.parse(eventRows(card.id).find((row) => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}") as { keptBranch?: boolean };
    assert.equal(cleaned.keptBranch, true);
  });

  for (const mode of ["fetch-fail", "ahead"] as const) {
    for (const status of ["archived", "done"] as const) {
      it(`${status} card, attached branch, uncommitted file, ${mode}`, async () => {
        const name = `dirty-${status}-${mode}`;
        const { root } = await originAndSide(name);
        const card = await cardOnMain(root, name, "Dirty");
        writeFileSync(join(card.directory, "only.txt"), "only\n");
        await git(card.directory, ["add", "only.txt"]);
        await git(card.directory, ["commit", "-m", "only"]);
        if (mode === "ahead") {
          await git(card.directory, ["push", "-u", "origin", card.branch]);
          await git(card.directory, ["commit", "--allow-empty", "-m", "local only"]);
        } else {
          await git(root, ["remote", "set-url", "origin", join(dir, `${name}-missing.git`)]);
        }
        writeFileSync(join(card.directory, "dirty.txt"), "not committed\n");
        await git(root, ["checkout", "side"]);
        const box = settlingOps(card.directory, root, inspectAgentFile);
        const release = installCleanup(box.ops, { timeoutMs: 5_000 });
        try {
          markDone(card.id);
          getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, card.id);
          await drainCleanups();
        } finally {
          release();
        }
        const collected = status === "archived";
        assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
        assert.equal(existsSync(card.directory), !collected);
        assert.equal(box.archives(), collected ? 1 : 0);
        assert.equal(cleanupRows(card.id).some((row) => row.action === "wip_commit" && row.ok === true && row.committed === true), collected);
        if (collected) {
          assert.equal(await git(root, ["log", card.branch, "-1", "--format=%s"]), `WIP: ${cardMark(card.id)} ${zhCNPart("tempWorkspace.wip.commitMessage", 12, 17)}\n`);
          assert.equal(cleanupRows(card.id).find((row) => row.action === "keep_branch")?.reason, "archived_keep_branch");
        }
      });
    }
  }

  it("keeps a done branch and the directory when origin cannot be read", async () => {
    const { root } = await originAndSide("done-fetch-fail");
    const card = await cardOnMain(root, "done-fetch-fail", (zhCN("labels.status.done") + zhCNPart("settings.projects.waitParentPr", 4, 6) + zhCN("compat.run.failed")));
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    await git(root, ["remote", "set-url", "origin", join(dir, "done-fetch-fail-missing.git")]);
    await git(root, ["checkout", "side"]);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(card.directory), true);
    assert.equal(box.archives(), 0);
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("wakes the leader for a done GitHub card without a pull request even with uncommitted files", async () => {
    resetMergeCache();
    const project = "gh-no-pr-dirty";
    const { root } = await originAndSide(project);
    const card = await cardOnMain(root, project, (zhCNPart("doctor.ready.suggestion", 27, 29) + "Dirty"));
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    writeFileSync(join(card.directory, "dirty.txt"), "not committed\n");
    await git(root, ["checkout", "side"]);
    getDb()
      .prepare("UPDATE tasks SET contract_json = ? WHERE id = ?")
      .run(writeContract({ kind: "github", repo: "acme/widgets", pr: null, awaiting: false }), card.id);
    const previous = loadConfig();
    saveConfig({
      ...previous,
      supervisorAgentId: "kanban-boss",
      supervisors: { ...previous.supervisors, [project]: "project-leader" },
      concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
    });
    setAgentAliveCheck((id) => id === "project-leader" || id === "kanban-boss");
    setWakeSender(() => undefined);
    resetBoardWakeForTests();
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    let now = new Date();
    try {
      markDone(card.id);
      await drainCleanups(now);
      for (const delay of CLEANUP_BACKOFF_MS) {
        now = new Date(now.getTime() + delay);
        await drainCleanups(now);
      }
      await drainCleanups(new Date(now.getTime() + 60 * 60_000));
    } finally {
      saveConfig(previous);
      resetAgentAliveCheck();
      resetBoardWakeForTests();
      release();
    }
    assert.equal(existsSync(card.directory), true);
    assert.equal(existsSync(join(card.directory, "dirty.txt")), true);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "wip_commit"), false);
    assert.equal(cleanupRows(card.id).filter((row) => row.reason === "not_merged").length, CLEANUP_BACKOFF_MS.length);
    assert.equal(cleanupRows(card.id).filter((row) => row.reason === "no_pr").length, 1);
    const wakes = eventRows(card.id).filter((row) => row.kind === "wake_missing_pr");
    assert.equal(wakes.length, 1);
    assert.match((JSON.parse(wakes[0]?.data_json ?? "{}") as { text?: string }).text ?? "", new RegExp(localePattern(zhCNPart("wake.missingPr.dirty", 1, 11))));
    assert.equal(box.archives(), 0);
  });

  it("does not collect a done GitHub branch while its pull request is still open", async () => {
    resetMergeCache();
    const { root } = await originAndSide("gh-open");
    const card = await cardOnMain(root, "gh-open", zhCNPart("worktreeGc.leftover.notMerged", 0, 2));
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    await git(root, ["checkout", "side"]);
    const pr = "https://github.com/acme/widgets/pull/701";
    getDb()
      .prepare("UPDATE tasks SET contract_json = ? WHERE id = ?")
      .run(writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false }), card.id);
    setGhRunner(async () => JSON.stringify({ state: "OPEN", mergedAt: null, url: pr, headRefOid: "e".repeat(40) }));
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    let now = start;
    try {
      markDone(card.id);
      await drainCleanups(now);
      for (const delay of CLEANUP_BACKOFF_MS) {
        now = new Date(now.getTime() + delay);
        await drainCleanups(now);
      }
    } finally {
      setGhRunner(null);
      resetMergeCache();
      release();
    }
    assert.equal(existsSync(card.directory), true);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
    assert.equal(cleanupRows(card.id).some((row) => row.reason === "no_pr"), false);
    assert.equal(eventRows(card.id).some((row) => row.kind === "wake_missing_pr"), false);
    const skipped = cleanupRows(card.id).filter((row) => row.action === "skip_worktree" && row.reason === "not_merged");
    assert.ok(skipped.length > CLEANUP_BACKOFF_MS.length);
    assert.equal(box.archives(), 0);
  });

  it("wakes the project leader when a done GitHub card never gets a pull request", async () => {
    resetMergeCache();
    const project = "gh-no-pr";
    const { root } = await originAndSide(project);
    const card = await cardOnMain(root, project, zhCNPart("doctor.ready.suggestion", 27, 29));
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    await git(root, ["checkout", "side"]);
    getDb()
      .prepare("UPDATE tasks SET contract_json = ? WHERE id = ?")
      .run(writeContract({ kind: "github", repo: "acme/widgets", pr: null, awaiting: false }), card.id);
    let ghCalls = 0;
    setGhRunner(async (args) => {
      if (args.includes(card.branch)) ghCalls += 1;
      throw new Error(`no pull requests found for branch ${card.branch}`);
    });
    const previous = loadConfig();
    saveConfig({
      ...previous,
      supervisorAgentId: "kanban-boss",
      supervisors: { ...previous.supervisors, [project]: "project-leader" },
      concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
    });
    setAgentAliveCheck((id) => id === "project-leader" || id === "kanban-boss");
    const sent: string[] = [];
    setWakeSender((id, text) => sent.push(`${id}\n${text}`));
    resetBoardWakeForTests();
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    let now = start;
    try {
      markDone(card.id);
      await drainCleanups(now);
      for (const delay of CLEANUP_BACKOFF_MS) {
        now = new Date(now.getTime() + delay);
        await drainCleanups(now);
      }
      noteOverdueArchives(now);
      await drainCleanups(new Date(now.getTime() + 60 * 60_000));
    } finally {
      setGhRunner(null);
      resetMergeCache();
      saveConfig(previous);
      resetAgentAliveCheck();
      resetBoardWakeForTests();
      release();
    }
    assert.equal(ghCalls, 0);
    assert.equal(existsSync(card.directory), true);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
    assert.equal(cleanupRows(card.id).filter((row) => row.reason === "not_merged").length, CLEANUP_BACKOFF_MS.length);
    assert.equal(cleanupRows(card.id).filter((row) => row.reason === "no_pr").length, 1);
    const wakes = eventRows(card.id).filter((row) => row.kind === "wake_missing_pr");
    assert.equal(wakes.length, 1);
    const wake = JSON.parse(wakes[0]?.data_json ?? "{}") as { text?: string; agentId?: string };
    assert.equal(wake.agentId, "project-leader");
    assert.match(wake.text ?? "", new RegExp(`${zhCNPart("tempWorkspace.missingPr.error", 0, 15)}${card.branch} ${zhCNPart("tempWorkspace.missingPr.error", 24, 31)}`));
    assert.equal(eventRows(card.id).some((row) => row.kind === "board_wake" && row.data_json.includes("archive_stuck")), false);
    assert.equal(sent.filter((text) => text.includes("project-leader") && text.includes(zhCNPart("tempWorkspace.missingPr.error", 0, 11))).length, 1);
    assert.equal(sent.some((text) => text.includes(cardMark(card.id)) && text.includes(zhCN("wake.board.archiveStuck"))), false);
    assert.equal(box.archives(), 0);
  });

  it("retries the no-PR wake until a live receiver takes it, then stops", async () => {
    resetMergeCache();
    const project = "gh-no-pr-retry";
    const { root } = await originAndSide(project);
    const card = await cardOnMain(root, project, "Uncollected");
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only"]);
    await git(root, ["checkout", "side"]);
    getDb()
      .prepare("UPDATE tasks SET contract_json = ? WHERE id = ?")
      .run(writeContract({ kind: "github", repo: "acme/widgets", pr: null, awaiting: false }), card.id);
    setGhRunner(async () => {
      throw new Error(`no pull requests found for branch ${card.branch}`);
    });
    const previous = loadConfig();
    saveConfig({
      ...previous,
      supervisorAgentId: "kanban-boss",
      supervisors: { ...previous.supervisors, [project]: "project-leader" },
      concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
    });
    let alive = false;
    setAgentAliveCheck((id) => alive && (id === "project-leader" || id === "kanban-boss"));
    const sent: string[] = [];
    setWakeSender((id, text) => sent.push(`${id}\n${text}`));
    resetBoardWakeForTests();
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    let now = new Date();
    const wakeRows = () => eventRows(card.id).filter((row) => row.kind === "wake_missing_pr");
    try {
      markDone(card.id);
      await drainCleanups(now);
      for (const delay of CLEANUP_BACKOFF_MS) {
        now = new Date(now.getTime() + delay);
        await drainCleanups(now);
      }
      await drainCleanups(new Date(now.getTime() + 60 * 60_000));
      // Nobody alive: cleanup recorded no_pr once, nothing was delivered, and the board still shows the problem.
      assert.equal(cleanupRows(card.id).filter((row) => row.reason === "no_pr").length, 1);
      assert.equal(sent.length, 0);
      assert.equal(wakeRows().some((row) => (JSON.parse(row.data_json) as { delivered?: boolean }).delivered === true), false);
      assert.equal(suppressTempArchiveStuck(card.id), false);
      alive = true;
      await drainCleanups(new Date(now.getTime() + 2 * 60 * 60_000));
      assert.equal(sent.filter((text) => text.includes(zhCNPart("tempWorkspace.missingPr.error", 0, 11))).length, 1);
      assert.equal(wakeRows().filter((row) => (JSON.parse(row.data_json) as { delivered?: boolean }).delivered === true).length, 1);
      assert.equal(suppressTempArchiveStuck(card.id), true);
      await drainCleanups(new Date(now.getTime() + 3 * 60 * 60_000));
      await drainCleanups(new Date(now.getTime() + 4 * 60 * 60_000));
      // Delivered once: no repeat, and no second no_pr record.
      assert.equal(sent.filter((text) => text.includes(zhCNPart("tempWorkspace.missingPr.error", 0, 11))).length, 1);
      assert.equal(cleanupRows(card.id).filter((row) => row.reason === "no_pr").length, 1);
    } finally {
      setGhRunner(null);
      resetMergeCache();
      saveConfig(previous);
      resetAgentAliveCheck();
      resetBoardWakeForTests();
      release();
    }
  });

  it("does not remove the directory when the agent cannot be deleted", async () => {
    const root = await makeRepo("stuck-agent");
    const task = createTask({ project: "tidy", title: "stuck", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "stuck");
    const directory = join(trees, "stuck-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "stuck.txt"), "x\n");
    await git(directory, ["add", "stuck.txt"]);
    await git(directory, ["commit", "-m", "stuck"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    blockDelete = true;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        throw new Error(("agent " + zhCNPart("rebind.error.unknown", 13, 18) + zhCN("labels.status.archived")));
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      await drainCleanups();
    } finally {
      release();
      blockDelete = false;
    }
    assert.equal(existsSync(directory), true);
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), false);
    assert.equal(existsSync(join(agents, "bucket", `agent-${task.id}.json`)), true);
    assert.equal(loadCwdAgents().some((agent) => agent.cwd === directory), true);
    assert.equal(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("lists a running temporary workspace without calling it overdue", async () => {
    const task = createTask({ project: "tidy", title: "still-running", role: "executor", workspacePath: dir });
    appendEvent(task.id, "temp_workspace", null, null, "test", { name: cardMark(task.id) });
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
    const text = formatAudit(await performAudit(auditView));
    assert.match(text, new RegExp(`${zhCNPart("tempWorkspace.audit.latePrefix", 4, 17)}${cardMark(task.id)}${zhCNPart("missingCwd.none", 0, 1)}${zhCN("labels.status.running")}${zhCNPart("missingCwd.none", 3, 4)}`));
    assert.equal(text.includes(`${zhCN("tempWorkspace.audit.latePrefix")}${cardMark(task.id)}`), false);
  });

  it("lists an overdue temporary workspace and wakes the supervisor once", async () => {
    const root = await makeRepo("late");
    const task = createTask({ project: "tidy", title: "late", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "late");
    const directory = join(trees, "late-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "late.txt"), "x\n");
    await git(directory, ["add", "late.txt"]);
    await git(directory, ["commit", "-m", "late"]);
    rememberTemp(task.id, root, branch, directory);
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        throw new Error((zhCNPart("boardView.waiting.parentsDone", 16, 21) + "Do not archive"));
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "supervisor", {});
      await drainCleanups();
      assert.equal(existsSync(directory), true);
      assert.equal(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      const early = formatAudit(await performAudit(auditView));
      assert.equal(early.includes(`${zhCN("tempWorkspace.audit.latePrefix")}${cardMark(task.id)}`), false);

      const doneAt = new Date(Date.now() - DEFAULT_ARCHIVE_DEADLINE_MS - 1000).toISOString();
      getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND to_status = 'done'").run(doneAt, task.id);
      const sent: string[] = [];
      saveConfig({
        ...loadConfig(),
        supervisorAgentId: "kanban-boss",
        archiveDeadlineMs: DEFAULT_ARCHIVE_DEADLINE_MS,
        concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
      });
      setAgentAliveCheck((id) => id === "kanban-boss");
      setWakeSender((_id, text) => sent.push(text));
      resetBoardWakeForTests();
      noteOverdueArchives();
      noteOverdueArchives();
      assert.equal(sent.filter((text) => text.includes(`${zhCN("tempWorkspace.audit.latePrefix")}${cardMark(task.id)}`)).length, 1);
      const late = formatAudit(await performAudit(auditView));
      assert.match(late, new RegExp(`${zhCN("tempWorkspace.audit.latePrefix")}${cardMark(task.id)}${zhCNPart("tempMark.note.temp", 19, 22)}${zhCNPart("missingCwd.none", 3, 4)}`));
      assert.match(boardExtras().tempWorkspaceMessage ?? "", new RegExp(`${zhCN("tempWorkspace.audit.latePrefix")}${cardMark(task.id)}`));
    } finally {
      release();
      resetAgentAliveCheck();
      resetBoardWakeForTests();
    }
  });

  it("closes a temp mark that never got a worktree", async () => {
    const path = room("orphan-mark");
    const task = createTask({ project: "orphan", title: "Creation failed", role: "executor", workspacePath: path });
    appendEvent(task.id, "temp_workspace", null, null, "test", { name: cardMark(task.id), root: path, base: "main" });
    getDb().prepare("UPDATE tasks SET status = 'archived', workspace_kind = 'worktree', paseo_workspace_id = 'main-ws' WHERE id = ?").run(task.id);
    let archived = false;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        archived = true;
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const release = installCleanup(ops);
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(archived, false);
    const cleaned = eventRows(task.id).find((row) => row.kind === "temp_workspace_cleaned");
    assert.ok(cleaned);
    assert.equal((JSON.parse(cleaned.data_json) as { reason?: string }).reason, "no_worktree");
    assert.equal(listTempWorkspaces().some((row) => row.id === task.id), false);
  });

  it("does not archive the main workspace while removing the temporary worktree", async () => {
    const root = await makeRepo("main-ws");
    const task = createTask({ project: "guard", title: "guard", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "guard");
    const directory = join(trees, "guard-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "guard.txt"), "x\n");
    await git(directory, ["add", "guard.txt"]);
    await git(directory, ["commit", "-m", "guard"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    let archived = false;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        archived = true;
        throw new Error("Do not archive main workspace");
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace(workspaceId) {
        return { id: workspaceId, name: "main", directory: root, projectRoot: root, projectId: "p", kind: "local", archived: false };
      },
    };
    const release = installCleanup(ops);
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(archived, false);
    assert.equal(existsSync(directory), false);
    assert.equal(existsSync(join(root, "README")), true);
    assert.ok(cleanupAction(task.id, "skip_workspace", true));
    assert.ok(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"));
  });

  it("records one cleanup failure row, and a retry after the backoff updates it in place", async () => {
    blockDelete = true;
    const root = await makeRepo("backoff");
    const task = createTask({ project: "backoff", title: "backoff", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "backoff");
    const directory = join(trees, "backoff-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "b.txt"), "x\n");
    await git(directory, ["add", "b.txt"]);
    await git(directory, ["commit", "-m", "b"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    const failed = (id: number) =>
      eventRows(id).filter((row) => {
        if (row.kind !== "cleanup") return false;
        const data = JSON.parse(row.data_json) as { action?: string; ok?: boolean };
        return data.action === "purge_agents" && data.ok === false;
      });
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        throw new Error((zhCNPart("cardDrawer.handoff.none", 0, 2) + zhCNPart("missingCwd.placeholder.keep", 32, 34) + " agent"));
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const release = installCleanup(ops);
    const start = new Date();
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups(start);
      await drainCleanups(start);
      assert.equal(failed(task.id).length, 1);
      await drainCleanups(new Date(start.getTime() + 61_000));
      const rows = failed(task.id);
      assert.equal(rows.length, 1, "the retry updates the failure row instead of adding another");
      assert.equal((JSON.parse(rows[0]!.data_json) as { attempts?: number }).attempts, 2);
      assert.equal(existsSync(directory), true);
    } finally {
      blockDelete = false;
      release();
    }
  });

  it("uses the latest completion when deciding the cleanup deadline", () => {
    const path = room("reopened");
    const task = createTask({ project: "reopened", title: "demo fixture", role: "executor", workspacePath: path });
    appendEvent(task.id, "temp_workspace", null, null, "test", { name: cardMark(task.id), root: path, base: "main" });
    appendEvent(task.id, "accept", "acceptance", "done", "test", {});
    const old = new Date(Date.now() - DEFAULT_ARCHIVE_DEADLINE_MS - 60_000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND to_status = 'done'").run(old, task.id);
    appendEvent(task.id, "reopen", "done", "ready", "test", {});
    appendEvent(task.id, "accept", "acceptance", "done", "test", {});
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    assert.equal(listTempWorkspaces().find((item) => item.id === task.id)?.late, false);
  });

  it("does not report a temporary workspace as overdue while an unfinished card still borrows it", () => {
    const path = room("borrowed");
    const task = createTask({ project: "borrowed", title: "Reader", role: "reader", workspacePath: path });
    const reviewer = createTask({ project: "borrowed", title: "Reviewer", role: "reviewer", workspacePath: path });
    appendEvent(task.id, "temp_workspace", null, null, "test", { name: cardMark(task.id), root: path, base: "main" });
    getDb().prepare("UPDATE tasks SET paseo_workspace_id = 'ws-shared' WHERE id IN (?, ?)").run(task.id, reviewer.id);
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    appendEvent(task.id, "accept", "acceptance", "done", "test", {});
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(reviewer.id);
    const old = new Date(Date.now() - DEFAULT_ARCHIVE_DEADLINE_MS - 60_000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND to_status = 'done'").run(old, task.id);
    assert.equal(listTempWorkspaces().find((item) => item.id === task.id)?.late, false);
    assert.equal(overdueTempWorkspaces().some((item) => item.taskId === task.id), false);

    // The borrower finishes just now: the clock restarts from that moment.
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(reviewer.id);
    appendEvent(reviewer.id, "accept", "reviewing", "done", "test", {});
    assert.equal(listTempWorkspaces().find((item) => item.id === task.id)?.late, false);
    const later = new Date(Date.now() + DEFAULT_ARCHIVE_DEADLINE_MS + 60_000);
    assert.equal(listTempWorkspaces(later).find((item) => item.id === task.id)?.late, true);
    assert.equal(overdueTempWorkspaces(later).some((item) => item.taskId === task.id), true);
  });

  it("deletes a temporary branch whose card title is Chinese", async () => {
    const root = await makeRepo("han");
    const task = createTask({ project: "han", title: zhCN("language.selfName"), role: "executor", workspacePath: root });
    const code = cardMark(task.id);
    const branch = tempBranchName(code, task.title);
    assert.equal(branch, `kanban/${code}-task`);
    assert.equal(refOk(branch), true);
    assert.deepEqual(squashDeleteArgs(task.id, branch), ["branch", "-D", branch]);
    const directory = join(trees, "han-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "han.txt"), "x\n");
    await git(directory, ["add", "han.txt"]);
    await git(directory, ["commit", "-m", "han"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
      await acceptTask(task.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["branch", "--list", branch])).trim(), "");
    assert.ok(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"));
  });

  it("waits while another open card shares the workspace", async () => {
    const root = await makeRepo("share-open");
    const task = createTask({ project: "share-open", title: "shared", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "shared");
    const directory = join(trees, "share-open-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "shared.txt"), "x\n");
    await git(directory, ["add", "shared.txt"]);
    await git(directory, ["commit", "-m", "shared"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    const sibling = createTask({ project: "share-open", title: "Still reviewing", role: "reviewer", workspacePath: directory });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', paseo_workspace_id = ? WHERE id = ?").run(`ws-${task.id}`, sibling.id);
    let archived = false;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        archived = true;
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
    };
    const release = installCleanup(ops);
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(archived, false);
    assert.equal(existsSync(directory), true);
    assert.equal(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
    assert.ok(eventRows(task.id).some((row) => row.kind === "cleanup" && row.data_json.includes("shared")));
  });

  it("archives a shared workspace once the other card is finished", async () => {
    const root = await makeRepo("share-done");
    const task = createTask({ project: "share-done", title: "shared", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "shared");
    const directory = join(trees, "share-done-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "shared.txt"), "x\n");
    await git(directory, ["add", "shared.txt"]);
    await git(directory, ["commit", "-m", "shared"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    const sibling = createTask({ project: "share-done", title: "Review finished", role: "reviewer", workspacePath: directory });
    getDb().prepare("UPDATE tasks SET status = 'done', paseo_workspace_id = ? WHERE id = ?").run(`ws-${task.id}`, sibling.id);
    let archived = false;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        archived = true;
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
    };
    const release = installCleanup(ops);
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(archived, true);
    assert.equal(existsSync(directory), false);
    assert.ok(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"));
  });

  it("keeps uncommitted work from a finished card on the branch", async () => {
    const root = await makeRepo("dirty-done");
    const task = createTask({ project: "dirty-done", title: "dirty", role: "executor", workspacePath: root });
    const code = cardMark(task.id);
    const branch = tempBranchName(code, "dirty");
    const directory = join(trees, "dirty-done-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "landed.txt"), "x\n");
    await git(directory, ["add", "landed.txt"]);
    await git(directory, ["commit", "-m", "landed"]);
    await git(root, ["merge", "--ff-only", branch]);
    writeFileSync(join(directory, "extra.txt"), "keep me\n");
    rememberTemp(task.id, root, branch, directory);
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(await git(root, ["log", branch, "-1", "--format=%s"]), `WIP: ${code} ${zhCNPart("tempWorkspace.wip.commitMessage", 12, 17)}\n`);
    assert.equal((await git(root, ["branch", "--list", branch])).includes(branch), true);
    const bodies = getDb().prepare("SELECT body FROM comments WHERE task_id = ?").all(task.id) as Array<{ body: string }>;
    assert.ok(bodies.some((row) => row.body.includes("WIP")));
    assert.equal(existsSync(directory), false);
    const cleaned = eventRows(task.id).find((row) => row.kind === "temp_workspace_cleaned");
    assert.equal((JSON.parse(cleaned?.data_json ?? "{}") as { keptBranch?: boolean }).keptBranch, true);
  });

  it("saves a WIP even when a pre-commit hook fails", async () => {
    const root = await makeRepo("hook");
    const task = createTask({ project: "hook", title: "hook", role: "executor", workspacePath: root });
    const code = cardMark(task.id);
    const branch = tempBranchName(code, "hook");
    const directory = join(trees, "hook-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "landed.txt"), "x\n");
    await git(directory, ["add", "landed.txt"]);
    await git(directory, ["commit", "-m", "landed"]);
    await git(root, ["merge", "--ff-only", branch]);
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(directory, "extra.txt"), "hook\n");
    rememberTemp(task.id, root, branch, directory);
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(await git(root, ["log", branch, "-1", "--format=%s"]), `WIP: ${code} ${zhCNPart("tempWorkspace.wip.commitMessage", 12, 17)}\n`);
  });

  it("does not delete an agent that is still in a turn", async () => {
    const root = await makeRepo("busy-agent");
    const task = createTask({ project: "busy-agent", title: "busy", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "busy");
    const directory = join(trees, "busy-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "busy.txt"), "x\n");
    await git(directory, ["add", "busy.txt"]);
    await git(directory, ["commit", "-m", "busy"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    const agentFile = join(agents, "bucket", `agent-${task.id}.json`);
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        throw new Error(zhCNPart("audit.turnOpen", 6, 13));
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
      async inspectAgent() {
        return { archived: false, busy: true };
      },
    };
    const release = installCleanup(ops);
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(agentFile), true);
    assert.equal(existsSync(directory), true);
    assert.equal(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
    assert.ok(eventRows(task.id).some((row) => row.kind === "cleanup" && row.data_json.includes("wait_turn")));
  });

  it("finishes the next round when a deleted agent is missing and archive failed once", async () => {
    const root = await makeRepo("gone-agent");
    const task = createTask({ project: "gone-agent", title: "gone", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "gone");
    const directory = join(trees, "gone-agent-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "gone.txt"), "x\n");
    await git(directory, ["add", "gone.txt"]);
    await git(directory, ["commit", "-m", "gone"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    let archives = 0;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        archives += 1;
        if (archives === 1) throw new Error((zhCNPart("settings.thresholds.transientRetryLimit", 0, 2) + "Demo text"));
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
      async inspectAgent(agentId) {
        if (!existsSync(join(agents, "bucket", `${agentId}.json`))) return null;
        return { archived: false, busy: false };
      },
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups(start);
      assert.equal(archives, 1);
      assert.equal(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      assert.equal(eventRows(task.id).some((row) => row.data_json.includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
      await drainCleanups(new Date(start.getTime() + 61_000));
    } finally {
      release();
    }
    assert.equal(archives, 2);
    assert.equal(existsSync(directory), false);
    assert.equal((await git(root, ["branch", "--list", branch])).trim(), "");
    assert.ok(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"));
    assert.equal(eventRows(task.id).some((row) => row.data_json.includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
  });

  it("finishes a shared workspace on the next round after the review card is done", async () => {
    const root = await makeRepo("share-next");
    const task = createTask({ project: "share-next", title: "shared", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "shared");
    const directory = join(trees, "share-next-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "shared.txt"), "x\n");
    await git(directory, ["add", "shared.txt"]);
    await git(directory, ["commit", "-m", "shared"]);
    await git(root, ["merge", "--ff-only", branch]);
    rememberTemp(task.id, root, branch, directory);
    const sibling = createTask({ project: "share-next", title: "Still reviewing", role: "reviewer", workspacePath: directory });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', paseo_workspace_id = ? WHERE id = ?").run(`ws-${task.id}`, sibling.id);
    let archived = false;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        archived = true;
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
      async inspectAgent(agentId) {
        if (!existsSync(join(agents, "bucket", `${agentId}.json`))) return null;
        return { archived: false, busy: false };
      },
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups(start);
      assert.equal(archived, false);
      assert.equal(existsSync(directory), true);
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(sibling.id);
      await drainCleanups(new Date(start.getTime() + 1_000));
    } finally {
      release();
    }
    assert.equal(archived, true);
    assert.equal(existsSync(directory), false);
    assert.ok(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"));
    assert.equal(eventRows(task.id).some((row) => row.data_json.includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
  });

  it("sample WIP First round interrupted afterward", async () => {
    const root = await makeRepo("wip-split");
    const task = createTask({ project: "wip-split", title: "wip", role: "executor", workspacePath: root });
    const code = cardMark(task.id);
    const branch = tempBranchName(code, "wip");
    const directory = join(trees, "wip-split-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "landed.txt"), "x\n");
    await git(directory, ["add", "landed.txt"]);
    await git(directory, ["commit", "-m", "landed"]);
    await git(root, ["merge", "--ff-only", branch]);
    writeFileSync(join(directory, "extra.txt"), "keep me\n");
    rememberTemp(task.id, root, branch, directory);
    let archives = 0;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        archives += 1;
        if (archives === 1) throw new Error((zhCNPart("settings.thresholds.transientRetryLimit", 0, 2) + "Demo text"));
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      inspectWorkspace: worktreeView(directory, root),
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups(start);
      assert.equal(archives, 1);
      assert.equal(await git(root, ["log", branch, "-1", "--format=%s"]), `WIP: ${code} ${zhCNPart("tempWorkspace.wip.commitMessage", 12, 17)}\n`);
      const wip = eventRows(task.id).find((row) => row.kind === "cleanup" && row.data_json.includes("wip_commit") && row.data_json.includes("\"ok\":true"));
      assert.equal((JSON.parse(wip?.data_json ?? "{}") as { landed?: boolean }).landed, true);
      assert.equal(eventRows(task.id).some((row) => row.data_json.includes("not_merged")), false);
      assert.equal(existsSync(directory), true);
      await drainCleanups(new Date(start.getTime() + 61_000));
    } finally {
      release();
    }
    assert.equal(archives, 2);
    assert.equal(existsSync(directory), false);
    assert.equal((await git(root, ["branch", "--list", branch])).includes(branch), true);
    assert.equal(eventRows(task.id).some((row) => row.data_json.includes("not_merged")), false);
    const cleaned = eventRows(task.id).find((row) => row.kind === "temp_workspace_cleaned");
    assert.equal((JSON.parse(cleaned?.data_json ?? "{}") as { keptBranch?: boolean }).keptBranch, true);
  });

  it("waits without backoff while a review agent still uses the temporary directory, then keeps that other card's agent", async () => {
    const card = await landedTemp("review-hold", "review");
    const sibling = createTask({ project: "review-hold", title: "Independent review", role: "reviewer", workspacePath: card.directory, reviewOf: card.id });
    const reviewAgent = `review-${sibling.id}`;
    getDb().prepare("UPDATE tasks SET status = 'reviewing', paseo_workspace_id = ?, agent_id = ? WHERE id = ?").run(`ws-${card.id}`, reviewAgent, sibling.id);
    getDb()
      .prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'reviewer', ?)")
      .run(sibling.id, reviewAgent, new Date().toISOString());
    writeAgent(reviewAgent, card.directory, String(sibling.id));
    const box = settlingOps(card.directory, card.root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(card.agentId)), true);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      const shared = () => cleanupRows(card.id).filter((row) => row.action === "skip_workspace" && row.reason === "shared");
      assert.equal(shared().length, 1);
      assert.equal(shared()[0]?.retryAt, undefined);
      assert.equal(cleanupRows(card.id).some((row) => row.action === "purge_agents" && row.ok === false), false);
      assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      await drainCleanups(new Date(start.getTime() + 1_000));
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(agentFile(card.agentId)), true);
      assert.equal(shared().length, 1);
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(sibling.id);
      await drainCleanups(new Date(start.getTime() + 2_000));
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(existsSync(agentFile(card.agentId)), false);
      assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      assert.equal(eventRows(card.id).some((row) => row.kind === "agent_purged" && row.data_json.includes(reviewAgent)), false);
      const held = cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false);
      assert.equal(held.length, 1);
      assert.equal(held[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(String(held[0]?.error).includes(reviewAgent), false);
      assert.equal((await git(card.root, ["branch", "--list", card.branch])).includes(card.branch), true);
    } finally {
      rmSync(agentFile(reviewAgent), { force: true });
      release();
    }
    assert.equal(cleanupRows(card.id).some((row) => String(row.error ?? "").includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
  });

  it("purges the remaining agent on the next round after one delete fails", async () => {
    const card = await landedTemp("two-agents", "pair");
    const second = `${card.agentId}-b`;
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(card.id, second, new Date().toISOString());
    writeAgent(second, card.directory, String(card.id));
    failOnce.add(second);
    const box = settlingOps(card.directory, card.root, daemonInspect());
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(card.agentId)), false);
      assert.equal(existsSync(agentFile(second)), true);
      const failures = cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.agentId, second);
      assert.equal(cleanupRows(card.id).some((row) => String(row.error ?? "").includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
      await drainCleanups(new Date(start.getTime() + 30_000));
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(agentFile(second)), true);
      assert.equal(cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false).length, 1);
      await drainCleanups(new Date(start.getTime() + 61_000));
    } finally {
      failOnce.delete(second);
      release();
    }
    await assertCleaned(card.root, card.id, card.branch, card.directory, box.archives());
    assert.equal(cleanupRows(card.id).some((row) => String(row.error ?? "").includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
  });

  it("cleans up on the first round when the agent is already gone", async () => {
    const card = await landedTemp("already-gone", "missing");
    rmSync(agentFile(card.agentId), { force: true });
    const box = settlingOps(card.directory, card.root, daemonInspect());
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      for (const minute of [0, 2, 10, 45, 90, 150, 300]) {
        await drainCleanups(new Date(start.getTime() + minute * 60_000));
      }
    } finally {
      release();
    }
    await assertCleaned(card.root, card.id, card.branch, card.directory, box.archives());
    assert.equal(cleanupRows(card.id).some((row) => String(row.error ?? "").includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "purge_agents" && row.agentId === card.agentId && row.ok === true), true);
  });

  it("finishes after a failed delete is removed by hand and Paseo answers Agent not found", async () => {
    const card = await landedTemp("half-deleted", "manual");
    const second = `${card.agentId}-b`;
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(card.id, second, new Date().toISOString());
    writeAgent(second, card.directory, String(card.id));
    failOnce.add(second);
    const box = settlingOps(card.directory, card.root, daemonInspect());
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(agentFile(second)), true);
      rmSync(agentFile(second), { force: true });
      failOnce.delete(second);
      for (const minute of [2, 10, 45, 90, 150, 300]) {
        await drainCleanups(new Date(start.getTime() + minute * 60_000));
      }
    } finally {
      failOnce.delete(second);
      release();
    }
    await assertCleaned(card.root, card.id, card.branch, card.directory, box.archives());
    assert.equal(cleanupRows(card.id).some((row) => String(row.error ?? "").includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
  });

  it("backs off when inspect throws, then cleans up once the query works", async () => {
    const card = await landedTemp("inspect-throw", "query");
    let broken = true;
    const box = settlingOps(card.directory, card.root, async (agentId) => {
      if (broken && agentId === card.agentId) throw new Error((zhCNPart("cardParts.event.prError", 2, 4) + zhCNPart("wake.board.tickError", 10, 12)));
      return inspectAgentFile(agentId);
    });
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(card.agentId)), true);
      const errors = cleanupRows(card.id).filter((row) => row.action === "archive_agent" && row.ok === false);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]?.error), new RegExp(localePattern(zhCNPart("cleanup.error.unreadable", 0, 9))));
      assert.equal(typeof errors[0]?.retryAt, "string");
      await drainCleanups(new Date(start.getTime() + 30_000));
      assert.equal(box.archives(), 0);
      assert.equal(cleanupRows(card.id).filter((row) => row.action === "archive_agent" && row.ok === false).length, 1);
      broken = false;
      await drainCleanups(new Date(start.getTime() + 61_000));
    } finally {
      release();
    }
    await assertCleaned(card.root, card.id, card.branch, card.directory, box.archives());
  });

  it("does not delete an agent the board did not open, and retries with backoff", async () => {
    const card = await landedTemp("foreign-agent", "foreign");
    const foreign = `outsider-${card.id}`;
    writeFileSync(
      agentFile(foreign),
      JSON.stringify({
        id: foreign,
        cwd: card.directory,
        title: "Manual session",
        provider: "cursor",
        labels: {},
        lastActivityAt: "2026-09-29T00:00:00.000Z",
      }),
    );
    const box = settlingOps(card.directory, card.root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(foreign)), true);
      assert.equal(existsSync(agentFile(card.agentId)), false);
      const failures = cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false);
      assert.equal(failures.length, 1);
      assert.match(String(failures[0]?.error), new RegExp(zhCN("missingCwd.purge.notKanban")));
      assert.equal(typeof failures[0]?.retryAt, "string");
      await drainCleanups(new Date(start.getTime() + 1_000));
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(agentFile(foreign)), true);
      assert.equal(cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false).length, 1);
    } finally {
      rmSync(agentFile(foreign), { force: true });
      release();
    }
  });

  async function cleanWithBystander(name: string, extra: Record<string, unknown>, expectClean: boolean): Promise<void> {
    const card = await landedTemp(name, name);
    const bystander = `bystander-${name}-${card.id}`;
    writeFileSync(
      agentFile(bystander),
      JSON.stringify({
        id: bystander,
        cwd: card.directory,
        title: "TEST_verify",
        provider: "claude",
        labels: extra.labels ?? {},
        lastStatus: extra.lastStatus ?? "idle",
        lastActivityAt: "2026-09-29T00:00:00.000Z",
        ...(extra.archivedAt ? { archivedAt: extra.archivedAt } : {}),
      }),
    );
    const box = settlingOps(card.directory, card.root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups(new Date());
      const failures = cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false);
      if (expectClean) {
        assert.equal(failures.length, 0);
        assert.equal(box.archives(), 1);
        assert.equal(existsSync(card.directory), false);
        assert.ok(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"));
      } else {
        assert.equal(failures.length, 1);
        assert.match(String(failures[0]?.error), new RegExp(zhCN("missingCwd.purge.notKanban")));
        assert.equal(existsSync(card.directory), true);
        assert.equal(existsSync(agentFile(bystander)), true);
      }
    } finally {
      rmSync(agentFile(bystander), { force: true });
      release();
    }
  }

  it("an archived closed agent the board did not open does not block cleanup", async () => {
    await cleanWithBystander("arch-foreign", { lastStatus: "closed", archivedAt: "2026-10-05T06:41:33.625Z" }, true);
  });

  it("an unarchived agent the board did not open still blocks cleanup", async () => {
    await cleanWithBystander("live-foreign", { lastStatus: "idle" }, false);
  });

  it("a child of the card's own agent counts as the card's agent, archived or not", async () => {
    const card = await landedTemp("child-agent", "child");
    const child = `child-of-${card.id}`;
    writeFileSync(
      agentFile(child),
      JSON.stringify({
        id: child,
        cwd: card.directory,
        title: "TEST_child",
        provider: "claude",
        labels: { "paseo.parent-agent-id": card.agentId },
        lastStatus: "closed",
        archivedAt: "2026-10-05T06:41:33.625Z",
        lastActivityAt: "2026-09-29T00:00:00.000Z",
      }),
    );
    const box = settlingOps(card.directory, card.root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups(new Date());
      assert.equal(cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false).length, 0);
      await assertCleaned(card.root, card.id, card.branch, card.directory, box.archives());
      assert.equal(existsSync(agentFile(child)), false);
    } finally {
      rmSync(agentFile(child), { force: true });
      release();
    }
  });

  it("treats Agent not found as gone and any other failed query as an error", async () => {
    const missing = "inspect-missing-agent";
    rmSync(agentFile(missing), { force: true });
    function paseo(refresh: () => Promise<{ agent: { status?: string; archivedAt?: string | null; activeTurn?: unknown } | null }>): NonNullable<CleanupOps["inspectAgent"]> {
      const ops = cleanupOps({
        agents: {
          ref() {
            return {
              refresh,
              current() {
                return null;
              },
            };
          },
        },
      } as unknown as PaseoApi);
      if (!ops.inspectAgent) throw new Error("cleanupOps did not provide inspectAgent");
      return ops.inspectAgent;
    }
    assert.equal(await paseo(async () => {
      throw new Error(`Agent not found: ${missing}`);
    })(missing), null);
    const failed = paseo(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await assert.rejects(() => failed(missing), new RegExp(zhCN("paseo.agent.lookupFailed")));
    writeAgent("inspect-file-agent", dir);
    await assert.rejects(() => failed("inspect-file-agent"), new RegExp(zhCN("paseo.agent.lookupFailed")));
    assert.deepEqual(
      await paseo(async () => {
        throw new Error("Agent not found: inspect-file-agent");
      })("inspect-file-agent"),
      { archived: false, busy: false },
    );
    rmSync(agentFile("inspect-file-agent"), { force: true });
  });

  it("does not delete a finished review card's agent that shares the directory", async () => {
    const card = await landedTemp("review-busy-share", "share");
    const sibling = createTask({
      project: "review-busy-share",
      title: "Review just ended",
      role: "reviewer",
      workspacePath: card.directory,
      reviewOf: card.id,
    });
    const reviewAgent = `review-${sibling.id}`;
    getDb().prepare("UPDATE tasks SET status = 'done', paseo_workspace_id = ?, agent_id = ? WHERE id = ?").run(`ws-${card.id}`, reviewAgent, sibling.id);
    appendEvent(sibling.id, "accept", "reviewing", "done", "test", {});
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'reviewer', ?)").run(sibling.id, reviewAgent, new Date().toISOString());
    writeAgent(reviewAgent, card.directory, String(sibling.id));
    let reviewBusy = true;
    const box = settlingOps(card.directory, card.root, daemonInspect((agentId) => reviewBusy && agentId === reviewAgent));
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(existsSync(agentFile(card.agentId)), false);
      assert.equal(existsSync(card.directory), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      const waits = () => cleanupRows(card.id).filter((row) => row.action === "wait_turn" && row.agentId === reviewAgent);
      assert.equal(waits().length, 0);
      const held = () => cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false);
      assert.equal(held().length, 1);
      assert.equal(held()[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(String(held()[0]?.error).includes(reviewAgent), false);
      await drainCleanups(new Date(start.getTime() + 1_000));
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(waits().length, 0);
      reviewBusy = false;
      await drainCleanups(new Date(start.getTime() + 2_000));
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "agent_purged" && row.data_json.includes(reviewAgent)), false);
      const reviewWaits = cleanupRows(sibling.id).filter((row) => row.action === "wait_turn" && row.agentId === reviewAgent);
      assert.equal(reviewWaits.length >= 1, true);
      const retryAt = Date.parse(String(reviewWaits[0]?.retryAt));
      assert.equal(Number.isFinite(retryAt), true);
      await drainCleanups(new Date(retryAt + 1_000));
      const archived = cleanupRows(sibling.id).find((row) => row.action === "archive_agent" && row.agentId === reviewAgent && row.ok === true);
      assert.ok(archived);
      assert.equal(eventRows(sibling.id).some((row) => row.kind === "cleanup_finished"), true);
      assert.equal(cleanupRows(sibling.id).some((row) => String(row.error ?? "").includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
    } finally {
      release();
    }
  });

  it("keeps the directory while another card's agent shares it, without querying that agent", async () => {
    const card = await landedTemp("review-query-share", "query-share");
    const sibling = createTask({
      project: "review-query-share",
      title: "Sample text agent Unclear",
      role: "reviewer",
      workspacePath: card.directory,
      reviewOf: card.id,
    });
    const reviewAgent = `review-query-${sibling.id}`;
    getDb().prepare("UPDATE tasks SET status = 'done', paseo_workspace_id = ?, agent_id = ? WHERE id = ?").run(`ws-${card.id}`, reviewAgent, sibling.id);
    appendEvent(sibling.id, "accept", "reviewing", "done", "test", {});
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'reviewer', ?)").run(sibling.id, reviewAgent, new Date().toISOString());
    writeAgent(reviewAgent, card.directory, String(sibling.id));
    let broken = true;
    const box = settlingOps(card.directory, card.root, async (agentId) => {
      if (broken && agentId === reviewAgent) throw new Error((zhCNPart("cardParts.event.prError", 2, 4) + zhCNPart("wake.board.tickError", 10, 12)));
      return inspectAgentFile(agentId);
    });
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(existsSync(card.directory), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      const errors = cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(String(errors[0]?.error).includes(reviewAgent), false);
      assert.equal(typeof errors[0]?.retryAt, "string");
      await drainCleanups(new Date(start.getTime() + 30_000));
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(existsSync(card.directory), true);
      assert.equal(cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false).length, 1);
      broken = false;
      await drainCleanups(new Date(start.getTime() + 61_000));
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "agent_purged" && row.data_json.includes(reviewAgent)), false);
    } finally {
      rmSync(agentFile(reviewAgent), { force: true });
      release();
    }
  });

  it("keeps the directory while another card's agent file is present, even when Paseo cannot be asked", async () => {
    const card = await landedTemp("review-query-file", "query-file");
    const sibling = createTask({
      project: "review-query-file",
      title: "Disk appears idle",
      role: "reviewer",
      workspacePath: card.directory,
      reviewOf: card.id,
    });
    const reviewAgent = `review-file-${sibling.id}`;
    getDb().prepare("UPDATE tasks SET status = 'done', paseo_workspace_id = ?, agent_id = ? WHERE id = ?").run(`ws-${card.id}`, reviewAgent, sibling.id);
    appendEvent(sibling.id, "accept", "reviewing", "done", "test", {});
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'reviewer', ?)").run(sibling.id, reviewAgent, new Date().toISOString());
    writeAgent(reviewAgent, card.directory, String(sibling.id));
    let broken = true;
    const box = settlingOps(card.directory, card.root, connectionInspect((agentId) => broken && agentId === reviewAgent));
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(existsSync(card.directory), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      const errors = cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
      assert.equal(String(errors[0]?.error).includes(reviewAgent), false);
      assert.equal(typeof errors[0]?.retryAt, "string");
      await drainCleanups(new Date(start.getTime() + 30_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false).length, 1);
      broken = false;
      await drainCleanups(new Date(start.getTime() + 61_000));
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(reviewAgent)), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "agent_purged" && row.data_json.includes(reviewAgent)), false);
    } finally {
      rmSync(agentFile(reviewAgent), { force: true });
      release();
    }
  });

  it("keeps a temporary directory when an agent bucket cannot be read, then cleans up once it can", async () => {
    const card = await landedTemp("locked-bucket", "locked");
    writeAgent(card.agentId, card.directory, String(card.id));
    const locked = join(agents, `eacces-${card.id}`);
    mkdirSync(locked);
    writeFileSync(join(locked, "hidden.json"), "{}\n");
    chmodSync(locked, 0o000);
    const box = settlingOps(card.directory, card.root, daemonInspect());
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(existsSync(card.directory), true);
      assert.equal(existsSync(agentFile(card.agentId)), true);
      assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      const errors = cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false && String(row.error ?? "").includes(zhCNPart("missingCwd.unreadAgentList", 0, 12)));
      assert.equal(errors.length, 1);
      assert.equal(typeof errors[0]?.retryAt, "string");
      await drainCleanups(new Date(start.getTime() + 30_000));
      assert.equal(existsSync(card.directory), true);
      assert.equal(cleanupRows(card.id).filter((row) => row.action === "purge_agents" && row.ok === false && String(row.error ?? "").includes(zhCNPart("missingCwd.unreadAgentList", 0, 12))).length, 1);
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
      await drainCleanups(new Date(start.getTime() + 61_000));
      await assertCleaned(card.root, card.id, card.branch, card.directory, box.archives());
    } finally {
      try {
        chmodSync(locked, 0o755);
      } catch {
        // already removed
      }
      rmSync(locked, { recursive: true, force: true });
      rmSync(agentFile(card.agentId), { force: true });
      release();
    }
  });

  it("reports an overdue archive after a waited turn goes idle and purge keeps failing", async () => {
    const card = await landedTemp("wait-purge-stuck", "purge-stuck");
    let busy = true;
    blockDelete = true;
    const box = settlingOps(card.directory, card.root, daemonInspect(() => busy));
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    const start = new Date();
    const sent: Array<{ id: string; text: string }> = [];
    saveConfig({
      ...quietTickConfig(),
      supervisorAgentId: "kanban-boss",
      archiveDeadlineMs: DEFAULT_ARCHIVE_DEADLINE_MS,
    });
    setAgentAliveCheck((id) => id === "kanban-boss");
    setWakeSender((id, text) => sent.push({ id, text }));
    resetBoardWakeForTests();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(cleanupRows(card.id).some((row) => row.action === "wait_turn" && row.agentId === card.agentId), true);
      assert.equal(cleanupRows(card.id).some((row) => row.action === "purge_agents" && row.ok === false), false);
      const early = listBoard().tasks.find((item) => item.id === card.id)?.cleanupNote ?? "";
      assert.equal(early.includes(zhCNPart("audit.overdue", 0, 5)), false);
      assert.equal(early.includes(zhCNPart("audit.turnOpen", 6, 13)), false);
      assert.equal(sent.some((item) => item.text.includes("purge-stuck") && item.text.includes(zhCN("wake.board.archiveStuck"))), false);

      busy = false;
      await drainCleanups(new Date(start.getTime() + 1_000));
      assert.equal(cleanupRows(card.id).some((row) => row.action === "purge_agents" && row.agentId === card.agentId && row.ok === false), true);
      assert.equal(existsSync(agentFile(card.agentId)), true);

      const doneAt = new Date(start.getTime() - DEFAULT_ARCHIVE_DEADLINE_MS - 1_000).toISOString();
      getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND to_status = 'done'").run(doneAt, card.id);
      // Still inside the grace after the turn ended: the failing purge is retried, not called stuck.
      sent.length = 0;
      resetBoardWakeForTests();
      await drainCleanups(new Date(start.getTime() + 2_000));
      assert.equal(sent.some((item) => item.text.includes("purge-stuck") && item.text.includes(zhCNPart("audit.overdue", 0, 5))), false);
      const graceNote = listBoard().tasks.find((item) => item.id === card.id)?.cleanupNote ?? "";
      assert.equal(graceNote.includes(zhCNPart("audit.overdue", 0, 5)), false);
      const idleAt = new Date(start.getTime() - 11 * 60_000).toISOString();
      getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'cleanup' AND json_extract(data_json, '$.action') = 'turn_idle'").run(idleAt, card.id);
      sent.length = 0;
      resetBoardWakeForTests();
      await drainCleanups(new Date(start.getTime() + 2_000));
      const note = listBoard().tasks.find((item) => item.id === card.id)?.cleanupNote ?? "";
      assert.match(note, new RegExp(localePattern(zhCNPart("audit.overdue", 0, 5))));
      assert.equal(note.includes(zhCNPart("audit.turnOpen", 6, 13)), false);
      assert.equal(sent.some((item) => item.text.includes("purge-stuck") && item.text.includes(zhCN("wake.board.archiveStuck")) && item.text.includes(zhCNPart("audit.overdue", 0, 5))), true);
      const audit = formatAudit(
        await performAudit({
          async listActiveAgents() {
            return [{ id: card.agentId, archived: false, workspaceId: `ws-${card.id}` }];
          },
          async inspectWorkspace() {
            return null;
          },
        }),
      );
      assert.match(audit, new RegExp(`${zhCNPart("audit.overdue", 0, 6)}${card.agentId}`));
      assert.equal(audit.includes(zhCNPart("audit.turnOpen", 6, 13)), false);
    } finally {
      blockDelete = false;
      release();
    }
  });

  it("records branch_observed when the executor completes on another branch", async () => {
    const { root } = await originAndSide("observe-switch");
    const card = await cardOnMain(root, "observe-switch", zhCNPart("cardParts.event.agentOpened", 0, 2));
    await git(card.directory, ["checkout", "-b", "docs/readme-notes"]);
    writeFileSync(join(card.directory, "notes.txt"), "notes\n");
    await git(card.directory, ["add", "notes.txt"]);
    await git(card.directory, ["commit", "-m", "notes"]);
    await git(card.directory, ["push", "-u", "origin", "HEAD"]);
    const head = (await git(card.directory, ["rev-parse", "HEAD"])).trim();
    deliver(card.id);
    const seen = observedBranch(card.id);
    assert.equal(seen?.branch, "docs/readme-notes");
    assert.equal(seen?.head, head);
    assert.equal(seen?.pushed, true);
  });

  it("does not record branch_observed when the checkout stays on the card branch", async () => {
    const root = await makeRepo("observe-stay");
    const card = await cardOnMain(root, "observe-stay", zhCNPart("routing.pinnedShort", 5, 7));
    writeFileSync(join(card.directory, "stay.txt"), "stay\n");
    await git(card.directory, ["add", "stay.txt"]);
    await git(card.directory, ["commit", "-m", "stay"]);
    deliver(card.id);
    assert.equal(observedBranch(card.id), null);
    assert.equal((await git(card.directory, ["branch", "--show-current"])).trim(), card.branch);
  });

  for (const readable of [true, false]) {
    it(`checks detached HEAD against fresh contract PR head (readable=${readable})`, async () => {
      const name = `detached-pr-${readable}`;
      const { root } = await originAndSide(name);
      const card = await cardOnMain(root, name, "PR head");
      await git(card.directory, ["checkout", "-b", `feature/${name}`]);
      await git(card.directory, ["commit", "--allow-empty", "-m", "remote"]);
      await git(card.directory, ["push", "-u", "origin", "HEAD"]);
      deliver(card.id);
      await git(card.directory, ["checkout", "--detach"]);
      await git(card.directory, ["commit", "--allow-empty", "-m", "PR head"]);
      const head = (await git(card.directory, ["rev-parse", "HEAD"])).trim();
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(
        writeContract({ kind: "github", repo: "acme/widgets", pr: "https://github.com/acme/widgets/pull/886", awaiting: false }), card.id);
      markDone(card.id);
      setGhRunner(async () => {
        if (!readable) throw new Error("PR unavailable");
        return JSON.stringify({ headRefOid: head });
      });
      const box = settlingOps(card.directory, root, inspectAgentFile);
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      try {
        await drainCleanups();
        assert.equal(existsSync(card.directory), !readable);
        assert.equal(box.archives(), readable ? 1 : 0);
        // The feature branch is the executor's checkout, not a card branch: cleanup keeps its name either way (TEST_0184 P2-15).
        assert.equal(Boolean((await git(root, ["branch", "--list", `feature/${name}`])).trim()), true);
        if (!readable) assert.ok(cleanupRows(card.id).some(row => row.retryAt));
      } finally { release(); setGhRunner(null); resetMergeCache(); }
    });
  }

  // Advance a bare fixture's remote branch without moving the worktree's tip.
  async function advanceOrigin(root: string, local: string, remote: string, name: string): Promise<string> {
    await git(root, ["checkout", "-b", `advance/${name}`, local]);
    await git(root, ["commit", "--allow-empty", "-m", "remote progress 1"]);
    await git(root, ["commit", "--allow-empty", "-m", "remote progress 2"]);
    await git(root, ["push", "origin", `HEAD:refs/heads/${remote}`]);
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    await git(root, ["checkout", "side"]);
    return head;
  }

  for (const status of ["done", "archived"] as const) {
    for (const mode of ["attached", "observed", "detached", "detached-other"] as const) {
      it(`collects a clean pushed ancestor (${status}, ${mode}) and retains the branch outside origin/base`, async () => {
        const name = `ancestor-${status}-${mode}`;
        const { root, origin } = await originAndSide(name);
        const card = await cardOnMain(root, name, "ancestor");
        const actual = mode === "observed" ? `feature/${name}` : card.branch;
        if (mode === "observed") await git(card.directory, ["checkout", "-b", actual]);
        await git(card.directory, ["commit", "--allow-empty", "-m", "local tip"]);
        const local = (await git(card.directory, ["rev-parse", "HEAD"])).trim();
        const remote = mode === "detached-other" ? `feature/${name}` : actual;
        const remoteHead = await advanceOrigin(root, actual, remote, name);
        // Base-only fetch and an old observation must not hide other origin heads.
        await git(root, ["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
        deliver(card.id);
        if (mode.startsWith("detached")) await git(card.directory, ["checkout", "--detach"]);
        const contract = writeContract({ kind: "github", repo: "acme/widgets", pr: "https://github.com/acme/widgets/pull/898", awaiting: false });
        getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(contract, card.id);
        setGhRunner(async () => JSON.stringify({ state: "OPEN", mergedAt: null, headRefOid: remoteHead }));
        const box = settlingOps(card.directory, root, inspectAgentFile);
        const release = installCleanup(box.ops, { timeoutMs: 5_000 });
        try {
          markDone(card.id);
          getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, card.id);
          await drainCleanups();
          assert.equal(box.archives(), 1);
          assert.equal(existsSync(card.directory), false);
          assert.equal((await git(root, ["rev-parse", `refs/heads/${actual}`])).trim(), local);
          assert.equal((await git(origin, ["rev-parse", `refs/heads/${remote}`])).trim(), remoteHead);
          assert.equal(getTask(card.id).contract_json, contract);
          const cleaned = JSON.parse(eventRows(card.id).find(row => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}");
          assert.equal(cleaned.reason, "pushed_ancestor");
          assert.equal(cleaned.keptBranch, true);
          const keepReason = mode === "observed" ? new RegExp(localePattern(zhCNPart("worktreeRecord.skip.notCardCopy", 2, 7))) : /origin\/main/;
          assert.ok(cleanupRows(card.id).some(row => row.action === "keep_branch" && keepReason.test(String(row.reason))));
          assert.ok(cleanupRows(card.id).some(row => row.action === "wip_commit" && row.reason === "pushed_ancestor"));
          assert.equal(loadCwdAgents().some(agent => pathWithin(card.directory, agent.cwd)), false);
        } finally { release(); setGhRunner(null); resetMergeCache(); }
      });
    }
  }

  for (const status of ["done", "archived"] as const) {
    for (const switched of [false, true]) {
      for (const detached of [false, true]) {
        it(`collects a clean pushed ${detached ? "detached" : "attached"} ${switched ? "observed" : "kanban"} branch with an OPEN PR on a ${status} card`, async () => {
          const name = `pushed-open-${status}-${switched}-${detached}`;
          const { root, origin } = await originAndSide(name);
          const card = await cardOnMain(root, name, "remote retained");
          const actual = switched ? `feature/${name}` : card.branch;
          if (switched) await git(card.directory, ["checkout", "-b", actual]);
          writeFileSync(join(card.directory, "notes.txt"), "pushed\n");
          await git(card.directory, ["add", "notes.txt"]);
          await git(card.directory, ["commit", "-m", "pushed"]);
          await git(card.directory, ["push", "-u", "origin", actual]);
          const head = (await git(root, ["rev-parse", `refs/heads/${actual}`])).trim();
          await git(root, ["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
          await git(root, ["update-ref", "-d", `refs/remotes/origin/${actual}`]);
          await assert.rejects(git(root, ["merge-base", "--is-ancestor", `refs/heads/${actual}`, "refs/remotes/origin/main"]));
          const pr = "https://github.com/acme/widgets/pull/883";
          const contract = writeContract({ kind: "github", repo: "acme/widgets", pr, awaiting: false });
          getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(contract, card.id);
          setGhRunner(async () => JSON.stringify({ state: "OPEN", mergedAt: null, headRefOid: head }));
          deliver(card.id);
          if (detached) await git(card.directory, ["checkout", "--detach"]);
          const box = settlingOps(card.directory, root, inspectAgentFile);
          const release = installCleanup(box.ops, { timeoutMs: 5_000 });
          try {
            markDone(card.id);
            getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, card.id);
            await drainCleanups();
            if (switched) {
              // A switched checkout is not a card branch: only its local name stays, the empty kanban branch goes.
              assert.equal(box.archives(), 1);
              assert.equal(existsSync(card.directory), false);
              assert.equal((await git(root, ["rev-parse", `refs/heads/${actual}`])).trim(), head);
              const kept = cleanupRows(card.id).find(row => row.action === "keep_branch" && row.ok === true);
              assert.match(String(kept?.reason ?? ""), new RegExp(localePattern(zhCNPart("worktreeRecord.skip.notCardCopy", 2, 7))));
            } else {
              await assertCleaned(root, card.id, actual, card.directory, box.archives());
              const deleted = cleanupRows(card.id).find(row => row.action === "delete_branch" && row.ok === true);
              assert.equal(deleted?.reason, zhCN("worktreeGc.basis.pushed"));
            }
            assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "");
            assert.equal((await git(origin, ["rev-parse", `refs/heads/${actual}`])).trim(), head);
            assert.equal(getTask(card.id).contract_json, contract);
            const cleaned = JSON.parse(eventRows(card.id).find(row => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}");
            assert.equal(cleaned.reason, zhCN("worktreeGc.basis.pushed"));
          } finally {
            release();
            setGhRunner(null);
            resetMergeCache();
          }
        });
      }
    }

    for (const detached of [false, true]) {
    it(`keeps a ${status} card whose ${detached ? "detached" : "attached"} observed branch has local commits beyond origin`, async () => {
      const name = `pushed-ahead-${status}-${detached}`;
      const { root, origin } = await originAndSide(name);
      const card = await cardOnMain(root, name, "ahead");
      const actual = `feature/${name}`;
      await git(card.directory, ["checkout", "-b", actual]);
      writeFileSync(join(card.directory, "notes.txt"), "pushed\n");
      await git(card.directory, ["add", "notes.txt"]);
      await git(card.directory, ["commit", "-m", "pushed"]);
      await git(card.directory, ["push", "-u", "origin", actual]);
      deliver(card.id); // Deliberately leave an older pushed:true observation.
      assert.equal(observedBranch(card.id)?.pushed, true);
      const remoteHead = (await git(origin, ["rev-parse", `refs/heads/${actual}`])).trim();
      if (detached) await git(card.directory, ["checkout", "--detach"]);
      await git(card.directory, ["commit", "--allow-empty", "-m", "local only"]);
      const box = settlingOps(card.directory, root, inspectAgentFile);
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      try {
        markDone(card.id);
        getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, card.id);
        await drainCleanups();
        // An archived attached branch is kept and its directory dropped; its local commits stay on the branch.
        const collected = status === "archived" && !detached;
        assert.equal(box.archives(), collected ? 1 : 0);
        assert.equal(existsSync(card.directory), !collected);
        assert.ok((await git(root, ["branch", "--list", actual])).trim());
        assert.ok((await git(root, ["branch", "--list", card.branch])).trim());
        assert.equal((await git(origin, ["rev-parse", `refs/heads/${actual}`])).trim(), remoteHead);
        assert.equal(eventRows(card.id).some(row => row.kind === "temp_workspace_cleaned"), collected);
        if (collected) assert.equal(cleanupRows(card.id).find(row => row.action === "keep_branch")?.reason, "archived_keep_branch");
      } finally { release(); }
    });
    }
  }

  for (const failing of ["fetch", "ls-remote"] as const) {
    it(`keeps a pushed ancestor on ${failing} failure and retries after backoff`, async () => {
      const name = `pushed-${failing}-retry`;
      const { root, origin } = await originAndSide(name);
      const card = await cardOnMain(root, name, "retry");
      writeFileSync(join(card.directory, "notes.txt"), "pushed\n");
      await git(card.directory, ["add", "notes.txt"]);
      await git(card.directory, ["commit", "-m", "pushed"]);
      await git(card.directory, ["push", "-u", "origin", card.branch]);
      await advanceOrigin(root, card.branch, card.branch, name);
      await git(card.directory, ["checkout", "--detach"]);
      markDone(card.id);
      const box = settlingOps(card.directory, root, inspectAgentFile);
      let fail = true;
      let attempts = 0;
      const events = readCleanupEvents(card.id);
      const start = new Date();
      const settle = (now: Date) => settleTempWorkspace({
        task: getTask(card.id), events, now,
        record(data) {
          appendEvent(card.id, "cleanup", null, null, "test", data);
          events.push({ ...data, at: now.toISOString() });
        },
        archiveWorkspace: box.ops.archiveWorkspace,
        decideWorkspace: async () => ({ action: "archive", workspaceId: `ws-${card.id}`, directory: card.directory }),
        async run(cwd, args) {
          if (args[0] === failing) {
            attempts += 1;
            if (fail) return { code: 1, stdout: "", stderr: "unavailable" };
          }
          // Local fixture only; allow the guarded local branch deletion.
          if (args[0] === "branch" && args[1] === "-D") {
            try { return { code: 0, stdout: await git(cwd, args), stderr: "" }; }
            catch { return { code: 1, stdout: "", stderr: "delete failed" }; }
          }
          return runGit(cwd, args);
        },
      });
      assert.equal(await settle(start), "pending");
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.ok((await git(root, ["branch", "--list", card.branch])).trim());
      const skipped = cleanupRows(card.id).find(row => row.action === "skip_worktree" && row.ok === false);
      assert.ok(skipped?.retryAt);
      const calls = attempts;
      fail = false;
      assert.equal(await settle(new Date(start.getTime() + 1_000)), "pending");
      assert.equal(attempts, calls);
      assert.equal(await settle(new Date(start.getTime() + 61_000)), "settled");
      assert.equal(box.archives(), 1);
      assert.equal(existsSync(card.directory), false);
      assert.ok(eventRows(card.id).some(row => row.kind === "temp_workspace_cleaned"));
      assert.ok((await git(root, ["branch", "--list", card.branch])).trim());
      assert.ok((await git(origin, ["branch", "--list", card.branch])).trim());
    });
  }

  it("rechecks saved pushed proof before retrying workspace archival", async () => {
    const { root } = await originAndSide("pushed-saved");
    const card = await cardOnMain(root, "pushed-saved", "recheck");
    writeFileSync(join(card.directory, "notes.txt"), "pushed\n");
    await git(card.directory, ["add", "notes.txt"]);
    await git(card.directory, ["commit", "-m", "pushed"]);
    await git(card.directory, ["push", "-u", "origin", card.branch]);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const archive = box.ops.archiveWorkspace;
    let calls = 0;
    box.ops.archiveWorkspace = async id => {
      calls += 1;
      if (calls === 1) throw new Error("archive temporarily unavailable");
      await archive(id);
    };
    const release = installCleanup(box.ops);
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(calls, 1);
      assert.ok(cleanupRows(card.id).some(row => row.action === "wip_commit" && row.reason === zhCN("worktreeGc.basis.pushed")));
      await git(card.directory, ["commit", "--allow-empty", "-m", "new local commit"]);
      await drainCleanups(new Date(start.getTime() + 61_000));
      assert.equal(calls, 1);
      assert.equal(existsSync(card.directory), true);
      await git(card.directory, ["push", "origin", card.branch]); // Temporary bare origin only.
      await drainCleanups(new Date(start.getTime() + 122_000));
      await assertCleaned(root, card.id, card.branch, card.directory, box.archives());
    } finally { release(); }
  });

  it("rechecks saved ancestor proof before archiving and retains its branch", async () => {
    const name = "ancestor-saved";
    const { root } = await originAndSide(name);
    const card = await cardOnMain(root, name, "ancestor recheck");
    writeFileSync(join(card.directory, "notes.txt"), "local tip\n");
    await git(card.directory, ["add", "notes.txt"]);
    await git(card.directory, ["commit", "-m", "local tip"]);
    await advanceOrigin(root, card.branch, card.branch, name);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const archive = box.ops.archiveWorkspace;
    let calls = 0;
    box.ops.archiveWorkspace = async id => {
      calls += 1;
      if (calls === 1) throw new Error("archive temporarily unavailable");
      await archive(id);
    };
    const release = installCleanup(box.ops);
    const start = new Date();
    try {
      markDone(card.id);
      await drainCleanups(start);
      assert.equal(calls, 1);
      assert.ok(cleanupRows(card.id).some(row => row.action === "wip_commit" && row.reason === "pushed_ancestor"));
      await git(card.directory, ["commit", "--allow-empty", "-m", "local divergence"]);
      await drainCleanups(new Date(start.getTime() + 61_000));
      assert.equal(calls, 1);
      assert.equal(existsSync(card.directory), true);
      await git(card.directory, ["rebase", `origin/${card.branch}`]);
      await git(card.directory, ["push", "origin", card.branch]); // Temporary bare origin only.
      await drainCleanups(new Date(start.getTime() + 122_000));
      assert.equal(box.archives(), 1);
      assert.equal(existsSync(card.directory), false);
      assert.ok((await git(root, ["branch", "--list", card.branch])).trim());
      const cleaned = JSON.parse(eventRows(card.id).find(row => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}");
      assert.equal(cleaned.reason, "pushed_ancestor");
      assert.equal(cleaned.keptBranch, true);
    } finally { release(); }
  });

  it("finishes detached ancestor cleanup after the directory is gone and base fetch recovers", async () => {
    const name = "ancestor-after-directory";
    const { root } = await originAndSide(name);
    const card = await cardOnMain(root, name, "detached retry");
    await git(card.directory, ["commit", "--allow-empty", "-m", "local tip"]);
    await advanceOrigin(root, card.branch, "feature/detached-proof", name);
    await git(card.directory, ["checkout", "--detach"]);
    markDone(card.id);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const events = readCleanupEvents(card.id);
    const start = new Date();
    let fail = true;
    const settle = (now: Date) => settleTempWorkspace({
      task: getTask(card.id), events, now,
      record(data) {
        appendEvent(card.id, "cleanup", null, null, "test", data);
        events.push({ ...data, at: now.toISOString() });
      },
      archiveWorkspace: box.ops.archiveWorkspace,
      decideWorkspace: async () => ({ action: "archive", workspaceId: `ws-${card.id}`, directory: card.directory }),
      async run(cwd, args) {
        if (fail && !existsSync(card.directory) && args[0] === "fetch") {
          return { code: 1, stdout: "", stderr: "base unavailable" };
        }
        return runGit(cwd, args);
      },
    });
    assert.equal(await settle(start), "pending");
    assert.equal(existsSync(card.directory), false);
    assert.equal(box.archives(), 1);
    assert.ok(cleanupRows(card.id).some(row => row.action === "delete_branch" && row.ok === false && row.retryAt));
    fail = false;
    assert.equal(await settle(new Date(start.getTime() + 1_000)), "pending");
    assert.equal(await settle(new Date(start.getTime() + 61_000)), "settled");
    assert.equal(box.archives(), 1);
    assert.ok((await git(root, ["branch", "--list", card.branch])).trim());
    const cleaned = JSON.parse(eventRows(card.id).find(row => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}");
    assert.equal(cleaned.reason, "pushed_ancestor");
    assert.equal(cleaned.keptBranch, true);
  });

  it("deletes an ancestor path's local branch only when origin/base contains its tip", async () => {
    const name = "ancestor-in-base";
    const { root } = await originAndSide(name);
    const card = await cardOnMain(root, name, "detached landed");
    await git(card.directory, ["commit", "--allow-empty", "-m", "local tip"]);
    await advanceOrigin(root, card.branch, card.branch, name);
    await git(root, ["push", "origin", `advance/${name}:refs/heads/main`]); // Bare fixture only.
    await git(card.directory, ["checkout", "--detach"]);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops);
    try {
      markDone(card.id);
      await drainCleanups();
      await assertCleaned(root, card.id, card.branch, card.directory, box.archives());
      assert.ok(cleanupRows(card.id).some(row => row.action === "delete_branch" && row.reason === zhCN("worktreeGc.basis.inOriginBase", {"base":"main"})));
      const cleaned = JSON.parse(eventRows(card.id).find(row => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}");
      assert.equal(cleaned.reason, "pushed_ancestor");
      assert.equal(cleaned.keptBranch, false);
    } finally { release(); }
  });

  for (const mode of ["equal", "ancestor"] as const) {
    for (const status of ["done", "archived"] as const) {
      it(`collects an attached card whose tip is on another origin branch (${mode}, ${status}) and keeps the local branch`, async () => {
        const name = `alias-${mode}-${status}`;
        const { root } = await originAndSide(name);
        const card = await cardOnMain(root, name, "alias");
        await commitFile(card.directory, "card-tip.txt", "card tip");
        const alias = `kanban/alias-${name}`;
        if (mode === "equal") await git(card.directory, ["push", "origin", `HEAD:refs/heads/${alias}`]); // Bare fixture only.
        else await advanceOrigin(root, card.branch, alias, name);
        const box = settlingOps(card.directory, root, inspectAgentFile);
        const release = installCleanup(box.ops);
        try {
          markDone(card.id);
          if (status === "archived") getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(card.id);
          await drainCleanups();
          assert.equal(box.archives(), 1);
          assert.equal(existsSync(card.directory), false);
          assert.ok((await git(root, ["branch", "--list", card.branch])).trim());
          const cleaned = JSON.parse(eventRows(card.id).find(row => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}");
          assert.equal(cleaned.reason, "pushed_other_branch");
          assert.equal(cleaned.originBranch, alias);
          assert.equal(cleaned.keptBranch, true);
          const kept = cleanupRows(card.id).find(row => row.action === "keep_branch") as { reason?: string } | undefined;
          assert.match(kept?.reason ?? "", /pushed_other_branch/);
          assert.doesNotMatch(kept?.reason ?? "", /pushed_ancestor/);
          assert.ok(cleanupRows(card.id).some(row => row.action === "wip_commit" && row.reason === "pushed_other_branch" && row.originBranch === alias));
        } finally { release(); }
      });
    }
  }

  it("deletes the local branch of an attached other-branch proof once origin/base contains it", async () => {
    const name = "alias-in-base";
    const { root } = await originAndSide(name);
    const card = await cardOnMain(root, name, "alias landed");
    await commitFile(card.directory, "card-tip.txt", "card tip");
    await git(card.directory, ["push", "origin", `HEAD:refs/heads/kanban/alias-${name}`]); // Bare fixture only.
    await git(card.directory, ["push", "origin", "HEAD:refs/heads/main"]); // Bare fixture only.
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops);
    try {
      markDone(card.id);
      await drainCleanups();
      await assertCleaned(root, card.id, card.branch, card.directory, box.archives());
    } finally { release(); }
  });

  it("keeps an attached done card with commits that no origin branch has", async () => {
    const name = "alias-unique";
    const { root } = await originAndSide(name);
    const card = await cardOnMain(root, name, "alias unique");
    await commitFile(card.directory, "on-origin.txt", "on origin");
    await git(card.directory, ["push", "origin", `HEAD:refs/heads/kanban/alias-${name}`]); // Bare fixture only.
    await commitFile(card.directory, "only-here.txt", "only here");
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops);
    try {
      markDone(card.id);
      await drainCleanups();
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.equal(eventRows(card.id).some(row => row.kind === "temp_workspace_cleaned"), false);
    } finally { release(); }
  });

  it("keeps an attached done card with uncommitted files even when its tip is on another origin branch", async () => {
    const name = "alias-dirty";
    const { root } = await originAndSide(name);
    const card = await cardOnMain(root, name, "alias dirty");
    await commitFile(card.directory, "card-tip.txt", "card tip");
    await git(card.directory, ["push", "origin", `HEAD:refs/heads/kanban/alias-${name}`]); // Bare fixture only.
    writeFileSync(join(card.directory, "dirty.txt"), "not committed\n");
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops);
    try {
      markDone(card.id);
      await drainCleanups();
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
    } finally { release(); }
  });

  it("keeps detached commits found only in a stale origin tracking ref", async () => {
    const name = "ancestor-stale-ref";
    const { root } = await originAndSide(name);
    const card = await cardOnMain(root, name, "stale ref");
    await git(card.directory, ["commit", "--allow-empty", "-m", "local only"]);
    await git(root, ["update-ref", "refs/remotes/origin/deleted-branch", card.branch]);
    await git(card.directory, ["checkout", "--detach"]);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops);
    try {
      markDone(card.id);
      await drainCleanups();
      assert.equal(box.archives(), 0);
      assert.equal(existsSync(card.directory), true);
      assert.ok((await git(root, ["branch", "--list", card.branch])).trim());
      assert.equal(eventRows(card.id).some(row => row.kind === "temp_workspace_cleaned"), false);
    } finally { release(); }
  });

  it("keeps a pushed ancestor with untracked files without saving a WIP or archiving the workspace", async () => {
    const { root } = await originAndSide("pushed-dirty");
    const card = await cardOnMain(root, "pushed-dirty", "dirty");
    writeFileSync(join(card.directory, "notes.txt"), "pushed\n");
    await git(card.directory, ["add", "notes.txt"]);
    await git(card.directory, ["commit", "-m", "pushed"]);
    await git(card.directory, ["push", "-u", "origin", card.branch]);
    await advanceOrigin(root, card.branch, card.branch, "untracked-ancestor");
    await git(root, ["config", "status.showUntrackedFiles", "no"]);
    writeFileSync(join(card.directory, "dirty.txt"), "not committed\n");
    const head = (await git(card.directory, ["rev-parse", "HEAD"])).trim();
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops);
    try {
      markDone(card.id);
      await drainCleanups();
      assert.equal(box.archives(), 0);
      assert.equal(readFileSync(join(card.directory, "dirty.txt"), "utf8"), "not committed\n");
      assert.equal((await git(card.directory, ["rev-parse", "HEAD"])).trim(), head);
    } finally { release(); }
  });

  it("keeps the switched branch the card did not create and cleans the empty kanban branch after the executor switches", async () => {
    const { root } = await originAndSide("clean-switch");
    const card = await cardOnMain(root, "clean-switch", zhCNPart("boardView.done.step", 16, 18));
    await git(card.directory, ["checkout", "-b", "docs/readme-notes"]);
    writeFileSync(join(card.directory, "notes.txt"), "notes\n");
    await git(card.directory, ["add", "notes.txt"]);
    await git(card.directory, ["commit", "-m", "notes"]);
    await git(card.directory, ["push", "-u", "origin", "HEAD"]);
    await git(root, ["merge", "--ff-only", "docs/readme-notes"]);
    await git(root, ["push", "origin", "main"]);
    await git(root, ["checkout", "side"]);
    await git(root, ["merge-base", "--is-ancestor", "docs/readme-notes", "origin/main"]);
    assert.equal((await git(root, ["rev-list", "--count", `origin/main..${card.branch}`])).trim(), "0");
    deliver(card.id);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "side");
    assert.equal((await git(root, ["branch", "--list", "docs/readme-notes"])).includes("docs/readme-notes"), true);
    assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "");
    assert.equal(existsSync(card.directory), false);
    const kept = cleanupRows(card.id).find((row) => row.action === "keep_branch" && row.ok === true);
    assert.match(String(kept?.reason ?? ""), new RegExp("docs\\/readme-notes " + localePattern(zhCNPart("worktreeRecord.skip.notCardCopy", 2, 7))));
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });

  for (const foreign of ["kanban/99999-other-card", "docs/team-notes"]) {
    it(`keeps an observed branch this card did not create (${foreign}), even when it is already in origin/main`, async () => {
      const name = `foreign-${foreign.replace(/\W+/g, "-")}`;
      const { root } = await originAndSide(name);
      const card = await cardOnMain(root, name, (zhCNPart("tempLand.refuse.mainOnOtherBranch", 27, 30) + zhCNPart("settings.projects.base", 2, 4)));
      await git(root, ["branch", foreign, "main"]);
      const tip = (await git(root, ["rev-parse", `refs/heads/${foreign}`])).trim();
      await git(card.directory, ["checkout", foreign]);
      await git(root, ["merge-base", "--is-ancestor", foreign, "origin/main"]);
      deliver(card.id);
      assert.equal(observedBranch(card.id)?.branch, foreign);
      const box = settlingOps(card.directory, root, inspectAgentFile);
      const release = installCleanup(box.ops, { timeoutMs: 5_000 });
      try {
        markDone(card.id);
        await drainCleanups();
      } finally {
        release();
      }
      assert.equal((await git(root, ["rev-parse", `refs/heads/${foreign}`])).trim(), tip);
      assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "");
      assert.equal(existsSync(card.directory), false);
      const kept = cleanupRows(card.id).find((row) => row.action === "keep_branch" && row.ok === true);
      assert.match(String(kept?.reason ?? ""), new RegExp(localePattern(zhCNPart("worktreeRecord.skip.notCardCopy", 2, 7))));
      assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch"), false);
      const cleaned = JSON.parse(eventRows(card.id).find((row) => row.kind === "temp_workspace_cleaned")?.data_json ?? "{}");
      assert.equal(cleaned.keptBranch, true);
    });
  }

  it("saves an archived copy's WIP on the card branch, not on the checked-out branch the card did not create", async () => {
    const root = await makeRepo("wip-foreign-switch");
    const card = await cardOnMain(root, "wip-foreign-switch", "Another dirty branch");
    const foreign = "docs/team-notes";
    await git(root, ["branch", foreign, "main"]);
    const before = (await git(root, ["rev-parse", foreign])).trim();
    await git(card.directory, ["checkout", foreign]);
    deliver(card.id);
    assert.equal(observedBranch(card.id)?.branch, foreign);
    writeFileSync(join(card.directory, "dirty.txt"), "left behind\n");
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["rev-parse", foreign])).trim(), before);
    assert.equal((await git(root, ["log", "-1", "--format=%s", card.branch])).trim(), wipCommitMessage(card.id));
    assert.match(await git(root, ["show", "--name-only", "--format=", card.branch]), /dirty\.txt/);
    assert.ok(cleanupRows(card.id).some((row) => row.action === "wip_commit" && row.ok === true && row.committed === true));
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });

  it("backs off instead of committing when an archived copy cannot switch back to the card branch", async () => {
    const root = await makeRepo("wip-foreign-stuck");
    const card = await cardOnMain(root, "wip-foreign-stuck", (zhCNPart("tempWorkspace.wip.switchFailed", 12, 15) + zhCNPart("tools.action.createReview", 4, 5)));
    const foreign = "kanban/99999-other-card";
    await git(root, ["checkout", "-b", foreign]);
    writeFileSync(join(root, "README"), "someone else's version\n");
    await git(root, ["commit", "-am", "other card"]);
    await git(root, ["checkout", "main"]);
    const before = (await git(root, ["rev-parse", foreign])).trim();
    await git(card.directory, ["checkout", foreign]);
    deliver(card.id);
    writeFileSync(join(card.directory, "README"), "uncommitted on top of the other card\n");
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["rev-parse", foreign])).trim(), before);
    assert.equal((await git(root, ["log", "-1", "--format=%s", card.branch])).trim(), "init");
    assert.equal(readFileSync(join(card.directory, "README"), "utf8"), "uncommitted on top of the other card\n");
    assert.equal((await git(card.directory, ["branch", "--show-current"])).trim(), foreign);
    const failed = cleanupRows(card.id).find((row) => row.action === "wip_commit" && row.ok === false);
    assert.match(String(failed?.error ?? ""), new RegExp(localePattern(zhCNPart("tempWorkspace.wip.switchFailed", 12, 19))));
    assert.ok(failed?.retryAt);
    assert.equal(box.archives(), 0);
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("keeps both branches when the switched branch is not pushed and not in origin/<base>", async () => {
    const { root } = await originAndSide("keep-switch");
    const card = await cardOnMain(root, "keep-switch", zhCNPart("missingCwd.purge.lineKeep", 0, 2));
    await git(card.directory, ["checkout", "-b", "docs/local-only"]);
    writeFileSync(join(card.directory, "local.txt"), "local\n");
    await git(card.directory, ["add", "local.txt"]);
    await git(card.directory, ["commit", "-m", "local"]);
    await git(root, ["checkout", "side"]);
    await git(root, ["merge-base", "--is-ancestor", card.branch, "origin/main"]);
    await assert.rejects(git(root, ["merge-base", "--is-ancestor", "docs/local-only", "origin/main"]));
    deliver(card.id);
    assert.equal(observedBranch(card.id)?.pushed, false);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal((await git(root, ["branch", "--list", "docs/local-only"])).includes("docs/local-only"), true);
    assert.equal(existsSync(card.directory), true);
    const skipped = cleanupRows(card.id).find((row) => row.action === "skip_worktree" && row.reason === "not_merged");
    assert.equal(skipped?.ok, false);
    assert.ok(skipped?.retryAt);
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("keeps a merged switched branch the card did not create and a kanban branch that still has its own commits", async () => {
    const { root } = await originAndSide("unique-switch");
    const card = await cardOnMain(root, "unique-switch", zhCNPart("worktreeGc.basis.noUniqueCommits", 2, 4));
    await git(card.directory, ["checkout", "-b", "docs/shared"]);
    writeFileSync(join(card.directory, "shared.txt"), "shared\n");
    await git(card.directory, ["add", "shared.txt"]);
    await git(card.directory, ["commit", "-m", "shared"]);
    await git(card.directory, ["push", "-u", "origin", "HEAD"]);
    await git(card.directory, ["checkout", card.branch]);
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only on kanban"]);
    await git(card.directory, ["checkout", "docs/shared"]);
    await git(root, ["merge", "--ff-only", "docs/shared"]);
    await git(root, ["push", "origin", "main"]);
    await git(root, ["checkout", "side"]);
    await assert.rejects(git(root, ["merge-base", "--is-ancestor", card.branch, "docs/shared"]));
    deliver(card.id);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      markDone(card.id);
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal((await git(root, ["branch", "--list", "docs/shared"])).includes("docs/shared"), true);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);
    assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch" && row.ok === false), false);
    const kept = cleanupRows(card.id).find((row) => row.action === "keep_branch" && row.ok === true);
    assert.match(String(kept?.reason ?? ""), new RegExp(localePattern(zhCNPart("worktreeGc.basis.noUniqueCommits", 2, 6))));
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });

  describe("delete_branch failures", () => {
    async function settleWithDeleteError(name: string, stderr: string, priorFailures: number) {
      const card = await landedTemp(name, name);
      markDone(card.id);
      const box = settlingOps(card.directory, card.root, inspectAgentFile);
      const events = readCleanupEvents(card.id);
      const start = new Date();
      const old = new Date(start.getTime() - 3_600_000).toISOString();
      for (let i = 0; i < priorFailures; i += 1) {
        events.push({ action: "delete_branch", directory: card.directory, branch: card.branch, ok: false, outcome: "error", error: stderr, retryAt: old, at: old });
      }
      const settle = (now: Date) => settleTempWorkspace({
        task: getTask(card.id), events, now,
        record(data) {
          appendEvent(card.id, "cleanup", null, null, "test", data);
          events.push({ ...data, at: now.toISOString() });
        },
        archiveWorkspace: box.ops.archiveWorkspace,
        decideWorkspace: async () => ({ action: "archive", workspaceId: `ws-${card.id}`, directory: card.directory }),
        async run(cwd, args) {
          if (args[0] === "branch" && (args.includes("-D") || args.includes("-d"))) return { code: 1, stdout: "", stderr };
          return runGit(cwd, args);
        },
      });
      const outcome = await settle(start);
      return { card, outcome };
    }
    const wakes = (id: number) => eventRows(id).filter((row) => row.kind === "wake_branch_kept").length;
    const cleaned = (id: number) => eventRows(id).some((row) => row.kind === "temp_workspace_cleaned");

    it("counts a real error toward the limit and defers before it", async () => {
      const { card, outcome } = await settleWithDeleteError("dbf-defer", "fatal: disk on fire", 10);
      assert.equal(outcome, "pending");
      assert.equal(cleaned(card.id), false);
      assert.equal(wakes(card.id), 0);
    });

    it("keeps the branch, settles and wakes the leader once when the limit is reached", async () => {
      const { card, outcome } = await settleWithDeleteError("dbf-limit", "fatal: disk on fire", 11);
      assert.equal(outcome, "settled");
      assert.equal(cleaned(card.id), true);
      const kept = cleanupRows(card.id).find((row) => row.action === "keep_branch" && row.ok === true);
      assert.match(String(kept?.reason ?? ""), /disk on fire/);
      assert.equal(wakes(card.id), 1);
    });

    it("keeps the branch at once when git says another worktree uses it", async () => {
      const { card, outcome } = await settleWithDeleteError("dbf-wt", "error: cannot delete branch 'x' used by worktree at '/tmp/y'", 0);
      assert.equal(outcome, "settled");
      assert.equal(cleanupRows(card.id).some((row) => row.action === "delete_branch" && row.ok === false), false);
      assert.match(String(cleanupRows(card.id).find((row) => row.action === "keep_branch")?.reason ?? ""), new RegExp(localePattern(zhCNPart("tempWorkspace.branch.keptByRule", 0, 5))));
      assert.equal(wakes(card.id), 0);
    });

    it("keeps the branch at once when git refuses an unmerged delete", async () => {
      const { card, outcome } = await settleWithDeleteError("dbf-nm", "error: the branch 'x' is not fully merged", 0);
      assert.equal(outcome, "settled");
      assert.ok(cleanupRows(card.id).some((row) => row.action === "keep_branch" && row.ok === true));
    });

    it("treats a branch git cannot find as already deleted and records why", async () => {
      const { card, outcome } = await settleWithDeleteError("dbf-gone", "error: branch 'x' not found", 0);
      assert.equal(outcome, "settled");
      const row = cleanupRows(card.id).find((item) => item.action === "delete_branch" && item.ok === true);
      assert.equal(row?.reason, zhCN("worktreeGc.basis.branchGone"));
      assert.equal(cleaned(card.id), true);
    });
  });

  it("does not treat a same-named tag as the unmerged branch", async () => {
    const root = await makeRepo("tag-shadow");
    const card = await cardOnMain(root, "tag-shadow", zhCNPart("nativeSessions.reconcile.duplicateJsonl", 8, 10));
    await git(card.directory, ["checkout", "-b", "release/snapshot"]);
    writeFileSync(join(card.directory, "only.txt"), "only\n");
    await git(card.directory, ["add", "only.txt"]);
    await git(card.directory, ["commit", "-m", "only on branch"]);
    const before = (await git(root, ["rev-parse", "refs/heads/main"])).trim();
    await git(root, ["tag", "release/snapshot", "refs/heads/main"]);
    await git(root, ["merge-base", "--is-ancestor", "release/snapshot", "main"]);
    await assert.rejects(git(root, ["merge-base", "--is-ancestor", "refs/heads/release/snapshot", "refs/heads/main"]));
    deliver(card.id);
    const task = getTask(card.id);
    const owned = ownedWorktree(card.id, createdWorktree(card.id));
    assert.ok(owned);
    const landed = await worktreeLanded(task, owned, runGit);
    assert.equal(landed.landed, false);
    const calls: string[][] = [];
    const record = async (cwd: string, args: string[]) => {
      calls.push(args);
      if (args.includes("-D")) return { code: 1, stdout: "", stderr: "blocked" };
      return runGit(cwd, args);
    };
    const deleted = await deleteOwnedBranch(task, owned, record, record);
    assert.equal(deleted.ok, false);
    // release/snapshot is the executor's checkout, not a card branch: it never gets -D.
    assert.equal(calls.some((args) => args.includes("-D") && args.includes("release/snapshot")), false);
    assert.equal((await git(root, ["branch", "--list", "release/snapshot"])).includes("release/snapshot"), true);
    assert.equal((await git(root, ["branch", "--list", card.branch])).includes(card.branch), true);

    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(card.id);
    const result = await acceptTask(card.id);
    assert.equal(result.status, "done");
    assert.equal(readFileSync(join(root, "only.txt"), "utf8"), "only\n");
    const again = await worktreeLanded(getTask(card.id), owned, runGit);
    assert.equal(again.landed, true);
    const box = settlingOps(card.directory, root, inspectAgentFile);
    const release = installCleanup(box.ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    // Landed: the empty card branch goes, the executor's own checkout keeps its name.
    assert.equal((await git(root, ["branch", "--list", "release/snapshot"])).includes("release/snapshot"), true);
    assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "");
    assert.equal((await git(root, ["rev-parse", "refs/tags/release/snapshot"])).trim(), before);
    assert.equal(readFileSync(join(root, "only.txt"), "utf8"), "only\n");
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), true);
  });
});

async function branchCard(root: string, project: string, title: string, file: string, body: string): Promise<{ id: number; branch: string; directory: string }> {
  const task = createTask({ project, title, role: "executor", workspacePath: root });
  const branch = tempBranchName(cardMark(task.id), title);
  const directory = join(trees, `${project}-${title}`);
  await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
  writeFileSync(join(directory, file), body);
  await git(directory, ["add", file]);
  await git(directory, ["commit", "-m", title]);
  rememberTemp(task.id, root, branch, directory);
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
  return { id: task.id, branch, directory };
}

describe("accept merges a temporary branch when the project has no remote", () => {
  it("fast-forwards the branch the executor checked out", async () => {
    const root = await makeRepo("land-switch");
    const task = createTask({ project: "land-switch", title: "Switch branch and land", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "Switch branch and land");
    const directory = join(trees, "land-switch-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    rememberTemp(task.id, root, branch, directory);
    await git(directory, ["checkout", "-b", "docs/land-me"]);
    writeFileSync(join(directory, "landed.txt"), "from-docs\n");
    await git(directory, ["add", "landed.txt"]);
    await git(directory, ["commit", "-m", "land me"]);
    const head = (await git(directory, ["rev-parse", "HEAD"])).trim();
    deliver(task.id);
    const seen = observedBranch(task.id);
    assert.equal(seen?.branch, "docs/land-me");
    assert.equal(seen?.head, head);
    assert.equal(seen?.pushed, false);
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    const result = await acceptTask(task.id);
    assert.equal(result.status, "done");
    assert.ok(result.merged?.some((line) => line.includes("land me")));
    assert.equal(readFileSync(join(root, "landed.txt"), "utf8"), "from-docs\n");
    const landed = eventRows(task.id).find((row) => row.kind === "landed");
    const data = JSON.parse(landed?.data_json ?? "{}") as { branch?: string };
    assert.equal(data.branch, "docs/land-me");
  });

  it("rebases the observed branch instead of the original kanban branch without a remote", async () => {
    const root = await makeRepo("land-switch-rebase");
    const card = await cardOnMain(root, "land-switch-rebase", (zhCNPart("tempLand.refuse.mainOnOtherBranch", 34, 37) + zhCNPart("tempLand.refuse.noFastForward", 0, 2) + zhCNPart("labels.badge.landPending", 1, 3)));
    assert.equal((await git(root, ["remote"])).trim(), "");
    writeFileSync(join(card.directory, "original-only.txt"), "keep on kanban branch\n");
    await git(card.directory, ["add", "original-only.txt"]);
    await git(card.directory, ["commit", "-m", "original branch only"]);
    const originalHead = (await git(card.directory, ["rev-parse", "HEAD"])).trim();

    const actual = "docs/rebase-observed";
    await git(card.directory, ["checkout", "-b", actual, "main"]);
    writeFileSync(join(card.directory, "notes.txt"), "from observed branch\n");
    await git(card.directory, ["add", "notes.txt"]);
    await git(card.directory, ["commit", "-m", "observed branch change"]);
    const observedHead = (await git(card.directory, ["rev-parse", "HEAD"])).trim();
    deliver(card.id);
    assert.deepEqual(observedBranch(card.id), { branch: actual, head: observedHead, pushed: false });

    // Advance the base independently so accepting must rebase the observed branch.
    writeFileSync(join(root, "base-only.txt"), "latest base\n");
    await git(root, ["add", "base-only.txt"]);
    await git(root, ["commit", "-m", "base advanced"]);
    const baseHead = (await git(root, ["rev-parse", "HEAD"])).trim();
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(card.id);
    const result = await acceptTask(card.id);

    assert.equal(result.status, "done");
    assert.equal(result.merged?.length, 1);
    assert.match(result.merged[0], / observed branch change$/);
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "from observed branch\n");
    assert.equal(readFileSync(join(root, "base-only.txt"), "utf8"), "latest base\n");
    assert.equal(existsSync(join(root, "original-only.txt")), false);
    assert.equal((await git(root, ["rev-parse", card.branch])).trim(), originalHead);
    const landedHead = (await git(root, ["rev-parse", "main"])).trim();
    assert.equal((await git(root, ["rev-parse", actual])).trim(), landedHead);
    assert.notEqual(landedHead, observedHead);
    await git(root, ["merge-base", "--is-ancestor", baseHead, "main"]);
    const landed = eventRows(card.id).find(row => row.kind === "landed");
    assert.equal(JSON.parse(landed?.data_json ?? "{}").branch, actual);
  });

  it("fast-forwards and lists the commits", async () => {
    const root = await makeRepo("ff-root");
    const card = await branchCard(root, "ff", "feature", "feature.txt", "feature\n");
    const result = await acceptTask(card.id);
    assert.equal(result.status, "done");
    assert.ok(result.merged?.some((line) => line.endsWith("feature")));
    assert.match(formatResult(result), new RegExp(zhCN("flow.accept.commit", {"commit":".*feature"})));
    await git(root, ["merge-base", "--is-ancestor", card.branch, "main"]);
    assert.equal(readFileSync(join(root, "feature.txt"), "utf8"), "feature\n");
  });

  it("rebases onto the latest base when the branch cannot fast-forward", async () => {
    const root = await makeRepo("rebase-root");
    const left = await branchCard(root, "rebase", "left", "a.txt", "a\n");
    const right = await branchCard(root, "rebase", "right", "b.txt", "b\n");
    await acceptTask(left.id);
    const result = await acceptTask(right.id);
    assert.equal(result.status, "done");
    assert.ok(result.merged?.some((line) => line.endsWith("right")));
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
    assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b\n");
    await git(root, ["merge-base", "--is-ancestor", right.branch, "main"]);
  });

  it("sends the card back when the rebase conflicts", async () => {
    const root = await makeRepo("clash-root");
    const left = await branchCard(root, "clash", "left", "README", "from-left\n");
    const right = await branchCard(root, "clash", "right", "README", "from-right\n");
    await acceptTask(left.id);
    await assert.rejects(acceptTask(right.id), new RegExp(`${zhCNPart("register.error.emptyFields", 8, 10)}${cardMark(left.id)} ${zhCNPart("tempLand.conflict.withCard", 10, 29)}`));
    assert.equal(getTask(right.id).status, "rework");
    assert.equal(readFileSync(join(root, "README"), "utf8"), "from-left\n");
    assert.equal(new RegExp("rebase|" + localePattern(zhCNPart("tempLand.refuse.noFastForward", 0, 2))).test(await git(right.directory, ["status"])), false);
    assert.equal(eventRows(right.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
  });

  it("finishes a dirty main directory, keeps the worktree, and lands on the next tick", async () => {
    const root = await makeRepo("dirty-root");
    const card = await branchCard(root, "dirty", "feature", "feature.txt", "feature\n");
    writeFileSync(join(root, "scratch.txt"), "dirty\n");
    const result = await acceptTask(card.id);
    assert.equal(result.status, "done");
    assert.match(result.pending ?? "", new RegExp(localePattern(zhCNPart("tempLand.dirty.mainDirty", 0, 10))));
    assert.match(result.pending ?? "", new RegExp(card.branch));
    assert.match(formatResult(result), new RegExp(localePattern(zhCNPart("flow.accept.pending", 0, 5))));
    const pending = eventRows(card.id).filter((row) => row.kind === "land_pending");
    assert.equal(pending.length, 1);
    const data = JSON.parse(pending[0]?.data_json ?? "{}") as { reason?: string; branch?: string };
    assert.match(data.reason ?? "", new RegExp(localePattern(zhCNPart("tempLand.dirty.mainDirty", 0, 10))));
    assert.equal(data.branch, card.branch);
    assert.equal(existsSync(card.directory), true);
    assert.match(await git(root, ["branch", "--list", card.branch]), new RegExp(card.branch));
    assert.equal(eventRows(card.id).some((row) => row.kind === "landed"), false);
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
    assert.equal(existsSync(join(root, "scratch.txt")), true);
    await assert.rejects(git(root, ["merge-base", "--is-ancestor", card.branch, "main"]));
    assert.match(formatAudit(await performAudit(auditView)), new RegExp(`${zhCNPart("tempMark.note.pending", 0, 4)}${cardMark(card.id)}${zhCNPart("missingCwd.none", 0, 1)}`));
    assert.match(getDetail(card.id).task.tempNote ?? "", new RegExp(`${zhCNPart("tempMark.note.pending", 0, 4)}${cardMark(card.id)}`));

    const doneAt = new Date(Date.now() - DEFAULT_ARCHIVE_DEADLINE_MS - 1_000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'accept'").run(doneAt, card.id);
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        rmSync(agentFile(agentId), { force: true });
      },
    });
    const release = installCleanup(
      {
        async archiveAgent() {},
        async archiveWorkspace() {},
        async listAgents() {
          return [];
        },
        async inspectWorkspace() {
          return null;
        },
      },
      { timeoutMs: 5_000 },
    );
    try {
      await drainCleanups();
      assert.equal(existsSync(card.directory), true);
      assert.match(await git(root, ["branch", "--list", card.branch]), new RegExp(card.branch));
      assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      const waiting = formatAudit(await performAudit(auditView));
      assert.match(waiting, new RegExp(`${zhCNPart("tempMark.note.pending", 0, 4)}${cardMark(card.id)}${zhCNPart("missingCwd.none", 0, 1)}`));
      assert.equal(waiting.includes(`${zhCN("tempWorkspace.audit.latePrefix")}${cardMark(card.id)}`), false);
      assert.equal((boardExtras().tempWorkspaceMessage ?? "").includes(cardMark(card.id)), false);

      rmSync(join(root, "scratch.txt"));
      await runTick({
        profiles: [],
        launcher: {
          async create() {
            return { id: "land-tick" };
          },
          async send() {},
        },
        config: quietTickConfig(),
      });
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(readFileSync(join(root, "feature.txt"), "utf8"), "feature\n");
    assert.equal(existsSync(card.directory), false);
    assert.equal((await git(root, ["branch", "--list", card.branch])).trim(), "");
    assert.equal(eventRows(card.id).filter((row) => row.kind === "landed").length, 1);
    assert.equal(eventRows(card.id).some((row) => row.kind === "temp_workspace_cleaned"), true);
    assert.equal(getDetail(card.id).task.tempNote, null);
    const landed = JSON.parse(eventRows(card.id).find((row) => row.kind === "landed")?.data_json ?? "{}") as { commits?: string[] };
    assert.ok(landed.commits?.some((line) => line.endsWith("feature")));
  });

  it("does not merge a queued land that conflicts, and wakes the project leader", async () => {
    const root = await makeRepo("defer-clash");
    const left = await branchCard(root, "defer-clash", "left", "README", "from-left\n");
    const right = await branchCard(root, "defer-clash", "right", "README", "from-right\n");
    writeFileSync(join(root, "scratch.txt"), "dirty\n");
    await acceptTask(left.id);
    await acceptTask(right.id);
    assert.equal(getTask(left.id).status, "done");
    assert.equal(getTask(right.id).status, "done");
    assert.equal(existsSync(right.directory), true);
    rmSync(join(root, "scratch.txt"));

    const sent: Array<{ id: string; text: string }> = [];
    const saved = loadConfig();
    const config = quietTickConfig();
    config.supervisorAgentId = null;
    config.supervisors["defer-clash"] = "leader-defer";
    saveConfig(config);
    setAgentAliveCheck((id) => id === "leader-defer");
    setWakeSender((id, text) => sent.push({ id, text }));
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        rmSync(agentFile(agentId), { force: true });
      },
    });
    const release = installCleanup(
      {
        async archiveAgent() {},
        async archiveWorkspace() {},
        async listAgents() {
          return [];
        },
        async inspectWorkspace() {
          return null;
        },
      },
      { timeoutMs: 5_000 },
    );
    try {
      await runTick({
        profiles: [],
        launcher: {
          async create() {
            return { id: "clash-tick" };
          },
          async send() {},
        },
        config,
      });
      await drainCleanups();
      await runTick({
        profiles: [],
        launcher: {
          async create() {
            return { id: "clash-tick-2" };
          },
          async send() {},
        },
        config,
      });
    } finally {
      release();
      saveConfig(saved);
      resetAgentAliveCheck();
      setWakeSender(() => {});
    }
    assert.equal(readFileSync(join(root, "README"), "utf8"), "from-left\n");
    assert.equal(existsSync(left.directory), false);
    assert.equal((await git(root, ["branch", "--list", left.branch])).trim(), "");
    assert.equal(getTask(right.id).status, "done");
    assert.equal(existsSync(right.directory), true);
    assert.match(await git(root, ["branch", "--list", right.branch]), new RegExp(right.branch));
    assert.equal(eventRows(right.id).some((row) => row.kind === "landed"), false);
    assert.equal(eventRows(right.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
    assert.equal(new RegExp("rebase|" + localePattern(zhCNPart("tempLand.refuse.noFastForward", 0, 2))).test(await git(right.directory, ["status"])), false);
    const conflict = eventRows(right.id).filter((row) => row.kind === "land_pending").at(-1);
    const conflictData = JSON.parse(conflict?.data_json ?? "{}") as { reason?: string; conflict?: boolean; files?: string[] };
    assert.equal(conflictData.conflict, true);
    assert.ok(conflictData.files?.includes("README"));
    assert.match(conflictData.reason ?? "", /README/);
    assert.equal(sent.filter((row) => row.id === "leader-defer").length, 1);
    assert.match(sent[0]?.text ?? "", /README/);
    assert.match(formatAudit(await performAudit(auditView)), new RegExp(`${zhCNPart("tempMark.note.pending", 0, 4)}${cardMark(right.id)}${zhCNPart("missingCwd.none", 0, 1)}`));
    assert.match(getDetail(right.id).task.tempNote ?? "", /README/);
  });

  it("does not merge when the card cannot move to done", async () => {
    const root = await makeRepo("early-root");
    const card = await branchCard(root, "early", "feature", "feature.txt", "feature\n");
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    for (const status of ["running", "in_review", "rework", "done"]) {
      getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, card.id);
      await assert.rejects(acceptTask(card.id), new RegExp(localePattern(zhCNPart("flow.error.cannotReject", 0, 3))));
      assert.equal(getTask(card.id).status, status);
      assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), head);
      assert.equal(eventRows(card.id).some((row) => row.kind === "landed"), false);
    }
  });

  it("refuses when the main directory is on another branch", async () => {
    const root = await makeRepo("side-root");
    const card = await branchCard(root, "side", "feature", "feature.txt", "feature\n");
    await git(root, ["checkout", "-b", "side"]);
    await assert.rejects(acceptTask(card.id), new RegExp(localePattern(zhCNPart("compat.board.notJson", 0, 3)) + "main"));
    assert.equal((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "side");
    assert.equal(getTask(card.id).status, "acceptance");
    assert.equal(eventRows(card.id).some((row) => row.kind === "landed"), false);
    assert.equal(existsSync(join(root, "feature.txt")), false);
  });

  it("accepts two cards on the same repository without a ref lock error", async () => {
    const root = await makeRepo("pair-root");
    const left = await branchCard(root, "pair", "left", "a.txt", "a\n");
    const right = await branchCard(root, "pair", "right", "b.txt", "b\n");
    const [first, second] = await Promise.all([acceptTask(left.id), acceptTask(right.id)]);
    assert.equal(first.status, "done");
    assert.equal(second.status, "done");
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
    assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b\n");
  });

  it("merges when the card is reviewing or blocked", async () => {
    for (const status of ["reviewing", "blocked"] as const) {
      const root = await makeRepo(`from-${status}`);
      const card = await branchCard(root, status, "feature", "feature.txt", `${status}\n`);
      getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, card.id);
      const result = await acceptTask(card.id);
      assert.equal(result.status, "done");
      assert.equal(readFileSync(join(root, "feature.txt"), "utf8"), `${status}\n`);
      assert.equal(eventRows(card.id).filter((row) => row.kind === "landed").length, 1);
      assert.match(formatResult(result), new RegExp(localePattern(zhCNPart("flow.accept.noCommits", 0, 4))));
    }
  });

  it("refuses a worktree outside the worktrees root and leaves it listed", async () => {
    const root = await makeRepo("outside-root");
    const task = createTask({ project: "outside", title: "outside", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(task.id), "outside");
    const directory = join(dir, "outside-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "outside.txt"), "x\n");
    await git(directory, ["add", "outside.txt"]);
    await git(directory, ["commit", "-m", "outside"]);
    rememberTemp(task.id, root, branch, directory);
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    await assert.rejects(acceptTask(task.id), new RegExp(localePattern(zhCNPart("worktreeGc.owner.outsideRoot", 11, 19))));
    assert.equal(getTask(task.id).status, "acceptance");
    assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal(eventRows(task.id).some((row) => row.kind === "landed"), false);
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        throw new Error("Do not archive");
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const release = installCleanup(ops);
    try {
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {});
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(directory), true);
    assert.equal(eventRows(task.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
    assert.equal(listTempWorkspaces().some((row) => row.id === task.id), true);
  });

  it("names the main directory when no landed card touched the conflict", async () => {
    const root = await makeRepo("guess-root");
    const card = await branchCard(root, "guess", "feature", "README", "from-card\n");
    const reader = createTask({ project: "guess", title: "Reader", role: "reader", workspacePath: root });
    writeFileSync(join(root, "README"), "from-main\n");
    await git(root, ["add", "README"]);
    await git(root, ["commit", "-m", "main change"]);
    await assert.rejects(acceptTask(card.id), (err: Error) => {
      assert.match(err.message, new RegExp(localePattern(zhCNPart("tempLand.conflict.withMain", 0, 14))));
      assert.match(err.message, /README/);
      assert.equal(err.message.includes(cardMark(reader.id)), false);
      return true;
    });
    assert.equal(getTask(card.id).status, "rework");
  });

  it("says when a remote repository is not merged locally", async () => {
    const root = await makeRepo("origin-root");
    const card = await branchCard(root, "origin", "feature", "feature.txt", "feature\n");
    await git(root, ["remote", "add", "origin", root]);
    const result = await acceptTask(card.id);
    assert.equal(result.status, "done");
    assert.match(result.unmerged ?? "", new RegExp(localePattern(zhCNPart("tempLand.skip.hasRemote", 2, 5))));
    assert.match(formatResult(result), new RegExp(zhCN("flow.accept.unmerged", {"reason":zhCN("tempLand.skip.hasRemote")})));
    assert.equal(existsSync(join(root, "feature.txt")), false);
    assert.equal(eventRows(card.id).some((row) => row.kind === "landed"), false);
  });

  it("does not write a second landed event when accept runs twice", async () => {
    const root = await makeRepo("twice-root");
    const card = await branchCard(root, "twice", "feature", "feature.txt", "feature\n");
    const results = await Promise.allSettled([acceptTask(card.id), acceptTask(card.id)]);
    const ok = results.filter((row) => row.status === "fulfilled");
    const bad = results.filter((row) => row.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.match(String((bad[0] as PromiseRejectedResult).reason), new RegExp(localePattern(zhCNPart("flow.error.statusChanged", 11, 17))));
    assert.equal(getTask(card.id).status, "done");
    assert.equal(eventRows(card.id).filter((row) => row.kind === "landed").length, 1);
    assert.equal(readFileSync(join(root, "feature.txt"), "utf8"), "feature\n");
  });
});
