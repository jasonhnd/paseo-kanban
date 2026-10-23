import assert from "node:assert/strict";
import { test } from "node:test";
import { forecastPool, recentReadings } from "../pool-forecast";
import type { HistorySample } from "../quota-history";

const H = 3_600_000;
const now = Date.parse("2030-01-02T12:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
const reset = iso(now + 10 * H);
const pool = { usedPct: 30, resetsAt: reset, periodDays: 7, observedAt: iso(now) };
const sample = (hoursAgo: number, usedPct: number | null, resetsAt = reset): HistorySample => ({
  at: iso(now - hoursAgo * H), pools: { demo: { usedPct, resetsAt } },
});

test("uniform consumption projects usage and exhaustion before reset", () => {
  const forecast = forecastPool(pool, [sample(2, 10), sample(1, 20), sample(0, 30)], "demo", now);
  assert.deepEqual(forecast, { burnRatePctPerHour: 10, projectedPct: 130, runsOutAt: iso(now + 7 * H), forecastConfidence: "high" });
});

test("a sudden jump changes the recent rate but lowers confidence", () => {
  const forecast = forecastPool(pool, [sample(2, 10), sample(1, 11), sample(0, 30)], "demo", now);
  assert.equal(forecast.burnRatePctPerHour, 10);
  assert.equal(forecast.forecastConfidence, "low");
});

test("new reset and a percent decrease discard previous cycle samples", () => {
  assert.equal(forecastPool(pool, [sample(2, 80, iso(now - H)), sample(0, 30)], "demo", now).forecastConfidence, "none");
  assert.equal(forecastPool(pool, [sample(2, 80), sample(1, 90), sample(0, 30)], "demo", now).forecastConfidence, "none");
});

test("missing readings and long gaps cannot be extrapolated", () => {
  for (const samples of [[sample(3, 10), sample(0, 30)], [sample(2, 10), sample(1, null), sample(0, 30)]]) {
    assert.equal(forecastPool(pool, samples, "demo", now).forecastConfidence, "none");
  }
  assert.equal(forecastPool({ ...pool, observedAt: iso(now - H) }, [sample(2, 10), sample(1, 30)], "demo", now).forecastConfidence, "none");
});

test("insufficient, duplicate, invalid and future readings stay unknown", () => {
  for (const samples of [[], [sample(0, 30)], [sample(0, 30), sample(0, 30)], [sample(-1, 40)]]) {
    assert.deepEqual(forecastPool(pool, samples, "demo", now), { burnRatePctPerHour: null, projectedPct: null, runsOutAt: null, forecastConfidence: "none" });
  }
});

test("flat usage projects current percent without inventing an exhaustion time", () => {
  const forecast = forecastPool(pool, [sample(2, 30), sample(1, 30), sample(0, 30)], "demo", now);
  assert.equal(forecast.burnRatePctPerHour, 0);
  assert.equal(forecast.projectedPct, 30);
  assert.equal(forecast.runsOutAt, null);
});

test("recent history is bounded and repeated source timestamps do not create evidence", () => {
  const pools = { demo: pool };
  const first = recentReadings([], pools, now);
  assert.equal(recentReadings(first, pools, now + H / 12).length, 1);
  const many = Array.from({ length: 2200 }, (_, i) => sample(i / 12, 10));
  assert.ok(recentReadings(many, pools, now).length <= 2016);
});

test("conflicting readings at one source timestamp break the evidence chain", () => {
  assert.equal(forecastPool(pool, [sample(2, 20), sample(1, 25), sample(1, 26), sample(0, 30)], "demo", now).forecastConfidence, "none");
});

test("a fresh reading contributes even between persisted sampling slots", () => {
  const result = forecastPool(pool, [sample(2, 10), sample(1, 20)], "demo", now);
  assert.equal(result.burnRatePctPerHour, 10);
  assert.equal(result.forecastConfidence, "high");
});

test("an unread source timestamp breaks the series at its collection time", () => {
  const missing = sample(1, null);
  missing.pools.demo.observedAt = null;
  assert.equal(forecastPool(pool, [sample(2, 10), missing, sample(0, 30)], "demo", now).forecastConfidence, "none");
});
