import assert from "node:assert/strict";
import { test } from "node:test";
import { t } from "../shared/i18n";
import type { Tier } from "../server/tier";
import { DispatchMatrix as ContractMatrix } from "../shared/contract/schema";
import { parseDispatchMatrix } from "../server/matrix";
import { openEntry, type PoolEntry, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile } from "../server/routing";

const profiles: Profile[] = [
  { id: "demo-a", name: "Demo Fable review", role: "reviewer", family: "anthropic", provider: "claude", model: "claude-fable-demo", pool: "demo-a" },
  { id: "demo-b", name: "Demo review B", role: "candidate", candidateFor: "reviewer", family: "xai", provider: "grok", model: "demo-b-model", pool: "demo-b" },
  { id: "demo-c", name: "Demo review C", role: "candidate", candidateFor: "reviewer", family: "openai", provider: "codex", model: "demo-c-model", pool: "demo-c" },
];
const row = (index: number, order?: number, paused = false): { profile: string; effort: string | null; paused: boolean; order?: number } => ({ profile: profiles[index].name, effort: "xhigh", paused,
  ...(order !== undefined ? { order } : {}) });
const rawMatrix = (rows = [row(1), row(2), row(0, 1)]) => ({
  schema: "fleet-quota/v1", producer: "agent-fleet-cockpit", producerVersion: "0.1.0", generatedAt: "2030-01-01T00:00:00Z", ttlSeconds: 300,
  version: 1, defaultTier: "L2", downgradeWhenTight: [], roles: {
    reviewer: { byExecutorFamily: { openai: { L4: rows }, xai: { L4: rows }, anthropic: { L4: rows } } },
  },
});
function snapshot(pools: Record<string, Partial<PoolEntry>> = {}): PoolSnapshot {
  const entry = (pool: string | null) => ({ ...openEntry(), prefer: pool !== "demo-a", deprioritize: pool === "demo-a", ...pools[pool ?? ""] });
  return { state: "fresh", message: "Demo quota", generatedAt: "2030-01-01T00:00:00Z", entry,
    hasPool: pool => profiles.some(profile => profile.pool === pool), dispatchable: pool => entry(pool).dispatchable };
}
function route(family: string, rows = [row(1), row(2), row(0, 1)], pools: Record<string, Partial<PoolEntry>> = {}, candidates = profiles) {
  // Parse the contract first so the test covers retention at the file boundary as well as routing.
  const matrix = parseDispatchMatrix(ContractMatrix.parse(rawMatrix(rows)));
  return routeProfile({ profiles: candidates, role: "reviewer", review: true, executorFamily: family, executorModel: family === "anthropic" ? "claude-fable-demo" : family === "xai" ? "demo-b-model" : "demo-exec-model", tier: "L4",
    project: "DEMO", byPool: {}, poolLimits: {}, snapshot: snapshot(pools), matrix, rules: {} });
}
function chosen(result: ReturnType<typeof route>): string {
  assert.equal(result.ok, true, result.reason);
  return result.ok ? result.profile.name : "";
}

test("L4 explicit order selects Fable before quota-preferred independent reviewers", () => {
  for (const family of ["openai", "xai"]) assert.equal(chosen(route(family)), profiles[0].name);
  assert.equal(chosen(route("anthropic")), profiles[1].name);
});

test("ordered reviewers still obey pauses, pool eligibility, family, missing profiles and depth guards", () => {
  assert.equal(chosen(route("openai", [row(0, 1, true), row(1)])), profiles[1].name);
  assert.equal(chosen(route("openai", undefined, { "demo-a": { dispatchable: false } })), profiles[1].name);
  assert.equal(chosen(route("xai", undefined, { "demo-a": { dispatchable: false } })), profiles[2].name);
  assert.equal(chosen(route("openai", undefined, { "demo-a": { onlyRoles: ["reader"] } })), profiles[1].name);
  assert.equal(chosen(route("openai", undefined, {}, profiles.slice(1))), profiles[1].name);
  const matrix = parseDispatchMatrix(ContractMatrix.parse(rawMatrix()));
  const result = routeProfile({ profiles, role: "reviewer", review: true, executorFamily: "openai", executorModel: "demo-exec-model", tier: "L4",
    project: "DEMO", byPool: {}, poolLimits: {}, snapshot: snapshot(), matrix, rules: {},
    supportsEffort: profile => profile.id !== profiles[0].id });
  assert.equal(chosen(result), profiles[1].name);
  assert.ok(result.reason.includes(t("routing.noEffortSupport", { effort: "xhigh" })));

});

