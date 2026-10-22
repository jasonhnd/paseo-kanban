import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { applyDispatchMatrix, profilesFromConfig, type DispatchMatrix as FleetMatrix, type DispatchProfile } from "../shared/fleet/dispatch";
import { resolveProfileToken } from "../shared/fleet/dispatch-slots";
import { parseDispatchMatrix } from "../server/matrix";
import { openEntry, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile } from "../server/routing";
import { protocolFor } from "../server/protocol";

const sol: Profile = { id: "sol", name: "Demo Sol executor", role: "candidate", candidateFor: "executor", provider: "codex", model: "gpt-6.1-sol", family: "openai", pool: "codex-pro", thinkingOptionId: "max" };
const luna: Profile = { ...sol, id: "luna", name: "Demo Luna executor", model: "gpt-6-luna", thinkingOptionId: "medium" };
const grok: Profile = { id: "grok", name: "Demo Grok executor", role: "executor", provider: "grok", model: "grok-4.7-build-fast", family: "xai", pool: "demo-grok", thinkingOptionId: "high" };
const reviewSol: Profile = { ...sol, id: "review-sol", name: "Demo Sol reviewer", candidateFor: "reviewer" };
const reviewLuna: Profile = { ...luna, id: "review-luna", name: "Demo Luna reviewer", candidateFor: "reviewer" };
const snapshot: PoolSnapshot = { state: "fresh", message: "Demo quota", generatedAt: null, dispatchable: () => true, entry: () => openEntry() };
const tiers = ["L1", "L2", "L3", "L4"] as const;
const base: FleetMatrix = JSON.parse(readFileSync(new URL("../shared/fleet/default-dispatch.example.json", import.meta.url), "utf8"));
const profiles: DispatchProfile[] = [sol, luna, grok, reviewSol, reviewLuna].map(p => ({ ...p, dispatchId: `${p.candidateFor ?? p.role}.${p.model}` }));
profiles.find(p => p.name === grok.name)!.dispatchId = "executor";
function published(dispatchOverrides?: unknown) {
  return applyDispatchMatrix(base, { profiles, knownNames: new Set(profiles.map(p => p.name)), pools: null, generatedAt: "2030-01-01T00:00:00Z",
    thinkingCatalog: Object.fromEntries(profiles.map(p => [p.name, ["low", "medium", "high", "xhigh", "max"]])), dispatchOverrides });
}
function route(tier: string, tags: string[], options: { title?: string; brief?: string; pinned?: boolean; cardEffort?: "max" | "medium"; matrix?: boolean; review?: boolean; profiles?: Profile[] } = {}) {
  return routeProfile({ matrix: options.matrix === false ? null : parseDispatchMatrix(published()), profiles: options.profiles ?? [sol, luna, grok, reviewSol, reviewLuna],
    role: options.review ? "reviewer" : "executor", review: options.review ?? false, tier, tags, title: options.title, brief: options.brief,
    cardEffort: options.cardEffort, profileOverride: options.pinned ? sol.name : undefined,
    executorFamily: options.review ? "xai" : null, executorModel: options.review ? grok.model : null, snapshot, byPool: {}, poolLimits: {} });
}

it("makes exact Luna slots first-class and publishes the model capability defaults", () => {
  for (const role of ["executor", "reviewer", "batch"]) {
    const profile = { name: `Demo ${role} Luna`, role: "candidate", candidateFor: role, provider: "codex", model: "gpt-6-luna" };
    assert.equal(resolveProfileToken(`${role}.gpt-6-luna`, [profile])?.name, profile.name);
    assert.equal(resolveProfileToken(`${role}.gpt-6-luna`, [{ ...profile, model: "gpt-6.1-sol" }]), null);
  }
  const executor = base.roles.executor as Record<string, Array<{ profile: string; effort: string }>>;
  const reviewer = base.roles.reviewer as typeof executor;
  assert.deepEqual(tiers.map(tier => [executor[tier][0].profile, executor[tier][0].effort]), [
    ["executor.gpt-6-luna", "medium"], ["executor.gpt-6.1-sol", "medium"], ["executor.gpt-6.1-sol", "high"], ["executor.gpt-6.1-sol", "xhigh"],
  ]);
  assert.deepEqual(tiers.map(tier => [reviewer[tier][0].profile, reviewer[tier][0].effort]), [
    ["reviewer.gpt-6-luna", "high"], ["reviewer.gpt-6-luna", "high"], ["reviewer.gpt-6.1-sol", "high"], ["reviewer.gpt-6.1-sol", "high"],
  ]);
  assert.deepEqual((base.roles.batch as Record<string, unknown[]>)["*"][0], { profile: "batch.gpt-6-luna", effort: "medium" });
  const example = JSON.parse(readFileSync(new URL("../examples/role-profiles.example.json", import.meta.url), "utf8"));
  assert.equal(profilesFromConfig(example)?.filter(p => p.model === "gpt-6-luna").length, 3);
});

