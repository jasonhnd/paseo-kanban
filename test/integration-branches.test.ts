/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readCleanupEvents } from "../server/archive-book";
import { ConfigFileError, configFileProblem, loadConfig, parseConfig, projectWorkspace, setProjectCode, setProjectWorkspace } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { runDoctor } from "../server/doctor";
import type { GitRunner } from "../server/git";
import { resetLaneLocksForTests, settleLaneBranch } from "../server/lane";
import { resetMissingCwdForTests, setMissingCwdHooks } from "../server/missing-cwd";
import { resetMergeCache, setGhRunner, writeContract } from "../server/pr";
import { readSettings, writeSettings } from "../server/settings";
import { appendEvent, createTask, getTask } from "../server/store";
import { settleTempWorkspace } from "../server/temp-workspace";
import { resetWorktreeRemovalForTests, settleOwnedWorktree } from "../server/worktree-gc";
import { branchName, laneBranchName } from "../server/workspace";

const savedData = process.env.KANBAN_DATA_DIR;
const savedTrees = process.env.KANBAN_WORKTREES_ROOT;
let dir: string;
let trees: string;

beforeEach(() => {
  closeDb();
  dir = mkdtempSync(join(tmpdir(), "integration-branches-"));
  trees = join(dir, "worktrees");
  mkdirSync(trees);
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_WORKTREES_ROOT = trees;
  setMissingCwdHooks({ listAgents: () => [] });
});

