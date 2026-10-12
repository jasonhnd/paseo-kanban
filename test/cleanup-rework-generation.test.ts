/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { cleanupFinished, readCleanupEvents, readCleanupEventsBatch, cardErrorBlocks } from "../server/archive-book";
import { invalidateAgentIndex } from "../server/agent-index";
import { setWakeSender } from "../server/bus";
import { runKanban } from "../server/cli";
import { drainCleanups, installCleanup, dueCardIds, enqueueCleanups, flushCleanups, type CleanupOps } from "../server/cleanup";
import { DEFAULT_CONCURRENCY, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { AgentLauncher } from "../server/dispatch";
import { resetMissingCwdForTests, setMissingCwdHooks } from "../server/missing-cwd";
import type { ListedWorkspace } from "../server/placement";
import { acquireStartClaim, releaseStartClaim } from "../server/start-claim";
import { appendEvent, createTask, getTask } from "../server/store";
import { cleanupGeneration } from "../server/cleanup-state";
import { round, takePerfSummary } from "../server/perf";
import { acceptTask } from "../server/flow";
import { issueToken } from "../server/tokens";
import { listTempWorkspaces } from "../server/temp-workspace";
import { tempCleaned } from "../server/temp-mark";
import { readWorktreeCreated } from "../server/worktree-record";
import { recreateWorkspace } from "../server/workspace-recreate";
import { clearDoctorSafetyCache, parseWorktreePorcelain, runDoctor } from "../server/doctor";
import { doctorSettings } from "../server/config";
import { performAudit } from "../server/audit";
import { boardSnapshot } from "../server/store";

// Every ID and repo is synthetic. No provider or daemon is constructed.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-generations-")));
const trees = join(dir, "worktrees");
const agents = join(dir, "agents");
mkdirSync(trees); mkdirSync(agents); mkdirSync(join(agents, "bucket"));
process.env.KANBAN_DATA_DIR = join(dir, "data");
process.env.KANBAN_WORKTREES_ROOT = trees;
process.env.KANBAN_AGENTS_DIR = agents;
setWakeSender(() => {});
saveConfig({ autoStart: {}, supervisors: {}, supervisorAgentId: null, concurrency: DEFAULT_CONCURRENCY });
setMissingCwdHooks({ deleteAgent: async id => { rmSync(join(agents, "bucket", `${id}.json`), { force: true }); } });
after(() => { installCleanup(null); resetMissingCwdForTests(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function rows(id: number, kind: string) {
  return getDb().prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ id: number; data_json: string }>;
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(dir, "repo-")));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a"), "base\n"); git(root, "add", "a"); git(root, "commit", "-qm", "base");
  const task = createTask({ project: "demo", title: "anonymous rebuild", role: "batch", workspacePath: root });
  const branch = `kanban/${task.id}-anonymous`;
  let n = 0;
  const workspaces = new Map<string, ListedWorkspace>();
  const archived: string[] = [];
  const purgedAgents: string[] = [];
  let createError = false;
  const launcher: AgentLauncher = {
    create: async () => { throw new Error("no provider permitted"); }, send: async () => {},
    listWorkspaces: async () => [{ id: `main-${task.id}`, name: "main", directory: root, projectRoot: root, projectId: null, kind: "local_checkout", archived: false }, ...workspaces.values()],
    archiveWorkspace: async id => { workspaces.get(id)!.archived = true; },
    createWorktree: async options => {
      if (createError) throw new Error("synthetic create failed");
      const directory = join(trees, `demo-${task.id}-r${++n}`);
      git(root, "worktree", "add", "-q", "-b", options.branchName, directory, options.baseBranch);
      const workspaceId = `workspace-${task.id}-${n}`;
      workspaces.set(workspaceId, { id: workspaceId, directory, name: "copy", projectRoot: root, projectId: null, kind: "worktree", archived: false });
      return { directory, workspaceId };
    },
  };
  const initial = await launcher.createWorktree!({ cwd: root, branchName: branch, baseBranch: "main" });
  appendEvent(task.id, "worktree_created", null, null, "synthetic", { ...initial, root, branch, base: "main", temp: true });
  appendEvent(task.id, "temp_workspace", null, null, "synthetic", { ...initial, root, base: "main" });
  function bind(directory: string, workspaceId: string, status = "running") {
    const agentId = `worker-${task.id}-${n}`;
    getDb().prepare("UPDATE tasks SET status = ?, workspace_kind = 'worktree', workspace_base = 'main', workspace_path = ?, paseo_workspace_id = ?, agent_id = ?, executor_agent_id = ? WHERE id = ?").run(status, directory, workspaceId, agentId, agentId, task.id);
    writeFileSync(join(agents, "bucket", `${agentId}.json`), JSON.stringify({ id: agentId, cwd: directory, provider: "synthetic", lastActivityAt: "2026-01-01T00:00:00.000Z", labels: { kanban: "1", kanban_task: String(task.id) } }));
    appendEvent(task.id, "agent_opened", null, null, "synthetic", { agentId }); invalidateAgentIndex();
  }
  bind(initial.directory, initial.workspaceId!);
  const ops: CleanupOps = {
    archiveAgent: async id => { purgedAgents.push(id); rmSync(join(agents, "bucket", `${id}.json`), { force: true }); invalidateAgentIndex(); },
    archiveWorkspace: async id => { archived.push(id); workspaces.get(id)!.archived = true; },
    inspectWorkspace: async id => workspaces.get(id) ?? null,
    listWorkspaceIds: async () => new Set(workspaces.keys()),
    listAgents: async () => [],
    inspectAgent: async id => existsSync(join(agents, "bucket", `${id}.json`)) ? { archived: false, busy: false } : null,
  };
  function finish(status = "done") {
    getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
    appendEvent(task.id, "synthetic_finish", "acceptance", status, "synthetic", {});
  }
  async function sweep(restart = false) {
    if (restart) { installCleanup(null); closeDb(); }
    installCleanup(ops, { keepSweepClock: !restart, timeoutMs: 2000 });
    await drainCleanups();
  }
  async function recreate() {
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
    const token = acquireStartClaim(task.id);
    assert.ok(token, "cleanup must have released the physical resource fence");
    try {
      const placement = await recreateWorkspace({ task: getTask(task.id), launcher, claimToken: token, actor: "synthetic", reason: "anonymous rework" });
      bind(placement.cwd, placement.workspaceId!);
      return readWorktreeCreated(task.id)!;
    } finally { releaseStartClaim(task.id, token); }
  }
  return { id: task.id, root, branch, initial, ops, launcher, archived, purgedAgents, finish, sweep, recreate, failCreate: (value = true) => { createError = value; } };
}

async function diagnose(f: Awaited<ReturnType<typeof fixture>>, now = new Date(Date.now() + 4 * 3_600_000)) {
  clearDoctorSafetyCache();
  return runDoctor({ now, settings: doctorSettings(null), wake: false, persist: false, sources: {
    agents: { agents: [] }, workspaces: [],
    git: { repos: [f.root], worktrees: async root => parseWorktreePorcelain(git(root, "worktree", "list", "--porcelain")),
      branches: async root => git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/kanban/").split("\n").filter(Boolean),
      dirty: async path => Boolean(git(path, "status", "--porcelain")), pushed: async () => "unknown", pr: async () => "unknown" },
  } });
}

it("doctor diagnoses current rebuilt failure despite historical finished and late old success", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true);
  const history = rows(f.id, "cleanup_finished");
  await f.recreate(); f.finish();
  installCleanup({ ...f.ops, archiveWorkspace: async () => { throw new Error("synthetic current archive failure"); } });
  await drainCleanups();
  appendEvent(f.id, "cleanup", null, null, "synthetic", { action: "archive_workspace", workspaceId: getTask(f.id).paseo_workspace_id, ok: true, cleanupGeneration: 0 });
  const report = await diagnose(f);
  assert.ok(report.findings.some(row => row.taskId === f.id && row.id.startsWith("card:cleanup:") && row.object === "archive_workspace" && row.severity === "red"), "historical finished must not hide the current archive failure");
  const audit = await performAudit({ listActiveAgents: async () => [], inspectWorkspace: f.ops.inspectWorkspace! });
  assert.ok(audit.cards.find(row => row.id === f.id)?.failures.some(line => line.includes("synthetic current archive failure")));
  assert.ok(boardSnapshot("demo").tasks.find(row => row.id === f.id)?.tempNote, "board must still show the new temporary target as pending");
  assert.deepEqual(rows(f.id, "cleanup_finished"), history);
});

