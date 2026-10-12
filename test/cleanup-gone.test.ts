import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { performAudit } from "../server/audit";
import { cleanupIssues, readCleanupEvents, restoreStoppedIds, type CleanupRecord } from "../server/archive-book";
import { enqueueCleanups, flushCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { directoryAbsent } from "../server/cleanup-gone";
import { closeDb, getDb } from "../server/db";
import { cleanupOps } from "../server/paseo";
import { appendEvent, createTask, getDetail, listBoard } from "../server/store";
import { cardSchema } from "../shared/rpc";
import { DEFAULT_RECONCILE_INTERVAL_MS } from "../server/config";

const dir = mkdtempSync(join(tmpdir(), "cleanup-gone-"));
process.env.KANBAN_DATA_DIR = join(dir, "board");
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR);
process.env.KANBAN_WORKTREES_ROOT = join(dir, "worktrees");
mkdirSync(process.env.KANBAN_WORKTREES_ROOT);
const future = new Date(Date.now() + 86400_000).toISOString();
const historical = Array.from({ length: 9 }, (_, index) => [
  `DEMO_${String(index + 1).padStart(4, "0")}`, `demo-workspace-${index + 1}`,
]);

after(() => { installCleanup(null); closeDb(); rmSync(dir, { recursive: true, force: true }); });
let serial = 0;
beforeEach(async () => {
  installCleanup(null);
  await flushCleanups();
  closeDb();
  process.env.KANBAN_DATA_DIR = join(dir, `board-${++serial}`);
});

function readOnlyOps(overrides: Partial<CleanupOps> = {}): CleanupOps {
  return {
    archiveAgent: async () => { assert.fail("absence reconciliation must not archive"); },
    archiveWorkspace: async () => { assert.fail("absence reconciliation must not archive"); },
    listAgents: async () => [], inspectWorkspace: async () => null, inspectAgent: async () => null,
    listWorkspaceIds: async () => new Set<string>(), ...overrides,
  };
}

async function sweep(ops = readOnlyOps(), timeoutMs = 5_000): Promise<void> {
  installCleanup(ops, { timeoutMs });
  enqueueCleanups();
  await flushCleanups();
}

function fixture(extra: Partial<CleanupRecord> = {}, finished = true) {
  const task = createTask({ project: "gone", title: "isolated cleanup", role: "executor", workspacePath: dir });
  const root = join(dir, `repo-${serial}-${task.id}`);
  const directory = join(process.env.KANBAN_WORKTREES_ROOT!, `card-${serial}-${task.id}`);
  const branch = `kanban/${task.id}-gone`;
  const workspaceId = `fixture-ws-${task.id}`;
  const agentId = `fixture-agent-${task.id}`;
  mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  getDb().prepare("UPDATE tasks SET status = 'archived', workspace_kind = 'worktree', workspace_path = ?, paseo_workspace_id = ?, agent_id = ? WHERE id = ?").run(directory, workspaceId, agentId, task.id);
  appendEvent(task.id, "worktree_created", null, null, "test", { root, directory, branch, base: "main", workspaceId });
  appendEvent(task.id, "cleanup", null, null, "test", { action: "archive_workspace", workspaceId, ok: false, error: "Daemon client closed", stopped: true, retryAt: future, ...extra });
  if (finished) appendEvent(task.id, "cleanup_finished", null, null, "test", {});
  else appendEvent(task.id, "cleanup", null, null, "test", { action: "error", ok: false, stopped: true, retryAt: future });
  return { task, root, directory, branch, workspaceId, agentId };
}

function failures(id: number) { return readCleanupEvents(id).filter(row => row.ok === false); }
function gone(id: number) { return readCleanupEvents(id).filter(row => row.ok && row.reason === "gone"); }

