import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { closeDb } from "../server/db";
import { loadConfig, saveConfig } from "../server/config";
import { parseDispatchMatrix } from "../server/matrix";
import { openEntry } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile, type RouteInput } from "../server/routing";

const dir = mkdtempSync(join(tmpdir(), "actual-model-"));
process.env.KANBAN_DATA_DIR = dir;
mkdirSync(join(dir, "fleet"));
beforeEach(() => saveConfig({ ...loadConfig(), families: {}, bannedProviders: { providers: [], families: [], pools: [], models: [] }, disabledPools: [], concurrency: { global: 10, roles: { reviewer: 10 }, pools: { demo: 10 } } }));
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
const executor: Profile = { id: "ex", name: "Executor", role: "executor", provider: "demo", family: "shared", model: " Demo-A ", pool: "demo" };
const reviewer: Profile = { id: "rev", name: "Reviewer", role: "reviewer", provider: "other", family: "shared", model: "Demo-B", pool: "demo", notes: "high-risk" };
function input(changes: Partial<RouteInput> = {}): RouteInput {
  return { role: "reviewer", review: true, executorFamily: executor.family, executorModel: executor.model, executorProfile: executor.name,
    reviewsExecutor: true, tier: "L2", profiles: [executor, reviewer], byPool: {}, poolLimits: { demo: 10 },
    snapshot: { state: "fresh", generatedAt: null, message: "anonymous", dispatchable: () => true, hasPool: () => true, entry: () => openEntry() }, ...changes };
}
test("same family different actual model admits, same model across provider/settings refuses", () => {
  assert.equal(routeProfile(input()).ok, true);
  for (const changed of [{ model: " demo-a ", provider: "other", family: "unrelated", thinkingOptionId: "high", modeId: "plan" }, { model: "" }, { model: undefined }]) {
    assert.equal(routeProfile(input({ profiles: [executor, { ...reviewer, ...changed }] })).ok, false);
  }
  assert.equal(routeProfile(input({ executorModel: null, executorProfile: undefined, profiles: [reviewer] })).ok, false);
});
test("exact model roster refuses absent/empty model branch without family fallback", () => {
  const row = { profile: reviewer.name, effort: "high", paused: false };
  const matrix = parseDispatchMatrix({ version: 1, generatedAt: new Date().toISOString(), defaultTier: "L2", downgradeWhenTight: [], roles: {
    reviewer: { byExecutorModel: { "demo-a": { L2: [row] } }, byExecutorFamily: { shared: { L2: [row] } } },
  } });
  assert.equal(routeProfile(input({ matrix })).ok, true);
  assert.equal(routeProfile(input({ executorModel: "other-model", matrix })).ok, false);
  assert.equal(routeProfile(input({ matrix: { ...matrix, reviewerModels: { "demo-a": { L2: [] } } } })).ok, false);
  for (const invalid of [null, [], "invalid", { " Demo-A ": {} }]) assert.throws(() => parseDispatchMatrix({ version: 1, defaultTier: "L2", downgradeWhenTight: [], roles: { reviewer: { byExecutorModel: invalid, byExecutorFamily: {} } } }));
});
test("pause, role, capacity, pool protection and high risk remain admission gates", () => {
  assert.equal(routeProfile(input({ profiles: [executor, { ...reviewer, paused: true }] })).ok, false);
  assert.equal(routeProfile(input({ profiles: [executor, { ...reviewer, role: "executor" }] })).ok, false);
  assert.equal(routeProfile(input({ byPool: { demo: 10 } })).ok, false);
  assert.equal(routeProfile(input({ snapshot: { ...input().snapshot, dispatchable: () => false, entry: () => ({ ...openEntry(), dispatchable: false }) } })).ok, false);
  assert.equal(routeProfile(input({ snapshot: { ...input().snapshot, entry: () => ({ ...openEntry(), onlyRoles: ["reader"] }) } })).ok, false);
  assert.equal(routeProfile(input({ tier: "L4", tags: ["high-risk"], rules: { Reviewer: { tags: ["ordinary-only"] } }, profiles: [executor, { ...reviewer, notes: "" }] })).ok, false);
});
