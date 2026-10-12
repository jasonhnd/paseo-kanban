import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { EXPORTS } from "../../../shared/contract/schema";
import { profilePaused, reviewerTier, type DispatchProfile } from "../../../shared/fleet/dispatch";
import { boardUsageRpc, type UsagePlan } from "../../../shared/fleet/usage";

const root = await mkdtemp(join(tmpdir(), "plan-role-limits-"));
const data = join(join(root, "data"), "fleet");
const home = join(root, "home");
const plugin = join(root, "plugin");
const now = Date.parse("2030-06-04T12:00:00Z");
const roles = ["reviewer", "executor", "batch", "reader", "decision", "supervisor", "other"];
const profiles: DispatchProfile[] = [
  ...roles.map(role => ({ name: `Demo ${role}`, role, model: role === "reviewer" ? "demo-review" : "demo-work", provider: "demo-provider", pool: "demo-pool" })),
  { name: "Demo review candidate", role: "candidate", candidateFor: "reviewer", model: "demo-review-candidate", provider: "demo-provider", pool: "demo-pool" },
  { name: "Demo work candidate", role: "candidate", candidateFor: "executor", provider: "demo-provider", pool: "demo-pool" },
  { name: "Demo without role", provider: "demo-provider", pool: "demo-pool" },
];
const rawPlan = {
  id: "demo-pool", name: "Demo pool", adapter: "grok-cli", providers: ["demo-provider"],
  usageProvider: "demo-provider", priceUsdMonthly: null, dispatch: true, cliRead: false,
  pacePause: false, onlyRoles: ["reviewer"], tempException: "Demo review-only authorization",
};
const providerWindow = { id: "weekly", label: "Weekly", usedPct: 30, resetsAt: "2030-06-08T00:00:00Z" };
const host = { providers: { listUsage: async () => ({ providers: [{ providerId: "demo-provider", windows: [providerWindow], balances: [] }] }) } } as never;
let usage: typeof import("../usage");
let pools: typeof import("../pools-status");
let dispatch: typeof import("../dispatch");
let clearCache: typeof import("../util").clearCache;

