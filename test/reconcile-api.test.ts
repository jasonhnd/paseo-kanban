/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { inspectAgentState } from "../server/agent-check";
import { saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { reclaimTask } from "../server/failures";
import { agentLiveness, findAgentFile } from "../server/open";
import { launcherFrom } from "../server/paseo";
import { openEntry, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { MISSING_CONFIRM_MS, resetReconcileForTests } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getTask } from "../server/store";

const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", pool: "cursor", model: "grok-4.7" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", pool: "claude-max", model: "sonnet" },
];
const start = new Date("2026-10-01T08:45:00.000Z");
const pools: PoolSnapshot = { state: "fresh", message: "", generatedAt: start.toISOString(), dispatchable: () => true, entry: () => openEntry(), hasPool: () => true };
let dir: string;
let config: KanbanConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "test-0084-"));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  process.env.KANBAN_DISPATCH_MATRIX = join(dir, "missing-matrix.json");
  resetReconcileForTests();
  config = { autoStart: { live: false }, supervisors: {}, supervisorAgentId: null,
    concurrency: { global: 50, pools: { cursor: 50, "claude-max": 50 }, roles: { executor: 50, reviewer: 50 } }, archiveTimeoutMs: 15 };
  saveConfig(config);
});

afterEach(() => {
  closeDb();
  delete process.env.KANBAN_AGENTS_DIR;
  delete process.env.KANBAN_DISPATCH_MATRIX;
  rmSync(dir, { recursive: true, force: true });
});

