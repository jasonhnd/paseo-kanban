// Exercise the real producer and default admission path with anonymous fixtures only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import { policyDigest, policySnapshotPath, publishPolicySnapshot, readPersistedPolicy } from "../server/application/policy-snapshot";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { DispatchMatrix, PoolStatus, envelopeFor } from "../server/contract";
import { closeDb, getDb } from "../server/db";
import { startTask, type AgentLauncher } from "../server/dispatch";
import { toPoolState } from "../server/fleet/exports";
import { poolStatus } from "../server/fleet/pools-status";
import { loadDispatchMatrix } from "../server/matrix";
import { readPoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile } from "../server/routing";
import { createTask, getTask } from "../server/store";
import type { UsagePlan, UsageWindow } from "../shared/fleet/usage";
import { setLanguage, translate } from "../shared/i18n";

const root = mkdtempSync(join(tmpdir(), "stale-policy-"));
const saved = { ...process.env };
Object.assign(process.env, {
  KANBAN_DATA_DIR: join(root, "data"), PASEO_HOME: join(root, "host"),
  KANBAN_PASEO_CONFIG: join(root, "host/config.json"), KANBAN_TMP_ROOT: join(root, "tmp"),
  KANBAN_AGENTS_DIR: join(root, "agents"),
});
for (const key of ["PASEO_AGENT_ID", "KANBAN_TOKEN", "AFC_DATA_DIR", "ROLES_STATE_DIR", "AFC_LEGACY_DATA_DIR", "KANBAN_POOL_STATUS", "KANBAN_DISPATCH_MATRIX"]) delete process.env[key];
for (const dir of ["host", "data/fleet", "work", "tmp", "agents"]) mkdirSync(join(root, dir), { recursive: true });
const NOW = Date.now();
const STALE = 46 * 60_000;
const TTL = envelopeFor("poolStatus", "0").ttlSeconds * 1000;
const profile: Profile = { id: "demo", name: "Demo", role: "reader", provider: "demo", family: "demo", model: "demo-a", pool: "demo" };
// Anonymous policy fixtures retain legacy selection; quota-routing tests cover the default-on router.
const config: KanbanConfig = {
  quotaRouting: { enabled: false },
  autoStart: { demo: true }, supervisorAgentId: null, supervisors: {},
  projects: { demo: { code: "DEMO", defaultWorkspace: "dir", baseBranch: "main", alwaysTemp: false, lanesEnabled: false, worktreeLanes: 1 } },
  concurrency: { global: 10, roles: { ...DEFAULT_CONCURRENCY.roles }, pools: { demo: 10 } },
};
let calls = 0;
const launcher: AgentLauncher = {
  async create() { return { id: `anonymous-${++calls}` }; }, async send() {},
  async listModels() { return { models: [{ id: "demo-a", thinkingOptions: [{ id: "low" }] }] }; },
};
function window(at: number, patch: Partial<UsageWindow> = {}): UsageWindow {
  return {
    label: "Demo", usedPct: 20, resetsAt: null, startsAt: null, elapsedPct: null,
    projectedPct: null, runsOutAt: null, verdict: "unknown", apiUsd: 0,
    fullWindowUsd: null, planUsd: null, source: "provider", manualAt: null,
    primary: true, readingExpiresAt: new Date(at + 7 * 60_000).toISOString(), ...patch,
  };
}
function plan(at: number, patch: Partial<UsagePlan> = {}): UsagePlan {
  return {
    id: "demo", name: "Demo", adapter: "manual", dispatch: true, quotaProtection: "none",
    providers: [], priceUsdMonthly: null, windows: [window(at)], note: "Anonymous plan stop",
    api30dUsd: 0, roi30d: null, coverage: "", ...patch,
  };
}
function publish(value: UsagePlan, at = NOW - STALE, paused = false) {
  writeFileSync(join(root, "data/fleet/plans.json"), JSON.stringify({ plans: [value] }));
  const produced = poolStatus([value], { now: at }).demo;
  assert.ok(produced, "real producer must supply the configured pool");
  const input = {
    policyDigest: policyDigest(),
    pools: PoolStatus.parse({ ...envelopeFor("poolStatus", "0", new Date(at)), quotaConfigured: true, priority: null, pools: { demo: toPoolState(produced) } }),
    matrix: DispatchMatrix.parse({ ...envelopeFor("dispatchMatrix", "0", new Date(at)), version: 1, defaultTier: "L1", downgradeWhenTight: ["L1"], priority: null,
      roles: { reader: { L1: [{ profile: profile.name, effort: "low", paused }] }, reviewer: { byExecutorModel: {} } } }),
  };
  publishPolicySnapshot(input, input.policyDigest);
  assert.equal(readPersistedPolicy().state, "ok");
  return { produced, input };
}
async function observe(label: string) {
  const snapshot = readPoolSnapshot(), loaded = loadDispatchMatrix();
  const route = routeProfile({ profiles: [profile], role: "reader", review: false, project: "demo", byPool: {}, poolLimits: {}, snapshot,
    matrix: loaded.state === "ok" ? loaded.matrix : null, tier: "L1" });
  const task = createTask({ project: "demo", title: "Anonymous admission", role: "reader", tier: "L1", workspacePath: join(root, "work") });
  const before = calls;
  await startTask(task.id, launcher, "fixture");
  const observed = { label, state: snapshot.state, dispatchable: snapshot.dispatchable("demo"), routeOk: route.ok,
    creates: calls - before, status: getTask(task.id).status };
  console.log(JSON.stringify(observed));
  return { snapshot, route, task, observed };
}
async function rejected(label: string, poolClosed = true) {
  const result = await observe(label);
  if (poolClosed) assert.equal(result.observed.dispatchable, false, label);
  assert.equal(result.observed.routeOk, false, label);
  assert.equal(result.observed.creates, 0, label);
  assert.equal(result.observed.status, "ready", label);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(result.task.id)!.n, 0);
}
beforeEach(() => {
  mock.restoreAll(); mock.method(Date, "now", () => NOW); setLanguage("en"); calls = 0;
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE status != 'archived'").run();
  saveConfig(config); rmSync(policySnapshotPath(), { force: true });
  writeFileSync(process.env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: [profile] } }));
  for (const name of ["plans.json", "afc.config.json", "paused-projects.json"]) writeFileSync(join(root, "data/fleet", name), name === "paused-projects.json" ? "[]" : "{}");
});
after(() => {
  mock.restoreAll(); closeDb();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true });
});

