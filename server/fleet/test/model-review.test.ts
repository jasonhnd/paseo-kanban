import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyDispatchMatrix, eligibleReviewers, firstDispatchable, legacyReviewerTiers, profilesFromConfig, reviewerTier, type DispatchMatrix, type DispatchProfile } from "../../../shared/fleet/dispatch";
import { DispatchMatrix as ExportMatrix } from "../../../shared/contract/schema";
import { buildDispatchMatrixExport } from "../exports";
import { buildRolesPageView } from "../roles-page";
import { differentReviewModels } from "../../../shared/fleet/review-model";
import { modelConflicts } from "../../../shared/fleet/roles-swap";
import { checkProfiles, parseProfiles } from "../../../shared/fleet/doctor-checks";

const fixture = JSON.parse(readFileSync(new URL("../../contract/test/model-review.fixture.json", import.meta.url), "utf8"));
const profiles = profilesFromConfig({ daemon: { agentProfiles: fixture.profiles } })!;
const now = Date.parse("2030-01-01T00:00:00Z");
const options = { profiles, knownNames: new Set(profiles.map(profile => profile.name)), pools: fixture.pools, generatedAt: new Date(now).toISOString() };
const build = (base: DispatchMatrix = fixture.base, live: DispatchProfile[] = profiles) =>
  applyDispatchMatrix(base, { ...options, profiles: live, knownNames: new Set(live.map(profile => profile.name)) });

test("raw profiles through apply, contract/export parse and server Roles view use actual models", async () => {
  const matrix = build();
  const parsed = ExportMatrix.parse(buildDispatchMatrixExport(matrix, "demo", new Date(now)));
  assert.deepEqual(parsed.roles, matrix.roles);
  for (const row of fixture.cases.filter((row: { tier: string }) => row.tier === "L2")) {
    const candidates = eligibleReviewers(parsed, row.executorModel, row.tier, profiles, fixture.pools).filter(entry => !entry.paused);
    assert.equal(candidates.some(entry => entry.profile === row.reviewer), row.allowed, row.label);
  }
  const page = await buildRolesPageView({ profiles: async () => profiles, pools: async () => fixture.pools, runsSince: () => [], baseMatrix: async () => fixture.base }, now);
  const line = page.cards.find(card => card.key === "reviewer")!.orderLines.find(line => line.includes("demo-alpha"))!;
  assert.match(line, /L2 Demo same family reviewer/);
  assert.ok(!line.includes("Demo same model reviewer"));
  assert.ok(!line.includes("Demo unknown reviewer"));
  assert.equal(firstDispatchable(reviewerTier(parsed, null, "L2")), null);
});

test("candidate switching and stale/invalid profiles are rechecked against live actual models", () => {
  const matrix = build();
  assert.ok(eligibleReviewers(matrix, "demo-alpha", "L2", profiles, fixture.pools).some(row => row.profile === "Demo same family reviewer"));
  for (const replacement of [{ model: "demo-alpha" }, { model: " DEMO-ALPHA " }, { model: "" }, { model: " " }, { model: null }, { role: "reader", candidateFor: null }]) {
    const live = profiles.map(profile => profile.name === "Demo same family reviewer" ? { ...profile, ...replacement } : profile);
    assert.ok(!eligibleReviewers(matrix, "demo-alpha", "L2", live, fixture.pools).some(row => row.profile === "Demo same family reviewer"));
    assert.ok(!reviewerTier(build(fixture.base, live), "demo-alpha", "L2").some(row => row.profile === "Demo same family reviewer"));
  }
  assert.ok(!eligibleReviewers(matrix, "demo-alpha", "L2", profiles.filter(row => row.name !== "Demo same family reviewer"), fixture.pools).some(row => row.profile === "Demo same family reviewer"));
  // The candidate became the actual executor: compare beta, not the main executor's alpha or family.
  assert.ok(!eligibleReviewers(matrix, "demo-beta", "L2", profiles, fixture.pools).some(row => row.profile === "Demo same family reviewer"));
  assert.ok(eligibleReviewers(matrix, "demo-beta", "L2", profiles, fixture.pools).some(row => row.profile === "Demo same model reviewer"));
  for (const model of [null, undefined, "", " ", "missing-model"]) assert.deepEqual(reviewerTier(matrix, model, "L2"), []);
});

