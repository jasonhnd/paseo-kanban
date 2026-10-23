import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcileXUltraWindow } from "../server/fleet/x-ultra";
import type { UsageWindow, UsagePlan } from "../shared/fleet/usage";
import type { CursorUsageReading } from "../server/fleet/cursor-usage";
import { rankPools, withPoolRankingMetadata } from "../shared/fleet/pool-ranking";
import { setLanguage } from "../shared/fleet/i18n";

const root = mkdtempSync(join(tmpdir(), "x-seat-"));
Object.assign(process.env, { KANBAN_DATA_DIR: root, PASEO_HOME: join(root, "host"),
  KANBAN_PASEO_CONFIG: join(root, "host/config.json"), KANBAN_AGENTS_DIR: join(root, "agents"), AFC_TRANSCRIPT_HOME: join(root, "transcripts") });
const { poolStatus } = await import("../server/fleet/pools-status");
const { buildPoolStatusExport } = await import("../server/fleet/exports");
const now = Date.now();
const at = new Date(now).toISOString();
const reset = new Date(now + 86_400_000).toISOString();
const month = new Date(now + 25 * 86_400_000).toISOString();
const grok: UsageWindow = { label: "Weekly", usedPct: 20, resetsAt: reset, startsAt: null, sampledAt: new Date(now - 60_000).toISOString(),
  source: "provider", manualAt: null, elapsedPct: null, projectedPct: null, runsOutAt: null, verdict: "unknown", apiUsd: 0, fullWindowUsd: null, planUsd: 0 };
const cursor: CursorUsageReading = { ok: true, readAt: at, error: null, includedPct: 1, autoPct: 1, apiPct: 1, onDemandUsd: 0, onDemandLimitUsd: 0,
  resetsAt: month, loggedOut: false, source: "official", windows: [
    { label: "Auto", usedPct: 1, resetsAt: month, onDemandUsd: null, onDemandLimitUsd: null },
    { label: "Grok", usedPct: 21, resetsAt: reset, onDemandUsd: null, onDemandLimitUsd: null },
  ] };
function plan(window: UsageWindow, xUltraReserve?: UsagePlan["xUltraReserve"]): UsagePlan {
  return { id: "x-ultra", name: "X Ultra", adapter: "grok-cli", priceUsdMonthly: 200, providers: ["grok", "cursor"], dispatch: true, pacePause: false,
    windows: [window], note: "", coverage: "", roi30d: null, api30dUsd: 0, ...(xUltraReserve ? { xUltraReserve } : {}) };
}
before(() => {
  setLanguage("en");
  Object.assign(process.env, { KANBAN_DATA_DIR: root, PASEO_HOME: join(root, "host"),
    KANBAN_PASEO_CONFIG: join(root, "host/config.json"), KANBAN_AGENTS_DIR: join(root, "agents"), AFC_TRANSCRIPT_HOME: join(root, "transcripts") });
  for (const name of ["fleet", "host", "agents", "transcripts"]) mkdirSync(join(root, name));
});
after(async () => { const { closeDb } = await import("../server/db"); closeDb(); rmSync(root, { recursive: true, force: true }); });

test("only Cursor's Grok row participates, with the shared reset and original source clock", () => {
  const window = reconcileXUltraWindow(grok, cursor, now);
  assert.equal(window.usedPct, 21); assert.equal(window.resetsAt, reset); assert.equal(window.sampledAt, at);
  assert.equal(window.pool, "x-ultra"); assert.equal(window.readingState, "live");
  const missingGrok = { ...cursor, windows: cursor.windows.slice(0, 1) };
  assert.equal(reconcileXUltraWindow({ ...grok, usedPct: null }, missingGrok, now).usedPct, null);
  for (const bad of [{ ...cursor, ok: false }, { ...cursor, readAt: new Date(now + 60_000).toISOString() },
    { ...cursor, windows: [{ ...cursor.windows[1], resetsAt: null }] }]) {
    assert.equal(reconcileXUltraWindow({ ...grok, usedPct: null }, bad, now).usedPct, null);
  }
});

test("reserve placeholders keep real usage visible, narrow configured unknown bounds, and survive export", () => {
  const p = plan(reconcileXUltraWindow(grok, cursor, now));
  const row = poolStatus([p], { now, unknownQuota: { maxConcurrent: 9, tiers: ["L1", "L2", "L3", "L4"] } })[p.id];
  assert.equal(row.state, "unknown"); assert.equal(row.usedPct, 21); assert.equal(row.dispatchable, true);
  assert.equal(row.unknownQuota!.maxConcurrent, 1); assert.deepEqual(row.unknownQuota!.tiers, ["L1", "L2"]);
  const exported = buildPoolStatusExport({ [p.id]: row }, null, "1.0.0", new Date(now));
  assert.equal(exported.pools[p.id].state, "unknown");
  assert.deepEqual(rankPools({ pools: withPoolRankingMetadata({ [p.id]: exported.pools[p.id] }, [p]), now, role: "executor", tier: "L4" }), []);
  const configured = plan(p.windows[0], { botPct: 20, userPct: 15 });
  const ready = poolStatus([configured], { now })[p.id];
  assert.equal(ready.state, "known"); assert.equal(ready.reservePct, 35);
  assert.equal(buildPoolStatusExport({ [p.id]: ready }, null, "1.0.0", new Date(now)).pools[p.id].reservePct, 35);
  assert.equal(poolStatus([plan({ ...p.windows[0], usedPct: 65 }, configured.xUltraReserve)], { now })[p.id].dispatchable, false);
  const stopped = poolStatus([{ ...p, dispatch: false }], { now })[p.id];
  assert.equal(stopped.dispatchable, false);
});