function fixture(role = "executor") {
  const task = createTask({ project: "live", title: "Keep live executor", role, workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = 'old-agent', executor_agent_id = 'old-agent', executor_profile = ?, executor_family = ?, updated_at = ? WHERE id = ?")
    .run(role === "reviewer" ? "reviewing" : "running", profiles[0]!.name, profiles[0]!.family!, start.toISOString(), task.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, started_at) VALUES (?, 'old-agent', ?, ?, ?)")
    .run(task.id, role, profiles[0]!.name, start.toISOString());
  const actions: string[] = [];
  // The intersection lets these behavioral regressions run against the old implementation too.
  const launcher: AgentLauncher & { inspectAgent(id: string): Promise<{ archived: boolean } | null> } = {
    async inspectAgent() { return { archived: false }; },
    async archiveAgent(id) { actions.push(`archive:${id}`); },
    async create() { actions.push("create"); return { id: "new-agent" }; },
    async send() { actions.push("send"); },
  };
  const tick = (elapsed: number) => runTick({ now: new Date(start.getTime() + elapsed), config, pools,
    matrix: { state: "missing" }, profiles, launcher, agentState: (id) => id === "old-agent" ? "missing" : "alive" });
  return { task, actions, launcher, tick };
}

function events(id: number, kind: string): Array<Record<string, unknown>> {
  return (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ data_json: string }>).map((r) => JSON.parse(r.data_json));
}

describe("reconcile verifies missing files with Paseo", () => {
  it("keeps an unarchived agent while Paseo refresh temporarily persists a closed snapshot", async () => {
    const f = fixture();
    const folder = join(process.env.KANBAN_AGENTS_DIR!, "Users-example-.paseo-worktrees-demo-worktree-kanban-abc-0046-602");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "old-agent.json"), JSON.stringify({ id: "old-agent", cwd: dir, provider: "codex", lastStatus: "closed" }));
    assert.equal(agentLiveness("old-agent"), "closed");
    await runTick({ now: start, config, pools, matrix: { state: "missing" }, profiles, launcher: f.launcher });
    assert.equal(getTask(f.task.id).status, "running");
    assert.equal(getTask(f.task.id).agent_id, "old-agent");
    assert.equal(events(f.task.id, "reclaimed").length, 0);
    assert.equal(events(f.task.id, "liveness_mismatch")[0]?.fileState, "closed");
    writeFileSync(join(folder, "old-agent.json"), JSON.stringify({ id: "old-agent", cwd: dir, provider: "codex", lastStatus: "idle" }));
    await runTick({ now: new Date(start.getTime() + 1_000), config, pools, matrix: { state: "missing" }, profiles, launcher: f.launcher });
    assert.equal(getTask(f.task.id).status, "running");
    assert.deepEqual(f.actions, []);
  });

  for (const role of ["executor", "reviewer"]) {
    it(`keeps the ${role} when the API says it exists and clears the miss clock`, async () => {
      const f = fixture(role);
      let calls = 0;
      f.launcher.inspectAgent = async () => { calls++; return { archived: false }; };
      await f.tick(0);
      assert.equal(calls, 0);
      await f.tick(MISSING_CONFIRM_MS);
      assert.equal(getTask(f.task.id).status, role === "reviewer" ? "reviewing" : "running");
      assert.equal(getTask(f.task.id).agent_id, "old-agent");
      assert.equal(events(f.task.id, "reclaimed").length, 0);
      assert.equal(events(f.task.id, "liveness_mismatch")[0]?.agentId, "old-agent");
      f.launcher.inspectAgent = async () => { calls++; return null; };
      await f.tick(MISSING_CONFIRM_MS + 1);
      assert.equal(calls, 1);
      await f.tick(2 * MISSING_CONFIRM_MS + 1);
      assert.equal(getTask(f.task.id).status, role === "reviewer" ? "in_review" : "ready");
    });
  }

  for (const apiState of ["missing", "archived", "unavailable"]) {
    it(apiState === "archived"
      ? "keeps a confirmed-archived executor instead of reclaiming"
      : `reclaims after two file misses when the API is ${apiState}`, async () => {
      const f = fixture();
      f.launcher.inspectAgent = async () => {
        if (apiState === "unavailable") throw new Error("daemon disconnected");
        return apiState === "archived" ? { archived: true } : null;
      };
      await f.tick(0);
      assert.equal(getTask(f.task.id).status, "running");
      await f.tick(MISSING_CONFIRM_MS - 1);
      assert.equal(getTask(f.task.id).status, "running");
      await f.tick(MISSING_CONFIRM_MS);
      if (apiState === "archived") {
        assert.equal(getTask(f.task.id).status, "running");
        assert.equal(getTask(f.task.id).agent_id, "old-agent");
        assert.equal(events(f.task.id, "reclaimed").length, 0);
        assert.equal(events(f.task.id, "auto_complete").length, 0);
      } else {
        assert.equal(getTask(f.task.id).status, "ready");
        assert.equal(events(f.task.id, "reclaimed").length, 1);
      }
    });
  }

  it("does not reclaim a replacement assigned while the API query is pending", async () => {
    const f = fixture();
    await f.tick(0);
    f.launcher.inspectAgent = async () => {
      getDb().prepare("UPDATE tasks SET agent_id = 'replacement' WHERE id = ?").run(f.task.id);
      return null;
    };
    await f.tick(MISSING_CONFIRM_MS);
    assert.equal(getTask(f.task.id).status, "running");
    assert.equal(getTask(f.task.id).agent_id, "replacement");
  });

  it("bounds a hung API lookup and ignores its late result", async () => {
    let finish!: (value: { archived: boolean }) => void;
    const state = await inspectAgentState("old-agent", () => new Promise((resolve) => { finish = resolve; }), 10);
    assert.equal(state, "unknown");
    finish({ archived: false });
    assert.equal(state, "unknown");
    assert.equal(await inspectAgentState("old-agent", async () => ({ archived: false })), "alive");
  });

  for (const fileState of ["closed", "error", "archived"] as const) {
    it(`lets the API veto ${fileState}, but preserves immediate reclaim on API failure`, async () => {
      const f = fixture();
      const tick = () => runTick({ now: start, config, pools, matrix: { state: "missing" }, profiles,
        launcher: f.launcher, agentState: () => fileState });
      await tick();
      assert.equal(getTask(f.task.id).status, "running");
      f.launcher.inspectAgent = async () => { throw new Error("offline"); };
      await tick();
      assert.equal(getTask(f.task.id).status, "ready");
      assert.equal(events(f.task.id, "reclaimed")[0]?.fileState, fileState);
      assert.equal(events(f.task.id, "reclaimed")[0]?.apiState, "unknown");
    });
  }
});

