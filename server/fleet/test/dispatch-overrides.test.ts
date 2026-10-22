import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyDispatchMatrix, firstDispatchable, type MatrixEntry, type DispatchMatrix, type DispatchProfile, type ReviewerModelMatrix } from "../../../shared/fleet/dispatch";
import { MatrixEntry as ContractMatrixEntry } from "../../../shared/contract/schema";
import { dispatchOverridesSchema, dispatchSettingRows } from "../../../shared/fleet/dispatch-overrides";
import { readThinkingCatalog } from "../dispatch-settings";
import { orderLines } from "../../../shared/fleet/roles-page";

const base: DispatchMatrix = JSON.parse(readFileSync(new URL("../../../shared/fleet/default-dispatch.example.json", import.meta.url), "utf8"));
function slots(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(row => typeof row.profile === "string" ? [row.profile] : slots(row));
  return node && typeof node === "object" ? Object.values(node).flatMap(slots) : [];
}
export const demoProfiles: DispatchProfile[] = [...new Set(slots(base.roles))].map(slot => ({
  name: `Demo ${slot}`, dispatchId: slot, role: slot.split(".")[0], provider: slot.includes("gpt") ? "codex" : "demo", model: slot.includes("gpt-6-luna") ? "gpt-6-luna" : slot === "reviewer.gpt-6-sol" ? "gpt-6-sol" : slot.includes("gpt") ? "gpt-6.1-sol" : `demo-${slot}`,
}));
export const demoThinking = Object.fromEntries(demoProfiles.map(profile => [profile.name, ["low", "medium", "high", "xhigh", "ultra"]]));
export const migrationOverrides = {
  executor: { L1: { "executor.gpt-6.1-sol": { effort: "medium" } }, L2: { "executor.gpt-6.1-sol": { effort: "high" } }, L3: { "executor.gpt-6.1-sol": { effort: "xhigh" } }, L4: { "executor.gpt-6.1-sol": { effort: "xhigh" } } },
  reviewer: { L1: { "reviewer.gpt-6.1-sol": { effort: "high" } }, L2: { "reviewer.gpt-6.1-sol": { effort: "xhigh" } }, L3: { "reviewer.gpt-6.1-sol": { effort: "xhigh" } }, L4: { "reviewer.gpt-6.1-sol": { effort: "xhigh" } } },
};
const options = { profiles: demoProfiles, knownNames: new Set(demoProfiles.map(profile => profile.name)), pools: null, generatedAt: "2030-01-01T00:00:00Z", thinkingCatalog: demoThinking };
const build = (dispatchOverrides?: unknown, onOverrideWarning?: (message: string) => void) => applyDispatchMatrix(base, { ...options, dispatchOverrides, onOverrideWarning });

test("no overrides reproduce the shipped defaults and do not mutate the input", () => {
  const expected = JSON.parse(JSON.stringify(base));
  const rename = (node: unknown): unknown => Array.isArray(node) ? node.map(row => ({ ...row, profile: `Demo ${row.profile}` }))
    : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).map(([key, value]) => [key, rename(value)])) : node;
  expected.generatedAt = options.generatedAt;
  expected.roles = rename(expected.roles);
  const { reviewer: _raw, ...otherDefaults } = expected.roles;
  const { reviewer, ...otherActual } = build().roles;
  assert.deepEqual(otherActual, otherDefaults);
  assert.deepEqual(build({}), build());
  assert.deepEqual((reviewer as ReviewerModelMatrix).byExecutorModel["gpt-6.1-sol"].L4.map(row => row.profile), ["Demo reviewer.gpt-6-luna", "Demo reviewer.fable", "Demo reviewer.grok", "Demo reviewer.gpt-6-sol"]);
  assert.equal((reviewer as ReviewerModelMatrix).byExecutorModel["gpt-6-sol"].L4.some(row => row.profile === "Demo reviewer.gpt-6-sol"), false);
  assert.equal(base.generatedAt, undefined);
  const executor = base.roles.executor as Record<string, Array<{ effort: string }>>;
  assert.deepEqual([executor.L1[0].effort, executor.L2[0].effort, executor.L3[0].effort], ["medium", "medium", "high"]);
});