test("assemble migrates legacy plans without rewriting them, and renders one company/pool", async () => {
  const file = join(root, "fleet/plans.json");
  const raw = JSON.stringify({ plans: [
    { id: "supergrok", name: "Old", providers: ["grok"], usageProvider: "grok", dispatch: true, cliRead: false, priceUsdMonthly: 300 },
    { id: "cursor", name: "Old bundle", providers: ["cursor"], dispatch: false, screenRead: false, cycleDay: 12, manual: { usedPct: 1, at } },
  ] });
  writeFileSync(file, raw);
  writeFileSync(join(root, "fleet/afc.config.json"), JSON.stringify({ adapters: { "cursor-api": false } }));
  const { assemble } = await import("../server/fleet/usage");
  const assembled = await assemble({ providers: { listUsage: async () => ({ providers: [{ providerId: "grok", windows: [{ label: "Weekly", usedPct: 20, resetsAt: reset }] }] }) } } as never, "7d");
  assert.deepEqual(assembled.board.plans.map(p => p.id), ["x-ultra"]);
  assert.deepEqual(assembled.catalog.map(p => p.id), ["x-ultra"]);
  assert.equal(assembled.board.plans[0].windows[0].pool, "x-ultra");
  assert.equal(assembled.board.plans[0].windows[0].usedPct, 20);
  assert.equal(readFileSync(file, "utf8"), raw);
});

test("expired legacy Auto metadata cannot invalidate a fresh independent Grok weekly row", async () => {
  const { readCursorUsageFile, CURSOR_USAGE_FILE } = await import("../server/fleet/cursor-usage");
  writeFileSync(CURSOR_USAGE_FILE, JSON.stringify({ ...cursor, resetsAt: new Date(now - 86_400_000).toISOString() }));
  const read = await readCursorUsageFile();
  assert.equal(reconcileXUltraWindow({ ...grok, usedPct: null }, read, now).usedPct, 21);
});

test("legacy Cursor transport stops do not close the shared Grok quota", async () => {
  const { readCompatibilityPoolSnapshot } = await import("../server/pools");
  const { routeProfile } = await import("../server/routing");
  const { createTask } = await import("../server/store");
  const { loadConfig } = await import("../server/config");
  const file = join(root, "fleet/pool-status.json");
  process.env.KANBAN_POOL_STATUS = file;
  for (const quotaId of ["supergrok", "x-ultra"]) {
    writeFileSync(file, JSON.stringify({ generatedAt: at, pools: { [quotaId]: { state: "known", dispatchable: true, usedPct: 21, resetsAt: reset, reservePct: 35, parent: null, adapter: "grok-cli", providers: ["grok", "cursor"] } } }));
    for (const disabledPools of [["demo-other", "cursor"], ["demo-other"]]) {
      writeFileSync(join(root, "kanban.config.json"), JSON.stringify({ disabledPools }));
      const snapshot = readCompatibilityPoolSnapshot(now);
      for (const id of ["supergrok", "x-ultra"]) assert.equal(snapshot.entry(id).dispatchable, true, `${quotaId}: ${id} stays open`);
      assert.equal(snapshot.entry("cursor").dispatchable, !disabledPools.includes("cursor"));
      const cli = { id: "cli", name: "Demo Grok CLI", provider: "grok", model: "grok-4.7", role: "reader", pool: "x-ultra" };
      const input = { profiles: [cli], role: "reader", review: false, tier: "L2", snapshot, byPool: {}, poolLimits: {}, now };
      assert.equal(routeProfile(input).ok, true);
      const task = createTask({ project: "demo", title: "Inspect the shared quota", role: "reader", tier: "L2", workspacePath: root });
      const current = { ...input, task, project: "demo", routingConfig: loadConfig() };
      assert.equal(routeProfile(current).ok, true, "the current G2c gate keeps Grok dispatch open");
      for (const model of ["grok-4.7", "gpt-demo"]) {
        const channel = { ...cli, provider: "cursor", model };
        assert.equal(routeProfile({ ...input, profiles: [channel] }).ok, false);
        const checked = routeProfile({ ...current, profiles: [channel] });
        assert.equal(checked.ok, false);
        if (model === "gpt-demo" && !checked.ok) assert.match(checked.reason, /third-party.*paid/i);
      }
    }
    for (const disabled of ["supergrok", "x-ultra"]) {
      writeFileSync(join(root, "kanban.config.json"), JSON.stringify({ disabledPools: [disabled] }));
      const snapshot = readCompatibilityPoolSnapshot(now);
      for (const id of ["supergrok", "x-ultra"]) assert.equal(snapshot.entry(id).dispatchable, false, `${disabled} stops ${id}`);
    }
  }
});

test("a newer provider observation remains evidence when the CLI screen wins its legacy selector", () => {
  const newerProvider = { ...grok, usedPct: 22, sampledAt: at };
  const window = reconcileXUltraWindow(grok, null, now, newerProvider);
  assert.equal(window.usedPct, 22); assert.equal(window.sampledAt, at);
});
