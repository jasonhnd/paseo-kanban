/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { invalidateAgentIndex } from "../server/agent-index";
import { saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import type { Profile } from "../server/profiles";
import { resetReconcileForTests } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { appendEvent, createTask, getTask } from "../server/store";
import { issueToken } from "../server/tokens";

const dir = mkdtempSync(join(tmpdir(), "lost-create-"));
const agents = join(dir, "agents");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agents;
process.env.KANBAN_CREATE_RECOVER_MS = "30";
mkdirSync(agents, { recursive: true });

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  pool: "alternate",
};

function shutAuto(): void {
  const config: KanbanConfig = { autoStart: {}, supervisorAgentId: null, supervisors: {}, concurrency: { global: 4, pools: { alternate: 4 }, roles: { executor: 4, reviewer: 4 } } };
  saveConfig(config);
}

function writeAgent(id: string, taskId: number, cwd: string, patch: Record<string, unknown> = {}): void {
  const folder = join(agents, id.slice(0, 2));
  mkdirSync(folder, { recursive: true });
  const { labels, ...rest } = patch;
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({
    id,
    cwd,
    workspaceId: "wks-lost",
    labels: { kanban: "1", kanban_task: String(taskId), role: "executor", ...(labels as Record<string, string> | undefined) },
    lastStatus: "idle",
    archivedAt: null,
    createdAt: new Date().toISOString(),
    provider: "claude",
    ...rest,
  }));
  invalidateAgentIndex();
}

