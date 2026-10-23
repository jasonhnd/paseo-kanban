// Real default scheduler/CLI admission: no compatibility readers are injected here.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import { policyDigest, policySnapshotPath, publishPolicySnapshot, readPersistedPolicy } from "../server/application/policy-snapshot";
import { runKanban } from "../server/cli";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { DispatchMatrix, PoolStatus, envelopeFor } from "../server/contract";
import { closeDb, getDb } from "../server/db";
import type { AgentLauncher } from "../server/dispatch";
import { loadDispatchMatrix } from "../server/matrix";
import { readPoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { resetReconcileForTests, runTick } from "../server/schedule";
import { createTask, getTask } from "../server/store";
import { setLanguage } from "../shared/i18n";

const root = mkdtempSync(join(tmpdir(), "immutable-admission-"));
const saved = { ...process.env };
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.PASEO_HOME = join(root, "host");
process.env.KANBAN_PASEO_CONFIG = join(root, "host", "config.json");
process.env.KANBAN_POOL_STATUS = join(root, "legacy-pools.json");
process.env.KANBAN_DISPATCH_MATRIX = join(root, "legacy-matrix.json");
process.env.KANBAN_TMP_ROOT = join(root, "tmp");
for (const name of ["AFC_DATA_DIR", "ROLES_STATE_DIR", "AFC_LEGACY_DATA_DIR"]) delete process.env[name];
for (const name of ["host", "data/fleet", "work"]) mkdirSync(join(root, name), { recursive: true });
const executor: Profile = { id: "demo-executor", name: "Demo Executor", role: "executor", provider: "demo", family: "shared", model: "Demo-A", pool: "demo" };
const reviewer: Profile = { id: "demo-reviewer", name: "Demo Reviewer", role: "reviewer", provider: "demo", family: "shared", model: " demo-b ", pool: "demo", notes: "High-risk" };
const profiles = [executor, reviewer];
// Anonymous policy fixtures retain legacy selection; quota-routing tests cover the default-on router.
const config: KanbanConfig = {
  quotaRouting: { enabled: false },
  autoStart: { demo: true }, supervisorAgentId: null, supervisors: {},
  projects: { demo: { code: "DEMO", defaultWorkspace: "dir", baseBranch: "main", alwaysTemp: false, worktreeLanes: 1, lanesEnabled: false } },
  concurrency: { global: 10, roles: { ...DEFAULT_CONCURRENCY.roles }, pools: { demo: 10 } },
};
let calls = 0;
const launcher: AgentLauncher = {
  async create() { return { id: `anonymous-${++calls}` }; }, async send() {},
  async listModels() { return { models: profiles.map(profile => ({ id: profile.model!.trim(), aliases: [profile.model!], thinkingOptions: [{ id: "low" }] })) }; },
};
function payload(at = Date.now(), onlyRoles: string[] | null = null) {
  const date = new Date(at);
  return {
    policyDigest: policyDigest(),
    pools: PoolStatus.parse({ ...envelopeFor("poolStatus", "0", date), quotaConfigured: true, priority: null,
      pools: { demo: { dispatchable: true, prefer: false, deprioritize: false, usedPct: 10, resetsAt: null, onlyRoles, reason: null,
        quotaProtection: "pause", readingExpiresAt: new Date(at + 7 * 60_000).toISOString() } } }),
    matrix: DispatchMatrix.parse({ ...envelopeFor("dispatchMatrix", "0", date), version: 1, defaultTier: "L1", downgradeWhenTight: ["L1"], priority: null,
      roles: { executor: { L1: [{ profile: executor.name, effort: "low" }] },
        reviewer: { byExecutorModel: { "demo-a": { L1: [{ profile: reviewer.name, effort: "low" }] } } } } }),
  };
}
function publish(at = Date.now(), onlyRoles: string[] | null = null) {
  const input = payload(at, onlyRoles); return publishPolicySnapshot(input, input.policyDigest);
}
function task() { return createTask({ project: "demo", title: "Anonymous admission", role: "executor", tier: "L1", workspacePath: join(root, "work") }); }
beforeEach(() => {
  setLanguage("en"); resetReconcileForTests(); calls = 0;
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE status != 'archived'").run();
  saveConfig(config); rmSync(policySnapshotPath(), { force: true });
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: profiles } }));
  for (const name of ["plans.json", "afc.config.json", "paused-projects.json"]) writeFileSync(join(root, "data/fleet", name), name === "paused-projects.json" ? "[]" : "{}");
  const input = payload();
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify(input.pools));
  writeFileSync(process.env.KANBAN_DISPATCH_MATRIX!, JSON.stringify(input.matrix));
});
after(() => { closeDb(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true }); });

