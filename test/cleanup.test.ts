/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import type { PaseoApi } from "@getpaseo/client";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { formatAudit, performAudit } from "../server/audit";
import { DEFAULT_ARCHIVE_DEADLINE_MS, DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { drainCleanups, flushCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { applyFailure } from "../server/failures";
import { acceptTask, approveTask, completeTask, rejectTask, requestChanges } from "../server/flow";
import { resetSchedulerForTests } from "../server/loop";
import { bindScheduler } from "./helpers/compat-loop";
import { HOME } from "../server/paths";
import { cleanupOps } from "../server/paseo";
import type { ListedWorkspace } from "../server/placement";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { appendEvent, archiveTask, blockTask, createTask, getTask, listBoard } from "../server/store";
import { cleanupNoteFor, readCleanupEvents, turnOpenAgentIds, turnUnknownAgentIds } from "../server/archive-book";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "clean-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
const previousWorktreesRoot = process.env.KANBAN_WORKTREES_ROOT;
// These workspace API fixtures have no real Git checkout. Keep them outside the
// managed root even when TMPDIR is inside a Paseo card worktree.
process.env.KANBAN_WORKTREES_ROOT = join(dir, "managed-worktrees");
mkdirSync(process.env.KANBAN_WORKTREES_ROOT, { recursive: true });

const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "x-ultra" };
const claudeExec: Profile = { id: "gg", name: "Executor · Claude", role: "executor", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
const reviewer: Profile = { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
const pools: PoolSnapshot = {
  state: "fresh",
  message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
  generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};

/** Upper bound for "must not wait on a hung call" checks; the hung call never returns, so only a regression reaches it. */
const HANG_GUARD_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tickConfig(project: string): KanbanConfig {
  return {
    autoStart: { [project]: true },
    supervisorAgentId: null,
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
}

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A card already stored as a per-card worktree. New creates no longer take this path. */
function legacyWorktree(title: string, root: string) {
  const task = createTask({ project: "clean", title, role: "executor", workspacePath: root });
  getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main' WHERE id = ?").run(task.id);
  return task;
}

function events(taskId: number, kind: string): Array<Record<string, unknown>> {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as unknown as Array<{
    data_json: string;
  }>;
  return rows.map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

function harness(snapshot: ListedWorkspace | null): {
  ops: CleanupOps;
  archivedAgents: string[];
  archivedWorkspaces: string[];
  agents: Array<{ id: string; archived: boolean }>;
  failAgent: { current: boolean };
  view: { snapshot: ListedWorkspace | null };
} {
  const archivedAgents: string[] = [];
  const archivedWorkspaces: string[] = [];
  const agents: Array<{ id: string; archived: boolean }> = [];
  const failAgent = { current: false };
  const view = { snapshot };
  const ops: CleanupOps = {
    async archiveAgent(agentId) {
      if (failAgent.current) throw new Error("archive down");
      if (agentId.startsWith("user-")) throw new Error("Do not archive another agent agent");
      archivedAgents.push(agentId);
    },
    async archiveWorkspace(workspaceId) {
      if (workspaceId.startsWith("main")) throw new Error("Do not archive main workspace");
      archivedWorkspaces.push(workspaceId);
    },
    async listAgents() {
      return agents.map((agent) => ({ ...agent }));
    },
    async inspectWorkspace() {
      return view.snapshot;
    },
  };
  return { ops, archivedAgents, archivedWorkspaces, agents, failAgent, view };
}

/** File missing throws "Agent not found". A name in `fail` throws "timeout" instead. */
function inspectLikePaseo(fail: Set<string> = new Set()): NonNullable<CleanupOps["inspectAgent"]> {
  const root = process.env.KANBAN_AGENTS_DIR ?? "";
  const ops = cleanupOps({
    agents: {
      ref(agentId: string) {
        return {
          async refresh() {
            if (fail.has(agentId)) throw new Error(zhCN("audit.timeout"));
            const path = join(root, "bucket", `${agentId}.json`);
            if (!existsSync(path)) throw new Error(`Agent not found: ${agentId}`);
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

function launcherFor(root: string, tree: string | null, workspaceId: string): AgentLauncher {
  if (tree) mkdirSync(join(tree, ".git"), { recursive: true });
  return {
    async create(options) {
      return { id: `agent-${workspaceId}-${options.workspaceId ?? "x"}-${Math.random().toString(16).slice(2)}`, workspaceId: options.workspaceId };
    },
    async send() {},
    async listWorkspaces() {
      return [
        ...(tree ? [{ id: workspaceId, name: "card-worktree", directory: tree, projectRoot: root, projectId: "parent-project", kind: "worktree", archived: false }] : []),
        {
          id: `main-${root}`,
          name: "main",
          directory: root,
          projectRoot: root,
          projectId: "parent-project",
          kind: "local_checkout",
          archived: false,
        },
      ];
    },
    async createWorktree() {
      return { directory: tree ?? root, workspaceId, name: "card-worktree" };
    },
  };
}

// Archive timeouts are unref'd so a hung call does not hold Paseo open.
// Node's test runner cancels a test that is waiting only on an unref'd timer.
const keepAlive = setInterval(() => {}, 60_000);

after(() => {
  clearInterval(keepAlive);
  resetSchedulerForTests();
  installCleanup(null);
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  setWakeSender(() => {});
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
  if (previousWorktreesRoot === undefined) delete process.env.KANBAN_WORKTREES_ROOT;
  else process.env.KANBAN_WORKTREES_ROOT = previousWorktreesRoot;
});

function armSupervisor(sent: Array<{ id: string; text: string }>): void {
  saveConfig({
    autoStart: {},
    supervisorAgentId: "kanban-boss",
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  });
  setAgentAliveCheck((id) => id === "kanban-boss");
  setWakeSender((id, text) => {
    sent.push({ id, text });
  });
  resetBoardWakeForTests();
}

describe("cleanup", () => {
  it("archives the card's agents when it is done or archived, and never the main workspace", async () => {
    const root = room("dir-card");
    const box = harness({
      id: "main-ws",
      name: "main",
      directory: root,
      projectRoot: root,
      projectId: "parent-project",
      kind: "local_checkout",
      archived: false,
    });
    installCleanup(box.ops);
    const task = createTask({ project: "clean", title: "Directory card", role: "executor", workspacePath: root });
    await startTask(task.id, launcherFor(root, null, "unused"), "test", { profiles: [executor, reviewer], chosen: executor, reason: "Test" });
    completeTask(task.id, "executor", "Handoff", null);
    await startTask(task.id, launcherFor(root, null, "unused"), "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    const runs = getDb().prepare("SELECT agent_id FROM runs WHERE task_id = ?").all(task.id) as unknown as Array<{ agent_id: string }>;
    assert.equal(runs.length, 2);
    assert.deepEqual(box.archivedAgents.sort(), runs.map((row) => row.agent_id).sort());
    assert.deepEqual(box.archivedWorkspaces, []);
    assert.equal(getTask(task.id).status, "done");
    assert.equal(events(task.id, "cleanup").some((event) => event.action === "skip_workspace" && event.reason === "not_worktree"), true);
    assert.equal(events(task.id, "cleanup_finished").length, 1);

    const other = createTask({ project: "clean", title: "Archive directly", role: "executor", workspacePath: root });
    await startTask(other.id, launcherFor(root, null, "unused"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    const before = box.archivedWorkspaces.length;
    archiveTask(other.id, "test");
    await flushCleanups();
    assert.equal(getTask(other.id).status, "archived");
    assert.equal(box.archivedWorkspaces.length, before);
    assert.equal(events(other.id, "cleanup").some((event) => event.reason === "not_worktree"), true);
  });

  it("archives an exclusive worktree workspace only when no other live agent remains", async () => {
    const root = room("wt-root");
    const tree = room("wt-dir");
    const box = harness({
      id: "wt-1",
      name: "card-worktree",
      directory: tree,
      projectRoot: root,
      projectId: "parent-project",
      kind: "worktree",
      archived: false,
    });
    box.agents.push({ id: "user-still-here", archived: false });
    installCleanup(box.ops);
    const task = legacyWorktree((zhCNPart("settings.projects.base", 2, 4) + zhCNPart("cardParts.event.blocked", 0, 1)), root);
    await startTask(task.id, launcherFor(root, tree, "wt-1"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.equal(getTask(task.id).status, "done");
    assert.deepEqual(box.archivedWorkspaces, []);
    assert.equal(events(task.id, "cleanup_finished").length, 0);
    assert.equal(events(task.id, "cleanup").some((event) => event.reason === "live_agents"), true);
    const ours = getTask(task.id).agent_id;
    assert.ok(ours);
    assert.equal(box.archivedAgents.includes(ours), true);
    assert.equal(box.archivedAgents.includes("user-still-here"), false);

    box.agents.length = 0;
    await drainCleanups();
    assert.deepEqual(box.archivedWorkspaces, ["wt-1"]);
    assert.equal(events(task.id, "cleanup_finished").length, 1);
    assert.equal(events(task.id, "cleanup").filter((event) => event.reason === "live_agents").length, 1);
  });

  it("does not archive the worktree of a card reopened while cleanup asked Paseo about it (TEST_0268)", async () => {
    const root = room("reopen-root");
    const tree = room("reopen-tree");
    const box = harness({
      id: "wt-reopen",
      name: "reopen",
      directory: tree,
      projectRoot: root,
      projectId: "parent-project",
      kind: "worktree",
      archived: false,
    });
    const task = legacyWorktree(zhCNPart("flow.rework.unreadable", 2, 4), root);
    const ops: CleanupOps = {
      ...box.ops,
      async inspectWorkspace(workspaceId) {
        // The leader reworks the card between the terminal check and the archive.
        getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
        return box.ops.inspectWorkspace(workspaceId);
      },
    };
    installCleanup(ops);
    await startTask(task.id, launcherFor(root, tree, "wt-reopen"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await drainCleanups();
    assert.equal(getTask(task.id).status, "rework");
    assert.deepEqual(box.archivedWorkspaces, []);
    assert.equal(events(task.id, "cleanup_finished").length, 0);
    // Park the card so later scheduler ticks in this file do not start the reopened card.
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(task.id);
    appendEvent(task.id, "cleanup_finished", null, null, "test", {});
  });

  it("does not archive a shared worktree or a workspace that is actually main", async () => {
    const root = room("shared-root");
    const tree = room("shared-tree");
    const box = harness({
      id: "wt-shared",
      name: "shared",
      directory: tree,
      projectRoot: root,
      projectId: "parent-project",
      kind: "worktree",
      archived: false,
    });
    installCleanup(box.ops);
    const task = legacyWorktree(zhCNPart("nativeAgentIndex.error.sharedSessionUnknown", 4, 6), root);
    await startTask(task.id, launcherFor(root, tree, "wt-shared"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    const sibling = legacyWorktree((zhCNPart("nativeSessions.lock.busy", 7, 9) + zhCNPart("missingCwd.purge.notThisCard", 4, 5)), root);
    getDb().prepare("UPDATE tasks SET paseo_workspace_id = ? WHERE id = ?").run("wt-shared", sibling.id);
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.deepEqual(box.archivedWorkspaces, []);
    assert.equal(events(task.id, "cleanup").some((event) => event.reason === "shared"), true);
    assert.equal(getTask(task.id).status, "done");

    const mainish = legacyWorktree("Looks like a branch", root);
    await startTask(mainish.id, launcherFor(root, tree, "wt-main"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET paseo_workspace_id = 'main-real' WHERE id = ?").run(mainish.id);
    box.view.snapshot = {
      id: "main-real",
      name: "main",
      directory: root,
      projectRoot: root,
      projectId: "parent-project",
      kind: "local_checkout",
      archived: false,
    };
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(mainish.id);
    await acceptTask(mainish.id, "supervisor");
    await flushCleanups();
    assert.deepEqual(box.archivedWorkspaces, []);
    assert.equal(events(mainish.id, "cleanup").some((event) => event.reason === "main"), true);
  });

  it("keeps the card status when archiving an agent fails, then retries", async () => {
    const root = room("retry-root");
    const tree = room("retry-tree");
    const box = harness({
      id: "wt-retry",
      name: "retry",
      directory: tree,
      projectRoot: root,
      projectId: "parent-project",
      kind: "worktree",
      archived: false,
    });
    box.failAgent.current = true;
    installCleanup(box.ops);
    const task = legacyWorktree((zhCN("compat.run.failed") + "Demo text"), root);
    await startTask(task.id, launcherFor(root, tree, "wt-retry"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.equal(getTask(task.id).status, "done");
    assert.equal(events(task.id, "cleanup_finished").length, 0);
    assert.equal(events(task.id, "cleanup").some((event) => event.ok === false && event.error === "archive down"), true);
    assert.deepEqual(box.archivedWorkspaces, []);

    const callsAfterFailure = box.archivedAgents.length;
    await drainCleanups();
    assert.equal(box.archivedAgents.length, callsAfterFailure);
    box.failAgent.current = false;
    await drainCleanups(new Date(Date.now() + 90_000));
    assert.equal(getTask(task.id).status, "done");
    assert.equal(box.archivedAgents.length, 1);
    assert.equal(listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote, null);
    assert.deepEqual(box.archivedWorkspaces, ["wt-retry"]);
    assert.equal(events(task.id, "cleanup_finished").length, 1);
  });

  it("retries an archive after the timed-out call settles, without starting a second call while it is still running", async () => {
    const root = room("timeout-root");
    const agentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let calls = 0;
    let release: (err?: Error) => void = () => {};
    const box = harness(null);
    box.ops.archiveAgent = async (id) => {
      if (id !== agentId) throw new Error(`Unexpected agent ${id}`);
      calls += 1;
      await new Promise<void>((resolve, reject) => {
        release = (err) => (err ? reject(err) : resolve());
      });
    };
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "Will time out", role: "executor", workspacePath: root });
    const fixed: AgentLauncher = {
      async create() {
        return { id: agentId };
      },
      async send() {},
    };
    await startTask(task.id, fixed, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.equal(calls, 1);
    const first = events(task.id, "cleanup").find((event) => event.action === "archive_agent");
    assert.equal(first?.ok, false);
    assert.equal(first?.outcome, "timeout");
    assert.equal(first?.error, zhCN("audit.timeout"));
    release(new Error("late"));
    await delay(20);
    await drainCleanups(new Date(Date.parse(String(first?.retryAt)) + 1000));
    assert.equal(calls, 2);
    release();
    await delay(20);
  });

  it("counts each backoff of an archive call that never returns, then shows sample and wakes once", async () => {
    const root = room("hang-forever");
    const agentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let calls = 0;
    const box = harness(null);
    box.ops.archiveAgent = (id) => {
      if (id !== agentId) throw new Error(`Unexpected agent ${id}`);
      calls += 1;
      return new Promise<void>(() => {});
    };
    const sent: Array<{ id: string; text: string }> = [];
    armSupervisor(sent);
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "Never returns", role: "executor", workspacePath: root });
    const fixed: AgentLauncher = {
      async create() {
        return { id: agentId };
      },
      async send() {},
    };
    await startTask(task.id, fixed, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.equal(calls, 1);
    assert.equal(events(task.id, "cleanup").filter((event) => event.outcome === "timeout").length, 1);

    const secondAt = Date.parse(String(events(task.id, "cleanup").find((event) => event.outcome === "timeout")?.retryAt));
    await drainCleanups(new Date(secondAt + 1000));
    assert.equal(calls, 1);
    assert.equal(events(task.id, "cleanup").filter((event) => event.outcome === "timeout").length, 2);

    const thirdAt = Date.parse(String(events(task.id, "cleanup").filter((event) => event.outcome === "timeout").at(-1)?.retryAt));
    await drainCleanups(new Date(thirdAt + 1000));
    assert.equal(calls, 1);
    assert.equal(events(task.id, "cleanup").filter((event) => event.outcome === "timeout").length, 3);
    assert.equal(listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote, zhCN("archiveBook.label.stuck", {"agent":"aaaaaaaa"}));
    assert.equal(sent.filter((item) => item.id === "kanban-boss" && item.text.includes(zhCN("archiveBook.label.stuck", {"agent":"aaaaaaaa"}))).length, 1);
    assert.equal(getTask(task.id).status, "done");
    assert.equal(events(task.id, "cleanup_finished").length, 0);

    await drainCleanups(new Date(thirdAt + 60 * 60_000));
    assert.equal(calls, 1);
    assert.equal(sent.filter((item) => item.text.includes(zhCN("archiveBook.label.stuck", {"agent":"aaaaaaaa"}))).length, 1);
  });

  it("records a workspace archive timeout and does not finish cleanup", async () => {
    const root = room("ws-timeout-root");
    const tree = room("ws-timeout-tree");
    const box = harness({
      id: "wt-slow",
      name: "slow",
      directory: tree,
      projectRoot: root,
      projectId: "parent-project",
      kind: "worktree",
      archived: false,
    });
    let calls = 0;
    let release: (err?: Error) => void = () => {};
    box.ops.archiveWorkspace = async (workspaceId) => {
      calls += 1;
      assert.equal(workspaceId, "wt-slow");
      await new Promise<void>((resolve, reject) => {
        release = (err) => (err ? reject(err) : resolve());
      });
    };
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = legacyWorktree(("workspace " + zhCN("audit.timeout")), root);
    await startTask(task.id, launcherFor(root, tree, "wt-slow"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.equal(calls, 1);
    assert.equal(events(task.id, "cleanup_finished").length, 0);
    const failure = events(task.id, "cleanup").find((event) => event.action === "archive_workspace");
    assert.equal(failure?.ok, false);
    assert.equal(failure?.outcome, "timeout");
    assert.equal(failure?.workspaceId, "wt-slow");
    assert.equal(getTask(task.id).status, "done");
    release(new Error("late"));
    await delay(20);
  });

  it("does not let a hung archive block the next tick or another card", async () => {
    const root = room("hang-root");
    const hangId = "hang-agent-11111111";
    const okId = "ok-agent-22222222";
    let hangCalls = 0;
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    const box = harness(null);
    box.ops.archiveAgent = async (agentId) => {
      if (agentId === hangId) {
        hangCalls += 1;
        return hang;
      }
      box.archivedAgents.push(agentId);
    };
    installCleanup(box.ops, { timeoutMs: 40, concurrency: 1 });
    const fixed = (id: string): AgentLauncher => ({
      async create() {
        return { id };
      },
      async send() {},
    });
    const hungCard = createTask({ project: "hang", title: "demo fixture", role: "executor", workspacePath: root });
    await startTask(hungCard.id, fixed(hangId), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    const okCard = createTask({ project: "hang", title: "Success", role: "executor", workspacePath: room("hang-ok") });
    await startTask(okCard.id, fixed(okId), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    archiveTask(hungCard.id, "test");
    archiveTask(okCard.id, "test");
    const ready = createTask({ project: "hang", title: "Not started", role: "executor", workspacePath: root });
    const sched = bindScheduler({
      intervalMs: 3_600_000,
      ready: () => ({
        launcher: {
          async create() {
            return { id: "started-by-tick" };
          },
          async send() {},
        },
        profiles: [executor, reviewer],
        config: tickConfig("hang"),
        pools,
        agentState: () => "alive" as const,
      }),
    });
    try {
      const started = Date.now();
      await sched.kick();
      assert.ok(Date.now() - started < HANG_GUARD_MS, `kick waited ${Date.now() - started}ms behind a hung archive`);
      assert.equal(getTask(ready.id).status, "running");
      assert.equal(getTask(ready.id).agent_id, "started-by-tick");
      const deadline = Date.now() + HANG_GUARD_MS;
      while (events(okCard.id, "cleanup_finished").length === 0) {
        if (Date.now() > deadline) break;
        await delay(15);
      }
      assert.equal(events(okCard.id, "cleanup_finished").length, 1);
      assert.equal(box.archivedAgents.includes(okId), true);
      assert.equal(hangCalls, 1);
      const extra = createTask({ project: "hang", title: "Sample text", role: "executor", workspacePath: room("hang-next") });
      const again = Date.now();
      await sched.kick();
      assert.ok(Date.now() - again < HANG_GUARD_MS, `second kick waited ${Date.now() - again}ms behind a hung archive`);
      assert.equal(getTask(extra.id).status, "running");
      assert.equal(hangCalls, 1);
      assert.equal(events(hungCard.id, "cleanup_finished").length, 0);
    } finally {
      releaseHang();
      sched.release();
      resetSchedulerForTests();
      await delay(20);
    }
  });

  it("archives every agent when the card is archived from running, reviewing, rework, or blocked", async () => {
    const root = room("direct-root");
    const box = harness(null);
    installCleanup(box.ops);
    const ids = new Map<string, string>();

    const running = createTask({ project: "clean", title: "Archive running card", role: "executor", workspacePath: root });
    await startTask(running.id, launcherFor(root, null, "unused"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    ids.set("running", getTask(running.id).agent_id ?? "");
    archiveTask(running.id, "test");

    const reviewing = createTask({ project: "clean", title: "Archive during review", role: "executor", workspacePath: root });
    await startTask(reviewing.id, launcherFor(root, null, "unused"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    completeTask(reviewing.id, "executor", "Handoff", null);
    await startTask(reviewing.id, launcherFor(root, null, "unused"), "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    ids.set("reviewing-executor", getTask(reviewing.id).executor_agent_id ?? "");
    ids.set("reviewing", getTask(reviewing.id).agent_id ?? "");
    archiveTask(reviewing.id, "test");

    const rework = createTask({ project: "clean", title: "Archive during rework", role: "executor", workspacePath: root });
    await startTask(rework.id, launcherFor(root, null, "unused"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    completeTask(rework.id, "executor", "Handoff", null);
    await startTask(rework.id, launcherFor(root, null, "unused"), "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    requestChanges(rework.id, "Edit", "Details");
    ids.set("rework", getTask(rework.id).agent_id ?? "");
    const reviewerRun = getDb().prepare("SELECT agent_id FROM runs WHERE task_id = ? AND role = 'reviewer'").get(rework.id) as { agent_id: string };
    ids.set("rework-reviewer", reviewerRun.agent_id);
    archiveTask(rework.id, "test");

    const blocked = createTask({ project: "clean", title: "Archive after blocking", role: "executor", workspacePath: root });
    await startTask(blocked.id, launcherFor(root, null, "unused"), "test", { profiles: [executor], chosen: executor, reason: "Test" });
    blockTask(blocked.id, "needs_human", "Missing information", "test");
    ids.set("blocked", getTask(blocked.id).agent_id ?? "");
    archiveTask(blocked.id, "test");

    await flushCleanups();
    for (const [name, agentId] of ids) {
      assert.ok(agentId, name);
      assert.equal(box.archivedAgents.includes(agentId), true, name);
    }
    assert.equal(getTask(running.id).status, "archived");
    assert.equal(getTask(reviewing.id).status, "archived");
    assert.equal(getTask(rework.id).status, "archived");
    assert.equal(getTask(blocked.id).status, "archived");
    assert.deepEqual(box.archivedWorkspaces, []);
  });

  it("archives the same executor again after rework, and every review agent", async () => {
    const root = room("rework-root");
    const box = harness(null);
    installCleanup(box.ops);
    let creates = 0;
    const launcher: AgentLauncher = {
      async create() {
        creates += 1;
        return { id: `round-${creates}-agent` };
      },
      async send() {},
    };
    const task = createTask({ project: "clean", title: "Rework same executor", role: "executor", workspacePath: root });
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Test" });
    const executorId = getTask(task.id).agent_id ?? "";
    completeTask(task.id, "executor", "Handoff", null);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    const firstReviewer = getTask(task.id).agent_id ?? "";
    requestChanges(task.id, "Edit", "Details");
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Rework" });
    assert.equal(creates, 2);
    assert.equal(getTask(task.id).agent_id, executorId);
    completeTask(task.id, "executor", "Updated", null);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Review again" });
    const secondReviewer = getTask(task.id).agent_id ?? "";
    assert.notEqual(secondReviewer, firstReviewer);
    approveTask(task.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.deepEqual(box.archivedAgents.sort(), [executorId, firstReviewer, secondReviewer].sort());
    assert.equal(box.archivedAgents.filter((id) => id === executorId).length, 1);
  });

  it("archives the agent from the pool that was rate-limited and the agent opened after", async () => {
    const root = room("pool-root");
    const box = harness(null);
    installCleanup(box.ops);
    let n = 0;
    const launcher: AgentLauncher = {
      async create() {
        n += 1;
        return { id: n === 1 ? "pool-cursor-agent" : "pool-claude-agent" };
      },
      async send() {},
    };
    const task = createTask({ project: "clean", title: "Switch pool", role: "executor", workspacePath: root });
    await startTask(task.id, launcher, "test", { profiles: [executor, claudeExec], chosen: executor, reason: "Test" });
    applyFailure(task.id, "429 rate limit", "rate_limit", new Date(), "cursor");
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).agent_id, null);
    await startTask(task.id, launcher, "test", { profiles: [executor, claudeExec], chosen: claudeExec, reason: "Switch pool" });
    assert.equal(getTask(task.id).agent_id, "pool-claude-agent");
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.deepEqual(box.archivedAgents.sort(), ["pool-claude-agent", "pool-cursor-agent"]);
  });

  it("archives every review agent a reviewer card opened", async () => {
    const root = room("review-rounds");
    const box = harness(null);
    installCleanup(box.ops);
    let n = 0;
    const launcher: AgentLauncher = {
      async create() {
        n += 1;
        return { id: `review-round-${n}` };
      },
      async send() {},
    };
    const task = createTask({ project: "clean", title: "Multiple review rounds", role: "reviewer", workspacePath: root });
    await startTask(task.id, launcher, "test", { profiles: [reviewer], chosen: reviewer, reason: "First round" });
    applyFailure(task.id, "429 rate limit", "rate_limit", new Date(), "claude-max");
    assert.equal(getTask(task.id).status, "in_review");
    await startTask(task.id, launcher, "test", { profiles: [reviewer], chosen: reviewer, reason: "Second round" });
    assert.equal(getTask(task.id).agent_id, "review-round-2");
    archiveTask(task.id, "test");
    await flushCleanups();
    assert.deepEqual(box.archivedAgents.sort(), ["review-round-1", "review-round-2"]);
    assert.equal(getTask(task.id).status, "archived");
  });

  it("archives an agent left behind when opening fails after the agent exists", async () => {
    const root = room("orphan-root");
    const box = harness(null);
    installCleanup(box.ops);
    const task = createTask({ project: "clean", title: "Midway failure", role: "executor", workspacePath: root });
    getDb().exec("CREATE TRIGGER fail_run_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'run insert failed'); END");
    await assert.rejects(
      () => startTask(task.id, launcherFor(root, null, "unused"), "test", { profiles: [executor], chosen: executor, reason: "Test" }),
      /run insert failed/,
    );
    getDb().exec("DROP TRIGGER fail_run_insert");
    const opened = events(task.id, "agent_opened");
    assert.equal(opened.length, 1);
    const agentId = String(opened[0]?.agentId);
    assert.ok(agentId);
    getDb().prepare("UPDATE tasks SET agent_id = NULL, executor_agent_id = NULL WHERE id = ?").run(task.id);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(task.id) as { n: number }).n, 0);
    archiveTask(task.id, "test");
    await flushCleanups();
    assert.deepEqual(box.archivedAgents, [agentId]);
    assert.equal(getTask(task.id).status, "archived");
  });

  it("does not archive an agent that still has a turn running, then archives it once idle", async () => {
    const root = room("busy-root");
    const agentId = "busy-agent-11111111";
    const state = { busy: true };
    const box = harness(null);
    box.ops.inspectAgent = async (id) => {
      if (id !== agentId) return { archived: true, busy: false };
      return { archived: false, busy: state.busy };
    };
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "still running", role: "executor", workspacePath: root });
    const fixed: AgentLauncher = {
      async create() {
        return { id: agentId };
      },
      async send() {},
    };
    await startTask(task.id, fixed, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.deepEqual(box.archivedAgents, []);
    assert.equal(events(task.id, "cleanup").some((event) => event.action === "wait_turn" && event.reason === zhCN("archiveBook.reason.waitTurn")), true);
    assert.equal(listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote, zhCN("archiveBook.label.waiting", {"agent":"busy-age"}));
    assert.equal(events(task.id, "cleanup_finished").length, 0);

    const retryAt = Date.parse(String(events(task.id, "cleanup").find((event) => event.action === "wait_turn")?.retryAt));
    await drainCleanups(new Date(retryAt - 1000));
    assert.deepEqual(box.archivedAgents, []);

    state.busy = false;
    await drainCleanups(new Date(retryAt + 1000));
    assert.deepEqual(box.archivedAgents, [agentId]);
    assert.equal(events(task.id, "cleanup_finished").length, 1);
    assert.equal(listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote, null);
  });

  for (const finished of [false, true]) {
    it(`writes one wait for unchanged busy state on ${finished ? "finished reconcile" : "ordinary archiveAgents"}, then archives immediately`, async () => {
      const root = room(`wait-once-${finished}`);
      const agentId = `wait-once-${finished}-agent`;
      let busy = true;
      let archived = false;
      let looks = 0;
      const box = harness(null);
      box.ops.inspectAgent = async (id) => { if (id !== agentId) return { archived: true, busy: false }; looks++; return { archived, busy }; };
      box.ops.archiveAgent = async (id) => { box.archivedAgents.push(id); if (id === agentId) archived = true; };
      installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
      const task = createTask({ project: "clean", title: "Record only wait changes", role: "executor", workspacePath: root });
      await startTask(task.id, { async create() { return { id: agentId }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
      const start = Date.now();
      if (finished) {
        getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
        appendEvent(task.id, "cleanup_finished", null, null, "test", {});
        appendEvent(task.id, "cleanup", null, null, "test", { action: "archive_agent", agentId, ok: true, verifyAt: new Date(start - 1).toISOString() });
      } else {
        getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
        await acceptTask(task.id, "supervisor");
      }
      await drainCleanups(new Date(start));
      const waits = () => events(task.id, "cleanup").filter((event) => event.action === "wait_turn" && event.agentId === agentId);
      assert.equal(waits().length, 1);
      const waitRow = () => getDb().prepare("SELECT id, at, data_json FROM events WHERE task_id = ? AND kind = 'cleanup' AND json_extract(data_json, '$.action') = 'wait_turn' ORDER BY id DESC LIMIT 1").get(task.id) as { id: number; at: string; data_json: string };
      const firstRow = waitRow();
      const firstRetry = Date.parse(String(waits()[0]?.retryAt));
      await drainCleanups(new Date(firstRetry - 1));
      assert.equal(Date.parse(String(waits()[0]?.retryAt)), firstRetry, "no refresh before retryAt");
      await drainCleanups(new Date(firstRetry));
      const secondRetry = Date.parse(String(waits()[0]?.retryAt));
      assert.equal(secondRetry, firstRetry + 5 * 60_000, "renew the one-minute wait to five minutes");
      let clock = secondRetry;
      for (let i = 0; i < 2; i++) {
        clock += 61_000; // Beyond the original retryAt/grace and the archive deadline.
        if (!finished) {
          assert.ok((cleanupNoteFor(task.id, new Date(clock)) ?? "").includes(zhCNPart("audit.turnUnknown", 0, 4)), "without a fresh observation a stale wait remains unknown");
        }
        // Rebinding must recover the backoff stage from the stored row.
        installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
        await drainCleanups(new Date(clock));
        const retry = Date.parse(String(waits()[0]?.retryAt));
        assert.equal(retry, clock + 30 * 60_000, "advance and cap the wait at thirty minutes");
        assert.equal(waitRow().id, firstRow.id, "renew the same event ID");
        assert.equal(waitRow().at, firstRow.at, "keep the original entry time");
        if (!finished) {
          const now = new Date(clock);
          assert.match(cleanupNoteFor(task.id, now) ?? "", new RegExp("agent " + localePattern(zhCNPart("audit.turnOpen", 6, 13))));
          assert.deepEqual(turnOpenAgentIds(task.id, now), [agentId]);
          assert.deepEqual(turnUnknownAgentIds(task.id, now), []);
        }
        clock = retry;
      }
      assert.ok(looks >= 5, "busy agents still get inspected");
      assert.equal(waits().length, 1, "unchanged busy must not append another wait_turn");
      assert.equal(box.archivedAgents.includes(agentId), false);
      busy = false;
      await drainCleanups(new Date(clock - 1000));
      assert.deepEqual(box.archivedAgents.filter((id) => id === agentId), [agentId], "idle archives on the very next tick");
      assert.equal(waits().length, 1);
      if (finished) {
        // A successful archive clears waiting; a later running turn is a new transition.
        archived = false; busy = true;
        await drainCleanups(new Date(clock + 70_000));
        assert.equal(waits().length, 2);
      }
    });
  }

  for (const finished of [false, true]) {
    it(`archives before the first busy retryAt on ${finished ? "finished reconcile" : "ordinary archiveAgents"}`, async () => {
      const agentId = `early-idle-${finished}`;
      let busy = true;
      const box = harness(null);
      box.ops.inspectAgent = async (id) => ({ archived: id !== agentId, busy: id === agentId && busy });
      installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
      const task = createTask({ project: "clean", title: "Idle during window", role: "executor", workspacePath: room(agentId) });
      await startTask(task.id, { async create() { return { id: agentId }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
      const start = Date.now();
      if (finished) {
        getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
        appendEvent(task.id, "cleanup_finished", null, null, "test", {});
        appendEvent(task.id, "cleanup", null, null, "test", { action: "archive_agent", agentId, ok: true, verifyAt: new Date(start - 1).toISOString() });
      } else {
        getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
        await acceptTask(task.id, "supervisor");
      }
      await drainCleanups(new Date(start));
      const waits = () => events(task.id, "cleanup").filter((event) => event.action === "wait_turn" && event.agentId === agentId);
      assert.equal(waits().length, 1);
      const retryAt = Date.parse(String(waits()[0]?.retryAt));
      const idleAt = retryAt - 1000;
      assert.ok(idleAt > start && idleAt < retryAt);
      busy = false;
      await drainCleanups(new Date(idleAt));
      assert.equal(box.archivedAgents.filter((id) => id === agentId).length, 1, "archive even inside the backoff window");
      assert.equal(waits().length, 1);
      assert.equal(events(task.id, "cleanup").filter((event) => event.action === "turn_idle" && event.agentId === agentId).length, 1);
    });
  }

  it("re-archives an agent Paseo wrote back, and stops after three restores", async () => {
    const root = room("restore-root");
    const agentId = "restore-agent-2222";
    const foreign = "foreign-token-agent";
    const state = { archived: false, busy: false };
    let calls = 0;
    const box = harness(null);
    box.ops.archiveAgent = async (id) => {
      calls += 1;
      if (id === foreign) throw new Error("Do not archive another agent agent");
      if (id !== agentId) throw new Error(`Unexpected agent ${id}`);
      box.archivedAgents.push(id);
    };
    box.ops.inspectAgent = async (id) => {
      if (id === foreign) return { archived: false, busy: false };
      if (id !== agentId) return { archived: true, busy: false };
      return { archived: state.archived, busy: state.busy };
    };
    const sent: Array<{ id: string; text: string }> = [];
    armSupervisor(sent);
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "Will be overwritten", role: "executor", workspacePath: root });
    const fixed: AgentLauncher = {
      async create() {
        return { id: agentId };
      },
      async send() {},
    };
    await startTask(task.id, fixed, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.equal(calls, 1);
    assert.equal(events(task.id, "cleanup_finished").length, 1);
    getDb()
      .prepare("INSERT INTO tokens (token, task_id, role, agent_id, created_at) VALUES (?, ?, 'executor', ?, ?)")
      .run(`tok-${task.id}`, task.id, foreign, new Date().toISOString());

    state.busy = true;
    let cursor = Date.now();
    cursor += 70_000;
    await drainCleanups(new Date(cursor));
    assert.equal(calls, 1);
    assert.equal(events(task.id, "cleanup").some((event) => event.action === "wait_turn" && event.reason === zhCN("archiveBook.reason.waitTurn")), true);
    assert.equal(box.archivedAgents.includes(foreign), false);

    state.busy = false;
    for (let i = 0; i < 3; i += 1) {
      state.archived = false;
      state.busy = false;
      cursor += 70_000;
      await drainCleanups(new Date(cursor));
      assert.equal(calls, i + 2, `${zhCNPart("flow.comment.round3", 0, 2)}${i + 1} recoveries`);
      const restored = events(task.id, "cleanup").filter((event) => event.restored === true);
      assert.equal(restored.length, i + 1);
      assert.equal(restored.at(-1)?.reason, zhCN("archiveBook.reason.restored"));
    }
    assert.equal(box.archivedAgents.includes(foreign), false);

    state.archived = false;
    cursor += 70_000;
    await drainCleanups(new Date(cursor));
    assert.equal(calls, 4);
    assert.equal(listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote, zhCN("archiveBook.label.restored", {"agent":"restore-"}));
    assert.equal(sent.filter((item) => item.id === "kanban-boss" && item.text.includes(zhCN("archiveBook.label.restored", {"agent":"restore-"}))).length, 1);
    assert.equal(box.archivedAgents.includes(foreign), false);

    state.archived = false;
    cursor += 70_000;
    await drainCleanups(new Date(cursor));
    assert.equal(calls, 4);
    assert.equal(sent.filter((item) => item.text.includes(zhCN("archiveBook.label.restored", {"agent":"restore-"}))).length, 1);
  });

  it("archives the reviewer when they give a verdict, and opens a new reviewer next round", async () => {
    const root = room("verdict-root");
    const box = harness(null);
    installCleanup(box.ops);
    let n = 0;
    const launcher: AgentLauncher = {
      async create() {
        n += 1;
        return { id: `verdict-${n}` };
      },
      async send() {},
    };
    const task = createTask({ project: "clean", title: "Reject first", role: "executor", workspacePath: root });
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Test" });
    const executorId = getTask(task.id).agent_id ?? "";
    completeTask(task.id, "executor", "Handoff", null);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    const firstReviewer = getTask(task.id).agent_id ?? "";
    requestChanges(task.id, "Edit", "Details");
    await flushCleanups();
    assert.equal(getTask(task.id).status, "rework");
    assert.equal(box.archivedAgents.includes(firstReviewer), true);
    assert.equal(box.archivedAgents.includes(executorId), false);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Rework" });
    assert.equal(getTask(task.id).agent_id, executorId);
    completeTask(task.id, "executor", "Updated", null);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Review again" });
    const secondReviewer = getTask(task.id).agent_id ?? "";
    assert.notEqual(secondReviewer, firstReviewer);
    approveTask(task.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await flushCleanups();
    assert.equal(getTask(task.id).status, "acceptance");
    assert.equal(box.archivedAgents.includes(secondReviewer), true);
    assert.equal(box.archivedAgents.includes(executorId), true);
  });

  it("archives the executor on acceptance and does not send the rejection back to them", async () => {
    const root = room("accept-release");
    const box = harness(null);
    installCleanup(box.ops);
    const launcher: AgentLauncher = {
      async create() {
        return { id: "exec-accept" };
      },
      async send() {
        throw new Error((zhCNPart("boardView.accept.external", 0, 4) + zhCNPart("taskLifecycle.blockIgnored.archived", 3, 7) + "Demo text"));
      },
    };
    const task = createTask({ project: "clean", title: "Collect at acceptance", role: "executor", workspacePath: root });
    await startTask(task.id, launcher, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    completeTask(task.id, "executor", "Handoff", null);
    const reviewerLauncher: AgentLauncher = {
      async create() {
        return { id: "review-accept" };
      },
      async send() {},
    };
    await startTask(task.id, reviewerLauncher, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    approveTask(task.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await flushCleanups();
    assert.equal(getTask(task.id).status, "acceptance");
    assert.equal(box.archivedAgents.includes("exec-accept"), true);
    assert.equal(box.archivedAgents.includes("review-accept"), true);
    assert.deepEqual(box.archivedWorkspaces, []);
    const rejected = rejectTask(task.id, zhCNPart("flow.error.reviewerReject", 3, 7), "supervisor");
    assert.equal(rejected.status, "rework");
    assert.equal(rejected.executor_agent_id, null);
    const opened: string[] = [];
    await startTask(
      task.id,
      {
        async create() {
          opened.push("new");
          return { id: "exec-again" };
        },
        async send() {
          throw new Error("Do not return");
        },
      },
      "test",
      { profiles: [executor], chosen: executor, reason: "Restart" },
    );
    assert.deepEqual(opened, ["new"]);
    assert.equal(getTask(task.id).executor_agent_id, "exec-again");
  });

  it("waits until the reviewer's turn is idle before archiving them", async () => {
    const root = room("busy-review");
    const box = harness(null);
    let reviewerBusy = true;
    box.ops.inspectAgent = async (agentId) => ({ archived: false, busy: agentId === "review-busy" && reviewerBusy });
    installCleanup(box.ops);
    const task = createTask({ project: "clean", title: "Review still wrapping up", role: "executor", workspacePath: root });
    await startTask(task.id, { async create() { return { id: "exec-busy" }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    completeTask(task.id, "executor", "Handoff", null);
    await startTask(task.id, { async create() { return { id: "review-busy" }; }, async send() {} }, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    approveTask(task.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await flushCleanups();
    assert.equal(box.archivedAgents.includes("exec-busy"), true);
    assert.equal(box.archivedAgents.includes("review-busy"), false);
    assert.equal(events(task.id, "cleanup").some((event) => event.action === "wait_turn" && event.agentId === "review-busy"), true);
    reviewerBusy = false;
    const retryAt = Date.parse(String(events(task.id, "cleanup").find((event) => event.action === "wait_turn")?.retryAt));
    await drainCleanups(new Date(retryAt + 1000));
    assert.equal(box.archivedAgents.includes("review-busy"), true);
  });

  it("records ordinary archive complete when Paseo says Agent not found and the file is gone", async () => {
    const root = room("gone-ordinary");
    const agentId = "gone-ordinary-agent";
    const box = harness(null);
    box.ops.inspectAgent = inspectLikePaseo();
    installCleanup(box.ops);
    const task = createTask({ project: "clean", title: "agent already gone", role: "executor", workspacePath: root });
    await startTask(task.id, { async create() { return { id: agentId }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.deepEqual(box.archivedAgents, []);
    const archived = events(task.id, "cleanup").find((event) => event.action === "archive_agent" && event.agentId === agentId && event.ok === true);
    assert.ok(archived);
    assert.equal(archived?.reason, zhCN("cleanup.reason.gone"));
    assert.equal(events(task.id, "cleanup_finished").length, 1);
    assert.equal(events(task.id, "cleanup").some((event) => String(event.error ?? "").includes(zhCNPart("cleanup.error.unreadable", 0, 9))), false);
  });

  it("backs off ordinary archive when the agent query times out", async () => {
    const root = room("query-timeout");
    const agentId = "timeout-ordinary-agent";
    const box = harness(null);
    box.ops.inspectAgent = inspectLikePaseo(new Set([agentId]));
    installCleanup(box.ops, { timeoutMs: 30 });
    const task = createTask({ project: "clean", title: "Query timeout", role: "executor", workspacePath: root });
    await startTask(task.id, { async create() { return { id: agentId }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    const start = new Date();
    await drainCleanups(start);
    const failures = () => events(task.id, "cleanup").filter((event) => event.action === "archive_agent" && event.agentId === agentId && event.ok === false);
    assert.equal(failures().length, 1);
    assert.match(String(failures()[0]?.error), new RegExp(localePattern(zhCNPart("cleanup.error.unreadable", 0, 9))));
    const retryAt = Date.parse(String(failures()[0]?.retryAt));
    assert.equal(Number.isFinite(retryAt), true);
    assert.equal(events(task.id, "cleanup_finished").length, 0);
    assert.deepEqual(box.archivedAgents, []);
    await drainCleanups(new Date(retryAt - 1000));
    assert.equal(failures().length, 1);
    assert.equal(events(task.id, "cleanup_finished").length, 0);
  });

  it("does not report a running turn as stuck, and archives on the next tick once idle", async () => {
    const root = room("wait-turn-idle");
    const agentId = "wait-turn-idle-agent";
    const state = { busy: true };
    const box = harness(null);
    box.ops.inspectAgent = async (id) => {
      if (id !== agentId) return { archived: true, busy: false };
      return { archived: false, busy: state.busy };
    };
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "Wait for turn", role: "executor", workspacePath: root });
    await startTask(task.id, { async create() { return { id: agentId }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    const start = Date.now();
    await acceptTask(task.id, "supervisor");
    await drainCleanups(new Date(start));
    assert.equal(box.archivedAgents.includes(agentId), false);
    const firstRetry = Date.parse(String(events(task.id, "cleanup").find((event) => event.action === "wait_turn")?.retryAt));
    assert.equal(Number.isFinite(firstRetry), true);
    await drainCleanups(new Date(firstRetry + 1000));
    assert.equal(box.archivedAgents.includes(agentId), false);
    const waits = () => events(task.id, "cleanup").filter((event) => event.action === "wait_turn");
    assert.equal(waits().length, 1);
    const laterRetry = Date.parse(String(waits().at(-1)?.retryAt));
    assert.equal(laterRetry, firstRetry + 1000 + 5 * 60_000);

    const doneAt = new Date(start - DEFAULT_ARCHIVE_DEADLINE_MS - 1000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND to_status = 'done'").run(doneAt, task.id);
    const sent: Array<{ id: string; text: string }> = [];
    armSupervisor(sent);
    const almost = new Date(laterRetry + 1_001);
    await drainCleanups(almost);
    assert.equal(box.archivedAgents.includes(agentId), false);
    const note = listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote ?? "";
    assert.equal(note.includes(zhCNPart("audit.overdue", 0, 5)), false);
    assert.match(note, new RegExp("agent " + localePattern(zhCNPart("audit.turnOpen", 6, 13))));
    assert.equal(
      sent.some((item) => item.text.includes("Wait for turn") && (item.text.includes(zhCN("wake.board.archiveStuck")) || item.text.includes(zhCNPart("audit.overdue", 0, 5)))),
      false,
    );
    const audit = formatAudit(
      await performAudit({
        async listActiveAgents() {
          return [{ id: agentId, archived: false, workspaceId: null }];
        },
        async inspectWorkspace() {
          return null;
        },
      }),
    );
    assert.equal(audit.includes(zhCNPart("audit.overdue", 0, 5)), false);
    assert.match(audit, new RegExp(`agent ${zhCNPart("audit.turnOpen", 6, 14)}${agentId}`));

    state.busy = false;
    await drainCleanups(new Date(almost.getTime() + 1000));
    assert.equal(box.archivedAgents.includes(agentId), true);
    assert.equal(events(task.id, "cleanup_finished").length, 1);
    assert.equal(listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote ?? null, null);
  });

  it("does not send a deadline wake when a late tick finds the turn still running", async () => {
    const root = room("wait-turn-late-tick");
    const agentId = "wait-turn-late-agent";
    const state = { busy: true };
    const box = harness(null);
    box.ops.inspectAgent = async (id) => {
      if (id !== agentId) return { archived: true, busy: false };
      return { archived: false, busy: state.busy };
    };
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "Late tick", role: "executor", workspacePath: root });
    await startTask(task.id, { async create() { return { id: agentId }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    const start = Date.now();
    await acceptTask(task.id, "supervisor");
    await drainCleanups(new Date(start));
    const firstRetry = Date.parse(String(events(task.id, "cleanup").find((event) => event.action === "wait_turn")?.retryAt));
    await drainCleanups(new Date(firstRetry + 1000));
    const laterRetry = Date.parse(String(events(task.id, "cleanup").filter((event) => event.action === "wait_turn").at(-1)?.retryAt));
    assert.equal(laterRetry, firstRetry + 1000 + 5 * 60_000);
    const doneAt = new Date(start - DEFAULT_ARCHIVE_DEADLINE_MS - 1000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND to_status = 'done'").run(doneAt, task.id);
    const sent: Array<{ id: string; text: string }> = [];
    armSupervisor(sent);
    await drainCleanups(new Date(laterRetry + 61_000));
    assert.equal(box.archivedAgents.includes(agentId), false);
    assert.equal(events(task.id, "cleanup").some((event) => event.action === "wait_turn" && event.agentId === agentId), true);
    const note = listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote ?? "";
    assert.equal(note.includes(zhCNPart("audit.overdue", 0, 5)), false);
    assert.equal(
      sent.some((item) => item.text.includes("Late tick") && (item.text.includes(zhCN("wake.board.archiveStuck")) || item.text.includes(zhCNPart("audit.overdue", 0, 5)))),
      false,
    );
  });

  it("still reports an idle agent whose archive keeps failing", async () => {
    const root = room("idle-archive-fail");
    const agentId = "idle-archive-fail-agent";
    const box = harness(null);
    box.ops.inspectAgent = async () => ({ archived: false, busy: false });
    box.ops.archiveAgent = async () => {
      throw new Error(zhCN("dispatch.archiveFailed"));
    };
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "Idle but archive fails", role: "executor", workspacePath: root });
    await startTask(task.id, { async create() { return { id: agentId }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    const start = Date.now();
    await acceptTask(task.id, "supervisor");
    await drainCleanups(new Date(start));
    assert.equal(events(task.id, "cleanup").some((event) => event.action === "wait_turn"), false);
    assert.equal(events(task.id, "cleanup").some((event) => event.action === "archive_agent" && event.ok === false), true);
    const doneAt = new Date(start - DEFAULT_ARCHIVE_DEADLINE_MS - 1000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND to_status = 'done'").run(doneAt, task.id);
    const sent: Array<{ id: string; text: string }> = [];
    armSupervisor(sent);
    await drainCleanups(new Date(start + 1000));
    const note = listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote ?? "";
    assert.match(note, new RegExp(zhCN("archiveBook.label.overdue", {"agent":"idle-arc"})));
    assert.equal(note.includes(zhCNPart("audit.turnOpen", 6, 13)), false);
    assert.equal(sent.some((item) => item.text.includes(zhCN("wake.board.archiveStuck")) && item.text.includes(zhCNPart("audit.overdue", 0, 5))), true);
  });

  it("writes one verify for an archived agent, and writes again only when that agent comes back", async () => {
    const root = room("verify-once");
    const agentId = "verify-once-agent";
    const state = { archived: true, busy: false };
    const box = harness(null);
    box.ops.inspectAgent = async (id) => {
      if (id !== agentId) return { archived: true, busy: false };
      return { archived: state.archived, busy: state.busy };
    };
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "Verify once", role: "executor", workspacePath: root });
    await startTask(task.id, { async create() { return { id: agentId }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    await flushCleanups();
    assert.equal(events(task.id, "cleanup_finished").length, 1);
    const verifies = () =>
      events(task.id, "cleanup").filter((event) => event.action === "verify_agent" && event.agentId === agentId && event.ok === true);
    assert.equal(verifies().length, 0);

    let cursor = Date.now();
    const again = async (step: number) => {
      cursor += step;
      installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
      await drainCleanups(new Date(cursor));
    };
    await again(70_000);
    assert.equal(verifies().length, 1);
    await again(70_000);
    await again(11 * 60_000);
    assert.equal(verifies().length, 1, (zhCNPart("compat.skip.worktree", 25, 27) + zhCN("missingCwd.report.isArchived") + zhCNPart("doctor.timeout.symptom", 5, 8) + "Demo text verify_agent"));

    state.archived = false;
    await again(70_000);
    assert.equal(verifies().length, 1);
    const restored = events(task.id, "cleanup").filter((event) => event.action === "archive_agent" && event.agentId === agentId && event.restored === true);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.reason, zhCN("archiveBook.reason.restored"));

    state.archived = true;
    await again(70_000);
    assert.equal(verifies().length, 2);
    await again(70_000);
    await again(11 * 60_000);
    assert.equal(verifies().length, 2);
  });

  it("confirms an archived claimed agent once when archive_agent never succeeded", async () => {
    const root = room("verify-no-archive");
    const agentId = "no-archive-ok";
    const state = { archived: true };
    let inspections = 0;
    const box = harness(null);
    box.ops.inspectAgent = async (id) => {
      if (id !== agentId) return { archived: true, busy: false };
      inspections += 1;
      return { archived: state.archived, busy: false };
    };
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    const task = createTask({ project: "clean", title: "No successful archive record", role: "executor", workspacePath: root });
    getDb().prepare("UPDATE tasks SET status = 'archived', agent_id = ? WHERE id = ?").run(agentId, task.id);
    appendEvent(task.id, "cleanup_finished", null, null, "kanban", {});
    const verifies = () =>
      events(task.id, "cleanup").filter((event) => event.action === "verify_agent" && event.agentId === agentId && event.ok === true);
    assert.equal(verifies().length, 0);
    assert.equal(
      readCleanupEvents(task.id).some((event) => event.action === "archive_agent" && event.agentId === agentId && event.ok === true),
      false,
    );

    const start = Date.now();
    let sweeps = 0;
    for (let i = 0; i < 3; i += 1) {
      sweeps += 1;
      await drainCleanups(new Date(start + i * 660_000));
      await flushCleanups();
    }
    assert.equal(sweeps, 3);
    assert.equal(inspections, 3);
    assert.equal(verifies().length, 1, (zhCNPart("wake.board.reviewRuling", 2, 6) + "rchive_agent " + zhCNPart("nativeSessions.sweep.noEvidence", 12, 14) + zhCNPart("dispatch.notRecorded", 1, 3) + zhCNPart("doctor.timeout.symptom", 5, 7) + "Three attempts sweep writes one record verify_agent"));
    assert.equal(getTask(task.id).status, "archived");
    assert.equal(state.archived, true);

    state.archived = false;
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    await drainCleanups(new Date(start + 3 * 660_000));
    const archivedAgain = events(task.id, "cleanup").filter((event) => event.action === "archive_agent" && event.agentId === agentId && event.ok === true);
    assert.equal(archivedAgain.length, 1, ("agent " + zhCNPart("cardParts.event.reopened", 0, 2) + zhCNPart("board.empty", 14, 16) + zhCNPart("doctor.decision.suggestion", 10, 12) + "Demo text"));
    assert.equal(verifies().length, 1);

    state.archived = true;
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    await drainCleanups(new Date(start + 3 * 660_000 + 70_000));
    assert.equal(verifies().length, 2);
    installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
    await drainCleanups(new Date(start + 4 * 660_000));
    await flushCleanups();
    assert.equal(verifies().length, 2);
  });

  it("keeps a verify-only confirmation across sweeps and a cleanup reinstall", async () => {
    const root = room("verify-only-rows");
    const agentId = "verify-only-agent";
    let inspections = 0;
    const box = harness(null);
    box.ops.inspectAgent = async (id) => {
      if (id !== agentId) return { archived: true, busy: false };
      inspections += 1;
      return { archived: true, busy: false };
    };
    const task = createTask({ project: "clean", title: "Verification row only", role: "executor", workspacePath: root });
    getDb().prepare("UPDATE tasks SET status = 'archived', agent_id = ? WHERE id = ?").run(agentId, task.id);
    appendEvent(task.id, "cleanup_finished", null, null, "kanban", {});
    appendEvent(task.id, "cleanup", null, null, "kanban", { action: "verify_agent", agentId, ok: true });
    const loaded = readCleanupEvents(task.id).filter((event) => event.action === "verify_agent" && event.agentId === agentId);
    assert.equal(loaded.length, 1, (zhCNPart("nativeSessions.reset.uncardedKanbanLeader", 9, 12) + "verify rows still include this check"));
    const verifies = () =>
      events(task.id, "cleanup").filter((event) => event.action === "verify_agent" && event.agentId === agentId && event.ok === true);

    const start = Date.now();
    for (let i = 0; i < 3; i += 1) {
      installCleanup(box.ops, { timeoutMs: 30, concurrency: 2 });
      await drainCleanups(new Date(start + i * 660_000));
      await flushCleanups();
    }
    assert.equal(inspections, 3);
    assert.equal(verifies().length, 1, ("Reinstall cleanup and run repeated sweep " + zhCNPart("doctor.decision.suggestion", 10, 12) + zhCNPart("cardDrawer.settings.tierUnset", 2, 4) + zhCNPart("cardDrawer.runs.title", 2, 4) + "verify row remains confirmed"));
    assert.equal(getTask(task.id).status, "archived");
  });
});
