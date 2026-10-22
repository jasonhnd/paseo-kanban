import { selectedReviewRoute } from "./helpers/selected-review";
/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
// TEST_0268: Paseo's auto-archive-on-merge took DEMO_0003's temporary workspace while the card was still running.
// The fake below behaves like the Paseo 0.10.3 daemon: the worktree directory is <root>/<slug> (slug from
// worktreeSlug, else the branch; "-1", "-2" only when the path exists), an archive marks the workspace
// archiving, archives its agents, then removes the directory, and the "PR was seen open" latch is per path.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { slugify } from "@getpaseo/protocol/branch-slug";
import { setWakeSender } from "../server/bus";
import { closeDb, getDb } from "../server/db";
import { PASEO_ARCHIVE_SETTLE_MS, type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { applyFailure, classifyFailure, reclaimTask } from "../server/failures";
import { createLifecycleHooks, type LifecycleHookDeps } from "../server/lifecycle-hooks";
import { askPaseoAgent } from "../server/paseo";
import { readAgentPresence } from "../server/presence";
import { readReclaimContext } from "../server/reclaim-note";
import { planTurn } from "../server/nudge";
import { settleCanceledTurn } from "../server/presence";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { PLACEHOLDER_NAME } from "../server/missing-cwd";
import { liveWorkspace } from "../server/paseo-archiving";
import type { ListedWorkspace } from "../server/placement";
import type { Profile } from "../server/profiles";
import { addComment, appendEvent, createTask, getTask } from "../server/store";
import { readWorktreeCreated } from "../server/worktree-record";
import { leaderReworkTask, pendingReworkReplacement } from "../server/flow";
import { runTick } from "./helpers/compat-schedule";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "merge-archive-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_WORKTREES_ROOT = join(dir, "paseo-worktrees");
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
setWakeSender(() => Promise.resolve());

const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
const pick = { profiles: [executor], chosen: executor, reason: "Test" };
const reviewer: Profile = { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" };
const pickReviewer = { profiles: [reviewer], chosen: reviewer, reason: "Test", routing: selectedReviewRoute([reviewer]) };

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(name: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

interface FakeWorkspace extends ListedWorkspace {
  /** Paseo removed the record from its active list (archivedAt set). */
  gone: boolean;
}

interface FakePaseo extends AgentLauncher {
  root: string;
  /** cwd of every agent the board opened, in order. */
  cwds: string[];
  /** Opening prompt of every agent the board opened, in order. */
  prompts: string[];
  agents: Array<{ id: string; workspaceId?: string; archived: boolean }>;
  boardArchivedWorkspaces: string[];
  spaces: FakeWorkspace[];
  slugs: Array<string | undefined>;
  /** Paths where Paseo saw the PR open (auto-archive-on-merge `openPullRequestUrlsByCwd`). */
  openLatch: Set<string>;
  /** Steps 1-2 of Paseo's archiveByScope: mark archiving, archive the workspace's agents. */
  beginArchive(workspaceId: string): string[];
  /** Steps 4-6: archive the record, remove the worktree directory. The branch stays. */
  finishArchive(workspaceId: string): void;
  /** A snapshot of `cwd` shows the PR merged: every active workspace there whose path was latched gets archived. */
  mergedSnapshot(cwd: string): string[];
}

function paseo(root: string): FakePaseo {
  const worktrees = join(dir, "paseo-worktrees", root.split("/").pop()!);
  let n = 0;
  const box: FakePaseo = {
    root,
    cwds: [],
    prompts: [],
    agents: [],
    boardArchivedWorkspaces: [],
    spaces: [{ id: "main-ws", name: "main", directory: root, projectRoot: root, projectId: "prj", kind: "local_checkout", archived: false, gone: false }],
    slugs: [],
    openLatch: new Set(),
    async create(options) {
      const ws = box.spaces.find((space) => space.id === options.workspaceId);
      const cwd = ws?.directory ?? options.cwd;
      box.cwds.push(cwd);
      box.prompts.push(options.prompt ?? "");
      const id = `agent-${box.agents.length + 1}`;
      box.agents.push({ id, workspaceId: options.workspaceId, archived: false });
      return { id, workspaceId: options.workspaceId };
    },
    async send() {},
    async listWorkspaces() {
      // Paseo's list hides archived records; an in-progress archive shows archivingAt (the board's `archived`).
      return box.spaces.filter((space) => !space.gone).map(({ gone: _gone, ...entry }) => entry);
    },
    async createWorktree(options) {
      box.slugs.push((options as { worktreeSlug?: string }).worktreeSlug);
      const slug = slugify((options as { worktreeSlug?: string }).worktreeSlug ?? options.branchName);
      let directory = join(worktrees, slug);
      for (let suffix = 1; existsSync(directory); suffix += 1) directory = join(worktrees, `${slug}-${suffix}`);
      mkdirSync(worktrees, { recursive: true });
      git(options.cwd, "worktree", "add", "-q", "-b", options.branchName, directory, options.baseBranch);
      n += 1;
      const id = `ws-${n}`;
      box.spaces.push({ id, name: options.title ?? null, directory, projectRoot: root, projectId: "prj", kind: "worktree", archived: false, gone: false });
      return { directory, workspaceId: id, name: options.title ?? null };
    },
    async archiveAgent(agentId) {
      const agent = box.agents.find((entry) => entry.id === agentId);
      if (agent) agent.archived = true;
    },
    async archiveWorkspace(id) {
      box.boardArchivedWorkspaces.push(id);
      const space = box.spaces.find((entry) => entry.id === id);
      if (space) space.gone = true;
    },
    beginArchive(workspaceId) {
      const space = box.spaces.find((entry) => entry.id === workspaceId)!;
      space.archived = true;
      const archived: string[] = [];
      for (const agent of box.agents) {
        if (agent.workspaceId === workspaceId && !agent.archived) {
          agent.archived = true;
          archived.push(agent.id);
        }
      }
      return archived;
    },
    finishArchive(workspaceId) {
      const space = box.spaces.find((entry) => entry.id === workspaceId)!;
      space.gone = true;
      git(root, "worktree", "remove", "--force", space.directory!);
    },
    mergedSnapshot(cwd) {
      if (!box.openLatch.has(cwd)) return [];
      const hit = box.spaces.filter((space) => !space.gone && space.directory === cwd).map((space) => space.id);
      for (const id of hit) {
        box.beginArchive(id);
        box.finishArchive(id);
      }
      return hit;
    },
  };
  return box;
}

function events(id: number, kind: string): Array<Record<string, unknown>> {
  return (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json));
}

/** A running executor card in its own temporary worktree, with one commit, whose PR Paseo has seen open. */
async function runningCard(name: string) {
  const root = repo(name);
  const box = paseo(root);
  const task = createTask({ project: name, title: "pre", role: "executor", workspacePath: root });
  getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main' WHERE id = ?").run(task.id);
  await startTask(task.id, box, "test", pick);
  const first = readWorktreeCreated(task.id)!;
  appendEvent(task.id, "temp_workspace", null, null, "test", { name: "x", root, base: "main", directory: first.directory });
  writeFileSync(join(first.directory!, "work.txt"), "kept\n");
  git(first.directory!, "add", "-A");
  git(first.directory!, "commit", "-q", "-m", "work");
  box.openLatch.add(first.directory!);
  assert.equal(getTask(task.id).status, "running");
  assert.deepEqual(box.cwds, [first.directory]);
  return { root, box, task, first, tip: git(root, "rev-parse", first.branch!) };
}

describe("Paseo auto-archive-on-merge vs. an unfinished card (TEST_0268)", () => {
  for (const timing of ["second-list", "create-await", "after-create"] as const) {
    it(`recovers leader rework archived at ${timing} without losing its branch, pending marker or fresh path`, async () => {
      const { box, task, first, root, tip } = await runningCard(`rework-race-${timing}`);
      getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
      box.agents[0]!.archived = true;
      await leaderReworkTask(task.id, "Preserve the submitted tip", { presence: () => "archived" });
      const list = box.listWorkspaces!;
      const create = box.create;
      let lists = 0;
      let generation = "";
      box.listWorkspaces = async () => {
        if (timing === "second-list" && ++lists === 2) box.beginArchive(first.workspaceId!);
        return list();
      };
      box.create = async options => {
        generation = options.labels?.kanban_start_generation ?? "";
        const agent = await create(options);
        if (timing === "create-await") box.beginArchive(first.workspaceId!);
        return agent;
      };
      box.inspectStartup = async (agentId, workspaceId) => ({
        archived: box.agents.find(agent => agent.id === agentId)!.archived,
        busy: false, generation, workspaceId, merged: true,
        timelineComplete: true, toolCalls: 0, pullRequestUrl: "https://github.com/o/r/pull/22",
      });
      await startTask(task.id, box, "test", pick);
      if (timing === "after-create") {
        box.beginArchive(first.workspaceId!);
        await runTick({ launcher: box, profiles: [], config: {
          autoStart: { [task.project]: false }, supervisors: {}, supervisorAgentId: null,
          concurrency: { global: 20, roles: {}, pools: {} },
        }, agentState: () => "archived" });
      }
      assert.equal(getTask(task.id).status, "ready");
      assert.equal(getTask(task.id).blocked_kind, null);
      assert.ok(pendingReworkReplacement(task.id));
      assert.equal(box.cwds.length, timing === "second-list" ? 1 : 2);
      if (timing !== "second-list") assert.equal(events(task.id, "rework_startup_retry").length, 1);
      box.finishArchive(first.workspaceId!);
      const starts = await Promise.allSettled([startTask(task.id, box, "test", pick), startTask(task.id, box, "test", pick)]);
      assert.equal(starts.filter(result => result.status === "fulfilled").length, 1);
      const rebuilt = readWorktreeCreated(task.id)!;
      assert.equal(getTask(task.id).status, "running");
      assert.equal(rebuilt.branch, first.branch);
      assert.equal(git(root, "rev-parse", first.branch!), tip);
      assert.notEqual(rebuilt.directory, first.directory);
      assert.match(rebuilt.directory!, /-r1$/);
      assert.equal(getTask(task.id).paseo_workspace_id, rebuilt.workspaceId);
      assert.equal(box.cwds.length, timing === "second-list" ? 2 : 3, "concurrent retries open only one agent");
    });
  }

  it("DEMO_0003: after agent_gone, no agent opens in the workspace Paseo is archiving; the card resumes in a rebuilt copy Paseo does not re-archive", async () => {
    const { box, task, first, tip, root } = await runningCard("demo-0003");
    // 05:15:03.86 Paseo marks the workspace archiving and archives its agent; the agent.archived hook reclaims.
    assert.deepEqual(box.beginArchive(first.workspaceId!), ["agent-1"]);
    assert.equal(reclaimTask(task.id), "reclaimed");
    // 05:15:03.9 the hook's kick restarts the card while the directory is still on disk.
    await startTask(task.id, box, "test", pick);
    assert.deepEqual(box.cwds, [first.directory], "no new agent inside the workspace Paseo is archiving");
    assert.equal(getTask(task.id).status, "ready");
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp("Paseo " + localePattern(zhCNPart("flow.error.executorArchiving", 4, 8))));
    assert.equal(events(task.id, "paseo_workspace_archiving").length, 1);
    // A second tick during the same archive does not stack events.
    await startTask(task.id, box, "test", pick);
    assert.equal(events(task.id, "paseo_workspace_archiving").length, 1);
    // 05:15:09.5 Paseo removes the directory. The branch stays.
    box.finishArchive(first.workspaceId!);
    assert.equal(existsSync(first.directory!), false);
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    const now = readWorktreeCreated(task.id)!;
    assert.equal(now.branch, first.branch);
    assert.notEqual(now.directory, first.directory, "a fresh path, so Paseo's per-path latch cannot match it");
    assert.equal(box.cwds.at(-1), now.directory);
    assert.equal(readFileSync(join(now.directory!, "work.txt"), "utf8"), "kept\n");
    assert.equal(git(root, "rev-parse", first.branch!), tip);
    // Paseo's next snapshots: the merged PR is seen again on the old path (latched) and on the rebuilt one (not latched).
    assert.deepEqual(box.mergedSnapshot(first.directory!), []);
    assert.deepEqual(box.mergedSnapshot(now.directory!), [], "Paseo does not archive the rebuilt copy");
    assert.equal(existsSync(now.directory!), true);
    assert.equal(getTask(task.id).hold_reason, null);
    const [recreated] = events(task.id, "temp_workspace_recreated");
    assert.equal(recreated.usedRef, "branch");
    assert.equal(recreated.freshPath, true);
  });

  it("directory gone but branch kept: rebuilds on the branch at a fresh path and carries on", async () => {
    const { box, task, first, tip, root } = await runningCard("dir-gone");
    // Paseo already finished: agent archived, record archived, directory removed; the latch still names the old path.
    box.beginArchive(first.workspaceId!);
    box.finishArchive(first.workspaceId!);
    assert.equal(reclaimTask(task.id), "reclaimed");
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).blocked_kind, null);
    const now = readWorktreeCreated(task.id)!;
    assert.equal(now.branch, first.branch);
    assert.notEqual(now.directory, first.directory);
    assert.equal(box.cwds.at(-1), now.directory);
    assert.equal(readFileSync(join(now.directory!, "work.txt"), "utf8"), "kept\n");
    assert.equal(git(root, "rev-parse", first.branch!), tip);
    assert.deepEqual(box.mergedSnapshot(now.directory!), []);
    assert.equal(existsSync(now.directory!), true);
    // The slug asked of Paseo is the old directory name plus a rebuild number, and fits Paseo's 50-character slug.
    const slug = box.slugs.at(-1)!;
    assert.match(slug, /-r1$/);
    assert.ok(slug.length <= 50, slug);
  });

  it("a second rebuild picks another fresh path, never one the card used before", async () => {
    const { box, task, first } = await runningCard("twice");
    box.beginArchive(first.workspaceId!);
    box.finishArchive(first.workspaceId!);
    reclaimTask(task.id);
    await startTask(task.id, box, "test", pick);
    const second = readWorktreeCreated(task.id)!;
    box.openLatch.add(second.directory!);
    box.beginArchive(second.workspaceId!);
    box.finishArchive(second.workspaceId!);
    reclaimTask(task.id);
    await startTask(task.id, box, "test", pick);
    const third = readWorktreeCreated(task.id)!;
    assert.equal(getTask(task.id).status, "running");
    assert.equal(new Set([first.directory, second.directory, third.directory]).size, 3);
    assert.match(box.slugs.at(-1)!, /-r2$/);
  });

  it("a long card slug still gets a distinct path: the rebuild number survives Paseo's 50-character cut", async () => {
    const root = repo("long-slug");
    const box = paseo(root);
    const task = createTask({ project: "long-slug", title: "a very long title for a card that keeps going and going on", role: "executor", workspacePath: root });
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main' WHERE id = ?").run(task.id);
    await startTask(task.id, box, "test", pick);
    const first = readWorktreeCreated(task.id)!;
    box.beginArchive(first.workspaceId!);
    box.finishArchive(first.workspaceId!);
    reclaimTask(task.id);
    await startTask(task.id, box, "test", pick);
    const now = readWorktreeCreated(task.id)!;
    assert.notEqual(now.directory, first.directory);
    assert.match(now.directory!, /-r1$/);
  });

  it("a plain agent_gone (only the agent archived) keeps the temp workspace and opens the new agent in the same directory", async () => {
    const { box, task, first } = await runningCard("agent-only");
    await box.archiveAgent!("agent-1");
    assert.equal(reclaimTask(task.id), "reclaimed");
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    assert.deepEqual(box.cwds, [first.directory, first.directory]);
    assert.equal(box.agents.at(-1)!.workspaceId, first.workspaceId);
    assert.deepEqual(box.boardArchivedWorkspaces, []);
    assert.equal(existsSync(first.directory!), true);
    assert.equal(readWorktreeCreated(task.id)!.directory, first.directory);
    assert.equal(events(task.id, "temp_workspace_recreated").length, 0);
  });

  it("a live checkout that tracks a file named like the patrol placeholder is not rebuilt", async () => {
    const { box, task, first } = await runningCard("tracked-placeholder");
    writeFileSync(join(first.directory!, PLACEHOLDER_NAME), "docs\n");
    git(first.directory!, "add", "-A");
    git(first.directory!, "commit", "-q", "-m", "tracked placeholder name");
    await box.archiveAgent!("agent-1");
    reclaimTask(task.id);
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(box.cwds.at(-1), first.directory);
    assert.deepEqual(box.boardArchivedWorkspaces, [], "the in-use workspace is not archived as if lost");
    assert.equal(events(task.id, "temp_workspace_recreated").length, 0);
  });

  it("a rework card waits while Paseo archives its workspace instead of placing into it", async () => {
    const { box, task, first } = await runningCard("rework-archiving");
    getDb().prepare("UPDATE tasks SET status = 'rework', review_round = 1, executor_agent_id = 'agent-1', agent_id = 'agent-1' WHERE id = ?").run(task.id);
    box.beginArchive(first.workspaceId!);
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "rework");
    assert.deepEqual(box.cwds, [first.directory]);
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp("Paseo " + localePattern(zhCNPart("flow.error.executorArchiving", 4, 8))));
  });

  it("Paseo archived the record but left the directory: waits, then blocks needs_human after the settle window without touching it", async () => {
    const { box, task, first } = await runningCard("kept-dir");
    box.beginArchive(first.workspaceId!);
    box.spaces.find((space) => space.id === first.workspaceId)!.gone = true;
    reclaimTask(task.id);
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "ready");
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp("Paseo " + localePattern(zhCNPart("flow.error.executorArchiving", 4, 8))));
    const past = new Date(Date.now() - PASEO_ARCHIVE_SETTLE_MS - 1000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'paseo_workspace_archiving'").run(past, task.id);
    await startTask(task.id, box, "test", pick);
    const row = getTask(task.id);
    assert.equal(row.status, "blocked");
    assert.equal(row.blocked_kind, "needs_human");
    assert.ok(row.blocked_reason?.includes(first.workspaceId!), row.blocked_reason ?? "");
    assert.ok(row.blocked_reason?.includes(first.directory!), row.blocked_reason ?? "");
    assert.equal(existsSync(first.directory!), true, "the board does not delete it");
    assert.deepEqual(box.cwds, [first.directory]);
    assert.deepEqual(box.boardArchivedWorkspaces, []);
  });

  it("the settle check never reports the directory as still there when Paseo removed it while the list was loading", async () => {
    const { box, task, first } = await runningCard("vanish-during-list");
    box.beginArchive(first.workspaceId!);
    appendEvent(task.id, "paseo_workspace_archiving", null, null, "test", { workspaceId: first.workspaceId, directory: first.directory, state: "archiving" });
    const past = new Date(Date.now() - PASEO_ARCHIVE_SETTLE_MS - 1000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'paseo_workspace_archiving'").run(past, task.id);
    const list = box.listWorkspaces!;
    const launcher: AgentLauncher = {
      ...box,
      async listWorkspaces() {
        const listed = await list();
        box.finishArchive(first.workspaceId!);
        return listed;
      },
    };
    const live = await liveWorkspace({ taskId: task.id, workspaceId: first.workspaceId, directory: first.directory!, launcher, actor: "test" });
    assert.ok("hold" in live, "a hold for the rebuild, not PASEO_ARCHIVED");
    assert.match(live.hold, new RegExp(localePattern(zhCNPart("paseoArchiving.hold.directoryGone", 19, 23))));
    assert.equal(events(task.id, "paseo_workspace_archiving").length, 1);
  });
});

