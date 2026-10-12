/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { resolveCompactIdentity } from "../server/identity";
import { archiveTask, autoArchiveTask, createTask, getTask, notifyFinished } from "../server/store";
import { identityFromToken, issueToken, WORKER_TOKEN_GRACE_MS } from "../server/tokens";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "token-lifecycle-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function card(title: string, status: string): number {
  const task = createTask({ project: "tokens", title, role: "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
  return task.id;
}

function tokensOf(taskId: number): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM tokens WHERE task_id = ?").get(taskId) as { n: number }).n;
}

function expiresAt(token: string): string | null {
  return (getDb().prepare("SELECT expires_at FROM tokens WHERE token = ?").get(token) as { expires_at: string | null }).expires_at;
}

describe("worker token lifecycle", () => {
  it("archiving a card revokes its worker tokens and leaves other cards and the supervisor alone", () => {
    const id = card((zhCN("labels.status.archived") + "Demo text"), "blocked");
    const other = card(zhCNPart("boardView.external.step", 22, 25), "running");
    issueToken("executor", id, "agent-a");
    issueToken("reviewer", id, "agent-b");
    const keep = issueToken("executor", other, "agent-c");
    const supervisor = issueToken("supervisor", null, null);
    archiveTask(id, "supervisor");
    assert.equal(tokensOf(id), 0);
    assert.equal(identityFromToken(keep).taskId, other);
    assert.equal(identityFromToken(supervisor).role, "supervisor");
  });

  it("auto-archiving a done card revokes its worker tokens", () => {
    const id = card(zhCN("history.auto"), "done");
    const token = issueToken("batch", id, "agent-d");
    assert.ok(autoArchiveTask(id, "scheduler"));
    assert.equal(tokensOf(id), 0);
    assert.throws(() => identityFromToken(token), new RegExp(zhCN("identity.tokenInvalid")));
  });

  it("a card entering done gives its worker tokens an expiry one grace period out", () => {
    const id = card((zhCN("labels.status.done") + zhCNPart("doctor.matrix.stale", 4, 6)), "done");
    const token = issueToken("batch", id, "agent-e");
    const supervisor = issueToken("supervisor", null, null);
    const before = Date.now();
    notifyFinished(getTask(id));
    const stamp = Date.parse(expiresAt(token) ?? "");
    assert.ok(stamp >= before + WORKER_TOKEN_GRACE_MS - 1000 && stamp <= Date.now() + WORKER_TOKEN_GRACE_MS + 1000);
    assert.equal(expiresAt(supervisor), null);
    assert.equal(identityFromToken(token).taskId, id);
  });

  it("an expired token is invalid for the CLI, the MCP path and compact-events", () => {
    const id = card("Expired", "done");
    const token = issueToken("batch", id, "agent-f");
    getDb().prepare("UPDATE tokens SET expires_at = ? WHERE token = ?").run(new Date(Date.now() - 1000).toISOString(), token);
    assert.throws(() => identityFromToken(token), new RegExp(zhCN("identity.tokenInvalid")));
    assert.throws(() => resolveCompactIdentity({ KANBAN_TOKEN: token }, getDb()), new RegExp(zhCN("identity.tokenInvalid")));
  });

  it("a token whose expiry is still ahead keeps working", () => {
    const id = card("Unexpired", "done");
    const token = issueToken("batch", id, "agent-g");
    getDb().prepare("UPDATE tokens SET expires_at = ? WHERE token = ?").run(new Date(Date.now() + 60_000).toISOString(), token);
    assert.equal(identityFromToken(token).taskId, id);
    assert.equal(resolveCompactIdentity({ KANBAN_TOKEN: token }, getDb()).taskId, id);
  });

  it("the startup migration revokes legacy tokens on done and archived cards once, then leaves later ones to expires_at", () => {
    const done = card((zhCNPart("profileRules.tag.highRisk", 10, 12) + " done"), "done");
    const archived = card((zhCNPart("profileRules.tag.highRisk", 10, 12) + " archived"), "archived");
    const live = card((zhCNPart("profileRules.tag.highRisk", 10, 12) + " running"), "running");
    issueToken("executor", done, "m-1");
    issueToken("executor", archived, "m-2");
    issueToken("reviewer", archived, "m-3");
    const liveToken = issueToken("executor", live, "m-4");
    const supervisor = issueToken("supervisor", null, null);
    getDb().exec("PRAGMA user_version = 0"); // a database from before the one-time cleanup
    closeDb();
    getDb();
    assert.equal(tokensOf(done), 0);
    assert.equal(tokensOf(archived), 0);
    assert.equal(identityFromToken(liveToken).taskId, live);
    assert.equal(identityFromToken(supervisor).role, "supervisor");
    // A card that finishes after the cleanup keeps its token for the grace period across reopens.
    const fresh = card((zhCNPart("profileRules.tag.highRisk", 10, 12) + "Demo text"), "running");
    const freshToken = issueToken("executor", fresh, "m-5");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(fresh);
    notifyFinished(getTask(fresh));
    closeDb();
    getDb();
    assert.equal(identityFromToken(freshToken).taskId, fresh);
    assert.ok(expiresAt(freshToken));
  });

  it("reopening a done card for rework makes its executor token long-lived again", () => {
    const id = card((zhCN("labels.status.rework") + zhCNPart("cli.action.resumeCleanup", 0, 2)), "running");
    getDb().prepare("UPDATE tasks SET executor_agent_id = ? WHERE id = ?").run("agent-r", id);
    const token = issueToken("executor", id, "agent-r");
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    notifyFinished(getTask(id));
    assert.ok(expiresAt(token));
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(id);
    assert.equal(expiresAt(token), null);
    assert.equal(identityFromToken(token).taskId, id);
  });
});