test("model branches take precedence; legacy families merge tiers without hard exclusions", () => {
  const legacy: DispatchMatrix = { ...fixture.base, roles: { reviewer: { byExecutorFamily: {
    "demo-family-a": { L2: [{ profile: "Demo same model reviewer", effort: "high" }] },
    "demo-family-b": { L2: [{ profile: "Demo same family reviewer", effort: "high" }, { profile: "Demo same model reviewer", effort: "high" }] },
  } } } };
  assert.equal(legacyReviewerTiers(legacy.roles.reviewer).L2.length, 2);
  assert.deepEqual(reviewerTier(build(legacy), "demo-alpha", "L2").map(row => row.profile), ["Demo same family reviewer"]);
  for (const branch of [{}, { "demo-alpha": { L2: [] } }, null, []]) {
    const mixed = { ...legacy, roles: { reviewer: { ...legacy.roles.reviewer as object, byExecutorModel: branch } } };
    assert.deepEqual(reviewerTier(build(mixed), "demo-alpha", "L2"), []);
  }
  const exact = { ...legacy, roles: { reviewer: { byExecutorModel: { "demo-alpha": { L2: [] }, "demo-beta": { L2: [{ profile: "Demo ordinary reviewer", effort: "high" }] } } } } };
  assert.deepEqual(reviewerTier(build(exact), "demo-alpha", "L2"), []);
});

test("model eligibility preserves pause, quota, roles, provider bans and explicit tier limits", () => {
  const matrix = build();
  const preferred = "Demo same family reviewer";
  for (const pools of [{ ...fixture.pools, "demo-ready": { dispatchable: false, prefer: true } },
    { ...fixture.pools, "demo-ready": { dispatchable: true, prefer: true, onlyRoles: ["reader"] } }]) {
    assert.equal(eligibleReviewers(matrix, "demo-alpha", "L2", profiles, pools).find(row => row.profile === preferred)?.paused, true);
  }
  const live = profiles.map(profile => profile.name === preferred ? { ...profile, notes: "[Paused]" } : profile);
  assert.equal(eligibleReviewers(matrix, "demo-alpha", "L2", live, null).find(row => row.profile === preferred)?.paused, true);
  assert.deepEqual(eligibleReviewers(matrix, "demo-alpha", "L2", profiles, fixture.pools, ["demo-provider-a"]).map(row => row.profile), ["Demo ordinary reviewer", "Demo paused reviewer"]);
  // L4 permission is represented by the configured tier list, never inferred from a different model.
  const highRiskBase = structuredClone(fixture.base);
  highRiskBase.roles.reviewer.L4 = highRiskBase.roles.reviewer.L4.filter((row: { profile: string }) => row.profile !== "Demo ordinary reviewer");
  assert.ok(!reviewerTier(build(highRiskBase), "demo-alpha", "L4").some(row => row.profile === "Demo ordinary reviewer"));
  const paused = structuredClone(highRiskBase);
  paused.roles.reviewer.L4[0].paused = true;
  assert.equal(reviewerTier(build(paused), "demo-alpha", "L4")[0].paused, true);
});

