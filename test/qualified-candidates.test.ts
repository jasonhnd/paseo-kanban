import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import * as policy from "../shared/fleet/executor-effort";
import { parseConfig } from "../server/config";

const tiers = ["L1", "L2", "L3", "L4"] as const;
const roles = ["executor", "reviewer", "reader", "decision", "batch", "ops_vercel", "ops_cloudflare", "ops_github", "ops_notion"];
const ranks = ["low", "medium", "high", "xhigh", "max"];
// Namespace lookup lets the red run report the missing API as an assertion.
const candidates = (input: Record<string, unknown>, config?: unknown): Array<{ provider: string; model: string; effort: string }> => {
  assert.equal(typeof policy.qualifiedCandidates, "function", "qualification API must exist");
  return policy.qualifiedCandidates(input as never, config as never);
};
const sol = (list: ReturnType<typeof candidates>) => list.filter(row => row.model === "gpt-6.1-sol").map(row => row.effort);

for (const role of roles) for (const tier of tiers) {
  it(`qualifies ${role}/${tier} in increasing depth order without implicit max`, () => {
    const list = candidates({ role, tier, cardType: role.startsWith("ops_") ? "ops" : "code", reworkCount: 0 });
    assert.ok(list.length > 0);
    assert.ok(list.every(row => row.provider !== "cursor" && row.effort !== "max"));
    assert.deepEqual(list.map(row => ranks.indexOf(row.effort)), list.map(row => ranks.indexOf(row.effort)).sort((a, b) => a - b));
    assert.equal(new Set(list.map(row => JSON.stringify(row))).size, list.length);
    if (role.startsWith("ops_")) assert.ok(list.every(row => row.effort === "low"));
    else if (["L3", "L4"].includes(tier)) assert.ok(list.every(row => ranks.indexOf(row.effort) >= 2));
    if (tier === "L4" && role === "executor") assert.deepEqual(list, [
      { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
      { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    ]);
  });
}

it("starts light batch at low with both Luna and Grok, without a quota preference", () => {
  const list = candidates({ role: "batch", tier: "L1", cardType: "batch", reworkCount: 0 });
  assert.ok(list.some(row => row.model === "gpt-6-luna" && row.effort === "low"));
  assert.ok(list.some(row => row.provider === "grok" && row.effort === "low"));
});

it("raises the qualified starting depth once per return and caps without max", () => {
  const query = { role: "executor", tier: "L4", cardType: "code" };
  assert.deepEqual(sol(candidates({ ...query, reworkCount: 0 })), ["high", "xhigh"]);
  for (const reworkCount of [1, 2, 100, Number.MAX_SAFE_INTEGER]) assert.deepEqual(sol(candidates({ ...query, reworkCount })), ["xhigh"]);
  const small = { role: "batch", tier: "L1", cardType: "batch" };
  assert.equal(candidates({ ...small, reworkCount: 0 }).find(row => row.model === "gpt-6-luna")?.effort, "low");
  assert.equal(candidates({ ...small, reworkCount: 1 }).find(row => row.model === "gpt-6-luna")?.effort, "medium");
  assert.equal(candidates({ ...small, reworkCount: 2 }).find(row => row.model === "gpt-6-luna")?.effort, "high");
  assert.equal(candidates({ ...small, reworkCount: 20 }).find(row => row.model === "gpt-6-luna")?.effort, "high");
});

it("admits max only as a card request; explicit lower effort cannot cross the quality floor", () => {
  const query = { role: "executor", tier: "L4", cardType: "code", reworkCount: 0 };
  assert.deepEqual(sol(candidates({ ...query, explicitEffort: "max" })), ["max"]);
  assert.deepEqual(sol(candidates({ ...query, explicitEffort: "medium" })), ["high", "xhigh"]);
  assert.deepEqual(sol(candidates({ ...query, reworkCount: 10, explicitEffort: "high" })), ["xhigh"]);
  assert.deepEqual(candidates({ ...query, explicitEffort: "ultra" }), []);
});

it("keeps every operational type light and low even for L4, explicit max and repeated rework", () => {
  for (const role of ["executor", "batch"]) {
    for (const cardType of ["ops", "deploy", "wait", "data-move", "release-rehearsal", "maintenance"]) {
      const list = candidates({ role, tier: "L4", cardType, reworkCount: 40, explicitEffort: "max" });
      assert.ok(list.length > 0);
      assert.ok(list.every(row => row.effort === "low" && (row.model === "gpt-6-luna" || row.provider === "grok")));
    }
  }
  assert.ok(candidates({ role: "reviewer", tier: "L4", cardType: "ops", reworkCount: 0 }).every(row => row.effort === "high" || row.effort === "xhigh"));
});

it("replaces individual cells with global then project policy; empty cells stay closed", () => {
  const query = { role: "batch", tier: "L1", cardType: "batch", reworkCount: 0 };
  const rule = { provider: "grok", model: "demo-grok", efforts: ["low", "high"] };
  const global = { batch: { L1: [rule] } };
  assert.deepEqual(candidates(query, { global }), [
    { provider: "grok", model: "demo-grok", effort: "low" }, { provider: "grok", model: "demo-grok", effort: "high" },
  ]);
  assert.deepEqual(candidates({ ...query, reworkCount: 1 }, { global }), [{ provider: "grok", model: "demo-grok", effort: "high" }]);
  assert.deepEqual(candidates(query, { global, project: { batch: { L1: [] } } }), []);
  assert.ok(candidates({ ...query, tier: "L2" }, { global }).length > 0);
});

it("does not let overrides bypass Cursor, high-tier or operations invariants", () => {
  const global = { executor: { L4: [
    { provider: "cursor", model: "gpt-6.1-sol", efforts: ["high"] },
    { provider: "codex", model: "gpt-6.1-sol", efforts: ["low", "high", "xhigh"] },
  ] }, ops: { L4: [{ provider: "codex", model: "gpt-6.1-sol", efforts: ["low"] }] } };
  const list = candidates({ role: "executor", tier: "L4", cardType: "code", reworkCount: 0 }, { global });
  assert.deepEqual(sol(list), ["high", "xhigh"]);
  assert.ok(list.every(row => row.provider !== "cursor"));
  assert.deepEqual(candidates({ role: "executor", tier: "L4", cardType: "ops", reworkCount: 0 }, { global }), []);
});

it("fails closed on unknown role, tier, depth or malformed rework count", () => {
  const query = { role: "executor", tier: "L4", cardType: "code", reworkCount: 0 };
  for (const patch of [{ role: "supervisor" }, { tier: "L5" }, { explicitEffort: "ultra" }, { reworkCount: -1 }, { reworkCount: 0.5 }, { reworkCount: Infinity }, { reworkCount: NaN }]) {
    assert.deepEqual(candidates({ ...query, ...patch }), []);
  }
});

it("parses global and project qualification settings and rejects unsafe configuration shapes", () => {
  const qualification = { executor: { L4: [{ provider: "codex", model: "gpt-6.1-sol", efforts: ["high"], allowExplicitMax: true }] } };
  const config = parseConfig({ qualification, projects: { demo: { defaultWorkspace: "dir", qualification: { executor: { L4: [] } } } } });
  assert.deepEqual(config.qualification, qualification);
  assert.deepEqual(config.projects?.demo.qualification, { executor: { L4: [] } });
  assert.throws(() => parseConfig({ qualification: { executor: { L4: [{ provider: "codex", model: "gpt-6.1-sol", efforts: ["max"] }] } } }));
  assert.throws(() => parseConfig({ projects: { demo: { defaultWorkspace: "dir", qualification: { executor: { L4: "bad" } } } } }));
});

it("ships an example matching the built-in quality table", () => {
  const example = JSON.parse(readFileSync(new URL("../examples/qualification.example.json", import.meta.url), "utf8"));
  assert.deepEqual(example, policy.DEFAULT_QUALIFICATION);
});

it("merges repeated model rows before rework so a shorter row cannot lower the cap", () => {
  const global = { batch: { L1: [
    { provider: "grok", model: "demo-grok", efforts: ["low", "medium", "high"] },
    { provider: "grok", model: "demo-grok", efforts: ["low"] },
  ] } };
  assert.deepEqual(candidates({ role: "batch", tier: "L1", cardType: "batch", reworkCount: 2 }, { global }), [
    { provider: "grok", model: "demo-grok", effort: "high" },
  ]);
});

it("accepts a project quality override without unrelated workspace settings", () => {
  const config = parseConfig({ projects: { demo: { qualification: { executor: { L4: [] } } } } });
  assert.deepEqual(config.projects?.demo.qualification, { executor: { L4: [] } });
  assert.throws(() => parseConfig({ projects: { demo: { qualification: { executor: { L4: "bad" } } } } }));
});


it("uses exact current Grok/Claude ids and retains high-risk Fable review", () => {
  const all = roles.flatMap(role => tiers.flatMap(tier => candidates({ role, tier, cardType: "code", reworkCount: 0 })));
  const grok = all.filter(row => row.provider === "grok");
  assert.ok(grok.length > 0);
  assert.ok(grok.every(row => row.model === "grok-4.7"));
  assert.ok(all.every(row => !row.model.includes("build-fast")));
  const claude = all.filter(row => row.provider === "claude");
  for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]) assert.ok(claude.some(row => row.model === model), model);
  assert.ok(claude.every(row => !["sonnet", "opus"].includes(row.model)));
  assert.ok(candidates({ role: "reviewer", tier: "L4", cardType: "review", reworkCount: 0 })
    .some(row => row.provider === "claude" && row.model === "claude-fable-5-1" && row.effort === "high"));
  assert.deepEqual(candidates({ role: "batch", tier: "L1", cardType: "batch", reworkCount: 0 }, {
    global: { batch: { L1: [{ provider: "grok", model: "grok-4.7-build-fast", efforts: ["low"] }] } },
  }), []);
});

