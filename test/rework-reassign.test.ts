/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { completeTask, requestChanges } from "../server/flow";
import type { AgentLiveness } from "../server/open";
import type { MatrixLoad } from "../server/matrix";
import { openEntry, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { resetReconcileForTests, type TickOptions } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { addComment, appendEvent, createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/alive";

const original: Profile = { id: "old", name: zhCN("labels.identity.executor"), role: "executor", family: "xai", provider: "alternate", pool: "alternate", model: "grok-4.7" };
const replacement: Profile = { id: "new", name: "Candidate executor", role: "candidate", candidateFor: "executor", family: "anthropic", provider: "claude", pool: "claude-max", model: "sonnet" };
const reviewer: Profile = { id: "review", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", pool: "claude-max", model: "sonnet" };
const crossReviewer: Profile = { id: "cross", name: "Cross-family review", role: "candidate", candidateFor: "reviewer", family: "xai", provider: "grok", pool: "supergrok", model: "grok-4.7" };
const roster = [original, replacement, reviewer, crossReviewer];
const start = new Date("2026-10-01T10:00:00.000Z");
const HOUR = 3_600_000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rework-"));
  process.env.KANBAN_DATA_DIR = dir;
  resetReconcileForTests();
  setAgentAliveCheck(() => true);
});

afterEach(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function pools(alternate: Partial<ReturnType<typeof openEntry>> = { dispatchable: false }): PoolSnapshot {
  return {
    state: "fresh", message: "", generatedAt: start.toISOString(),
    dispatchable: (pool) => pool !== "alternate" || alternate.dispatchable !== false,
    entry: (pool) => ({ ...openEntry(), ...(pool === "alternate" ? alternate : {}) }),
    hasPool: () => true,
  };
}

function fixture(hours?: number) {
  const cwd = join(dir, "original-worktree");
  mkdirSync(cwd);
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, "prior-work.txt"), "existing work");
  const task = createTask({ project: "reassign", title: "Continue rework", role: "executor", workspacePath: cwd, brief: "Fix existing function", profileOverride: original.name });
  getDb().prepare("UPDATE tasks SET status = 'rework', workspace_kind = 'worktree', agent_id = 'old-agent', executor_agent_id = 'old-agent', executor_profile = ?, executor_family = ?, review_round = 1 WHERE id = ?").run(original.name, original.family!, task.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, family, started_at, ended_at, end_kind) VALUES (?, 'old-agent', 'executor', ?, ?, ?, ?, ?, 'complete')").run(task.id, original.name, original.provider, original.family!, start.toISOString(), start.toISOString());
  appendEvent(task.id, "worktree_created", null, null, "test", { directory: cwd, workspaceId: "original-workspace", branch: "kanban/test", root: dir, base: "main", temp: true });
  appendEvent(task.id, "request_changes", "reviewing", "rework", "reviewer", { reason: "Fix boundary conditions", findings: "Add regression coverage" }, start.toISOString());
  addComment(task.id, "reviewer", "Fix boundary conditions\nAdd regression coverage");
  addComment(task.id, "executor", (zhCNPart("loginBlip.reopenLater", 6, 8) + zhCNPart("transientRetry.reviewPrompt", 24, 27) + zhCNPart("settings.thresholds.progressGraceMs", 0, 2) + zhCNPart("tools.emptyComment", 0, 4) + "Demo text"));
  const config: KanbanConfig = {
    autoStart: {}, supervisorAgentId: null, supervisors: {},
    concurrency: { global: 50, roles: { executor: 50, reviewer: 50 }, pools: { alternate: 50, "claude-max": 50, supergrok: 50 } },
    ...(hours !== undefined ? { reworkReassignHours: hours } : {}),
    archiveTimeoutMs: 10,
  };
  saveConfig(config);
  const actions: string[] = [];
  const opened: Parameters<TickOptions["launcher"]["create"]>[0][] = [];
  const states = new Map<string, AgentLiveness>();
  const launcher: TickOptions["launcher"] = {
    async create(options) { actions.push("create"); opened.push(options); return { id: options.labels?.role === "reviewer" ? "review-agent" : "new-agent" }; },
    async send(id) { actions.push(`send:${id}`); },
    async archiveAgent(id) { actions.push(`archive:${id}`); states.set(id, "archived"); },
    async createWorktree() { assert.fail("must reuse the original worktree"); },
  };
  const tick = (elapsed: number, snapshot = pools(), profiles = roster, matrix: MatrixLoad = { state: "missing" }) => runTick({
    now: new Date(start.getTime() + elapsed), profiles, launcher, config, pools: snapshot,
    matrix, agentState: (id) => states.get(id ?? "") ?? "alive",
  });
  return { task, cwd, config, actions, opened, states, launcher, tick };
}

