import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { cardMark } from "../server/card-ref";
import { drainCleanups, installCleanup } from "../server/cleanup";
import { setAgentAliveCheck, resetAgentAliveCheck } from "../server/alive";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { setProjectSupervisor, setProjectWorkspace } from "../server/config";
import { notifyReadOnlyLeftovers } from "../server/wake";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { runDoctor } from "../server/doctor";
import { acceptTask, approveTask, completeTask, requestChanges } from "../server/flow";
import { setMissingCwdHooks, resetMissingCwdForTests } from "../server/missing-cwd";
import { launcherFrom } from "../server/paseo";
import type { ListedWorkspace } from "../server/placement";
import type { Profile } from "../server/profiles";
import type { ReworkReassignment } from "../server/rework-reassign";
import { appendEvent, createTask, getTask } from "../server/store";
import { listTempWorkspaces } from "../server/temp-workspace";
import { readOnlyBranchName } from "../server/readonly-worktree";
import { worktreeOwnershipError } from "../server/worktree-gc";

const dir = mkdtempSync(join(tmpdir(), "leader-workspace-"));
const trees = join(dir, "worktrees");
const agents = join(dir, "agents");
process.env.KANBAN_DATA_DIR = join(dir, "data");
process.env.KANBAN_WORKTREES_ROOT = trees;
process.env.KANBAN_AGENTS_DIR = agents;
mkdirSync(trees);
mkdirSync(agents);
mkdirSync(join(agents, "bucket"));
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const profile = (role: string): Profile => ({ id: role, name: role, role, family: role === "reviewer" ? "xai" : "anthropic", provider: role === "reviewer" ? "grok" : "claude", model: role === "reviewer" ? "demo-review" : "demo-work" });
const pick = (role: string) => ({ chosen: profile(role), profiles: [profile(role)], reason: "test" });

