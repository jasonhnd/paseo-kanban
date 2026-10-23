import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask, type AgentLauncher } from "../server/dispatch";
import { currentOccupancy } from "../server/routing";
import { unknownPoolOccupancy } from "../server/unknown-quota";
import { resetReconcileForTests, runTick } from "../server/schedule";
import { createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";

const root = mkdtempSync(join(tmpdir(), "unknown-schedule-"));
Object.assign(process.env, { KANBAN_DATA_DIR: join(root, "data"), PASEO_HOME: join(root, "host"),
  KANBAN_PASEO_CONFIG: join(root, "host/config.json"), KANBAN_AGENTS_DIR: join(root, "agents"), KANBAN_TMP_ROOT: join(root, "tmp") });
for (const dir of ["work", "agents", "host"]) mkdirSync(join(root, dir), { recursive: true });
const profile: Profile = { id: "demo-reader", name: "Demo reader", role: "reader", provider: "grok", model: "grok-4.7", pool: "demo" };
const writer: Profile = { ...profile, id: "demo-executor", name: "Demo executor", role: "executor" };
const reviewer: Profile = { ...profile, id: "demo-reviewer", name: "Demo reviewer", role: "reviewer", pool: "normal" };
const normal: Profile = { ...profile, id: "demo-normal", name: "Demo normal", pool: "normal" };
const snapshot: PoolSnapshot = { state: "fresh", generatedAt: new Date().toISOString(), message: "Demo", dispatchable: () => true,
  entry: pool => ({ state: pool === "demo" ? "unknown" : "known", usedPct: pool === "demo" ? null : 10, dispatchable: true, deprioritize: false, prefer: false, resetsAt: null,
    reason: "Demo", onlyRoles: null, unknownQuota: { maxAgeMs: 7200000, maxConcurrent: 1, tiers: ["L1", "L2"] } }) };
let config: KanbanConfig;
let wakes: string[] = [];
beforeEach(() => {
  getDb().prepare("UPDATE tasks SET status = 'archived'").run(); resetReconcileForTests(); wakes = [];
  setWakeSender((_id, text) => { wakes.push(text); }); setAgentAliveCheck(() => true);
  config = { autoStart: { demo: true }, supervisors: { demo: "demo-leader" }, supervisorAgentId: null,
    families: {}, bannedProviders: { providers: [], families: [], pools: [], models: [] },
    projects: { demo: { code: "DEMO", alwaysTemp: false, defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } },
    concurrency: { global: 10, roles: { ...DEFAULT_CONCURRENCY.roles, reader: 10 }, pools: { demo: 10, normal: 10 } } };
  saveConfig(config);
});
after(() => { resetAgentAliveCheck(); closeDb(); rmSync(root, { recursive: true, force: true }); });
function card(title = "Demo queued") { return createTask({ project: "demo", title, role: "reader", tier: "L1", workspacePath: join(root, "work") }); }
function creating() {
  const task = card("Demo creating");
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
  getDb().prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'agent_creating', 'fixture', ?)")
    .run(task.id, new Date().toISOString(), JSON.stringify({ role: "reader", profile: profile.name }));
  return task;
}
function noFailure(id: number) {
  assert.deepEqual(getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'start_failed'").all(id), []);
  assert.equal(wakes.length, 0);
}

test("selection and the final guard count creating cards identically and exclude the current card", () => {
  const active = creating();
  assert.equal(currentOccupancy([profile]).byPool.demo, 1);
  assert.equal(unknownPoolOccupancy("demo", [profile], -1), 1);
  assert.equal(currentOccupancy([profile], active.id).byPool.demo ?? 0, 0);
  assert.equal(unknownPoolOccupancy("demo", [profile], active.id), 0);
});
for (const fallback of [false, true]) {
  test(`scheduler ${fallback ? "uses the next pool" : "queues quietly"} while an unknown pool has an agent_creating card`, async () => {
    creating(); const queued = card(); let creates = 0;
    const launcher: AgentLauncher = { async create() { creates++; return { id: "demo-scheduled" }; }, async send() {}, async listModels() { return { models: [{ id: "grok-4.7", thinkingOptions: [{ id: "low" }] }] }; } };
    const result = await runTick({ profiles: fallback ? [profile, normal] : [profile], launcher, config, pools: snapshot,
      matrix: { state: "missing" }, agentState: () => "alive" });
    assert.deepEqual(result.errors, []);
    assert.equal(creates, fallback ? 1 : 0);
    assert.equal(result.started.includes(queued.id), fallback);
    if (fallback) assert.equal(getTask(queued.id).executor_profile, normal.name);
    else { assert.equal(getTask(queued.id).status, "ready"); assert.ok(result.held.some(row => row.id === queued.id)); }
    noFailure(queued.id);
  });
}
test("a slot consumed after selection becomes a normal quota wait without a start failure", async () => {
  const queued = card(); let seeded = false; let creates = 0;
  const launcher: AgentLauncher = { async create() { creates++; return { id: "demo-late" }; }, async send() {}, async listModels() { return { models: [{ id: "grok-4.7", thinkingOptions: [{ id: "low" }] }] }; },
    async listWorkspaces() { if (!seeded) { seeded = true; creating(); } return [{ id: "demo-workspace", name: "Demo", directory: join(root, "work"), projectRoot: join(root, "work"), projectId: null, kind: "directory", archived: false }]; } };
  const result = await runTick({ profiles: [profile], launcher, config, pools: snapshot, matrix: { state: "missing" }, agentState: () => "alive" });
  assert.equal(seeded, true); assert.equal(creates, 0); assert.deepEqual(result.errors, []);
  assert.equal(getTask(queued.id).status, "ready");
  assert.ok(result.held.some(row => row.id === queued.id));
  noFailure(queued.id);
});

async function resumedWriter() {
  const task = createTask({ project: "demo", title: "Demo reviewed writer", role: "executor", tier: "L1", workspacePath: join(root, "work") });
  const run = getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, started_at) VALUES (?, ?, ?, ?, ?)");
  run.run(task.id, "demo-original", "executor", writer.name, "2025-01-01T00:00:00.000Z");
  getDb().prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'agent_creating', 'fixture', ?)")
    .run(task.id, "2025-01-01T00:00:01.000Z", JSON.stringify({ role: "reviewer", profile: reviewer.name }));
  run.run(task.id, "demo-review", "reviewer", reviewer.name, "2025-01-01T00:00:02.000Z");
  getDb().prepare("UPDATE tasks SET status = 'rework', agent_id = 'demo-review', executor_agent_id = 'demo-original', executor_profile = ? WHERE id = ?")
    .run(writer.name, task.id);
  const sent: string[] = [];
  await startTask(task.id, { async create() { throw new Error("Resume must reuse the executor"); }, async send(id) { sent.push(id); } }, "fixture",
    { profiles: [writer, reviewer], snapshot, force: true });
  assert.deepEqual(sent, ["demo-original"]);
  assert.equal(getTask(task.id).status, "running");
  return task;
}