test("Gemini uses all legal different-model reviewers while personal substitutes stay paused", async () => {
  const live: DispatchProfile[] = [
    { name: "Demo Gemini executor", role: "executor", model: "gemini-3.8-flash-medium", family: "google", provider: "antigravity", pool: "demo-google" },
    { name: "Demo GPT reviewer", role: "reviewer", model: "gpt-6.1-sol", family: "openai", provider: "codex", pool: "demo-gpt" },
    { name: "Demo Grok reviewer", role: "candidate", candidateFor: "reviewer", model: "grok-4.7", family: "xai", provider: "grok", pool: "demo-grok" },
    { name: "Demo paused high-risk reviewer", role: "personal", pausedCandidateFor: "reviewer", model: "demo-fable", family: "anthropic", pool: "demo-claude" },
  ];
  const tiers = ["L1", "L2", "L3", "L4"];
  const rows = (profile: string) => Object.fromEntries(tiers.map(tier => [tier,
    [{ profile, effort: tier === "L1" || tier === "L2" ? "xhigh" : "max" },
      ...(tier === "L4" ? [{ profile: live[3].name, effort: "xhigh" }] : [])]]));
  const base: DispatchMatrix = { ...fixture.base, roles: {
    executor: { L1: [{ profile: live[0].name, effort: null }], L2: [{ profile: live[0].name, effort: null }] },
    // Historical buckets are compatibility candidates, never an executor-family restriction.
    reviewer: { byExecutorFamily: { google: rows(live[1].name), openai: rows(live[2].name), xai: rows(live[1].name) } },
  } };
  const pools = { "demo-google": { dispatchable: true, prefer: false }, "demo-gpt": { dispatchable: true, prefer: true },
    "demo-grok": { dispatchable: true, prefer: false }, "demo-claude": { dispatchable: true, prefer: false } };
  const opts = { ...options, profiles: live, knownNames: new Set(live.map(row => row.name)), pools };
  const matrix = applyDispatchMatrix(base, opts);
  const parsed = ExportMatrix.parse(buildDispatchMatrixExport(matrix, "demo", new Date(now)));
  assert.deepEqual(parsed.roles.executor, base.roles.executor);
  assert.ok(!live.some(row => row.family === "google" && (row.role === "reviewer" || row.candidateFor === "reviewer")));
  for (const tier of tiers) {
    const candidates = reviewerTier(parsed, live[0].model, tier);
    assert.deepEqual(candidates.filter(row => !row.paused).map(row => row.profile), [live[1].name, live[2].name]);
    assert.equal(firstDispatchable(candidates)?.profile, live[1].name);
    const gptPaused = eligibleReviewers(parsed, live[0].model, tier, live, { ...pools, "demo-gpt": { dispatchable: false, prefer: true } });
    assert.equal(firstDispatchable(gptPaused)?.profile, live[2].name);
    const bothPaused = eligibleReviewers(parsed, live[0].model, tier, live, {
      ...pools, "demo-gpt": { dispatchable: false, prefer: true }, "demo-grok": { dispatchable: false, prefer: false },
    });
    assert.equal(firstDispatchable(bothPaused), null);
    const changed = live.map(row => row.name === live[2].name ? {
      ...row, model: live[0].model, family: "xai", provider: "demo-other-provider", thinkingOptionId: "high", modeId: "demo-other-mode",
    } : row);
    assert.ok(!eligibleReviewers(parsed, live[0].model, tier, changed, pools).some(row => row.profile === live[2].name));
    assert.ok(!reviewerTier(applyDispatchMatrix(base, { ...opts, profiles: changed }), live[0].model, tier).some(row => row.profile === live[2].name));
  }
  for (const model of [live[0].model, live[1].model, live[2].model]) {
    const paused = reviewerTier(parsed, model, "L4").find(row => row.profile === live[3].name);
    assert.equal(paused?.paused, true);
    assert.ok(firstDispatchable(reviewerTier(parsed, model, "L4"))?.profile !== live[3].name);
  }
  const page = await buildRolesPageView({ profiles: async () => live, pools: async () => pools, runsSince: () => [], baseMatrix: async () => base }, now);
  const line = page.cards.find(card => card.key === "reviewer")!.orderLines.find(row => row.includes(live[0].model!))!;
  assert.match(line, /Demo GPT reviewer/);
});

test("doctor and model-swap warnings compare actual models even across companies", async () => {
  const raw = [fixture.profiles[0], fixture.profiles[1]];
  const verdict = (reviewer: object) => checkProfiles({ profiles: parseProfiles({ daemon: { agentProfiles: [raw[0], reviewer] } }), models: {}, providers: null, disabledPools: [] }).findings.find(row => row.key === "profiles:model")!.status;
  assert.equal(verdict(raw[1]), "green");
  assert.equal(verdict({ ...raw[1], model: "demo-alpha", family: "other" }), "red");
  assert.equal(verdict({ ...raw[1], model: "" }), "red");
  const page = await buildRolesPageView({ profiles: async () => profiles, pools: async () => fixture.pools, runsSince: () => [], baseMatrix: async () => fixture.base }, now);
  assert.deepEqual(modelConflicts(page.cards, "executor", "Demo executor", "demo-gamma-unlisted"), []);
  assert.ok(modelConflicts(page.cards, "executor", "Demo executor", "demo-alpha").some(line => line.includes("Demo same model reviewer")));
  assert.equal(differentReviewModels("demo-alpha", "demo-beta"), true);
});
