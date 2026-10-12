/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { applyFailure, reclaimTask } from "../server/failures";
import { approveTask, requestChanges } from "../server/flow";
import type { Profile } from "../server/profiles";
import { createTask, getTask } from "../server/store";
import { identityFromToken, issueToken } from "../server/tokens";
import { handleTool } from "../server/tools";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "token-guard-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });

const profile: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
};

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

function openRun(taskId: number, agentId: string, role: string): void {
  getDb()
    .prepare(`INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, ?, ?)`)
    .run(taskId, agentId, role, new Date().toISOString());
}

describe("worker tokens", () => {
  it("rejects complete and approve from a token that is not the current agent", async () => {
    const task = createTask({ project: "guard", title: "Current agent", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run("agent-now", task.id);
    const current = issueToken("executor", task.id, "agent-now");
    const leaked = issueToken("executor", task.id, "agent-old");
    await assert.rejects(() => handleTool("kanban_complete", { id: task.id, summary: "Unauthorized completion" }, leaked), new RegExp(localePattern(zhCNPart("tools.tokenNotCardAgent", 14, 28))));
    const rejected = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'token_rejected'").get(task.id) as {
      data_json: string;
    };
    assert.match(rejected.data_json, /agent-old/);
    const done = (await handleTool("kanban_complete", { id: task.id, summary: "Submitted" }, current)) as { status: string };
    assert.equal(done.status, "in_review");

    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = ? WHERE id = ?").run("review-now", task.id);
    const reviewer = issueToken("reviewer", task.id, "review-now");
    const oldReview = issueToken("reviewer", task.id, "review-old");
    await assert.rejects(() => handleTool("kanban_approve", { id: task.id, summary: "sample" }, oldReview), new RegExp(localePattern(zhCNPart("tools.tokenNotCardAgent", 14, 28))));
    openRun(task.id, "review-now", "reviewer");
    const approved = (await handleTool("kanban_approve", { id: task.id, summary: "sample" }, reviewer)) as { status: string };
    assert.equal(approved.status, "acceptance");
    assert.throws(() => identityFromToken(reviewer), new RegExp(localePattern(zhCNPart("identity.tokenInvalid", 9, 11))));
  });

  it("revokes the token when a run fails, is reclaimed, or is replaced", async () => {
    const failed = createTask({ project: "guard", title: "failed", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run("fail-agent", failed.id);
    openRun(failed.id, "fail-agent", "executor");
    const failToken = issueToken("executor", failed.id, "fail-agent");
    applyFailure(failed.id, "socket hang up", "other");
    assert.throws(() => identityFromToken(failToken), new RegExp(localePattern(zhCNPart("identity.tokenInvalid", 9, 11))));

    const gone = createTask({ project: "guard", title: "demo fixture", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run("gone-agent", gone.id);
    openRun(gone.id, "gone-agent", "executor");
    const goneToken = issueToken("executor", gone.id, "gone-agent");
    assert.equal(reclaimTask(gone.id), "reclaimed");
    assert.throws(() => identityFromToken(goneToken), new RegExp(localePattern(zhCNPart("identity.tokenInvalid", 9, 11))));

    const replaced = createTask({ project: "guard", title: "Replace agent", role: "executor", workspacePath: dir });
    const old = issueToken("executor", replaced.id, "old-exec");
    await startTask(replaced.id, { async create() { return { id: "new-exec" }; }, async send() {} }, "test", { profiles: [profile], chosen: profile });
    assert.equal(getTask(replaced.id).agent_id, "new-exec");
    assert.throws(() => identityFromToken(old), new RegExp(localePattern(zhCNPart("identity.tokenInvalid", 9, 11))));
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE task_id = ? AND agent_id = ?").get(replaced.id, "new-exec") as { n: number }).n,
      1,
    );
  });

  it("drops the reviewer token on request changes and keeps the executor token for the same agent", () => {
    const task = createTask({ project: "guard", title: "Sent back", role: "executor", workspacePath: dir });
    getDb()
      .prepare("UPDATE tasks SET status = 'reviewing', agent_id = ?, executor_agent_id = ? WHERE id = ?")
      .run("rev-agent", "exec-agent", task.id);
    openRun(task.id, "rev-agent", "reviewer");
    const reviewer = issueToken("reviewer", task.id, "rev-agent");
    const executor = issueToken("executor", task.id, "exec-agent");
    requestChanges(task.id, zhCNPart("taskLifecycle.blockIgnored.archived", 7, 9), "Add tests", "reviewer");
    assert.equal(getTask(task.id).status, "rework");
    assert.equal(getTask(task.id).agent_id, "exec-agent");
    assert.throws(() => identityFromToken(reviewer), new RegExp(localePattern(zhCNPart("identity.tokenInvalid", 9, 11))));
    assert.equal(identityFromToken(executor).agentId, "exec-agent");
  });
});
