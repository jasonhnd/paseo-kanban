import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { DELETE_BRANCH_RETRY_LIMIT, readCleanupEvents } from "../server/archive-book";
import { setWakeSender } from "../server/bus";
import { kanbanHelp, runKanban } from "../server/cli";
import { drainCleanups, flushCleanups, installCleanup } from "../server/cleanup";
import { discardAuthorization } from "../server/cleanup-discard";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { runGit, type GitRunner } from "../server/git";
import { setMissingCwdHooks, resetMissingCwdForTests } from "../server/missing-cwd";
import { appendEvent, createTask, getTask } from "../server/store";
import { settleTempWorkspace, tempCleanupDue } from "../server/temp-workspace";
import { issueToken } from "../server/tokens";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { createdWorktree, ownedWorktree } from "../server/worktree-gc";

const dir = mkdtempSync(join(tmpdir(), "resume-cleanup-"));
const trees = join(dir, "trees");
mkdirSync(trees);
process.env.KANBAN_DATA_DIR = join(dir, "data");
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
process.env.KANBAN_WORKTREES_ROOT = trees;
mkdirSync(process.env.KANBAN_AGENTS_DIR);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const env = (id: string) => ({ PASEO_AGENT_ID: id });
let serial = 0;
const sent: string[] = [];