it("doctor never uses an old keptBranch mark to soften a new leftover branch", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true);
  appendEvent(f.id, "temp_workspace_cleaned", null, null, "synthetic", { keptBranch: true });
  const copy = await f.recreate(); f.finish();
  // A current closed cleanup with a leftover branch, plus a later reply from the old generation.
  appendEvent(f.id, "cleanup_finished", null, null, "synthetic", { cleanupGeneration: cleanupGeneration(f.id) });
  appendEvent(f.id, "temp_workspace_cleaned", null, null, "synthetic", { keptBranch: true, cleanupGeneration: 0 });
  assert.equal(git(f.root, "show-ref", "--verify", `refs/heads/${copy.branch}`).includes(copy.branch!), true);
  const finding = (await diagnose(f)).findings.find(row => row.check === "branch" && row.taskId === f.id);
  assert.equal(finding?.severity, "yellow", "old keptBranch must not label a current residual branch as intentionally kept");
});

it("doctor still reports an actually retained current branch as info and preserves pending/unknown safety", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true);
  const copy = await f.recreate();
  writeFileSync(join(copy.directory!, "unlanded"), "private synthetic change\n");
  git(copy.directory!, "add", "unlanded"); git(copy.directory!, "commit", "-qm", "unlanded synthetic change");
  f.finish("archived"); await f.sweep(true); // Existing archived-card policy keeps unlanded local work.
  assert.equal(existsSync(copy.directory!), false);
  assert.equal(JSON.parse(rows(f.id, "temp_workspace_cleaned").at(-1)!.data_json).keptBranch, true);
  appendEvent(f.id, "temp_workspace_cleaned", null, null, "synthetic", { keptBranch: false, cleanupGeneration: 0 });
  assert.equal((await diagnose(f)).findings.find(row => row.check === "branch" && row.taskId === f.id)?.severity, "info");
  const pending = await fixture(); pending.finish(); await pending.sweep(true);
  const target = await pending.recreate(); pending.finish();
  const recent = await diagnose(pending, new Date());
  assert.equal(recent.findings.some(row => row.taskId === pending.id && row.id.startsWith("card:cleanup:")), false);
  assert.equal(recent.findings.some(row => row.taskId === pending.id && row.id.startsWith("git:worktree:")), false, "new terminal target retains its cleanup grace despite old closed marks");
  assert.equal(existsSync(target.directory!), true);
});

