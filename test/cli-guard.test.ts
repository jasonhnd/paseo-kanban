/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { kanbanHelp, runKanban } from "../server/cli";
import { closeDb, getDb } from "../server/db";
import { createTask, getTask } from "../server/store";
import { handleTool } from "../server/tools";
import { issueToken } from "../server/tokens";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "cli-guard-"));
process.env.KANBAN_DATA_DIR = dir;

function running(role: string, agentId: string, status = "running"): number {
  const task = createTask({ project: "guard", title: role, role, workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = ? WHERE id = ?").run(status, agentId, task.id);
  return task.id;
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("cli help and required text", () => {
  it("prints usage for --help and -h without completing a card", async () => {
    const id = running("reader", "reader-help");
    for (const argv of [
      ["complete", String(id), "--help"],
      ["complete", String(id), "-h"],
      ["approve", String(id), "--help"],
      ["request-changes", String(id), "--help"],
      ["block", String(id), "--help"],
    ]) {
      const help = await runKanban(argv, { PASEO_AGENT_ID: "reader-help" });
      assert.equal(help, kanbanHelp());
    }
    assert.equal(getTask(id).status, "running");
    assert.equal(getTask(id).handoff_json, null);
  });

  it("rejects an empty summary or reason on every status-changing command", async () => {
    const reader = running("reader", "reader-empty");
    const reviewer = running("reviewer", "reviewer-empty", "reviewing");
    const executor = running("executor", "executor-empty");
    const cases: Array<{ argv: string[]; env: string; message: RegExp; id: number; status: string }> = [
      { argv: ["complete", String(reader), "--summary", ""], env: "reader-empty", message: new RegExp(zhCN("flow.error.noSummary")), id: reader, status: "running" },
      { argv: ["complete", String(reader), "--summary", "   "], env: "reader-empty", message: new RegExp(zhCN("flow.error.noSummary")), id: reader, status: "running" },
      { argv: ["complete", String(reader)], env: "reader-empty", message: new RegExp(zhCN("flow.error.noSummary")), id: reader, status: "running" },
      { argv: ["approve", String(reviewer), "--summary", ""], env: "reviewer-empty", message: new RegExp(zhCN("flow.error.noSummary")), id: reviewer, status: "reviewing" },
      { argv: ["approve", String(reviewer)], env: "reviewer-empty", message: new RegExp(zhCN("flow.error.noSummary")), id: reviewer, status: "reviewing" },
      { argv: ["request-changes", String(reviewer), "--reason", ""], env: "reviewer-empty", message: new RegExp(zhCN("flow.error.noReason")), id: reviewer, status: "reviewing" },
      { argv: ["request-changes", String(reviewer), "--reason", "  "], env: "reviewer-empty", message: new RegExp(zhCN("flow.error.noReason")), id: reviewer, status: "reviewing" },
      { argv: ["block", String(executor), "--kind", "needs_human", "--reason", ""], env: "executor-empty", message: new RegExp(zhCN("flow.error.noReason")), id: executor, status: "running" },
      { argv: ["block", String(executor), "--kind", "dependency"], env: "executor-empty", message: new RegExp(zhCN("flow.error.noReason")), id: executor, status: "running" },
    ];
    for (const item of cases) {
      await assert.rejects(() => runKanban(item.argv, { PASEO_AGENT_ID: item.env }), item.message);
      assert.equal(getTask(item.id).status, item.status);
    }

    const readerToken = issueToken("reader", reader, "reader-empty");
    await assert.rejects(() => handleTool("kanban_complete", { id: reader, summary: "" }, readerToken), new RegExp(zhCN("flow.error.noSummary")));
    await assert.rejects(() => handleTool("kanban_complete", { id: reader, summary: "  " }, readerToken), new RegExp(zhCN("flow.error.noSummary")));
    const reviewerToken = issueToken("reviewer", reviewer, "reviewer-empty");
    await assert.rejects(() => handleTool("kanban_approve", { id: reviewer, summary: "" }, reviewerToken), new RegExp(zhCN("flow.error.noSummary")));
    await assert.rejects(() => handleTool("kanban_request_changes", { id: reviewer, reason: "" }, reviewerToken), new RegExp(zhCN("flow.error.noReason")));
    const executorToken = issueToken("executor", executor, "executor-empty");
    await assert.rejects(() => handleTool("kanban_block", { id: executor, kind: "needs_human", reason: " " }, executorToken), new RegExp(zhCN("flow.error.noReason")));
    assert.equal(getTask(reader).status, "running");
    assert.equal(getTask(reviewer).status, "reviewing");
    assert.equal(getTask(executor).status, "running");
  });

  it("rejects unknown flags and extra positionals, and still accepts a real summary", async () => {
    const id = running("reader", "reader-unknown");
    await assert.rejects(() => runKanban(["complete", String(id), "--summary", "Written", "--bogus"], { PASEO_AGENT_ID: "reader-unknown" }), new RegExp(zhCN("checkMissingCwd.unknownArg", {"arg":"--bogus"})));
    await assert.rejects(() => runKanban(["complete", String(id), "extra", "--summary", "Written"], { PASEO_AGENT_ID: "reader-unknown" }), new RegExp(zhCN("checkMissingCwd.unknownArg", {"arg":"extra"})));
    await assert.rejects(() => runKanban(["nope"], {}), new RegExp(zhCN("cli.unknownCommand", {"command":"nope"})));
    assert.equal(getTask(id).status, "running");
    const done = (await runKanban(["complete", String(id), "--summary", "Written", "--handoff", '{"files":[]}'], { PASEO_AGENT_ID: "reader-unknown" })) as {
      status: string;
    };
    assert.equal(done.status, "acceptance");
    assert.equal(getTask(id).status, "acceptance");
  });
});
