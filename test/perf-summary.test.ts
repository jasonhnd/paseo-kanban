/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { existsSync } from "../server/perf-fs";
import {
  PERF_KEEP,
  appendPerfSummary,
  countIo,
  flushPerf,
  perfLogLine,
  perfSummaryPath,
  resetPerfForTests,
  round,
  stage,
  takePerfSummary,
} from "../server/perf";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "perf-summary-"));
const previous = process.env.KANBAN_DATA_DIR;
process.env.KANBAN_DATA_DIR = dir;

beforeEach(() => resetPerfForTests());

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = previous;
});

describe("round and stage timing", () => {
  it("adds stages and I/O to the round they ran in, for sync and async work", async () => {
    await round("tick", async () => {
      stage("tick.a", () => countIo("exists"));
      await stage("tick.b", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        countIo("readdir");
      });
      stage("tick.a", () => undefined);
    });
    const summary = takePerfSummary()!;
    const tick = summary.loops.tick!;
    assert.equal(tick.rounds, 1);
    assert.equal(tick.stages["tick.a"]!.calls, 2);
    assert.ok(tick.stages["tick.b"]!.ms >= 4);
    assert.deepEqual({ exists: tick.io.exists, readdir: tick.io.readdir }, { exists: 1, readdir: 1 });
    assert.equal(tick.slowest?.io.exists, 1);
    assert.ok(tick.maxMs >= tick.stages["tick.b"]!.ms);
  });

  it("keeps overlapping rounds apart", async () => {
    await Promise.all([
      round("one", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        countIo("stat");
      }),
      round("two", async () => {
        countIo("readFile");
        countIo("readFile");
      }),
    ]);
    const loops = takePerfSummary()!.loops;
    assert.equal(loops.one!.io.stat, 1);
    assert.equal(loops.one!.io.readFile, 0);
    assert.equal(loops.two!.io.readFile, 2);
  });

  it("passes results and errors through and still records the stage", async () => {
    assert.equal(stage("x.sync", () => 7), 7);
    await assert.rejects(round("r", () => stage("x.async", async () => { throw new Error("boom"); })), /boom/);
    assert.throws(() => stage("x.throw", () => { throw new Error("sync boom"); }), /sync boom/);
    const summary = takePerfSummary()!;
    assert.equal(summary.loops.r!.rounds, 1);
    assert.equal(summary.loops.r!.stages["x.async"]!.calls, 1);
    assert.equal(summary.loops.other!.stages["x.sync"]!.calls, 1);
    assert.equal(summary.loops.other!.stages["x.throw"]!.calls, 1);
  });

  it("counts counted fs calls and sqlite statements", () => {
    getDb();
    resetPerfForTests();
    round("io", () => {
      existsSync(dir);
      getDb().prepare("SELECT 1 AS one").get();
      getDb().prepare("SELECT 1 AS one").get();
    });
    const io = takePerfSummary()!.loops.io!.io;
    assert.equal(io.exists, 1);
    assert.equal(io.sql, 2);
  });

  it("returns nothing when no round ran", () => {
    assert.equal(takePerfSummary(), null);
  });
});

describe("summary output", () => {
  it("formats one log line and appends to perf-summary.json, keeping only the newest entries", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    try {
      for (let i = 0; i < PERF_KEEP + 3; i += 1) {
        round("tick", () => stage("tick.reconcile", () => countIo("exists")));
        flushPerf(Date.now() + i);
      }
    } finally {
      console.log = log;
    }
    assert.equal(lines.length, PERF_KEEP + 3);
    assert.match(lines[0]!, /^\[paseo-kanban\] perf window=\d+s processCpu=[\d.]+% tick\{rounds=1 total=[\d.]+ms cpu=[\d.]+ms max=[\d.]+ms stages: tick\.reconcile=[\d.]+ms\/1 io: exists=1\}/);
    const saved = JSON.parse(readFileSync(perfSummaryPath(), "utf8")) as { summaries: Array<{ loops: Record<string, { rounds: number }> }> };
    assert.equal(saved.summaries.length, PERF_KEEP);
    assert.equal(saved.summaries.at(-1)!.loops.tick!.rounds, 1);
  });

  it("writes nothing to the events table", () => {
    const before = getDb().prepare("SELECT COUNT(*) AS n FROM events").get()!.n;
    round("tick", () => stage("tick.x", () => undefined));
    flushPerf();
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events").get()!.n, before);
  });

  it("survives a damaged summary file and an empty window", () => {
    appendPerfSummary({ at: "2026-10-03T00:00:00.000Z", windowMs: 1, processCpuPct: 0, loops: {} });
    assert.ok(perfLogLine({ at: "x", windowMs: 1000, processCpuPct: 1, loops: {} }).includes("perf window=1s"));
    assert.equal(flushPerf(), null);
  });
});
