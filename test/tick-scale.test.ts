/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONCURRENCY, type KanbanConfig } from "../server/config";
import { enqueueCleanups, flushCleanups, installCleanup, RECONCILE_ATTENTION_CAP, RECONCILE_SWEEP_CHUNK } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { boardExtras } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { snapshotFromRecord } from "../server/paseo";
import { doctorReds } from "../server/doctor-board";
import { round, stage, takePerfSummary } from "../server/perf";
import type { PoolSnapshot } from "../server/pools";
import { projectRows } from "../server/project-rows";
import type { Profile } from "../server/profiles";
import { boardSnapshot, createTask, getDetail } from "../server/store";
import { calibrateIo, cpuContentionGate, measureIoProbe, samplePerformanceLoad, type PerformanceLoad } from "./helpers/performance-load";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "tick-scale-"));
const agentsDir = join(dir, "agents");
mkdirSync(agentsDir, { recursive: true });
const previous = {
  data: process.env.KANBAN_DATA_DIR,
  agents: process.env.KANBAN_AGENTS_DIR,
  ttl: process.env.KANBAN_AGENT_INDEX_TTL_MS,
};
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agentsDir;
// Production keeps the bucket index for a second; the default under test is zero.
process.env.KANBAN_AGENT_INDEX_TTL_MS = "1000";

/** The board this models: 800 finished cards, 40k events, 600 agent records. */
const FINISHED = 800;
const STILL_DONE = 280;
const ACTIVE = 12;
const EVENTS_PER_CARD = 50;
const AGENT_RECORDS = 600;
/** A few leaders created most cards; each card asks for its creator's title twice. */
const LEADERS = 5;
/** One board build reads each leader title once plus a few fixed files, far below one read per card. */
const BOARD_READ_BUDGET = 40;
const BOARD_CARDS = STILL_DONE + ACTIVE;
const TICK_LIMIT_MS = 200;
/**
 * The RPC budget for one board build. A healthy build takes ~20ms here, and ~60-80ms even when the
 * process is confined to efficiency cores; it used to measure ~105ms only because the test isolation
 * guard re-resolved the data directory on every getDb() call (TEST_0310). Keep this budget, not a looser one.
 */
const BOARD_LIMIT_MS = 100;
const STEADY_ROUNDS = 3;
const MIN = 60_000;

const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];
const pools: PoolSnapshot = {
  state: "fresh",
  message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
  generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};
const config: KanbanConfig = {
  autoStart: { scale: false },
  supervisorAgentId: null,
  supervisors: {},
  concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
};

let inspected = 0;

