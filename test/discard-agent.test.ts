/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { drainCleanups, flushCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import type { Profile } from "../server/profiles";
import { appendEvent, createTask, getTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "discard-"));
process.env.KANBAN_DATA_DIR = dir;

const executor: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
};

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function events(taskId: number, kind: string): Array<Record<string, unknown>> {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as unknown as Array<{
    data_json: string;
  }>;
  return rows.map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

function pick(): { profiles: Profile[]; chosen: Profile; reason: string } {
  return { profiles: [executor], chosen: executor, reason: "Test" };
}

after(() => {
  installCleanup(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("discard an agent opened during a failed start", () => {
  it("archives the agent and records agent_discarded when the card is archived during create", async () => {
    const path = room("archived-during-create");
    const task = createTask({ project: "discard", title: "demo fixture Demo text", role: "executor", workspacePath: path });
    const archived: string[] = [];
    const workspaces: string[] = [];
    const launcher: AgentLauncher = {
      async create() {
        getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(task.id);
        return { id: "late-agent" };
      },
      async send() {},
      async archiveAgent(agentId) {
        archived.push(agentId);
      },
      async archiveWorkspace(workspaceId) {
        workspaces.push(workspaceId);
      },
    };
    await assert.rejects(() => startTask(task.id, launcher, "scheduler", pick()), new RegExp(localePattern(zhCNPart("dispatch.lostClaim", 35, 41))));
    assert.deepEqual(archived, ["late-agent"]);
    assert.deepEqual(workspaces, []);
    const discarded = events(task.id, "agent_discarded");
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0]?.agentId, "late-agent");
    assert.equal(discarded[0]?.archived, true);
    assert.match(String(discarded[0]?.reason), new RegExp(zhCN("labels.status.archived")));
    const after = getTask(task.id);
    assert.equal(after.status, "archived");
    assert.equal(after.agent_id, null);
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(task.id) as { n: number }).n,
      0,
    );
  });

  it("archives the agent when the card is put back to ready during create", async () => {
    const path = room("ready-during-create");
    const task = createTask({ project: "discard", title: "demo fixture Demo text", role: "executor", workspacePath: path });
    const archived: string[] = [];
    const launcher: AgentLauncher = {
      async create() {
        getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id);
        return { id: "extra-agent" };
      },
      async send() {},
      async archiveAgent(agentId) {
        archived.push(agentId);
      },
    };
    await assert.rejects(() => startTask(task.id, launcher, "scheduler", pick()), new RegExp(localePattern(zhCNPart("dispatch.lostClaim", 35, 41))));
    assert.deepEqual(archived, ["extra-agent"]);
    assert.equal(events(task.id, "agent_discarded")[0]?.agentId, "extra-agent");
    const after = getTask(task.id);
    assert.equal(after.status, "ready");
    assert.equal(after.agent_id, null);
  });

  it("records a retryable cleanup failure when archive fails, and cleanup retries it", async () => {
    const path = room("archive-fails");
    const task = createTask({ project: "discard", title: "archive failed", role: "executor", workspacePath: path });
    const archived: string[] = [];
    const ops: CleanupOps = {
      async archiveAgent(agentId) {
        archived.push(agentId);
      },
      async archiveWorkspace() {},
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    installCleanup(ops);
    const launcher: AgentLauncher = {
      async create() {
        getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(task.id);
        appendEvent(task.id, "cleanup_finished", null, null, "kanban", {});
        return { id: "stuck-agent" };
      },
      async send() {},
      async archiveAgent() {
        throw new Error("archive down");
      },
    };
    await assert.rejects(() => startTask(task.id, launcher, "scheduler", pick()), new RegExp(localePattern(zhCNPart("dispatch.lostClaim", 35, 41))));
    const discarded = events(task.id, "agent_discarded");
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0]?.agentId, "stuck-agent");
    assert.equal(discarded[0]?.archived, false);
    assert.match(String(discarded[0]?.error), /archive down/);
    const failure = events(task.id, "cleanup").find((row) => row.action === "archive_agent" && row.ok === false && row.agentId === "stuck-agent");
    assert.ok(failure);
    assert.equal(typeof failure?.retryAt, "string");
    assert.ok(Date.parse(String(failure?.retryAt)) > Date.now());
    await flushCleanups();
    assert.deepEqual(archived, []);
    await drainCleanups(new Date(Date.parse(String(failure?.retryAt)) + 1000));
    assert.deepEqual(archived, ["stuck-agent"]);
  });
});
