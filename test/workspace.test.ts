/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { completeTask, requestChanges } from "../server/flow";
import { pickWorkspace, type ListedWorkspace } from "../server/placement";
import type { Profile } from "../server/profiles";
import { createTask, getDetail, getTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "place-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });

const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" };
const reviewer: Profile = { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function workspace(patch: Partial<ListedWorkspace> & Pick<ListedWorkspace, "id" | "directory">): ListedWorkspace {
  return {
    name: patch.name ?? patch.id,
    projectRoot: patch.projectRoot ?? patch.directory,
    projectId: patch.projectId ?? "project-1",
    kind: patch.kind ?? "directory",
    archived: patch.archived ?? false,
    pinned: patch.pinned,
    ...patch,
  };
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

describe("pickWorkspace", () => {
  it("prefers the unarchived main workspace whose cwd is the directory", () => {
    const root = room("main-root");
    const picked = pickWorkspace(
      [
        workspace({ id: "archived", directory: root, archived: true }),
        workspace({ id: "worktree", directory: root, kind: "worktree", projectRoot: join(dir, "elsewhere") }),
        workspace({ id: "extra", directory: root, kind: "checkout", projectRoot: join(dir, "other-root") }),
        workspace({ id: "main", directory: root, kind: "local_checkout", projectId: "paseo-kanban" }),
      ],
      root,
    );
    assert.equal(picked?.id, "main");
  });

  it("prefers the workspace named main when several checkouts share the directory", () => {
    const root = room("two-locals");
    const picked = pickWorkspace(
      [
        workspace({ id: "task-ws", directory: root, name: "Implement something", kind: "local_checkout" }),
        workspace({ id: "main", directory: root, name: "main", kind: "local_checkout" }),
      ],
      root,
    );
    assert.equal(picked?.id, "main");
  });

  it("returns null when every match is archived, so the caller may create one", () => {
    const root = room("only-archived");
    assert.equal(pickWorkspace([workspace({ id: "old", directory: root, archived: true })], root), null);
  });
});

describe("workspace reuse", () => {
  it("reuses the existing main workspace for execute, review, and rework", async () => {
    const root = room("reuse");
    const listed: ListedWorkspace[] = [
      workspace({ id: "main-ws", directory: root, name: "demo_board", kind: "local_checkout", projectId: "paseo-kanban" }),
    ];
    const created: Array<{ cwd: string; workspaceId?: string }> = [];
    let directories = 0;
    const launcher: AgentLauncher = {
      async create(options) {
        created.push({ cwd: options.cwd, workspaceId: options.workspaceId });
        return { id: `agent-${created.length}`, workspaceId: options.workspaceId };
      },
      async send() {},
      async listWorkspaces() {
        return listed;
      },
      async createDirectoryWorkspace() {
        directories += 1;
        throw new Error((zhCNPart("schedule.sameWorkspace", 6, 8) + " workspace" + zhCNPart("missingCwd.placeholder.blocks", 5, 7) + "Demo text"));
      },
    };
    const task = createTask({ project: "reuse", title: "demo fixture", role: "executor", workspacePath: root });
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Test" });
    completeTask(task.id, "executor", "Handoff", null);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    requestChanges(task.id, zhCNPart("taskLifecycle.blockIgnored.archived", 7, 9), "Add a sentence", "reviewer");
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Rework" });
    assert.equal(directories, 0);
    assert.equal(created.length, 2);
    assert.equal(created[0]?.workspaceId, "main-ws");
    assert.equal(created[1]?.workspaceId, "main-ws");
    assert.equal(created[0]?.cwd, root);
    assert.equal(getTask(task.id).paseo_workspace_id, "main-ws");
    assert.equal(getTask(task.id).paseo_workspace_name, "demo_board");
    assert.equal(getDetail(task.id).task.paseoWorkspace, "demo_board");
    assert.equal(getTask(task.id).status, "running");
    const bound = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'workspace_bound'").get(task.id) as { n: number };
    assert.equal(bound.n, 1);
  });

  it("creates a directory workspace only when the directory has none, then reuses it", async () => {
    const root = room("fresh");
    const listed: ListedWorkspace[] = [];
    const created: string[] = [];
    let directories = 0;
    const launcher: AgentLauncher = {
      async create(options) {
        created.push(options.workspaceId ?? "");
        return { id: `fresh-${created.length}`, workspaceId: options.workspaceId };
      },
      async send() {},
      async listWorkspaces() {
        return listed.slice();
      },
      async createDirectoryWorkspace(options) {
        directories += 1;
        listed.push(workspace({ id: "created-ws", directory: options.cwd, name: "New sample", projectRoot: options.cwd }));
        return { id: "created-ws", directory: options.cwd, name: "New sample" };
      },
    };
    const task = createTask({ project: "fresh", title: "First attempt", role: "executor", workspacePath: root });
    await startTask(task.id, launcher, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    completeTask(task.id, "executor", "Handoff", null);
    await startTask(task.id, launcher, "test", { profiles: [reviewer], chosen: reviewer, reason: "Reviewer" });
    assert.equal(directories, 1);
    assert.deepEqual(created, ["created-ws", "created-ws"]);
  });

  it("keeps execute, review, and rework in one worktree workspace and passes the parent project id", async () => {
    const root = room("repo");
    const tree = room("repo-tree");
    const calls: Array<{ projectId?: string | null; branchName: string }> = [];
    const created: Array<{ cwd: string; workspaceId?: string }> = [];
    let sent = 0;
    const launcher: AgentLauncher = {
      async create(options) {
        created.push({ cwd: options.cwd, workspaceId: options.workspaceId });
        return { id: `tree-agent-${created.length}`, workspaceId: options.workspaceId ?? "missing" };
      },
      async send() {
        sent += 1;
      },
      async listWorkspaces() {
        // Like Paseo, the worktree workspace it created stays in the active list (TEST_0268 checks it before reuse).
        return [
          workspace({ id: "main-ws", directory: root, name: "demo fixture", projectId: "parent-project", kind: "local_checkout" }),
          ...(calls.length > 0 ? [workspace({ id: "wt-1", directory: tree, name: "kanban-branch", projectRoot: root, projectId: "parent-project", kind: "worktree" })] : []),
        ];
      },
      async createWorktree(options) {
        calls.push({ projectId: options.projectId, branchName: options.branchName });
        return { directory: tree, workspaceId: "wt-1", name: "kanban-branch" };
      },
    };
    const task = createTask({ project: "trees", title: "Documentation", role: "executor", workspacePath: root });
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main' WHERE id = ?").run(task.id);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Test" });
    completeTask(task.id, "executor", "Handoff", null);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    requestChanges(task.id, zhCNPart("taskLifecycle.blockIgnored.archived", 7, 9), "Add a sentence", "reviewer");
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Rework" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.projectId, "parent-project");
    assert.match(calls[0]?.branchName ?? "", new RegExp(`^kanban/${task.id}-`));
    assert.equal(created.length, 2);
    assert.equal(created[0]?.workspaceId, "wt-1");
    assert.equal(created[1]?.workspaceId, "wt-1");
    assert.equal(created[0]?.cwd, tree);
    assert.equal(sent, 1);
    assert.equal(getTask(task.id).paseo_workspace_id, "wt-1");
    assert.equal(getTask(task.id).paseo_workspace_name, "kanban-branch");
    const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'worktree_created'").get(task.id) as { data_json: string };
    const saved = JSON.parse(event.data_json) as { workspaceId: string; projectId: string; directory: string };
    assert.equal(saved.workspaceId, "wt-1");
    assert.equal(saved.projectId, "parent-project");
    assert.equal(saved.directory, tree);
  });
});
