/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { enqueueCleanups, flushCleanups, installCleanup } from "../server/cleanup";
import { resetAgentIndexForTests } from "../server/agent-index";
import { snapshotFromRecord } from "../server/paseo";
import { createTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "gone-agents-"));
const agents = join(dir, "agents");
mkdirSync(agents, { recursive: true });
const previous = { data: process.env.KANBAN_DATA_DIR, agents: process.env.KANBAN_AGENTS_DIR, ttl: process.env.KANBAN_AGENT_INDEX_TTL_MS };
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agents;
// Keep the production-like one-minute-class index so a stale miss is possible.
process.env.KANBAN_AGENT_INDEX_TTL_MS = "60000";

const MIN = 60_000;
let inspected = 0;
let release = () => {};
let seq = 0;

/** A finished card whose agent was archived but never verified: the state reconcile keeps asking about. */
function finishedCard(agentId: string): number {
  const db = getDb();
  const ago = new Date(Date.now() - 600 * MIN).toISOString();
  const task = createTask({ project: "gone", title: `card ${seq++}`, role: "executor", workspacePath: dir });
  db.prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, task.id);
  db.prepare(
    ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n     VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
  ).run(task.id, agentId, ago);
  const insert = db.prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, ?, 'kanban', ?)");
  insert.run(task.id, ago, "cleanup", JSON.stringify({ action: "archive_agent", agentId, ok: true, verifyAt: ago }));
  insert.run(task.id, ago, "cleanup_finished", "{}");
  return task.id;
}

function writeRecord(agentId: string, body: string): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(join(agents, "bucket", `${agentId}.json`), body);
}

async function round(offsetMs = 0): Promise<void> {
  enqueueCleanups(new Date(Date.now() + offsetMs));
  await flushCleanups();
}

beforeEach(() => {
  inspected = 0;
  const db = getDb();
  for (const table of ["events", "runs", "tasks", "links"]) db.exec(`DELETE FROM ${table}`);
  resetAgentIndexForTests();
  // A fresh clock each test so the first round is a sweep and later ones are ordinary ticks.
  installCleanup(null);
  release = installCleanup(
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

describe("agents the reconcile pass treats as gone", () => {
  it("sees a running record written after an earlier miss, even with an unexpired index", async () => {
    const agentId = "late-running";
    finishedCard(agentId);
    const { findAgentFile } = await import("../server/open");
    assert.equal(findAgentFile(agentId), null, "warm the index with a miss");
    writeRecord(agentId, JSON.stringify({ id: agentId, lastStatus: "running", archivedAt: null }));
    await round();
    assert.equal(inspected, 1);
    await round();
    assert.equal(inspected, 2, "a running agent keeps the card out of the quiet set");
    const waits = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'cleanup' AND json_extract(data_json, '$.action') = 'wait_turn'").get() as { n: number };
    assert.ok(waits.n >= 1, "the busy agent was recorded as a turn still running");
  });

  it("does not freeze an unreadable record into gone", async () => {
    const agentId = "half-written";
    finishedCard(agentId);
    writeRecord(agentId, "{ not json");
    const errors = console.error;
    console.error = () => {};
    try {
      await round();
      await round();
      await round();
    } finally {
      console.error = errors;
    }
    assert.equal(inspected, 3, "every ordinary round asks again");
    writeRecord(agentId, JSON.stringify({ id: agentId, lastStatus: "idle", archivedAt: "2026-09-01T00:00:00.000Z" }));
    await round();
    assert.equal(inspected, 4);
    await round();
    assert.equal(inspected, 4, "once the record reads fine and verifies, the card is quiet");
  });

  it("skips a confirmed-gone agent on ordinary ticks but looks again on the next sweep", async () => {
    const agentId = "purged";
    finishedCard(agentId);
    await round();
    assert.equal(inspected, 1);
    await round();
    await round();
    assert.equal(inspected, 1, "ordinary ticks do not ask about a gone agent again");
    writeRecord(agentId, JSON.stringify({ id: agentId, lastStatus: "running", archivedAt: null }));
    await round(11 * MIN);
    assert.equal(inspected, 2, "the sweep looks again and finds the agent that came back");
    await round(11 * MIN);
    assert.equal(inspected, 3, "it is busy again, so it stays on the list");
  });
});
