import { setLanguage } from "../shared/i18n";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../server/db";
import { appendEvent, createTask, getTask } from "../server/store";
import { parseConfig, saveConfig } from "../server/config";
import { routeProfile, type RouteInput } from "../server/routing";
import type { Profile } from "../server/profiles";
import type { PoolEntry, PoolSnapshot } from "../server/pools";
import type { DispatchMatrix, MatrixItem } from "../server/matrix";
import { qualificationReworkCount } from "../server/qualification";

const root = mkdtempSync(join(tmpdir(), "quota-routing-"));
process.env.KANBAN_DATA_DIR = root;
mkdirSync(join(root, "work")); mkdirSync(join(root, "fleet"));
after(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });
const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString();
const row = (extra = {}): PoolEntry => ({ state: "known", dispatchable: true, prefer: false, deprioritize: false,
  usedPct: 10, resetsAt: iso(6), reason: null, onlyRoles: null, ...extra });
let pools: Record<string, PoolEntry>;
let profiles: Profile[];
let matrix: DispatchMatrix;
let config: ReturnType<typeof parseConfig>;
beforeEach(() => {
  setLanguage("en");
  config = parseConfig({ families: {}, bannedProviders: { providers: [], families: [], pools: [], models: [] },
    projects: { demo: { defaultWorkspace: "dir", alwaysTemp: false } } });
  saveConfig(config);
  rmSync(join(root, "fleet/run-costs.json"), { force: true });
  pools = { "codex-pro": row({ usedPct: 9, projectedPct: 350, runsOutAt: iso(1), forecastConfidence: "high" }),
    supergrok: row({ usedPct: 16, resetsAt: iso(2), projectedPct: 30, forecastConfidence: "high" }), "claude-max": row({ usedPct: 3 }) };
  profiles = ["executor", "reviewer", "reader", "batch"].flatMap(role => [
    { id: `${role}-sol`, name: `${role} Sol`, role, provider: "codex", model: "gpt-6.1-sol", pool: "codex-pro", thinkingOptionId: "xhigh" },
    { id: `${role}-grok`, name: `${role} Grok`, role, provider: "grok", model: "grok-4.7", pool: "supergrok", thinkingOptionId: "high" },
    { id: `${role}-sonnet`, name: `${role} Sonnet`, role, provider: "claude", model: role === "reader" ? "claude-sonnet-5-5[1m]" : "claude-sonnet-5-5", pool: "claude-max" },
  ]);
  const items = (role: string): MatrixItem[] => profiles.filter(p => p.role === role).map((p, order) => ({ profile: p.name, effort: "xhigh", paused: false, order: order + 1 }));
  const tiers = (role: string) => Object.fromEntries(["L1", "L2", "L3", "L4"].map(tier => [tier, items(role)]));
  matrix = { version: 1, generatedAt: new Date(now).toISOString(), defaultTier: "L2", downgradeWhenTight: ["L1", "L2"],
    executor: tiers("executor"), reviewerFamilies: { openai: tiers("reviewer"), grok: tiers("reviewer") },
    reviewerModels: { "gpt-6.1-sol": tiers("reviewer"), "grok-4.7": tiers("reviewer") },
    star: { reader: items("reader"), batch: items("batch") }, priority: { order: ["codex-pro", "supergrok", "claude-max"], until: iso(4), untilMs: now + 4 * 86400000 } };
});
function input(role = "reader", tier = "L2", patch: Partial<RouteInput> = {}): RouteInput {
  const task = createTask({ project: "demo", title: "Change code", role, tier: tier as never, workspacePath: join(root, "work") });
  const snapshot: PoolSnapshot = { state: "fresh", generatedAt: iso(0), message: "Demo", hasPool: p => !!p && !!pools[p],
    entry: p => pools[p ?? ""] ?? row({ dispatchable: false }), dispatchable: p => !!p && !!pools[p]?.dispatchable };
  return { task, routingConfig: config, profiles, role, review: role === "reviewer", project: "demo", tier, snapshot, matrix,
    byPool: {}, poolLimits: {}, now, ...patch } as RouteInput;
}
function pick(i: RouteInput) { const d = routeProfile(i); if (!d.ok) assert.fail(d.reason); return d; }
for (const [role, tier, pool, effort] of [["reviewer", "L2", "supergrok", "medium"], ["reader", "L2", "supergrok", "low"],
  ["batch", "L1", "supergrok", "low"], ["executor", "L4", "codex-pro", "high"], ["executor", "L3", "supergrok", "high"]]) {
  test(`design scenario routes ${role}/${tier} to ${pool} at ${effort}`, () => {
    const d = pick(input(role, tier)); assert.equal(d.profile.pool, pool); assert.equal(d.effort, effort);
    assert.match(d.reason, /cost|estimate/i); assert.match(d.reason, /surplus|remaining/i);
  });
}
test("returns advance one depth; a stopped review and its leader continuation count once", () => {
  const i = input("batch", "L1"); const task = i.task!;
  appendEvent(task.id, "request_changes", "reviewing", "rework", "reviewer", {});
  appendEvent(task.id, "leader_rework", "rework", "ready", "supervisor", {});
  assert.equal(qualificationReworkCount(task.id), 1);
  assert.equal(pick({ ...i, task: getTask(task.id) } as RouteInput).effort, "medium");
});
test("cost admission removes an expensive primary and then permits Claude fallback", () => {
  pools.supergrok = row({ usedPct: 98, resetsAt: iso(1) }); pools["codex-pro"] = row({ usedPct: 79 });
  const d = pick(input("batch", "L1")); assert.equal(d.profile.pool, "claude-max");
  assert.match(d.reason, /default|fallback/i);
});
test("measured estimates are scoped to the candidate pool and depth", () => {
  pools.supergrok = row({ usedPct: 97, resetsAt: iso(1) });
  const records = [1, 2, 3].flatMap(runId => [
    { runId, source: "measured", model: "grok-4.7", effort: "low", cardType: "read", role: "reader", tier: "L2", pool: "supergrok", quotaPctDelta: 1 },
    { runId: runId + 10, source: "measured", model: "grok-4.7", effort: "low", cardType: "read", role: "reader", tier: "L2", pool: "other", quotaPctDelta: 90 },
  ]);
  writeFileSync(join(root, "fleet/run-costs.json"), JSON.stringify({ records }));
  const d = pick(input()); assert.equal(d.profile.pool, "supergrok"); assert.match(d.reason, /1\.5/);
});
test("unknown pool limits include other profiles and high tiers stay excluded", () => {
  pools.supergrok = row({ state: "unknown", usedPct: null }); pools["codex-pro"] = row({ dispatchable: false }); pools["claude-max"] = row({ dispatchable: false });
  assert.equal(pick(input()).profile.pool, "supergrok");
  assert.equal(routeProfile(input("reader", "L2", { byPool: { supergrok: 1 } })).ok, false);
  assert.equal(routeProfile(input("reader", "L3")).ok, false);
});
test("actual model, high-risk roster, capacity, pauses, fast and Cursor remain gates", () => {
  pools["codex-pro"] = row();
  const i = input("reviewer", "L4", { executorModel: " GROK-4.7 ", reviewsExecutor: true });
  assert.equal(pick(i).profile.model, "gpt-6.1-sol");
  matrix.reviewerModels!["grok-4.7"]!.L4 = [];
  assert.equal(routeProfile(i).ok, false);
  assert.equal(routeProfile(input("reader", "L2", { poolLimits: { supergrok: 1 }, byPool: { supergrok: 1 }, profileOverride: "reader-grok" })).ok, false);
  const grok = profiles.find(p => p.id === "reader-grok")!;
  grok.provider = "cursor";
  assert.equal(routeProfile(input("reader", "L2", { profileOverride: grok.id })).ok, false);
});
for (const model of ["claude-opus-demo", "unknown", "grok-4.7", "composer-2"]) {
  for (const scenario of ["paused", "outside matrix", "empty matrix"] as const) {
    test(`quota routing permanently refuses Cursor ${model} when ${scenario}`, () => {
      config = parseConfig({ ...config, quotaRouting: { enabled: true } });
      const cursor: Profile = { id: "reader-cursor", name: "Reader Cursor", role: "reader", provider: "cursor", model, pool: "x-ultra" };
      profiles.push(cursor);
      matrix.star.reader = scenario === "paused" ? [{ profile: cursor.name, effort: "low", paused: true }]
        : scenario === "empty matrix" ? [] : matrix.star.reader;
      const result = routeProfile(input("reader", "L2", scenario === "paused" ? {} : { profileOverride: cursor.id }));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, model === "grok-4.7" || model === "composer-2" ? /Cursor channel is reserved/i : /paid Additional Usage/i);
        assert.equal(result.action, "block");
        assert.equal(result.kind, "needs_human");
        assert.notEqual(result.quotaWait, true);
      }
    });
  }
}
test("explicit profile cannot bypass reserve or quality and disabled switch restores old order/depth", () => {
  pools["codex-pro"] = row({ usedPct: 79 });
  assert.equal(routeProfile(input("executor", "L4", { profileOverride: "executor-sol" })).ok, false);
  config = parseConfig({ ...config, quotaRouting: { enabled: false } });
  const d = pick(input("reader", "L2")); assert.equal(d.profile.pool, "codex-pro"); assert.equal(d.effort, "xhigh");
});