it("routes operational cards at every tier only to Luna or Grok at low, including heuristics and explicit max", () => {
  for (const tier of tiers) for (const tag of ["ops", "deploy", "wait", "data-move", "release-rehearsal", "maintenance"]) {
    for (const options of [{}, { cardEffort: "max" as const }, { matrix: false }]) {
      const result = route(tier, [tag], options);
      assert.ok(result.ok, result.reason);
      assert.ok([luna.model, grok.model].includes(result.profile.model));
      assert.equal(result.effort, "low");
    }
  }
  for (const title of ["Deploy pre", "Preview: deploy pre", "Wait for long build", "Move data to storage", "\u90e8\u7f72 pre", "\u642c\u6570\u636e"]) {
    const result = route("L4", [], { title });
    assert.ok(result.ok, result.reason);
    assert.equal(result.effort, "low");
  }
  const coded = route("L3", ["hard-code"], { title: "Deploy a complex new compiler" });
  assert.ok(coded.ok, coded.reason);
  assert.equal(coded.profile.model, sol.model);
  assert.equal(coded.effort, "high");
  assert.equal(route("L3", ["ops"], { pinned: true }).ok, false, "a Sol pin cannot bypass the cheap operations route");
  assert.equal(route("L4", ["ops"], { profiles: [sol, reviewSol, reviewLuna] }).ok, false, "no expensive fallback when light profiles are missing");
  const fallback = route("L3", ["ops"], { profiles: [sol, grok, reviewSol, reviewLuna] });
  assert.ok(fallback.ok, fallback.reason);
  assert.equal(fallback.profile.model, grok.model);
  assert.equal(fallback.effort, "low");
});

it("requires a card-level max request, keeps default matrices free of max, and does not inherit executor tags into review", () => {
  const legacy = published({ executor: { L3: { "executor.gpt-6.1-sol": { effort: "max" } } }, reviewer: { L3: { "reviewer.gpt-6.1-sol": { effort: "max" } } } });
  assert.ok(!JSON.stringify(legacy).includes('"max"'));
  for (const tier of tiers) {
    for (const tags of [[], ["hard-code"]]) {
      const result = route(tier, tags);
      assert.ok(result.ok, result.reason);
      assert.notEqual(result.effort, "max");
    }
    const explicit = route(tier, ["hard-code"], { cardEffort: "max", pinned: true });
    assert.ok(explicit.ok, explicit.reason);
    assert.equal(explicit.effort, "max");
  }
  const requested = route("L4", ["needs-max"]);
  assert.ok(requested.ok, requested.reason);
  assert.equal(requested.effort, "max");
  const lower = route("L4", ["needs-max"], { cardEffort: "medium" });
  assert.ok(lower.ok, lower.reason);
  assert.equal(lower.effort, "medium");
  const review = route("L3", ["needs-max", "ops"], { review: true });
  assert.ok(review.ok, review.reason);
  assert.equal(review.effort, "high");
  for (const executor of [sol, luna]) {
    const result = routeProfile({ matrix: parseDispatchMatrix(published()), profiles: [sol, luna, grok, reviewSol, reviewLuna],
      role: "reviewer", review: true, reviewsExecutor: true, tier: "L1", executorModel: executor.model, executorFamily: "openai", snapshot, byPool: {}, poolLimits: {} });
    assert.ok(result.ok, result.reason);
    assert.notEqual(result.profile.model, executor.model);
  }
  for (const language of ["en", "zh-CN"] as const) {
    assert.match(protocolFor("executor", { language }), /--effort max/);
    assert.match(protocolFor("executor", { language }), /needs-max/);
  }
});