afterEach(() => {
  closeDb();
  resetMissingCwdForTests();
  resetWorktreeRemovalForTests();
  resetLaneLocksForTests();
  resetMergeCache();
  setGhRunner(null);
  if (savedData === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = savedData;
  if (savedTrees === undefined) delete process.env.KANBAN_WORKTREES_ROOT;
  else process.env.KANBAN_WORKTREES_ROOT = savedTrees;
  rmSync(dir, { recursive: true, force: true });
});

function rawConfig(integrationBranches?: unknown): Record<string, unknown> {
  return {
    projects: {
      demo: {
        defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false,
        ...(integrationBranches === undefined ? {} : { integrationBranches }),
      },
    },
  };
}

function configure(integrationBranches?: unknown): void {
  writeFileSync(join(dir, "kanban.config.json"), JSON.stringify(rawConfig(integrationBranches)));
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(integrationBranches?: unknown, kind: "worktree" | "lane" = "worktree") {
  configure(integrationBranches);
  const root = join(dir, "repo");
  mkdirSync(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Demo");
  git(root, "config", "user.email", "demo@example.invalid");
  git(root, "commit", "--allow-empty", "-m", "Initial");
  git(root, "branch", "pre");
  const task = createTask({ project: "demo", title: "Integration cleanup", role: "executor", workspacePath: root });
  const branch = kind === "lane" ? laneBranchName(task.id, task.title) : branchName(task.id, task.title);
  const directory = join(trees, "card");
  if (kind === "lane") git(root, "branch", "kanban-lane-1");
  git(root, "worktree", "add", "-b", branch, directory, "main");
  writeFileSync(join(directory, "change.txt"), "Card work\n");
  git(directory, "add", "change.txt");
  git(directory, "commit", "-m", "Card work");
  const tip = git(directory, "rev-parse", "HEAD");
  getDb().prepare("UPDATE tasks SET status = 'done', workspace_kind = ?, workspace_path = ?, workspace_base = 'main' WHERE id = ?").run(kind, directory, task.id);
  appendEvent(task.id, kind === "lane" ? "lane_bound" : "worktree_created", null, null, "test", {
    directory, branch, base: "main", root, ...(kind === "lane" ? { lane: "kanban-lane-1", workspaceId: "demo-lane" } : {}),
  });
  return { id: task.id, root, branch, directory, tip };
}

const fixtureGit: GitRunner = async (cwd, args) => {
  try {
    return { code: 0, stdout: git(cwd, ...args), stderr: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { code: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }
};

async function settle(id: number, run: GitRunner = fixtureGit): Promise<"settled" | "pending"> {
  const events = readCleanupEvents(id);
  const settleBranch = getTask(id).workspace_kind === "lane" ? settleLaneBranch : settleOwnedWorktree;
  return settleBranch({
    task: getTask(id), events, now: new Date(), timeoutMs: 5_000,
    record: data => {
      appendEvent(id, "cleanup", null, null, "test", data);
      events.push({ ...data, at: new Date().toISOString() });
    },
    run,
  });
}

function staleFailure(id: number, directory: string, branch: string, extra: Record<string, unknown> = {}): void {
  const at = new Date(Date.now() - 5 * 3_600_000).toISOString();
  getDb().prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'cleanup', 'test', ?)")
    .run(id, at, JSON.stringify({ action: "skip_worktree", directory, branch, ok: false, reason: "not_merged", ...extra }));
}

describe("integration branch configuration", () => {
  it("loads local and remote names and preserves them through project and settings edits", async () => {
    const names = ["pre", "origin/release/next", "refs/heads/staging", "refs/remotes/upstream/staging"];
    configure(names);
    const expected = { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: true, integrationBranches: names };
    assert.deepEqual(loadConfig().projects?.demo, expected);
    assert.deepEqual(projectWorkspace("demo"), expected);
    setProjectWorkspace("demo", { parallel: false });
    setProjectCode("demo", "DEMO");
    const settings = await readSettings(async () => []);
    assert.equal(settings.problem, null);
    assert.ok(settings.document);
    const saved = await writeSettings({ revision: settings.revision, document: settings.document }, async () => []);
    assert.equal(saved.ok, true);
    const raw = JSON.parse(readFileSync(join(dir, "kanban.config.json"), "utf8"));
    assert.deepEqual(raw.projects.demo.integrationBranches, names);
  });

  for (const invalid of [null, "pre", 1, [null], [""], [" "], [" pre"], ["-pre"], ["HEAD"], ["a..b"], ["a.lock"], ["a.lock/b"], ["a/.b"], ["a//b"], ["a/"], ["/a"], ["a."], ["a@{b"], ["a:b"], ["refs/tags/pre"], ["refs/heads/"], ["refs/remotes/"]]) {
    it(`rejects invalid integrationBranches ${JSON.stringify(invalid)} with a field-specific error`, () => {
      assert.throws(() => parseConfig(rawConfig(invalid)), error => {
        assert.ok(error instanceof ConfigFileError);
        assert.match(error.message, /projects\.demo\.integrationBranches/);
        return true;
      });
    });
  }

  it("leaves the option absent when unconfigured and accepts an empty list", () => {
    assert.equal(Object.hasOwn(projectWorkspace("demo", parseConfig(rawConfig())), "integrationBranches"), false);
    assert.deepEqual(parseConfig(rawConfig([])).projects?.demo, {
      defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: true, integrationBranches: [],
    });
  });

  it("accepts valid Git punctuation and a project with only integrationBranches configured", () => {
    const names = ["pre+next", "a./b", "@", "release/next"];
    for (const name of names) assert.equal(git(dir, "check-ref-format", "--branch", name), name);
    assert.deepEqual(parseConfig({ projects: { demo: { integrationBranches: names } } }).projects?.demo, {
      defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: true, integrationBranches: names,
    });
  });

  it("reports an invalid config file and rejects invalid project edits without writing", () => {
    configure(["pre"]);
    const path = join(dir, "kanban.config.json");
    const before = readFileSync(path, "utf8");
    assert.throws(() => setProjectWorkspace("demo", { integrationBranches: [""] }), ConfigFileError);
    assert.equal(readFileSync(path, "utf8"), before);
    configure(["bad.lock"]);
    assert.throws(() => loadConfig(), /projects\.demo\.integrationBranches/);
    assert.match(configFileProblem()?.message ?? "", /projects\.demo\.integrationBranches/);
  });
});

describe("cleanup on configured integration branches", () => {
  for (const [name, configured, ref] of [
    ["local pre", "pre", "refs/heads/pre"],
    ["origin/pre by short name", "pre", "refs/remotes/origin/pre"],
    ["origin/pre by remote name", "origin/pre", "refs/remotes/origin/pre"],
    ["an explicit local ref", "refs/heads/pre", "refs/heads/pre"],
    ["an explicit remote ref", "refs/remotes/upstream/pre", "refs/remotes/upstream/pre"],
  ]) {
    it(`removes the worktree and card branch contained only in ${name}`, async () => {
      const f = await fixture([configured]);
      // Neither a successful fetch nor a merged PR is needed for this proof.
      git(f.root, "remote", "add", "origin", join(dir, "unavailable.git"));
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(
        writeContract({ kind: "github", repo: "acme/widgets", pr: "https://github.com/acme/widgets/pull/8", awaiting: false }), f.id,
      );
      let ghCalls = 0;
      setGhRunner(async () => { ghCalls += 1; throw new Error("PR query must not be needed"); });
      git(f.root, "update-ref", ref, f.tip);
      assert.notEqual(git(f.root, "rev-parse", "refs/heads/main"), f.tip);
      const calls: string[][] = [];
      assert.equal(await settle(f.id, (cwd, args) => { calls.push(args); return fixtureGit(cwd, args); }), "settled");
      assert.equal(existsSync(f.directory), false);
      assert.equal(git(f.root, "branch", "--list", f.branch), "");
      assert.equal(git(f.root, "rev-parse", ref), f.tip);
      assert.equal(ghCalls, 0);
      assert.equal(calls.some(args => args[0] === "fetch"), false);
    });
  }

  it("keeps not_merged when neither main, an integration branch nor a PR contains the tip", async () => {
    const f = await fixture(["missing", "pre"]);
    assert.equal(await settle(f.id), "pending");
    assert.equal(existsSync(f.directory), true);
    assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), f.tip);
    assert.equal(readCleanupEvents(f.id).some(row => row.reason === "not_merged" && row.ok === false), true);
  });

  for (const integrationBranches of [undefined, []]) {
    it(`keeps the previous behavior with integrationBranches ${JSON.stringify(integrationBranches)}`, async () => {
      const f = await fixture(integrationBranches);
      git(f.root, "update-ref", "refs/heads/pre", f.tip);
      assert.equal(await settle(f.id), "pending");
      assert.equal(existsSync(f.directory), true);
      assert.equal(readCleanupEvents(f.id).some(row => row.reason === "not_merged"), true);
    });
  }

  it("does not treat a matching tag as an integration branch", async () => {
    const f = await fixture(["pre"]);
    git(f.root, "tag", "pre", f.tip);
    assert.equal(await settle(f.id), "pending");
    assert.equal(existsSync(f.directory), true);
  });

  it("does not use the card branch as its own integration destination", async () => {
    const f = await fixture();
    configure([f.branch]);
    assert.equal(await settle(f.id), "pending");
    assert.equal(existsSync(f.directory), true);
    assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), f.tip);
  });

  it("checks ancestry rather than accepting only equal tips", async () => {
    const f = await fixture(["pre"]);
    git(f.directory, "commit", "--allow-empty", "-m", "Integration follow-up");
    git(f.root, "update-ref", "refs/heads/pre", git(f.directory, "rev-parse", "HEAD"));
    git(f.directory, "reset", "--hard", f.tip);
    assert.equal(await settle(f.id), "settled");
    assert.equal(existsSync(f.directory), false);
    assert.equal(git(f.root, "branch", "--list", f.branch), "");
  });

  it("retains dirty work even when the committed tip is integrated", async () => {
    const f = await fixture(["pre"]);
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    writeFileSync(join(f.directory, "uncommitted.txt"), "Keep me\n");
    assert.equal(await settle(f.id), "pending");
    assert.equal(readFileSync(join(f.directory, "uncommitted.txt"), "utf8"), "Keep me\n");
    assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), f.tip);
  });

  it("uses the same proof for the temporary workspace cleanup path", async () => {
    const f = await fixture(["pre"]);
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    appendEvent(f.id, "temp_workspace", null, null, "test", { directory: f.directory, branch: f.branch, root: f.root, base: "main" });
    const events = readCleanupEvents(f.id);
    assert.equal(await settleTempWorkspace({
      task: getTask(f.id), events, now: new Date(), run: fixtureGit,
      record: data => {
        appendEvent(f.id, "cleanup", null, null, "test", data);
        events.push({ ...data, at: new Date().toISOString() });
      },
      archiveWorkspace: async () => {},
      decideWorkspace: async () => ({ action: "skip", reason: "gone" }),
    }), "settled");
    assert.equal(existsSync(f.directory), false);
    assert.equal(git(f.root, "branch", "--list", f.branch), "");
    assert.equal(events.some(row => row.action === "wip_commit" && row.landed === true), true);
  });

  it("retains the copy and branch when integration refs cannot be read", async () => {
    const f = await fixture(["pre"]);
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    const result = await settle(f.id, (cwd, args) => args[0] === "for-each-ref"
      ? Promise.resolve({ code: 128, stdout: "", stderr: "Cannot read integration refs" }) : fixtureGit(cwd, args));
    assert.equal(result, "pending");
    assert.equal(existsSync(f.directory), true);
    assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), f.tip);
  });

  it("rechecks the card tip before deletion and retains commits added after the first proof", async () => {
    const f = await fixture(["pre"]);
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    const later = git(f.root, "commit-tree", `${f.tip}^{tree}`, "-p", f.tip, "-m", "Unintegrated follow-up");
    let deleted = false;
    assert.equal(await settle(f.id, async (cwd, args) => {
      if (args[0] === "branch" && args[1] === "-D") deleted = true;
      const result = await fixtureGit(cwd, args);
      if (args[0] === "worktree" && args[1] === "remove" && result.code === 0) {
        git(f.root, "update-ref", `refs/heads/${f.branch}`, later);
      }
      return result;
    }), "pending");
    assert.equal(deleted, false);
    assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), later);
  });
});

