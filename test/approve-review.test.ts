/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { cardMark } from "../server/card-ref";
import { setProjectCode } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { KanbanError } from "../server/errors";
import { createTask, getTask } from "../server/store";
import { issueToken, revokeAgentToken } from "../server/tokens";
import { handleTool } from "../server/tools";
import { withWriteTransport } from "../server/write-source";
import { seedLegacyLinkedReview } from "./helpers/legacy-review";

const dir = mkdtempSync(join(tmpdir(), "approve-review-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR);
setProjectCode("approval-demo", "DEMO");

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

function linkedReview() {
  const original = createTask({ project: "approval-demo", title: "Submitted work", role: "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = 'in_review', agent_id = 'demo-executor', executor_agent_id = 'demo-executor' WHERE id = ?")
    .run(original.id);
  const review = seedLegacyLinkedReview({ project: original.project, title: "Independent review", role: "reviewer", workspacePath: dir, reviewOf: original.id });
  const agent = `demo-reviewer-${review.id}`;
  getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = ? WHERE id = ?").run(agent, review.id);
  const run = getDb().prepare("INSERT INTO runs (task_id, agent_id, role, provider, model, started_at) VALUES (?, ?, 'reviewer', 'demo', 'review-model', ?)")
    .run(review.id, agent, new Date().toISOString());
  const token = issueToken("reviewer", review.id, agent);
  return { original: getTask(original.id), review, agent, token, runId: Number(run.lastInsertRowid) };
}

function targetFacts(id: number) {
  return {
    task: getTask(id),
    events: getDb().prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id").all(id),
    comments: getDb().prepare("SELECT * FROM comments WHERE task_id = ? ORDER BY id").all(id),
    runs: getDb().prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id").all(id),
  };
}

function assertHeldTarget(id: number, before: ReturnType<typeof targetFacts>, reviewId: number) {
  const { comments, ...after } = targetFacts(id);
  const { comments: previous, ...unchanged } = before;
  assert.deepEqual(after, unchanged);
  assert.equal(comments.length, previous.length + 1);
  assert.deepEqual(comments.slice(0, -1), previous);
  const note = comments.at(-1) as { body: string };
  assert.ok(note.body.includes(cardMark(reviewId)));
  assert.ok(note.body.includes(`pass ${cardMark(id)}`));
}

const errorCode = (code: string) => (error: unknown) => error instanceof KanbanError && error.code === code;

describe("assigned review approval", () => {
  for (const explicitId of [false, true]) {
    it(`records an MCP verdict with ${explicitId ? "an explicit" : "the implicit"} own card id while missing executor evidence holds the target`, async () => {
      const { original, review, agent, token, runId } = linkedReview();
      const before = targetFacts(original.id);
      const approved = await withWriteTransport("mcp", () => handleTool("kanban_approve", {
        ...(explicitId ? { id: `DEMO_${review.code_seq}` } : {}), summary: "Approved with independent evidence",
      }, token)) as { id: number; status: string };
      assert.equal(approved.id, review.id);
      assert.equal(approved.status, "acceptance");
      assertHeldTarget(original.id, before, review.id);
      const event = getDb().prepare("SELECT from_status, to_status, actor, data_json FROM events WHERE task_id = ? AND kind = 'approve'").get(review.id);
      assert.deepEqual({ ...event }, {
        from_status: "reviewing", to_status: "acceptance", actor: "reviewer", data_json: JSON.stringify({ summary: "Approved with independent evidence" }),
      });
      const run = getDb().prepare("SELECT end_kind, ended_at FROM runs WHERE id = ?").get(runId) as { end_kind: string; ended_at: string };
      assert.equal(run.end_kind, "approve");
      assert.ok(run.ended_at);
      const audit = getDb().prepare("SELECT role, source_json, outcome FROM write_audits WHERE task_id = ? ORDER BY id DESC LIMIT 1")
        .get(review.id) as { role: string; source_json: string; outcome: string };
      assert.equal(audit.role, "reviewer");
      assert.equal(audit.outcome, "returned");
      assert.deepEqual(Object.fromEntries(Object.entries(JSON.parse(audit.source_json)).filter(([key]) => ["agentId", "runId", "transport"].includes(key))),
        { agentId: agent, runId, transport: "mcp" });
    });
  }

  for (const credential of ["token", "agent"] as const) {
    it(`records the same verdict through CLI ${credential} identity`, async () => {
      const { original, review, agent, token } = linkedReview();
      const before = targetFacts(original.id);
      const env = credential === "token" ? { KANBAN_TOKEN: token, PASEO_AGENT_ID: "unrelated-agent" } : { PASEO_AGENT_ID: agent };
      const approved = await runKanban(["approve", String(review.id), "--summary", "Approved through CLI"], env) as { id: number; status: string };
      assert.equal(approved.id, review.id);
      assert.equal(approved.status, "acceptance");
      assertHeldTarget(original.id, before, review.id);
      const audit = getDb().prepare("SELECT source_json, outcome FROM write_audits WHERE task_id = ? ORDER BY id DESC LIMIT 1")
        .get(review.id) as { source_json: string; outcome: string };
      assert.equal(audit.outcome, "returned");
      assert.equal(JSON.parse(audit.source_json).transport, "cli");
      assert.equal(JSON.parse(audit.source_json).agentId, agent);
    });
  }

  it("keeps write access limited to the assigned card, including related targets and other reviews", async () => {
    const { original, review, token } = linkedReview();
    const other = seedLegacyLinkedReview({ project: original.project, title: "Another review", role: "reviewer", reviewOf: original.id });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'another-reviewer' WHERE id = ?").run(other.id);
    // Project-wide read access must never grant approval rights.
    getDb().prepare("UPDATE tasks SET project_read_scope = 'project' WHERE id = ?").run(review.id);
    const before = targetFacts(original.id);
    for (const requested of [original.id, other.id]) {
      await assert.rejects(() => handleTool("kanban_approve", { id: requested, summary: "Out of scope" }, token), errorCode("forbidden"));
      await assert.rejects(() => runKanban(["approve", String(requested), "--summary", "Out of scope"], { KANBAN_TOKEN: token }), errorCode("forbidden"));
    }
    assert.deepEqual(targetFacts(original.id), before);
    assert.equal(getTask(other.id).status, "reviewing");
    assert.equal(getTask(review.id).status, "reviewing");
    await handleTool("kanban_approve", { summary: "Own card only" }, token);
    assert.equal(getTask(review.id).status, "acceptance");
    assertHeldTarget(original.id, before, review.id);
  });

  it("rejects a stale reviewer token after assignment changes", async () => {
    const { original, review, token } = linkedReview();
    getDb().prepare("UPDATE tasks SET agent_id = 'replacement-reviewer' WHERE id = ?").run(review.id);
    const before = targetFacts(original.id);
    await assert.rejects(() => handleTool("kanban_approve", { summary: "Stale assignment" }, token), errorCode("forbidden"));
    await assert.rejects(() => runKanban(["approve", String(review.id), "--summary", "Stale assignment"], { KANBAN_TOKEN: token }), errorCode("forbidden"));
    assert.equal(getTask(review.id).status, "reviewing");
    assert.deepEqual(targetFacts(original.id), before);
  });

  it("rejects expired and revoked reviewer credentials", async () => {
    const { review, agent, token } = linkedReview();
    getDb().prepare("UPDATE tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?").run(token);
    await assert.rejects(() => handleTool("kanban_approve", { summary: "Expired" }, token), errorCode("unauthorized"));
    const revoked = issueToken("reviewer", review.id, agent);
    revokeAgentToken(agent);
    await assert.rejects(() => handleTool("kanban_approve", { summary: "Revoked" }, revoked), errorCode("unauthorized"));
    assert.equal(getTask(review.id).status, "reviewing");
  });

  it("requires the reviewer role even when another role's token names the current agent", async () => {
    const { review, agent } = linkedReview();
    for (const role of ["executor", "reader", "batch", "decision", "supervisor"]) {
      const token = issueToken(role, review.id, agent);
      await assert.rejects(() => handleTool("kanban_approve", { summary: "Wrong role" }, token), errorCode("forbidden"));
    }
    assert.equal(getTask(review.id).status, "reviewing");
  });
});