function writeAgentRecord(agentId: string, bucket: string, extra: Record<string, unknown> = {}): void {
  const folder = join(agentsDir, bucket);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${agentId}.json`),
    JSON.stringify({ id: agentId, cwd: `/tmp/${bucket}`, title: `agent ${agentId}`, lastStatus: "idle", archivedAt: "2026-09-01T00:00:00.000Z", ...extra }),
  );
}

function buildFixture(): void {
  const db = getDb();
  const ago = new Date(Date.now() - 600 * MIN).toISOString();
  const verifyAt = new Date(Date.now() - 500 * MIN).toISOString();
  const insertEvent = db.prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertRun = db.prepare(
    ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n     VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
  );
  let records = 0;
  for (let n = 0; n < LEADERS; n += 1) writeAgentRecord(`scale-leader-${n}`, `leaders`, { archivedAt: null });
  db.exec("BEGIN");
  try {
    for (let i = 0; i < FINISHED; i += 1) {
      const task = createTask({ project: "scale", title: `finished ${i}`, role: "executor", workspacePath: dir });
      const agentId = `scale-agent-${i}`;
      // Cards whose agent record was purged from disk are the ones that never reach "verified".
      const hasRecord = records < AGENT_RECORDS && i % 4 !== 3;
      if (hasRecord) {
        writeAgentRecord(agentId, `bucket-${records % 300}`);
        records += 1;
      }
      const status = i < STILL_DONE ? "done" : "archived";
      db.prepare("UPDATE tasks SET status = ?, agent_id = ?, executor_agent_id = ?, created_by_agent = ?, handoff_json = ? WHERE id = ?")
        .run(status, agentId, agentId, `scale-leader-${i % LEADERS}`, JSON.stringify({ files: [], verification: "ok", risks: "none" }), task.id);
      insertRun.run(task.id, agentId, ago);
      insertEvent.run(task.id, ago, "agent_opened", null, null, "scheduler", JSON.stringify({ agentId }));
      insertEvent.run(task.id, ago, "accept", "acceptance", "done", "test", "{}");
      insertEvent.run(task.id, ago, "cleanup", null, null, "kanban", JSON.stringify({ action: "archive_agent", agentId, ok: true, verifyAt }));
      if (hasRecord) insertEvent.run(task.id, ago, "cleanup", null, null, "kanban", JSON.stringify({ action: "verify_agent", agentId, ok: true }));
      for (let n = 0; n < EVENTS_PER_CARD - 5; n += 1) insertEvent.run(task.id, ago, "comment", null, null, "scheduler", "{}");
      insertEvent.run(task.id, ago, "cleanup_finished", null, null, "kanban", "{}");
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  assert.equal(records, AGENT_RECORDS);
  const states = ["running", "running", "running", "acceptance", "acceptance", "blocked", "ready", "ready", "waiting", "in_review", "reviewing", "rework"];
  for (let i = 0; i < ACTIVE; i += 1) {
    const task = createTask({ project: "scale", title: `active ${i}`, role: "executor", workspacePath: dir });
    const agentId = `scale-live-${i}`;
    writeAgentRecord(agentId, `live-${i}`, { archivedAt: null, lastStatus: "running" });
    db.prepare("UPDATE tasks SET status = ?, agent_id = ?, executor_agent_id = ? WHERE id = ?").run(states[i] ?? "ready", agentId, agentId, task.id);
    insertRun.run(task.id, agentId, ago);
  }
}

/** What production does for a finished card: ask Paseo, and fall back to the agent record when Paseo has no such agent. */
function installFakeCleanup(): () => void {
  return installCleanup(
    {
      archiveAgent: async () => {},
      archiveWorkspace: async () => {},
      listAgents: async () => [],
      inspectWorkspace: async () => null,
      inspectAgent: async (agentId) => {
        inspected += 1;
        return snapshotFromRecord(agentId);
      },
    },
    { keepSweepClock: false },
  );
}

async function oneRound(): Promise<void> {
  await round("tick", async () => {
    await runTick({
      profiles,
      launcher: { async create() { throw new Error("scale test must not start anything"); }, async send() {} },
      config,
      pools,
      agentActivity: () => ({ state: "busy", lastAt: new Date().toISOString() }),
    });
    stage("tick.enqueueCleanups", () => enqueueCleanups(new Date()));
  });
  await flushCleanups();
}

function boardRead(): { cards: number } {
  return round("rpc.board", () => {
    stage("board.extras", () => boardExtras(undefined));
    const snapshot = stage("board.snapshot", () => boardSnapshot(undefined));
    stage("board.projectRows", () => projectRows());
    stage("board.doctorReds", () => doctorReds(undefined));
    return { cards: snapshot.tasks.length };
  });
}

/** Same busy-machine gate as native-sessions: load average before and after, plus a business-independent I/O probe. */
async function busyGate(probeBefore: { probeMs: number[]; medianMs: number }, loadBefore: PerformanceLoad): Promise<{ skip: boolean; reason: string }> {
  const probeAfter = await measureIoProbe([dir], join(dir, "io-probe"));
  const load = cpuContentionGate([loadBefore, samplePerformanceLoad()]);
  const io = calibrateIo([probeBefore, probeAfter]);
  return load.skip ? load : io.skip ? io : { skip: false, reason: `${load.reason}; ${io.reason}` };
}

let release = () => {};

before(() => {
  buildFixture();
  release = installFakeCleanup();
});

after(() => {
  release();
  installCleanup(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [["KANBAN_DATA_DIR", previous.data], ["KANBAN_AGENTS_DIR", previous.agents], ["KANBAN_AGENT_INDEX_TTL_MS", previous.ttl]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("scheduler round at board scale", () => {
  it("settles purged agents once, so steady rounds do not ask Paseo or scan agent buckets again", async (t) => {
    const probeBefore = await measureIoProbe([dir], join(dir, "io-probe"));
    const loadBefore = samplePerformanceLoad();
    takePerfSummary();
    const startup = performance.now();
    // The first sweep is spread over rounds, RECONCILE_SWEEP_CHUNK cards at a time; it is done when a round asks about nobody.
    let mostInOneRound = 0;
    let sweepRounds = 0;
    for (; sweepRounds < 40; sweepRounds += 1) {
      const before = inspected;
      await oneRound();
      mostInOneRound = Math.max(mostInOneRound, inspected - before);
      if (inspected === before) break;
    }
    const startupMs = performance.now() - startup;
    const askedAtStartup = inspected;
    assert.ok(askedAtStartup > 0, "the sweep inspects every claimed agent");
    assert.ok(sweepRounds > 1, "a board of this size needs more than one sweep round");
    assert.ok(mostInOneRound <= RECONCILE_SWEEP_CHUNK + RECONCILE_ATTENTION_CAP, `one round asked Paseo about ${mostInOneRound} agents`);
    takePerfSummary();
    const durations: number[] = [];
    for (let i = 0; i < STEADY_ROUNDS; i += 1) {
      const started = performance.now();
      await oneRound();
      durations.push(performance.now() - started);
    }
    assert.equal(inspected, askedAtStartup, "no agent may be inspected again until the next sweep");
    const summary = takePerfSummary();
    assert.ok(summary, "rounds were recorded");
    const tick = summary!.loops.tick!;
    assert.equal(tick.rounds, STEADY_ROUNDS);
    // The unbounded bucket scan used to cost ~600 exists calls per purged agent per round.
    const bucketProbes = (tick.io.exists + tick.io.readdir) / STEADY_ROUNDS;
    assert.ok(bucketProbes < 500, `per-round exists+readdir ${bucketProbes.toFixed(0)}`);
    const reconcile = summary!.loops.reconcile;
    assert.ok(!reconcile || (reconcile.io.exists + reconcile.io.readdir) / reconcile.rounds < 100, "reconcile reads no agent buckets in a steady round");
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const gate = await busyGate(probeBefore, loadBefore);
    t.diagnostic(`PERFORMANCE tick+cleanup steady=${durations.map((n) => n.toFixed(1)).join(",")}ms startup sweep=${startupMs.toFixed(1)}ms; ${gate.reason}`);
    await t.test("wall-clock threshold", { skip: gate.skip ? gate.reason : false }, () => {
      assert.ok(mean < TICK_LIMIT_MS, `a steady round took ${mean.toFixed(0)}ms, limit ${TICK_LIMIT_MS}ms`);
    });
  });

  it("builds the board and one card detail inside the RPC budget at 292 cards", async (t) => {
    const probeBefore = await measureIoProbe([dir], join(dir, "io-probe"));
    const loadBefore = samplePerformanceLoad();
    boardRead();
    takePerfSummary();
    const runs = 5;
    const buildsMs: number[] = [];
    let cards = 0;
    for (let i = 0; i < runs; i += 1) {
      const started = performance.now();
      cards = boardRead().cards;
      buildsMs.push(performance.now() - started);
    }
    // The median, so one scheduler or GC pause in five builds does not decide the gate.
    const boardMs = [...buildsMs].sort((a, b) => a - b)[Math.floor(runs / 2)];
    assert.equal(cards, BOARD_CARDS);
    const first = getDb().prepare("SELECT id FROM tasks WHERE status = 'done' ORDER BY id LIMIT 1").get() as { id: number };
    const detailStarted = performance.now();
    const detail = round("rpc.detail", () => getDetail(first.id));
    const detailMs = performance.now() - detailStarted;
    assert.equal(detail.task.id, first.id);
    const summary = takePerfSummary()!;
    assert.equal(summary.loops["rpc.board"]!.rounds, runs);
    assert.ok(summary.loops["rpc.board"]!.io.readdir === 0, "a board read never lists the agents directory");
    const boardIo = summary.loops["rpc.board"]!.io;
    assert.ok(boardIo.readFile / runs <= BOARD_READ_BUDGET, `readFile per board build ${(boardIo.readFile / runs).toFixed(0)}, budget ${BOARD_READ_BUDGET}`);
    assert.ok(boardIo.exists / runs <= BOARD_READ_BUDGET, `exists per board build ${(boardIo.exists / runs).toFixed(0)}, budget ${BOARD_READ_BUDGET}`);
    const gate = await busyGate(probeBefore, loadBefore);
    t.diagnostic(`PERFORMANCE board reads/build readFile=${(boardIo.readFile / runs).toFixed(0)} exists=${(boardIo.exists / runs).toFixed(0)}`);
    t.diagnostic(`PERFORMANCE board=${boardMs.toFixed(1)}ms (median of ${buildsMs.map((n) => n.toFixed(1)).join(",")}ms) detail=${detailMs.toFixed(1)}ms cards=${cards}; ${gate.reason}`);
    await t.test("wall-clock threshold", { skip: gate.skip ? gate.reason : false }, () => {
      assert.ok(boardMs < BOARD_LIMIT_MS, `a board read took ${boardMs.toFixed(0)}ms, limit ${BOARD_LIMIT_MS}ms`);
      assert.ok(detailMs < BOARD_LIMIT_MS, `a detail read took ${detailMs.toFixed(0)}ms, limit ${BOARD_LIMIT_MS}ms`);
    });
  });
});