describe("lane cleanup on configured integration branches", () => {
  for (const ref of ["refs/heads/pre", "refs/remotes/origin/pre"]) {
    it(`deletes only the integrated card branch and preserves the lane using ${ref}`, async () => {
      const f = await fixture(["pre"], "lane");
      git(f.root, "remote", "add", "origin", join(dir, "unavailable.git"));
      getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(
        writeContract({ kind: "github", repo: "acme/widgets", pr: "https://github.com/acme/widgets/pull/8", awaiting: false }), f.id,
      );
      let ghCalls = 0;
      setGhRunner(async () => { ghCalls += 1; throw new Error("Integration proof does not need a PR"); });
      git(f.root, "update-ref", ref, f.tip);
      const calls: string[][] = [];
      assert.equal(await settle(f.id, (cwd, args) => { calls.push(args); return fixtureGit(cwd, args); }), "settled");
      assert.equal(git(f.root, "branch", "--list", f.branch), "");
      assert.equal(existsSync(f.directory), true);
      assert.equal(git(f.directory, "branch", "--show-current"), "kanban-lane-1");
      assert.notEqual(git(f.root, "rev-parse", "refs/heads/main"), f.tip);
      assert.equal(git(f.root, "rev-parse", ref), f.tip);
      assert.equal(calls.filter(args => args[0] === "for-each-ref").length, 2, "recheck before forced deletion");
      assert.equal(calls.some(args => args[0] === "branch" && args[1] === "-D"), true);
      assert.equal(calls.some(args => args[0] === "worktree" || args[0] === "fetch"), false);
      assert.equal(ghCalls, 0);
      assert.equal(readCleanupEvents(f.id).some(row => row.action === "delete_lane_branch" && row.ok === true), true);
    });
  }

  it("keeps not_merged for a lane tip outside main and all integration branches", async () => {
    const f = await fixture(["pre"], "lane");
    assert.equal(await settle(f.id), "pending");
    assert.equal(readCleanupEvents(f.id).some(row => row.action === "skip_lane" && row.reason === "not_merged"), true);
    assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), f.tip);
    assert.equal(git(f.directory, "branch", "--show-current"), f.branch);
  });

  for (const configured of [undefined, []]) {
    it(`retains the previous lane behavior with integrationBranches ${JSON.stringify(configured)}`, async () => {
      const f = await fixture(configured, "lane");
      git(f.root, "update-ref", "refs/heads/pre", f.tip);
      assert.equal(await settle(f.id), "pending");
      assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), f.tip);
    });
  }

  it("preserves dirty lane files even if the committed tip is integrated", async () => {
    const f = await fixture(["pre"], "lane");
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    writeFileSync(join(f.directory, "unsaved.txt"), "Keep lane work\n");
    assert.equal(await settle(f.id), "pending");
    assert.equal(readFileSync(join(f.directory, "unsaved.txt"), "utf8"), "Keep lane work\n");
    assert.equal(git(f.directory, "branch", "--show-current"), f.branch);
    assert.equal(readCleanupEvents(f.id).some(row => row.action === "delete_lane_branch" && row.ok === false), true);
  });

  for (const changed of ["card tip", "integration ref"]) {
    it(`refuses forced lane deletion when the ${changed} changes after the merge gate`, async () => {
      const f = await fixture(["pre"], "lane");
      git(f.root, "update-ref", "refs/heads/pre", f.tip);
      const later = git(f.root, "commit-tree", `${f.tip}^{tree}`, "-p", f.tip, "-m", "Unintegrated lane follow-up");
      let switched = false;
      let forced = false;
      assert.equal(await settle(f.id, async (cwd, args) => {
        if (args[0] === "branch" && args[1] === "-D") forced = true;
        const result = await fixtureGit(cwd, args);
        if (args[0] === "checkout" && result.code === 0) {
          switched = true;
          git(f.root, "update-ref", changed === "card tip" ? `refs/heads/${f.branch}` : "refs/heads/pre",
            changed === "card tip" ? later : git(f.root, "rev-parse", "refs/heads/main"));
        }
        return result;
      }), "pending");
      assert.equal(switched, true);
      assert.equal(forced, false);
      assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), changed === "card tip" ? later : f.tip);
      assert.equal(existsSync(f.directory), true);
    });
  }

  it("keeps the lane branch when the deletion-time integration proof cannot be read", async () => {
    const f = await fixture(["pre"], "lane");
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    let reads = 0;
    let forced = false;
    assert.equal(await settle(f.id, (cwd, args) => {
      if (args[0] === "branch" && args[1] === "-D") forced = true;
      if (args[0] === "for-each-ref" && ++reads === 2) return Promise.resolve({ code: 128, stdout: "", stderr: "Cannot read integration refs" });
      return fixtureGit(cwd, args);
    }), "pending");
    assert.equal(reads, 2);
    assert.equal(forced, false);
    assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), f.tip);
  });

  it("finishes configured lane cleanup when its card branch was already removed", async () => {
    const f = await fixture(["pre"], "lane");
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    git(f.directory, "checkout", "kanban-lane-1");
    git(f.root, "branch", "-D", f.branch);
    assert.equal(await settle(f.id), "settled");
    assert.equal(existsSync(f.directory), true);
    assert.equal(git(f.directory, "branch", "--show-current"), "kanban-lane-1");
  });
});

