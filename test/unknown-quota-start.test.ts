import { setLanguage } from "../shared/i18n";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveConfig, DEFAULT_CONCURRENCY } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask, type AgentLauncher } from "../server/dispatch";
import { createTask } from "../server/store";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";

const root = mkdtempSync(join(tmpdir(), "unknown-start-"));
Object.assign(process.env, { KANBAN_DATA_DIR: join(root, "data"), PASEO_HOME: join(root, "host"),
  KANBAN_PASEO_CONFIG: join(root, "host/config.json"), KANBAN_AGENTS_DIR: join(root, "agents"), KANBAN_TMP_ROOT: join(root, "tmp") });
for (const name of ["work", "agents", "host"]) mkdirSync(join(root, name), { recursive: true });
const profile: Profile = { id: "demo-reader", name: "Demo reader", role: "reader", provider: "grok", model: "grok-4.7", pool: "demo" };
const other: Profile = { ...profile, id: "demo-other", name: "Demo other" };
let creates = 0;
let sends = 0;
const launcher: AgentLauncher = { async create() { return { id: `demo-created-${++creates}` }; }, async send() { sends++; }, async listModels() { return { models: [{ id: "grok-4.7", thinkingOptions: [{ id: "low" }, { id: "high" }] }] }; } };
const snapshot = (state: "known" | "unknown"): PoolSnapshot => ({ state: "fresh", generatedAt: new Date().toISOString(), message: "Demo",
  dispatchable: () => true, entry: () => ({ state, usedPct: state === "known" ? 10 : null, dispatchable: true, deprioritize: false, prefer: false, resetsAt: null,
    reason: "Demo", onlyRoles: null, unknownQuota: { maxAgeMs: 7200000, maxConcurrent: 1, tiers: ["L1", "L2"] } }) });
beforeEach(() => {
  setLanguage("en");
  creates = 0; sends = 0;
  getDb().prepare("UPDATE tasks SET status = 'archived'").run();
  saveConfig({ autoStart: { demo: true }, supervisors: {}, supervisorAgentId: null, families: {}, bannedProviders: { providers: [], families: [], pools: [], models: [] },
    projects: { demo: { code: "DEMO", alwaysTemp: false, defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } },
    concurrency: { ...DEFAULT_CONCURRENCY, global: 10, pools: { demo: 10 } } });
});
after(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

for (const mode of ["tier", "occupied", "creating"] as const) {
  test(`preselected profiles cannot bypass unknown ${mode} limits at the create boundary`, async () => {
    if (mode !== "tier") {
      const active = createTask({ project: "demo", title: "Demo active", role: "reader", workspacePath: join(root, "work") });
      getDb().prepare("UPDATE tasks SET status = 'running', executor_profile = ? WHERE id = ?").run(mode === "creating" ? null : other.name, active.id);
      if (mode === "creating") getDb().prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'agent_creating', 'fixture', ?)")
        .run(active.id, new Date().toISOString(), JSON.stringify({ profile: other.name }));
    }
    const task = createTask({ project: "demo", title: "Demo new start", role: "reader", tier: mode === "tier" ? "L3" : "L1", workspacePath: join(root, "work") });
    await startTask(task.id, launcher, "fixture", { profiles: [profile, other], chosen: profile, snapshot: snapshot("unknown"), force: true }).catch(() => {});
    assert.equal(creates, 0);
  });
}

test("a known pool restores normal admission at the create boundary", async () => {
  const task = createTask({ project: "demo", title: "Demo recovered", role: "reader", tier: "L4", workspacePath: join(root, "work") });
  await startTask(task.id, launcher, "fixture", { profiles: [profile], chosen: profile, snapshot: snapshot("known"), force: true });
  assert.equal(creates, 1);
});

test("resuming a returned card cannot bypass the unknown tier restriction", async () => {
  const task = createTask({ project: "demo", title: "Demo resume", role: "reader", tier: "L4", workspacePath: join(root, "work") });
  await startTask(task.id, launcher, "fixture", { profiles: [profile], chosen: profile, snapshot: snapshot("known"), force: true });
  getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
  sends = 0;
  await startTask(task.id, launcher, "fixture", { profiles: [profile], snapshot: snapshot("unknown"), force: true }).catch(() => {});
  assert.equal(sends, 0);
  assert.equal(getDb().prepare("SELECT status FROM tasks WHERE id = ?").get(task.id)!.status, "rework");
});

test("preselected paid Cursor profiles cannot create a local agent", async () => {
  const paid = { ...profile, provider: "cursor", model: "gpt-demo" };
  const task = createTask({ project: "demo", title: "Demo paid start", role: "reader", tier: "L1", workspacePath: join(root, "work") });
  const result = await startTask(task.id, launcher, "fixture", { profiles: [paid], chosen: paid, snapshot: snapshot("known"), force: true });
  assert.match(result.message, /third-party.*paid/i);
  assert.equal(creates, 0);
});

test("resume rejects actual Cursor run evidence even after the profile is relabelled", async () => {
  const task = createTask({ project: "demo", title: "Demo returned paid run", role: "reader", tier: "L1", workspacePath: join(root, "work") });
  await startTask(task.id, launcher, "fixture", { profiles: [profile], chosen: profile, snapshot: snapshot("known"), force: true });
  getDb().prepare("UPDATE runs SET provider = 'cursor', model = 'gpt-demo' WHERE task_id = ?").run(task.id);
  getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
  sends = 0;
  const result = await startTask(task.id, launcher, "fixture", { profiles: [profile], snapshot: snapshot("known"), force: true });
  assert.match(result.message, /third-party.*paid/i);
  assert.equal(sends, 0);
});

test("unknown shared quota counts legacy channel aliases before admitting a new profile", async () => {
  const active = createTask({ project: "demo", title: "Demo occupied seat", role: "reader", workspacePath: join(root, "work") });
  const old = { ...other, pool: "cursor" };
  getDb().prepare("UPDATE tasks SET status = 'running', executor_profile = ? WHERE id = ?").run(old.name, active.id);
  const next = { ...profile, pool: "supergrok" };
  const task = createTask({ project: "demo", title: "Demo shared admission", role: "reader", tier: "L1", workspacePath: join(root, "work") });
  await startTask(task.id, launcher, "fixture", { profiles: [next, old], chosen: next, snapshot: snapshot("unknown"), force: true });
  assert.equal(creates, 0);
});
