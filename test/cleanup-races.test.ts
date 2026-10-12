/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { agentIndexInvalidations, resetAgentIndexForTests } from "../server/agent-index";
import { enqueueCleanups, flushCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { round } from "../server/perf";
import { snapshotFromRecord } from "../server/paseo";
import { createTask } from "../server/store";

const dir = mkdtempSync(join("/tmp", "cleanup-races-"));
const agents = join(dir, "agents");
mkdirSync(agents, { recursive: true });
const previous = { data: process.env.KANBAN_DATA_DIR, agents: process.env.KANBAN_AGENTS_DIR, ttl: process.env.KANBAN_AGENT_INDEX_TTL_MS };
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agents;
process.env.KANBAN_AGENT_INDEX_TTL_MS = "60000";
const MIN = 60_000;
let seq = 0;

after(() => {
  installCleanup(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [["KANBAN_DATA_DIR", previous.data], ["KANBAN_AGENTS_DIR", previous.agents], ["KANBAN_AGENT_INDEX_TTL_MS", previous.ttl]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  installCleanup(null);
  const db = getDb();
  for (const table of ["events", "runs", "tasks", "links"]) db.exec(`DELETE FROM ${table}`);
  resetAgentIndexForTests();
});

/**
 * A finished card. `failedArchive` leaves a retryable failure line, the one case where a finished card is due again.
 * `archivedUnverified` leaves an archive success nobody confirmed yet, so ordinary rounds keep asking Paseo about it.
 */
function finishedCard(agentId: string, failedArchive = false, archivedUnverified = false): number {
  const db = getDb();
  const ago = new Date(Date.now() - 600 * MIN).toISOString();
  const task = createTask({ project: "race", title: `card ${seq++}`, role: "executor", workspacePath: dir });
  db.prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, task.id);
  db.prepare(
    ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n     VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
  ).run(task.id, agentId, ago);
  const insert = db.prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, ?, 'kanban', ?)");
  insert.run(task.id, ago, "agent_opened", JSON.stringify({ agentId }));
  if (archivedUnverified) insert.run(task.id, ago, "cleanup", JSON.stringify({ action: "archive_agent", agentId, ok: true, verifyAt: ago }));
  if (failedArchive) insert.run(task.id, ago, "cleanup", JSON.stringify({ action: "archive_agent", agentId, ok: false, outcome: "error", error: "boom", retryAt: ago }));
  insert.run(task.id, ago, "cleanup_finished", "{}");
  return task.id;
}

function deferred(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function opsNamed(name: string, log: string[], inspect: NonNullable<CleanupOps["inspectAgent"]>): CleanupOps {
  return {
    archiveAgent: async (agentId) => {
      log.push(`${name}:archive:${agentId}`);
    },
    archiveWorkspace: async () => {},
    listAgents: async () => [],
    inspectWorkspace: async () => null,
    inspectAgent: inspect,
  };
}

describe("rebinding the Paseo client while a reconcile pass is running", () => {
  it("does not start a second pass, and the running pass finishes on the new client", async () => {
    finishedCard("agent-one");
    finishedCard("agent-two");
    const gate = deferred();
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const slowInspect: NonNullable<CleanupOps["inspectAgent"]> = async (agentId) => {
      running += 1;
      most = Math.max(most, running);
      try {
        if (agentId === "agent-one") await gate.promise;
        return { archived: false, busy: false };
      } finally {
        running -= 1;
      }
    };
    installCleanup(opsNamed("old", log, slowInspect), { keepSweepClock: false });
    enqueueCleanups(new Date());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Every turn end rebinds the client; the sweep clock is kept.
    installCleanup(opsNamed("new", log, slowInspect), { keepSweepClock: true });
    enqueueCleanups(new Date());
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.open();
    await flushCleanups();
    assert.equal(most, 1, "one reconcile pass at a time across a rebind");
    assert.deepEqual(log.filter((line) => line.startsWith("old:")), [], "nothing is archived through the replaced client");
    assert.ok(log.includes("new:archive:agent-one") && log.includes("new:archive:agent-two"), `both agents archived on the new client: ${log.join(",")}`);
  });
});

describe("the cleanup xyz and the reconcile pass on one card", () => {
  it("never inspect and archive the same card at once", async () => {
    finishedCard("agent-busy-card", true);
    const gate = deferred();
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const inspect: NonNullable<CleanupOps["inspectAgent"]> = async () => {
      running += 1;
      most = Math.max(most, running);
      try {
        await gate.promise;
        return { archived: false, busy: false };
      } finally {
        running -= 1;
      }
    };
    installCleanup(opsNamed("only", log, inspect), { keepSweepClock: false });
    enqueueCleanups(new Date());
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.open();
    await flushCleanups();
    assert.equal(most, 1, "the retry xyz and the sweep did not both look at the card");
    const archived = log.filter((line) => line.includes("archive:agent-busy-card"));
    assert.equal(archived.length, 1, `archived once: ${archived.join(",")}`);
  });
});

describe("the agents directory is listed again only when it matters", () => {
  function writeRecord(agentId: string, body: Record<string, unknown>): void {
    mkdirSync(join(agents, "bucket"), { recursive: true });
    writeFileSync(join(agents, "bucket", `${agentId}.json`), JSON.stringify(body));
  }

  /** How many times one round forced the agents listing to refresh. */
  async function oneRound(): Promise<number> {
    const before = agentIndexInvalidations();
    await round("tick", async () => {
      enqueueCleanups(new Date());
      await flushCleanups();
    });
    return agentIndexInvalidations() - before;
  }

  it("an ordinary round does not refresh the listing; a newly gone agent does, once", async () => {
    finishedCard("running-agent", false, true);
    writeRecord("running-agent", { id: "running-agent", lastStatus: "running", archivedAt: null });
    finishedCard("vanishing-agent", false, true);
    writeRecord("vanishing-agent", { id: "vanishing-agent", lastStatus: "running", archivedAt: null });
    installCleanup(
      {
        archiveAgent: async () => {},
        archiveWorkspace: async () => {},
        listAgents: async () => [],
        inspectWorkspace: async () => null,
        inspectAgent: async (agentId) => snapshotFromRecord(agentId),
      },
      { keepSweepClock: false },
    );
    assert.equal(await oneRound(), 1, "the sweep round refreshes the listing once");
    const second = await oneRound();
    const third = await oneRound();
    assert.equal(second, 0, `an ordinary round refreshed the agents listing ${second} times`);
    assert.equal(third, 0, `an ordinary round refreshed the agents listing ${third} times`);

    // Paseo purges the agent between two ordinary rounds.
    rmSync(join(agents, "bucket", "vanishing-agent.json"));
    assert.equal(await oneRound(), 1, "an agent that looks gone is confirmed against a fresh listing, once");
    assert.equal(await oneRound(), 0, "and a confirmed-gone agent is not looked at again on ordinary rounds");
  });
});
