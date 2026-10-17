/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readCleanupEvents, resumeCleanup, retryReady, type CleanupRecord } from "../server/archive-book";
import { doctorSettings, loadConfig } from "../server/config";
import { drainCleanups, installCleanup, record, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { parseWorktreePorcelain, runDoctor } from "../server/doctor";
import { cardMark } from "../server/card-ref";
import {
  resetMissingCwdForTests,
  retainAgentsBeforeDirectoryRemoval,
  setMissingCwdHooks,
} from "../server/missing-cwd";
import { appendEvent, createTask } from "../server/store";
import { tempBranchName } from "../server/workspace";

const tmp = realpathSync(tmpdir());
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "borrowed-ws-"));
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

function gitSync(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo(name: string): Promise<string> {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "README"), "a\n");
  await git(root, ["add", "README"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

function agentFile(id: string): string {
  return join(agents, "bucket", `${id}.json`);
}

function writeAgent(id: string, cwd: string, taskId: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(agentFile(id), JSON.stringify({
    id,
    cwd,
    title: id,
    provider: "cursor",
    labels: { kanban: "1", kanban_task: taskId },
    lastActivityAt: "2026-09-29T00:00:00.000Z",
    ...extra,
  }));
}

function eventRows(id: number): Array<{ kind: string; data_json: string }> {
  return getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? ORDER BY id").all(id) as Array<{ kind: string; data_json: string }>;
}

function namesAgent(id: number, agentId: string): boolean {
  return eventRows(id).some((row) => row.data_json.includes(agentId));
}

async function landedOwner(name: string): Promise<{ id: number; root: string; directory: string; branch: string; agentId: string; workspaceId: string }> {
  const root = await makeRepo(name);
  const task = createTask({ project: name, title: name, role: "executor", workspacePath: root });
  const branch = tempBranchName(cardMark(task.id), name);
  const directory = join(trees, `${name}-card`);
  await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
  writeFileSync(join(directory, "landed.txt"), "x\n");
  await git(directory, ["add", "landed.txt"]);
  await git(directory, ["commit", "-m", "landed"]);
  await git(root, ["merge", "--ff-only", branch]);
  const agentId = `agent-${task.id}`;
  const workspaceId = `ws-${task.id}`;
  getDb().prepare(
    `UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main', workspace_path = ?, paseo_workspace_id = ?, paseo_workspace_name = ?, agent_id = ?, executor_agent_id = ? WHERE id = ?`,
  ).run(directory, workspaceId, cardMark(task.id), agentId, agentId, task.id);
  appendEvent(task.id, "temp_workspace", null, null, "test", { name: cardMark(task.id), root, base: "main" });
  appendEvent(task.id, "worktree_created", null, null, "test", { directory, branch, base: "main", root, temp: true });
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(task.id, agentId, new Date().toISOString());
  writeAgent(agentId, directory, String(task.id));
  return { id: task.id, root, directory, branch, agentId, workspaceId };
}

function borrow(owner: { id: number; directory: string; workspaceId: string }, status: string): { id: number; agentId: string } {
  const sibling = createTask({
    project: "borrowed",
    title: "Review",
    role: "reviewer",
    workspacePath: owner.directory,
    reviewOf: owner.id,
  });
  const agentId = `review-${sibling.id}`;
  getDb().prepare("UPDATE tasks SET status = ?, paseo_workspace_id = ?, agent_id = ? WHERE id = ?").run(status, owner.workspaceId, agentId, sibling.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'reviewer', ?)").run(sibling.id, agentId, new Date().toISOString());
  writeAgent(agentId, owner.directory, String(sibling.id));
  return { id: sibling.id, agentId };
}

function markDone(id: number): void {
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
  appendEvent(id, "accept", "acceptance", "done", "test", {});
}

function opsFor(directory: string, root: string, archived: { n: number }): CleanupOps {
  return {
    async archiveAgent() {},
    async archiveWorkspace() {
      archived.n += 1;
      rmSync(directory, { recursive: true, force: true });
    },
    async listAgents() {
      return [];
    },
    async inspectWorkspace(workspaceId) {
      return { id: workspaceId, name: workspaceId, directory, projectRoot: root, projectId: "p", kind: "worktree", archived: false };
    },
    async inspectAgent(agentId) {
      if (!existsSync(agentFile(agentId))) return null;
      return { archived: false, busy: false };
    },
  };
}

after(() => {
  resetMissingCwdForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("a review card that borrowed a temporary workspace", () => {
  it("releases the claim when both cards are finished, and waits while the review is still open", async () => {
    const owner = await landedOwner("both-done");
    const review = borrow(owner, "reviewing");
    const archived = { n: 0 };
    const deleted: string[] = [];
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        deleted.push(agentId);
        rmSync(agentFile(agentId), { force: true });
      },
    });
    const release = installCleanup(opsFor(owner.directory, owner.root, archived), { timeoutMs: 5_000 });
    const start = new Date();
    try {
      markDone(owner.id);
      await drainCleanups(start);
      assert.equal(existsSync(owner.directory), true);
      assert.equal(existsSync(agentFile(review.agentId)), true);
      assert.equal(eventRows(owner.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      assert.equal(archived.n, 0);

      markDone(review.id);
      await drainCleanups(new Date(start.getTime() + 1_000));
      assert.equal(existsSync(agentFile(review.agentId)), false);
      assert.equal(deleted.includes(review.agentId), true);
      assert.equal(namesAgent(owner.id, review.agentId), false);
      assert.equal(existsSync(owner.directory), false);
      assert.equal((await git(owner.root, ["branch", "--list", owner.branch])).trim(), "");
      assert.equal(eventRows(owner.id).some((row) => row.kind === "temp_workspace_cleaned"), true);
      assert.equal(eventRows(review.id).some((row) => row.kind === "cleanup_finished"), true);
      assert.equal(archived.n, 1);
      const report = await runDoctor({
        persist: false,
        now: new Date(start.getTime() + 4 * 60 * 60 * 1000),
        settings: doctorSettings(loadConfig()),
        sources: {
          workspaces: [{
            id: owner.workspaceId,
            name: owner.workspaceId,
            directory: owner.directory,
            projectRoot: owner.root,
            kind: "worktree",
            archived: true,
          }],
          agents: { agents: [] },
          dirs: {
            root: trees,
            list: () => [],
            placeholderAgents: () => null,
            worktrees: [],
            scanned: true,
          },
          git: {
            repos: [owner.root],
            worktrees: async () => parseWorktreePorcelain(gitSync(owner.root, ["worktree", "list", "--porcelain"])),
            branches: async () => gitSync(owner.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean),
            dirty: async () => false,
            pushed: async () => false,
            pr: async () => "none",
          },
        },
      });
      const reds = report.findings.filter((finding) => finding.severity === "red" && (
        finding.symptom === zhCN("doctor.git.worktree.notUnfinished") || finding.symptom === zhCN("doctor.ws.orphan.cleaned")
      ));
      assert.deepEqual(reds.map((finding) => finding.symptom), []);
    } finally {
      release();
      resetMissingCwdForTests();
    }
  });

  it("keeps the directory while the review card is still open", async () => {
    const owner = await landedOwner("still-open");
    const review = borrow(owner, "reviewing");
    const archived = { n: 0 };
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        rmSync(agentFile(agentId), { force: true });
      },
    });
    const release = installCleanup(opsFor(owner.directory, owner.root, archived), { timeoutMs: 5_000 });
    try {
      markDone(owner.id);
      await drainCleanups(new Date());
      assert.equal(existsSync(owner.directory), true);
      assert.equal(existsSync(agentFile(review.agentId)), true);
      assert.equal(eventRows(owner.id).some((row) => row.kind === "temp_workspace_cleaned"), false);
      assert.equal(archived.n, 0);
    } finally {
      release();
      resetMissingCwdForTests();
    }
  });

  it("still blocks on a live agent of a finished card, and does not delete that agent", async () => {
    const owner = await landedOwner("live-block");
    const review = borrow(owner, "done");
    appendEvent(review.id, "accept", "reviewing", "done", "test", {});
    const archived = { n: 0 };
    const deleted: string[] = [];
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        if (agentId === review.agentId) throw new Error("kept");
        deleted.push(agentId);
        rmSync(agentFile(agentId), { force: true });
      },
    });
    const release = installCleanup(opsFor(owner.directory, owner.root, archived), { timeoutMs: 5_000 });
    try {
      markDone(owner.id);
      await drainCleanups(new Date());
      assert.equal(existsSync(agentFile(review.agentId)), true);
      assert.equal(deleted.includes(review.agentId), false);
      assert.equal(namesAgent(owner.id, review.agentId), false);
      assert.equal(existsSync(owner.directory), true);
      assert.equal(archived.n, 0);
      const held = readCleanupEvents(owner.id).filter((row) => row.action === "purge_agents" && row.ok === false && row.agentId === undefined);
      assert.equal(held.length, 1);
      assert.equal(held[0]?.error, zhCN("tempWorkspace.agents.foreignDirectory"));
    } finally {
      release();
      resetMissingCwdForTests();
    }
  });

  it("ignores an archived agent file of a finished card and removes the directory", async () => {
    const owner = await landedOwner("archived-file");
    const review = borrow(owner, "done");
    appendEvent(review.id, "accept", "reviewing", "done", "test", {});
    writeAgent(review.agentId, owner.directory, String(review.id), { archivedAt: "2026-10-05T06:41:33.625Z" });
    const archived = { n: 0 };
    setMissingCwdHooks({
      async deleteAgent(agentId) {
        if (agentId === review.agentId) throw new Error("kept");
        rmSync(agentFile(agentId), { force: true });
      },
    });
    const release = installCleanup(opsFor(owner.directory, owner.root, archived), { timeoutMs: 5_000 });
    try {
      markDone(owner.id);
      await drainCleanups(new Date());
      assert.equal(existsSync(agentFile(review.agentId)), true);
      assert.equal(namesAgent(owner.id, review.agentId), false);
      assert.equal(existsSync(owner.directory), false);
      assert.equal(archived.n, 1);
      assert.equal(eventRows(owner.id).some((row) => row.kind === "temp_workspace_cleaned"), true);
    } finally {
      release();
      resetMissingCwdForTests();
    }
  });
});