function fixture() {
  const root = mkdtempSync(join(dir, "repo-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  writeFileSync(join(root, "README"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  const main: ListedWorkspace = { id: root, name: "<leader> Fixed title", directory: root, projectRoot: root, projectId: root, kind: "local_checkout", archived: false };
  const workspaces = [main];
  const opened: Array<Parameters<AgentLauncher["create"]>[0]> = [];
  const created: Array<Parameters<NonNullable<AgentLauncher["createWorktree"]>>[0]> = [];
  const order: string[] = [];
  const box: AgentLauncher = {
    async listWorkspaces() { return workspaces; },
    async listAgents() { return []; },
    async archiveWorkspace(id) { workspaces.find((w) => w.id === id)!.archived = true; },
    async send() {},
    async create(options) {
      assert.notEqual(options.workspaceId, main.id, (zhCNPart("doctor.agent.main.symptom", 21, 29) + " Cannot enter <leader> workspace"));
      opened.push(options);
      const id = `agent-${getDb().prepare("SELECT COUNT(*) AS n FROM runs").get()?.n}-${opened.length}`;
      writeFileSync(join(agents, "bucket", `${id}.json`), JSON.stringify({ id, cwd: options.cwd, labels: options.labels, archivedAt: null }));
      return { id, workspaceId: options.workspaceId };
    },
    async createWorktree(options) {
      created.push(options);
      const path = join(trees, `${root.split("/").at(-1)}-${options.title}-${created.length}`);
      git(options.cwd, ["worktree", "add", "-b", options.branchName, path, options.baseBranch]);
      workspaces.push({ ...main, id: path, directory: path, name: options.title ?? null, kind: "worktree" });
      return { directory: path, workspaceId: path, name: options.title, head: git(path, ["rev-parse", "HEAD"]) };
    },
  };
  return { root, main, workspaces, opened, created, order, box };
}

function cleanupFixture(f: ReturnType<typeof fixture>, state: { activity?: "idle" | "busy" | "unknown"; failPurge?: boolean } = {}) {
  setMissingCwdHooks({ deleteAgent: async (id) => {
    if (state.failPurge) throw new Error("purge failed");
    f.order.push("purge"); rmSync(join(agents, "bucket", `${id}.json`), { force: true });
  } });
  installCleanup({
    async archiveAgent() { f.order.push("agent archive"); },
    async inspectAgent() {
      if (state.activity === "unknown") throw new Error("query failed");
      return { archived: false, busy: state.activity === "busy" };
    },
    async archiveWorkspace(id) { assert.ok(f.order.includes("purge")); f.order.push("workspace archive"); f.workspaces.find((w) => w.id === id)!.archived = true; },
    async inspectWorkspace(id) { return f.workspaces.find((w) => w.id === id) ?? null; },
    async listAgents() { return []; },
  });
}

beforeEach(() => {
  getDb().exec("DELETE FROM start_claims; DELETE FROM tokens; DELETE FROM links; DELETE FROM runs; DELETE FROM events; DELETE FROM comments; DELETE FROM tasks;");
  setProjectWorkspace("leader", { alwaysTemp: true, baseBranch: "main" });
  installCleanup(null);
  resetMissingCwdForTests();
});
after(() => { installCleanup(null); resetMissingCwdForTests(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe("<leader> workspace isolation", () => {
  for (const role of ["reader", "decision", "reviewer"]) {
    it(`opens ${role} on a card-named read-only copy and cleans it after acceptance`, async () => {
      const f = fixture();
      const task = createTask({ project: "leader", title: role, role, workspacePath: f.root });
      await startTask(task.id, f.box, "test", pick(role));
      const placed = getTask(task.id);
      assert.equal(placed.workspace_kind, "worktree");
      assert.equal(placed.paseo_workspace_name, cardMark(task.id));
      assert.match(f.created[0]!.branchName, /^kanban-readonly\//);
      assert.match(f.opened[0]!.prompt ?? "", new RegExp(localePattern(zhCNPart("readonlyWorktree.branch.unreadable", 3, 5))));
      const record = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'worktree_created'").get(task.id) as { data_json: string }).data_json);
      assert.equal(record.readOnly, true);
      assert.equal(git(f.root, ["branch", "--list", "kanban/*"]), "");
      setMissingCwdHooks({ deleteAgent: async (id) => {
        f.order.push("purge"); rmSync(join(agents, "bucket", `${id}.json`));
      } });
      installCleanup({
        async archiveAgent() { f.order.push("agent archive"); },
        async inspectAgent() { return { archived: false, busy: false }; },
        async archiveWorkspace(id) { assert.ok(f.order.includes("purge")); f.order.push("workspace archive"); f.workspaces.find((w) => w.id === id)!.archived = true; },
        async inspectWorkspace(id) { return f.workspaces.find((w) => w.id === id) ?? null; },
        async listAgents() { return []; },
      });
      if (role === "reviewer") await approveTask(task.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
      else await completeTask(task.id, role, zhCN("labels.status.done"), { files: [], verification: "test", risks: [] });
      assert.equal(getTask(task.id).status, "acceptance");
      const accepted = await acceptTask(task.id);
      assert.equal(accepted.status, "done");
      assert.equal(accepted.merged, undefined);
      await drainCleanups(new Date(Date.now() + 1_000));
      assert.equal(existsSync(placed.workspace_path!), false);
      assert.equal(listTempWorkspaces().length, 0);
      const inspection = getDb().prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = 'readonly_cleanup'").get(task.id) as { id: number; data_json: string };
      assert.equal(JSON.parse(inspection.data_json).reason, "readonly_clean_base");
      const archivedRow = (getDb().prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = 'cleanup' ORDER BY id").all(task.id) as Array<{ id: number; data_json: string }>)
        .find((row) => JSON.parse(row.data_json).action === "archive_workspace" && JSON.parse(row.data_json).ok === true);
      assert.ok(archivedRow && inspection.id < archivedRow.id, "the copy is inspected before its workspace is archived");
      const cleaned = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'temp_workspace_cleaned'").get(task.id) as { data_json: string };
      assert.equal(JSON.parse(cleaned.data_json).reason, "readonly_clean_base");
      assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id), undefined);
      assert.equal(git(f.root, ["branch", "--list", "kanban-readonly/*"]), "");
      assert.deepEqual(f.order.filter((step) => step !== "agent archive"), ["purge", "workspace archive"]);
      assert.equal(f.main.name, "<leader> Fixed title");
    });
  }

  it("follows the reviewed temporary workspace without taking its ownership", async () => {
    const f = fixture();
    const original = createTask({ project: "leader", title: "Executor", role: "executor", workspacePath: f.root });
    await startTask(original.id, f.box, "test", pick("executor"));
    const review = createTask({ project: "leader", title: "Reviewer", role: "reviewer", workspacePath: f.root, reviewOf: original.id });
    await startTask(review.id, f.box, "test", pick("reviewer"));
    assert.equal(f.created.length, 1);
    assert.equal(f.opened[1]!.workspaceId, getTask(original.id).paseo_workspace_id);
    assert.equal(f.opened[1]!.cwd, getTask(original.id).workspace_path);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'temp_workspace'").get(review.id), undefined);
    await approveTask(review.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await acceptTask(review.id);
    assert.equal(existsSync(getTask(original.id).workspace_path!), true);
  });

  it("reviews a legacy directory card at the delivered commit on an isolated read-only copy", async () => {
    const f = fixture();
    git(f.root, ["checkout", "-b", "feature/submission"]);
    writeFileSync(join(f.root, "change"), "review this\n");
    git(f.root, ["add", "."]); git(f.root, ["commit", "-m", "submission"]);
    const head = git(f.root, ["rev-parse", "HEAD"]);
    git(f.root, ["checkout", "main"]);
    const original = createTask({ project: "leader", title: "Old directory card", role: "executor", workspacePath: f.root });
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, provider, model, family, started_at) VALUES (?, 'legacy-executor', 'executor', 'claude', 'demo-work', 'anthropic', ?)").run(original.id, new Date().toISOString());
    appendEvent(original.id, "branch_observed", null, null, "test", { branch: "feature/submission", head, pushed: false });
    const review = createTask({ project: "leader", title: "Review old card", role: "reviewer", workspacePath: f.root, reviewOf: original.id });
    await startTask(review.id, f.box, "test", pick("reviewer"));
    assert.equal(git(f.opened[0]!.cwd, ["rev-parse", "HEAD"]), head);
    assert.equal(f.created[0]!.baseBranch, head);
    assert.equal(getTask(original.id).workspace_path, f.root);
  });

  it("uses local base when a read-only copy cannot fetch origin", async () => {
    const f = fixture();
    git(f.root, ["remote", "add", "origin", join(dir, "missing-remote")]);
    const task = createTask({ project: "leader", title: "offline", role: "reader", workspacePath: f.root });
    await startTask(task.id, f.box, "test", pick("reader"));
    assert.equal(f.created[0]!.baseBranch, "main");
  });

  it("fetches origin/base for an inspection even when local base is behind", async () => {
    const f = fixture();
    git(f.root, ["checkout", "-b", "next"]);
    writeFileSync(join(f.root, "next"), "remote\n");
    git(f.root, ["add", "."]); git(f.root, ["commit", "-m", "remote base"]);
    const head = git(f.root, ["rev-parse", "HEAD"]);
    const origin = join(dir, `origin-${head}`);
    git(dir, ["clone", "--bare", f.root, origin]);
    git(origin, ["update-ref", "refs/heads/main", head]);
    git(f.root, ["checkout", "main"]);
    git(f.root, ["remote", "add", "origin", origin]);
    const task = createTask({ project: "leader", title: "origin", role: "decision", workspacePath: f.root });
    await startTask(task.id, f.box, "test", pick("decision"));
    assert.equal(f.created[0]!.baseBranch, "origin/main");
    assert.equal(git(f.opened[0]!.cwd, ["rev-parse", "HEAD"]), head);
    assert.notEqual(git(f.root, ["rev-parse", "HEAD"]), head);
  });

  for (const activity of ["busy", "unknown", "purge failure"] as const) {
    it(`keeps a read-only copy for ${activity} and cleans it once safe within five minutes`, async () => {
      const f = fixture();
      const task = createTask({ project: "leader", title: activity, role: "reader", workspacePath: f.root });
      await startTask(task.id, f.box, "test", pick("reader"));
      await completeTask(task.id, "reader", zhCN("labels.status.done"), null);
      await acceptTask(task.id);
      const state = { activity: activity === "purge failure" ? "idle" as const : activity, failPurge: activity === "purge failure" };
      cleanupFixture(f, state);
      await drainCleanups(new Date(Date.now() + 1_000));
      assert.equal(existsSync(f.opened[0]!.cwd), true);
      assert.equal(f.order.includes("workspace archive"), false);
      state.activity = "idle";
      state.failPurge = false;
      await drainCleanups(new Date(Date.now() + 240_000));
      assert.equal(existsSync(f.opened[0]!.cwd), false);
      assert.deepEqual(f.order, ["purge", "workspace archive"]);
      assert.equal(listTempWorkspaces().length, 0);
    });
  }

  async function settledReader(title: string) {
    const f = fixture();
    const task = createTask({ project: "leader", title, role: "reader", workspacePath: f.root });
    await startTask(task.id, f.box, "test", pick("reader"));
    return { f, task, path: f.opened[0]!.cwd };
  }

  async function finish(f: ReturnType<typeof fixture>, taskId: number) {
    await completeTask(taskId, "reader", zhCN("labels.status.done"), null);
    await acceptTask(taskId);
    cleanupFixture(f);
    await drainCleanups(new Date(Date.now() + 1_000));
  }

  function cleanupReason(taskId: number): string {
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'readonly_cleanup'").get(taskId) as { data_json: string };
    return JSON.parse(row.data_json).reason as string;
  }

  for (const move of ["detached", "other local branch"] as const) {
    it(`removes a clean read-only copy after ${move} at the creation commit`, async () => {
      const { f, task, path } = await settledReader(move);
      const head = git(path, ["rev-parse", "HEAD"]);
      if (move === "detached") git(path, ["checkout", "--detach"]);
      else git(path, ["checkout", "-b", "unexpected"]);
      assert.equal(git(path, ["rev-parse", "HEAD"]), head);
      assert.equal(git(path, ["status", "--porcelain"]), "");
      await finish(f, task.id);
      assert.equal(existsSync(path), false);
      assert.equal(cleanupReason(task.id), "readonly_clean_base");
      assert.equal(git(f.root, ["branch", "--list", "kanban-readonly/*"]), "");
      assert.equal(listTempWorkspaces().length, 0);
      assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id), undefined);
    });
  }

  it("cleans a backed-off read-only copy after an old skip_worktree for a changed commit", async () => {
    const { f, task, path } = await settledReader("old-skip");
    const head = git(path, ["rev-parse", "HEAD"]);
    git(path, ["checkout", "--detach"]);
    assert.equal(git(path, ["rev-parse", "HEAD"]), head);
    assert.equal(git(path, ["status", "--porcelain"]), "");
    await completeTask(task.id, "reader", zhCN("labels.status.done"), null);
    await acceptTask(task.id);
    cleanupFixture(f);
    const now = Date.now();
    const created = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'worktree_created'").get(task.id) as { data_json: string }).data_json) as { directory: string };
    appendEvent(task.id, "cleanup", null, null, "kanban", {
      action: "skip_worktree",
      directory: created.directory,
      branch: readOnlyBranchName(task.id),
      ok: false,
      error: zhCN("readonlyWorktree.copy.movedKept"),
      retryAt: new Date(now + 60_000).toISOString(),
    }, new Date(now).toISOString());
    await drainCleanups(new Date(now + 1_000));
    assert.equal(existsSync(path), true);
    assert.match(git(f.root, ["branch", "--list", "kanban-readonly/*"]), /kanban-readonly\//);
    assert.equal(f.workspaces.find((workspace) => workspace.directory === path)?.archived, false);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'temp_workspace_cleaned'").get(task.id), undefined);
    await drainCleanups(new Date(now + 60_000));
    assert.equal(existsSync(path), false);
    assert.equal(git(f.root, ["branch", "--list", "kanban-readonly/*"]), "");
    assert.equal(f.workspaces.find((workspace) => workspace.directory === path)?.archived, true);
    assert.equal(listTempWorkspaces().length, 0);
    assert.equal(cleanupReason(task.id), "readonly_clean_base");
    const skips = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cleanup'").all(task.id) as Array<{ data_json: string }>;
    assert.equal(skips.some((row) => JSON.parse(row.data_json).error === zhCN("readonlyWorktree.copy.movedKept")), true);
  });

  it("removes a clean read-only copy checked out at another origin branch", async () => {
    const { f, task, path } = await settledReader("origin-preview");
    const base = git(path, ["rev-parse", "HEAD"]);
    git(f.root, ["checkout", "-b", "preview"]);
    writeFileSync(join(f.root, "preview-file"), "preview\n");
    git(f.root, ["add", "."]);
    git(f.root, ["commit", "-m", "preview tip"]);
    const preview = git(f.root, ["rev-parse", "HEAD"]);
    git(f.root, ["checkout", "main"]);
    const origin = join(dir, `origin-${task.id}`);
    git(dir, ["clone", "--bare", f.root, origin]);
    git(f.root, ["remote", "add", "origin", origin]);
    git(f.root, ["fetch", "origin"]);
    git(path, ["checkout", "--detach", "origin/preview"]);
    assert.equal(git(path, ["rev-parse", "HEAD"]), preview);
    assert.notEqual(preview, base);
    assert.equal(git(path, ["status", "--porcelain"]), "");
    await finish(f, task.id);
    assert.equal(existsSync(path), false);
    assert.equal(cleanupReason(task.id), "readonly_clean_on_origin");
    assert.equal(git(f.root, ["branch", "--list", "kanban-readonly/*"]), "");
    assert.equal(listTempWorkspaces().length, 0);
    assert.equal(getDb().prepare(("SELECT id FROM comments WHERE task_id = ? AND body LIKE '%" + zhCNPart("worktreeRecord.skip.readOnlyNotRemoved", 3, 7) + "%'")).get(task.id), undefined);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id), undefined);
  });

  function ignoredDropped(taskId: number): { files: string[]; count: number; directory: string } {
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'readonly_ignored_dropped'").get(taskId) as { data_json: string };
    return JSON.parse(row.data_json);
  }

  it("removes a clean read-only copy holding only ignored generated files and lists them in an event", async () => {
    const { f, task, path } = await settledReader("ignored-generated");
    writeFileSync(join(f.root, ".git", "info", "exclude"), ".astro/\npublic/data.*.json\n.env\n");
    mkdirSync(join(path, ".astro"), { recursive: true });
    writeFileSync(join(path, ".astro", "types.d.ts"), "x");
    mkdirSync(join(path, "public"), { recursive: true });
    writeFileSync(join(path, "public", "data.x.json"), "{}");
    writeFileSync(join(path, ".env"), "SECRET=1\n");
    await finish(f, task.id);
    assert.equal(existsSync(path), false);
    assert.equal(git(f.root, ["branch", "--list", "kanban-readonly/*"]), "");
    assert.equal(listTempWorkspaces().length, 0);
    assert.equal(cleanupReason(task.id), "readonly_clean_base");
    const dropped = ignoredDropped(task.id);
    for (const name of [".astro/", ".env", "public/data.x.json"]) assert.ok(dropped.files.includes(name), name);
    assert.equal(dropped.count, dropped.files.length);
    assert.equal(dropped.directory, path);
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id), undefined);
  });

  it("still exports uncommitted edits before removing a read-only copy that also holds ignored files", async () => {
    const sent = watchLeader();
    try {
      const { f, task, path } = await settledReader("ignored-and-dirty");
      writeFileSync(join(f.root, ".git", "info", "exclude"), ".astro/\n");
      mkdirSync(join(path, ".astro"), { recursive: true });
      writeFileSync(join(path, ".astro", "types.d.ts"), "x");
      writeFileSync(join(path, "README"), "edited\n");
      writeFileSync(join(path, "scratch.txt"), "new file\n");
      await finish(f, task.id);
      assert.equal(existsSync(path), false);
      const saved = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id) as { data_json: string }).data_json) as {
        files: string[];
        path: string;
        commits: number;
      };
      assert.equal(saved.commits, 0);
      assert.deepEqual([...saved.files].sort(), ["README", "scratch.txt"]);
      assert.equal(existsSync(join(saved.path, "untracked", "scratch.txt")), true);
      assert.equal(existsSync(join(saved.path, "untracked", ".astro")), false);
      assert.deepEqual(ignoredDropped(task.id).files, [".astro/"]);
      assert.equal(sent.filter((text) => text.includes(zhCNPart("worktreeRecord.skip.readOnlyNotRemoved", 3, 7))).length, 1);
      const cleaned = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'temp_workspace_cleaned'").get(task.id) as { data_json: string }).data_json) as { reason?: string };
      assert.equal(cleaned.reason, "readonly_leftovers");
    } finally {
      resetWakeSender();
      resetAgentAliveCheck();
    }
  });

  it("keeps a read-only copy whose untracked files are over the export size cap", async () => {
    const { f, task, path } = await settledReader("too-big");
    writeFileSync(join(path, "big.bin"), "x".repeat(4096));
    process.env.KANBAN_READONLY_EXPORT_MAX_BYTES = "1024";
    try {
      await finish(f, task.id);
      assert.equal(existsSync(path), true);
      assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id), undefined);
      assert.equal(readdirSync(join(dir, "data", "readonly-leftovers")).some((name) => name.startsWith(".partial-")), false);
    } finally {
      delete process.env.KANBAN_READONLY_EXPORT_MAX_BYTES;
    }
  });

  it("counts committed patches toward the export size cap", async () => {
    const { f, task, path } = await settledReader("big-commit");
    writeFileSync(join(path, "big-committed.txt"), "y".repeat(8192));
    git(path, ["add", "."]);
    git(path, ["commit", "-m", "big local"]);
    process.env.KANBAN_READONLY_EXPORT_MAX_BYTES = "1024";
    try {
      await finish(f, task.id);
      assert.equal(existsSync(path), true);
      assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id), undefined);
    } finally {
      delete process.env.KANBAN_READONLY_EXPORT_MAX_BYTES;
    }
  });

  function watchLeader() {
    setProjectSupervisor("leader", "leader-agent");
    setAgentAliveCheck(() => true);
    const sent: string[] = [];
    setWakeSender((id, text) => {
      assert.equal(id, "leader-agent");
      sent.push(text);
    });
    return sent;
  }

  it("saves a patch, comments, wakes the project leader, and still removes a read-only copy that has commits", async () => {
    const sent = watchLeader();
    try {
      const { f, task, path } = await settledReader("committed");
      writeFileSync(join(path, "local-change"), "only here\n");
      git(path, ["add", "."]);
      git(path, ["commit", "-m", "local only"]);
      await finish(f, task.id);
      assert.equal(existsSync(path), false);
      assert.equal(git(f.root, ["branch", "--list", "kanban-readonly/*"]), "");
      const saved = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id) as { data_json: string }).data_json) as {
        files: string[];
        path: string;
        commits: number;
      };
      assert.equal(saved.commits >= 1, true);
      assert.ok(saved.files.includes("local-change"));
      assert.equal(existsSync(saved.path), true);
      const patch = readdirSync(saved.path).find((name) => name.endsWith(".patch"));
      assert.ok(patch);
      assert.match(readFileSync(join(saved.path, patch!), "utf8"), /local-change/);
      const comment = getDb().prepare(("SELECT body FROM comments WHERE task_id = ? AND body LIKE '%" + zhCNPart("worktreeRecord.skip.readOnlyNotRemoved", 3, 7) + "%'")).get(task.id) as { body: string };
      assert.match(comment.body, new RegExp(zhCN("labels.role.reader") + localePattern(zhCNPart("readonlyWorktree.leftovers.sentence", 6, 16)) + "1 " + localePattern(zhCNPart("tokens.emptyFile", 38, 41))));
      assert.match(comment.body, new RegExp(localePattern(zhCNPart("readonlyWorktree.leftovers.sentence", 41, 58))));
      assert.match(comment.body, new RegExp(saved.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const leftoverWakes = () => sent.filter((text) => text.includes(zhCNPart("worktreeRecord.skip.readOnlyNotRemoved", 3, 7)));
      assert.equal(leftoverWakes().length, 1);
      assert.match(leftoverWakes()[0]!, new RegExp(zhCN("labels.role.reader") + localePattern(zhCNPart("readonlyWorktree.leftovers.sentence", 6, 16)) + "1 " + localePattern(zhCNPart("tokens.emptyFile", 38, 41))));
      notifyReadOnlyLeftovers(task.id, "again");
      assert.equal(leftoverWakes().length, 1);
      assert.equal(listTempWorkspaces().length, 0);
      const cleaned = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'temp_workspace_cleaned'").get(task.id) as { data_json: string }).data_json) as { reason?: string };
      assert.equal(cleaned.reason, "readonly_leftovers");
    } finally {
      resetWakeSender();
      resetAgentAliveCheck();
    }
  });

  it("saves uncommitted edits and untracked files from a read-only copy, then removes it", async () => {
    const sent = watchLeader();
    try {
      const { f, task, path } = await settledReader("dirty");
      writeFileSync(join(path, "README"), "edited\n");
      writeFileSync(join(path, "scratch.txt"), "new file\n");
      await finish(f, task.id);
      assert.equal(existsSync(path), false);
      const saved = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id) as { data_json: string }).data_json) as {
        files: string[];
        path: string;
        commits: number;
      };
      assert.equal(saved.commits, 0);
      assert.deepEqual(saved.files, ["README", "scratch.txt"]);
      assert.match(readFileSync(join(saved.path, "worktree.diff"), "utf8"), /edited/);
      assert.equal(readFileSync(join(saved.path, "untracked", "scratch.txt"), "utf8"), "new file\n");
      const leftoverWakes = sent.filter((text) => text.includes(zhCNPart("worktreeRecord.skip.readOnlyNotRemoved", 3, 7)));
      assert.equal(leftoverWakes.length, 1);
      assert.match(leftoverWakes[0]!, new RegExp(localePattern(zhCNPart("readonlyWorktree.leftovers.sentence", 13, 16)) + "2 " + localePattern(zhCNPart("tokens.emptyFile", 38, 41))));
      assert.equal(git(f.root, ["branch", "--list", "kanban-readonly/*"]), "");
      assert.equal(listTempWorkspaces().length, 0);
    } finally {
      resetWakeSender();
      resetAgentAliveCheck();
    }
  });

  it("exports read-only leftovers and records them before archiving the Paseo workspace, which deletes the directory", async () => {
    const sent = watchLeader();
    try {
      const { f, task, path } = await settledReader("export-first");
      writeFileSync(join(path, "README"), "edited before archive\n");
      writeFileSync(join(path, "scratch.txt"), "untracked\n");
      await completeTask(task.id, "reader", zhCN("labels.status.done"), null);
      await acceptTask(task.id);
      setMissingCwdHooks({ deleteAgent: async (id) => {
        f.order.push("purge"); rmSync(join(agents, "bucket", `${id}.json`), { force: true });
      } });
      installCleanup({
        async archiveAgent() { f.order.push("agent archive"); },
        async inspectAgent() { return { archived: false, busy: false }; },
        async archiveWorkspace(id) {
          const exported = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id);
          f.order.push(exported ? "workspace archive after export" : "workspace archive before export");
          // Paseo's workspace archive deletes the worktree directory.
          rmSync(path, { recursive: true, force: true });
          f.workspaces.find((w) => w.id === id)!.archived = true;
        },
        async inspectWorkspace(id) { return f.workspaces.find((w) => w.id === id) ?? null; },
        async listAgents() { return []; },
      });
      await drainCleanups(new Date(Date.now() + 1_000));
      assert.deepEqual(f.order.filter((step) => step !== "agent archive"), ["purge", "workspace archive after export"]);
      assert.equal(existsSync(path), false);
      const saved = JSON.parse((getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id) as { data_json: string }).data_json) as {
        files: string[];
        path: string;
      };
      assert.deepEqual(saved.files, ["README", "scratch.txt"]);
      assert.match(readFileSync(join(saved.path, "worktree.diff"), "utf8"), /edited before archive/);
      assert.equal(readFileSync(join(saved.path, "untracked", "scratch.txt"), "utf8"), "untracked\n");
      const ids = getDb().prepare("SELECT id, kind, data_json FROM events WHERE task_id = ? ORDER BY id").all(task.id) as Array<{ id: number; kind: string; data_json: string }>;
      const exportedAt = ids.find((row) => row.kind === "readonly_leftovers")!.id;
      const archivedAt = ids.find((row) => row.kind === "cleanup" && JSON.parse(row.data_json).action === "archive_workspace" && JSON.parse(row.data_json).ok === true)!.id;
      assert.ok(exportedAt < archivedAt, "readonly_leftovers is recorded before archive_workspace");
      assert.equal(sent.filter((text) => text.includes(zhCNPart("worktreeRecord.skip.readOnlyNotRemoved", 3, 7))).length, 1);
      assert.equal(listTempWorkspaces().length, 0);
    } finally {
      resetWakeSender();
      resetAgentAliveCheck();
    }
  });

  it("keeps a read-only copy and backs off when the patch cannot be saved", async () => {
    const sent = watchLeader();
    try {
      const { f, task, path } = await settledReader("export-fails");
      writeFileSync(join(path, "README"), "x".repeat(1_100_000));
      await completeTask(task.id, "reader", zhCN("labels.status.done"), null);
      await acceptTask(task.id);
      cleanupFixture(f);
      await drainCleanups(new Date(Date.now() + 1_000));
      assert.equal(existsSync(path), true);
      assert.equal(git(path, ["rev-parse", "--abbrev-ref", "HEAD"]), readOnlyBranchName(task.id));
      assert.match(git(f.root, ["branch", "--list", readOnlyBranchName(task.id)]), new RegExp(readOnlyBranchName(task.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const failed = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'cleanup' ORDER BY id DESC LIMIT 1").get(task.id) as { data_json: string };
      const data = JSON.parse(failed.data_json) as { ok?: boolean; error?: string; retryAt?: string };
      assert.equal(data.ok, false);
      assert.match(data.error ?? "", new RegExp(localePattern(zhCNPart("readonlyWorktree.patch.failed", 4, 9))));
      assert.ok(data.retryAt);
      assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'readonly_leftovers'").get(task.id), undefined);
      assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'temp_workspace_cleaned'").get(task.id), undefined);
      assert.equal(sent.filter((text) => text.includes(zhCNPart("worktreeRecord.skip.readOnlyNotRemoved", 3, 7))).length, 0);
      assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'wake_readonly_leftovers'").get(task.id), undefined);
      assert.equal(listTempWorkspaces(new Date(Date.now() + 360_000)).some((row) => row.id === task.id), true);
      await drainCleanups(new Date(Date.now() + 2_000));
      assert.equal(existsSync(path), true);
    } finally {
      resetWakeSender();
      resetAgentAliveCheck();
    }
  });

  it("discards a newly created read-only copy after losing the start claim", async () => {
    const f = fixture();
    const task = createTask({ project: "leader", title: "lost claim", role: "reader", workspacePath: f.root });
    const create = f.box.createWorktree!;
    f.box.createWorktree = async (options) => {
      const made = await create(options);
      getDb().prepare("DELETE FROM start_claims WHERE task_id = ?").run(task.id);
      return made;
    };
    await startTask(task.id, f.box, "test", pick("reader"));
    assert.equal(f.opened.length, 0);
    assert.equal(existsSync(f.workspaces[1]!.directory!), false);
    assert.equal(f.workspaces[1]!.archived, true);
    assert.equal(git(f.root, ["branch", "--list", "kanban-readonly/*"]), "");
  });

  it("refuses a launcher returning the main directory as its temporary workspace", async () => {
    const f = fixture();
    const task = createTask({ project: "leader", title: "bad placement", role: "reader", workspacePath: f.root });
    f.box.createWorktree = async () => ({ directory: f.root, workspaceId: f.main.id });
    await assert.rejects(() => startTask(task.id, f.box, "test", pick("reader")), new RegExp(localePattern(zhCNPart("workspaceRecreate.isMain", 14, 22))));
    assert.equal(f.opened.length, 0);
    assert.equal(git(f.root, ["branch", "--show-current"]), "main");
  });

  it("moves an inline legacy review and its later rework onto the submitted execution copy", async () => {
    const f = fixture();
    const original = createTask({ project: "leader", title: "legacy", role: "executor", workspacePath: f.root });
    getDb().prepare("UPDATE tasks SET status = 'running', executor_agent_id = 'legacy-executor', agent_id = 'legacy-executor' WHERE id = ?").run(original.id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, provider, model, family, started_at) VALUES (?, 'legacy-executor', 'executor', 'claude', 'demo-work', 'anthropic', ?)").run(original.id, new Date().toISOString());
    await completeTask(original.id, "executor", "Handoff", null);
    const head = git(f.root, ["rev-parse", "HEAD"]);
    await startTask(original.id, f.box, "test", pick("reviewer"));
    const path = f.opened[0]!.cwd;
    assert.equal(git(path, ["rev-parse", "HEAD"]), head);
    assert.match(f.created[0]!.branchName, /^kanban\//);
    assert.equal(getTask(original.id).executor_agent_id, null);
    requestChanges(original.id, zhCNPart("taskLifecycle.blockIgnored.archived", 7, 9), "Add tests");
    await startTask(original.id, f.box, "test", pick("executor"));
    assert.equal(f.opened[1]!.cwd, path);
    assert.equal(f.created.length, 1);
  });

  it("requires card ownership and a separate worktree root for read-only cleanup", () => {
    const f = fixture();
    const task = createTask({ project: "leader", title: "ownership", role: "reader", workspacePath: f.root });
    const owned = { directory: join(trees, "owned"), root: f.root, branch: readOnlyBranchName(task.id), head: git(f.root, ["rev-parse", "HEAD"]), readOnly: true };
    assert.equal(worktreeOwnershipError(task.id, owned), null);
    assert.match(worktreeOwnershipError(task.id, { ...owned, branch: "main" })!, new RegExp(localePattern(zhCNPart("missingCwd.purge.notThisCard", 0, 3))));
    assert.match(worktreeOwnershipError(task.id, { ...owned, directory: f.root })!, new RegExp(localePattern(zhCNPart("worktreeGc.owner.outsideRoot", 11, 15)) + "|" + localePattern(zhCNPart("worktreeGc.owner.isMain", 16, 19))));
    assert.match(worktreeOwnershipError(task.id, { ...owned, head: undefined })!, new RegExp(localePattern(zhCNPart("missingCwd.purge.notThisCard", 0, 3))));
  });

  for (const exception of ["alwaysTemp_off", "force"] as const) {
    it(`records the ${exception} exception for a read-only agent on the main workspace`, async () => {
      const f = fixture();
      if (exception === "alwaysTemp_off") setProjectWorkspace("leader", { alwaysTemp: false });
      const task = createTask({ project: "leader", title: exception, role: "reader", workspacePath: f.root });
      f.box.create = async (options) => { f.opened.push(options); return { id: "exception-agent", workspaceId: options.workspaceId }; };
      await startTask(task.id, f.box, "test", { ...pick("reader"), force: exception === "force" });
      assert.equal(f.opened[0]!.workspaceId, f.main.id);
      assert.equal(f.created.length, 0);
      const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'main_workspace_exception'").get(task.id) as { data_json: string };
      assert.equal(JSON.parse(event.data_json).reason, exception);
      assert.equal(f.main.name, "<leader> Fixed title");
    });
  }

  function returningLauncher(f: ReturnType<typeof fixture>, archived: string[]) {
    f.box.archiveAgent = async (id) => { archived.push(id); };
    f.box.create = async (options) => {
      f.opened.push(options);
      return { id: `agent-${f.opened.length}`, workspaceId: options.workspaceId ?? f.main.id };
    };
    return f.box;
  }

  function adjudicatedDirectory(f: ReturnType<typeof fixture>, title: string) {
    const task = createTask({ project: "leader", title, role: "executor", workspacePath: f.root, brief: "Original goal" });
    writeFileSync(join(f.root, "progress"), `${title}\n`);
    git(f.root, ["add", "."]); git(f.root, ["commit", "-m", title]);
    const head = git(f.root, ["rev-parse", "HEAD"]);
    appendEvent(task.id, "leader_rework", "blocked", "ready", "leader", {
      reason: "Current correction", fromStatus: "blocked", countRound: false, agentId: "old", presence: "missing",
    });
    getDb().prepare("UPDATE tasks SET status = 'ready', agent_id = NULL, executor_agent_id = NULL, brief = ? WHERE id = ?")
      .run((zhCNPart("boardView.done.conflictChoice", 11, 13) + zhCNPart("missingCwd.report.title", 0, 1) + "\n\n## " + zhCNPart("flow.brief.thisRound", 3, 11) + "\nCurrent correction\n"), task.id);
    return { task, head };
  }

  it("moves a leader-rework replacement off the main workspace onto the current commit", async () => {
    const f = fixture();
    const archived: string[] = [];
    const { task, head } = adjudicatedDirectory(f, "leader-rework");
    await startTask(task.id, returningLauncher(f, archived), "scheduler", pick("executor"));
    const opened = f.opened.at(-1)!;
    assert.equal(getTask(task.id).status, "running");
    assert.equal(archived.length, 0);
    assert.notEqual(opened.workspaceId, f.main.id);
    assert.notEqual(opened.cwd, f.root);
    assert.equal(git(opened.cwd, ["rev-parse", "HEAD"]), head);
    assert.equal(f.created[0]!.baseBranch, head);
    assert.match(opened.prompt ?? "", new RegExp("Current correction"));
    assert.equal(f.main.name, "<leader> Fixed title");
  });

  it("moves a main-directory takeover onto the current commit and does not archive the new agent", async () => {
    const f = fixture();
    const archived: string[] = [];
    const task = createTask({ project: "leader", title: "takeover-main", role: "executor", workspacePath: f.root });
    writeFileSync(join(f.root, "progress"), "takeover\n");
    git(f.root, ["add", "."]); git(f.root, ["commit", "-m", "takeover"]);
    const head = git(f.root, ["rev-parse", "HEAD"]);
    getDb().prepare("UPDATE tasks SET status = 'rework', agent_id = 'old-agent', executor_agent_id = 'old-agent', executor_profile = 'old-profile', executor_family = 'openai' WHERE id = ?").run(task.id);
    const replacement = { ...profile("executor"), name: "demo fixture", pool: "claude-max" };
    const reworkReassign: ReworkReassignment = {
      oldAgentId: "old-agent", oldProfile: "old-profile", oldPool: "cursor", oldAgentState: "alive",
      expectedExecutorAgentId: "old-agent", reason: "Original pool unavailable", waitSince: new Date().toISOString(), evaluatedAt: new Date().toISOString(),
    };
    await startTask(task.id, returningLauncher(f, archived), "scheduler", { chosen: replacement, profiles: [replacement], reason: "test", reworkReassign });
    const opened = f.opened.at(-1)!;
    assert.equal(getTask(task.id).status, "running");
    assert.deepEqual(archived, ["old-agent"]);
    assert.notEqual(opened.workspaceId, f.main.id);
    assert.equal(git(opened.cwd, ["rev-parse", "HEAD"]), head);
    assert.equal(f.created[0]!.baseBranch, head);
  });

  it("reuses an existing temporary copy when leader rework starts a replacement", async () => {
    const f = fixture();
    const task = createTask({ project: "leader", title: "copied", role: "executor", workspacePath: f.root });
    await startTask(task.id, f.box, "test", pick("executor"));
    const copied = getTask(task.id);
    assert.equal(copied.workspace_kind, "worktree");
    appendEvent(task.id, "leader_rework", "blocked", "ready", "leader", {
      reason: "Continue edits", fromStatus: "blocked", countRound: false, agentId: copied.executor_agent_id, presence: "missing",
    });
    getDb().prepare("UPDATE tasks SET status = 'ready', agent_id = NULL, executor_agent_id = NULL WHERE id = ?").run(task.id);
    const createdBefore = f.created.length;
    const archived: string[] = [];
    await startTask(task.id, returningLauncher(f, archived), "scheduler", pick("executor"));
    assert.equal(f.created.length, createdBefore);
    assert.equal(f.opened.at(-1)!.cwd, copied.workspace_path);
    assert.equal(f.opened.at(-1)!.workspaceId, copied.paseo_workspace_id);
    assert.equal(archived.length, 0);
    assert.equal(getTask(task.id).status, "running");
  });

  for (const exception of ["alwaysTemp_off", "force"] as const) {
    it(`records ${exception} when adjudicated rework is allowed to stay on the main workspace`, async () => {
      const f = fixture();
      if (exception === "alwaysTemp_off") setProjectWorkspace("leader", { alwaysTemp: false });
      const archived: string[] = [];
      const { task } = adjudicatedDirectory(f, exception);
      await startTask(task.id, returningLauncher(f, archived), "scheduler", { ...pick("executor"), force: exception === "force" });
      assert.equal(f.created.length, 0);
      assert.equal(f.opened.at(-1)!.workspaceId, f.main.id);
      assert.equal(f.opened.at(-1)!.cwd, f.root);
      assert.equal(archived.length, 0);
      assert.equal(getTask(task.id).status, "running");
      const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'main_workspace_exception'").get(task.id) as { data_json: string };
      assert.equal(JSON.parse(event.data_json).reason, exception);
    });
  }

  it("preserves new committed rework progress when taking over a legacy main-directory card", async () => {
    const f = fixture();
    const task = createTask({ project: "leader", title: "takeover", role: "executor", workspacePath: f.root });
    const submitted = git(f.root, ["rev-parse", "HEAD"]);
    appendEvent(task.id, "branch_observed", null, null, "test", { branch: "main", head: submitted });
    writeFileSync(join(f.root, "progress"), "new rework\n");
    git(f.root, ["add", "."]); git(f.root, ["commit", "-m", "rework progress"]);
    const progress = git(f.root, ["rev-parse", "HEAD"]);
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
    await startTask(task.id, f.box, "test", pick("executor"));
    assert.equal(git(f.opened[0]!.cwd, ["rev-parse", "HEAD"]), progress);
    assert.notEqual(progress, submitted);
  });

  it("warns yellow for live board agents on the main workspace, including agents known only by runs", async () => {
    const f = fixture();
    const task = createTask({ project: "leader", title: "Old sample", role: "reader", workspacePath: f.root });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'board', paseo_workspace_id = ? WHERE id = ?").run(f.main.id, task.id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, 'run-only', 'reviewer', ?)").run(task.id, new Date().toISOString());
    getDb().prepare("UPDATE runs SET ended_at = ? WHERE agent_id = 'run-only'").run(new Date().toISOString());
    const report = await runDoctor({ sources: { workspaces: [f.main], agents: { agents: [
      { id: "board", archived: false, workspaceId: f.main.id },
      { id: "run-only", archived: false, cwd: f.root },
      { id: "<leader>", archived: false, workspaceId: f.main.id },
      { id: "archived", archived: true, workspaceId: f.main.id, labels: { kanban: "1" } },
    ] } } });
    const hits = report.findings.filter((x) => x.id.startsWith("agent:main:"));
    assert.deepEqual(hits.map((x) => [x.object, x.severity]).sort(), [["board", "yellow"], ["run-only", "yellow"]]);
  });

  it("only names newly created worktrees and agents, leaving existing titles alone", async () => {
    const f = fixture();
    const requests: unknown[] = [];
    const agentsCreated: unknown[] = [];
    const bad = () => { throw new Error((zhCNPart("routing.fastNotAllowed", 4, 6) + "Demo text")); };
    const api = {
      agents: { ref: bad },
      workspaces: {
        async create(request: { title?: string }) { requests.push(request); return { id: "temp", current: () => ({ workspaceDirectory: f.root, projectId: f.root, title: request.title }), setTitle: bad }; },
        ref(id: string) { assert.equal(id, "temp"); return { setTitle: bad, agents: { async create(request: unknown) { agentsCreated.push(request); return { id: "new", workspaceId: "temp" }; } } }; },
      },
    } as unknown as PaseoApi;
    const box = launcherFrom(api);
    await box.createWorktree!({ cwd: f.root, branchName: "kanban-readonly/TEST_0001", baseBranch: "main", title: "TEST_0001" });
    await box.create({ cwd: f.root, workspaceId: "temp", title: "Sample text agent", config: { provider: "claude" } });
    assert.equal((requests[0] as { title: string }).title, "TEST_0001");
    assert.equal((agentsCreated[0] as { title: string }).title, "Sample text agent");
    assert.equal(f.main.name, "<leader> Fixed title");
  });
});
