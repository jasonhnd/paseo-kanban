/// <reference types="node" />
import { AsyncLocalStorage } from "node:async_hooks";
import { tightenFile } from "./data-perms";
import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";
import { setIoSink } from "./perf-count";

/**
 * Per-round timing for the scheduler tick, the cleanup round and board/detail RPCs.
 *
 * Nothing here writes per round. Stage and I/O counters accumulate in memory; every
 * PERF_WINDOW_MS one summary line goes to the plugin log and one entry is appended to
 * data/perf-summary.json (newest PERF_KEEP kept). Nothing is written to the events table.
 */
export type IoKind = "exists" | "readdir" | "readFile" | "stat" | "sql";
const IO_KINDS: IoKind[] = ["exists", "readdir", "readFile", "stat", "sql"];

export const PERF_WINDOW_MS = 5 * 60_000;
export const PERF_KEEP = 24;
const SLOWEST_STAGE_LIMIT = 12;

interface StageAcc {
  ms: number;
  cpuMs: number;
  calls: number;
  maxMs: number;
}

type IoCounts = Record<IoKind, number>;

interface RoundCtx {
  loop: string;
  stages: Map<string, StageAcc>;
  io: IoCounts;
}

interface SlowestRound {
  ms: number;
  stages: Record<string, number>;
  io: IoCounts;
}

interface LoopAcc {
  rounds: number;
  totalMs: number;
  cpuMs: number;
  maxMs: number;
  slowest: SlowestRound | null;
  stages: Map<string, StageAcc>;
  io: IoCounts;
}

export interface PerfStageSummary {
  ms: number;
  cpuMs: number;
  calls: number;
  maxMs: number;
}

export interface PerfLoopSummary {
  rounds: number;
  totalMs: number;
  cpuMs: number;
  maxMs: number;
  slowest: SlowestRound | null;
  stages: Record<string, PerfStageSummary>;
  io: IoCounts;
}

export interface PerfSummary {
  at: string;
  windowMs: number;
  /** User+system CPU of the whole host process over the window, as a percentage of one core. */
  processCpuPct: number;
  loops: Record<string, PerfLoopSummary>;
}

const als = new AsyncLocalStorage<RoundCtx>();
const loops = new Map<string, LoopAcc>();
let windowStart = Date.now();
let windowCpu = process.cpuUsage();

function zeroIo(): IoCounts {
  return { exists: 0, readdir: 0, readFile: 0, stat: 0, sql: 0 };
}

function loopAcc(name: string): LoopAcc {
  let acc = loops.get(name);
  if (!acc) {
    acc = { rounds: 0, totalMs: 0, cpuMs: 0, maxMs: 0, slowest: null, stages: new Map(), io: zeroIo() };
    loops.set(name, acc);
  }
  return acc;
}

function addStage(into: Map<string, StageAcc>, name: string, ms: number, cpuMs: number): void {
  const acc = into.get(name);
  if (acc) {
    acc.ms += ms;
    acc.cpuMs += cpuMs;
    acc.calls += 1;
    if (ms > acc.maxMs) acc.maxMs = ms;
  } else {
    into.set(name, { ms, cpuMs, calls: 1, maxMs: ms });
  }
}

function cpuMsSince(start: NodeJS.CpuUsage): number {
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** Count one synchronous I/O call against the running round, or against "other" outside any round. */
export function countIo(kind: IoKind): void {
  const ctx = als.getStore();
  if (ctx) ctx.io[kind] += 1;
  else loopAcc("other").io[kind] += 1;
}

setIoSink(countIo);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function";
}

/** Time one stage. Works for sync and async callbacks; the result and any throw pass through unchanged. */
export function stage<T>(name: string, fn: () => T): T {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const finish = (): void => {
    const ms = performance.now() - started;
    const cpuMs = cpuMsSince(cpu);
    const ctx = als.getStore();
    addStage(ctx ? ctx.stages : loopAcc("other").stages, name, ms, cpuMs);
  };
  let result: T;
  try {
    result = fn();
  } catch (err) {
    finish();
    throw err;
  }
  if (isThenable(result)) {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        finish();
        return value;
      },
      (err: unknown) => {
        finish();
        throw err;
      },
    ) as T;
  }
  finish();
  return result;
}

function endRound(ctx: RoundCtx, ms: number, cpuMs: number): void {
  const acc = loopAcc(ctx.loop);
  acc.rounds += 1;
  acc.totalMs += ms;
  acc.cpuMs += cpuMs;
  for (const [name, stat] of ctx.stages) {
    const into = acc.stages.get(name);
    if (into) {
      into.ms += stat.ms;
      into.cpuMs += stat.cpuMs;
      into.calls += stat.calls;
      if (stat.maxMs > into.maxMs) into.maxMs = stat.maxMs;
    } else {
      acc.stages.set(name, { ...stat });
    }
  }
  for (const kind of IO_KINDS) acc.io[kind] += ctx.io[kind];
  if (ms > acc.maxMs) {
    acc.maxMs = ms;
    const stages: Record<string, number> = {};
    for (const [name, stat] of ctx.stages) stages[name] = round1(stat.ms);
    acc.slowest = { ms: round1(ms), stages, io: { ...ctx.io } };
  }
}

