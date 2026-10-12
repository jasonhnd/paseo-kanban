/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { cardMark } from "../server/card-ref";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { acceptTask, approveTask, completeTask, requestChanges } from "../server/flow";
import type { Profile } from "../server/profiles";
import { openEntry } from "../server/pools";
import { runTick } from "./helpers/compat-schedule";
import { appendEvent, claimStatus, createTask, getTask, requestAgentReleases } from "../server/store";
import { tempBranchName } from "../server/workspace";

const tmp = join(tmpdir(), "TEST_0103");
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "land-conflict-"));
const agents = join(dir, "agents");
const trees = join(dir, "paseo-worktrees");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agents;
process.env.KANBAN_WORKTREES_ROOT = trees;
mkdirSync(agents, { recursive: true });
mkdirSync(trees, { recursive: true });

const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" };
const reviewer: Profile = { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Replay the branch onto main and keep both README bodies, so the next accept can fast-forward. */
async function rebaseKeepBoth(directory: string): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile("git", ["rebase", "main"], { cwd: directory }, () => resolve());
  });
  writeFileSync(join(directory, "README"), "from-left\nfrom-right\n");
  await git(directory, ["add", "README"]);
  await git(directory, ["-c", "core.editor=true", "rebase", "--continue"]);
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || stdout || err.message));
      else resolve(String(stdout));
    });
  });
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

function writeAgent(id: string, cwd: string, archived = false): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(
    join(agents, "bucket", `${id}.json`),
    JSON.stringify({
      id,
      cwd,
      title: id,
      provider: "cursor",
      labels: { kanban: "1" },
      lastActivityAt: "2026-10-01T00:00:00.000Z",
      ...(archived ? { archivedAt: "2026-10-01T00:00:00.000Z" } : {}),
    }),
  );
}

function rememberTemp(id: number, root: string, branch: string, directory: string, archived = false): void {
  const code = cardMark(id);
  getDb()
    .prepare(
      `UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main', workspace_path = ?, paseo_workspace_id = ?, paseo_workspace_name = ?, agent_id = ?, executor_agent_id = ? WHERE id = ?`,
    )
    .run(directory, `ws-${id}`, code, `agent-${id}`, `agent-${id}`, id);
  appendEvent(id, "temp_workspace", null, null, "test", { name: code, root, base: "main" });
  appendEvent(id, "worktree_created", null, null, "test", { directory, branch, base: "main", root, temp: true });
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, provider, model, family, started_at) VALUES (?, ?, 'executor', 'cursor', 'grok-4.7', 'xai', ?)").run(id, `agent-${id}`, new Date().toISOString());
  writeAgent(`agent-${id}`, directory, archived);
}

async function branchCard(root: string, project: string, title: string, file: string, body: string, archived = false): Promise<{ id: number; branch: string; directory: string }> {
  const task = createTask({ project, title, role: "executor", workspacePath: root, brief: "demo fixture" });
  const branch = tempBranchName(cardMark(task.id), title);
  const directory = join(trees, `${project}-${title}`);
  await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
  writeFileSync(join(directory, file), body);
  await git(directory, ["add", file]);
  await git(directory, ["commit", "-m", title]);
  rememberTemp(task.id, root, branch, directory, archived);
  getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
  return { id: task.id, branch, directory };
}

function events(id: number): Array<{ kind: string; data_json: string }> {
  return getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? ORDER BY id").all(id) as Array<{ kind: string; data_json: string }>;
}

function landEvent(id: number): { files?: string[]; other?: string | null; base?: string; count?: number } {
  const row = [...events(id)].reverse().find((item) => item.kind === "land_conflict");
  assert.ok(row, "land_conflict event");
  return JSON.parse(row.data_json) as { files?: string[]; other?: string | null; base?: string; count?: number };
}

