import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDispatchMatrix } from "../server/matrix";
import { openEntry, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile } from "../server/routing";
import type { Tier } from "../server/tier";

const snapshot: PoolSnapshot = {
  state: "fresh", message: "Demo quota", generatedAt: null,
  dispatchable: () => true, entry: () => openEntry(),
};
const base = { version: 1, defaultTier: "L2", downgradeWhenTight: [] };
const roles = ["reader", "decision", "batch"] as const;

for (const role of roles) {
  const profiles: Profile[] = ["default", "override"].map(id => ({
    id: `${role}-${id}`, name: `Demo ${role} ${id}`, role: id === "default" ? role : "candidate",
    candidateFor: role, provider: "grok", model: "grok-4.7", family: "xai", pool: "demo-pool",
  }));
  const route = (matrix: ReturnType<typeof parseDispatchMatrix>, tier: Tier) =>
    routeProfile({ matrix, tier, profiles, snapshot, role, review: false, byPool: {}, poolLimits: {}, project: "demo", tags: [] });

  for (const configuredTier of ["L1", "L2", "L3", "L4"] as const) {
    test(`${role} uses its explicit ${configuredTier} order and depth, falling back to wildcard for other tiers`, () => {
      const matrix = parseDispatchMatrix({ ...base, roles: { [role]: {
        "*": [{ profile: profiles[0].name, effort: "medium" }, { profile: profiles[1].name, effort: "low" }],
        [configuredTier]: [{ profile: profiles[1].name, effort: "high" }, { profile: profiles[0].name, effort: "medium" }],
      } } });
      for (const tier of ["L1", "L2", "L3", "L4"] as const) {
        const result = route(matrix, tier);
        assert.ok(result.ok, result.reason);
        assert.equal(result.profile.name, profiles[tier === configuredTier ? 1 : 0].name);
        assert.equal(result.effort, tier === configuredTier ? "high" : "medium");
        assert.equal(result.effortSource, "matrix");
      }
    });
  }

  test(`${role} respects empty tier lists and validates explicit tiers without a wildcard`, () => {
    const empty = parseDispatchMatrix({ ...base, roles: { [role]: { "*": [{ profile: profiles[0].name }], L3: [] } } });
    const held = route(empty, "L3");
    assert.ok(!held.ok);
    assert.equal(held.action, "hold");
    assert.equal(route(empty, "L1").ok, true);
    const specific = parseDispatchMatrix({ ...base, roles: { [role]: { L3: [{ profile: profiles[1].name, effort: null }] } } });
    const selected = route(specific, "L3");
    assert.ok(selected.ok, selected.reason);
    assert.equal(selected.profile.name, profiles[1].name);
    assert.equal(route(specific, "L1").ok, false);
    assert.throws(() => parseDispatchMatrix({ ...base, roles: { [role]: { L3: [{ profile: profiles[0].name, effort: "future-depth" }] } } }));
    assert.throws(() => parseDispatchMatrix({ ...base, roles: { [role]: { L3: null } } }));
  });
}

test("wildcard-only matrices keep their original parsed shape", () => {
  const matrix = parseDispatchMatrix({ ...base, roles: { reader: { "*": [{ profile: "Demo reader" }] } } });
  assert.equal(Object.hasOwn(matrix, "starTiers"), false);
  assert.deepEqual(matrix.star.reader, [{ profile: "Demo reader", effort: null, paused: false }]);
});

test("executor tiers and reviewer family tiers retain their original routing", () => {
  const executor: Profile = {
    id: "executor", name: "Demo executor", role: "executor",
    provider: "grok", model: "grok-4.7", family: "xai", pool: "demo-executor",
  };
  const reviewer: Profile = {
    id: "reviewer", name: "Demo reviewer", role: "reviewer",
    provider: "claude", model: "demo-model", family: "anthropic", pool: "demo-reviewer",
  };
  const matrix = parseDispatchMatrix({ ...base, roles: {
    executor: { L3: [{ profile: executor.name, effort: "high" }] },
    reviewer: { byExecutorFamily: { xai: { L3: [{ profile: reviewer.name, effort: "medium" }] } } },
    reader: { L3: [{ profile: "Demo reader", effort: "low" }] },
  } });
  for (const review of [false, true]) {
    const result = routeProfile({
      matrix, tier: "L3", profiles: [executor, reviewer], snapshot,
      role: review ? "reviewer" : "executor", review, executorFamily: review ? "xai" : null, executorModel: review ? executor.model : null,
      byPool: {}, poolLimits: {}, project: "demo", tags: [],
    });
    assert.ok(result.ok, result.reason);
    assert.equal(result.profile.name, review ? reviewer.name : executor.name);
    assert.equal(result.effort, review ? "medium" : "high");
    assert.equal(result.effortSource, "matrix");
  }
});