/** Run one scheduler tick / cleanup round / RPC as a measured round. Stages and I/O inside it are attributed to it. */
export function round<T>(loop: string, fn: () => T): T {
  const ctx: RoundCtx = { loop, stages: new Map(), io: zeroIo() };
  const started = performance.now();
  const cpu = process.cpuUsage();
  const finish = (): void => endRound(ctx, performance.now() - started, cpuMsSince(cpu));
  let result: T;
  try {
    result = als.run(ctx, fn);
  } catch (err) {
    finish();
    throw err;
  }
  if (isThenable(result)) {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        finish();
        return value;
      },
      (err: unknown) => {
        finish();
        throw err;
      },
    ) as T;
  }
  finish();
  return result;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Snapshot the window and start a new one. Returns null when nothing ran. */
export function takePerfSummary(now = Date.now()): PerfSummary | null {
  const windowMs = now - windowStart;
  const cpu = process.cpuUsage(windowCpu);
  const processCpuPct = windowMs > 0 ? ((cpu.user + cpu.system) / 1000 / windowMs) * 100 : 0;
  const out: Record<string, PerfLoopSummary> = {};
  for (const [name, acc] of loops) {
    const stages: Record<string, PerfStageSummary> = {};
    for (const [stageName, stat] of acc.stages) {
      stages[stageName] = { ms: round1(stat.ms), cpuMs: round1(stat.cpuMs), calls: stat.calls, maxMs: round1(stat.maxMs) };
    }
    out[name] = {
      rounds: acc.rounds,
      totalMs: round1(acc.totalMs),
      cpuMs: round1(acc.cpuMs),
      maxMs: round1(acc.maxMs),
      slowest: acc.slowest,
      stages,
      io: { ...acc.io },
    };
  }
  loops.clear();
  windowStart = now;
  windowCpu = process.cpuUsage();
  if (Object.keys(out).length === 0) return null;
  return { at: new Date(now).toISOString(), windowMs, processCpuPct: round1(processCpuPct), loops: out };
}

/** One log line: per loop, rounds, total and slowest, the top stages, and I/O counts. */
export function perfLogLine(summary: PerfSummary): string {
  const parts = Object.entries(summary.loops).map(([name, loop]) => {
    const top = Object.entries(loop.stages)
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, SLOWEST_STAGE_LIMIT)
      .map(([stageName, stat]) => `${stageName}=${stat.ms}ms/${stat.calls}`)
      .join(" ");
    const io = IO_KINDS.filter((kind) => loop.io[kind] > 0).map((kind) => `${kind}=${loop.io[kind]}`).join(" ");
    return `${name}{rounds=${loop.rounds} total=${loop.totalMs}ms cpu=${loop.cpuMs}ms max=${loop.maxMs}ms${top ? ` stages: ${top}` : ""}${io ? ` io: ${io}` : ""}}`;
  });
  return `[paseo-kanban] perf window=${Math.round(summary.windowMs / 1000)}s processCpu=${summary.processCpuPct}% ${parts.join(" ")}`;
}

export function perfSummaryPath(): string {
  return join(dataDir(), "perf-summary.json");
}

/** Append to data/perf-summary.json, keeping only the newest PERF_KEEP entries. */
export function appendPerfSummary(summary: PerfSummary): void {
  const file = perfSummaryPath();
  let existing: PerfSummary[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { summaries?: PerfSummary[] };
    if (Array.isArray(parsed.summaries)) existing = parsed.summaries;
  } catch {
    existing = [];
  }
  const next = [...existing, summary].slice(-PERF_KEEP);
  mkdirSync(dataDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ summaries: next }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  tightenFile(file);
}

/** Close the window: one log line and one JSON entry. A write failure is logged, never thrown. */
export function flushPerf(now = Date.now()): PerfSummary | null {
  const summary = takePerfSummary(now);
  if (!summary) return null;
  console.log(perfLogLine(summary));
  try {
    appendPerfSummary(summary);
  } catch (err) {
    console.error("[paseo-kanban] perf summary file", err instanceof Error ? err.message : err);
  }
  return summary;
}

let reporter: ReturnType<typeof setInterval> | null = null;

/** Start the 5-minute report timer once per process. Returns a stop function. */
export function startPerfReporter(intervalMs = PERF_WINDOW_MS): () => void {
  if (reporter) clearInterval(reporter);
  windowStart = Date.now();
  windowCpu = process.cpuUsage();
  const timer = setInterval(() => {
    try {
      flushPerf();
    } catch (err) {
      console.error("[paseo-kanban] perf", err instanceof Error ? err.message : err);
    }
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  reporter = timer;
  return () => {
    if (reporter === timer) {
      clearInterval(timer);
      reporter = null;
    }
  };
}

export function resetPerfForTests(): void {
  loops.clear();
  windowStart = Date.now();
  windowCpu = process.cpuUsage();
}