test("multiple explicit positions sort first with stable ties; no order keeps quota routing unchanged", () => {
  assert.equal(chosen(route("openai", [row(1, 1000), row(0, 20)])), profiles[0].name);
  assert.equal(chosen(route("openai", [row(1, 1000), row(0, 1000)])), profiles[1].name);
  assert.equal(chosen(route("openai", [row(0), row(1)])), profiles[1].name);
  const parsed = parseDispatchMatrix(rawMatrix([row(1)]));
  assert.deepEqual(parsed.reviewerFamilies.openai.L4, [{ profile: profiles[1].name, effort: "xhigh", paused: false }]);
  for (const order of [0, -1, 1.5, 1001, "1"]) {
    const matrix = rawMatrix([{ ...row(0), order } as ReturnType<typeof row>]);
    assert.throws(() => parseDispatchMatrix(matrix), { message: t("matrix.badOrder", { where: "reviewer.openai.L4[0]" }) });
    assert.equal(ContractMatrix.safeParse(matrix).success, false);
  }
});

test("explicit candidate order precedes an active pool priority and a retry pool preference", () => {
  const matrix = parseDispatchMatrix(ContractMatrix.parse({ ...rawMatrix(),
    priority: { order: ["demo-b", "demo-a"], until: "2031-01-01T00:00:00Z" },
  }));
  const result = routeProfile({ profiles, role: "reviewer", review: true, executorFamily: "openai", executorModel: "demo-exec-model", tier: "L4",
    project: "DEMO", byPool: {}, poolLimits: {}, snapshot: snapshot(), matrix, rules: {},
    avoidPools: ["demo-a"], now: Date.parse("2030-01-01T00:00:00Z") });
  assert.equal(chosen(result), profiles[0].name);
});

test("ordered reviewers still obey concurrency limits", () => {
  const matrix = parseDispatchMatrix(ContractMatrix.parse(rawMatrix()));
  const input = { profiles, role: "reviewer", review: true, executorFamily: "openai", executorModel: "demo-exec-model", tier: "L4",
    project: "DEMO", byPool: {}, poolLimits: {}, snapshot: snapshot(), matrix, rules: {} };
  assert.equal(chosen(routeProfile({ ...input, byPool: { "demo-a": 1 }, poolLimits: { "demo-a": 1 } })), profiles[1].name);
});

for (const role of ["executor", "reader", "decision", "batch"] as const) {
  test(`${role} orders candidates within difficulty lists and retains wildcard fallback`, () => {
    const candidates = [...profiles.slice(0, 2).map(profile => ({ ...profile, role })), profiles[2]];
    const matrix = parseDispatchMatrix(ContractMatrix.parse({ ...rawMatrix(), roles: {
      reviewer: { byExecutorFamily: { anthropic: { L3: [row(2)] }, xai: { L3: [row(2)] } } },
      [role]: {
        ...(role === "executor" ? {} : { "*": [row(1, 1), row(0, 2)] }),
        L3: [row(1, 2), row(0, 1)], L4: [],
      },
    } }));
    const routeTier = (tier: Tier) => routeProfile({ profiles: candidates, role, review: false, tier,
      project: "DEMO", byPool: {}, poolLimits: {}, snapshot: snapshot(), matrix, rules: {} });
    const selected = routeTier("L3");
    assert.equal(chosen(selected), profiles[0].name);
    assert.equal(selected.ok && selected.effort, "xhigh");
    assert.equal(routeTier("L4").ok, false);
    if (role === "executor") assert.equal(routeTier("L2").ok, false);
    else {
      assert.equal(chosen(routeTier("L2")), profiles[1].name);
      assert.equal(matrix.starTiers?.[role]?.L3?.[1].order, 1);
    }
  });
}