describe("replacement retires a reclaimed agent", () => {
  it("archives a still-live old executor before starting its replacement", async () => {
    const f = fixture();
    reclaimTask(f.task.id, start);
    const result = await startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[0] });
    assert.equal(result.agentId, "new-agent");
    assert.deepEqual(f.actions, ["archive:old-agent", "create"]);
  });

  it("waits on failed archive, keeps retry bookkeeping, and never opens a duplicate", async () => {
    const f = fixture();
    reclaimTask(f.task.id, start);
    f.launcher.archiveAgent = async () => { f.actions.push("archive-failed"); throw new Error("offline"); };
    await assert.rejects(startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[0] }), new RegExp(zhCN("labels.status.archived")));
    assert.equal(getTask(f.task.id).status, "ready");
    assert.deepEqual(f.actions, ["archive-failed"]);
    assert.equal(events(f.task.id, "cleanup")[0]?.ok, false);
    f.launcher.archiveAgent = async () => { f.actions.push("archive-retry"); };
    await assert.rejects(startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[0] }), new RegExp(zhCN("labels.status.archived")));
    assert.deepEqual(f.actions, ["archive-failed"]);
    getDb().prepare("UPDATE events SET data_json = json_set(data_json, '$.retryAt', '2000-01-01T00:00:00Z') WHERE task_id = ? AND kind = 'cleanup'").run(f.task.id);
    await startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[0] });
    assert.deepEqual(f.actions, ["archive-failed", "archive-retry", "create"]);
  });

  it("archives conservatively before replacement when the API cannot be reached", async () => {
    const f = fixture();
    reclaimTask(f.task.id, start);
    f.launcher.inspectAgent = async () => { throw new Error("offline"); };
    await startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[0] });
    assert.deepEqual(f.actions, ["archive:old-agent", "create"]);
  });

  it("can reclaim and retire in the same tick when the agent reappears in the API", async () => {
    const f = fixture();
    let calls = 0;
    f.launcher.inspectAgent = async () => ++calls === 1 ? null : { archived: false };
    config.autoStart.live = true;
    saveConfig(config);
    await f.tick(0);
    const result = await f.tick(MISSING_CONFIRM_MS);
    assert.deepEqual(result.started, [f.task.id]);
    assert.deepEqual(f.actions, ["archive:old-agent", "create"]);
  });

  it("does not repeat a timed-out archive or create while that archive is pending", async () => {
    const f = fixture();
    reclaimTask(f.task.id, start);
    let finish!: () => void;
    let archived = false;
    f.launcher.inspectAgent = async () => ({ archived });
    f.launcher.archiveAgent = async () => {
      f.actions.push("archive-pending");
      await new Promise<void>((resolve) => { finish = resolve; });
      archived = true;
    };
    try {
      await assert.rejects(startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[0] }), new RegExp(zhCN("labels.status.archived")));
      await assert.rejects(startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[0] }), new RegExp(zhCN("labels.status.archived")));
      assert.deepEqual(f.actions, ["archive-pending"]);
      assert.equal(events(f.task.id, "cleanup")[0]?.outcome, "timeout");
    } finally {
      finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[0] });
    assert.deepEqual(f.actions, ["archive-pending", "create"]);
  });

  it("retires a reclaimed reviewer without archiving the executor's completed run", async () => {
    const f = fixture("reviewer");
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, started_at, ended_at, end_kind) VALUES (?, 'writer', 'executor', ?, ?, ?, 'complete')")
      .run(f.task.id, profiles[0]!.name, start.toISOString(), start.toISOString());
    reclaimTask(f.task.id, new Date(start.getTime() + 10 * MISSING_CONFIRM_MS));
    await startTask(f.task.id, f.launcher, "test", { profiles, chosen: profiles[1] });
    assert.deepEqual(f.actions, ["archive:old-agent", "create"]);
  });
});

describe("agent records and live API adapter", () => {
  it("reads Codex records from ABC_0046's encoded worktree directory without using the cwd as a key", () => {
    const id = "00000000-0000-4000-8000-000000000005";
    const folder = join(process.env.KANBAN_AGENTS_DIR!, "Users-example-.paseo-worktrees-demo-worktree-kanban-abc-0046-602");
    mkdirSync(folder, { recursive: true });
    const cwd = "/Users/example/.paseo/worktrees/demo-worktree/kanban-abc-0046-602";
    writeFileSync(join(folder, `${id}.json`), JSON.stringify({ id, cwd, provider: "codex", lastStatus: "idle", config: { model: "gpt-6.1-sol" } }));
    assert.equal(agentLiveness(id), "alive");
    assert.equal(findAgentFile(id)?.cwd, cwd);
  });

  it("uses refreshed API state and distinguishes Agent not found from connection failures", async () => {
    let state = "live";
    const paseo = { agents: { ref: () => ({
      async refresh() {
        if (state === "missing") throw new Error("Agent not found: old-agent");
        if (state === "offline") throw new Error("connection timeout");
        return { agent: { status: state === "closed" ? "closed" : "idle", archivedAt: state === "archived" ? start.toISOString() : null } };
      },
      current: () => null,
    }) } } as unknown as PaseoApi;
    const launcher = launcherFrom(paseo) as AgentLauncher & { inspectAgent(id: string): Promise<{ archived: boolean } | null> };
    assert.deepEqual(await launcher.inspectAgent("old-agent"), { archived: false });
    state = "closed";
    assert.deepEqual(await launcher.inspectAgent("old-agent"), { archived: false });
    state = "archived";
    assert.deepEqual(await launcher.inspectAgent("old-agent"), { archived: true });
    state = "missing";
    assert.equal(await launcher.inspectAgent("old-agent"), null);
    state = "offline";
    await assert.rejects(launcher.inspectAgent("old-agent"), /connection timeout/);
  });
});