it("intersects defaults with anonymous configured-profile identities", () => {
  // Anonymous role/provider/model facts checked against the local roster; no live reads in tests.
  const profiles = [
    { role: "executor", provider: "grok", model: "grok-4.7", tiers: ["L1", "L2"] },
    { role: "executor", provider: "claude", model: "claude-sonnet-5-5", tiers: ["L1", "L2", "L3"] },
    { role: "executor", provider: "claude", model: "claude-opus-5-5", tiers: ["L3"] },
    { role: "reviewer", provider: "grok", model: "grok-4.7", tiers },
    { role: "reviewer", provider: "claude", model: "claude-fable-5-1", tiers: ["L4"] },
    { role: "reader", provider: "grok", model: "grok-4.7", tiers },
    { role: "reader", provider: "claude", model: "claude-sonnet-5-5[1m]", tiers },
    { role: "decision", provider: "grok", model: "grok-4.7", tiers },
    { role: "decision", provider: "claude", model: "claude-fable-5-1", tiers },
    { role: "batch", provider: "grok", model: "grok-4.7", tiers },
    ...roles.filter(role => role.startsWith("ops_")).map(role => ({ role, provider: "claude", model: "claude-sonnet-5-5", tiers })),
  ];
  for (const profile of profiles) for (const tier of profile.tiers) {
    const found = candidates({ role: profile.role, tier, cardType: "code", reworkCount: 0 })
      .filter(row => row.provider === profile.provider && row.model === profile.model);
    assert.ok(found.length > 0, `${profile.role}/${tier}/${profile.model} must survive exact intersection`);
  }
});

