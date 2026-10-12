// Provider policy checks use isolated demo profiles, plans, histories and fake daemon responses.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bannedProviderTerms, providerBanned } from "../../../shared/fleet/provider-policy";
import { buildDispatchBundle, profilesFromConfig, profilesForRole, type DispatchMatrix, type DispatchProfile } from "../../../shared/fleet/dispatch";
import { buildRolesPage } from "../../../shared/fleet/roles-page";
import { pickableModels, swapRefusal } from "../../../shared/fleet/roles-policy";

const home = mkdtempSync(join(tmpdir(), "provider-policy-demo-"));
const data = join(join(home, "data"), "fleet");
const paseoDir = join(home, ".paseo");
const plugin = join(home, "plugin");
const saved = { ...process.env };
const now = Date.now();
const at = new Date(now).toISOString();
const hour = at.slice(0, 13);
const banned = ["gemini", "google", "antigravity"];
const profiles: DispatchProfile[] = [
  { name: "Demo executor", role: "executor", provider: "gemini", model: "gemini-demo", family: "google", pool: "search-pool", dispatchId: "executor" },
  { name: "Demo alternate", role: "candidate", candidateFor: "executor", provider: "antigravity", model: "gravity-demo", family: "google", pool: "gravity-pool", dispatchId: "executor.sonnet" },
  { name: "Demo allowed", role: "candidate", candidateFor: "executor", provider: "claude", model: "sonnet-demo", family: "anthropic", pool: "allowed-pool" },
];
const base: DispatchMatrix = {
  version: 1, defaultTier: "L2", downgradeWhenTight: [],
  roles: { executor: { L2: profiles.map((profile) => ({ profile: profile.dispatchId ?? profile.name, effort: "medium" })) } },
};
const plans = profiles.map((profile) => ({
  id: profile.pool!, name: `${profile.provider} demo plan`, providers: [profile.provider!], usageProvider: profile.provider,
  adapter: "manual", dispatch: true, priceUsdMonthly: 0, cycleDay: 1, manual: { usedPct: 10, at },
}));
const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
let util: typeof import("../util");
let dispatch: typeof import("../dispatch");
let config: typeof import("../adapters/config");

