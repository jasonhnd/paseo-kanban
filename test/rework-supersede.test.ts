/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { closeDb, getDb } from "../server/db";
import { leaderReworkTask, rejectTask } from "../server/flow";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import type { ListedWorkspace } from "../server/placement";
import type { Profile } from "../server/profiles";
import { createTask, getTask } from "../server/store";
import { readWorktreeCreated } from "../server/worktree-record";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "rework-supersede-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_WORKTREES_ROOT = join(dir, "paseo-worktrees");
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
setWakeSender(() => Promise.resolve());

const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
const pick = { profiles: [executor], chosen: executor, reason: "Test" };

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function launcher(root: string): AgentLauncher & { created: string[] } {
  let n = 0;
  const workspaces: ListedWorkspace[] = [{ id: "main-ws", name: "main", directory: root, projectRoot: root, projectId: "prj", kind: "local_checkout", archived: false }];
  const created: string[] = [];
  return {
    created,
    async create(options) {
      created.push(options.cwd);
      return { id: `agent-${created.length}`, workspaceId: options.workspaceId };
    },
    async send() {},
    async listWorkspaces() { return workspaces; },
    async createWorktree(options) {
      n += 1;
      const directory = join(dir, "trees", `copy-${n}`);
      git(options.cwd, "worktree", "add", "-q", "-b", options.branchName, directory, options.baseBranch);
      workspaces.push({ id: `ws-${n}`, name: options.title ?? null, directory, projectRoot: root, projectId: "prj", kind: "worktree", archived: false });
      return { directory, workspaceId: `ws-${n}`, name: options.title ?? null };
    },
    async archiveWorkspace(id) {
      const hit = workspaces.find((entry) => entry.id === id);
      if (hit) hit.archived = true;
    },
  };
}

function releases(taskId: number): string[] {
  return (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'release_agent' ORDER BY id").all(taskId) as Array<{ data_json: string }>)
    .map((row) => (JSON.parse(row.data_json) as { agentId: string }).agentId);
}

describe("rework replaces an executor", () => {
  it("queues the superseded executor for archive when its work directory is gone, and spares the successor", async () => {
    const root = join(dir, "repo");
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "base\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    const box = launcher(root);
    const task = createTask({ project: "supersede", title: "Rework", role: "executor", workspacePath: root });
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main' WHERE id = ?").run(task.id);
    await startTask(task.id, box, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    assert.equal(getTask(task.id).executor_agent_id, "agent-1");
    // Leader rework while the old agent is idle, then its directory disappears before the resume.
    const copy = readWorktreeCreated(task.id)!;
    rmSync(copy.directory!, { recursive: true, force: true });
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);

    await startTask(task.id, box, "test", pick);

    const after = getTask(task.id);
    assert.equal(after.executor_agent_id, "agent-2", "a new executor takes the card");
    assert.deepEqual(releases(task.id), ["agent-1"], "only the superseded executor is queued for archive");
    assert.equal(releases(task.id).includes(after.executor_agent_id!), false);
  });

  it("leader rework naming another agent queues the old executor, but keeping the same executor does not", async () => {
    const keep = createTask({ project: "supersede", title: "Reuse", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'rev', executor_agent_id = 'old-exec' WHERE id = ?").run(keep.id);
    await leaderReworkTask(keep.id, (zhCNPart("wake.blocked.needsHuman", 9, 11) + zhCNPart("cardParts.event.tierChanged", 0, 1)), { presence: () => "idle" });
    assert.deepEqual(releases(keep.id), ["rev"]);
    assert.equal(getTask(keep.id).executor_agent_id, "old-exec");

    const swap = createTask({ project: "supersede", title: "Replace agent", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'rev', executor_agent_id = 'old-exec' WHERE id = ?").run(swap.id);
    await leaderReworkTask(swap.id, "Replace agent", { agentId: "new-exec", presence: () => "idle" });
    assert.equal(getTask(swap.id).executor_agent_id, "new-exec");
    assert.equal(releases(swap.id).includes("old-exec"), true);
    assert.equal(releases(swap.id).includes("new-exec"), false);
  });

  for (const presence of ["closed", "missing"] as const) {
    it(`leader rework with presence ${presence} reopens and queues the departed executor`, async () => {
      const task = createTask({ project: "supersede", title: presence, role: "executor", workspacePath: dir });
      getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'rev', executor_agent_id = 'gone-exec' WHERE id = ?").run(task.id);
      await leaderReworkTask(task.id, zhCNPart("cardParts.event.reclaimed", 2, 4), { presence: () => presence });
      assert.equal(getTask(task.id).status, "ready");
      assert.equal(getTask(task.id).executor_agent_id, null);
      assert.equal(releases(task.id).includes("gone-exec"), true);
    });
  }

  it("acceptance reject queues the executor whose work directory is gone", () => {
    mkdirSync(join(process.env.KANBAN_AGENTS_DIR!, "bucket"), { recursive: true });
    writeFileSync(join(process.env.KANBAN_AGENTS_DIR!, "bucket", "cwd-gone.json"), JSON.stringify({
      id: "cwd-gone", cwd: join(dir, "no-such-dir"), title: "x", provider: "claude", labels: {}, archivedAt: null, lastStatus: "idle",
    }));
    const task = createTask({ project: "supersede", title: "Sample text", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'acceptance', agent_id = 'cwd-gone', executor_agent_id = 'cwd-gone' WHERE id = ?").run(task.id);
    rejectTask(task.id, zhCNPart("taskLifecycle.blockIgnored.archived", 7, 9));
    assert.equal(getTask(task.id).executor_agent_id, null);
    assert.deepEqual(releases(task.id), ["cwd-gone"]);
  });
});
