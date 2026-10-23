import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { archiveSucceeded, cleanupIssues, readCleanupEvents } from "../server/archive-book";
import { drainCleanups, flushCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { runDoctor } from "../server/doctor";
import { appendEvent, createTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "archive-reconcile-"));
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
process.env.KANBAN_WORKTREES_ROOT = join(dir, "worktrees");
mkdirSync(process.env.KANBAN_AGENTS_DIR);
mkdirSync(process.env.KANBAN_WORKTREES_ROOT);
let serial = 0;
const now = new Date();
const old = new Date(now.getTime() - 4 * 3_600_000).toISOString();

beforeEach(async () => {
  installCleanup(null);
  await flushCleanups();
  closeDb();
  process.env.KANBAN_DATA_DIR = join(dir, `board-${++serial}`);
});
after(() => { installCleanup(null); closeDb(); rmSync(dir, { recursive: true, force: true }); });

function fixture(options: { pendingLand?: boolean; stopped?: boolean; outcome?: "timeout" | "error" } = {}) {
  const task = createTask({ project: "demo", title: "Archive timeout", role: "executor", workspacePath: dir });
  const agentId = `demo-agent-${serial}`;
  getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ? WHERE id = ?").run(agentId, task.id);
  appendEvent(task.id, "cleanup", null, null, "test", {
    action: "archive_agent", agentId, ok: false, outcome: options.outcome ?? "timeout", error: "timeout",
    retryAt: options.stopped ? new Date(now.getTime() + 86_400_000).toISOString() : old,
    ...(options.stopped ? { stopped: true } : {}),
  });
  if (options.pendingLand) {
    appendEvent(task.id, "temp_workspace", null, null, "test", {});
    appendEvent(task.id, "land_pending", null, null, "test", { reason: "Waiting for integration", branch: "kanban/demo", base: "main" });
  }
  return { task, agentId };
}

function ops(overrides: Partial<CleanupOps> = {}): CleanupOps {
  return {
    archiveAgent: async () => { assert.fail("an archived agent must not be archived again"); },
    archiveWorkspace: async () => { assert.fail("reconciliation must not archive a workspace"); },
    listAgents: async () => [], inspectWorkspace: async () => null,
    inspectAgent: async () => ({ archived: true, busy: false }),
    ...overrides,
  };
}

function reconciled(id: number, agentId: string) {
  const successes = readCleanupEvents(id).filter(row => row.action === "archive_agent" && row.agentId === agentId && row.ok);
  assert.equal(successes.length, 1);
  assert.equal(successes[0]?.via, "reconciled");
  assert.equal(cleanupIssues(id).failures.length, 0);
}

it("records archive success on retry when a timed out request actually archived the agent", async () => {
  const { task, agentId } = fixture();
  const before = await runDoctor({ now, sources: {}, persist: false, wake: false });
  assert.ok(before.findings.some(finding => finding.taskId === task.id && finding.object === "archive_agent" && finding.severity === "red"));
  installCleanup(ops());
  await drainCleanups(now);
  reconciled(task.id, agentId);
  const report = await runDoctor({ now, sources: {}, persist: false, wake: false });
  assert.ok(!report.findings.some(finding => finding.taskId === task.id && finding.object === "archive_agent" && finding.severity === "red"));
});

it("sends archive again only after confirming the timed out agent is still unarchived", async () => {
  const { task, agentId } = fixture();
  const calls: string[] = [];
  let archived = false;
  installCleanup(ops({
    inspectAgent: async () => { calls.push("inspect"); return { archived, busy: false }; },
    archiveAgent: async id => { assert.equal(id, agentId); calls.push("archive"); archived = true; },
  }));
  await drainCleanups(now);
  assert.ok(calls.indexOf("inspect") < calls.indexOf("archive"));
  assert.equal(calls.filter(call => call === "archive").length, 1);
  assert.ok(archiveSucceeded(readCleanupEvents(task.id), "archive_agent", agentId));
});