test("migration restores elevated efforts in every eligible reviewer model branch", () => {
  const matrix = build(migrationOverrides);
  const executor = matrix.roles.executor as Record<string, Array<{ profile: string; effort: string }>>;
  for (const [tier, effort] of Object.entries({ L1: "medium", L2: "high", L3: "xhigh", L4: "xhigh" })) {
    assert.equal(executor[tier].find(row => row.profile === "Demo executor.gpt-6.1-sol")?.effort, effort);
  }
  const reviewer = matrix.roles.reviewer as ReviewerModelMatrix;
  for (const model of ["demo-executor", "demo-executor.sonnet"]) for (const tier of ["L1", "L2", "L3", "L4"]) {
    assert.equal(reviewer.byExecutorModel[model][tier].find(row => row.profile === "Demo reviewer.gpt-6.1-sol")?.effort, tier === "L1" ? "high" : "xhigh");
  }
  assert.deepEqual(reviewer.byExecutorModel["gpt-6.1-sol"], (build().roles.reviewer as typeof reviewer).byExecutorModel["gpt-6.1-sol"]);
});

test("bad entries are isolated, unsupported efforts warn, and GPT ultra cannot be enabled", () => {
  const warnings: string[] = [];
  const result = build({ ...migrationOverrides, executor: { ...migrationOverrides.executor, L1: {
    "executor.gpt-6.1-sol": { effort: "ultra", order: 2 }, "executor.sonnet": { effort: "future" }, "missing.slot": { effort: "high" }, "executor": { order: -1 },
  }, L5: {}, L3: "invalid" }, unknown: {} }, value => warnings.push(value));
  const executor = result.roles.executor as Record<string, Array<{ profile: string; effort: string }>>;
  assert.equal(executor.L1.find(row => row.profile === "Demo executor.gpt-6.1-sol")?.effort, "medium");
  assert.equal(executor.L1.find(row => row.profile === "Demo executor.sonnet")?.effort, "low");
  assert.equal(executor.L2[0].effort, "high");
  assert.equal(warnings.length, 7);
  assert.deepEqual(result.roles.reviewer, build(migrationOverrides).roles.reviewer);
});

test("catalog extensions outside the matrix contract cannot enter exports or settings choices", () => {
  const catalog = Object.fromEntries(demoProfiles.map(profile => [profile.name, ["low", "medium", "high", "xhigh", "max", "ultra", "future-depth"]]));
  const warnings: string[] = [];
  const matrix = applyDispatchMatrix(base, { ...options, thinkingCatalog: catalog,
    dispatchOverrides: { executor: { L1: { "executor.sonnet": { effort: "future-depth", order: 1 } } } },
    onOverrideWarning: message => warnings.push(message) });
  const list = (matrix.roles.executor as Record<string, Array<{ profile: string; effort: string }>>).L1;
  assert.equal(list[0].profile, "Demo executor.sonnet");
  assert.equal(list[0].effort, "low");
  assert.deepEqual(matrix.roles.reviewer, build().roles.reviewer);
  assert.ok(!JSON.stringify(matrix).includes("future-depth"));
  assert.match(warnings[0], /Ignoring dispatch effort executor\/L1\/executor.sonnet: unsupported thinking option/);
  const rows = dispatchSettingRows(base, demoProfiles, catalog);
  assert.ok(rows.every(row => !row.supportedEfforts.includes("future-depth") && !row.supportedEfforts.includes("ultra")));
  assert.ok(rows.every(row => row.supportedEfforts.includes("max")));
});