for (const sameTimestamp of [false, true]) {
  test(`a resumed writer uses its latest run over ${sameTimestamp ? "an equal-time" : "an older"} review creation and keeps the workspace locked`, async () => {
    const task = await resumedWriter();
    if (sameTimestamp) getDb().prepare("UPDATE events SET at = (SELECT started_at FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1) WHERE task_id = ? AND kind = 'agent_creating'")
      .run(task.id, task.id);
    const occupancy = currentOccupancy([writer, reviewer]);
    assert.deepEqual(occupancy.byPool, { demo: 1 });
    assert.deepEqual(occupancy.byRole, { executor: 1 });
    assert.ok(occupancy.workspaces.has(join(root, "work")));
    assert.equal(unknownPoolOccupancy("demo", [writer, reviewer], -1), 1);
    assert.equal(unknownPoolOccupancy("demo", [writer, reviewer], task.id), 0);
  });
}

test("a resumed executor fills its unknown pool so another L1 queues without a start failure", async () => {
  await resumedWriter();
  const queued = card(); let creates = 0;
  const result = await runTick({ profiles: [profile, writer, reviewer],
    launcher: { async create() { creates++; return { id: "demo-extra" }; }, async send() {} },
    config, pools: snapshot, matrix: { state: "missing" }, agentState: () => "alive" });
  assert.deepEqual(result.errors, []);
  assert.equal(creates, 0);
  assert.equal(result.started.includes(queued.id), false);
  assert.equal(getTask(queued.id).status, "ready");
  assert.ok(result.held.some(row => row.id === queued.id));
  noFailure(queued.id);
});

test("a newer creation still owns occupancy and the writing workspace before its run exists", () => {
  const task = card("Demo next creation");
  getDb().prepare("UPDATE tasks SET status = 'running', executor_profile = ? WHERE id = ?").run(writer.name, task.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, profile_name, started_at) VALUES (?, 'demo-previous-review', 'reviewer', ?, ?)")
    .run(task.id, reviewer.name, "2025-01-01T00:00:00.000Z");
  getDb().prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'agent_creating', 'fixture', ?)")
    .run(task.id, "2025-01-01T00:00:01.000Z", JSON.stringify({ role: "executor", profile: writer.name }));
  const occupancy = currentOccupancy([writer, reviewer]);
  assert.deepEqual(occupancy.byPool, { demo: 1 });
  assert.deepEqual(occupancy.byRole, { executor: 1 });
  assert.ok(occupancy.workspaces.has(join(root, "work")));
  assert.equal(unknownPoolOccupancy("demo", [writer, reviewer], -1), 1);
});