describe("an independent review borrowing a card's copy (TEST_0268)", () => {
  /** The executor card has handed in; an independent review card borrows its temporary copy. */
  async function handedIn(name: string, reviewPath?: (first: { directory?: string }, root: string) => string) {
    const card = await runningCard(name);
    const review = createTask({ project: name, title: "sample", role: "reviewer", workspacePath: reviewPath ? reviewPath(card.first, card.root) : card.root, reviewOf: card.task.id });
    getDb().prepare("UPDATE tasks SET status = 'in_review', agent_id = NULL WHERE id = ?").run(card.task.id);
    // Preserve the real ordering: the manual reservation predates the later inline queue.
    appendEvent(card.task.id, "complete", "running", "in_review", "executor");
    return { ...card, review };
  }

  it("follows the live workspace Paseo lists at the borrowed path when the recorded id is gone", async () => {
    const { box, first, root, review } = await handedIn("review-moved-id");
    box.spaces.find((space) => space.id === first.workspaceId)!.gone = true;
    box.spaces.push({ id: "ws-same-path", name: "same", directory: first.directory!, projectRoot: root, projectId: "prj", kind: "worktree", archived: false, gone: false });
    await startTask(review.id, box, "test", pickReviewer);
    assert.equal(getTask(review.id).status, "reviewing");
    assert.equal(box.agents.at(-1)!.workspaceId, "ws-same-path", "not the archived recorded id");
    assert.equal(box.cwds.at(-1), first.directory);
    assert.equal(getTask(review.id).paseo_workspace_id, "ws-same-path");
  });

  it("gets a read-only copy and starts when the borrowed directory is gone, even if it is the review card's own path", async () => {
    const { box, first, root, tip, task, review } = await handedIn("review-same-path", (copy) => copy.directory!);
    box.beginArchive(first.workspaceId!);
    box.finishArchive(first.workspaceId!);
    await startTask(review.id, box, "test", pickReviewer);
    const row = getTask(review.id);
    assert.equal(row.status, "reviewing");
    assert.equal(row.blocked_kind, null);
    const cwd = box.cwds.at(-1)!;
    assert.notEqual(cwd, first.directory);
    assert.equal(readFileSync(join(cwd, "work.txt"), "utf8"), "kept\n");
    assert.equal(events(review.id, "temp_workspace_recreated").length, 1);
    assert.equal(git(root, "rev-parse", first.branch!), tip);
    assert.equal(events(task.id, "temp_workspace_recreated").length, 0, "the reviewed card's own record is untouched");
  });

  it("reviews the live checkout when it only tracks a file named like the patrol placeholder", async () => {
    const { box, first, review } = await handedIn("review-tracked-placeholder");
    writeFileSync(join(first.directory!, PLACEHOLDER_NAME), "docs\n");
    git(first.directory!, "add", "-A");
    git(first.directory!, "commit", "-q", "-m", "tracked placeholder name");
    await startTask(review.id, box, "test", pickReviewer);
    assert.equal(getTask(review.id).status, "reviewing");
    assert.equal(box.cwds.at(-1), first.directory);
    assert.equal(events(review.id, "temp_workspace_recreated").length, 0);
  });
});

