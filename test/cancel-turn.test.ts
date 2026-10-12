/// <reference types="node" />
import { zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { readAgentPresence, settleCanceledTurn, type AgentAsk } from "../server/presence";
import { createTask, getTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "cancel-turn-"));
process.env.KANBAN_DATA_DIR = dir;
const agents = join(dir, "agents");
const previousAgents = process.env.KANBAN_AGENTS_DIR;
process.env.KANBAN_AGENTS_DIR = agents;

function running(agentId: string, status: "running" | "reviewing" = "running", nudge = 1): number {
  const task = createTask({ project: "cancel", title: "demo fixture", role: "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = ?, nudge_count = ? WHERE id = ?").run(status, agentId, nudge, task.id);
  return task.id;
}

function events(taskId: number, kind: string): Array<{ actor: string; from_status: string | null; to_status: string | null; data_json: string }> {
  return getDb()
    .prepare("SELECT actor, from_status, to_status, data_json FROM events WHERE task_id = ? AND kind = ?")
    .all(taskId, kind) as unknown as Array<{ actor: string; from_status: string | null; to_status: string | null; data_json: string }>;
}

function writeAgent(agentId: string, body: string): void {
  const folder = join(agents, agentId.slice(0, 2));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${agentId}.json`), body);
}

after(() => {
  if (previousAgents === undefined) delete process.env.KANBAN_AGENTS_DIR;
  else process.env.KANBAN_AGENTS_DIR = previousAgents;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("canceled turn", () => {
  for (const presence of ["running", "idle", "unknown"] as const) {
    it(`does not reclaim or count a nudge when the agent is ${presence}`, () => {
      const id = running(`agent-${presence}`, "running", 2);
      assert.equal(settleCanceledTurn(id, `agent-${presence}`, presence), "kept");
      const task = getTask(id);
      assert.equal(task.status, "running");
      assert.equal(task.agent_id, `agent-${presence}`);
      assert.equal(task.nudge_count, 2);
      assert.equal(events(id, "reclaimed").length, 0);
      const noted = events(id, "turn_canceled");
      assert.equal(noted.length, 1);
      assert.equal(noted[0]?.actor, "scheduler");
      assert.equal(noted[0]?.from_status, "running");
      assert.equal(noted[0]?.to_status, "running");
      const data = JSON.parse(noted[0]?.data_json ?? "{}") as { agentId?: string; presence?: string };
      assert.equal(data.agentId, `agent-${presence}`);
      assert.equal(data.presence, presence);
    });
  }

  for (const presence of ["archived", "closed", "missing"] as const) {
    it(`reclaims when the agent is ${presence}`, () => {
      const id = running(`gone-${presence}`);
      assert.equal(settleCanceledTurn(id, `gone-${presence}`, presence), "reclaimed");
      assert.equal(getTask(id).status, "ready");
      assert.equal(getTask(id).agent_id, null);
      assert.equal(events(id, "turn_canceled").length, 0);
      const reclaimed = events(id, "reclaimed");
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0]?.to_status, "ready");
    });
  }

  it("records the evidence and the canceled-turn source on the reclaim (TEST_0299)", () => {
    const id = running("gone-merge");
    const evidence = { trail: { actions: [("gh pr merge #354" + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("compat.exitCode", 0, 4) + "0" + zhCNPart("missingCwd.none", 3, 4))], otherCommands: 0 }, cancelReason: "agent closed" };
    assert.equal(settleCanceledTurn(id, "gone-merge", "archived", evidence), "reclaimed");
    const data = JSON.parse(events(id, "reclaimed")[0]?.data_json ?? "{}") as Record<string, unknown>;
    assert.deepEqual(data, { reason: "agent_gone", agentId: "gone-merge", source: "turn_canceled", apiState: "archived", ...evidence });
  });

  it("skips a card that another agent already holds", () => {
    const id = running("gone-replaced");
    getDb().prepare("UPDATE tasks SET agent_id = 'newer' WHERE id = ?").run(id);
    assert.equal(settleCanceledTurn(id, "gone-replaced", "archived"), "skip");
    assert.equal(getTask(id).status, "running");
    assert.equal(events(id, "reclaimed").length, 0);
  });

  it("reclaims a reviewing card back to in_review when the reviewer is closed", () => {
    const id = running("reviewer-closed", "reviewing");
    assert.equal(settleCanceledTurn(id, "reviewer-closed", "closed"), "reclaimed");
    assert.equal(getTask(id).status, "in_review");
    assert.equal(events(id, "reclaimed")[0]?.to_status, "in_review");
  });
});

describe("agent presence", () => {
  it("trusts a Paseo snapshot over the record file", async () => {
    writeAgent("snap-live", JSON.stringify({ id: "snap-live", lastStatus: "closed", archivedAt: null }));
    const ask: AgentAsk = async () => ({ status: "running", archivedAt: null, activeTurn: { turnId: "t" } });
    assert.equal(await readAgentPresence("snap-live", ask), "running");
    const idle: AgentAsk = async () => ({ status: "idle", archivedAt: null });
    assert.equal(await readAgentPresence("snap-live", idle), "idle");
    const archived: AgentAsk = async () => ({ status: "idle", archivedAt: "2026-09-27T00:00:00.000Z" });
    assert.equal(await readAgentPresence("snap-live", archived), "archived");
    const closed: AgentAsk = async () => ({ status: "closed", archivedAt: null });
    assert.equal(await readAgentPresence("snap-live", closed), "closed");
  });

  it("falls back to a live file when the API cannot be asked, and stays unknown when the file cannot be read", async () => {
    writeAgent("file-idle", JSON.stringify({ id: "file-idle", lastStatus: "idle", archivedAt: null }));
    writeAgent("file-closed", JSON.stringify({ id: "file-closed", lastStatus: "closed", archivedAt: null }));
    writeAgent("file-arch", JSON.stringify({ id: "file-arch", lastStatus: "idle", archivedAt: "2026-09-27T00:00:00.000Z" }));
    writeAgent("file-bad", "{");
    const down: AgentAsk = async () => {
      throw new Error("socket hang up");
    };
    assert.equal(await readAgentPresence("file-idle", down), "idle");
    assert.equal(await readAgentPresence("file-closed", down), "closed");
    assert.equal(await readAgentPresence("file-arch", down), "archived");
    assert.equal(await readAgentPresence("file-bad", down), "unknown");
    assert.equal(await readAgentPresence("file-missing", down), "unknown");
    assert.equal(await readAgentPresence("file-idle"), "idle");
    assert.equal(await readAgentPresence("file-missing"), "unknown");
  });

  it("treats an empty API snapshot plus a missing file as gone, and a not-found error as gone unless the file is unreadable", async () => {
    writeAgent("still-there", JSON.stringify({ id: "still-there", lastStatus: "running", archivedAt: null }));
    writeAgent("half", "{");
    const absent: AgentAsk = async () => "absent";
    assert.equal(await readAgentPresence("no-such-agent", absent), "missing");
    assert.equal(await readAgentPresence("still-there", absent), "running");
    assert.equal(await readAgentPresence("half", absent), "unknown");
    const notFound: AgentAsk = async () => {
      throw new Error("agent not found");
    };
    assert.equal(await readAgentPresence("no-such-agent", notFound), "missing");
    assert.equal(await readAgentPresence("still-there", notFound), "missing");
    assert.equal(await readAgentPresence("half", notFound), "unknown");
  });
});