before(async () => {
  for (const dir of [data, paseoDir, join(plugin, "shared", "fleet"), plugin, join(paseoDir, "agents", "demo")]) mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { HOME: home, PASEO_HOME: paseoDir, KANBAN_DATA_DIR: join(data, ".."), KANBAN_HOME: plugin,  AFC_LANGUAGE: "en" });
  process.env.KANBAN_PASEO_CONFIG = join(paseoDir, "config.json");

  put(join(paseoDir, "config.json"), { daemon: { agentProfiles: profiles } });
  put(join(plugin, "shared/fleet/default-dispatch.example.json"), base);
  put(join(data, "plans.json"), { plans, prices: Object.fromEntries(profiles.map((profile) => [profile.model, { input: 1, output: 1 }])) });
  put(join(data, "usage-ledger.json"), { version: 2, turns: profiles.map((profile, index) => ({
    at, agentId: `agent-${index}`, provider: profile.provider, model: profile.model, input: 1_000_000, cached: 0, output: 0,
  })) });
  for (const [index, profile] of profiles.entries()) put(join(paseoDir, "agents", "demo", `${index}.json`), {
    id: `agent-${index}`, title: profile.name, provider: profile.provider, config: { model: profile.model },
    labels: { role: "executor" }, cwd: "", createdAt: at, lastStatus: "idle", persistence: { sessionId: `session-${index}` },
  });
  writeFileSync(join(data, "changes.log"), profiles.map((profile) => JSON.stringify({ at, role: "executor", from: `${profile.provider}/old`, to: `${profile.provider}/${profile.model}` })).join("\n"));
  util = await import("../util");
  config = await import("../adapters/config");
  dispatch = await import("../dispatch");
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

test("empty, malformed and explicit provider policies are normalized without implicit bans", () => {
  for (const raw of [null, {}, { bannedProviders: [] }, { bannedProviders: "gemini" }]) assert.deepEqual(bannedProviderTerms(raw), []);
  assert.deepEqual(bannedProviderTerms({ bannedProviders: [" Gemini ", 1, "GOOGLE", "gemini", ""] }), ["gemini", "google"]);
  assert.equal(providerBanned(profiles[0]), false);
  assert.equal(providerBanned(profiles[0], ["google"]), true, "company metadata matches independently of provider id");
  assert.equal(providerBanned({ id: "demo", usageProvider: "antigravity" }, banned), true);
  assert.equal(providerBanned({ name: "Demo", provider: "claude" }, banned), false);
  assert.equal(providerBanned({ provider: "gemini" }, ["google"]), true);
  assert.equal(providerBanned({ provider: "antigravity" }, ["google"]), true);
  assert.equal(providerBanned({ provider: "claude", model: "gemini-demo" }, ["google"]), true);
  assert.equal(providerBanned({ provider: "codex" }, ["openai"]), true);
  assert.deepEqual(bannedProviderTerms(JSON.parse(readFileSync(new URL("../../../examples/afc.config.example.json", import.meta.url), "utf8"))), []);
  assert.deepEqual(config.readBannedProviders(), []);
  writeFileSync(join(data, "afc.config.json"), "{");
  assert.deepEqual(config.readBannedProviders(), []);
});

test("matrix, stats and profile page admit demo providers by default and exclude only configured ones", () => {
  const raw = { daemon: { agentProfiles: profiles } };
  assert.equal(profilesFromConfig(raw)?.length, 3);
  assert.equal(profilesFromConfig(raw, banned)?.length, 1);
  assert.equal(profilesForRole("executor", profiles).length, 3);
  assert.equal(profilesForRole("executor", profiles, banned).length, 1);
  for (const terms of [[], banned]) {
    const expected = terms.length ? ["Demo allowed"] : profiles.map((profile) => profile.name);
    const bundle = buildDispatchBundle({ base, profiles, bannedProviders: terms, pools: {}, generatedAt: at,
      effortRuns: profiles.flatMap((profile) => Array.from({ length: 3 }, () => ({ profile: profile.name, effort: "medium", tokens: 10, usd: 1 }))),
      poolDeltas: profiles.map((profile) => ({ pool: profile.pool!, deltaPct: 1, runs: 1 })), claude: null,
    });
    assert.deepEqual((bundle.matrix.roles.executor as { L2: Array<{ profile: string }> }).L2.map((row) => row.profile), expected);
    assert.deepEqual(bundle.stats.byProfileEffort.map((row) => row.profile).sort(), [...expected].sort());
    assert.equal(bundle.stats.byPool.length, expected.length);
    assert.deepEqual(bundle.unresolvedSlots, [], "deliberate bans are not unresolved config slots");
    const page = buildRolesPage({ profiles, bannedProviders: terms, pools: {}, todayRuns: {}, matrix: bundle.matrix, generatedAt: at });
    assert.deepEqual(page.cards.find((card) => card.key === "executor")?.rows.map((row) => row.profile).sort(), [...expected].sort());
    const offered = profiles.map((profile) => ({ provider: profile.provider!, id: profile.model!, thinking: [] }));
    assert.equal(pickableModels(offered, terms).length, expected.length);
    assert.equal(swapRefusal("gemini", "gemini-demo", null, terms) === null, terms.length === 0);
  }
});

test("an allowed profile keeps a pool shared with a banned model", () => {
  const shared = profiles.map((profile) => ({ ...profile, pool: "shared-transport" }));
  const bundle = buildDispatchBundle({ base, profiles: shared, bannedProviders: ["google"], pools: {}, generatedAt: at,
    priority: { order: ["shared-transport"], until: at }, effortRuns: [],
    poolDeltas: [{ pool: "shared-transport", deltaPct: 1, runs: 1 }], claude: null,
  });
  assert.equal(bundle.stats.byPool.length, 1);
  assert.deepEqual(bundle.matrix.priority?.order, ["shared-transport"]);
});

test("server entry points share the data-directory policy and display hiding leaves dispatch intact", async () => {
  const { profilePools } = await import("../quota-history");
  const { readChanges, buildRoles } = await import("../snapshot-parts");
  const { buildRolesPageView, productionRolesPageDeps } = await import("../roles-page");
  const { buildHomeView } = await import("../home-feed");
  const { buildInsights } = await import("../insights");
  const { readPoolCatalog } = await import("../adapters/plans");
  const { buildUsage, assemble } = await import("../usage");
  const { ensureScan } = await import("../scan");
  const { readSupervisorPanel, setShiftStatePathForTests } = await import("../supervisor-shift");
  // This file-only Kanban export enables the panel without a real daemon or database.
  const kanban = join(data, "..");
  mkdirSync(join(kanban, "exports"), { recursive: true });
  const envelope = { schema: "fleet-quota/v1", producer: "paseo-kanban", producerVersion: "0.0.0-demo", generatedAt: at, ttlSeconds: 1800 };
  put(join(kanban, "exports", "kanban.json"), { ...envelope, dataDir: kanban, cli: null, features: ["board-summary"] });
  put(join(kanban, "exports", "board-summary.json"), { ...envelope, projects: [], cards: [], dbPath: null });
  const shiftConfig = join(home, "shift-config.json");
  put(shiftConfig, { supervisors: { demo: "agent-0" }, projects: { demo: { code: "DEMO" } } });
  setShiftStatePathForTests(join(data, "shift-state.json"), { config: shiftConfig, log: join(data, "handoffs.log") });
  const requested: string[] = [];
  const fake = { providers: {
    listUsage: async () => ({ providers: [] }),
    refresh: async () => undefined,
    listModels: async (provider: string) => {
      requested.push(provider);
      return { models: [{ id: `${provider}-demo`, label: `${provider} demo`, thinkingOptions: [] }] };
    },
  } } as never;
  await ensureScan(0);
  for (const [terms, hidden] of [[[], []], [banned, []], [["google"], []], [[], banned]] as const) {
    put(join(data, "afc.config.json"), { bannedProviders: terms, hiddenPlans: hidden });
    util.clearCache();
    const expected = terms.length ? ["Demo allowed"] : profiles.map((profile) => profile.name);
    assert.deepEqual((await profilePools()).map((row) => row.name), expected);
    assert.equal((await readChanges()).length, expected.length);
    const roles = buildRoles(profiles, {}, now).roles;
    assert.equal(roles.find((role) => role.key === "executor")?.lineup.length, expected.length);
    const page = await buildRolesPageView({ ...productionRolesPageDeps(), runsSince: () => [] }, now);
    assert.deepEqual(page.cards.find((card) => card.key === "executor")?.rows.map((row) => row.profile).sort(), [...expected].sort());
    requested.length = 0;
    const insights = await buildInsights(fake, true);
    assert.equal(insights.scorecard.length, expected.length);
    assert.equal(insights.models.some((model) => model.provider === "gemini"), terms.length === 0);
    assert.equal(insights.models.some((model) => model.provider === "antigravity"), terms.length === 0, "candidate providers are discoverable");
    assert.equal(requested.includes("gemini"), terms.length === 0);
    const records = await (await import("../records")).readAgentRecords();
    const panel = await readSupervisorPanel(null, [{ id: "agent-0", contextTokens: 1 }] as never, records, now);
    assert.equal(panel.rows.length, 1);
    assert.equal(panel.rows[0].todayText === null, terms.length > 0);
    if (!terms.length) assert.match(panel.rows[0].todayText!, /1/);
    const assembled = await assemble(fake, "7d");
    assert.equal(assembled.board.plans.length, expected.length);
    const usage = await buildUsage(fake, "7d");
    assert.equal(usage.plans.length, terms.length || hidden.length ? 1 : 3);
    const catalog = await readPoolCatalog();
    assert.equal(catalog.length, expected.length, "hidden cards keep their dispatch pools");
    const poolFile = JSON.parse(readFileSync(join(data, "pool-status.json"), "utf8"));
    assert.equal(Object.keys(poolFile.pools).length, expected.length);
    const homeView = await buildHomeView({ now, pools: poolFile.pools, roles });
    assert.equal(homeView.companies.length, usage.companies?.length);
    assert.equal(homeView.companies.some((card) => /gemini|antigravity/i.test(card.name)), terms.length === 0 && hidden.length === 0);
    // A banned model routed through an allowed transport must not leak through home chart buckets.
    put(join(data, "usage-scan-cache.json"), { files: { demo: { provider: "claude", sessionId: "session-0", b: {
      [`${hour}|claude|gemini-demo|0`]: [100, 0, 0, 0, 0, 1],
    } } } });
    util.clearCache("home-usage");
    const routed = await buildHomeView({ now, pools: {}, roles });
    const routedTokens = routed.days.reduce((sum, day) => sum + day.claude, 0);
    assert.equal(routedTokens, terms.length ? 1_000_000 : 1_000_100);
  }
});

test("explicit bans scrub old matrices even when another slot is unresolved", async () => {
  const policyNow = Date.now();
  put(join(data, "afc.config.json"), { bannedProviders: [] });
  await dispatch.publishDispatch({}, policyNow, []);
  const legacyPath = dispatch.DISPATCH_MATRIX;
  const exportPath = join(data, "..", "exports", "fleet", "dispatch-matrix.json");
  const previous = JSON.parse(readFileSync(legacyPath, "utf8"));
  const before = readFileSync(legacyPath);
  const policyPath = join(data, "policy-snapshot.json");
  const policyBefore = readFileSync(policyPath);
  const missingBase = { ...base, roles: { executor: { L2: [...(base.roles.executor as { L2: unknown[] }).L2, { profile: "reviewer", effort: "high" }] } } };
  put(join(plugin, "shared/fleet/default-dispatch.example.json"), missingBase);
  await assert.rejects(() => dispatch.publishDispatch({}, policyNow, []), /Policy slots are unresolved/);
  assert.deepEqual(readFileSync(legacyPath), before, "unresolved policy preserves existing bytes");
  put(join(data, "afc.config.json"), { bannedProviders: banned });
  await assert.rejects(() => dispatch.publishDispatch({}, policyNow, []), /Policy slots are unresolved/);
  for (const path of [legacyPath, exportPath]) {
    const matrix = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(matrix.roles.executor.L2.map((row: { profile: string }) => row.profile), ["Demo allowed"]);
  }
  assert.equal(JSON.parse(readFileSync(legacyPath, "utf8")).generatedAt, previous.generatedAt);
  assert.deepEqual(readFileSync(policyPath), policyBefore, "unresolved updates never replace the immutable admission snapshot");
});