describe("doctor integration cleanup findings", () => {
  it("clears a stale not_merged finding as soon as the card lands in pre, without changing board state", async () => {
    const f = await fixture(["pre"]);
    staleFailure(f.id, f.directory, f.branch);
    const before = await runDoctor({ persist: false, wake: false });
    assert.equal(before.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`)), true);
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    const eventsBefore = getDb().prepare("SELECT * FROM events ORDER BY id").all();
    const after = await runDoctor({ persist: false, wake: false });
    assert.equal(after.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`)), false);
    assert.deepEqual(getDb().prepare("SELECT * FROM events ORDER BY id").all(), eventsBefore);
    assert.equal(existsSync(f.directory), true);
  });

  it("keeps stale cleanup findings without configuration or when there is another read error", async () => {
    const f = await fixture();
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    staleFailure(f.id, f.directory, f.branch);
    const unconfigured = await runDoctor({ persist: false, wake: false });
    assert.equal(unconfigured.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`)), true);
    configure(["pre"]);
    staleFailure(f.id, f.directory, f.branch, { action: "remove_worktree", reason: "dirty", error: "Permission denied" });
    const unreadable = await runDoctor({ persist: false, wake: false });
    assert.equal(unreadable.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`)), true);
  });

  it("supersedes an old base-fetch error once local integration containment is proven", async () => {
    const f = await fixture(["pre"]);
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    staleFailure(f.id, f.directory, f.branch, { error: "Earlier fetch of origin/main failed" });
    const report = await runDoctor({ persist: false, wake: false });
    assert.equal(report.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`)), false);
  });

  for (const ref of ["refs/heads/pre", "refs/remotes/origin/pre"]) {
    it(`clears a lane not_merged finding using ${ref} without changing board state`, async () => {
      const f = await fixture(["pre"], "lane");
      staleFailure(f.id, f.directory, f.branch, { action: "skip_lane" });
      const before = await runDoctor({ persist: false, wake: false });
      assert.equal(before.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`)), true);
      git(f.root, "update-ref", ref, f.tip);
      const events = getDb().prepare("SELECT * FROM events ORDER BY id").all();
      const after = await runDoctor({ persist: false, wake: false });
      assert.equal(after.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`)), false);
      assert.deepEqual(getDb().prepare("SELECT * FROM events ORDER BY id").all(), events);
      assert.equal(git(f.root, "rev-parse", `refs/heads/${f.branch}`), f.tip);
      assert.equal(existsSync(f.directory), true);
    });
  }

  it("keeps unconfigured lane findings and errors unrelated to containment", async () => {
    const f = await fixture(undefined, "lane");
    git(f.root, "update-ref", "refs/heads/pre", f.tip);
    staleFailure(f.id, f.directory, f.branch, { action: "skip_lane" });
    const before = await runDoctor({ persist: false, wake: false });
    assert.equal(before.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`)), true);
    configure(["pre"]);
    staleFailure(f.id, f.directory, f.branch, { action: "delete_lane_branch", reason: "error", error: "Permission denied" });
    const after = await runDoctor({ persist: false, wake: false });
    assert.equal(after.findings.some(row => row.id.startsWith(`card:cleanup:${f.id}:`) && row.object === "delete_lane_branch"), true);
  });
});