test("explicit order wins over quota ordering and wildcard role displays use tier lists with fallback", () => {
  const overrides = { executor: { L1: { "executor.sonnet": { order: 1 } } }, reader: { L2: { "reader.gpt-6.1-sol": { effort: null, order: 1 } } } };
  assert.equal((build(overrides).roles.executor as Record<string, Array<{ profile: string }>>).L1[0].profile, "Demo executor.sonnet");
  const reader = build(overrides).roles.reader as Record<string, Array<{ profile: string; effort: string | null }>>;
  assert.equal(reader.L2[0].profile, "Demo reader.gpt-6.1-sol");
  assert.equal(reader.L2[0].effort, null);
  const display = orderLines("reader", build(overrides), 3).join(" ");
  assert.match(display, /L1 Demo reader · L2 Demo reader.gpt-6.1-sol · L3 Demo reader · L4 Demo reader/);
  const profiles = demoProfiles.map(profile => ({ ...profile, pool: profile.dispatchId === "executor.gpt-6.1-sol" ? "demo-preferred" : "demo-other" }));
  const matrix = applyDispatchMatrix(base, { ...options, profiles, dispatchOverrides: overrides, pools: { "demo-preferred": { dispatchable: true, prefer: true }, "demo-other": { dispatchable: true, prefer: false } } });
  assert.equal((matrix.roles.executor as Record<string, Array<{ profile: string }>>).L1[0].profile, "Demo executor.sonnet");
});

test("partial reader, decision and batch overrides display all four effective difficulty lists", () => {
  for (const role of ["reader", "decision", "batch"] as const) {
    const slot = `${role}.gpt-6.1-sol`;
    const matrix = build({ [role]: { L2: { [slot]: { effort: "high", order: 1 } } } });
    const display = orderLines(role, matrix, 3).join(" ");
    for (const tier of ["L1", "L2", "L3", "L4"]) {
      assert.ok(display.includes(`${tier} Demo ${tier === "L2" ? slot : role}`), display);
    }
  }
  const matrix = build({ reader: { L2: { "reader.gpt-6.1-sol": { order: 1 } } } });
  (matrix.roles.reader as Record<string, unknown>).L2 = [];
  const display = orderLines("reader", matrix, 3).join(" ");
  assert.ok(display.includes("L1 Demo reader"));
  assert.ok(!display.includes("L2 Demo reader"));
});

test("unresolved slots and slots outside a role cannot alter its defaults", () => {
  const warnings: string[] = [];
  const matrix = build({ executor: { L1: { reviewer: { effort: "high", order: 1 } } } }, message => warnings.push(message));
  assert.deepEqual(matrix, build());
  assert.match(warnings[0], /absent from the default role/);
  const profiles = demoProfiles.filter(profile => profile.dispatchId !== "executor.sonnet");
  const unresolved = applyDispatchMatrix(base, { ...options, profiles, dispatchOverrides: { executor: { L1: { "executor.sonnet": { effort: "high" } } } }, onOverrideWarning: message => warnings.push(message) });
  assert.ok(!JSON.stringify(unresolved).includes("Demo executor.sonnet"));
  assert.match(warnings[1], /unresolved slot/);
});

test("schema rejects malformed writes and UI rows retain direct tier defaults", () => {
  assert.equal(dispatchOverridesSchema.safeParse(migrationOverrides).success, true);
  for (const value of [null, { executor: { L5: {} } }, { executor: { L1: { executor: {} } } }, { executor: { L1: { executor: { order: 0 } } } }]) assert.equal(dispatchOverridesSchema.safeParse(value).success, false);
  const rows = dispatchSettingRows(base, demoProfiles, demoThinking);
  const reviewer = rows.find(row => row.role === "reviewer" && row.tier === "L1" && row.slot === "reviewer.gpt-6.1-sol");
  assert.equal(reviewer?.defaults.length, 1);
  assert.ok(!reviewer?.supportedEfforts.includes("ultra"));
  assert.equal(rows.filter(row => row.role === "reader").length, 12);
});

