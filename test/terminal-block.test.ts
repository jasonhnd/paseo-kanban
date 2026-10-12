/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { closeDb, getDb } from "../server/db";
import { archiveTask, blockTask, createTask, getTask, setBlockedListener } from "../server/store";
import { canTransition } from "../server/state";
import { issueToken } from "../server/tokens";
import { formatResult, handleTool } from "../server/tools";

const dir = mkdtempSync(join(tmpdir(), "TEST_0095-terminal-block-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  setBlockedListener(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function card(role: string, status: string) {
  const task = createTask({ project: "terminal-block", title: `${role} ${status}`, role, workspacePath: dir });
  const agentId = `agent-${task.id}`;
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = ?, executor_agent_id = ? WHERE id = ?").run(
    status === "archived" ? "running" : status, agentId, agentId, task.id,
  );
  if (status === "archived") archiveTask(task.id, "supervisor");
  return { task: getTask(task.id), agentId };
}

describe("terminal cards ignore their agents' block reports", () => {
  for (const role of ["executor", "reviewer", "reader", "decision", "batch"]) {
    for (const status of ["archived", "done"]) {
      for (const via of ["MCP", "CLI"]) {
        it(`${via}: ${role} cannot block a ${status} card`, async () => {
          const { task, agentId } = card(role, status);
          const reason = (zhCNPart("parents.block.waitingParents", 0, 4) + zhCNPart("cardParts.event.blocked", 0, 1) + "\n" + zhCNPart("nativeSessions.kept.leader", 9, 11) + zhCNPart("decisions.row.expand", 3, 5) + zhCNPart("nativeSessions.skipLabel.other", 2, 4));
          const message = status === "archived" ? zhCN("taskLifecycle.blockIgnored.archived") : zhCN("taskLifecycle.blockIgnored.done");
          let notified = 0;
          setBlockedListener(() => { notified += 1; });
          try {
            const result = via === "MCP"
              ? await handleTool("kanban_block", { id: task.id, kind: "dependency", reason }, issueToken(role, task.id, agentId))
              : await runKanban(["block", String(task.id), "--kind", "dependency", "--reason", reason], { PASEO_AGENT_ID: agentId });
            assert.equal(formatResult(result), message);
            assert.deepEqual(getTask(task.id), task, "all task fields, including timestamps and holds, stay unchanged");
            assert.equal(notified, 0, "no blocked notification or cleanup disruption");
            const event = getDb().prepare("SELECT actor, from_status, to_status, data_json FROM events WHERE task_id = ? AND kind = 'block_ignored'").get(task.id) as {
              actor: string; from_status: string | null; to_status: string | null; data_json: string;
            };
            assert.equal(event.actor, role);
            assert.equal(event.from_status, null);
            assert.equal(event.to_status, null);
            assert.deepEqual(JSON.parse(event.data_json), { kind: "dependency", reason, status, message });
            const comment = getDb().prepare("SELECT author, body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(task.id) as { author: string; body: string };
            assert.equal(comment.author, role);
            assert.ok(comment.body.includes(reason));
            assert.ok(comment.body.includes(message));
          } finally {
            setBlockedListener(null);
          }
        });
      }
    }
  }

  it("CLI with a card token also returns the terminal message", async () => {
    const { task, agentId } = card("executor", "archived");
    const result = await runKanban(["block", String(task.id), "--kind", "dependency", "--reason", zhCNPart("cardParts.event.prWait", 0, 2)], {
      KANBAN_TOKEN: issueToken("executor", task.id, agentId), PASEO_AGENT_ID: "other-agent",
    });
    assert.equal(formatResult(result), zhCN("taskLifecycle.blockIgnored.archived"));
    assert.deepEqual(getTask(task.id), task);
  });

  it("keeps current-agent and own-card checks, and validates terminal reports", async () => {
    const { task, agentId } = card("executor", "archived");
    const token = issueToken("executor", task.id, agentId);
    await assert.rejects(() => handleTool("kanban_block", { kind: "bad", reason: "Waiting" }, token), new RegExp("blocked_kind " + localePattern(zhCNPart("config.workspaceOnlyDir", 4, 7))));
    await assert.rejects(() => handleTool("kanban_block", { kind: "dependency", reason: " " }, token), new RegExp(zhCN("flow.error.noReason")));
    await assert.rejects(() => handleTool("kanban_block", { kind: "dependency", reason: "Waiting" }, issueToken("executor", task.id, "old-agent")), new RegExp(localePattern(zhCNPart("tools.tokenNotCardAgent", 14, 28))));
    const other = card("executor", "archived");
    await assert.rejects(() => handleTool("kanban_block", { id: other.task.id, kind: "dependency", reason: "Waiting" }, token), new RegExp(localePattern(zhCNPart("tools.ownCardsOnly", 4, 13))));
    assert.deepEqual(getTask(task.id), task);
    const ignored = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'block_ignored'").get(task.id) as { n: number };
    assert.equal(ignored.n, 0);
  });

  it("still blocks an active card and notifies the blocked listener", async () => {
    const { task, agentId } = card("executor", "running");
    let notified = 0;
    setBlockedListener(() => { notified += 1; });
    try {
      await handleTool("kanban_block", { kind: "dependency", reason: "Waiting" }, issueToken("executor", task.id, agentId));
      assert.equal(getTask(task.id).status, "blocked");
      assert.equal(getTask(task.id).blocked_from, "running");
      assert.equal(notified, 1);
    } finally {
      setBlockedListener(null);
    }
  });

  it("preserves explicit supervisor blocks of archived and done cards", async () => {
    for (const status of ["archived", "done"]) {
      const { task } = card("executor", status);
      const result = await handleTool("kanban_block", { id: task.id, kind: "needs_human", reason: "Manual handling" }, issueToken("supervisor", null, null)) as { status: string };
      assert.equal(result.status, "blocked");
      assert.equal(getTask(task.id).blocked_from, status);
    }
    assert.equal(canTransition("archived", "blocked"), true);
    assert.equal(canTransition("archived", "rework"), true);
  });

  it("guards direct card-role calls to the store as well", () => {
    const { task } = card("executor", "archived");
    assert.equal(formatResult(blockTask(task.id, "dependency", "Late report", "executor")), zhCN("taskLifecycle.blockIgnored.archived"));
    assert.deepEqual(getTask(task.id), task);
  });

  it("preserves review_of rejection of an archived original, including the third-round fuse", async () => {
    for (const round of [0, 2]) {
      const { task: original } = card("executor", "archived");
      getDb().prepare("UPDATE tasks SET review_round = ? WHERE id = ?").run(round, original.id);
      const review = createTask({ project: "terminal-block", title: "Independent review", role: "reviewer", workspacePath: dir, reviewOf: original.id });
      const agentId = `review-${review.id}`;
      getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = ? WHERE id = ?").run(agentId, review.id);
      await handleTool("kanban_request_changes", { reason: "Valid rejection", findings: "Add tests" }, issueToken("reviewer", review.id, agentId));
      assert.equal(getTask(original.id).status, round === 0 ? "rework" : "blocked");
      assert.equal(getTask(original.id).review_round, round + 1);
      assert.equal(getTask(review.id).status, "done");
      const reopened = getDb().prepare("SELECT kind FROM events WHERE task_id = ? AND from_status = 'archived' AND to_status = 'rework'").get(original.id) as { kind: string };
      assert.equal(reopened.kind, round === 0 ? "request_changes" : "reopened");
    }
  });
});