function cliChild(id: number, identity: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["bin/paseo-kanban.mjs", "resume-cleanup", String(id), "--json"], { cwd: process.cwd(), env: { ...process.env, ...identity }, encoding: "utf8" });
}

function tickChild(id: number, now?: Date, unknown: boolean | "agents" = false) {
  const result = execFileSync(process.execPath, ["--import", "tsx", "--import", "./test/helpers/i18n-preload.ts", "test/helpers/cleanup-resume-worker.ts", String(id), now?.toISOString() ?? "", String(unknown)], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  return JSON.parse(result.trim().split("\n").at(-1)!) as { finished: boolean; archived: string[] };
}

it("independent bin CLI persists one request; a fresh normal tick confirms then cleans real Git resources", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true);
  const history = rows(f.id, "cleanup_finished");
  const copy = await f.recreate();
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(f.id);
  installCleanup(null); await acceptTask(f.id, "synthetic");
  const first = cliChild(f.id);
  assert.equal(first.status, 0, first.stderr);
  const requests = rows(f.id, "cleanup_resume_requested");
  assert.equal(requests.length, 1, "CLI exit must leave a persistent request even without installed ops");
  const output = JSON.parse(first.stdout) as { requested: boolean; execution: string };
  assert.equal(output.requested, true, "independent CLI must report a durable request, not memory enqueue");
  assert.equal(output.execution, "periodic");
  assert.equal(JSON.parse(requests[0]!.data_json).cleanupGeneration, cleanupGeneration(f.id));
  assert.equal(rows(f.id, "cleanup_resume_acknowledged").length, 0);
  assert.equal(existsSync(copy.directory!), true, "request alone does not execute cleanup");
  for (let i = 0; i < 3; i++) assert.equal(cliChild(f.id).status, 0);
  assert.deepEqual(rows(f.id, "cleanup_resume_requested"), requests, "duplicate requests are bounded and survive CLI exit");
  const tick = tickChild(f.id);
  assert.equal(tick.finished, true);
  assert.deepEqual(tick.archived, [copy.workspaceId]);
  assert.equal(existsSync(copy.directory!), false);
  assert.equal(git(f.root, "for-each-ref", "--format=%(refname)", `refs/heads/${copy.branch}`), "");
  assert.equal(rows(f.id, "cleanup_resume_acknowledged").length, 1);
  assert.deepEqual(rows(f.id, "cleanup_finished").slice(0, 1), history);
  assert.deepEqual(tickChild(f.id).archived, [], "restart cannot physically archive the target again");
  assert.equal(rows(f.id, "cleanup_finished").length, 2);
  for (const action of ["drop_directory", "delete_branch"]) assert.equal(readCleanupEvents(f.id).filter(row => row.action === action && row.ok === true).length, 1);
});

