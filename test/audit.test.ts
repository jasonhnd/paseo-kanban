/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { formatAudit, performAudit, type AuditView } from "../server/audit";
import { kanbanHelp, runKanban } from "../server/cli";
import { closeDb, getDb } from "../server/db";
import type { ListedWorkspace } from "../server/placement";
import { createTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "audit-"));
process.env.KANBAN_DATA_DIR = dir;

const tree: ListedWorkspace = {
  id: "wt-left",
  name: "card-worktree",
  directory: join(dir, "tree"),
  projectRoot: join(dir, "root"),
  projectId: "parent-project",
  kind: "worktree",
  archived: false,
};

function fingerprint(): string {
  const db = getDb();
  return JSON.stringify({
    tasks: db.prepare("SELECT * FROM tasks ORDER BY id").all(),
    runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
    events: db.prepare("SELECT * FROM events ORDER BY id").all(),
    tokens: db.prepare("SELECT * FROM tokens ORDER BY token").all(),
    comments: db.prepare("SELECT * FROM comments ORDER BY id").all(),
  });
}

function addRun(taskId: number, agentId: string): void {
  getDb()
    .prepare(
      ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n       VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
    )
    .run(taskId, agentId, new Date().toISOString());
}

function addCleanup(taskId: number, data: Record<string, unknown>): void {
  getDb()
    .prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'cleanup', 'kanban', ?)")
    .run(taskId, new Date().toISOString(), JSON.stringify(data));
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("audit", () => {
  it("names leaked agents, leftover worktrees, and stuck cleanup without writing", async () => {
    const leaked = createTask({ project: "audit", title: "Missed", role: "executor", workspacePath: join(dir, "root") });
    getDb().prepare("UPDATE tasks SET status = 'done', workspace_kind = 'worktree', paseo_workspace_id = 'wt-left' WHERE id = ?").run(leaked.id);
    addRun(leaked.id, "leak-agent-0123456789");
    const stuck = createTask({ project: "audit", title: "Blocked archive", role: "executor", workspacePath: join(dir, "other") });
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(stuck.id);
    addRun(stuck.id, "stuck-agent-abcdef");
    for (let i = 0; i < 3; i += 1) {
      addCleanup(stuck.id, { action: "archive_agent", agentId: "stuck-agent-abcdef", ok: false, outcome: "timeout", error: zhCN("audit.timeout") });
    }
    const running = createTask({ project: "audit", title: "Still working", role: "executor", workspacePath: join(dir, "live") });
    addRun(running.id, "still-working-agent");
    const sharedA = createTask({ project: "audit", title: "Shared A", role: "executor" });
    const sharedB = createTask({ project: "audit", title: "Shared B", role: "executor" });
    getDb().prepare("UPDATE tasks SET status = 'done', workspace_kind = 'worktree', paseo_workspace_id = 'wt-shared' WHERE id = ?").run(sharedA.id);
    getDb().prepare("UPDATE tasks SET status = 'done', workspace_kind = 'worktree', paseo_workspace_id = 'wt-shared' WHERE id = ?").run(sharedB.id);

    let inspections = 0;
    const view: AuditView = {
      async listActiveAgents() {
        return [
          { id: "leak-agent-0123456789", archived: false, workspaceId: "wt-left" },
          { id: "still-working-agent", archived: false, workspaceId: null },
          { id: "already-archived", archived: true, workspaceId: "wt-left" },
        ];
      },
      async inspectWorkspace(workspaceId) {
        inspections += 1;
        if (workspaceId === "wt-shared") return { ...tree, id: "wt-shared", name: "shared" };
        assert.equal(workspaceId, "wt-left");
        return tree;
      },
    };
    const before = fingerprint();
    const report = await performAudit(view);
    assert.equal(fingerprint(), before);
    assert.equal(inspections, 3);
    assert.equal(report.ok, false);
    const leakCard = report.cards.find((card) => card.id === leaked.id);
    assert.ok(leakCard);
    assert.deepEqual(leakCard?.unarchivedAgents, ["leak-agent-0123456789"]);
    assert.deepEqual(leakCard?.unclearedWorkspaces, ["wt-left"]);
    const stuckCard = report.cards.find((card) => card.id === stuck.id);
    assert.equal(stuckCard?.stuck[0], zhCN("archiveBook.label.stuck", {"agent":"stuck-ag"}));
    assert.equal(report.cards.some((card) => card.id === running.id), false);
    assert.equal(report.cards.some((card) => card.id === sharedA.id || card.id === sharedB.id), false);
    const text = formatAudit(report);
    assert.match(text, new RegExp(zhCN("audit.unarchived", {"id":"leak-agent-0123456789"})));
    assert.match(text, new RegExp(zhCN("audit.uncleared", {"id":"wt-left"})));
    assert.match(text, new RegExp(zhCN("audit.unusedWorkspace", {"id":"wt-left"})));
    assert.match(text, new RegExp(zhCN("audit.unusedWorkspace", {"id":"wt-shared"})));
    assert.match(text, new RegExp(zhCN("archiveBook.label.stuck", {"agent":"stuck-ag"})));
    assert.equal(text.includes(zhCN("audit.summary.clean")), false);
    assert.equal(text.includes("still-working-agent"), false);

    addCleanup(stuck.id, { action: "archive_agent", agentId: "stuck-agent-abcdef", ok: true });
    const quiet: AuditView = {
      async listActiveAgents() {
        return [];
      },
      async inspectWorkspace() {
        return { ...tree, archived: true };
      },
    };
    const quietBefore = fingerprint();
    const clean = await runKanban(["audit"], {}, { auditView: quiet });
    assert.equal(clean, ((zhCN("audit.summary.clean") + "\n") + zhCNPart("audit.lastTick", 0, 10) + zhCN("doctor.none") + "\n" + zhCN("doctor.auditLine.none")));
    assert.equal(fingerprint(), quietBefore);
    const json = (await runKanban(["audit", "--json"], {}, { auditView: quiet })) as { ok: boolean; message: string };
    assert.equal(json.ok, true);
    assert.equal(json.message, zhCN("audit.summary.clean"));
    assert.equal(fingerprint(), quietBefore);
    assert.match(kanbanHelp(), /\baudit\b/);
  });

  it("lists a card whose agent has been idle without handing work in", async () => {
    const stalled = createTask({ project: "audit", title: "Stalled reader", role: "reader", workspacePath: join(dir, "stalled") });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run("idle-reader", stalled.id);
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'stalled', 'scheduler', ?)")
      .run(stalled.id, new Date().toISOString(), JSON.stringify({ agentId: "idle-reader", text: zhCN("stall.label", {"minutes":"12"}) }));
    const view: AuditView = {
      async listActiveAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const report = await performAudit(view);
    assert.equal(report.ok, false);
    assert.equal(report.message, zhCN("audit.summary.stalled"));
    const card = report.cards.find((item) => item.id === stalled.id);
    assert.equal(card?.stalled, zhCN("stall.label", {"minutes":"12"}));
    assert.match(formatAudit(report), new RegExp("[A-Z0-9]+_\\d+ Stalled reader"));
    assert.match(formatAudit(report), new RegExp(zhCN("stall.label", {"minutes":"12"})));
  });
});