it("keeps dedicated operations profiles at low without the light-executor model restriction", () => {
  for (const role of roles.filter(role => role.startsWith("ops_"))) for (const tier of tiers) {
    const query = { role, tier, cardType: "ops", reworkCount: 20, explicitEffort: "max" };
    assert.deepEqual(candidates(query), [{ provider: "claude", model: "claude-sonnet-5-5", effort: "low" }]);
    const project = { [role]: { [tier]: [{ provider: "claude", model: "demo-ops-model", efforts: ["low", "high", "xhigh"], allowExplicitMax: true }] } };
    assert.deepEqual(candidates(query, { project }), [{ provider: "claude", model: "demo-ops-model", effort: "low" }]);
  }
});

it("advances explicit non-max starting depths on every new-agent rework", () => {
  const query = { role: "executor", tier: "L2", cardType: "code" };
  const checks = [
    ["low", 0, ["medium", "high", "xhigh"]], ["medium", 1, ["high", "xhigh"]],
    ["high", 0, ["high", "xhigh"]], ["high", 1, ["xhigh"]], ["high", 20, ["xhigh"]],
    ["xhigh", 20, ["xhigh"]], ["max", 20, ["max"]],
  ] as const;
  for (const [explicitEffort, reworkCount, expected] of checks) assert.deepEqual(sol(candidates({ ...query, explicitEffort, reworkCount })), expected);
  assert.ok(!candidates({ ...query, explicitEffort: "high", reworkCount: 100 }).some(row => row.effort === "max"));
});

it("resolves specific operations cells before generic ops fallback across configuration levels", () => {
  const query = { role: "ops_vercel", tier: "L4", cardType: "ops", reworkCount: 3 };
  const row = (model: string) => [{ provider: "claude", model, efforts: ["low"] }];
  const project = { ops: { L4: row("demo-generic") } };
  const global = { ops_vercel: { L4: row("demo-specific") } };
  assert.deepEqual(candidates(query, { project, global }), [{ provider: "claude", model: "demo-specific", effort: "low" }]);
  assert.deepEqual(candidates(query, { project }), [{ provider: "claude", model: "claude-sonnet-5-5", effort: "low" }]);
  assert.deepEqual(candidates(query, { project: { ...project, ops_vercel: { L4: row("demo-project-specific") } }, global }), [{ provider: "claude", model: "demo-project-specific", effort: "low" }]);
  assert.deepEqual(candidates(query, { project, global: { ops_vercel: { L4: [] } } }), []);
});