it("normal ticks acknowledge at most 100 obsolete requests and restart never duplicates acknowledgements", async () => {
  installCleanup(null);
  const ids: number[] = [];
  for (let i = 0; i < 105; i++) {
    const card = createTask({ project: "request-cap", title: "anonymous stale request", role: "reader" });
    ids.push(card.id);
    appendEvent(card.id, "cleanup_resume_requested", null, null, "synthetic", { cleanupGeneration: 0, workspaceId: null, directory: null, branch: null, execution: "periodic" });
  }
  const count = () => ids.reduce((n, id) => n + rows(id, "cleanup_resume_acknowledged").length, 0);
  const ops: CleanupOps = { archiveAgent: async () => { throw new Error("no archive in request-cap probe"); },
    archiveWorkspace: async () => { throw new Error("no archive in request-cap probe"); }, listAgents: async () => [],
    inspectWorkspace: async () => { throw new Error("unknown inventory in request-cap probe"); } };
  // Requests are now on active cards. Observation cannot schedule destructive work.
  installCleanup(ops); await drainCleanups(); assert.equal(count(), 100);
  await drainCleanups(); assert.equal(count(), 105);
  installCleanup(null); closeDb(); installCleanup(ops); await drainCleanups(); assert.equal(count(), 105);
});

it("actual independent CLI identity refuses foreign leaders, workers and guests before recording a request", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true); const copy = await f.recreate(); f.finish(); installCleanup(null);
  saveConfig({ ...loadTestConfig(), supervisors: { demo: "leader-demo", other: "leader-other" } });
  const worker = issueToken("executor", f.id, "synthetic-token-worker");
  for (const identity of [{ PASEO_AGENT_ID: "leader-other" }, { KANBAN_TOKEN: worker }, { PASEO_AGENT_ID: "guest-anonymous" }, { KANBAN_TOKEN: "invalid-synthetic-token" }]) {
    const refused = cliChild(f.id, identity);
    assert.equal(refused.status, 1);
    assert.equal(rows(f.id, "cleanup_resume_requested").length, 0);
    assert.equal(existsSync(copy.directory!), true);
  }
  assert.equal(cliChild(f.id, { PASEO_AGENT_ID: "leader-demo" }).status, 0);
  assert.equal(rows(f.id, "cleanup_resume_requested").length, 1);
  saveConfig({ ...loadTestConfig(), supervisors: {} });
});

function loadTestConfig() { return { autoStart: {}, supervisors: {}, supervisorAgentId: null, concurrency: DEFAULT_CONCURRENCY }; }