for (const protection of ["none", undefined] as const) {
  for (const age of [0, TTL * 3 - 1, TTL * 3, TTL * 3 + 1, STALE]) {
    test(`default admission preserves ${protection ?? "legacy-low"} dispatch=false at age ${age}`, async () => {
      const at = NOW - age;
      const { produced } = publish(plan(at, { dispatch: false, quotaProtection: protection }), at);
      assert.equal(produced.dispatchable, false);
      await rejected(`${protection ?? "legacy-low"} hard stop ${age}`);
      assert.equal(readPoolSnapshot().state, age > TTL * 3 ? "stale" : "fresh");
    });
  }
}
for (const age of [0, TTL * 3, TTL * 3 + 1, STALE]) {
  test(`default routing retains paused with an open unprotected pool at age ${age}`, async () => {
    const at = NOW - age;
    assert.equal(publish(plan(at), at, true).produced.dispatchable, true);
    assert.equal(readPoolSnapshot().dispatchable("demo"), true);
    await rejected(`paused ${age}`, false);
  });
}
for (const [label, protection, signal] of [
  ["safetyError", "none", { safetyError: "Anonymous authentication failure" }],
  ["knownQuotaStop", "pause", { knownQuotaStop: "Anonymous exhausted source" }],
] as const) {
  test(`producer ${label} remains closed through stale default admission`, async () => {
    const at = NOW - STALE;
    const { produced } = publish(plan(at, { quotaProtection: protection, windows: [window(at, { readingState: "live", ...signal })] }), at);
    assert.equal(produced.dispatchable, false); assert.match(produced.reason, /Anonymous/);
    await rejected(label);
  });
}
for (const age of [7 * 60_000 - 1, 7 * 60_000, STALE]) {
  test(`protected reading expiry remains enforced at age ${age}`, async () => {
    const at = NOW - age;
    assert.equal(publish(plan(at, { quotaProtection: "pause", windows: [window(at, { readingState: "live" })] }), at).produced.dispatchable, true);
    if (age < 7 * 60_000) {
      const result = await observe("protected live"); assert.equal(result.observed.creates, 1);
    } else { await rejected(`protected expiry ${age}`); assert.equal(readPoolSnapshot().entry("demo").usedPct, null); }
  });
}
test("stale originally open none pool remains allowed without a matrix pause, even at 99 percent", async () => {
  const at = NOW - STALE;
  assert.equal(publish(plan(at, { windows: [window(at, { usedPct: 99 })] }), at).produced.dispatchable, true);
  const result = await observe("none open positive");
  assert.equal(result.observed.state, "stale"); assert.equal(result.observed.dispatchable, true);
  assert.equal(result.observed.routeOk, true); assert.equal(result.observed.creates, 1); assert.equal(result.observed.status, "running");
});
for (const language of ["en", "zh-CN"] as const) {
  test(`stale default policy diagnostic retains stops and matrix pauses in ${language}`, async () => {
    setLanguage(language);
    publish(plan(NOW - STALE));
    const snapshot = readPoolSnapshot();
    const matrix = loadDispatchMatrix();
    const route = routeProfile({ profiles: [profile], role: "reader", review: false, project: "demo", byPool: {}, poolLimits: {}, snapshot,
      matrix: matrix.state === "ok" ? matrix.matrix : null, tier: "L1" });
    const expected = translate(language, "pools.stalePolicyMessage", { minutes: 46 });
    assert.equal(snapshot.message, expected);
    assert.ok(route.ok); assert.ok(route.reason.includes(expected));
    assert.notEqual(snapshot.message, translate(language, "pools.staleMessage", { minutes: 46 }));
    publish(plan(NOW - STALE, { dispatch: false }), NOW - STALE, true);
    assert.equal(readPoolSnapshot().message, expected);
    await rejected("stale diagnostic keeps hard stops");
  });
}
test("legacy 99 percent stop still closes an originally open old-schema policy entry", async () => {
  const at = NOW - STALE;
  const { input } = publish(plan(at, { quotaProtection: undefined, windows: [window(at, { usedPct: 99 })] }), at);
  // An old-schema producer could allow this reading; the consumer must keep its stale stop line.
  input.pools.pools.demo.dispatchable = true;
  publishPolicySnapshot(input, input.policyDigest);
  await rejected("legacy 99 percent");
});
test("disabledPools overrides an originally open stale none policy", async () => {
  publish(plan(NOW - STALE)); saveConfig({ ...config, disabledPools: ["demo"] });
  await rejected("disabledPools");
});
for (const malformed of [false, true]) {
  test(`default admission refuses ${malformed ? "invalid" : "absent"} policy despite green compatibility overrides`, async () => {
    const { input } = publish(plan(NOW));
    process.env.KANBAN_POOL_STATUS = join(root, "legacy-pools.json");
    process.env.KANBAN_DISPATCH_MATRIX = join(root, "legacy-matrix.json");
    writeFileSync(process.env.KANBAN_POOL_STATUS, JSON.stringify(input.pools));
    writeFileSync(process.env.KANBAN_DISPATCH_MATRIX, JSON.stringify(input.matrix));
    if (malformed) writeFileSync(policySnapshotPath(), "{broken"); else rmSync(policySnapshotPath());
    try { await rejected(malformed ? "invalid" : "absent"); }
    finally { delete process.env.KANBAN_POOL_STATUS; delete process.env.KANBAN_DISPATCH_MATRIX; }
  });
}
test("changed plan digest refuses a stale originally open policy", async () => {
  publish(plan(NOW - STALE));
  writeFileSync(join(root, "data/fleet/plans.json"), JSON.stringify({ plans: [plan(NOW, { dispatch: false })] }));
  assert.equal(readPersistedPolicy().state, "invalid");
  await rejected("changed digest");
});