test("public catalog projection handles different models and unknown options without reading config", async () => {
  const calls: string[] = [];
  const result = await readThinkingCatalog(demoProfiles, async provider => { calls.push(provider); return provider === "codex" ? [{ id: "gpt-6.1-sol", thinkingOptionIds: ["high", "xhigh"] }] : [{ id: "demo-model" }]; });
  assert.deepEqual(calls.sort(), ["codex", "demo"]);
  assert.deepEqual(result["Demo executor.gpt-6.1-sol"], ["high", "xhigh"]);
  assert.equal(result["Demo executor.sonnet"], undefined);
});

test("unknown capabilities retain default efforts while valid order edits survive, including inherited GPT ultra", () => {
  const warnings: string[] = [];
  const overrides = { executor: { L1: { "executor.gpt-6.1-sol": { effort: "high", order: 3 } } } };
  const unknown = applyDispatchMatrix(base, { ...options, thinkingCatalog: {}, dispatchOverrides: overrides, onOverrideWarning: message => warnings.push(message) });
  const list = (unknown.roles.executor as Record<string, Array<{ profile: string; effort: string }>>).L1;
  assert.equal(list.find(row => row.profile === "Demo executor.gpt-6.1-sol")?.effort, "medium");
  assert.equal(list[0].profile, "Demo executor.gpt-6.1-sol");
  assert.equal(list[1].profile, "Demo executor.gpt-6-luna");
  assert.match(warnings[0], /unsupported thinking option/);
  const profiles = demoProfiles.map(profile => ({ ...profile, thinkingOptionId: "ultra" }));
  assert.deepEqual(applyDispatchMatrix(base, { ...options, profiles, dispatchOverrides: { executor: { L1: { "executor.gpt-6.1-sol": { effort: null } } } } }), build());
  const subset = { ...base, roles: { executor: base.roles.executor } };
  assert.deepEqual(applyDispatchMatrix(subset, { ...options, dispatchOverrides: { reader: { L1: { reader: { order: 1 } } } } }), applyDispatchMatrix(subset, options));
});

test("legacy elevated overrides retain common profile efforts while capability defaults change order and add Luna", () => {
  // Snapshot of the elevated defaults in main at 416de178, kept exclusively for migration verification.
  const previous: DispatchMatrix = JSON.parse(readFileSync(new URL("fixtures/previous-main-defaults.json", import.meta.url), "utf8"));
  const expected = applyDispatchMatrix(previous, options);
  const actual = build(migrationOverrides);
  for (const role of ["executor", "reader", "decision", "batch"]) {
    const oldLists = expected.roles[role] as Record<string, MatrixEntry[]>;
    const newLists = actual.roles[role] as Record<string, MatrixEntry[]>;
    for (const [tier, rows] of Object.entries(oldLists)) for (const row of rows) {
      assert.equal(newLists[tier].find(next => next.profile === row.profile)?.effort, row.effort, `${role}/${tier}/${row.profile}`);
    }
  }
  const reviewer = actual.roles.reviewer as ReviewerModelMatrix;
  for (const [model, tiers] of Object.entries(reviewer.byExecutorModel)) for (const tier of ["L1", "L2", "L3", "L4"]) {
    const row = tiers[tier]?.find(entry => entry.profile === "Demo reviewer.gpt-6-sol");
    if (model === "gpt-6-sol") assert.equal(row, undefined);
    else assert.equal(row?.effort, "high");
  }
});