it("a durable request leaves old stops and current backoff intact until a legally due tick", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true);
  appendEvent(f.id, "cleanup", null, null, "synthetic", { action: "error", ok: false, stopped: true, attempts: 12, retryAt: "2099-01-01T00:00:00.000Z", error: "old stopped row" });
  const oldRows = rows(f.id, "cleanup");
  const copy = await f.recreate(); f.finish();
  installCleanup({ ...f.ops, archiveWorkspace: async () => { throw new Error("synthetic retryable failure"); } });
  await drainCleanups(); installCleanup(null);
  const failure = readCleanupEvents(f.id).find(row => row.action === "archive_workspace" && !row.ok)!;
  const failures = rows(f.id, "cleanup");
  assert.equal(cliChild(f.id).status, 0);
  assert.deepEqual(rows(f.id, "cleanup"), failures, "CLI request cannot clear backoff or old stops");
  const early = tickChild(f.id, new Date(Date.parse(failure.retryAt!) - 1000));
  assert.equal(early.finished, false); assert.deepEqual(early.archived, []);
  assert.equal(rows(f.id, "cleanup_resume_acknowledged").length, 0);
  assert.equal(existsSync(copy.directory!), true);
  const later = tickChild(f.id, new Date(Date.parse(failure.retryAt!) + 1000));
  assert.equal(later.finished, true); assert.deepEqual(later.archived, [copy.workspaceId]);
  assert.deepEqual(rows(f.id, "cleanup").filter(row => oldRows.some(old => old.id === row.id)), oldRows);
});

it("confirmation of a periodic candidate is separate from unknown reads and actual cleanup", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true); const copy = await f.recreate(); f.finish(); installCleanup(null);
  assert.equal(cliChild(f.id).status, 0);
  const unknown = tickChild(f.id, undefined, true);
  assert.equal(unknown.finished, false); assert.deepEqual(unknown.archived, []);
  assert.equal(existsSync(copy.directory!), true);
  assert.equal(JSON.parse(rows(f.id, "cleanup_resume_acknowledged")[0]!.data_json).outcome, "periodic_candidate");
  assert.equal(rows(f.id, "cleanup_finished").length, 1, "acknowledgement is not completion");
  assert.equal(tickChild(f.id, new Date(Date.now() + 10 * 60_000)).finished, true);
  assert.equal(rows(f.id, "cleanup_resume_acknowledged").length, 1);
});

it("a request cannot collect a target after rework, a new generation, shared ownership or unreadable inventory", async () => {
  for (const change of ["rework", "generation", "shared", "unknown"] as const) {
    const f = await fixture(); f.finish(); await f.sweep(true); let copy = await f.recreate(); f.finish(); installCleanup(null);
    assert.equal(cliChild(f.id).status, 0);
    const request = rows(f.id, "cleanup_resume_requested")[0]!;
    const generation = cleanupGeneration(f.id);
    if (change === "rework") getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(f.id);
    if (change === "generation") {
      git(f.root, "worktree", "remove", "--force", copy.directory!);
      git(f.root, "branch", "-D", copy.branch!);
      copy = await f.recreate(); // Actual rebuild creates the new boundary and binds an active copy.
      assert.ok(cleanupGeneration(f.id) > generation);
    }
    if (change === "shared") {
      const borrower = createTask({ project: "demo", title: "new active borrower", role: "reader", workspacePath: copy.directory });
      getDb().prepare("UPDATE tasks SET paseo_workspace_id = ?, workspace_kind = 'worktree' WHERE id = ?").run(copy.workspaceId!, borrower.id);
    }
    const tick = tickChild(f.id, undefined, change === "unknown" ? "agents" : false);
    assert.equal(tick.finished, false, change); assert.deepEqual(tick.archived, [], change);
    assert.equal(existsSync(copy.directory!), true, change);
    if (change === "rework" || change === "generation") {
      const ack = JSON.parse(rows(f.id, "cleanup_resume_acknowledged")[0]!.data_json);
      assert.equal(ack.requestId, request.id); assert.equal(ack.outcome, "obsolete");
    } else assert.equal(rows(f.id, "cleanup_resume_acknowledged").length, 0);
    assert.deepEqual(rows(f.id, "cleanup_resume_requested"), [request]);
    if (change !== "shared") { f.finish(); await f.sweep(true); }
  }
});

