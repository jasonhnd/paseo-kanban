import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { runKanban } from "../server/cli";
import { loadConfig, projectWorkspace, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { runDoctor } from "../server/doctor";
import { collectLiveSources } from "../server/doctor-live";
import { inspectMissingLand, recordMissingLandSettlement } from "../server/missing-land";
import { runGit } from "../server/git";
import { pendingLand, recordLandPending, workspaceHeldForLand } from "../server/land-pending";
import { appendEvent, createTask, getTask } from "../server/store";
import { landLocalBranch, resumePendingLands } from "../server/temp-land";
import { issueToken } from "../server/tokens";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { setLanguage } from "../shared/i18n";

const dir = mkdtempSync(join(tmpdir(), "missing-land-"));
const trees = join(dir, "trees");
mkdirSync(trees);
process.env.KANBAN_DATA_DIR = join(dir, "data");
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
process.env.KANBAN_WORKTREES_ROOT = trees;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const rows = (id: number, kind: string) => getDb().prepare("SELECT actor, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ actor: string; data_json: string }>;
let serial = 0;
const sent: string[] = [];
beforeEach(() => {
  getDb().exec("DELETE FROM events; DELETE FROM tasks; DELETE FROM tokens");
  saveConfig({ ...loadConfig(), supervisorAgentId: "board-leader", supervisors: { demo: "project-leader", other: "other-leader" } });
  setLanguage("en");
  setAgentAliveCheck(id => id === "project-leader" || id === "board-leader");
  sent.length = 0;
  setWakeSender((id, text) => { sent.push(`${id}\n${text}`); });
});
after(() => { resetAgentAliveCheck(); setWakeSender(() => {}); closeDb(); rmSync(dir, { recursive: true, force: true }); });

async function fixture(ownCommit = true) {
  const root = join(dir, `repo-${++serial}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "paseo-fleet contributors");
  git(root, "config", "user.email", "noreply@example.invalid");
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Base fixture");
  const task = createTask({ project: "demo", title: "Missing landing fixture", role: "batch", createdByAgent: "creator" });
  const branch = `kanban/${task.id}-landing`;
  const directory = join(trees, String(serial));
  git(root, "worktree", "add", "-qb", branch, directory);
  if (ownCommit) {
    writeFileSync(join(directory, "change.txt"), "card content\n");
    git(directory, "add", ".");
    git(directory, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Card content");
  }
  const head = git(directory, "rev-parse", "HEAD");
  const workspaceId = `workspace-${serial}`;
  getDb().prepare("UPDATE tasks SET status = 'archived', workspace_path = ?, workspace_kind = 'worktree', workspace_base = 'main', paseo_workspace_id = ? WHERE id = ?").run(directory, workspaceId, task.id);
  const owned = { root, directory, branch, base: "main" };
  appendEvent(task.id, "temp_workspace", null, null, "test", owned);
  appendEvent(task.id, "worktree_created", null, null, "test", { ...owned, temp: true, workspaceId });
  writeFileSync(join(root, "scratch.txt"), "main stays dirty\n");
  const result = await landLocalBranch(getTask(task.id), owned, "test");
  assert.equal(result.kind, "pending");
  if (result.kind !== "pending") throw new Error("Expected queued landing");
  recordLandPending(task.id, "archived", "test", result);
  return { ...owned, id: task.id, head, workspaceId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function disappear(f: Fixture) {
  git(f.root, "worktree", "remove", f.directory);
  // Simulate an external deletion inside the disposable fixture only.
  git(f.root, "update-ref", "-d", `refs/heads/${f.branch}`);
}
async function finding(f: Fixture, branches: () => Promise<string[]> = async () => git(f.root, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n")) {
  const report = await runDoctor({ persist: false, now: new Date(Date.now() + 60 * 60_000), sources: {
    workspaces: [], agents: { agents: [] }, dirs: { root: trees, list: () => [], placeholderAgents: () => null, worktrees: [], scanned: true },
    git: { repos: [f.root], worktrees: async () => [], branches, dirty: async () => false, pushed: async () => false, pr: async () => "none" },
  } });
  return report.findings.find(row => row.id === `card:land:${f.id}`);
}
const settle = (f: Fixture, who = "project-leader", reason = "Installation-only card; release content was checked separately.") => runKanban(["resume-cleanup", String(f.id), "--settle-missing-land", "--reason", reason], { PASEO_AGENT_ID: who });

async function liveGit() {
  const sources = await collectLiveSources(null, Date.now(), Date.now() + 20_000);
  assert.ok(sources.git, "the live collector must supply Git reads");
  return sources.git;
}

it("live doctor lists checked-out and idle branches despite display settings and same-named tags", async () => {
  const f = await fixture();
  const idle = "kanban/demo-idle";
  const current = "kanban/demo-current";
  git(f.root, "branch", idle);
  git(f.root, "checkout", "-qb", current);
  git(f.root, "tag", f.branch);
  assert.match(git(f.root, "-c", "color.ui=false", "-c", "column.branch=never", "branch", "--list", f.branch), /^\+ /);
  git(f.root, "config", "color.ui", "always");
  git(f.root, "config", "column.branch", "always");
  const inventory = await liveGit();
  assert.deepEqual((await inventory.branches(f.root)).sort(), [f.branch, idle, current].sort());
  assert.equal(git(f.directory, "symbolic-ref", "HEAD"), `refs/heads/${f.branch}`);
});

it("live doctor uses the recorded project repo and queued work lands after its main directory is cleaned", async () => {
  const f = await fixture();
  const board = join(dir, `board-${serial}`);
  mkdirSync(board);
  git(board, "init", "-q", "-b", "main");
  // Configuration and process cwd point elsewhere; the worktree event owns the landing repo.
  const config = loadConfig();
  saveConfig({ ...config, projects: { demo: { ...projectWorkspace("demo", config), workspacePath: board } } });
  const cwd = process.cwd();
  process.chdir(board);
  try {
    const inventory = await liveGit();
    assert.ok(inventory.repos.includes(board));
    assert.ok(inventory.repos.includes(f.root));
    assert.deepEqual(await inventory.branches(board), []);
    await resumePendingLands();
    assert.equal(pendingLand(f.id)?.mainDirty, true);
    assert.equal(pendingLand(f.id)?.missingBranch, undefined);
    assert.equal((await inspectMissingLand(f, pendingLand(f.id)!)).kind, "present");
    await assert.rejects(settle(f), { code: "invalid" });
    const hit = await finding(f, () => inventory.branches(f.root));
    assert.equal(hit?.severity, "yellow");
    assert.match(hit?.suggestion ?? "", /once the main directory is clean/);
    assert.doesNotMatch(`${hit?.symptom} ${hit?.evidence} ${hit?.suggestion}`, /stopped|branch is missing|settle-missing-land/i);
    assert.equal(rows(f.id, "land_settled").length, 0);
    assert.equal(sent.length, 0);
    rmSync(join(f.root, "scratch.txt"));
    await resumePendingLands();
    assert.equal(pendingLand(f.id), null);
    assert.equal(git(f.root, "rev-parse", "main"), f.head);
    assert.equal(git(f.directory, "symbolic-ref", "HEAD"), `refs/heads/${f.branch}`);
    assert.equal(rows(f.id, "landed").length, 1);
    assert.equal(rows(f.id, "land_settled").length, 0);
    assert.equal(await finding(f, () => inventory.branches(f.root)), undefined);
  } finally {
    process.chdir(cwd);
    saveConfig(config);
  }
});

it("live doctor still reports a truly missing branch while the pending queue is read-only", async () => {
  const f = await fixture();
  disappear(f);
  const inventory = await liveGit();
  const before = rows(f.id, "land_pending");
  const hit = await finding(f, () => inventory.branches(f.root));
  assert.equal(hit?.severity, "red");
  assert.match(hit?.suggestion ?? "", /settle-missing-land/);
  assert.deepEqual(rows(f.id, "land_pending"), before);
  assert.equal(rows(f.id, "land_settled").length, 0);
});

it("captures the queued branch tip even while the main directory is dirty", async () => {
  const f = await fixture();
  assert.equal((pendingLand(f.id) as { head?: string })?.head, f.head);
});
it("settles an archived missing branch with no own commits and releases the landing hold", async () => {
  const f = await fixture(false);
  disappear(f);
  await resumePendingLands();
  assert.equal(pendingLand(f.id), null);
  assert.equal(workspaceHeldForLand(f.workspaceId), false);
  assert.equal(rows(f.id, "landed").length, 0);
  const receipt = JSON.parse(rows(f.id, "land_settled")[0]?.data_json ?? "{}");
  assert.equal(receipt.mode, "retained");
  assert.equal(receipt.head, f.head);
  assert.equal(receipt.retainedBy, "refs/heads/main");
  assert.equal(await finding(f), undefined);
  await resumePendingLands();
  assert.equal(rows(f.id, "land_settled").length, 1);
});
for (const ref of ["refs/heads/retained", "refs/remotes/origin/retained", "refs/tags/retained"]) {
  it(`settles a missing branch whose queued commits survive in ${ref}`, async () => {
    const f = await fixture();
    git(f.root, "update-ref", ref, f.head);
    disappear(f);
    await resumePendingLands();
    assert.equal(pendingLand(f.id), null);
    assert.equal(JSON.parse(rows(f.id, "land_settled")[0].data_json).retainedBy, ref);
    assert.match(git(f.root, "status", "--porcelain"), /scratch.txt/);
  });
}
it("stops a missing branch with unretained commits, wakes once, and doctor gives recovery advice", async () => {
  const f = await fixture();
  disappear(f);
  // A prior conflict notification must not suppress this distinct missing-branch wake.
  appendEvent(f.id, "wake_land", null, null, "test", { agentId: "project-leader", delivered: true });
  await resumePendingLands();
  await resumePendingLands();
  assert.ok(pendingLand(f.id));
  assert.equal(rows(f.id, "land_settled").length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /project-leader/);
  assert.match(sent[0], /settle-missing-land/);
  assert.equal(rows(f.id, "land_pending").length, 2, "unchanged evidence must not append on every tick");
  const hit = await finding(f);
  assert.equal(hit?.severity, "red");
  assert.match(hit?.suggestion ?? "", /settle-missing-land/);
  assert.doesNotMatch(hit?.suggestion ?? "", /once the main directory is clean/);
});
it("does not guess a historical tip from the creation base", async () => {
  const f = await fixture(false);
  getDb().prepare("UPDATE events SET data_json = json_remove(data_json, '$.head') WHERE task_id = ? AND kind = 'land_pending'").run(f.id);
  disappear(f);
  await resumePendingLands();
  assert.ok(pendingLand(f.id));
  assert.equal(rows(f.id, "land_settled").length, 0);
  assert.match(sent[0], /tip|commit/i);
});
it("normal queued landing still waits for a clean main directory then lands", async () => {
  const f = await fixture();
  await resumePendingLands();
  assert.ok(pendingLand(f.id));
  assert.equal(rows(f.id, "land_settled").length, 0);
  assert.equal(sent.length, 0);
  assert.match((await finding(f))?.suggestion ?? "", /once the main directory is clean/);
  rmSync(join(f.root, "scratch.txt"));
  await resumePendingLands();
  assert.equal(pendingLand(f.id), null);
  assert.equal(git(f.root, "rev-parse", "main"), f.head);
  assert.equal(rows(f.id, "landed").length, 1);
});
it("doctor detects a missing historical branch before the scheduler runs", async () => {
  const f = await fixture();
  disappear(f);
  const hit = await finding(f);
  assert.equal(hit?.severity, "red");
  assert.match(hit?.suggestion ?? "", /settle-missing-land/);
  assert.equal(rows(f.id, "land_pending").length, 1, "doctor is read-only");
});
it("doctor does not mistake a failed branch listing for a missing branch", async () => {
  const f = await fixture();
  const hit = await finding(f, async () => { throw new Error("Git listing unavailable"); });
  assert.doesNotMatch(hit?.suggestion ?? "", /--settle-missing-land/);
  assert.match(hit?.suggestion ?? "", /confirm|inspect|read/i);
});
for (const who of ["project-leader", "board-leader"]) {
  it(`allows ${who} to settle a missing historical queue with an audited reason`, async () => {
    const f = await fixture();
    getDb().prepare("UPDATE events SET data_json = json_remove(data_json, '$.head') WHERE task_id = ? AND kind = 'land_pending'").run(f.id);
    disappear(f);
    await settle(f, who);
    assert.equal(pendingLand(f.id), null);
    const receipt = rows(f.id, "land_settled")[0];
    assert.equal(receipt.actor, who);
    const data = JSON.parse(receipt.data_json);
    assert.equal(data.mode, "leader");
    assert.match(data.reason, /Installation-only/);
    assert.equal(data.head, null);
    assert.equal(data.branch, f.branch);
    assert.equal(rows(f.id, "landed").length, 0);
  });
}
it("audits the unretained commit when the leader explicitly settles", async () => {
  const f = await fixture();
  disappear(f);
  await settle(f);
  const data = JSON.parse(rows(f.id, "land_settled")[0].data_json);
  assert.equal(data.head, f.head);
  assert.equal(data.commits[0].sha, f.head);
  assert.equal(data.commits[0].subject, "Card content");
});
it("refuses creators, unrelated leaders, anonymous shells and card tokens", async () => {
  const f = await fixture();
  disappear(f);
  const token = issueToken("executor", f.id, "project-leader");
  for (const caller of [{ PASEO_AGENT_ID: "creator" }, { PASEO_AGENT_ID: "other-leader" }, {}, { KANBAN_TOKEN: token }]) {
    await assert.rejects(runKanban(["resume-cleanup", String(f.id), "--settle-missing-land", "--reason", "Checked"], caller), { code: "forbidden" });
  }
  assert.ok(pendingLand(f.id));
  assert.equal(rows(f.id, "land_settled").length, 0);
});
it("refuses an existing branch, active card, missing reason or mixed destructive flags", async () => {
  const f = await fixture();
  await assert.rejects(settle(f), { code: "invalid" });
  disappear(f);
  for (const suffix of [["--settle-missing-land"], ["--settle-missing-land=false", "--reason", "Checked"], ["--settle-missing-land", "--discard-unmerged", "--reason", "Checked"], ["--reason", "Checked"]]) {
    await assert.rejects(runKanban(["resume-cleanup", String(f.id), ...suffix], { PASEO_AGENT_ID: "project-leader" }), { code: "invalid" });
  }
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(f.id);
  await assert.rejects(settle(f), { code: "invalid" });
  assert.equal(rows(f.id, "land_settled").length, 0);
});
it("resumes normal landing when the missing branch is restored", async () => {
  const f = await fixture();
  disappear(f);
  await resumePendingLands();
  git(f.root, "update-ref", `refs/heads/${f.branch}`, f.head);
  rmSync(join(f.root, "scratch.txt"));
  await resumePendingLands();
  assert.equal(pendingLand(f.id), null);
  assert.equal(git(f.root, "rev-parse", "main"), f.head);
  assert.equal(rows(f.id, "landed").length, 1);
});

it("rechecks the tip even when the dirty-main reason has not changed", async () => {
  const f = await fixture();
  writeFileSync(join(f.directory, "later.txt"), "later card work\n");
  git(f.directory, "add", ".");
  git(f.directory, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Later card content");
  const later = git(f.directory, "rev-parse", "HEAD");
  await resumePendingLands();
  assert.equal(pendingLand(f.id)?.head, later);
  git(f.root, "update-ref", "refs/heads/old-snapshot", f.head);
  disappear(f);
  await resumePendingLands();
  assert.ok(pendingLand(f.id), "retention of an older snapshot cannot settle the latest tip");
  assert.equal(rows(f.id, "land_settled").length, 0);
});
it("accepts ancestry through an annotated tag and keeps its exact peeled OID in the audit", async () => {
  const f = await fixture();
  const child = git(f.root, "commit-tree", `${f.head}^{tree}`, "-p", f.head, "-m", "Retaining descendant");
  git(f.root, "tag", "-a", "retained-descendant", child, "-m", "Retains card history");
  disappear(f);
  await resumePendingLands();
  assert.equal(pendingLand(f.id), null);
  const data = JSON.parse(rows(f.id, "land_settled")[0].data_json);
  assert.equal(data.retainedBy, "refs/tags/retained-descendant");
  assert.equal(data.retainedOid, child);
});
it("keeps a dirty surviving copy even when the queued commit is retained", async () => {
  const f = await fixture(false);
  git(f.directory, "checkout", "--detach");
  writeFileSync(join(f.directory, "uncommitted.txt"), "keep this work\n");
  git(f.root, "update-ref", "-d", `refs/heads/${f.branch}`);
  await resumePendingLands();
  assert.ok(pendingLand(f.id));
  assert.equal(rows(f.id, "land_settled").length, 0);
  assert.match(sent[0], /copy|dirty/i);
});
it("an older settled queue cannot hide a later pending landing", async () => {
  const f = await fixture(false);
  disappear(f);
  await resumePendingLands();
  assert.equal(pendingLand(f.id), null);
  recordLandPending(f.id, "archived", "test", { reason: "A new landing attempt", branch: f.branch, base: f.base });
  assert.ok(pendingLand(f.id));
  assert.ok(await finding(f));
});

it("does not treat a failed ref read as confirmed branch absence", async () => {
  const f = await fixture();
  const inspection = await inspectMissingLand(f, pendingLand(f.id)!, async () => ({ code: 128, stdout: "", stderr: "Cannot read repository" }));
  assert.equal(inspection.kind, "error");
  assert.equal(rows(f.id, "land_settled").length, 0);
});
it("rejects automatic settlement when the branch or retaining ref changes after inspection", async () => {
  const f = await fixture(false);
  disappear(f);
  const pending = pendingLand(f.id)!;
  const inspection = await inspectMissingLand(f, pending);
  assert.equal(inspection.kind, "missing");
  if (inspection.kind !== "missing") throw new Error("Expected missing branch");
  git(f.root, "update-ref", `refs/heads/${f.branch}`, f.head);
  assert.equal(recordMissingLandSettlement(getTask(f.id), pending, f, inspection, "test"), false);
  git(f.root, "update-ref", "-d", `refs/heads/${f.branch}`);
  const other = git(f.root, "commit-tree", `${f.head}^{tree}`, "-m", "Unrelated root");
  git(f.root, "update-ref", "refs/heads/main", other);
  assert.equal(recordMissingLandSettlement(getTask(f.id), pending, f, inspection, "test"), false);
  assert.ok(pendingLand(f.id));
});
it("a failed retention listing cannot prove that a missing branch is safe", async () => {
  const f = await fixture(false);
  disappear(f);
  const inspection = await inspectMissingLand(f, pendingLand(f.id)!, async (cwd, args) => args[0] === "for-each-ref"
    ? { code: 128, stdout: "", stderr: "Cannot list refs" } : runGit(cwd, args));
  assert.equal(inspection.kind, "missing");
  if (inspection.kind === "missing") assert.equal(inspection.retainedBy, null);
});
it("records a new landed receipt when an older landed event predates a new queue", async () => {
  const f = await fixture();
  appendEvent(f.id, "landed", null, null, "test", { branch: f.branch, base: f.base });
  recordLandPending(f.id, "archived", "test", { reason: "Queued again", branch: f.branch, base: f.base, head: f.head });
  assert.ok(pendingLand(f.id));
  rmSync(join(f.root, "scratch.txt"));
  await resumePendingLands();
  assert.equal(pendingLand(f.id), null);
  assert.equal(rows(f.id, "landed").length, 2);
});
it("a scheduler write from an inspected old queue cannot resurrect a leader settlement", async () => {
  const f = await fixture();
  disappear(f);
  const inspected = pendingLand(f.id)!;
  await settle(f);
  assert.equal(recordLandPending(f.id, "archived", "scheduler", { ...inspected, reason: "Late missing-branch result", missingBranch: true }, inspected.eventId), false);
  assert.equal(pendingLand(f.id), null);
  assert.equal(rows(f.id, "land_pending").length, 1);
});