describe("process cwd still occupies a directory an archived agent no longer holds", () => {
  it("holds for a live cwd, an unreadable listing, or a thrown hook, and not when lsof is absent", async () => {
    const owner = await landedOwner("process-cwd");
    const review = borrow(owner, "done");
    appendEvent(review.id, "accept", "reviewing", "done", "test", {});
    writeAgent(review.agentId, owner.directory, String(review.id), { archivedAt: "2026-10-05T06:41:33.625Z" });
    const scope = { taskId: owner.id, recorded: new Set([owner.agentId]) };
    async function outside(list: () => string[] | null | "no-lsof"): Promise<string[]> {
      setMissingCwdHooks({ listProcessCwds: list, async deleteAgent() { throw new Error("kept"); } });
      const result = await retainAgentsBeforeDirectoryRemoval(owner.directory, undefined, scope);
      return result.outside;
    }
    try {
      assert.deepEqual(await outside(() => [owner.directory]), ["process"]);
      assert.deepEqual(await outside(() => "no-lsof"), []);
      assert.deepEqual(await outside(() => null), ["process"]);
      assert.deepEqual(await outside(() => { throw new Error("unreadable"); }), ["process"]);
    } finally {
      resetMissingCwdForTests();
    }
  });
});

describe("resume-cleanup brings a backoff forward", () => {
  it("retries a future retryAt without resetting the attempt count", () => {
    const task = createTask({ project: "backoff", title: "backoff", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    const events: CleanupRecord[] = [];
    const at = new Date("2026-10-03T00:00:00.000Z");
    record(task.id, {
      action: "purge_agents",
      directory: ownerDirectory(task.id),
      ok: false,
      outcome: "error",
      error: "waiting",
      retryAt: new Date(at.getTime() + 60_000).toISOString(),
      attempts: 4,
    }, events);
    const soon = new Date(at.getTime() + 1_000);
    assert.equal(retryReady(readCleanupEvents(task.id), "purge_agents", ownerDirectory(task.id), soon), false);
    assert.equal(resumeCleanup(task.id, soon), 1);
    const after = readCleanupEvents(task.id).find((row) => row.action === "purge_agents");
    assert.equal(after?.attempts, 4);
    assert.equal(after?.stopped, undefined);
    assert.equal(retryReady(readCleanupEvents(task.id), "purge_agents", ownerDirectory(task.id), soon), true);
    assert.equal(resumeCleanup(task.id, soon), 0);
  });
});

function ownerDirectory(taskId: number): string {
  return join(dir, `backoff-${taskId}`);
}