it("ordinary sweep retires second and third rebuilt targets, preserving first history across restart", async () => {
  const f = await fixture();
  f.finish(); await f.sweep(true);
  assert.equal(existsSync(f.initial.directory), false);
  assert.equal(cleanupFinished(f.id), true);
  const history = rows(f.id, "cleanup_finished");
  for (const status of ["done", "archived"]) {
    const copy = await f.recreate();
    assert.equal(existsSync(copy.directory!), true);
    const agent = getTask(f.id).agent_id!;
    f.finish(status); await f.sweep(true);
    assert.equal(existsSync(copy.directory!), false, "a historical cleanup_finished must not hide the new copy");
    assert.equal(f.archived.filter(id => id === copy.workspaceId).length, 1);
    assert.equal(existsSync(join(agents, "bucket", `${agent}.json`)), false);
    assert.equal(readCleanupEvents(f.id).filter(e => e.action === "purge_agents" && e.agentId === agent && e.ok).length, 1);
    assert.equal(readCleanupEvents(f.id).filter(e => e.action === "delete_branch" && e.branch === copy.branch && e.ok).length, 1);
    assert.equal(readCleanupEvents(f.id).filter(e => e.action === "drop_directory" && e.directory === copy.directory && e.ok).length, 1);
    assert.equal(git(f.root, "for-each-ref", "--format=%(refname)", `refs/heads/${f.branch}`), "");
    await f.sweep();
  }
  assert.equal(rows(f.id, "cleanup_finished").length, 3);
  assert.deepEqual(rows(f.id, "cleanup_finished").slice(0, 1), history);
});

it("actual resume-cleanup handler accepts a rebuilt terminal target with no stopped rows", async () => {
  const f = await fixture();
  f.finish(); await f.sweep(true);
  const copy = await f.recreate(); f.finish();
  assert.equal(rows(f.id, "cleanup").some(row => JSON.parse(row.data_json).stopped), false);
  const result = await runKanban(["resume-cleanup", String(f.id)], {}) as { resumed: number };
  assert.ok(result.resumed > 0, "the handler must requeue the evidenced rebuilt generation");
  await f.sweep(true);
  assert.equal(existsSync(copy.directory!), false);
  assert.equal(tempCleaned(f.id), true);
  const second = await runKanban(["resume-cleanup", String(f.id)], {}) as { resumed: number };
  assert.equal(second.resumed, 0, "a fully retired target remains an idempotent no-op");
});

function deferred() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

it("failed rebuild and a rework request without new resources leave the old cleanup state intact", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true);
  const history = rows(f.id, "cleanup_finished");
  const boundary = cleanupGeneration(f.id);
  f.failCreate();
  await assert.rejects(f.recreate(), (error: unknown) => (error as { code?: string }).code === "workspace_recreate_failed" && String(error).includes("synthetic create failed"));
  assert.equal(cleanupGeneration(f.id), boundary);
  assert.equal(cleanupFinished(f.id), true);
  assert.equal(tempCleaned(f.id), true);
  assert.deepEqual(rows(f.id, "cleanup_finished"), history);
  f.finish(); await f.sweep(true);
  assert.deepEqual(rows(f.id, "cleanup_finished"), history);
  f.failCreate(false); const copy = await f.recreate();
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(f.id);
  await acceptTask(f.id, "synthetic"); await f.sweep(true);
  assert.equal(getTask(f.id).status, "done");
  assert.equal(existsSync(copy.directory!), false);
});

it("active cards, shared targets, unknown ownership and unauthorized handler calls cannot force recovery", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true); const copy = await f.recreate();
  const before = f.archived.length;
  for (const status of ["rework", "running", "acceptance"]) {
    getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, f.id);
    assert.equal((await runKanban(["resume-cleanup", String(f.id)], {}) as { resumed: number }).resumed, 0);
    await f.sweep(true);
    assert.equal(existsSync(copy.directory!), true);
    assert.equal(f.archived.length, before);
  }
  f.finish();
  const sharer = createTask({ project: "demo", title: "active borrower", role: "reader", workspacePath: copy.directory });
  getDb().prepare("UPDATE tasks SET status = 'running', paseo_workspace_id = ? WHERE id = ?").run(copy.workspaceId!, sharer.id);
  assert.equal((await runKanban(["resume-cleanup", String(f.id)], {}) as { resumed: number }).resumed, 0);
  await f.sweep(true);
  assert.equal(existsSync(copy.directory!), true);
  assert.equal(cleanupFinished(f.id), false);
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(sharer.id);
  const token = issueToken("executor", f.id, "anonymous-worker");
  await assert.rejects(runKanban(["resume-cleanup", String(f.id)], { KANBAN_TOKEN: token }), /leader/);
  const foreignLeader = "11111111-2222-4333-8444-555555555555";
  saveConfig({ autoStart: {}, supervisorAgentId: null, supervisors: { other: foreignLeader }, concurrency: DEFAULT_CONCURRENCY });
  await assert.rejects(runKanban(["resume-cleanup", String(f.id)], { PASEO_AGENT_ID: foreignLeader }), /demo/);
  const failed = rows(f.id, "cleanup");
  getDb().prepare("UPDATE tasks SET paseo_workspace_id = 'unknown-target' WHERE id = ?").run(f.id);
  assert.equal((await runKanban(["resume-cleanup", String(f.id)], {}) as { resumed: number }).resumed, 0);
  assert.deepEqual(rows(f.id, "cleanup"), failed);
  getDb().prepare("UPDATE tasks SET paseo_workspace_id = ? WHERE id = ?").run(copy.workspaceId!, f.id);
  await f.sweep(true); assert.equal(existsSync(copy.directory!), false);
});