function box(): AgentLauncher & { prompts: string[]; sent: string[] } {
  const prompts: string[] = [];
  const sent: string[] = [];
  let n = 0;
  return {
    prompts,
    sent,
    async create(options) {
      n += 1;
      prompts.push(options.prompt ?? "");
      return { id: `opened-${n}` };
    },
    async send(_id, text) {
      sent.push(text);
    },
  };
}

async function deliverAgain(id: number): Promise<void> {
  claimStatus(id, "rework", "running", "test");
  completeTask(id, "executor", zhCNPart("tempLand.conflict.withCard", 23, 29), null);
  claimStatus(id, "in_review", "reviewing", "test");
  await approveTask(id, (zhCNPart("flow.conflict.reviewNote", 36, 40) + zhCNPart("flow.conflict.reviewNote", 42, 47)), "reviewer");
}

describe("accept land conflict is not a review rejection", { concurrency: 1 }, () => {
  it("keeps review_round and returns to rework after approve when rebase conflicts", async () => {
    const root = await makeRepo("round-root");
    const left = await branchCard(root, "round", "left", "README", "from-left\n");
    const right = await branchCard(root, "round", "right", "README", "from-right\n");
    await acceptTask(left.id);
    getDb().prepare("UPDATE tasks SET review_round = 2 WHERE id = ?").run(right.id);
    await assert.rejects(acceptTask(right.id), new RegExp(`${zhCNPart("register.error.emptyFields", 8, 10)}${cardMark(left.id)} ${zhCNPart("tempLand.conflict.withCard", 10, 15)}`));
    const task = getTask(right.id);
    assert.equal(task.status, "rework");
    assert.equal(task.review_round, 2);
    assert.equal(task.blocked_kind, null);
    assert.equal(task.land_conflict_count, 1);
    assert.equal(task.executor_agent_id, `agent-${right.id}`);
    const data = landEvent(right.id);
    assert.deepEqual(data.files, ["README"]);
    assert.equal(data.other, cardMark(left.id));
    assert.equal(data.base, "main");
    assert.equal(data.count, 1);
    assert.match(task.brief, new RegExp(zhCN("flow.brief.landConflict")));
    assert.match(task.brief, new RegExp(cardMark(left.id)));
    assert.match(task.brief, new RegExp("git rebase main " + localePattern(zhCNPart("flow.conflict.redo", 18, 34))));
    assert.equal(events(right.id).some((row) => row.kind === "rejected"), false);
    assert.equal(events(right.id).some((row) => row.kind === "review_leader_hold"), false);
    assert.equal(new RegExp(zhCN("flow.comment.round3")).test(task.blocked_reason ?? ""), false);

    const resumed = box();
    await startTask(right.id, resumed, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Rework" });
    assert.match(resumed.sent[0] ?? "", new RegExp("git rebase main " + localePattern(zhCNPart("flow.conflict.redo", 18, 34))));
    assert.equal(new RegExp(zhCN("labels.caption.reviewRejectBare") + "|" + localePattern(zhCNPart("flow.comment.round2", 0, 5))).test(resumed.sent[0] ?? ""), false);

    completeTask(right.id, "executor", (zhCNPart("tempLand.conflict.withCard", 25, 29) + zhCNPart("dispatch.noExecutorAgent", 18, 20) + zhCNPart("labels.status.done", 0, 1)), null);
    const review = box();
    await startTask(right.id, review, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    const prompt = review.prompts[0] ?? "";
    assert.match(prompt, new RegExp("## " + localePattern(zhCNPart("dispatch.prompt.conflict", 3, 7))));
    assert.match(prompt, new RegExp(localePattern(zhCNPart("flow.conflict.reviewNote", 0, 6))));
    assert.match(prompt, /range-diff/);
    assert.match(prompt, new RegExp(localePattern(zhCNPart("flow.conflict.reviewNote", 42, 49))));
  });

  it("names the main checkout when no other card landed the same file", async () => {
    const root = await makeRepo("mainline-root");
    const card = await branchCard(root, "mainline", "feature", "README", "from-card\n");
    writeFileSync(join(root, "README"), "from-main\n");
    await git(root, ["add", "README"]);
    await git(root, ["commit", "-m", "main move"]);
    getDb().prepare("UPDATE tasks SET review_round = 2 WHERE id = ?").run(card.id);
    await assert.rejects(acceptTask(card.id), new RegExp(localePattern(zhCNPart("tempLand.conflict.withMain", 0, 14))));
    const task = getTask(card.id);
    assert.equal(task.status, "rework");
    assert.equal(task.review_round, 2);
    assert.equal(task.blocked_kind, null);
    const data = landEvent(card.id);
    assert.deepEqual(data.files, ["README"]);
    assert.equal(data.other, null);
    assert.match(task.brief, new RegExp("git rebase main " + localePattern(zhCNPart("flow.conflict.redo", 18, 34))));
  });

  it("wakes a person only after land conflicts pass the limit", async () => {
    assert.equal(loadConfig().landConflictLimit, 3);
    saveConfig({ ...loadConfig(), landConflictLimit: 1 });
    try {
      const root = await makeRepo("limit-root");
      const left = await branchCard(root, "limit", "left", "README", "from-left\n");
      const right = await branchCard(root, "limit", "right", "README", "from-right\n");
      await acceptTask(left.id);
      getDb().prepare("UPDATE tasks SET review_round = 1 WHERE id = ?").run(right.id);
      await assert.rejects(acceptTask(right.id), new RegExp(localePattern(zhCNPart("tempLand.conflict.withCard", 10, 15))));
      assert.equal(getTask(right.id).status, "rework");
      assert.equal(getTask(right.id).review_round, 1);
      assert.equal(getTask(right.id).blocked_kind, null);
      assert.equal(getTask(right.id).land_conflict_count, 1);

      await deliverAgain(right.id);
      await assert.rejects(acceptTask(right.id), new RegExp(localePattern(zhCNPart("tempLand.conflict.withCard", 10, 15))));
      const blocked = getTask(right.id);
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.blocked_kind, "needs_human");
      assert.equal(blocked.review_round, 1);
      assert.equal(blocked.land_conflict_count, 2);
      assert.match(blocked.blocked_reason ?? "", new RegExp(zhCN("labels.caption.landConflictBare")));
      assert.equal(new RegExp(zhCN("flow.comment.round3")).test(blocked.blocked_reason ?? ""), false);
    } finally {
      saveConfig({ ...loadConfig(), landConflictLimit: 3 });
    }
  });

  it("resets the land conflict count after a clean land", async () => {
    saveConfig({ ...loadConfig(), landConflictLimit: 1 });
    try {
      const root = await makeRepo("reset-root");
      const left = await branchCard(root, "reset", "left", "README", "from-left\n");
      const right = await branchCard(root, "reset", "right", "README", "from-right\n");
      await acceptTask(left.id);
      await assert.rejects(acceptTask(right.id), new RegExp(localePattern(zhCNPart("tempLand.conflict.withCard", 10, 15))));
      assert.equal(getTask(right.id).land_conflict_count, 1);
      await rebaseKeepBoth(right.directory);
      await deliverAgain(right.id);
      const landed = await acceptTask(right.id);
      assert.equal(landed.status, "done");
      assert.equal(getTask(right.id).land_conflict_count, 0);
    } finally {
      saveConfig({ ...loadConfig(), landConflictLimit: 3 });
    }
  });

  it("still stops for a person on the third review rejection", () => {
    const task = createTask({ project: "review-fuse", title: "Three review rounds", role: "executor" });
    const cycle = () => {
      const current = getTask(task.id);
      if (current.status === "rework") claimStatus(task.id, "rework", "running", "test");
      else claimStatus(task.id, "ready", "running", "test");
      completeTask(task.id, "executor", "Updated", null);
      claimStatus(task.id, "in_review", "reviewing", "test");
      return requestChanges(task.id, "Still failing", "Add tests", "reviewer");
    };
    assert.equal(cycle().status, "rework");
    const held = cycle();
    assert.equal(held.status, "rework");
    assert.equal(held.review_round, 2);
    assert.equal(held.blocked_kind, null);
    assert.equal(events(task.id).some((row) => row.kind === "review_leader_hold"), true);
    const blocked = cycle();
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_kind, "needs_human");
    assert.equal(blocked.review_round, 3);
    assert.match(blocked.blocked_reason ?? "", new RegExp(zhCN("flow.comment.round3")));
    assert.equal(events(task.id).some((row) => row.kind === "land_conflict"), false);
  });

  it("opens a new executor when the old one is gone, with the conflict note in the brief", async () => {
    const root = await makeRepo("gone-root");
    const left = await branchCard(root, "gone", "left", "README", "from-left\n");
    const right = await branchCard(root, "gone", "right", "README", "from-right\n", true);
    requestAgentReleases(right.id, [{ agentId: `agent-${right.id}`, role: "executor" }]);
    await acceptTask(left.id);
    await assert.rejects(acceptTask(right.id), new RegExp(localePattern(zhCNPart("tempLand.conflict.withCard", 10, 15))));
    const task = getTask(right.id);
    assert.equal(task.status, "rework");
    assert.equal(task.executor_agent_id, null);
    assert.match(task.brief, new RegExp("git rebase main " + localePattern(zhCNPart("flow.conflict.redo", 18, 34))));
    const opened = box();
    opened.inspectAgent = async id => id === `agent-${right.id}` ? { archived: true } : { archived: false };
    const config = loadConfig();
    config.autoStart.gone = true;
    await runTick({ profiles: [executor, reviewer], launcher: opened, config, matrix: { state: "missing" },
      agentState: () => "alive",
      pools: { state: "fresh", generatedAt: new Date().toISOString(), message: "", hasPool: () => true, dispatchable: () => true, entry: () => openEntry() },
    });
    assert.match(opened.prompts[0] ?? "", new RegExp("git rebase main " + localePattern(zhCNPart("flow.conflict.redo", 18, 34))));
    assert.equal(getTask(right.id).status, "running");
    assert.equal(getTask(right.id).workspace_path, right.directory);
    assert.equal(getTask(right.id).hold_reason, null);
    assert.deepEqual(opened.sent, []);
    assert.equal(events(right.id).filter(row => row.kind === "held").length, 0);
    assert.equal(events(right.id).filter(row => row.kind === "rework_reopened").length, 1);
  });

  it("drops the conflict-review note after a normal review rejection", async () => {
    const root = await makeRepo("note-root");
    const left = await branchCard(root, "note", "left", "README", "from-left\n");
    const right = await branchCard(root, "note", "right", "README", "from-right\n");
    await acceptTask(left.id);
    await assert.rejects(acceptTask(right.id), new RegExp(localePattern(zhCNPart("tempLand.conflict.withCard", 10, 15))));
    claimStatus(right.id, "rework", "running", "test");
    completeTask(right.id, "executor", (zhCNPart("profileRules.tag.highRisk", 62, 64) + "Demo text"), null);
    claimStatus(right.id, "in_review", "reviewing", "test");
    requestChanges(right.id, (zhCNPart("tempWorkspace.branch.keptAfterRetriesComment", 32, 34) + "Demo text"), (zhCNPart("tempWorkspace.placeholder.notDirectory", 6, 8) + zhCNPart("dispatch.prompt.readReview", 8, 12)), "reviewer");
    claimStatus(right.id, "rework", "running", "test");
    completeTask(right.id, "executor", "Updated following review", null);
    const review = box();
    await startTask(right.id, review, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Review again" });
    assert.equal((review.prompts[0] ?? "").includes(("## " + zhCNPart("dispatch.prompt.conflict", 3, 7))), false);
  });
});