it("keeps failed or timed out status queries pending without sending archive", async () => {
  const { task, agentId } = fixture({ pendingLand: true });
  const before = readCleanupEvents(task.id);
  for (const inspectAgent of [
    async () => { throw new Error("connection lost"); },
    async (): Promise<never> => new Promise(() => {}),
  ]) {
    installCleanup(ops({ inspectAgent }), { timeoutMs: 20 });
    await drainCleanups(now);
    assert.deepEqual(readCleanupEvents(task.id), before);
    assert.ok(!archiveSucceeded(readCleanupEvents(task.id), "archive_agent", agentId));
  }
});

it("rebuilds reconciliation from persisted timeout rows after restart despite pending land and backoff", async () => {
  const { task, agentId } = fixture({ pendingLand: true, stopped: true });
  installCleanup(ops({ inspectAgent: async () => { throw new Error("offline"); } }));
  await drainCleanups(now);
  installCleanup(null);
  closeDb();
  installCleanup(ops());
  await drainCleanups(now);
  reconciled(task.id, agentId);
  const count = readCleanupEvents(task.id).length;
  installCleanup(null);
  installCleanup(ops());
  await drainCleanups(now);
  assert.equal(readCleanupEvents(task.id).length, count, "restart does not duplicate success");
});

it("also reconciles archive errors and preserves unrelated agent failures", async () => {
  const { task, agentId } = fixture({ pendingLand: true, outcome: "error" });
  appendEvent(task.id, "cleanup", null, null, "test", {
    action: "archive_agent", agentId: "demo-other", ok: false, outcome: "timeout", retryAt: old,
  });
  appendEvent(task.id, "release_agent", null, null, "test", { agentId: "demo-other" });
  installCleanup(ops({ inspectAgent: async id => {
    if (id === "demo-other") throw new Error("unknown agent state");
    return { archived: true, busy: false };
  } }));
  await drainCleanups(now);
  assert.ok(archiveSucceeded(readCleanupEvents(task.id), "archive_agent", agentId));
  assert.ok(!archiveSucceeded(readCleanupEvents(task.id), "archive_agent", "demo-other"));
});

it("can reconcile an agent stopped after three timeouts without resuming cleanup", async () => {
  const { task, agentId } = fixture({ pendingLand: true, stopped: true });
  for (let attempt = 0; attempt < 2; attempt++) appendEvent(task.id, "cleanup", null, null, "test", {
    action: "archive_agent", agentId, ok: false, outcome: "timeout", retryAt: old,
  });
  installCleanup(ops());
  await drainCleanups(now);
  reconciled(task.id, agentId);
});

it("an unavailable inspector leaves the persisted failure pending on startup", async () => {
  const { task } = fixture({ pendingLand: true });
  const before = readCleanupEvents(task.id);
  installCleanup(ops({ inspectAgent: undefined }));
  await drainCleanups(now);
  assert.deepEqual(readCleanupEvents(task.id), before);
});

it("a failed retry status read never sends a second archive request", async () => {
  const { task, agentId } = fixture();
  let archives = 0;
  installCleanup(ops({
    inspectAgent: async () => { throw new Error("status unavailable"); },
    archiveAgent: async () => { archives++; },
  }));
  await drainCleanups(now);
  assert.equal(archives, 0);
  assert.ok(!archiveSucceeded(readCleanupEvents(task.id), "archive_agent", agentId));
  assert.ok(cleanupIssues(task.id).failures.length > 0);
});

it("checks status even while the original timed out archive RPC is still inflight", async () => {
  const task = createTask({ project: "demo", title: "Late archive RPC", role: "executor", workspacePath: dir });
  const agentId = "demo-inflight";
  getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ? WHERE id = ?").run(agentId, task.id);
  let archived = false;
  let calls = 0;
  let resolveArchive!: () => void;
  installCleanup(ops({
    inspectAgent: async () => ({ archived, busy: false }),
    archiveAgent: async () => { calls++; await new Promise<void>(resolve => { resolveArchive = resolve; }); },
  }), { timeoutMs: 20 });
  try {
    await drainCleanups(now);
    const failure = readCleanupEvents(task.id).find(row => row.outcome === "timeout");
    assert.ok(failure?.retryAt);
    assert.equal(calls, 1);
    archived = true;
    await drainCleanups(new Date(Date.parse(failure.retryAt) + 1));
    reconciled(task.id, agentId);
    assert.equal(calls, 1);
  } finally {
    installCleanup(null);
    resolveArchive?.();
    await flushCleanups();
  }
});