test("pool selection uses the lightest qualified model inside the chosen pool", () => {
  pools["codex-pro"] = row(); pools.supergrok.dispatchable = false;
  const luna = { id: "batch-luna", name: "Batch Luna", role: "batch", provider: "codex", model: "gpt-6-luna", pool: "codex-pro" };
  profiles.push(luna); matrix.star.batch!.push({ profile: luna.name, effort: "xhigh", paused: false });
  const d = pick(input("batch", "L1")); assert.equal(d.profile.model, "gpt-6-luna"); assert.equal(d.effort, "low");
});
test("parent reserve is estimated independently and special-mode metadata keeps its reserve", () => {
  pools.supergrok.dispatchable = false; pools["codex-pro"].dispatchable = false;
  const child = profiles.find(p => p.id === "reader-sonnet")!; child.pool = "claude-child";
  pools["claude-child"] = row({ parent: "claude-max", reservePct: 0, usedPct: 80 });
  pools["claude-max"] = row({ reservePct: 10, usedPct: 80 });
  assert.equal(pick(input()).profile.pool, "claude-child");
  pools["claude-max"] = row({ reservePct: 25, usedPct: 72 });
  assert.equal(routeProfile(input()).ok, false);
});
test("fast settings, paused candidates, unsupported depths and explicit pins stay closed", () => {
  const grok = profiles.find(p => p.id === "reader-grok")!;
  grok.featureValues = { fast: true };
  assert.equal(routeProfile(input("reader", "L2", { profileOverride: grok.id })).ok, false);
  delete grok.featureValues;
  matrix.star.reader!.find(item => item.profile === grok.name)!.paused = true;
  assert.equal(routeProfile(input("reader", "L2", { profileOverride: grok.id })).ok, false);
  matrix.star.reader!.find(item => item.profile === grok.name)!.paused = false;
  assert.equal(routeProfile(input("reader", "L2", { profileOverride: grok.id, supportsEffort: () => false })).ok, false);
});
test("configuration validates defaults, new pins and reserve overrides without inheriting old priority", () => {
  for (const patch of [{ enabled: "yes" }, { minSamples: 0 }, { defaultCostPct: NaN }, { safetyFactor: 0 }, { reserves: { demo: 101 } }, { dispatchPriority: {} }]) {
    assert.throws(() => parseConfig({ quotaRouting: patch }));
  }
  pools["codex-pro"] = row();
  config = parseConfig({ ...config, quotaRouting: { dispatchPriority: { order: ["codex-pro"], until: iso(1) } } });
  assert.equal(pick(input()).profile.pool, "codex-pro");
  config = parseConfig({ ...config, quotaRouting: { dispatchPriority: { order: ["codex-pro"], until: iso(-1) } } });
  assert.equal(pick(input()).profile.pool, "supergrok");
  config = parseConfig({ ...config, quotaRouting: { reserves: { supergrok: 82 } } });
  assert.equal(pick(input()).profile.pool, "codex-pro");
});

test("a child run consumes its unknown parent's shared slot and configured capacity", () => {
  pools.supergrok.dispatchable = false; pools["codex-pro"].dispatchable = false;
  profiles.find(p => p.id === "reader-sonnet")!.pool = "claude-child";
  pools["claude-child"] = row({ parent: "claude-max", reservePct: 0 });
  pools["claude-max"] = row({ state: "unknown", usedPct: null });
  assert.equal(routeProfile(input("reader", "L2", { byPool: { "claude-child": 1 } })).ok, false);
  pools["claude-max"] = row();
  assert.equal(routeProfile(input("reader", "L2", { byPool: { "claude-child": 1 }, poolLimits: { "claude-max": 1 } })).ok, false);
});