it("old stops, backoff, generic successes and late rows never cover a rebuilt generation", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true);
  appendEvent(f.id, "cleanup", null, null, "synthetic", { action: "error", ok: false, stopped: true, attempts: 12, retryAt: "2099-01-01T00:00:00.000Z" });
  const old = rows(f.id, "cleanup"); const boundary = cleanupGeneration(f.id);
  const copy = await f.recreate(); f.finish();
  // Same-target stale responses are tagged with the launching generation, even when inserted later.
  for (const action of ["purge_agents", "drop_directory", "wip_commit", "delete_branch"]) {
    appendEvent(f.id, "cleanup", null, null, "synthetic", { action, directory: copy.directory, branch: copy.branch, ok: true, cleanupGeneration: boundary });
  }
  appendEvent(f.id, "cleanup_finished", null, null, "synthetic", { cleanupGeneration: boundary });
  appendEvent(f.id, "temp_workspace_cleaned", null, null, "synthetic", { cleanupGeneration: boundary });
  assert.equal(cleanupFinished(f.id), false); assert.equal(tempCleaned(f.id), false);
  assert.equal(cardErrorBlocks(readCleanupEvents(f.id), new Date()), false);
  assert.ok(dueCardIds().includes(f.id));
  assert.ok(listTempWorkspaces().some(row => row.id === f.id));
  await f.sweep(true);
  assert.equal(existsSync(copy.directory!), false);
  assert.deepEqual(rows(f.id, "cleanup").slice(0, old.length), old);
});

it("a timed-out old physical archive fences rebuilding, then its late success cannot finish rework", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true); const second = await f.recreate(); f.finish();
  const gate = deferred(); const entered = deferred();
  const archive = f.ops.archiveWorkspace;
  f.ops.archiveWorkspace = async id => {
    entered.open(); await gate.promise;
    // Simulate Paseo retiring the old copy; use only this fixture's real Git tree.
    git(f.root, "worktree", "remove", second.directory!);
    await archive(id);
  };
  installCleanup(f.ops, { timeoutMs: 30, keepSweepClock: false });
  enqueueCleanups(); await entered.promise; await flushCleanups();
  assert.equal(readCleanupEvents(f.id).some(e => e.action === "archive_workspace" && !e.ok), true);
  getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(f.id);
  assert.equal(acquireStartClaim(f.id), null, "no rebuild can free/reuse this branch before the real call settles");
  const archivedBefore = f.archived.length;
  gate.open(); await new Promise(resolve => setImmediate(resolve)); await flushCleanups();
  assert.equal(f.archived.length, archivedBefore + 1);
  assert.equal(cleanupFinished(f.id), false, "late old success must not close an active rework");
  assert.equal(tempCleaned(f.id), false);
  f.ops.archiveWorkspace = archive;
  const third = await f.recreate();
  const thirdBoundary = cleanupGeneration(f.id);
  assert.ok(thirdBoundary > 0);
  assert.equal(readCleanupEvents(f.id).some(e => e.workspaceId === second.workspaceId), false);
  f.finish(); await f.sweep(true);
  assert.equal(existsSync(third.directory!), false);
  assert.equal(f.archived.filter(id => id === third.workspaceId).length, 1);
  assert.equal(rows(f.id, "cleanup_finished").filter(row => JSON.parse(row.data_json).cleanupGeneration === thirdBoundary).length, 1);
});