it("ordinary periodic reconciliation resolves the nine archived demo workspace failures without resume", async () => {
  const ids = historical.map(([code, workspaceId], index) => {
    const task = createTask({ project: code.split("_")[0], title: code, role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'archived', workspace_kind = 'worktree', paseo_workspace_id = ? WHERE id = ?").run(workspaceId!, task.id);
    appendEvent(task.id, "workspace_bound", null, null, "test", { workspaceId });
    appendEvent(task.id, "cleanup", null, null, "test", {
      action: "archive_workspace", workspaceId, ok: false, outcome: index % 2 ? "error" : "timeout",
      error: index % 2 ? "Daemon client closed" : "timeout", stopped: index % 3 === 0, retryAt: future,
    });
    appendEvent(task.id, "cleanup_finished", null, null, "test", {});
    return task.id;
  });
  const view = { listActiveAgents: async () => [], inspectWorkspace: async () => null };
  assert.equal((await performAudit(view)).cards.filter(card => ids.includes(card.id) && card.failures.length).length, 9);
  let inventories = 0;
  const ops = readOnlyOps({ listWorkspaceIds: async () => { inventories++; return new Set<string>(); } });
  await sweep(ops);
  assert.equal(inventories, 1, "one complete inventory covers this whole round");
  for (const id of ids) {
    assert.equal(readCleanupEvents(id).filter(row => row.action === "archive_workspace" && row.ok && row.reason === "gone").length, 1);
    assert.equal(listBoard().tasks.find(task => task.id === id)?.cleanupNote, null);
    assert.equal(cardSchema.parse(getDetail(id).task).cleanupNote, null, "the actual task RPC payload has no alert");
    assert.ok(gone(id)[0]?.failureRowId, "the original immutable failure is referenced");
    assert.equal(failures(id).length, 1, "keep the failure history");
  }
  assert.equal((await performAudit(view)).cards.filter(card => ids.includes(card.id) && card.failures.length).length, 0);
  const count = getDb().prepare("SELECT COUNT(*) AS n FROM events").get()!;
  await sweep(ops); // Includes a restart, not just the in-memory cache.
  await sweep(ops);
  assert.deepEqual(getDb().prepare("SELECT COUNT(*) AS n FROM events").get(), count);
  assert.equal(inventories, 1, "resolved failures no longer query inventory");
});

it("keeps a present workspace and every unknown inventory without changing backoff", async () => {
  const { task, workspaceId } = fixture();
  const before = readCleanupEvents(task.id);
  for (const listWorkspaceIds of [
    async () => new Set([workspaceId]),
    async (): Promise<Set<string>> => { throw new Error("Daemon client closed"); },
    async (): Promise<Set<string>> => { throw new Error("EACCES"); },
    async (): Promise<Set<string>> => new Promise(() => {}),
  ]) {
    await sweep(readOnlyOps({ listWorkspaceIds }), 30);
    assert.deepEqual(readCleanupEvents(task.id), before);
    assert.equal(cleanupIssues(task.id).failures.length, 1);
  }
});

it("the real Paseo adapter requires all pages, including valid cursor termination", async () => {
  const { task, workspaceId } = fixture();
  const entry = { id: workspaceId, workspaceKind: "worktree", projectRootPath: dir, archivingAt: null };
  for (const pages of [
    [{ entries: [], pageInfo: { nextCursor: "next" } }, { entries: [entry], pageInfo: { nextCursor: null } }],
    [{ entries: [], pageInfo: { nextCursor: "next" } }, { entries: [] }],
    [{ entries: [], pageInfo: { nextCursor: undefined } }],
    [{ entries: [], pageInfo: { nextCursor: "" } }],
    [{ entries: [], pageInfo: { nextCursor: "next" } }, { entries: [], pageInfo: { nextCursor: "next" } }],
    [{ entries: [{ id: workspaceId }], pageInfo: { nextCursor: null } }],
  ]) {
    let page = 0;
    const adapter = cleanupOps({ workspaces: { list: async () => pages[page++] } } as unknown as PaseoApi);
    await sweep(readOnlyOps({ listWorkspaceIds: adapter.listWorkspaceIds }));
    assert.equal(gone(task.id).length, 0);
  }
  const adapter = cleanupOps({ workspaces: { list: async () => ({ entries: [], pageInfo: { nextCursor: null } }) } } as unknown as PaseoApi);
  await sweep(readOnlyOps({ listWorkspaceIds: adapter.listWorkspaceIds }));
  assert.equal(gone(task.id).length, 1);
});

it("stopped, future retry and card-level stop do not prevent a missing-resource check", async () => {
  const { task, agentId } = fixture({}, false);
  for (let i = 0; i < 3; i++) appendEvent(task.id, "cleanup", null, null, "test", { action: "archive_agent", agentId, ok: false, outcome: "timeout", retryAt: future });
  appendEvent(task.id, "cleanup", null, null, "test", { action: "restore_stuck", agentId, ok: false });
  await sweep();
  assert.equal(gone(task.id).filter(row => row.action === "archive_agent").length, 1);
  assert.equal(gone(task.id).filter(row => row.action === "archive_workspace").length, 1);
  assert.deepEqual(restoreStoppedIds(readCleanupEvents(task.id)), []);
  assert.deepEqual(cleanupIssues(task.id), { stuck: [], failures: [] });
  assert.equal(getDetail(task.id).task.cleanupNote, null);
  assert.equal(readCleanupEvents(task.id).find(row => row.action === "error")?.stopped, true, "unrelated card-level failure is not cleared");
});

it("keeps a stopped present/busy agent and unknown agent reads", async () => {
  const { task, agentId } = fixture({ action: "archive_agent", workspaceId: undefined, agentId: "fixture-agent-1" });
  assert.equal(agentId, "fixture-agent-1");
  const before = readCleanupEvents(task.id);
  for (const inspectAgent of [
    async () => ({ archived: false, busy: true }),
    async (): Promise<null> => { throw new Error("lookup failed"); },
    async (): Promise<null> => new Promise(() => {}),
  ]) {
    await sweep(readOnlyOps({ inspectAgent }), 30);
    assert.deepEqual(readCleanupEvents(task.id), before);
  }
});

it("independently verifies directory and branch and preserves a mixed card's live branch", async () => {
  const f = fixture({ action: "drop_directory", workspaceId: undefined });
  // Replace only this isolated fixture row with its exact owned targets.
  const id = failures(f.task.id)[0]!.rowId!;
  getDb().prepare("UPDATE events SET data_json = ? WHERE id = ?").run(JSON.stringify({ action: "drop_directory", directory: f.directory, ok: false, retryAt: future, stopped: true }), id);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: f.root });
  execFileSync("git", ["branch", f.branch], { cwd: f.root });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "delete_branch", directory: f.directory, branch: f.branch, ok: false, retryAt: future });
  await sweep();
  assert.equal(gone(f.task.id).some(row => row.action === "drop_directory"), true);
  assert.equal(gone(f.task.id).some(row => row.action === "delete_branch"), false);
  assert.equal(execFileSync("git", ["show-ref", "--verify", `refs/heads/${f.branch}`], { cwd: f.root, encoding: "utf8" }).includes(f.branch), true);
  // A separate never-created local branch is absent. Its absence needs no merge or delete command.
  const missingBranch = `kanban/${f.task.id}-absent`;
  appendEvent(f.task.id, "worktree_created", null, null, "test", { root: f.root, directory: f.directory, branch: missingBranch, workspaceId: f.workspaceId });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "delete_branch", directory: f.directory, branch: missingBranch, ok: false, retryAt: future });
  await sweep();
  assert.equal(gone(f.task.id).some(row => row.action === "delete_branch" && row.branch === missingBranch), true);
  assert.equal(gone(f.task.id).some(row => row.branch === f.branch), false);
});

