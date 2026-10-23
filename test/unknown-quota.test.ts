import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UsagePlan, UsageWindow } from "../shared/fleet/usage";

const root = mkdtempSync(join(tmpdir(), "unknown-quota-"));
process.env.KANBAN_DATA_DIR = root;
process.env.KANBAN_POOL_STATUS = join(root, "pools.json");
const { poolStatus } = await import("../server/fleet/pools-status");
const { toPoolState, buildPoolStatusExport } = await import("../server/fleet/exports");
const { readCompatibilityPoolSnapshot, unknownQuotaBlock } = await import("../server/pools");
const { routeProfile } = await import("../server/routing");
const { closeDb } = await import("../server/db");
const { quotaLine } = await import("../shared/fleet/quota-line");
const { paceStatusLabel } = await import("../shared/fleet/usage");
const { t } = await import("../shared/fleet/i18n");
after(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });
const now = Date.parse("2030-06-01T01:00:00Z");
const window = (changes: Partial<UsageWindow> = {}): UsageWindow => ({ label: "Weekly", usedPct: 20,
  startsAt: "2030-06-01T00:00:00Z", resetsAt: "2030-06-08T00:00:00Z", sampledAt: new Date(now).toISOString(),
  elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown", apiUsd: 0, fullWindowUsd: null,
  planUsd: null, source: "provider", manualAt: null, ...changes });
const plan = (w = window()): UsagePlan => ({ id: "demo-grok", name: "Demo Grok", adapter: "muse-msp", dispatch: true,
  pacePause: false, providers: ["demo"], windows: [w], priceUsdMonthly: null, note: "", api30dUsd: 0, roi30d: null, coverage: "" });
const status = (w = window(), unknownQuota?: { maxAgeMs?: number; maxConcurrent?: number; tiers?: string[] }) => poolStatus([plan(w)], { now, unknownQuota })["demo-grok"];

test("missing, failed, stale and expired reads become unknown; recovery is known", () => {
  for (const w of [window({ usedPct: null }), window({ readError: "Read failed" }),
    window({ sampledAt: new Date(now - 2 * 60 * 60_000).toISOString() }), window({ sampledAt: null }),
    window({ sampledAt: new Date(now + 1).toISOString() }), window({ readingState: "stale" }),
    window({ readingExpiresAt: new Date(now).toISOString() })]) {
    const row = status(w);
    assert.equal(row.state, "unknown");
    assert.equal(row.prefer, false);
    assert.equal(row.usedPct, null);
    assert.equal(row.paceState, "unknown");
  }
  assert.equal(status().state, "known");
  assert.equal(status().dispatchable, true);
  assert.equal(status(window({ sampledAt: new Date(now - 1000).toISOString() }), { maxAgeMs: 1000 }).state, "unknown");
});

test("contract and consumer preserve state and limits, expire at read time without reopening stops", () => {
  const row = status(window(), { maxAgeMs: 1000, maxConcurrent: 2, tiers: ["L2"] });
  const wire = buildPoolStatusExport({ "demo-grok": row }, null, "demo", new Date(now));
  assert.equal(wire.pools["demo-grok"].state, "known");
  assert.equal(toPoolState({ ...row, state: "unknown" }).state, "unknown");
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ generatedAt: wire.generatedAt, pools: wire.pools }));
  const fresh = readCompatibilityPoolSnapshot(now).entry("demo-grok");
  assert.equal(unknownQuotaBlock(fresh, "L4", 5), null);
  const expired = readCompatibilityPoolSnapshot(now + 1000).entry("demo-grok");
  assert.equal(expired.state, "unknown");
  assert.equal(unknownQuotaBlock(expired, "L2", 1), null);
  assert.ok(unknownQuotaBlock(expired, "L2", 2));
  assert.ok(unknownQuotaBlock(expired, "L1", 0));
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ pools: { "demo-grok": { ...wire.pools["demo-grok"], dispatchable: false } } }));
  assert.equal(readCompatibilityPoolSnapshot(now + 1000).entry("demo-grok").dispatchable, false);
});