beforeEach(() => {
  getDb().exec("DELETE FROM tokens");
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { demo: "project-leader", other: "other-leader" } });
  setMissingCwdHooks({ listAgents: () => [] });
  sent.length = 0;
  setAgentAliveCheck(id => id === "project-leader" || id === "board-leader");
  setWakeSender((id, text) => { sent.push(`${id}\n${text}`); });
});
after(() => { resetMissingCwdForTests(); resetAgentAliveCheck(); setWakeSender(() => {}); closeDb(); rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = join(dir, `repo-${++serial}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "paseo-fleet contributors");
  git(root, "config", "user.email", "noreply@example.invalid");
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Base fixture");
  const task = createTask({ project: "demo", title: "Cleanup fixture", role: "executor", createdByAgent: "creator" });
  const branch = `kanban/${task.id}-cleanup`;
  const directory = join(trees, String(task.id));
  git(root, "worktree", "add", "-qb", branch, directory);
  const commits = ["Discarded documentation one", "Discarded documentation two"].map((subject, i) => {
    writeFileSync(join(directory, `doc-${i}.md`), `${subject}\n`);
    git(directory, "add", ".");
    git(directory, "-c", "core.hooksPath=/dev/null", "commit", "-qm", subject);
    return { sha: git(directory, "rev-parse", "HEAD"), subject };
  }).reverse();
  const workspaceId = `workspace-${task.id}`;
  getDb().prepare("UPDATE tasks SET status = 'done', workspace_path = ?, workspace_kind = 'worktree', workspace_base = 'main', paseo_workspace_id = ? WHERE id = ?").run(directory, workspaceId, task.id);
  appendEvent(task.id, "temp_workspace", null, null, "test", { root, base: "main" });
  appendEvent(task.id, "worktree_created", null, null, "test", { directory, branch, base: "main", root, temp: true, workspaceId });
  return { id: task.id, root, directory, branch, workspaceId, commits };
}
type Fixture = ReturnType<typeof fixture>;
const rows = (id: number, kind: string) => getDb().prepare("SELECT actor, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ actor: string; data_json: string }>;
async function settle(f: Fixture, archives: string[], beforeArchive?: () => void, options: { now?: Date; run?: GitRunner } = {}) {
  return settleTempWorkspace({ task: getTask(f.id), events: readCleanupEvents(f.id), now: options.now ?? new Date(), run: options.run,
    record: data => appendEvent(f.id, "cleanup", null, null, "kanban", data),
    decideWorkspace: async () => { beforeArchive?.(); return { action: "archive", workspaceId: f.workspaceId, directory: f.directory }; },
    archiveWorkspace: async id => { archives.push(id); },
  });
}
const grantFor = (f: Fixture) => discardAuthorization(getTask(f.id), ownedWorktree(f.id, createdWorktree(f.id))!);
function advanceTip(f: Fixture): string {
  const tip = git(f.root, "commit-tree", `${f.branch}^{tree}`, "-p", f.branch, "-m", "Later branch work");
  git(f.root, "update-ref", `refs/heads/${f.branch}`, tip);
  return tip;
}

it("lets the Kanban leader resume another project's stopped cleanup", async () => {
  const f = fixture();
  appendEvent(f.id, "cleanup", null, null, "kanban", { action: "skip_worktree", directory: f.directory, ok: false, reason: "not_merged", stopped: true, attempts: 12 });
  const result = await runKanban(["resume-cleanup", String(f.id)], env("board-leader")) as { resumed: number };
  assert.equal(result.resumed, 1);
});

it("still refuses an unrelated project leader and ordinary worker identities", async () => {
  const f = fixture();
  for (const caller of [env("other-leader"), { KANBAN_TOKEN: issueToken("executor", f.id, "worker") }, { KANBAN_TOKEN: issueToken("reviewer", f.id, "reviewer") }]) {
    await assert.rejects(runKanban(["resume-cleanup", String(f.id)], caller), { code: "forbidden" });
  }
  await assert.rejects(runKanban(["tag", String(f.id), "--tag", "example"], env("board-leader")), { code: "forbidden" });
});

it("keeps not_merged and all resources without the discard flag", async () => {
  const f = fixture();
  await runKanban(["resume-cleanup", String(f.id)], env("project-leader"));
  const archives: string[] = [];
  assert.equal(await settle(f, archives), "pending");
  assert.ok(readCleanupEvents(f.id).some(row => row.reason === "not_merged"));
  assert.ok(existsSync(f.directory));
  assert.equal(git(f.root, "rev-parse", f.branch), f.commits[0].sha);
  assert.deepEqual(archives, []);
});

for (const leader of ["project-leader", "board-leader"]) {
  it(`lists and audits exact commits, then cleans the worktree, branch and workspace for ${leader}`, async () => {
    const f = fixture();
    await settle(f, []); // A real not_merged failure/backoff must not prevent explicit discard.
    const result = await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env(leader)) as { text: string; commits: Fixture["commits"] };
    assert.deepEqual(result.commits, f.commits);
    for (const commit of f.commits) { assert.ok(result.text.includes(commit.sha)); assert.ok(result.text.includes(commit.subject)); }
    assert.ok(existsSync(f.directory), "CLI lists the plan before periodic cleanup executes");
    const authorized = rows(f.id, "cleanup_discard_authorized");
    assert.equal(authorized[0].actor, leader);
    assert.deepEqual(JSON.parse(authorized[0].data_json).commits, f.commits);
    assert.equal(tempCleanupDue(getTask(f.id), new Date()), true);
    const archives: string[] = [];
    assert.equal(await settle(f, archives), "settled", JSON.stringify(readCleanupEvents(f.id)));
    assert.equal(existsSync(f.directory), false);
    assert.equal(git(f.root, "branch", "--list", f.branch), "");
    assert.deepEqual(archives, [f.workspaceId]);
    const discarded = rows(f.id, "cleanup_discarded");
    assert.equal(discarded[0].actor, leader);
    assert.deepEqual(JSON.parse(discarded[0].data_json).commits, f.commits);
    assert.equal(JSON.parse(rows(f.id, "temp_workspace_cleaned")[0].data_json).keptBranch, false);
    // Restart after the discard receipt, before the final cleanup marks were persisted.
    getDb().prepare("DELETE FROM events WHERE task_id = ? AND (kind = 'temp_workspace_cleaned' OR (kind = 'cleanup' AND json_extract(data_json, '$.action') = 'delete_branch'))").run(f.id);
    assert.equal(await settle(f, archives), "settled");
    assert.equal(rows(f.id, "cleanup_discarded").length, 1, "no duplicate discard receipt");
    assert.deepEqual(archives, [f.workspaceId]);
  });
}

it("refuses discard for creators, foreign leaders, workers, card tokens and the anonymous shell", async () => {
  const f = fixture();
  saveConfig({ ...loadConfig(), supervisors: { ...loadConfig().supervisors, created: "creator" } });
  for (const caller of [env("creator"), env("other-leader"), {},
    { KANBAN_TOKEN: issueToken("executor", f.id, "project-leader") },
    { KANBAN_TOKEN: issueToken("reviewer", f.id, "board-leader") },
    { KANBAN_TOKEN: issueToken("supervisor", f.id, "board-leader") }]) {
    await assert.rejects(runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], caller), { code: "forbidden" });
  }
  assert.equal(rows(f.id, "cleanup_discard_authorized").length, 0);
  assert.ok(existsSync(f.directory));
});

it("does not promote a card-bound guest token into cleanup authority", async () => {
  const f = fixture();
  const caller = { KANBAN_TOKEN: issueToken("guest", f.id, "board-leader") };
  for (const suffix of [[], ["--discard-unmerged"]]) {
    await assert.rejects(runKanban(["resume-cleanup", String(f.id), ...suffix], caller), { code: "forbidden" });
  }
  assert.equal(rows(f.id, "cleanup_discard_authorized").length, 0);
});

it("refuses active cards, dirty copies and foreign checkouts before recording authorization", async () => {
  const f = fixture();
  const command = ["resume-cleanup", String(f.id), "--discard-unmerged"];
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(f.id);
  await assert.rejects(runKanban(command, env("project-leader")));
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.id);
  writeFileSync(join(f.directory, "unsaved.md"), "Keep me\n");
  await assert.rejects(runKanban(command, env("project-leader")));
  rmSync(join(f.directory, "unsaved.md"));
  git(f.directory, "switch", "-qc", "foreign");
  await assert.rejects(runKanban(command, env("project-leader")));
  assert.equal(rows(f.id, "cleanup_discard_authorized").length, 0);
});

it("does not discard a newer tip or uncommitted changes added after authorization", async () => {
  for (const change of ["commit", "dirty"]) {
    const f = fixture();
    await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("project-leader"));
    writeFileSync(join(f.directory, "later.md"), "Keep later work\n");
    if (change === "commit") { git(f.directory, "add", "."); git(f.directory, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Later work"); }
    const archives: string[] = [];
    assert.equal(await settle(f, archives), "pending");
    assert.ok(existsSync(f.directory));
    assert.deepEqual(archives, []);
    assert.equal(rows(f.id, "cleanup_discarded").length, 0);
    assert.equal(tempCleanupDue(getTask(f.id), new Date()), false, "changed approvals retain normal failure backoff");
  }
});

it("rechecks the authorized tip after awaited workspace inspection", async () => {
  const f = fixture();
  await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("project-leader"));
  const archives: string[] = [];
  assert.equal(await settle(f, archives, () => {
    git(f.directory, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Arrived during inspection");
  }), "pending");
  assert.deepEqual(archives, []);
  assert.ok(existsSync(f.directory));
});

it("documents the explicit discard flag in CLI help", () => { assert.ok(kanbanHelp().includes("--discard-unmerged")); });

it("keeps a shared copy and a busy agent's copy after discard authorization", async () => {
  const shared = fixture();
  const borrower = createTask({ project: "demo", title: "Shared fixture", role: "reviewer", workspacePath: shared.directory });
  getDb().prepare("UPDATE tasks SET paseo_workspace_id = ? WHERE id = ?").run(shared.workspaceId, borrower.id);
  await runKanban(["resume-cleanup", String(shared.id), "--discard-unmerged"], env("project-leader"));
  const archives: string[] = [];
  assert.equal(await settle(shared, archives), "pending");
  assert.ok(existsSync(shared.directory));
  assert.deepEqual(archives, []);

  const busy = fixture();
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("busy-worker", busy.id);
  appendEvent(busy.id, "agent_opened", null, null, "kanban", { agentId: "busy-worker" });
  await runKanban(["resume-cleanup", String(busy.id), "--discard-unmerged"], env("project-leader"));
  assert.equal(await settleTempWorkspace({ task: getTask(busy.id), events: readCleanupEvents(busy.id), now: new Date(),
    record: data => appendEvent(busy.id, "cleanup", null, null, "kanban", data),
    agentActivity: async () => "busy", decideWorkspace: async () => { throw new Error("Must not inspect while busy"); },
    archiveWorkspace: async () => { throw new Error("Must not archive while busy"); },
  }), "pending");
  assert.ok(existsSync(busy.directory));
});

it("does not reuse a grant across workspace generations or after a base change", async () => {
  for (const change of ["generation", "base"]) {
    const f = fixture();
    await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("project-leader"));
    if (change === "generation") appendEvent(f.id, "temp_workspace_recreated", null, null, "kanban", { directory: f.directory });
    else git(f.root, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Base advanced");
    assert.equal(await settle(f, []), "pending");
    assert.ok(existsSync(f.directory));
    assert.equal(rows(f.id, "cleanup_discarded").length, 0);
  }
});

it("rejects a value on the destructive flag without recording authorization", async () => {
  const f = fixture();
  await assert.rejects(runKanban(["resume-cleanup", String(f.id), "--discard-unmerged=false"], env("project-leader")), { code: "invalid" });
  assert.equal(rows(f.id, "cleanup_discard_authorized").length, 0);
});

it("performs approved no-PR cleanup through the normal periodic tick", async () => {
  const f = fixture();
  appendEvent(f.id, "cleanup", null, null, "kanban", { action: "skip_worktree", directory: f.directory, ok: false, reason: "no_pr" });
  const archives: string[] = [];
  await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("board-leader"));
  installCleanup({ archiveAgent: async () => {}, listAgents: async () => [],
    inspectAgent: async () => null,
    inspectWorkspace: async id => id === f.workspaceId ? { id, directory: f.directory, kind: "worktree", name: "Temporary fixture",
      projectRoot: f.root, projectId: null, archived: false } : null,
    archiveWorkspace: async id => { archives.push(id); },
  });
  try { await drainCleanups(new Date()); await flushCleanups(); } finally { installCleanup(null); }
  assert.ok(archives.includes(f.workspaceId));
  assert.equal(existsSync(f.directory), false);
  assert.equal(git(f.root, "branch", "--list", f.branch), "");
  assert.equal(rows(f.id, "cleanup_discarded").length, 1);
  assert.equal(rows(f.id, "temp_workspace_cleaned").length, 1);
});

it("deletes the audited tip after its copy is gone and the base advances", async () => {
  const f = fixture();
  await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("project-leader"));
  git(f.root, "worktree", "remove", f.directory);
  git(f.root, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Base advanced after removal");
  assert.equal(await settle(f, []), "settled");
  assert.equal(git(f.root, "branch", "--list", f.branch), "");
  assert.equal(rows(f.id, "cleanup_discarded").length, 1);
  assert.equal(JSON.parse(rows(f.id, "temp_workspace_cleaned")[0].data_json).keptBranch, false);
});

it("revokes a changed tip after removal, keeps the branch and wakes its project leader", async () => {
  const f = fixture();
  await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("project-leader"));
  git(f.root, "worktree", "remove", f.directory);
  const newer = advanceTip(f);
  assert.equal(await settle(f, []), "settled");
  assert.equal(git(f.root, "rev-parse", f.branch), newer);
  assert.equal(grantFor(f), null);
  assert.equal(rows(f.id, "cleanup_discard_revoked").length, 1);
  assert.equal(rows(f.id, "cleanup_discarded").length, 0);
  assert.equal(JSON.parse(rows(f.id, "temp_workspace_cleaned")[0].data_json).keptBranch, true);
  assert.ok(readCleanupEvents(f.id).some(row => row.action === "keep_branch" && row.ok));
  assert.equal(JSON.parse(rows(f.id, "wake_branch_kept")[0].data_json).agentId, "project-leader");
  assert.equal(sent.filter(text => text.startsWith("project-leader\n")).length, 1);
  // A crash before the final mark must not revive the revoked grant, even if the old tip returns.
  getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'temp_workspace_cleaned'").run(f.id);
  git(f.root, "update-ref", `refs/heads/${f.branch}`, f.commits[0].sha);
  assert.equal(await settle(f, []), "settled");
  assert.equal(git(f.root, "rev-parse", f.branch), f.commits[0].sha);
  assert.equal(grantFor(f), null);
  assert.equal(rows(f.id, "wake_branch_kept").length, 1);
});

it("retries a real ref lock after dropping the copy even when the base advances", async () => {
  const f = fixture();
  await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("project-leader"));
  const lock = join(f.root, ".git", `${`refs/heads/${f.branch}`}.lock`);
  writeFileSync(lock, "");
  const now = Date.now();
  assert.equal(await settle(f, [], undefined, { now: new Date(now) }), "pending");
  assert.equal(existsSync(f.directory), false);
  assert.ok(readCleanupEvents(f.id).some(row => row.action === "drop_directory" && row.ok));
  assert.equal(tempCleanupDue(getTask(f.id), new Date(now + 1)), false);
  rmSync(lock);
  git(f.root, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Base advanced during retry");
  assert.equal(await settle(f, [], undefined, { now: new Date(now + 61_000) }), "settled");
  assert.equal(git(f.root, "branch", "--list", f.branch), "");
  assert.equal(rows(f.id, "cleanup_discarded").length, 1);
});

it("settles with a revoked grant, kept branch and leader wake after bounded deletion failures", async () => {
  const f = fixture();
  await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("project-leader"));
  const lock = join(f.root, ".git", `${`refs/heads/${f.branch}`}.lock`);
  writeFileSync(lock, "");
  const now = Date.now();
  let attempts = 0;
  const run: GitRunner = (cwd, args) => { if (args[0] === "update-ref") attempts += 1; return runGit(cwd, args); };
  for (let i = 0; i < DELETE_BRANCH_RETRY_LIMIT; i += 1) {
    assert.equal(await settle(f, [], undefined, { now: new Date(now + i * 24 * 60 * 60_000), run }),
      i === DELETE_BRANCH_RETRY_LIMIT - 1 ? "settled" : "pending");
    if (i === 0) git(f.root, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Base advanced while locked");
  }
  rmSync(lock);
  assert.equal(attempts, DELETE_BRANCH_RETRY_LIMIT);
  assert.equal(grantFor(f), null);
  assert.equal(git(f.root, "rev-parse", f.branch), f.commits[0].sha);
  assert.equal(JSON.parse(rows(f.id, "temp_workspace_cleaned")[0].data_json).keptBranch, true);
  assert.equal(rows(f.id, "cleanup_discard_revoked").length, 1);
  assert.equal(JSON.parse(rows(f.id, "wake_branch_kept")[0].data_json).agentId, "project-leader");
  assert.equal(await settle(f, [], undefined, { now: new Date(now + 20 * 24 * 60 * 60_000), run }), "settled");
  assert.equal(attempts, DELETE_BRANCH_RETRY_LIMIT);
});

it("does not discard a tip that changes between inspection and compare-and-delete", async () => {
  const f = fixture();
  await runKanban(["resume-cleanup", String(f.id), "--discard-unmerged"], env("project-leader"));
  let newer = "";
  const run: GitRunner = (cwd, args) => {
    if (args[0] === "update-ref" && !newer) newer = advanceTip(f);
    return runGit(cwd, args);
  };
  const now = Date.now();
  assert.equal(await settle(f, [], undefined, { now: new Date(now), run }), "pending");
  assert.equal(existsSync(f.directory), false);
  assert.equal(git(f.root, "rev-parse", f.branch), newer);
  assert.equal(await settle(f, [], undefined, { now: new Date(now + 61_000), run }), "settled");
  assert.equal(git(f.root, "rev-parse", f.branch), newer);
  assert.equal(grantFor(f), null);
  assert.equal(rows(f.id, "cleanup_discarded").length, 0);
  assert.equal(rows(f.id, "wake_branch_kept").length, 1);
});
