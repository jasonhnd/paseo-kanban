import { setLanguage } from "../shared/fleet/i18n";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalPoolId, mergeXUltraPlans, resolveXUltraReading, xUltraReservePct } from "../shared/fleet/x-ultra";
import { rankPools, withPoolRankingMetadata } from "../shared/fleet/pool-ranking";
import { plansSchema } from "../shared/fleet/settings";
import { poolCatalog } from "../shared/fleet/quota-adapters";
import { forecastPool } from "../server/fleet/pool-forecast";
import { runsInSpan } from "../server/fleet/quota-history";

setLanguage("en");
const now = Date.parse("2030-06-01T12:00:00Z");
const reset = "2030-06-07T12:00:00Z";
const stamp = (ago: number) => new Date(now - ago * 60_000).toISOString();
const reading = (usedPct = 21, ago = 0) => ({ usedPct, resetsAt: reset, observedAt: stamp(ago) });

test("old plans parse and migrate in memory to one weekly X Ultra seat without monthly leftovers", () => {
  const document = plansSchema.parse({ plans: [
    { id: "supergrok", name: "Old", providers: ["grok"], priceUsdMonthly: 300, dispatch: true },
    { id: "cursor", name: "Old bundle", adapter: "cursor-api", providers: ["cursor"], dispatch: false,
      cycleDay: 12, manual: { usedPct: 1, at: stamp(10) } },
  ] });
  const before = structuredClone(document);
  const plans = mergeXUltraPlans(document.plans);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, "x-ultra");
  assert.equal(plans[0].name, "X Ultra");
  assert.equal(plans[0].priceUsdMonthly, 200);
  assert.equal(plans[0].cycleDay, undefined);
  assert.equal(plans[0].manual, undefined);
  assert.equal(plans[0].dispatch, true);
  assert.deepEqual(plans[0].providers, ["grok", "cursor"]);
  assert.deepEqual(poolCatalog(plans).map(p => [p.id, p.period]), [["x-ultra", "week"]]);
  assert.deepEqual(document, before);
  assert.equal(canonicalPoolId("supergrok"), "x-ultra");
  assert.equal(canonicalPoolId("cursor"), "x-ultra");
  assert.equal(canonicalPoolId("demo"), "demo");
});

test("source clocks select the newest consistent reading; ambiguous evidence is unknown", () => {
  assert.deepEqual(resolveXUltraReading([reading(20, 10), reading(21)], now), { ...reading(), state: "known", reason: null });
  for (const sources of [
    [reading(23, 10), reading(21)], // decreases beyond rounding tolerance conflict
    [reading(20), reading(21)], // same clock, different value
    [reading(20), { ...reading(21), observedAt: "2030-06-01T21:00:00+09:00" }],
    [reading(), { ...reading(22), resetsAt: "2030-06-08T12:00:00Z" }],
  ]) {
    const result = resolveXUltraReading(sources, now);
    assert.equal(result.state, "unknown");
    assert.equal(result.usedPct, null);
    assert.match(result.reason!, /conflict/i);
  }
  assert.equal(resolveXUltraReading([reading(99, 180)], now).state, "unknown");
  assert.equal(resolveXUltraReading([{ ...reading(), observedAt: stamp(-5) }], now).state, "unknown");
  assert.equal(resolveXUltraReading([reading(), { ...reading(99), resetsAt: stamp(1) }], now).usedPct, 21);
});

test("newer same-cycle readings tolerate at most one percentage point of rounding", () => {
  for (const usedPct of [21.64, 22]) {
    assert.deepEqual(resolveXUltraReading([reading(usedPct, 10), reading(21)], now),
      { ...reading(21), state: "known", reason: null });
  }
  for (const newer of [reading(19), reading(20.63)]) {
    const result = resolveXUltraReading([reading(21.64, 10), newer], now);
    assert.equal(result.state, "unknown");
    assert.equal(result.usedPct, null);
    assert.match(result.reason!, /conflict/i);
  }
});

test("reserves require both user decisions; schema rejects invalid totals and ranking preserves hard stops", () => {
  assert.equal(xUltraReservePct(undefined), null);
  assert.equal(xUltraReservePct({ botPct: 10, userPct: null }), null);
  assert.equal(xUltraReservePct({ botPct: 10, userPct: 15 }), 25);
  const base = { id: "x-ultra", name: "X Ultra" };
  for (const xUltraReserve of [{ botPct: -1, userPct: 10 }, { botPct: 70, userPct: 40 }]) {
    assert.equal(plansSchema.safeParse({ plans: [{ ...base, xUltraReserve }] }).success, false);
  }
  const pools = { "x-ultra": { ...reading(), dispatchable: true, state: "known" as const } };
  const rank = (plans: any[], tier = "L4", activeRuns = {}) => rankPools({ pools: withPoolRankingMetadata(pools, plans, activeRuns), now, tier, role: "executor" });
  assert.deepEqual(rank([base]), []);
  assert.deepEqual(rank([base], "L1")[0].allowedTiers, ["L1", "L2"]);
  assert.deepEqual(rank([base], "L1", { supergrok: 1 }), []);
  assert.equal(rank([{ ...base, xUltraReserve: { botPct: 10, userPct: 15 } }]).length, 1);
  assert.deepEqual(rank([{ ...base, xUltraReserve: { botPct: 40, userPct: 40 } }]), []);
});

test("ranking deduplicates old aliases and accounting attributes both channels to the same pool", () => {
  const pools = withPoolRankingMetadata({ supergrok: { ...reading(20, 10), dispatchable: true }, cursor: { ...reading(), dispatchable: true } },
    [{ id: "supergrok", xUltraReserve: { botPct: 5, userPct: 5 } }]);
  const ranked = rankPools({ pools, now, tier: "L2", role: "executor" });
  assert.deepEqual(ranked.map(r => r.pool), ["x-ultra"]);
  assert.equal(runsInSpan([{ profile: "CLI", at: stamp(1) }, { profile: "Bot", at: stamp(1) }],
    [{ name: "CLI", pool: "supergrok" }, { name: "Bot", pool: "cursor" }], "x-ultra", now - 60_000, now), 2);
  const forecast = forecastPool({ ...reading(), periodDays: 7 }, [
    { at: stamp(30), pools: { supergrok: reading(18, 30) } },
  ], "x-ultra", now);
  assert.equal(forecast.forecastConfidence, "low");
});

test("current quota routing and cost queries preserve reserves and legacy pool identity", async () => {
  const { routingReserve } = await import("../server/quota-routing");
  const { estimateRunCost } = await import("../shared/fleet/run-cost");
  const row = { dispatchable: true, reservePct: 35 };
  assert.equal(routingReserve("x-ultra", row, { reserves: { supergrok: 0 } }), 35);
  assert.equal(routingReserve("supergrok", row, { reserves: { "x-ultra": 0 } }), 35);
  assert.equal(routingReserve("x-ultra", row, { reserves: { supergrok: 70 } }), 70);
  const cost = estimateRunCost([{ runId: 99, source: "measured", model: "grok-demo", effort: "low", cardType: "read", pool: "supergrok", quotaPctDelta: 1 }],
    { model: "grok-demo", effort: "low", cardType: "read", pool: "x-ultra" });
  assert.equal(cost.avgQuotaPct, 1); assert.equal(cost.quotaSamples, 1);
});