test("green legacy overrides cannot open default tick or CLI without immutable policy", async () => {
  const card = task();
  const tick = await runTick({ launcher, profiles, config, agentState: () => "alive" });
  assert.equal(tick.started.length, 0); assert.equal(getTask(card.id).status, "ready");
  await runKanban(["start", String(card.id)], {}, { launcher });
  assert.equal(calls, 0); assert.equal(getTask(card.id).status, "ready");
  assert.equal(readPoolSnapshot().dispatchable("demo"), false);
  assert.equal(loadDispatchMatrix().state, "invalid");
});
test("persisted policy starts an executor then a different model in the same family through actual CLI", async () => {
  publish(); const card = task();
  const tick = await runTick({ launcher, profiles, config, agentState: () => "alive" });
  assert.deepEqual(tick.started, [card.id], JSON.stringify(tick)); assert.equal(getTask(card.id).status, "running");
  getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = 'complete' WHERE task_id = ?").run(new Date().toISOString(), card.id);
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(card.id);
  const review = await runKanban(["create", "--project", "demo", "--title", "Anonymous review", "--role", "reviewer", "--workspace", join(root, "work"), "--reviews", String(card.id), "--tier", "L1"], {}) as { id: number };
  await runKanban(["start", String(review.id)], {}, { launcher });
  assert.equal(getTask(review.id).status, "reviewing", getTask(review.id).hold_reason ?? getTask(review.id).blocked_reason ?? ""); assert.equal(calls, 2);
});
test("profile edits invalidate persisted admission and green legacy overrides cannot rescue it", async () => {
  publish(); const card = task();
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: [{ ...executor, model: "Demo-C" }, reviewer] } }));
  assert.equal(readPersistedPolicy().state, "invalid");
  const tick = await runTick({ launcher, profiles, config, agentState: () => "alive" });
  assert.equal(tick.started.length, 0);
  await runKanban(["start", String(card.id)], {}, { launcher });
  assert.equal(calls, 0); assert.equal(getTask(card.id).status, "ready");
});
test("protected reading expiry and onlyRoles apply to default tick and CLI", async () => {
  publish(Date.now() - 8 * 60_000); const card = task();
  await runTick({ launcher, profiles, config, agentState: () => "alive" });
  await runKanban(["start", String(card.id)], {}, { launcher });
  assert.equal(calls, 0); assert.equal(getTask(card.id).status, "ready");
  publish(Date.now(), ["reviewer"]);
  await runTick({ launcher, profiles, config, agentState: () => "alive" });
  await runKanban(["start", String(card.id)], {}, { launcher });
  assert.equal(calls, 0); assert.equal(getTask(card.id).status, "ready");
});
test("CLI refuses policy inputs changed during an awaited model lookup", async () => {
  publish(); const card = task();
  const changed: AgentLauncher = { ...launcher, async listModels() {
    writeFileSync(join(root, "data/fleet", "paused-projects.json"), '[{"project":"demo"}]');
    return launcher.listModels!("demo");
  } };
  await assert.rejects(runKanban(["start", String(card.id)], {}, { launcher: changed }), /policy|Policy/);
  assert.equal(calls, 0); assert.equal(getTask(card.id).status, "ready");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(card.id)!.n, 0);
});
test("tick refuses a newer closed revision published during model lookup", async () => {
  publish(); const card = task();
  const changed: AgentLauncher = { ...launcher, async listModels() {
    const input = payload(); input.pools.pools.demo.dispatchable = false;
    publishPolicySnapshot(input, input.policyDigest);
    return launcher.listModels!("demo");
  } };
  const tick = await runTick({ launcher: changed, profiles, config, agentState: () => "alive" });
  assert.deepEqual(tick.started, []); assert.equal(calls, 0); assert.equal(getTask(card.id).status, "ready");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind IN ('start_failed', 'start_transient')").get(card.id)!.n, 0);
});
test("protected quota is rechecked after an awaited workspace lookup", async () => {
  const at = Date.now(); publish(at); const card = task();
  let lookups = 0;
  const changed: AgentLauncher = { ...launcher, async listWorkspaces() {
    if (++lookups === 2) mock.method(Date, "now", () => at + 7 * 60_000);
    return [];
  }, async createDirectoryWorkspace({ cwd }) { return { id: "anonymous-workspace", directory: cwd, name: "anonymous" }; } };
  try {
    const tick = await runTick({ launcher: changed, profiles, config, agentState: () => "alive" });
    assert.ok(lookups >= 2); assert.deepEqual(tick.started, []); assert.equal(calls, 0); assert.equal(getTask(card.id).status, "ready");
  } finally { mock.restoreAll(); }
});