function eventCount(taskId: number, kind: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number }).n;
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("lost agents.create response", () => {
  it("binds the agent record before a late create response", async () => {
    shutAuto();
    const cwd = join(dir, "hang");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-hang", title: "Creation hung", role: "executor", workspacePath: cwd });
    writeAgent("lostagent01", task.id, cwd);
    const launcher: AgentLauncher = {
      async create() {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { id: "lostagent01" };
      },
      async send() {},
    };
    const result = await startTask(task.id, launcher, "supervisor", { profiles: [executor], chosen: executor, reason: "Test" });
    assert.equal(result.agentId, "lostagent01");
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).agent_id, "lostagent01");
    assert.equal(getTask(task.id).executor_agent_id, "lostagent01");
    const opened = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'agent_opened'").get(task.id) as { data_json: string };
    assert.equal(JSON.parse(opened.data_json).recovered, "lost_create_response");
    const bound = getDb().prepare("SELECT agent_id FROM tokens WHERE task_id = ?").all(task.id) as Array<{ agent_id: string }>;
    assert.deepEqual(bound.map((row) => row.agent_id), ["lostagent01"]);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND agent_id = ?").get(task.id, "lostagent01") as { n: number }).n, 1);
  });

  it("binds the record when create rejects after the daemon already wrote it", async () => {
    shutAuto();
    const cwd = join(dir, "reject");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-reject", title: "Creation disconnected", role: "executor", workspacePath: cwd });
    writeAgent("lostagent02", task.id, cwd);
    const launcher: AgentLauncher = {
      async create() {
        throw new Error("socket closed");
      },
      async send() {},
    };
    const result = await startTask(task.id, launcher, "supervisor", { profiles: [executor], chosen: executor, reason: "Test" });
    assert.equal(result.agentId, "lostagent02");
    assert.equal(getTask(task.id).status, "running");
  });

  it("binds when the record shows up shortly after create rejects", async () => {
    shutAuto();
    const cwd = join(dir, "late-file");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-late", title: "Late record", role: "executor", workspacePath: cwd });
    const launcher: AgentLauncher = {
      async create() {
        setTimeout(() => writeAgent("lostagent07", task.id, cwd), 300);
        throw new Error("socket closed");
      },
      async send() {},
    };
    const result = await startTask(task.id, launcher, "supervisor", { profiles: [executor], chosen: executor, reason: "Test" });
    assert.equal(result.agentId, "lostagent07");
    assert.equal(getTask(task.id).agent_id, "lostagent07");
  });

  it("still reverts when create fails and no record exists", async () => {
    shutAuto();
    const cwd = join(dir, "none");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-none", title: "not recorded", role: "executor", workspacePath: cwd });
    const launcher: AgentLauncher = {
      async create() {
        throw new Error("socket closed");
      },
      async send() {},
    };
    await assert.rejects(
      () => startTask(task.id, launcher, "supervisor", { profiles: [executor], chosen: executor, reason: "Test" }),
      /socket closed/,
    );
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).agent_id, null);
    assert.equal(eventCount(task.id, "agent_opened"), 0);
  });

  it("adopts one live record after the start grace instead of reclaiming", async () => {
    resetReconcileForTests();
    shutAuto();
    const cwd = join(dir, "grace");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-grace", title: "Rebind after grace", role: "executor", workspacePath: cwd });
    const now = new Date("2026-10-07T15:27:02.000Z");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = NULL, updated_at = ? WHERE id = ?").run(now.toISOString(), task.id);
    writeAgent("lostagent03", task.id, cwd);
    issueToken("executor", task.id, null);
    const config = { autoStart: { "lost-grace": false }, supervisorAgentId: null, supervisors: {}, concurrency: { global: 4, pools: { alternate: 4 }, roles: { executor: 4 } } } as KanbanConfig;
    saveConfig(config);
    await runTick({ profiles: [executor], launcher: { async create() { return { id: "should-not" }; }, async send() {} }, now, config, agentState: () => "missing" });
    assert.equal(getTask(task.id).agent_id, null);
    assert.equal(eventCount(task.id, "reclaimed"), 0);
    const later = new Date(now.getTime() + 3 * 60 * 1000);
    await runTick({ profiles: [executor], launcher: { async create() { return { id: "should-not" }; }, async send() {} }, now: later, config, agentState: () => "missing" });
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).agent_id, "lostagent03");
    assert.equal(eventCount(task.id, "reclaimed"), 0);
    assert.equal(eventCount(task.id, "agent_opened"), 1);
    const token = getDb().prepare("SELECT agent_id FROM tokens WHERE task_id = ?").get(task.id) as { agent_id: string };
    assert.equal(token.agent_id, "lostagent03");
  });

  it("reclaims a null agent id when no live record matches", async () => {
    resetReconcileForTests();
    shutAuto();
    const cwd = join(dir, "gone");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-gone", title: "Truly absent", role: "executor", workspacePath: cwd });
    const now = new Date("2026-10-07T15:00:00.000Z");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = NULL, updated_at = ? WHERE id = ?").run(now.toISOString(), task.id);
    writeAgent("lostagent04", task.id, join(dir, "elsewhere"));
    const config = { autoStart: {}, supervisorAgentId: null, supervisors: {}, concurrency: { global: 4, pools: {}, roles: {} } } as KanbanConfig;
    saveConfig(config);
    const later = new Date(now.getTime() + 3 * 60 * 1000);
    await runTick({ profiles: [executor], launcher: { async create() { return { id: "nope" }; }, async send() {} }, now: later, config, agentState: () => "missing" });
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(eventCount(task.id, "reclaimed"), 1);
  });

  it("does not reclaim when two live records match the card", async () => {
    resetReconcileForTests();
    shutAuto();
    const cwd = join(dir, "two");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-two", title: "Two records", role: "executor", workspacePath: cwd });
    const now = new Date("2026-10-07T15:10:00.000Z");
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = NULL, updated_at = ? WHERE id = ?").run(now.toISOString(), task.id);
    writeAgent("lostagent05", task.id, cwd);
    writeAgent("lostagent06", task.id, cwd, { createdAt: "2026-10-07T15:27:03.000Z" });
    const config = { autoStart: {}, supervisorAgentId: null, supervisors: {}, concurrency: { global: 4, pools: {}, roles: {} } } as KanbanConfig;
    saveConfig(config);
    const later = new Date(now.getTime() + 3 * 60 * 1000);
    const launcher = { async create() { return { id: "nope" }; }, async send() {} };
    await runTick({ profiles: [executor], launcher, now: later, config, agentState: () => "missing" });
    await runTick({ profiles: [executor], launcher, now: new Date(later.getTime() + 1000), config, agentState: () => "missing" });
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).agent_id, null);
    assert.equal(eventCount(task.id, "reclaimed"), 0);
    assert.equal(eventCount(task.id, "agent_recover_ambiguous"), 1);
  });

  it("records the chosen profile before create", async () => {
    shutAuto();
    const cwd = join(dir, "creating");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-creating", title: "Record profile first", role: "executor", workspacePath: cwd });
    const launcher: AgentLauncher = {
      async create() {
        const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'agent_creating'").get(task.id) as { data_json: string } | undefined;
        assert.ok(row, "agent_creating must exist before create returns");
        const data = JSON.parse(row.data_json);
        assert.equal(data.profile, zhCN("labels.role.executor"));
        assert.equal(data.family, "xai");
        assert.equal(data.role, "executor");
        return { id: "creating01" };
      },
      async send() {},
    };
    const result = await startTask(task.id, launcher, "supervisor", { profiles: [executor], chosen: executor, reason: "Test" });
    assert.equal(result.agentId, "creating01");
  });

  it("does not bind an older live agent when this create really fails", async () => {
    shutAuto();
    const cwd = join(dir, "stale");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-stale", title: "Sample text agent Sample text", role: "executor", workspacePath: cwd });
    writeAgent("staleagent1", task.id, cwd, { createdAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    const launcher: AgentLauncher = {
      async create() {
        throw new Error("socket closed");
      },
      async send() {},
    };
    await assert.rejects(
      () => startTask(task.id, launcher, "supervisor", { profiles: [executor], chosen: executor, reason: "Test" }),
      /socket closed/,
    );
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).agent_id, null);
    assert.equal(eventCount(task.id, "agent_opened"), 0);
  });

  it("adopts with the profile and family recorded before create", async () => {
    resetReconcileForTests();
    shutAuto();
    const cwd = join(dir, "profiled");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-profiled", title: "Backfill profile", role: "executor", workspacePath: cwd });
    const now = new Date();
    const claimedAt = new Date(now.getTime() - 3 * 60 * 1000);
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = NULL, updated_at = ? WHERE id = ?").run(claimedAt.toISOString(), task.id);
    appendEvent(task.id, "agent_creating", null, null, "scheduler", {
      role: "executor", profile: zhCN("labels.role.executor"), family: "xai", provider: "alternate", model: "grok-4.7", autoAccept: 1, effort: "high",
    }, claimedAt.toISOString());
    writeAgent("profiled01", task.id, cwd, { createdAt: new Date(claimedAt.getTime() + 2_000).toISOString() });
    const config = { autoStart: {}, supervisorAgentId: null, supervisors: {}, concurrency: { global: 4, pools: {}, roles: {} } } as KanbanConfig;
    saveConfig(config);
    await runTick({ profiles: [executor], launcher: { async create() { return { id: "nope" }; }, async send() {} }, now, config, agentState: () => "missing" });
    const after = getTask(task.id);
    assert.equal(after.agent_id, "profiled01");
    assert.equal(after.executor_profile, zhCN("labels.role.executor"));
    assert.equal(after.executor_family, "xai");
    const run = getDb().prepare("SELECT profile_name, family, auto_accept, effort FROM runs WHERE task_id = ? AND agent_id = ?").get(task.id, "profiled01") as {
      profile_name: string | null; family: string | null; auto_accept: number; effort: string | null;
    };
    assert.deepEqual({ ...run }, { profile_name: zhCN("labels.role.executor"), family: "xai", auto_accept: 1, effort: "high" });
  });

  it("reclaims instead of adopting an agent created before this claim", async () => {
    resetReconcileForTests();
    shutAuto();
    const cwd = join(dir, "older");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-older", title: "Old record does not count", role: "executor", workspacePath: cwd });
    const now = new Date();
    const claimedAt = new Date(now.getTime() - 3 * 60 * 1000);
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = NULL, updated_at = ? WHERE id = ?").run(claimedAt.toISOString(), task.id);
    appendEvent(task.id, "agent_creating", null, null, "scheduler", { role: "executor", profile: zhCN("labels.role.executor"), family: "xai" }, claimedAt.toISOString());
    writeAgent("olderagent1", task.id, cwd, { createdAt: new Date(claimedAt.getTime() - 60_000).toISOString() });
    const config = { autoStart: {}, supervisorAgentId: null, supervisors: {}, concurrency: { global: 4, pools: {}, roles: {} } } as KanbanConfig;
    saveConfig(config);
    await runTick({ profiles: [executor], launcher: { async create() { return { id: "nope" }; }, async send() {} }, now, config, agentState: () => "missing" });
    assert.equal(getTask(task.id).agent_id, null);
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(eventCount(task.id, "reclaimed"), 1);
  });

  it("blocks the review instead of dispatching it when the executor family is unknown", async () => {
    resetReconcileForTests();
    const cwd = join(dir, "nofamily");
    mkdirSync(cwd, { recursive: true });
    const task = createTask({ project: "lost-nofamily", title: "Executor family empty", role: "executor", workspacePath: cwd });
    getDb().prepare("UPDATE tasks SET status = 'in_review', executor_profile = NULL, executor_family = NULL, executor_agent_id = 'gone01' WHERE id = ?").run(task.id);
    const sameFamily: Profile = { id: "rv", name: "Reviewer · Same family", role: "reviewer", family: "xai", provider: "grok", model: "grok-4.7", pool: "alternate" };
    const config = { autoStart: { "lost-nofamily": true }, supervisorAgentId: null, supervisors: {}, concurrency: { global: 4, pools: { alternate: 4 }, roles: { executor: 4, reviewer: 4 } } } as KanbanConfig;
    saveConfig(config);
    let created = 0;
    const launcher: AgentLauncher = { async create() { created += 1; return { id: "review-should-not" }; }, async send() {} };
    await runTick({ profiles: [executor, sameFamily], launcher, now: new Date(), config, agentState: () => "alive" });
    assert.equal(created, 0);
    const after = getTask(task.id);
    assert.equal(after.status, "blocked");
    assert.equal(after.blocked_kind, "needs_human");
    assert.match(after.blocked_reason ?? "", new RegExp(localePattern(zhCNPart("routing.execFamilyUnknown", 0, 6))));
  });
});
