/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_PROGRESS_GRACE_MS } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { applyNudge } from "../server/flow";
import { appendEvent, claimStatus, createTask, getTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "nudge-turn-end-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

const NOW = Date.parse("2026-10-05T04:30:00.000Z");

function runningCard(title: string, role: string, agentId: string): number {
  const task = createTask({ project: "sandbox", title, role });
  claimStatus(task.id, "ready", "running", "test");
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(agentId, task.id);
  return task.id;
}

/** The agent wrote a progress comment seconds before its turn ended (TEST_0253 §1.1: 92% of nudged agents). */
function progressSecondsAgo(taskId: number, agentId: string, seconds: number): void {
  appendEvent(taskId, "comment", null, "running", agentId, {}, new Date(NOW - seconds * 1000).toISOString());
}

const runningSubAgent = [{ type: "tool_call", name: "Task", status: "running", callId: "child", detail: { type: "sub_agent" } }];
const idleTimeline = [{ type: "assistant_message", text: "Full suite still running; progress recorded; continue afterward" }];

describe("F1: a turn that ends after a progress comment is still a missed finish", () => {
  it("shortens the progress grace default to three minutes", () => {
    assert.equal(DEFAULT_PROGRESS_GRACE_MS, 3 * 60_000);
  });

  it("reminds when the turn ends seconds after a progress comment and no sub-agent is running", () => {
    const id = runningCard("Ended turn after progress", "executor", "agent-f1-remind");
    progressSecondsAgo(id, "agent-f1-remind", 10);
    const decision = applyNudge(id, false, { nowMs: NOW, timeline: idleTimeline });
    assert.equal(decision.action, "remind");
    assert.equal(decision.count, 1);
    assert.equal(getTask(id).nudge_count, 1);
  });

  it("stays quiet while a sub-agent is still running, even without a progress comment", () => {
    const id = runningCard((zhCNPart("cardParts.event.wakeChildren", 2, 3) + " agent " + zhCNPart("reclaimNote.result.running", 1, 3)), "executor", "agent-f1-sub");
    progressSecondsAgo(id, "agent-f1-sub", 10);
    assert.equal(applyNudge(id, false, { nowMs: NOW, timeline: runningSubAgent }).action, "none");
    assert.equal(getTask(id).nudge_count, 0);
  });

  it("keeps the progress grace when the timeline could not be read", () => {
    const id = runningCard((zhCNPart("nudge.skip.badTimeline", 2, 5) + zhCNPart("doctor.matrix.unknown", 4, 7)), "executor", "agent-f1-blind");
    progressSecondsAgo(id, "agent-f1-blind", 10);
    assert.equal(applyNudge(id, false, { nowMs: NOW }).action, "none");
    assert.equal(getTask(id).nudge_count, 0);
  });

  it("keeps the spacing between counted nudges", () => {
    const id = runningCard("No repeated reminders", "reviewer", "agent-f1-space");
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(id);
    progressSecondsAgo(id, "agent-f1-space", 10);
    assert.equal(applyNudge(id, false, { nowMs: NOW, timeline: idleTimeline }).action, "remind");
    progressSecondsAgo(id, "agent-f1-space", 5);
    assert.equal(applyNudge(id, false, { nowMs: NOW + 60_000, timeline: idleTimeline }).action, "none");
    assert.equal(getTask(id).nudge_count, 1);
  });
});

describe("F3: a quiet batch or reader card is handed in, not fused into a false block", () => {
  for (const role of ["batch", "reader"] as const) {
    it(`hands a quiet ${role} card to acceptance after one reminder`, () => {
      const agentId = `agent-f3-${role}`;
      const id = runningCard(`Quiet${role}`, role, agentId);
      const first = applyNudge(id, false, { nowMs: NOW, timeline: idleTimeline });
      assert.equal(first.action, "remind");
      const later = applyNudge(id, false, { nowMs: NOW + 10 * 60_000, timeline: idleTimeline });
      assert.equal(later.action, "handoff");
      const task = getTask(id);
      assert.equal(task.status, "acceptance");
      assert.equal(task.blocked_kind, null);
      assert.match(task.handoff_json ?? "", new RegExp(localePattern(zhCNPart("flow.auto.prefix", 1, 5))));
      assert.match(task.handoff_json ?? "", new RegExp("Full suite still running"));
    });

    it(`never produces the three-miss block for a ${role} card (card 778 replay)`, () => {
      const agentId = `agent-f3-replay-${role}`;
      const id = runningCard(`Replay 778 ${role}`, role, agentId);
      // 02:50, 03:00, 03:16, 03:27, 03:38: the agent wakes, looks, and ends the turn again.
      const base = Date.parse("2026-10-04T02:50:00.000Z");
      const offsets = [0, 10, 26, 37, 48];
      const actions = offsets.map((minutes) => applyNudge(id, false, { nowMs: base + minutes * 60_000, timeline: idleTimeline }).action);
      assert.ok(!actions.includes("block"), `actions: ${actions.join(",")}`);
      const blocked = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'blocked'").get(id) as { n: number };
      assert.equal(blocked.n, 0);
      assert.equal(getTask(id).status, "acceptance");
    });
  }

  it("does not hand in a decision card", () => {
    const id = runningCard((zhCN("labels.role.decision") + zhCNPart("cardParts.event.blocked", 0, 1)), "decision", "agent-f3-decision");
    assert.equal(applyNudge(id, false, { nowMs: NOW, timeline: idleTimeline }).action, "remind");
    assert.equal(applyNudge(id, false, { nowMs: NOW + 10 * 60_000, timeline: idleTimeline }).action, "remind");
    assert.equal(getTask(id).status, "running");
  });
});
