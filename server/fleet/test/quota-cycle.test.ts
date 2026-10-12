import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cycleBounds, cycleKey, manualState, quotaCycleSchema, type QuotaCycle } from "../../../shared/fleet/quota-cycle";
const bounds = (cycle: QuotaCycle, now: string) => {
  const row = cycleBounds(cycle, Date.parse(now));
  return row && [new Date(row.start).toISOString(), new Date(row.end).toISOString()];
};
test("monthly resets clamp 29-31 while retaining the configured day", () => {
  for (const day of [29, 30, 31]) {
    const cycle: QuotaCycle = { kind: "month", day, timeZone: "UTC", hour: 0, minute: 0 };
    assert.deepEqual(bounds(cycle, "2025-02-28T12:00:00Z"), ["2025-02-28T00:00:00.000Z", `2025-03-${day}T00:00:00.000Z`]);
    assert.equal(bounds(cycle, "2024-02-29T12:00:00Z")?.[0], "2024-02-29T00:00:00.000Z");
  }
});
test("daily and weekly wall clocks honor DST and UTC", () => {
  const day: QuotaCycle = { kind: "day", timeZone: "America/New_York", hour: 0, minute: 0 };
  assert.deepEqual(bounds(day, "2026-03-08T18:00:00Z"), ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  assert.deepEqual(bounds(day, "2026-11-01T18:00:00Z"), ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  assert.deepEqual(bounds({ ...day, hour: 2, minute: 30 }, "2026-03-08T12:00:00Z"), ["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
  assert.equal(bounds({ ...day, hour: 1, minute: 30 }, "2026-11-01T12:00:00Z")?.[0], "2026-11-01T05:30:00.000Z");
  assert.deepEqual(bounds({ kind: "week", weekday: 0, timeZone: day.timeZone, hour: 0, minute: 0 }, "2026-03-04T12:00:00Z"), ["2026-03-01T05:00:00.000Z", "2026-03-08T05:00:00.000Z"]);
  assert.deepEqual(bounds({ kind: "day", timeZone: "UTC", hour: 0, minute: 0 }, "2026-03-08T00:00:00Z"), ["2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"]);
});
test("fixed durations repeat from an explicit anchor; unknown has no pace", () => {
  assert.deepEqual(bounds({ kind: "duration", seconds: 3600, startsAt: "2026-01-01T00:00:00Z" }, "2026-01-01T01:30:00Z"), ["2026-01-01T01:00:00.000Z", "2026-01-01T02:00:00.000Z"]);
  assert.equal(cycleBounds({ kind: "unknown" }, Date.now()), null);
  assert.equal(quotaCycleSchema.safeParse({ kind: "day", timeZone: "Invalid/Zone", hour: 0, minute: 0 }).success, false);
});
test("manual readings expire on age, reset, future timestamps, cycle edits and invalid numbers", () => {
  const cycle: QuotaCycle = { kind: "day", timeZone: "UTC", hour: 0, minute: 0 };
  const now = Date.parse("2026-01-02T12:00:00Z");
  const reading = { usedPct: 0, at: "2026-01-02T11:00:00Z", cycleKey: cycleKey(cycle) };
  assert.equal(manualState(reading, cycle, now).state, "manual");
  for (const changed of [{ at: "2026-01-01T23:59:00Z" }, { at: "2026-01-02T13:00:00Z" }, { ttlSeconds: 60 }, { resetsAt: "2026-01-02T12:00:00Z" }]) assert.equal(manualState({ ...reading, ...changed }, cycle, now).state, "stale");
  assert.equal(manualState(reading, { ...cycle, timeZone: "America/New_York" }, now).state, "stale");
  for (const usedPct of [NaN, Infinity, -1, 101, null]) assert.equal(manualState({ ...reading, usedPct }, cycle, now).state, "unknown");
  assert.equal(manualState({ usedPct: 12, at: "2026-01-02T11:00:00Z" }, { kind: "unknown" }, now).bounds, null);
});