it("already-gone rebuilt resources converge read-only without rewriting the original stopped failure", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true); const copy = await f.recreate(); f.finish();
  git(f.root, "worktree", "remove", copy.directory!);
  f.ops.inspectWorkspace = async () => null;
  f.ops.listWorkspaceIds = async () => new Set();
  appendEvent(f.id, "cleanup", null, null, "synthetic", { action: "archive_workspace", workspaceId: copy.workspaceId, ok: false, stopped: true, attempts: 12, retryAt: "2099-01-01T00:00:00.000Z", error: "old failure" });
  const failed = rows(f.id, "cleanup").at(-1)!;
  await f.sweep(true); await f.sweep();
  assert.equal(tempCleaned(f.id), true);
  assert.deepEqual(rows(f.id, "cleanup").find(row => row.id === failed.id), failed);
  assert.ok(readCleanupEvents(f.id).some(row => row.failureRowId === failed.id && row.reconciled && row.ok));
  assert.equal(f.archived.includes(copy.workspaceId!), false, "confirmed absence uses no destructive RPC");
});

it("unknown/failed inspections retain the new directory and current unrelated card errors", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true); const copy = await f.recreate(); f.finish();
  f.ops.inspectWorkspace = async () => { throw new Error("synthetic unknown inventory"); };
  f.ops.listWorkspaceIds = async () => { throw new Error("synthetic inventory failure"); };
  await f.sweep(true);
  assert.equal(existsSync(copy.directory!), true); assert.equal(cleanupFinished(f.id), false);
  assert.ok(readCleanupEvents(f.id).some(e => e.action === "archive_workspace" && e.ok === false));
  appendEvent(f.id, "cleanup", null, null, "synthetic", { action: "error", ok: false, stopped: true, attempts: 12, retryAt: "2099-01-01T00:00:00.000Z", error: "unrelated current error" });
  const error = rows(f.id, "cleanup").at(-1)!;
  await f.sweep(true);
  assert.deepEqual(rows(f.id, "cleanup").find(row => row.id === error.id), error);
  assert.equal(cardErrorBlocks(readCleanupEvents(f.id), new Date()), true);
  assert.equal(existsSync(copy.directory!), true);
});

it("batched cleanup reads normalize mixed historical generations in three statements per 400-card chunk", () => {
  const ids: number[] = [];
  for (let n = 0; n < 401; n++) {
    const task = createTask({ project: "query-demo", title: "synthetic generation query", role: "batch", workspacePath: dir });
    ids.push(task.id);
    appendEvent(task.id, "cleanup", null, null, "synthetic", { action: "drop_directory", ok: true, directory: "old" });
    appendEvent(task.id, "cleanup_finished", null, null, "synthetic", {});
    appendEvent(task.id, "temp_workspace_recreated", null, null, "synthetic", { directory: join(trees, `query-${task.id}`) });
    appendEvent(task.id, "cleanup", null, null, "synthetic", { action: "drop_directory", ok: false, directory: "new" });
  }
  takePerfSummary();
  const batch = round("generation-query", () => readCleanupEventsBatch(ids));
  const sql = Object.values(takePerfSummary()!.loops).reduce((n, loop) => n + loop.io.sql, 0);
  assert.equal(sql, 6, "no per-card queries were introduced in the batch reader");
  for (const id of ids) { assert.equal(batch.get(id)!.length, 1); assert.equal(batch.get(id)![0]!.directory, "new"); }
});

it("cleanup and recreation keep one writer while the physical create is suspended", async () => {
  const f = await fixture(); f.finish(); await f.sweep(true);
  const gate = deferred(); const entered = deferred();
  const create = f.launcher.createWorktree!;
  let creates = 0;
  f.launcher.createWorktree = async options => { creates++; entered.open(); await gate.promise; return create(options); };
  const rebuilding = f.recreate(); await entered.promise;
  assert.equal(acquireStartClaim(f.id), null);
  await f.sweep(true);
  assert.equal(creates, 1);
  assert.equal(rows(f.id, "cleanup_finished").length, 1);
  gate.open(); const copy = await rebuilding;
  await f.sweep(true); assert.equal(existsSync(copy.directory!), true);
  assert.equal(cleanupFinished(f.id), false);
  f.finish(); await f.sweep(true);
  assert.equal(existsSync(copy.directory!), false);
  assert.equal(f.archived.filter(id => id === copy.workspaceId).length, 1);
});