test("unknown pool route enforces shared occupancy, tier and configured limits; recovery removes restrictions", () => {
  const profile = { id: "demo", name: "Demo read", role: "read", provider: "demo", model: "demo", pool: "demo-grok" };
  const known = status();
  const unknown = status(window({ usedPct: null }));
  const route = (row: typeof known, tier: string, count: number) => routeProfile({ profiles: [profile], role: "read", review: false,
    profileOverride: profile.id, byPool: { "demo-grok": count }, poolLimits: { "demo-grok": 10 }, tier,
    snapshot: { state: "fresh", generatedAt: new Date(now).toISOString(), message: "Demo", entry: () => ({ ...row, onlyRoles: null }), dispatchable: () => row.dispatchable } });
  assert.equal(route(unknown, "L1", 0).ok, true);
  assert.equal(route(unknown, "L2", 0).ok, true);
  assert.equal(route(unknown, "L1", 1).ok, false);
  assert.equal(route(unknown, "L3", 0).ok, false);
  assert.equal(route(unknown, "L4", 0).ok, false);
  assert.equal(route(known, "L4", 2).ok, true);
});

test("AFC notifies each project leader once per unknown episode, retries failures, serializes concurrent refreshes", async () => {
  const { notifyUnknownQuota } = await import("../server/fleet/unknown-quota");
  const path = join(root, "notices.json");
  const leaders = ["demo-leader-one", "demo-leader-two"];
  const rows = { "demo-grok": status(window({ usedPct: null })) };
  const sent: string[] = [];
  let fail = true;
  const notify = async (id: string) => { if (id === leaders[1] && fail) throw new Error("Demo failure"); sent.push(id); };
  await notifyUnknownQuota(rows, leaders, notify, path);
  fail = false;
  await Promise.all(Array.from({ length: 4 }, () => notifyUnknownQuota(rows, leaders, notify, path)));
  assert.deepEqual(sent, leaders);
  await notifyUnknownQuota({ "demo-grok": status() }, leaders, notify, path);
  await notifyUnknownQuota(rows, leaders, notify, path);
  assert.deepEqual(sent, [...leaders, ...leaders]);
});

test("panel labels unknown quota as a warning even if a last percent existed", () => {
  const row = status(window({ readError: "Demo failure" }));
  assert.equal(paceStatusLabel(row), t("quota.unknown.label"));
  const line = quotaLine({ ...row, key: "demo-grok" }, now)!;
  assert.equal(line.tone, "yellow");
  assert.ok(line.text.includes(t("quota.unknown.label")));
});

test("a protected reading that expires before its source-age limit is also marked unknown", () => {
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ pools: { "demo-grok": {
    ...toPoolState(status()), quotaProtection: "pause", readingExpiresAt: new Date(now).toISOString(),
  } } }));
  const row = readCompatibilityPoolSnapshot(now).entry("demo-grok");
  assert.equal(row.dispatchable, false);
  assert.equal(row.state, "unknown");
});

test("unknown preserves an existing soft deprioritization through publication and routing", () => {
  const makePools = (failed: boolean) => poolStatus([
    { ...plan(window(failed ? { readError: "Demo failure" } : {})), pacePause: true },
    { ...plan(window({ usedPct: 100 })), id: "demo-down", name: "Demo down" },
  ], { now, siblings: { "demo-grok": ["demo-down"] } });
  const known = makePools(false)["demo-grok"];
  assert.equal(known.dispatchable, true); assert.equal(known.deprioritize, true);
  const unknown = makePools(true)["demo-grok"];
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.dispatchable, true);
  assert.equal(unknown.deprioritize, true); assert.equal(unknown.prefer, false);
  writeFileSync(process.env.KANBAN_POOL_STATUS!, JSON.stringify({ pools: {
    "demo-grok": toPoolState(unknown), normal: { ...toPoolState(status()), deprioritize: false },
  } }));
  const snapshot = readCompatibilityPoolSnapshot(now);
  assert.equal(snapshot.entry("demo-grok").deprioritize, true);
  const deprioritized = { id: "demo-first", name: "Demo first", role: "reader", provider: "demo", model: "demo", pool: "demo-grok" };
  const normal = { ...deprioritized, id: "demo-second", name: "Demo second", pool: "normal" };
  for (const matrix of [null, { version: 1, generatedAt: null, defaultTier: "L1" as const, downgradeWhenTight: [],
    executor: {}, reviewerFamilies: {}, star: { reader: [deprioritized, normal].map(p => ({ profile: p.name, effort: null, paused: false })) } }]) {
    const result = routeProfile({ profiles: [deprioritized, normal], role: "reader", review: false, byPool: {}, poolLimits: {}, snapshot, matrix, tier: "L1", now });
    assert.ok(result.ok); assert.equal(result.profile.id, normal.id);
  }
});
