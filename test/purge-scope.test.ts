/// <reference types="node" />
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readCleanupEvents } from "../server/archive-book";
import { cardMark } from "../server/card-ref";
import { drainCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { purgeCardAgents, resetMissingCwdForTests, setMissingCwdHooks, type CwdAgent } from "../server/missing-cwd";
import { appendEvent, createTask } from "../server/store";
import { branchName, tempBranchName } from "../server/workspace";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "purge-scope-"));
const trees = join(dir, "paseo-worktrees");
const agents = join(dir, "agents");
mkdirSync(trees, { recursive: true });
mkdirSync(agents, { recursive: true });
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_WORKTREES_ROOT = trees;
process.env.KANBAN_AGENTS_DIR = agents;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(String(stdout));
    });
  });
}

async function makeRepo(name: string, base = "main"): Promise<string> {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  await git(root, ["init", "-b", base]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "README"), "a\n");
  await git(root, ["add", "README"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

function agentPath(id: string): string {
  return join(agents, "bucket", `${id}.json`);
}

function writeAgent(id: string, cwd: string, taskId: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(
    agentPath(id),
    JSON.stringify({
      id,
      cwd,
      title: id,
      provider: "cursor",
      labels: { kanban: "1", kanban_task: taskId },
      lastActivityAt: "2026-09-01T00:00:00.000Z",
      ...extra,
    }),
  );
}

function eventData(taskId: number, kind: string): Array<Record<string, unknown>> {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

function namesAgent(row: Record<string, unknown>, agentId: string): boolean {
  if (row.agentId === agentId) return true;
  return JSON.stringify(row).includes(agentId);
}

after(() => {
  resetMissingCwdForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("cleanup purges only the agents this card recorded", () => {
  it("does not purge another finished card's executor and reviewer that share the directory", async () => {
    const root = await makeRepo("shared-temp");
    const card = createTask({ project: "shared-temp", title: "Cleaning card", role: "executor", workspacePath: root });
    const branch = tempBranchName(cardMark(card.id), "Cleaning card");
    const directory = join(trees, "shared-temp-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
    writeFileSync(join(directory, "landed.txt"), "x\n");
    await git(directory, ["add", "landed.txt"]);
    await git(directory, ["commit", "-m", "landed"]);
    await git(root, ["merge", "--ff-only", branch]);
    const own = `agent-${card.id}`;
    getDb()
      .prepare(
        `UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main', workspace_path = ?, paseo_workspace_id = ?, paseo_workspace_name = ?, agent_id = ?, executor_agent_id = ?, status = 'done' WHERE id = ?`,
      )
      .run(directory, `ws-${card.id}`, cardMark(card.id), own, own, card.id);
    appendEvent(card.id, "temp_workspace", null, null, "test", { name: cardMark(card.id), root, base: "main" });
    appendEvent(card.id, "worktree_created", null, null, "test", { directory, branch, base: "main", root, temp: true });
    appendEvent(card.id, "accept", "acceptance", "done", "test", {});
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(card.id, own, "2026-09-29T00:00:00.000Z");
    writeAgent(own, directory, String(card.id));

    const other = createTask({ project: "shared-temp", title: "Finished earlier", role: "executor", workspacePath: directory });
    const executor = `exec-${other.id}`;
    const reviewer = `review-${other.id}`;
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(reviewer, executor, other.id);
    appendEvent(other.id, "accept", "acceptance", "done", "test", {});
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(other.id, executor, "2026-09-01T00:00:00.000Z");
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'reviewer', ?)").run(other.id, reviewer, "2026-09-01T00:00:00.000Z");
    appendEvent(other.id, "agent_opened", null, null, "test", { agentId: executor });
    appendEvent(other.id, "agent_opened", null, null, "test", { agentId: reviewer });
    writeAgent(executor, directory, String(other.id));
    writeAgent(reviewer, directory, String(other.id));

    const deleted: string[] = [];
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        deleted.push(agentId);
        rmSync(agentPath(agentId), { force: true });
      },
    });
    let archives = 0;
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {
        archives += 1;
        rmSync(directory, { recursive: true, force: true });
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return { id: `ws-${card.id}`, name: `ws-${card.id}`, directory, projectRoot: root, projectId: "p", kind: "worktree", archived: false };
      },
      async inspectAgent(agentId) {
        if (!existsSync(agentPath(agentId))) return null;
        return { archived: false, busy: false };
      },
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups(new Date("2026-10-15T00:00:00.000Z"));
    } finally {
      release();
      resetMissingCwdForTests();
    }

    assert.deepEqual(deleted.filter((id) => id === executor || id === reviewer), []);
    assert.equal(deleted.includes(own), true);
    assert.equal(existsSync(agentPath(own)), false);
    assert.equal(existsSync(agentPath(executor)), true);
    assert.equal(existsSync(agentPath(reviewer)), true);
    assert.equal(existsSync(directory), true);
    assert.equal(archives, 0);
    for (const taskId of [card.id, other.id]) {
      for (const row of eventData(taskId, "agent_purged")) {
        assert.equal(namesAgent(row, executor), false);
        assert.equal(namesAgent(row, reviewer), false);
      }
      for (const row of eventData(taskId, "cleanup")) {
        assert.equal(namesAgent(row, executor), false);
        assert.equal(namesAgent(row, reviewer), false);
      }
    }
    assert.equal(eventData(card.id, "agent_purged").some((row) => row.agentId === own), true);
  });

  it("does not let purge-agents delete an agent recorded on another card", async () => {
    const root = join(dir, "label-root");
    mkdirSync(root, { recursive: true });
    const card = createTask({ project: "label-scope", title: "Purge this card", role: "executor", workspacePath: root });
    const other = createTask({ project: "label-scope", title: "Owns the labeled agent", role: "executor", workspacePath: root });
    const own = `own-${card.id}`;
    const foreign = `foreign-${other.id}`;
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ? WHERE id = ?").run(own, card.id);
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ? WHERE id = ?").run(foreign, other.id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(card.id, own, "2026-09-29T00:00:00.000Z");
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(other.id, foreign, "2026-09-01T00:00:00.000Z");
    const shared = join(dir, "label-cwd");
    mkdirSync(shared, { recursive: true });
    writeAgent(own, shared, String(card.id));
    writeAgent(foreign, shared, String(card.id));
    const deleted: string[] = [];
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        deleted.push(agentId);
        rmSync(agentPath(agentId), { force: true });
      },
    });
    try {
      const result = await purgeCardAgents(card.id);
      assert.deepEqual(result.deleted, [own]);
      assert.equal(existsSync(agentPath(foreign)), true);
      assert.equal(existsSync(agentPath(own)), false);
      assert.equal(eventData(card.id, "agent_purged").some((row) => row.agentId === foreign), false);
      assert.equal(eventData(other.id, "agent_purged").some((row) => row.agentId === foreign), false);
    } finally {
      resetMissingCwdForTests();
    }
  });

  it("does not remove a merged worktree while another card's idle agent still points at it", async () => {
    const root = await makeRepo("shared-gc", "pre");
    const card = createTask({ project: "shared-gc", title: "Merged copy", role: "executor", workspacePath: root });
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'pre' WHERE id = ?").run(card.id);
    const branch = branchName(card.id, "Merged copy");
    const directory = join(trees, "shared-gc-card");
    await git(root, ["worktree", "add", "-b", branch, directory, "pre"]);
    writeFileSync(join(directory, "merged.txt"), "x\n");
    await git(directory, ["add", "merged.txt"]);
    await git(directory, ["commit", "-m", "merged"]);
    await git(root, ["merge", branch]);
    appendEvent(card.id, "worktree_created", null, null, "test", { directory, branch, base: "pre", root });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(card.id);

    const other = createTask({ project: "shared-gc", title: "Idle neighbor", role: "reviewer", workspacePath: directory });
    const neighbor = `neighbor-${other.id}`;
    getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ? WHERE id = ?").run(neighbor, other.id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'reviewer', ?)").run(other.id, neighbor, "2026-09-01T00:00:00.000Z");
    const agent: CwdAgent = {
      id: neighbor,
      cwd: directory,
      provider: "cursor",
      title: "idle neighbor",
      archived: false,
      lastActivityAt: "2026-09-01T00:00:00.000Z",
      labels: { kanban: "1", kanban_task: String(other.id) },
    };
    const deleted: string[] = [];
    setMissingCwdHooks({
      listAgents: () => (deleted.includes(neighbor) ? [] : [agent]),
      deleteAgent: async (agentId) => {
        deleted.push(agentId);
      },
    });
    const ops: CleanupOps = {
      async archiveAgent() {},
      async archiveWorkspace() {},
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
      async inspectAgent() {
        return { archived: false, busy: false };
      },
    };
    const release = installCleanup(ops, { timeoutMs: 5_000 });
    try {
      await drainCleanups(new Date("2026-10-15T00:00:00.000Z"));
    } finally {
      release();
      resetMissingCwdForTests();
    }

    assert.deepEqual(deleted, []);
    assert.equal(existsSync(directory), true);
    const cleanup = readCleanupEvents(card.id);
    assert.equal(cleanup.some((event) => event.action === "remove_worktree" && event.ok === true), false);
    assert.equal(cleanup.some((event) => event.action === "wait_turn" && event.agentId === neighbor), false);
    assert.equal(cleanup.some((event) => JSON.stringify(event).includes(neighbor)), false);
    assert.equal(eventData(other.id, "agent_purged").length, 0);
  });
});