test("explicit reviewer order survives pool priority without bypassing quota pauses or model boundaries", () => {
  const profiles = demoProfiles.map(profile => ({ ...profile, role: "candidate", candidateFor: "reviewer", pool: profile.dispatchId }));
  const pools = Object.fromEntries(profiles.map(profile => [profile.pool!, {
    dispatchable: true, prefer: profile.dispatchId !== "reviewer.fable", deprioritize: profile.dispatchId === "reviewer.fable",
    priorityIndex: profile.dispatchId === "reviewer.fable" ? 9 : 0,
  }]));
  const dispatchOverrides = { reviewer: { L4: { "reviewer.fable": { order: 1 } } } };
  const run = (flags = pools) => applyDispatchMatrix(base, { ...options, profiles, pools: flags, dispatchOverrides });
  const reviewerLists = (matrix: DispatchMatrix) =>
    (matrix.roles.reviewer as ReviewerModelMatrix).byExecutorModel;
  for (const model of ["gpt-6.1-sol", "demo-executor"]) {
    const list = reviewerLists(run())[model].L4;
    assert.equal(list[0].profile, "Demo reviewer.fable");
    assert.equal(list[0].order, 1);
    assert.deepEqual(ContractMatrixEntry.parse(list[0]), list[0]);
    const paused = reviewerLists(run({ ...pools, "reviewer.fable": { ...pools["reviewer.fable"], dispatchable: false } }))[model].L4;
    assert.equal(paused[0].paused, true);
    assert.notEqual(firstDispatchable(paused)?.profile, "Demo reviewer.fable");
  }
  assert.ok(!reviewerLists(run())["demo-reviewer.fable"].L4.some(row => row.profile === "Demo reviewer.fable"));
  const restricted = applyDispatchMatrix(base, { ...options, profiles, dispatchOverrides,
    pools: { ...pools, "reviewer.fable": { ...pools["reviewer.fable"], onlyRoles: ["reader"] } } });
  assert.equal(reviewerLists(restricted)["gpt-6.1-sol"].L4[0].paused, true);
  const banned = applyDispatchMatrix(base, { ...options, profiles: profiles.map(profile => ({ ...profile,
    provider: profile.dispatchId === "reviewer.fable" ? "demo-blocked" : profile.provider })), pools, dispatchOverrides, bannedProviders: ["demo-blocked"] });
  assert.ok(!reviewerLists(banned)["gpt-6.1-sol"].L4.some(row => row.profile === "Demo reviewer.fable"));
});

test("explicit positions sort before implicit positions, keep stable ties, and do not promote effort-only overrides", () => {
  const overrides = { executor: { L1: {
    "executor.sonnet": { order: 1000 }, executor: { order: 1000 }, "executor.gpt-6.1-sol": { effort: "high" },
  } } };
  const list = (build(overrides).roles.executor as Record<string, MatrixEntry[]>).L1;
  assert.deepEqual(list.slice(0, 2).map(row => row.profile), ["Demo executor.sonnet", "Demo executor"]);
  assert.equal(list[2].profile, "Demo executor.gpt-6-luna");
  assert.equal(list[3].profile, "Demo executor.gpt-6.1-sol");
  assert.equal(list[2].order, undefined);
  const reversed = build({ executor: { L1: { "executor.sonnet": { order: 20 }, executor: { order: 10 } } } });
  assert.equal((reversed.roles.executor as Record<string, MatrixEntry[]>).L1[0].profile, "Demo executor");
  for (const order of [0, -1, 1.5, 1001, "1"]) assert.equal(ContractMatrixEntry.safeParse({ profile: "Demo", effort: null, order }).success, false);
});

test("disabled or unknown providers stay quiet while other catalog failures still warn", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    const profiles = [
      { name: "Disabled", provider: "antigravity", model: "flash" },
      { name: "Also disabled", provider: "gemini", model: "flash" },
      { name: "Unknown", provider: "missing", model: "none" },
      { name: "Broken", provider: "codex", model: "gpt" },
    ];
    const result = await readThinkingCatalog(profiles, async (provider) => {
      if (provider === "antigravity") throw new Error("paseo provider: Failed to fetch models for antigravity: Provider antigravity is disabled");
      if (provider === "gemini") throw new Error("paseo provider: Failed to fetch models for gemini: Provider gemini is disabled");
      if (provider === "missing") throw new Error("paseo provider: Failed to fetch models for missing: Unknown provider: missing");
      throw new Error("paseo provider: connection reset");
    });
    assert.deepEqual(result, {});
    assert.deepEqual(warnings, ["[afc] dispatch overrides: Thinking options unavailable for provider codex"]);
  } finally {
    console.warn = original;
  }
});