function events(id: number, kind: string): Array<Record<string, unknown>> {
  return (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json));
}

describe("rework reassignment", () => {
  it("defaults to two hours and validates configured hours", () => {
    assert.equal(loadConfig().reworkReassignHours, 2);
    const path = join(dir, "kanban.config.json");
    for (const value of [0, -1, "3", null]) {
      writeFileSync(path, JSON.stringify({ reworkReassignHours: value }));
      assert.equal(loadConfig().reworkReassignHours, 2);
    }
    writeFileSync(path, JSON.stringify({ reworkReassignHours: 0.5 }));
    assert.equal(loadConfig().reworkReassignHours, 0.5);
  });

  it("reassigns after a paused pool exceeds the threshold, preserving cwd and recording the handoff", async () => {
    const f = fixture();
    await f.tick(0);
    assert.deepEqual(f.actions, []);
    const result = await f.tick(2 * HOUR + 1);
    assert.deepEqual(result.started, [f.task.id]);
    assert.deepEqual(f.actions, ["archive:old-agent", "create"]);
    assert.equal(f.opened[0]?.cwd, f.cwd);
    assert.equal(f.opened[0]?.workspaceId, "original-workspace");
    assert.equal(readFileSync(join(f.cwd, "prior-work.txt"), "utf8"), "existing work");
    assert.match(f.opened[0]?.prompt ?? "", new RegExp(zhCN("reworkReassign.takeoverNote")));
    assert.match(f.opened[0]?.prompt ?? "", new RegExp((zhCNPart("dispatch.prompt.lastReview", 3, 11) + "[\\s\\S]*Fix boundary conditions[\\s\\S]*Add regression coverage")));
    assert.equal((f.opened[0]?.prompt ?? "").includes(zhCNPart("workspace.freshCopy", 0, 8)), false);
    const reassigned = events(f.task.id, "rework_reassigned");
    assert.equal(reassigned.length, 1);
    assert.equal(reassigned[0]?.oldAgentId, "old-agent");
    assert.equal(reassigned[0]?.oldProfile, original.name);
    assert.equal(reassigned[0]?.newProfile, replacement.name);
    assert.match(String(reassigned[0]?.reason), new RegExp("alternate.*" + localePattern(zhCNPart("routing.poolClosed", 7, 10))));
    assert.equal(getTask(f.task.id).executor_family, replacement.family);
  });

  it("does nothing before or exactly at the threshold", async () => {
    const f = fixture();
    await f.tick(0);
    await f.tick(2 * HOUR - 1);
    await f.tick(2 * HOUR);
    assert.equal(getTask(f.task.id).status, "rework");
    assert.deepEqual(f.actions, []);
  });

  it("uses the configured threshold for onlyRoles holds", async () => {
    const f = fixture(0.5);
    const limited = pools({ dispatchable: true, onlyRoles: ["reviewer"] });
    await f.tick(0, limited);
    await f.tick(HOUR / 2 + 1, limited);
    assert.equal(getTask(f.task.id).executor_profile, replacement.name);
    assert.match(String(events(f.task.id, "rework_reassigned")[0]?.reason), new RegExp(localePattern(zhCNPart("pools.onlyFor", 7, 9)) + zhCN("labels.role.reviewer") + localePattern(zhCNPart("labels.assigner.user", 0, 1))));
  });

  it("reopens a missing agent immediately on its original profile if its pool is open", async () => {
    const f = fixture();
    f.states.set("old-agent", "missing");
    await f.tick(0, pools({ dispatchable: true }));
    assert.deepEqual(f.actions, ["create"]);
    assert.equal(getTask(f.task.id).executor_profile, original.name);
    await f.tick(2 * HOUR + 1, pools({ dispatchable: true }));
    assert.equal(getTask(f.task.id).executor_agent_id, "new-agent");
    assert.deepEqual(f.actions, ["create"]);
  });

  it("recovers the old executor from its run when rejection already cleared the agent columns", async () => {
    const f = fixture();
    getDb().prepare("UPDATE tasks SET agent_id = NULL, executor_agent_id = NULL WHERE id = ?").run(f.task.id);
    f.states.set("old-agent", "archived");
    await f.tick(0, pools({ dispatchable: true }));
    assert.deepEqual(f.actions, ["create"]);
    await f.tick(2 * HOUR + 1, pools({ dispatchable: true }));
    assert.equal(events(f.task.id, "rework_reopened")[0]?.oldAgentId, "old-agent");
    assert.equal(getTask(f.task.id).executor_profile, original.name);
  });

  it("resumes the original if its pool recovers before reassignment", async () => {
    const f = fixture();
    await f.tick(0);
    await f.tick(HOUR, pools({ dispatchable: true }));
    assert.deepEqual(f.actions, ["send:old-agent"]);
    assert.equal(events(f.task.id, "rework_reassigned").length, 0);
  });

  it("holds when no other pool is dispatchable without changing the original assignment", async () => {
    const f = fixture();
    await f.tick(0);
    const closed = pools();
    closed.entry = () => ({ ...openEntry(), dispatchable: false });
    await f.tick(2 * HOUR + 1, closed);
    assert.equal(getTask(f.task.id).status, "rework");
    assert.equal(getTask(f.task.id).executor_agent_id, "old-agent");
    assert.deepEqual(f.actions, []);
  });

  it("holds on failed archive, records retryable cleanup, and never resumes the retired agent", async (t) => {
    // Cleanup also records wall-clock times; keep them on the scheduler's timeline.
    t.mock.timers.enable({ apis: ["Date"], now: start.getTime() });
    const f = fixture();
    await f.tick(0);
    f.launcher.archiveAgent = async () => { throw new Error("archive unavailable"); };
    await f.tick(2 * HOUR + 1);
    assert.equal(getTask(f.task.id).status, "rework");
    assert.deepEqual(f.actions, []);
    assert.equal(events(f.task.id, "cleanup").find((row) => row.action === "archive_agent" && row.ok === false)?.agentId, "old-agent");
    assert.equal(events(f.task.id, "release_agent")[0]?.agentId, "old-agent");
    f.launcher.archiveAgent = async (id) => { f.actions.push(`archive:${id}`); };
    await f.tick(3 * HOUR, pools({ dispatchable: true }));
    assert.deepEqual(f.actions, ["archive:old-agent", "create"]);
    assert.equal(getTask(f.task.id).executor_agent_id, "new-agent");
  });

  it("reviews against the replacement family and sends subsequent rework to the replacement", async () => {
    const f = fixture();
    await f.tick(0);
    await f.tick(2 * HOUR + 1);
    completeTask(f.task.id, "executor", "Fix complete", null);
    await f.tick(2 * HOUR + 2, pools({ dispatchable: true }));
    assert.equal(f.opened[1]?.config.provider, `${crossReviewer.provider}/${crossReviewer.model}`);
    assert.equal(getTask(f.task.id).executor_family, replacement.family);
    getDb().prepare("UPDATE tasks SET review_round = 0 WHERE id = ?").run(f.task.id);
    requestChanges(f.task.id, "Add another case", "Detailed explanation");
    await f.tick(2 * HOUR + 3, pools({ dispatchable: true }));
    assert.equal(f.actions.at(-1), "send:new-agent");
    assert.equal(events(f.task.id, "rework_reassigned").length, 1);
  });

  it("inherits an existing quota hold without waiting another two hours", async () => {
    const f = fixture();
    const reason = zhCN("reworkReassign.poolClosed", {"pool":(zhCN("blocked.prefix.quota") + "alternate" + zhCNPart("boardView.blocked.dependency", 39, 41) + zhCNPart("reworkReassign.waitingAutoStart", 1, 7) + "alternate")});
    getDb().prepare("UPDATE tasks SET hold_reason = ? WHERE id = ?").run(reason, f.task.id);
    appendEvent(f.task.id, "held", "rework", "rework", "scheduler", { kind: "quota", reason }, start.toISOString());
    await f.tick(3 * HOUR);
    assert.equal(getTask(f.task.id).executor_agent_id, "new-agent");
    assert.equal(events(f.task.id, "rework_reassigned")[0]?.waitSince, start.toISOString());
  });

  it("strictly excludes every executor on the paused original pool for a quota takeover", async () => {
    const f = fixture();
    const samePool = { ...original, id: "same", name: "Candidate in same pool", role: "candidate", candidateFor: "executor" };
    await f.tick(0, pools(), [original, samePool, ...roster.slice(1)]);
    await f.tick(3 * HOUR, pools(), [original, samePool, ...roster.slice(1)]);
    assert.equal(getTask(f.task.id).executor_profile, replacement.name);
  });

  it("recovers the old pool from dispatch history when the original profile was removed", async () => {
    const f = fixture();
    appendEvent(f.task.id, "started", "ready", "running", "test", { agentId: "old-agent", quota: { pool: "alternate" } }, start.toISOString());
    const samePool = { ...original, id: "same", name: "Candidate in same pool", role: "candidate", candidateFor: "executor" };
    const profiles = [samePool, ...roster.slice(1)];
    await f.tick(0, pools({ dispatchable: true }), profiles);
    await f.tick(3 * HOUR, pools({ dispatchable: true }), profiles);
    assert.equal(getTask(f.task.id).executor_profile, replacement.name);
    assert.equal(events(f.task.id, "rework_reassigned")[0]?.oldPool, "alternate");
  });

  it("uses normal matrix routing and the replacement's depth", async () => {
    const f = fixture();
    const matrix: MatrixLoad = { state: "ok", path: "fixture", matrix: {
      version: 1, generatedAt: start.toISOString(), defaultTier: "L3", downgradeWhenTight: [], star: {},
      executor: { L3: [{ profile: original.name, effort: "xhigh", paused: false }, { profile: replacement.name, effort: "high", paused: false }] },
      reviewerFamilies: { anthropic: { L3: [{ profile: crossReviewer.name, effort: null, paused: false }] }, xai: { L3: [{ profile: reviewer.name, effort: null, paused: false }] } },
    } };
    f.launcher.listModels = async () => ({ models: [{ id: replacement.model!, thinkingOptions: [{ id: "high" }] }] });
    await f.tick(0, pools(), roster, matrix);
    await f.tick(3 * HOUR, pools(), roster, matrix);
    assert.equal(f.opened[0]?.config.thinkingOptionId, "high");
    assert.equal(getTask(f.task.id).executor_profile, replacement.name);
  });

  it("does not create a fresh worktree when the old creation event is missing", async () => {
    const f = fixture();
    getDb().prepare("UPDATE events SET kind = 'fixture_old_record' WHERE task_id = ? AND kind = 'worktree_created'").run(f.task.id);
    getDb().prepare("UPDATE tasks SET paseo_workspace_id = 'original-workspace' WHERE id = ?").run(f.task.id);
    await f.tick(0);
    await f.tick(3 * HOUR);
    assert.equal(f.opened[0]?.cwd, f.cwd);
    assert.equal(f.opened[0]?.workspaceId, "original-workspace");
  });

  it("never resumes the old agent after replacement creation fails", async () => {
    const f = fixture();
    await f.tick(0);
    const create = f.launcher.create;
    f.launcher.create = async () => { throw new Error("create unavailable"); };
    await f.tick(3 * HOUR);
    assert.equal(getTask(f.task.id).status, "rework");
    assert.deepEqual(f.actions, ["archive:old-agent"]);
    f.launcher.create = create;
    await f.tick(4 * HOUR, pools({ dispatchable: true }));
    assert.deepEqual(f.actions, ["archive:old-agent", "create"]);
    assert.equal(getTask(f.task.id).executor_agent_id, "new-agent");
  });

  it("holds on archive timeout and does not make a second archive call while the first is pending", async () => {
    const f = fixture();
    await f.tick(0);
    let calls = 0;
    let finish!: () => void;
    f.launcher.archiveAgent = async () => { calls += 1; await new Promise<void>((resolve) => { finish = resolve; }); };
    await f.tick(3 * HOUR);
    assert.equal(getTask(f.task.id).status, "rework");
    assert.equal(events(f.task.id, "cleanup").find((row) => row.ok === false)?.outcome, "timeout");
    await f.tick(4 * HOUR);
    assert.equal(calls, 1);
    assert.deepEqual(f.actions, []);
    finish();
    await Promise.resolve();
    f.states.set("old-agent", "archived");
    await f.tick(5 * HOUR);
    assert.deepEqual(f.actions, ["create"]);
  });

  it("resets the pool wait when the original pool recovers but concurrency still holds the card", async () => {
    const f = fixture();
    await f.tick(0);
    f.config.concurrency.global = 0;
    await f.tick(HOUR, pools({ dispatchable: true }));
    f.config.concurrency.global = 50;
    await f.tick(3 * HOUR);
    assert.deepEqual(f.actions, []);
    await f.tick(5 * HOUR + 1);
    assert.equal(getTask(f.task.id).executor_agent_id, "new-agent");
  });
});