before(async () => {
  mock.timers.enable({ apis: ["Date"], now });
  Object.assign(process.env, {
    HOME: home, PASEO_HOME: join(home, "paseo"), PASEO_URL: "ws://127.0.0.1:1",
    KANBAN_DATA_DIR: join(data, ".."),
    AFC_TRANSCRIPT_HOME: join(root, "transcripts"), KANBAN_HOME: plugin, AFC_LANGUAGE: "en",
  });
  process.env.KANBAN_PASEO_CONFIG = join(process.env.PASEO_HOME!, "config.json");

  await Promise.all([data, process.env.PASEO_HOME!, join(plugin, "shared", "fleet")].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(join(process.env.PASEO_HOME!, "config.json"), JSON.stringify({ daemon: { agentProfiles: profiles } }));
  const baseRoles = Object.fromEntries(roles.slice(0, 5).map(role => [role, { L2: profiles.filter(p => p.role === role || p.candidateFor === role).map(p => ({ profile: p.name, effort: null })) }]));
  await writeFile(join(plugin, "shared/fleet/default-dispatch.example.json"), JSON.stringify({ version: 1, defaultTier: "L2", roles: baseRoles, downgradeWhenTight: [] }));
  usage = await import("../usage");
  pools = await import("../pools-status");
  dispatch = await import("../dispatch");
  ({ clearCache } = await import("../util"));
});
after(async () => { mock.timers.reset(); await rm(root, { recursive: true, force: true }); });

async function assemble(changes: Record<string, unknown> = {}, api = host) {
  // Independent fixture scenarios; changing real plans does not reset sampler state.
  await rm(join(data, "quota-sampling.json"), { force: true });
  await writeFile(join(data, "plans.json"), JSON.stringify({ plans: [{ ...rawPlan, ...changes }] }));
  clearCache();
  return usage.assemble(api, "7d");
}
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const reviewNames = ["Demo reviewer", "Demo review candidate"];

test("raw review-only plans survive normalization, RPC, status, contract export and both matrices", async () => {
  const { board, catalog } = await assemble();
  // Inspect every boundary, rather than constructing the expected pool flags by hand.
  const status = await pools.writePoolStatus(board.plans, null, now, false, null, null, 0, null, null, null, catalog);
  const legacy = await json(pools.POOL_STATUS);
  const exported = EXPORTS.poolStatus.schema.parse(await json(join(data, "..", "exports/fleet/pool-status.json")));
  // Exercise the real timer refresh as well as the standalone writer.
  await usage.refreshPoolStatus(host);
  const panel = boardUsageRpc.output.parse(await usage.buildUsage(host, "7d"));
  const matrices = await Promise.all([dispatch.DISPATCH_MATRIX, join(data, "..", "exports/fleet/dispatch-matrix.json")].map(json));
  // Keep all boundary observations available even when an older implementation fails the first assertion.
  console.info("plan role boundaries", JSON.stringify({
    normalizedOnlyRoles: (board.plans[0] as UsagePlan & { onlyRoles?: string[] }).onlyRoles ?? null,
    statusOnlyRoles: status[rawPlan.id].onlyRoles ?? null,
    exportedOnlyRoles: exported.pools[rawPlan.id].onlyRoles,
    paused: matrices.map(matrix => Object.fromEntries(roles.slice(0, 5).map(role => [role, (role === "reviewer" ? reviewerTier(matrix, "demo-work", "L2") : matrix.roles[role].L2).map((row: { paused?: boolean }) => Boolean(row.paused))]))),
  }));
  assert.deepEqual((board.plans[0] as UsagePlan & { onlyRoles?: string[] }).onlyRoles, ["reviewer"]);
  assert.deepEqual((boardUsageRpc.output.parse(board).plans[0] as UsagePlan & { onlyRoles?: string[] }).onlyRoles, ["reviewer"]);
  assert.equal(status[rawPlan.id].dispatchable, true);
  assert.deepEqual(status[rawPlan.id].onlyRoles, ["reviewer"]);
  assert.deepEqual(legacy.pools[rawPlan.id].onlyRoles, ["reviewer"]);
  assert.deepEqual(exported.pools[rawPlan.id].onlyRoles, ["reviewer"]);
  for (const flags of [dispatch.poolFlagsFromJson(legacy.pools, now), dispatch.poolFlagsFromJson(exported.pools, now)]) {
    for (const profile of profiles) assert.equal(profilePaused(profile, flags[rawPlan.id]), !reviewNames.includes(profile.name), profile.name);
  }
  assert.deepEqual(panel.plans[0].onlyRoles, ["reviewer"]);
  assert.equal(panel.pools![rawPlan.id].dispatchable, true);
  for (const matrix of matrices) {
    assert.deepEqual(reviewerTier(matrix, "demo-work", "L2").map(row => [row.profile, Boolean(row.paused)]), reviewNames.map(name => [name, false]));
    assert.deepEqual(reviewerTier(matrix, null, "L2"), []);
    for (const role of roles.slice(1, 5)) assert.ok(matrix.roles[role].L2.every((row: { paused?: boolean }) => row.paused === true), role);
  }
});

test("missing, null and empty role lists keep existing unrestricted semantics", async () => {
  for (const onlyRoles of [undefined, null, []]) {
    const { board } = await assemble({ onlyRoles });
    const status = pools.poolStatus(board.plans, { now });
    assert.equal(status[rawPlan.id].dispatchable, true);
    const flags = dispatch.poolFlagsFromJson(status, now)[rawPlan.id];
    for (const profile of profiles) assert.equal(profilePaused(profile, flags), false, profile.name);
  }
});

test("role limits never open a closed, exhausted or protected unread pool", async () => {
  for (const changes of [
    { dispatch: false },
    { quotaProtection: "pause", manualOverride: null, usageProvider: "missing" },
    { quotaProtection: "pause", manualOverride: null },
  ]) {
    const exhausted = changes.usageProvider !== "missing" && changes.dispatch !== false;
    providerWindow.usedPct = exhausted ? 100 : 30;
    try {
      const { board } = await assemble({ ...changes, paceDisable: true });
      const status = pools.poolStatus(board.plans, { now });
      assert.equal(status[rawPlan.id].dispatchable, false);
      for (const profile of profiles) assert.equal(profilePaused(profile, dispatch.poolFlagsFromJson(status, now)[rawPlan.id]), true, profile.name);
    } finally { providerWindow.usedPct = 30; }
  }
});

test("quota and rate-limit read failures keep protected pools paused", async () => {
  for (const message of ["quota exhausted", "rate_limit"]) {
    const failed = { providers: { listUsage: async () => { throw new Error(message); } } } as never;
    const { board } = await assemble({ quotaProtection: "pause", manualOverride: null, paceDisable: true }, failed);
    const status = pools.poolStatus(board.plans, { now });
    assert.equal(status[rawPlan.id].dispatchable, false);
    for (const profile of profiles) assert.equal(profilePaused(profile, dispatch.poolFlagsFromJson(status, now)[rawPlan.id]), true, profile.name);
  }
});

test("unprotected and legacy pools still enforce explicit roles, including unknown role names", async () => {
  for (const quotaProtection of [undefined, "none"]) {
    const { board } = await assemble({ quotaProtection, paceDisable: true });
    const status = pools.poolStatus(board.plans, { now });
    assert.equal(status[rawPlan.id].dispatchable, true);
    for (const profile of profiles) assert.equal(profilePaused(profile, dispatch.poolFlagsFromJson(status, now)[rawPlan.id]), !reviewNames.includes(profile.name), profile.name);
  }
  const { board } = await assemble({ onlyRoles: ["unconfigured-role"] });
  const flags = dispatch.poolFlagsFromJson(pools.poolStatus(board.plans, { now }), now)[rawPlan.id];
  for (const profile of profiles) assert.equal(profilePaused(profile, flags), true, profile.name);
});

test("explicit plan limits narrow existing reviewer exceptions without opening other pools", async () => {
  const { board } = await assemble();
  const window = { ...board.plans[0].windows[0], usedPct: 80 };
  const leader = {
    ...board.plans[0], id: "demo-leader", adapter: "claude-cli", windows: [window, { ...window, label: "Weekly · Fable", usedPct: 20 }],
    reviewerException: { roles: ["reviewer"], stopPct: 90, until: "2030-06-08T00:00:00Z" },
  };
  const cases = [
    { onlyRoles: undefined, allowed: ["reviewer"], dispatchable: true },
    { onlyRoles: [], allowed: ["reviewer"], dispatchable: true },
    { onlyRoles: ["reviewer", "executor"], allowed: ["reviewer"], dispatchable: true },
    { onlyRoles: ["reader"], allowed: [], dispatchable: false },
  ];
  for (const item of cases) {
    const status = pools.poolStatus([{ ...leader, onlyRoles: item.onlyRoles }, { ...board.plans[0], id: "demo-unrestricted", onlyRoles: undefined }], { now });
    assert.equal(status[leader.id].dispatchable, item.dispatchable);
    assert.deepEqual(status[leader.id].onlyRoles, item.allowed);
    assert.equal(status["claude-fable"].dispatchable, item.dispatchable);
    assert.deepEqual(status["claude-fable"].onlyRoles, item.allowed);
    assert.equal(status["demo-unrestricted"].onlyRoles, undefined);
  }
  const expired = { ...leader, reviewerException: { ...leader.reviewerException, until: new Date(now).toISOString() } };
  assert.equal(pools.poolStatus([expired], { now })[leader.id].dispatchable, false);
});
