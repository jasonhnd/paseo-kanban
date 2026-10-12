import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface PerformanceLoad {
  load: number[];
  cpus: number;
}

export function samplePerformanceLoad(): PerformanceLoad {
  return { load: loadavg(), cpus: availableParallelism() };
}

/** Only timing assertions are skipped; functional checks still run. */
export function performanceLoadGate(samples: PerformanceLoad[]): { skip: boolean; reason: string } {
  const shown = samples.map(({ load, cpus }) => `loadavg=[${load.map(n => n.toFixed(2)).join(",")}] availableCPUs=${cpus}`).join("; ");
  if (!samples.length || samples.some(({ load, cpus }) => load.length !== 3 || load.some(n => !Number.isFinite(n) || n < 0) || !Number.isInteger(cpus) || cpus <= 0)) {
    return { skip: true, reason: `Cannot measure machine load; skip timing threshold;${shown}` };
  }
  const overloaded = samples.some(({ load, cpus }) => load[0] / cpus > 1);
  return {
    skip: overloaded,
    reason: `${overloaded ? "High load: 1-minute load / available CPU > 1; skip timing threshold" : "CPU Load within limit (effective limit in PERFORMANCE IO row)"};${shown}`,
  };
}

/**
 * CPU-bound timing gates (board build, tick) also skip while the 5-minute load is above capacity: the
 * 1-minute average dips between bursts of other agents' work while the CPUs are still contended.
 */
export function cpuContentionGate(samples: PerformanceLoad[]): { skip: boolean; reason: string } {
  const gate = performanceLoadGate(samples);
  if (gate.skip) return gate;
  const sustained = samples.some(({ load, cpus }) => load[1] / cpus > 1);
  if (!sustained) return gate;
  return { skip: true, reason: `Sustained high load: 5-minute load / available CPU > 1; skip timing threshold;${gate.reason.split(";").slice(1).join(";")}` };
}

export function assertNativePerformance({ coldMs, batchMs, sweepMs, cliMs }: { coldMs: number; batchMs: number; sweepMs: number; cliMs: number }, scale = 1): void {
  assert.ok(coldMs < 200 * scale, `cold batch ${coldMs.toFixed(1)}ms (limit ${(200 * scale).toFixed(1)}ms)`);
  assert.ok(batchMs < 200 * scale, `batch hard limit ${batchMs.toFixed(1)}ms (limit ${(200 * scale).toFixed(1)}ms)`);
  assert.ok(batchMs < 50 * scale, `cached batch target ${batchMs.toFixed(1)}ms (limit ${(50 * scale).toFixed(1)}ms)`);
  assert.ok(sweepMs < 10_000, `sweep ${sweepMs.toFixed(1)}ms`);
  assert.ok(cliMs < 10_000, `CLI sweep ${cliMs.toFixed(1)}ms`);
}

/** Median of the I/O probe on an idle machine of the dev class (24 CPU Mac); measured, not a target. */
export const IO_PROBE_NOMINAL_MS = 12;
/**
 * Above this slowdown the gate skips instead of scaling. Scaling multiplies the 50ms margin too: with a
 * healthy cached batch of ~20ms, a +50ms regression (~70ms) hides under 50*scale once scale > ~1.7,
 * so a gate that still runs must stay close to idle where +50ms is distinguishable.
 */
export const IO_PROBE_MAX_SCALE = 1.4;
const IO_PROBE_RUNS = 5;

export interface IoCalibration {
  probeMs: number[];
  medianMs: number;
  scale: number;
  skip: boolean;
  reason: string;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Business-independent I/O probe of roughly the same shape as a cached batch:
 * a wide concurrent lstat sweep, a few small file reads and a handful of
 * separately committed SQLite writes on the same filesystem. Reports the median of several runs.
 */
export async function measureIoProbe(statPaths: string[], scratchDir: string): Promise<{ probeMs: number[]; medianMs: number }> {
  fs.mkdirSync(scratchDir, { recursive: true });
  const small = join(scratchDir, "probe.json"); fs.writeFileSync(small, "{}");
  const db = new DatabaseSync(join(scratchDir, "probe.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS probe(a INTEGER, b TEXT)");
  const probeMs: number[] = [];
  try {
    for (let run = 0; run < IO_PROBE_RUNS; run++) {
      const started = performance.now();
      await Promise.all(statPaths.map(path => fsPromises.lstat(path).catch(() => undefined)));
      for (let i = 0; i < 5; i++) await fsPromises.readFile(small, "utf8");
      // Separate commits: each one pays the fsync that a real batch pays per queue item.
      const insert = db.prepare("INSERT INTO probe VALUES (?, ?)");
      for (let i = 0; i < 10; i++) insert.run(i, "x".repeat(100));
      probeMs.push(performance.now() - started);
    }
  } finally { db.close(); }
  return { probeMs, medianMs: median(probeMs) };
}

/**
 * Scale the timing thresholds by how much slower this machine's raw I/O is right
 * now than the nominal idle probe (never below 1x, so thresholds never tighten).
 * A probe that is itself far too slow means a busy machine: skip with a reason.
 */
export function calibrateIo(probes: { probeMs: number[]; medianMs: number }[]): IoCalibration {
  const medianMs = Math.max(...probes.map(p => p.medianMs));
  const scale = Math.max(1, medianMs / IO_PROBE_NOMINAL_MS);
  const shown = `probe runs=[${probes.flatMap(p => p.probeMs).map(n => n.toFixed(1)).join(",")}]ms worst-median=${medianMs.toFixed(1)}ms nominal=${IO_PROBE_NOMINAL_MS}ms scale=${scale.toFixed(2)}x`;
  const skip = !Number.isFinite(scale) || scale > IO_PROBE_MAX_SCALE;
  return { probeMs: probes.flatMap(p => p.probeMs), medianMs, scale, skip, reason: skip ? `I/O Slow baseline (>${IO_PROBE_MAX_SCALE}x); machine busy; skip timing threshold;${shown}` : `I/O Baseline calibration;${shown}` };
}