it("composite worktree failure needs both directory and branch absent; unreadable repo is unknown", async () => {
  const f = fixture();
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "remove_worktree", directory: f.directory, branch: f.branch, ok: false });
  await sweep();
  assert.equal(gone(f.task.id).some(row => row.action === "remove_worktree"), true);
  const other = fixture();
  rmSync(other.root, { recursive: true });
  appendEvent(other.task.id, "cleanup", null, null, "test", { action: "delete_branch", directory: other.directory, branch: other.branch, ok: false });
  await sweep();
  assert.equal(gone(other.task.id).some(row => row.action === "delete_branch"), false);
});

it("purge success is scoped to the missing agent, never all agents on a mixed card", async () => {
  const f = fixture();
  const present = "still-running";
  getDb().prepare("UPDATE tasks SET executor_agent_id = ? WHERE id = ?").run(present, f.task.id);
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "purge_agents", directory: f.directory, agentId: f.agentId, ok: false, retryAt: future });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "purge_agents", directory: f.directory, ok: false, retryAt: future });
  await sweep(readOnlyOps({ inspectAgent: async id => id === present ? { archived: false, busy: true } : null }));
  assert.equal(gone(f.task.id).filter(row => row.action === "purge_agents" && row.agentId === f.agentId).length, 1);
  assert.equal(gone(f.task.id).filter(row => row.action === "purge_agents" && !row.agentId).length, 0);
});

