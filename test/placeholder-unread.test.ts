/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cardMark } from "../server/card-ref";
import { drainCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { PLACEHOLDER_NAME, loadCwdAgentList, placeholderBlocksRemoval } from "../server/missing-cwd";
import { appendEvent, createTask } from "../server/store";
import { tempBranchName } from "../server/workspace";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "ph-unread-"));
const trees = join(dir, "paseo-worktrees");
const agents = join(dir, "agents");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_WORKTREES_ROOT = trees;
process.env.KANBAN_AGENTS_DIR = agents;
mkdirSync(trees, { recursive: true });
mkdirSync(agents, { recursive: true });

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(String(stdout));
    });
  });
}

function writeAgent(id: string, cwd: string, taskId: string): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(
    join(agents, "bucket", `${id}.json`),
    JSON.stringify({
      id,
      cwd,
      title: id,
      provider: "cursor",
      labels: { kanban: "1", kanban_task: taskId },
      lastActivityAt: "2026-09-29T00:00:00.000Z",
    }),
  );
}

function writePlaceholder(directory: string, agentId: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, PLACEHOLDER_NAME),
    [
      zhCN("missingCwd.placeholder.intro"),
      (zhCNPart("reclaimNote.cause", 0, 3) + zhCN("missingCwd.patrol.placed")),
      `agent${zhCN("common.colon")}${agentId}`,
      zhCN("missingCwd.placeholder.keep"),
      "",
    ].join("\n"),
  );
}

function goneWorkspace(): CleanupOps {
  return {
    async archiveAgent() {},
    async archiveWorkspace() {
      throw new Error(("workspace " + zhCN("cleanup.reason.gone") + zhCNPart("missingCwd.placeholder.blocks", 5, 7) + "Demo text"));
    },
    async listAgents() {
      return [];
    },
    async inspectWorkspace() {
      return null;
    },
  };
}

async function landedPlaceholder(name: string): Promise<{ id: number; directory: string; agentId: string }> {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "README"), "a\n");
  await git(root, ["add", "README"]);
  await git(root, ["commit", "-m", "init"]);
  const task = createTask({ project: "tidy", title: name, role: "executor", workspacePath: root });
  const branch = tempBranchName(cardMark(task.id), name);
  const directory = join(trees, `${name}-card`);
  await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
  writeFileSync(join(directory, "landed.txt"), "x\n");
  await git(directory, ["add", "landed.txt"]);
  await git(directory, ["commit", "-m", "landed"]);
  await git(root, ["merge", "--ff-only", branch]);
  const agentId = `agent-${task.id}`;
  getDb()
    .prepare(
      `UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main', workspace_path = ?, paseo_workspace_id = ?, paseo_workspace_name = ?, agent_id = ?, executor_agent_id = ? WHERE id = ?`,
    )
    .run(directory, `ws-${task.id}`, cardMark(task.id), agentId, agentId, task.id);
  appendEvent(task.id, "temp_workspace", null, null, "test", { name: cardMark(task.id), root, base: "main" });
  appendEvent(task.id, "worktree_created", null, null, "test", { directory, branch, base: "main", root, temp: true });
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(task.id, agentId, new Date().toISOString());
  writeAgent(agentId, directory, String(task.id));
  await git(root, ["worktree", "remove", directory]);
  writePlaceholder(directory, agentId);
  appendEvent(task.id, "cwd_placeholder", null, null, "test", { agentId, path: directory, reason: "demo fixture" });
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  appendEvent(task.id, "accept", "acceptance", "done", "test", {});
  return { id: task.id, directory, agentId };
}

function hideAgentList(): string {
  const blocked = join(dir, `agents-not-a-directory-${Date.now()}`);
  writeFileSync(blocked, "not a directory\n");
  process.env.KANBAN_AGENTS_DIR = blocked;
  return blocked;
}

function cleanupRows(id: number): Array<Record<string, unknown>> {
  const rows = getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? ORDER BY id").all(id) as Array<{
    kind: string;
    data_json: string;
  }>;
  return rows.filter((row) => row.kind === "cleanup").map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("unreadable agent list", { concurrency: 1 }, () => {
  it("does not delete a placeholder when the agent list cannot be read", async () => {
    const { id, directory, agentId } = await landedPlaceholder("drop");
    appendEvent(id, "cleanup", null, null, "test", { action: "purge_agents", directory, ok: true });
    hideAgentList();
    assert.equal(placeholderBlocksRemoval(directory, id), zhCN("missingCwd.unreadAgentList"));
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), true);
    assert.equal(existsSync(join(agents, "bucket", `${agentId}.json`)), true);
    assert.equal(
      (getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'cleanup_finished'").get(id) as { id: number } | undefined) == null,
      true,
    );
    const refused = cleanupRows(id).find((row) => row.action === "drop_directory" && row.ok === false);
    assert.match(String(refused?.error), new RegExp(zhCN("missingCwd.unreadAgentList")));
  });

  it("does not record a purge when the agent list cannot be read", async () => {
    const { id, directory, agentId } = await landedPlaceholder("purge");
    hideAgentList();
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
    }
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), true);
    assert.equal(existsSync(join(agents, "bucket", `${agentId}.json`)), true);
    const refused = cleanupRows(id).find((row) => row.action === "purge_agents" && row.ok === false);
    assert.match(String(refused?.error), new RegExp(zhCN("missingCwd.unreadAgentList")));
    assert.equal(
      cleanupRows(id).some((row) => row.action === "purge_agents" && row.ok === true && row.agentId == null),
      false,
    );
  });

  it("treats a missing agent directory as no agents, so cleanup can drop the placeholder", async () => {
    const { id, directory } = await landedPlaceholder("enoent");
    appendEvent(id, "cleanup", null, null, "test", { action: "purge_agents", directory, ok: true });
    const missing = join(dir, "agents-do-not-exist");
    process.env.KANBAN_AGENTS_DIR = missing;
    assert.equal(existsSync(missing), false);
    assert.deepEqual(loadCwdAgentList(), []);
    assert.equal(placeholderBlocksRemoval(directory, id), null);
    const release = installCleanup(goneWorkspace(), { timeoutMs: 5_000 });
    try {
      await drainCleanups();
    } finally {
      release();
      process.env.KANBAN_AGENTS_DIR = agents;
    }
    assert.equal(existsSync(join(directory, PLACEHOLDER_NAME)), false);
    const dropped = cleanupRows(id).find((row) => row.action === "drop_directory" && row.ok === true);
    assert.ok(dropped);
    assert.equal(
      cleanupRows(id).some((row) => String(row.error ?? "").includes(zhCNPart("missingCwd.unreadAgentList", 0, 12))),
      false,
    );
  });
});
