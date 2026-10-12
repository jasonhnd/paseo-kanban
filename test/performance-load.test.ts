import assert from "node:assert/strict";
import { it } from "node:test";
import { assertNativePerformance, calibrateIo, cpuContentionGate, IO_PROBE_MAX_SCALE, IO_PROBE_NOMINAL_MS, performanceLoadGate } from "./helpers/performance-load";

it("retains timing gates at low load, including the one-load-per-CPU boundary", () => {
  for (const load of [0, 2, 8]) {
    const gate = performanceLoadGate([{ load: [load, 40, 60], cpus: 8 }]);
    assert.equal(gate.skip, false);
    assert.match(gate.reason, /CPU Load within limit.*PERFORMANCE IO/);
    assert.match(gate.reason, /loadavg=.*availableCPUs=8/);
  }
});
it("skips with a visible reason above available CPU capacity, including a mid-run spike", () => {
  const gate = performanceLoadGate([{ load: [1, 1, 1], cpus: 8 }, { load: [40, 50, 60], cpus: 8 }]);
  assert.equal(gate.skip, true);
  assert.match(gate.reason, /High load.*skip timing threshold/);
  assert.match(gate.reason, /loadavg=\[40.00,50.00,60.00\] availableCPUs=8/);
  assert.equal(performanceLoadGate([{ load: [2, 2, 2], cpus: 1 }]).skip, true);
});
it("does not silently enforce or pass a gate when load cannot be measured", () => {
  for (const samples of [[], [{ load: [NaN, 0, 0], cpus: 8 }], [{ load: [0, 0, 0], cpus: 0 }], [{ load: [], cpus: 8 }]]) {
    const gate = performanceLoadGate(samples);
    assert.equal(gate.skip, true);
    assert.match(gate.reason, /Cannot measure machine load.*skip timing threshold/);
  }
});

it("original low-load limits still reject slow measurements instead of relaxing them", () => {
  const fast = { coldMs: 199, batchMs: 49, sweepMs: 9999, cliMs: 9999 };
  assert.doesNotThrow(() => assertNativePerformance(fast));
  for (const [key, value] of [["coldMs", 200], ["batchMs", 50], ["sweepMs", 10000], ["cliMs", 10000]] as const) {
    assert.throws(() => assertNativePerformance({ ...fast, [key]: value }), assert.AssertionError);
  }
});

it("I/O calibration never tightens, scales limits with a slow probe and skips with a reason when far too slow", () => {
  const probe = (ms: number) => ({ probeMs: [ms, ms, ms], medianMs: ms });
  const idle = calibrateIo([probe(IO_PROBE_NOMINAL_MS / 2), probe(IO_PROBE_NOMINAL_MS)]);
  assert.equal(idle.scale, 1); assert.equal(idle.skip, false);
  const busy = calibrateIo([probe(IO_PROBE_NOMINAL_MS), probe(IO_PROBE_NOMINAL_MS * 1.25)]);
  assert.equal(busy.scale, 1.25); assert.equal(busy.skip, false); assert.match(busy.reason, /scale=1\.25x/);
  const swamped = calibrateIo([probe(IO_PROBE_NOMINAL_MS * (IO_PROBE_MAX_SCALE + 1))]);
  assert.equal(swamped.skip, true); assert.match(swamped.reason, /I\/O Slow baseline.*skip timing threshold/);
  assert.equal(calibrateIo([probe(NaN)]).skip, true);
});
it("scaled limits accept a proportionally slower run but still reject a regression beyond the scale", () => {
  assert.doesNotThrow(() => assertNativePerformance({ coldMs: 399, batchMs: 99, sweepMs: 1, cliMs: 1 }, 2));
  assert.throws(() => assertNativePerformance({ coldMs: 1, batchMs: 101, sweepMs: 1, cliMs: 1 }, 2), /cached batch target/);
  assert.throws(() => assertNativePerformance({ coldMs: 1, batchMs: 70, sweepMs: 1, cliMs: 1 }), /cached batch target/);
});

it("CPU-bound gates skip while the 5-minute load stays above capacity even if the 1-minute load dipped", () => {
  const dipped = [{ load: [3, 29, 28], cpus: 24 }];
  assert.equal(performanceLoadGate(dipped).skip, false);
  const gate = cpuContentionGate(dipped);
  assert.equal(gate.skip, true);
  assert.match(gate.reason, /Sustained high load.*skip timing threshold/);
  assert.match(gate.reason, /loadavg=\[3.00,29.00,28.00\] availableCPUs=24/);
  assert.equal(cpuContentionGate([{ load: [3, 20, 28], cpus: 24 }]).skip, false);
});