// TEST_0299: TEST2_0165 / TEST2_0166. A merge card's agent checked out the PR branch in its temp worktree and ran
// gh pr merge; Paseo 0.11.1's auto-archive-on-merge archived the workspace and the agent 4-6 s later, the
// agent.archived hook reclaimed, and the next agent got the same brief and reported the merge as the user's.
describe("Paseo closes the agent after a PR merge: reclaim evidence and the restart prompt (TEST_0299)", () => {
  const PR = "https://github.com/o/r/pull/354";

  /**
   * The real lifecycle hooks, wired to a Paseo context that answers like the 0.11.1 daemon. Paseo's archive emits
   * agent.archived (markRecordArchived), then closes the session, which ends the running turn as canceled.
   */
  function paseoEvents(box: FakePaseo, opts: { workspaceId: string; merged: boolean; timeline: unknown[] }) {
    const paseo = {
      agents: {
        ref: (agentId: string) => ({
          refresh: async () => {
            const agent = box.agents.find((entry) => entry.id === agentId);
            return agent ? { agent: { id: agentId, status: "idle", archivedAt: agent.archived ? "2026-10-08T01:49:31.317Z" : null } } : null;
          },
          current: () => null,
          timeline: { refetch: async () => ({ entries: opts.timeline.map((item) => ({ item })) }) },
          send: async () => assert.fail("no message to a departed agent"),
        }),
      },
      workspaces: {
        ref: (id: string) => ({
          refresh: async () => {
            const space = box.spaces.find((entry) => entry.id === id && !entry.gone);
            if (!space) return null;
            return {
              id, archivingAt: space.archived ? "2026-10-08T01:49:31.300Z" : null,
              githubRuntime: { pullRequest: { url: PR, number: 354, title: "t", state: opts.merged ? "merged" : "open", baseRefName: "dev", headRefName: "kanban/TEST2_0160-task", isMerged: opts.merged } },
            };
          },
        }),
      },
    };
    const noop = () => undefined;
    const errors: string[] = [];
    const hooks = createLifecycleHooks({
      hookObjects: { agent: () => true, workspace: () => true },
      bind: noop, schedulerReady: () => true, bindMemory: noop, kick: async () => undefined,
      createOptions: () => ({ baseUrl: "http://fixture", supervisorToken: null }),
      permissionContext: () => ({ kanban: true, autoAccept: false, role: "executor", taskId: null }),
      console: { error: (...args: unknown[]) => { errors.push(args.join(" ")); } },
      getDb, decidePermission: () => ({ action: "ignore" }), addComment, appendEvent, getTask,
      planTurn, lastUserMessageAtOf: () => undefined,
      readAgentPresence, settleCanceledTurn, askPaseoAgent, readAgentEndNote: async () => null,
      settleOpeningLoginBlip: async () => "ignore", readProfiles: () => [], applyFailure, classifyFailure, reclaimTask,
      applyNudge: () => ({ action: "none" }), mcpNoteFor: () => null, readReclaimContext,
    } as unknown as LifecycleHookDeps);
    const context = { paseo } as unknown as PluginHookContext;
    const agent = (agentId: string) => ({ id: agentId, workspaceId: opts.workspaceId, cwd: "", provider: "claude", title: null, parentAgentId: null });
    return {
      errors,
      archived: (agentId: string) => hooks.archived({ agent: agent(agentId), archivedAt: "2026-10-08T01:49:31.317Z" } as never, context),
      canceled: (agentId: string) => hooks.turn({
        agent: agent(agentId), turnId: "t1", timeline: opts.timeline, outcome: { kind: "canceled", reason: "agent closed" },
      } as never, context),
    };
  }

  /** The fake numbers agents per card; hooks look a card up by agent id across the shared database. */
  function uniqueAgent(box: FakePaseo, taskId: number, agentId: string): string {
    const old = box.agents[0]!.id;
    box.agents[0]!.id = agentId;
    getDb().prepare("UPDATE tasks SET agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, taskId);
    getDb().prepare("UPDATE runs SET agent_id = ? WHERE task_id = ? AND agent_id = ?").run(agentId, taskId, old);
    return agentId;
  }

  const mergeTimeline = [
    { type: "tool_call", callId: "c1", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "git switch kanban/TEST2_0160-task", exitCode: 0 } },
    { type: "tool_call", callId: "c2", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "KANBAN_TOKEN=abc123 gh pr merge 354 --squash", exitCode: 0 } },
    { type: "assistant_message", text: ("PR #354 " + zhCNPart("reclaimNote.cause.prMerged", 34, 38) + "Demo text Issue #352 " + zhCNPart("board.attention.memo", 78, 80) + zhCNPart("workspace.freshCopy", 21, 23)) },
  ];

  it("TEST2_0165: the reclaim records the merged PR and the last operations; the rebuilt agent is told not to merge again", async () => {
    const { box, task, first } = await runningCard("test2-0165");
    const agentId = uniqueAgent(box, task.id, "ad3a3a96");
    const paseoSays = paseoEvents(box, { workspaceId: first.workspaceId!, merged: true, timeline: mergeTimeline });
    // 01:49:31.317 Paseo marks the workspace archiving and archives agent-1 mid-turn.
    assert.deepEqual(box.beginArchive(first.workspaceId!), [agentId]);
    // agent.archived alone leaves a running executor/batch card to the quiet hand-in (TEST_0256)...
    await paseoSays.archived(agentId);
    assert.equal(getTask(task.id).status, "running");
    // ...the session close then ends the turn as canceled with the agent gone: this is the reclaim (presence.ts).
    await paseoSays.canceled(agentId);
    assert.deepEqual(paseoSays.errors, []);
    assert.equal(getTask(task.id).status, "ready");
    const [reclaimed] = events(task.id, "reclaimed");
    assert.equal(reclaimed!.reason, "agent_gone");
    assert.equal(reclaimed!.source, "turn_canceled");
    assert.equal(reclaimed!.cancelReason, "agent closed");
    assert.equal(reclaimed!.apiState, "archived");
    assert.deepEqual(reclaimed!.workspace, { id: first.workspaceId, archiving: true, pullRequest: { url: PR, number: 354, headRefName: "kanban/TEST2_0160-task", merged: true } });
    assert.deepEqual(reclaimed!.trail, { actions: [("git switch kanban/TEST2_0160-task" + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("compat.exitCode", 0, 4) + "0" + zhCNPart("missingCwd.none", 3, 4)), ("gh pr merge #354 --squash" + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("compat.exitCode", 0, 4) + "0" + zhCNPart("missingCwd.none", 3, 4))], otherCommands: 0 });
    assert.doesNotMatch(JSON.stringify(reclaimed), new RegExp("abc123|" + localePattern(zhCNPart("reclaimNote.cause.prMerged", 34, 38)) + "Demo text"), "no raw command text or assistant message reaches the database");
    // The kick lands while Paseo is still archiving: no agent; then the directory goes and the card rebuilds.
    await startTask(task.id, box, "test", pick);
    assert.equal(box.prompts.length, 1);
    box.finishArchive(first.workspaceId!);
    await startTask(task.id, box, "test", pick);
    assert.equal(getTask(task.id).status, "running");
    const prompt = box.prompts.at(-1)!;
    assert.match(prompt, new RegExp(zhCN("reclaimNote.heading")));
    assert.match(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.heading", 3, 13)) + "ad3a3a96" + localePattern(zhCNPart("reclaimNote.run", 17, 21)) + zhCN("labels.role.executor") + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.match(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.attribute", 29, 42))));
    assert.match(prompt, new RegExp(`PR ${PR.replace(/[.]/g, "\\.")}${zhCNPart("reclaimNote.cause.branch", 0, 4)}kanban/TEST2_0160-task${zhCNPart("doctor.blocked.symptom", 9, 11)}${zhCNPart("worktreeGc.leftover.notMerged", 1, 3)}`));
    assert.match(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.cause.prMerged", 76, 91))));
    assert.match(prompt, new RegExp("- gh pr merge #354 --squash" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + localePattern(zhCNPart("compat.exitCode", 0, 4)) + "0" + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.doesNotMatch(prompt, /abc123|KANBAN_TOKEN/);
    assert.match(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.check", 88, 97))));
    assert.match(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.attribute", 29, 42))));
    assert.doesNotMatch(box.prompts[0]!, new RegExp(localePattern(zhCNPart("reclaimNote.heading", 3, 16))), "the first agent had no predecessor");
  });

  it("PR merged and the directory gone, but Paseo still reports the agent live and unarchived: the card and agent stay", async () => {
    const { box, task, first } = await runningCard("test2-alive");
    const agentId = uniqueAgent(box, task.id, "1a5eabbb");
    const paseoSays = paseoEvents(box, { workspaceId: first.workspaceId!, merged: true, timeline: mergeTimeline });
    // Paseo took the workspace and its directory, but the agent record is (again) unarchived.
    box.beginArchive(first.workspaceId!);
    box.finishArchive(first.workspaceId!);
    box.agents[0]!.archived = false;
    assert.equal(existsSync(first.directory!), false);
    await paseoSays.archived(agentId);
    await paseoSays.canceled(agentId);
    assert.deepEqual(paseoSays.errors, []);
    const now = getTask(task.id);
    assert.equal(now.status, "running");
    assert.equal(now.agent_id, agentId);
    assert.equal(events(task.id, "reclaimed").length, 0);
    assert.deepEqual(events(task.id, "turn_canceled"), [{ agentId, presence: "idle" }]);
    // The scheduler's restart does not place a second agent either: the card is not ready.
    await startTask(task.id, box, "test", pick).catch(() => undefined);
    assert.equal(box.prompts.length, 1, "no second agent");
  });

  it("a reclaim without hook evidence (reconcile path) still tells the next agent to check before acting", async () => {
    const { box, task, first } = await runningCard("reconcile-gone");
    await box.archiveAgent!("agent-1");
    assert.equal(reclaimTask(task.id, new Date(), { fileState: "missing", apiState: "missing" }), "reclaimed");
    await startTask(task.id, box, "test", pick);
    assert.equal(box.cwds.at(-1), first.directory);
    const prompt = box.prompts.at(-1)!;
    assert.match(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.heading", 3, 13)) + "agent-1"));
    assert.match(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.cause.goneStates", 0, 15)) + "missing" + zhCN("nativeSessions.sweep.reasonSep") + "missing" + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.match(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.check", 49, 57))));
    assert.doesNotMatch(prompt, new RegExp(localePattern(zhCNPart("reclaimNote.actions", 0, 11))));
  });
});
