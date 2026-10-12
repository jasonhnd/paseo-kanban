/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { dueCardIds, enqueueCleanups, flushCleanups, installCleanup, noteOverdueArchives, RECONCILE_ATTENTION_CAP, RECONCILE_SWEEP_CHUNK, reconcileScanStats } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { round, takePerfSummary } from "../server/perf";
import { createTask } from "../server/store";
import { listTempWorkspaces, overdueTempWorkspaces } from "../server/temp-workspace";

/**
 * The number of SQL statements one round runs must not depend on how many finished cards the
 * board has already accumulated. Each scale builds its own database with 1x, 2x and 4x as many
 * finished, fully cleaned cards, and the same handful of cards that still need work.
 */
const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const root = mkdtempSync(join(tmp, "cleanup-queries-"));
const previousData = process.env.KANBAN_DATA_DIR;
const previousAgents = process.env.KANBAN_AGENTS_DIR;
const MIN = 60_000;
/** Larger than the reconcile chunk, so every scale's first sweep round is full. */
const UNIT = 220;
const SCALES = [1, 2, 4];
const MAX_SWEEP_ROUNDS = 40;
/** Statements allowed to differ between the 1x and the 4x board. */
const SLACK = 2;

after(() => {
  installCleanup(null);
  closeDb();
  rmSync(root, { recursive: true, force: true });
  if (previousData === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = previousData;
  if (previousAgents === undefined) delete process.env.KANBAN_AGENTS_DIR;
  else process.env.KANBAN_AGENTS_DIR = previousAgents;
});

function buildBoard(scale: number): void {
  const db = getDb();
  const ago = new Date(Date.now() - 600 * MIN).toISOString();
  const verifyAt = new Date(Date.now() - 500 * MIN).toISOString();
  const insertEvent = db.prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertRun = db.prepare(
    ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n     VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
  );
  const cleanup = (taskId: number, data: Record<string, unknown>) => insertEvent.run(taskId, ago, "cleanup", null, null, "kanban", JSON.stringify(data));
  db.exec("BEGIN");
  try {
    for (let i = 0; i < UNIT * scale; i += 1) {
      const task = createTask({ project: "q", title: `finished ${i}`, role: "executor", workspacePath: root });
      const agentId = `q-agent-${scale}-${i}`;
      db.prepare("UPDATE tasks SET status = ?, agent_id = ?, executor_agent_id = ? WHERE id = ?").run(i % 3 === 0 ? "archived" : "done", agentId, agentId, task.id);
      insertRun.run(task.id, agentId, ago);
      insertEvent.run(task.id, ago, "agent_opened", null, null, "scheduler", JSON.stringify({ agentId }));
      insertEvent.run(task.id, ago, "accept", "acceptance", "done", "test", "{}");
      // Every reviewed card released its reviewer, finished or not.
      insertEvent.run(task.id, ago, "release_agent", null, null, "kanban", JSON.stringify({ agentId: `q-reviewer-${scale}-${i}` }));
      // One in six had a failed archive that a later attempt fixed. Those used to stay in the failed set forever.
      if (i % 6 === 0) cleanup(task.id, { action: "archive_agent", agentId, ok: false, outcome: "error", error: "boom", retryAt: ago });
      cleanup(task.id, { action: "archive_agent", agentId, ok: true, verifyAt });
      cleanup(task.id, { action: "verify_agent", agentId, ok: true });
      if (i % 2 === 0) {
        insertEvent.run(task.id, ago, "temp_workspace", null, null, "scheduler", JSON.stringify({ name: `q${i}` }));
        insertEvent.run(task.id, ago, "temp_workspace_cleaned", null, null, "kanban", "{}");
      }
      insertEvent.run(task.id, ago, "cleanup_finished", null, null, "kanban", "{}");
    }
    // The part that really has work, the same size at every scale.
    for (let i = 0; i < 4; i += 1) {
      const task = createTask({ project: "q", title: `open temp ${i}`, role: "executor", workspacePath: root });
      db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
      insertEvent.run(task.id, ago, "temp_workspace", null, null, "scheduler", JSON.stringify({ name: `open${i}` }));
    }
    for (let i = 0; i < 3; i += 1) {
      const task = createTask({ project: "q", title: `done not cleaned ${i}`, role: "executor", workspacePath: root });
      const agentId = `q-open-${scale}-${i}`;
      db.prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, task.id);
      insertRun.run(task.id, agentId, ago);
      insertEvent.run(task.id, ago, "agent_opened", null, null, "scheduler", JSON.stringify({ agentId }));
      insertEvent.run(task.id, new Date().toISOString(), "accept", "acceptance", "done", "test", "{}");
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function sqlOf(summary: ReturnType<typeof takePerfSummary>): number {
  return Object.values(summary?.loops ?? {}).reduce((sum, loop) => sum + loop.io.sql, 0);
}

function measure<T>(fn: () => T): { sql: number; result: T } {
  takePerfSummary();
  const result = round("probe", fn);
  return { sql: sqlOf(takePerfSummary()), result };
}

interface Measured {
  due: number;
  overdue: number;
  listTemp: number;
  overdueTemp: number;
  firstSweepRound: number;
  steadyRound: number;
  steadyCardStages: number;
  sweepRounds: number;
  /** Finished-card rows the first round read from the tasks table, and the most any sweep round read. */
  firstRoundRows: number;
  mostRowsInOneRound: number;
  mostVisitedInOneRound: number;
  steadyRowsRead: number;
  steadyVisited: number;
  finishedAgentsInspected: number;
  mostInspectsOfOneAgent: number;
}

async function oneRound(): Promise<{ sql: number; inspected: number; cardStages: number; rowsRead: number; visited: number }> {
  takePerfSummary();
  inspectedNow = 0;
  enqueueCleanups(new Date());
  await flushCleanups();
  const summary = takePerfSummary();
  const scan = reconcileScanStats();
  return { sql: sqlOf(summary), inspected: inspectedNow, cardStages: summary?.loops.reconcile?.stages["reconcile.card"]?.calls ?? 0, rowsRead: scan.rowsRead, visited: scan.visited };
}

let inspectedNow = 0;
const inspectCounts = new Map<string, number>();

async function measureScale(scale: number): Promise<Measured> {
  const dir = mkdtempSync(join(root, `scale-${scale}-`));
  mkdirSync(join(dir, "agents"), { recursive: true });
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  closeDb();
  buildBoard(scale);
  const now = new Date();
  const due = measure(() => dueCardIds(now)).sql;
  const overdue = measure(() => noteOverdueArchives(now)).sql;
  const listTemp = measure(() => listTempWorkspaces(now)).sql;
  const overdueTemp = measure(() => overdueTempWorkspaces(now)).sql;
  installCleanup(
    {
      archiveAgent: async () => {},
      archiveWorkspace: async () => {},
      listAgents: async () => [],
      inspectWorkspace: async () => null,
      inspectAgent: async (agentId) => {
        inspectedNow += 1;
        inspectCounts.set(agentId, (inspectCounts.get(agentId) ?? 0) + 1);
        // The three unfinished cards keep a live agent; everything else is archived.
        return { archived: !agentId.startsWith("q-open-"), busy: false };
      },
    },
    { keepSweepClock: false },
  );
  inspectCounts.clear();
  const first = await oneRound();
  let sweepRounds = 1;
  let last = first;
  let mostRows = first.rowsRead;
  let mostVisited = first.visited;
  // Keep going until a round no longer inspects the finished cards; that is the end of the first sweep.
  for (; sweepRounds < MAX_SWEEP_ROUNDS; sweepRounds += 1) {
    last = await oneRound();
    mostRows = Math.max(mostRows, last.rowsRead);
    mostVisited = Math.max(mostVisited, last.visited);
    if (last.inspected <= 3) break;
  }
  const finishedCounts = [...inspectCounts].filter(([agentId]) => agentId.startsWith("q-agent-"));
  const steady = await oneRound();
  installCleanup(null);
  return {
    due,
    overdue,
    listTemp,
    overdueTemp,
    firstSweepRound: first.sql,
    steadyRound: steady.sql,
    steadyCardStages: steady.cardStages,
    firstRoundRows: first.rowsRead,
    mostRowsInOneRound: mostRows,
    mostVisitedInOneRound: mostVisited,
    steadyRowsRead: steady.rowsRead,
    steadyVisited: steady.visited,
    sweepRounds,
    finishedAgentsInspected: finishedCounts.length,
    mostInspectsOfOneAgent: Math.max(0, ...finishedCounts.map(([, count]) => count)),
  };
}

describe("cleanup rounds issue a bounded number of queries however many finished cards exist", () => {
  const results = new Map<number, Measured>();
  const at = (scale: number): Measured => {
    const found = results.get(scale);
    if (!found) throw new Error(`scale ${scale} was not measured`);
    return found;
  };

  before(async () => {
    for (const scale of SCALES) results.set(scale, await measureScale(scale));
    console.log(`cleanup query counts by board size:\n${SCALES.map((scale) => JSON.stringify({ cards: scale * UNIT, ...at(scale) })).join("\n")}`);
  });

  for (const key of ["due", "overdue", "listTemp", "overdueTemp"] as const) {
    it(`${key}: statement count is the same at 1x, 2x and 4x`, () => {
      assert.ok(at(2)[key] <= at(1)[key] + SLACK, `${key} 2x ${at(2)[key]} vs 1x ${at(1)[key]}`);
      assert.ok(at(4)[key] <= at(1)[key] + SLACK, `${key} 4x ${at(4)[key]} vs 1x ${at(1)[key]}`);
    });
  }

  it("a reconcile sweep round is capped, so the first round costs the same at 1x, 2x and 4x", () => {
    assert.ok(at(4).firstSweepRound <= at(1).firstSweepRound * 1.2 + 10, `4x first round ${at(4).firstSweepRound} vs 1x ${at(1).firstSweepRound}`);
    assert.ok(at(2).firstSweepRound <= at(1).firstSweepRound * 1.2 + 10, `2x first round ${at(2).firstSweepRound} vs 1x ${at(1).firstSweepRound}`);
  });

  it("a steady round after the sweep costs the same at 1x, 2x and 4x and visits no quiet card", () => {
    assert.ok(at(4).steadyRound <= at(1).steadyRound + SLACK + 5, `4x steady ${at(4).steadyRound} vs 1x ${at(1).steadyRound}`);
    assert.ok(at(4).steadyCardStages <= at(1).steadyCardStages + 1, `4x steady reconcile.card calls ${at(4).steadyCardStages} vs 1x ${at(1).steadyCardStages}`);
  });

  it("reads and visits a bounded number of finished-card rows per round, and none in a steady round", () => {
    for (const scale of SCALES) {
      const found = at(scale);
      assert.ok(found.mostRowsInOneRound <= RECONCILE_SWEEP_CHUNK, `scale ${scale}: a round read ${found.mostRowsInOneRound} finished-card rows`);
      assert.ok(found.mostVisitedInOneRound <= RECONCILE_SWEEP_CHUNK + RECONCILE_ATTENTION_CAP, `scale ${scale}: a round visited ${found.mostVisitedInOneRound} cards`);
      assert.equal(found.steadyRowsRead, 0, `scale ${scale}: a steady round read finished-card rows`);
    }
    assert.ok(at(4).steadyVisited <= at(1).steadyVisited, `4x steady visited ${at(4).steadyVisited} vs 1x ${at(1).steadyVisited}`);
    assert.equal(at(4).mostRowsInOneRound, at(1).mostRowsInOneRound, "the page size does not grow with the board");
  });

  it("the chunked sweep still asks about every finished card's agent exactly once", () => {
    for (const scale of SCALES) {
      assert.equal(at(scale).finishedAgentsInspected, UNIT * scale, `scale ${scale}: agents inspected`);
      assert.equal(at(scale).mostInspectsOfOneAgent, 1, `scale ${scale}: an agent was inspected more than once in one sweep`);
    }
  });

  it("the sweep takes more rounds on a bigger board instead of one huge round", () => {
    assert.ok(at(4).sweepRounds > at(1).sweepRounds, `sweep rounds 4x ${at(4).sweepRounds} vs 1x ${at(1).sweepRounds}`);
  });
});