it("does not settle foreign IDs, a main directory, protected branches, or resources shared by an active card", async () => {
  const f = fixture();
  const active = createTask({ project: "gone", title: "active sharer", role: "executor", workspacePath: f.directory });
  getDb().prepare("UPDATE tasks SET paseo_workspace_id = ?, agent_id = ? WHERE id = ?").run(f.workspaceId, f.agentId, active.id);
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "archive_agent", agentId: f.agentId, ok: false });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "archive_agent", agentId: "foreign", ok: false });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "archive_workspace", workspaceId: "foreign", ok: false });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "drop_directory", directory: f.directory, ok: false });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "drop_directory", directory: f.root, ok: false });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "delete_branch", directory: f.directory, branch: "main", ok: false });
  await sweep();
  assert.equal(gone(f.task.id).length, 0);
});

it("directory read failures, dangling symlinks and placeholders are not absence", async () => {
  const missing = join(dir, "really-missing", "child");
  assert.equal(await directoryAbsent(missing), true);
  const link = join(dir, "dangling"); symlinkSync(join(dir, "missing-target"), link);
  assert.equal(await directoryAbsent(link), false);
  assert.equal(await directoryAbsent(join(link, "child")), false);
  const placeholder = join(dir, "placeholder"); mkdirSync(placeholder); writeFileSync(join(placeholder, "KEEP"), "fixture");
  assert.equal(await directoryAbsent(placeholder), false);
  const denied = Object.assign(new Error("unreadable"), { code: "EACCES" });
  assert.equal(await directoryAbsent(missing, { lstat: async () => { throw denied; }, readdir: async () => { throw denied; } } as unknown as Parameters<typeof directoryAbsent>[1]), false);
});

it("a missing lane branch is confirmed while its permanent directory is kept", async () => {
  const f = fixture();
  mkdirSync(f.directory);
  getDb().prepare("UPDATE tasks SET workspace_kind = 'lane' WHERE id = ?").run(f.task.id);
  appendEvent(f.task.id, "lane_bound", null, null, "test", { lane: "fixture", directory: f.directory, root: f.root, branch: f.branch });
  appendEvent(f.task.id, "cleanup", null, null, "test", { action: "delete_lane_branch", directory: f.directory, branch: f.branch, ok: false, retryAt: future });
  await sweep();
  assert.equal(gone(f.task.id).filter(row => row.action === "delete_lane_branch").length, 1);
  assert.equal(await directoryAbsent(f.directory), false);
  assert.equal(gone(f.task.id).some(row => row.action === "archive_workspace"), false);
});

it("late timed-out results and cards reopened during an inventory read cannot append gone", async () => {
  const f = fixture();
  let resolve!: (ids: Set<string>) => void;
  await sweep(readOnlyOps({ listWorkspaceIds: () => new Promise(done => { resolve = done; }) }), 30);
  resolve(new Set());
  await new Promise(done => setTimeout(done, 10));
  assert.equal(gone(f.task.id).length, 0);
  await sweep(readOnlyOps({ listWorkspaceIds: async () => {
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(f.task.id);
    return new Set();
  } }));
  assert.equal(gone(f.task.id).length, 0);
});

it("bounded per-card target rotation eventually checks failures beyond the first batch", async () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) {
    const agentId = `batch-agent-${i}`;
    appendEvent(f.task.id, "agent_opened", null, null, "test", { agentId });
    appendEvent(f.task.id, "cleanup", null, null, "test", { action: "archive_agent", agentId, ok: false, retryAt: future });
  }
  let reads = 0;
  installCleanup(readOnlyOps({ listWorkspaceIds: async () => new Set([f.workspaceId]), inspectAgent: async id => {
    if (id.startsWith("batch-agent")) reads++;
    return id === "batch-agent-39" ? null : { archived: false, busy: true };
  } }));
  const start = new Date();
  enqueueCleanups(start); await flushCleanups();
  assert.ok(reads <= 32, `first batch read ${reads}`);
  assert.equal(gone(f.task.id).length, 0);
  enqueueCleanups(new Date(start.getTime() + DEFAULT_RECONCILE_INTERVAL_MS + 1)); await flushCleanups();
  assert.equal(gone(f.task.id).filter(row => row.agentId === "batch-agent-39").length, 1);
});
