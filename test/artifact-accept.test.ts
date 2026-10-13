/// <reference types="node" />
import { zhCN, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { ARTIFACT_KEEP_BRANCH } from "../server/artifact-accept";
import { readCleanupEvents } from "../server/archive-book";
import { cardMark } from "../server/card-ref";
import { setProjectCode } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { KanbanError } from "../server/errors";
import { acceptTask } from "../server/flow";
import { appendEvent, createTask, getTask } from "../server/store";
import { settleTempWorkspace } from "../server/temp-workspace";
import { tempBranchName } from "../server/workspace";
import { runKanban } from "./helpers/compat-cli";

const rootTmp = mkdtempSync(join(tmpdir(), "artifact-accept-"));
const dir = join(rootTmp, "data");
const agents = join(dir, "agents");
const trees = join(dir, "worktrees");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agents;
process.env.KANBAN_WORKTREES_ROOT = trees;
mkdirSync(agents, { recursive: true });
mkdirSync(trees, { recursive: true });
setProjectCode("demo", "DEMO");
setProjectCode("elsewhere", "TEST");

after(() => {
  closeDb();
  rmSync(rootTmp, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || stdout || err.message));
      else resolveOut(String(stdout));
    });
  });
}

async function initRepo(name: string): Promise<string> {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "README"), "base\n");
  await git(root, ["add", "README"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

interface Card {
  id: number;
  branch: string;
  directory: string;
  root: string;
  sha: string;
  tree: string;
}

function rememberTemp(id: number, root: string, branch: string, directory: string): void {
  getDb()
    .prepare("UPDATE tasks SET workspace_kind = 'worktree', workspace_base = 'main', workspace_path = ?, status = 'acceptance' WHERE id = ?")
    .run(directory, id);
  appendEvent(id, "temp_workspace", null, null, "test", { name: "copy", root, base: "main" });
  appendEvent(id, "worktree_created", null, null, "test", { directory, branch, base: "main", root, temp: true });
}

async function addCard(root: string, title: string, body: string, role = "executor"): Promise<Card> {
  const task = createTask({ project: "demo", title, role, workspacePath: root, brief: "demo fixture" });
  const branch = tempBranchName(cardMark(task.id), title);
  const directory = join(trees, `${title}-${task.id}`);
  await git(root, ["worktree", "add", "-b", branch, directory, "main"]);
  writeFileSync(join(directory, "README"), body);
  await git(directory, ["add", "README"]);
  await git(directory, ["commit", "-m", title]);
  rememberTemp(task.id, root, branch, directory);
  if (role === "executor") appendEvent(task.id, "approve", "reviewing", "acceptance", "reviewer", { summary: "checked" });
  const sha = (await git(root, ["rev-parse", `refs/heads/${branch}`])).trim();
  const tree = (await git(root, ["rev-parse", `${sha}^{tree}`])).trim();
  return { id: task.id, branch, directory, root, sha, tree };
}

async function moveMain(root: string, body: string): Promise<string> {
  writeFileSync(join(root, "README"), body);
  await git(root, ["add", "README"]);
  await git(root, ["commit", "-m", "main move"]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

function events(id: number): Array<{ kind: string; data_json: string }> {
  return getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? ORDER BY id").all(id) as Array<{ kind: string; data_json: string }>;
}

function artifactEvent(id: number): { sha?: string; tree?: string; evidenceKind?: string; evidence?: string; evidencePath?: string; evidenceSha256?: string; reason?: string; branch?: string; base?: string } {
  const row = [...events(id)].reverse().find((item) => item.kind === "artifact_accepted");
  assert.ok(row, "artifact_accepted event");
  return JSON.parse(row.data_json) as { sha?: string; tree?: string; evidenceKind?: string; evidence?: string; evidencePath?: string; evidenceSha256?: string; reason?: string; branch?: string; base?: string };
}

async function untouched(card: Card, main: string): Promise<void> {
  assert.equal((await git(card.root, ["rev-parse", "HEAD"])).trim(), main);
  assert.equal((await git(card.root, ["rev-parse", `refs/heads/${card.branch}`])).trim(), card.sha);
  const common = resolve(card.directory, (await git(card.directory, ["rev-parse", "--git-common-dir"])).trim());
  assert.equal(existsSync(join(common, "rebase-merge")), false);
  assert.equal(existsSync(join(common, "MERGE_HEAD")), false);
  assert.equal((await git(card.root, ["status", "--porcelain"])).trim(), "");
}

function comment(id: number): string {
  const row = getDb().prepare("SELECT body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id) as { body: string };
  return row.body;
}

async function settle(card: Card, now = new Date()): Promise<"settled" | "pending"> {
  const task = getTask(card.id);
  const cleanup = readCleanupEvents(card.id);
  return settleTempWorkspace({
    task,
    events: cleanup,
    now,
    record(data) {
      appendEvent(card.id, "cleanup", null, null, "test", data);
      cleanup.push({ ...data, at: now.toISOString() });
    },
    agentActivity: async () => "gone",
    async archiveWorkspace() {},
    decideWorkspace: async () => ({ action: "skip", reason: "none" }),
  });
}

describe("artifact acceptance", { concurrency: 1 }, () => {
  it("records the commit and leaves a divergent no-origin main untouched", async () => {
    const root = await initRepo("sha-root");
    const card = await addCard(root, "sha-card", "from-card\n");
    const main = await moveMain(root, "from-main\n");
    const accepted = await acceptTask(card.id, "supervisor", { artifact: card.sha });
    assert.equal(accepted.status, "done");
    assert.equal(accepted.artifact?.sha, card.sha);
    assert.equal(accepted.artifact?.tree, card.tree);
    assert.equal(getTask(card.id).status, "done");
    await untouched(card, main);
    const data = artifactEvent(card.id);
    assert.equal(data.sha, card.sha);
    assert.equal(data.tree, card.tree);
    assert.equal(data.evidenceKind, "commit");
    assert.equal(data.branch, card.branch);
    assert.equal(data.base, "main");
    assert.equal(events(card.id).some((row) => row.kind === "landed" || row.kind === "land_conflict"), false);
    assert.equal(comment(card.id), zhCN("flow.accept.artifact", { sha: card.sha, tree: card.tree }));
    const viaCli = await addCard(root, "cli-card", "from-cli\n");
    const cli = (await runKanban(["accept", String(viaCli.id), "--artifact", viaCli.sha.slice(0, 12)], {})) as { status: string; artifact?: { sha: string } };
    assert.equal(cli.status, "done");
    assert.equal(cli.artifact?.sha, viaCli.sha);
    assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), main);
    assert.equal((await git(root, ["rev-parse", `refs/heads/${viaCli.branch}`])).trim(), viaCli.sha);
  });

  it("accepts a file that names the tip and a bundle of that tip", async () => {
    const root = await initRepo("file-root");
    const fileCard = await addCard(root, "file-card", "from-file\n");
    const bundleCard = await addCard(root, "bundle-card", "from-bundle\n");
    const main = await moveMain(root, "from-main-file\n");
    const evidence = join(dir, "file-evidence.txt");
    writeFileSync(evidence, `checked\n${fileCard.sha}\n`);
    const accepted = await acceptTask(fileCard.id, "supervisor", { artifact: evidence });
    assert.equal(accepted.status, "done");
    const data = artifactEvent(fileCard.id);
    assert.equal(data.sha, fileCard.sha);
    assert.equal(data.evidenceKind, "file");
    assert.equal(data.evidenceSha256, createHash("sha256").update(`checked\n${fileCard.sha}\n`).digest("hex"));
    assert.equal(data.evidencePath, resolve(evidence));
    assert.equal(comment(fileCard.id).includes(evidence), false);
    await untouched(fileCard, main);
    const bundle = join(dir, "tip.bundle");
    await git(root, ["bundle", "create", bundle, `refs/heads/${bundleCard.branch}`]);
    const bundled = await acceptTask(bundleCard.id, "supervisor", { artifact: bundle });
    assert.equal(bundled.status, "done");
    assert.equal(artifactEvent(bundleCard.id).sha, bundleCard.sha);
    assert.equal(artifactEvent(bundleCard.id).evidenceKind, "file");
    await untouched(bundleCard, main);
  });

  it("requires a reason for a pull request and binds the local tip without a network call", async () => {
    const root = await initRepo("pr-root");
    const card = await addCard(root, "pr-card", "from-pr\n");
    const main = await moveMain(root, "from-main-pr\n");
    const url = "https://github.com/example/widgets/pull/7";
    await assert.rejects(() => acceptTask(card.id, "supervisor", { artifact: url }), new RegExp(localePattern(zhCN("artifactAccept.prReason"))));
    assert.equal(getTask(card.id).status, "acceptance");
    await untouched(card, main);
    const accepted = await acceptTask(card.id, "supervisor", { artifact: url, reason: "checked the diff and the tree" });
    assert.equal(accepted.status, "done");
    const data = artifactEvent(card.id);
    assert.equal(data.evidenceKind, "pull_request");
    assert.equal(data.evidence, url);
    assert.equal(data.reason, "checked the diff and the tree");
    assert.equal(data.sha, card.sha);
    assert.equal(data.tree, card.tree);
    assert.equal(data.evidencePath, undefined);
    await untouched(card, main);
  });

  it("keeps ordinary accept on the land path when the repository has no remote", async () => {
    const root = await initRepo("land-root");
    const pending = await addCard(root, "pending-card", "from-pending\n");
    const landed = await addCard(root, "landed-card", "from-landed\n");
    const main = await moveMain(root, "from-main-land\n");
    await assert.rejects(() => runKanban(["accept", String(pending.id), "--no-land"], {}), new RegExp(localePattern(zhCN("cli.unknownArgument", { argument: "--no-land" }))));
    assert.equal(getTask(pending.id).status, "acceptance");
    await assert.rejects(() => runKanban(["accept", String(landed.id), "--reason", "a note is not artifact evidence"], {}), new RegExp(localePattern(zhCN("tempLand.conflict.withMain").slice(0, 8))));
    assert.equal(getTask(landed.id).status, "rework");
    assert.equal(events(landed.id).some((row) => row.kind === "land_conflict"), true);
    assert.equal(events(landed.id).some((row) => row.kind === "artifact_accepted"), false);
    assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), main);
    assert.equal((await git(root, ["rev-parse", `refs/heads/${landed.branch}`])).trim(), landed.sha);
    assert.equal(getTask(pending.id).status, "acceptance");
  });

  it("rejects missing evidence, a credential, the wrong commit, and a non-file", async () => {
    const root = await initRepo("reject-root");
    const card = await addCard(root, "reject-card", "from-reject\n");
    const main = await moveMain(root, "from-main-reject\n");
    const token = ["ghp", "a".repeat(20)].join("_");
    await assert.rejects(() => runKanban(["accept", String(card.id), "--artifact"], {}), new RegExp(localePattern(zhCN("artifactAccept.missing"))));
    await assert.rejects(() => acceptTask(card.id, "supervisor", { artifact: card.sha, reason: token }), (err: unknown) => {
      assert.ok(err instanceof KanbanError);
      assert.equal(err.message.includes(token), false);
      assert.match(err.message, new RegExp(localePattern(zhCN("artifactAccept.secret"))));
      return true;
    });
    const mainSha = (await git(root, ["rev-parse", "HEAD"])).trim();
    await assert.rejects(() => acceptTask(card.id, "supervisor", { artifact: mainSha }), new RegExp(localePattern(zhCN("artifactAccept.shaMismatch", { sha: card.sha }))));
    const empty = join(dir, "empty-evidence.txt");
    writeFileSync(empty, "");
    await assert.rejects(() => acceptTask(card.id, "supervisor", { artifact: empty }), new RegExp(localePattern(zhCN("artifactAccept.emptyFile"))));
    await assert.rejects(() => acceptTask(card.id, "supervisor", { artifact: dir }), new RegExp(localePattern(zhCN("artifactAccept.notFile"))));
    const link = join(dir, "evidence-link");
    symlinkSync(empty, link);
    await assert.rejects(() => acceptTask(card.id, "supervisor", { artifact: link }), new RegExp(localePattern(zhCN("artifactAccept.notFile"))));
    assert.equal(getTask(card.id).status, "acceptance");
    await untouched(card, main);
    assert.equal(events(card.id).some((row) => row.kind === "artifact_accepted" || row.kind === "landed" || row.kind === "land_conflict"), false);
  });

  it("rejects an unqualified identity and a supervisor from another project", async () => {
    const root = await initRepo("identity-root");
    const card = await addCard(root, "identity-card", "from-identity\n");
    const worker = "worker-artifact";
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(worker, card.id);
    await assert.rejects(
      () => runKanban(["accept", String(card.id), "--artifact", card.sha], { PASEO_AGENT_ID: worker }),
      new RegExp(localePattern(zhCN("tools.denial.accept").slice(0, 12))),
    );
    assert.equal(getTask(card.id).status, "acceptance");
    getDb().prepare("UPDATE tasks SET agent_id = NULL WHERE id = ?").run(card.id);
    const boss = "boss-of-demo";
    await runKanban(["supervise", "--project", "demo"], { PASEO_AGENT_ID: boss });
    const other = createTask({ project: "elsewhere", title: "Other project", role: "executor", workspacePath: root, brief: "demo fixture" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(other.id);
    appendEvent(other.id, "approve", "reviewing", "acceptance", "reviewer", { summary: "checked" });
    await assert.rejects(
      () => runKanban(["accept", String(other.id), "--artifact", card.sha], { PASEO_AGENT_ID: boss }),
      new RegExp(localePattern(zhCN("identity.otherProjectCard", { action: zhCN("tools.action.accept"), project: "elsewhere" }))),
    );
    assert.equal(getTask(other.id).status, "acceptance");
    assert.equal(events(other.id).some((row) => row.kind === "artifact_accepted"), false);
  });

  it("refuses active cards and an executor card with no approving review", async () => {
    const root = await initRepo("gate-root");
    const running = await addCard(root, "running-card", "from-running\n");
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(running.id);
    const main = (await git(root, ["rev-parse", "HEAD"])).trim();
    await assert.rejects(
      () => acceptTask(running.id, "supervisor", { artifact: running.sha }),
      new RegExp(localePattern(zhCN("artifactAccept.onlyAcceptance", { status: "running" }))),
    );
    assert.equal(getTask(running.id).status, "running");
    await untouched(running, main);
    const reviewing = await addCard(root, "reviewing-card", "from-reviewing\n");
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(reviewing.id);
    await assert.rejects(() => acceptTask(reviewing.id, "supervisor", { artifact: reviewing.sha }), new RegExp(localePattern(zhCN("artifactAccept.onlyAcceptance", { status: "reviewing" }))));
    assert.equal(getTask(reviewing.id).status, "reviewing");
    const unreviewed = await addCard(root, "unreviewed-card", "from-unreviewed\n");
    getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'approve'").run(unreviewed.id);
    await assert.rejects(() => acceptTask(unreviewed.id, "supervisor", { artifact: unreviewed.sha }), new RegExp(localePattern(zhCN("artifactAccept.reviewRequired"))));
    assert.equal(getTask(unreviewed.id).status, "acceptance");
    const review = createTask({ project: "demo", title: "Review note", role: "reviewer", workspacePath: root, brief: "demo fixture", reviewOf: unreviewed.id });
    appendEvent(review.id, "approve", "reviewing", "acceptance", "reviewer", { summary: "checked" });
    const accepted = await acceptTask(unreviewed.id, "supervisor", { artifact: unreviewed.sha });
    assert.equal(accepted.status, "done");
    const passed = await addCard(root, "passed-card", "from-passed\n");
    getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'approve'").run(passed.id);
    appendEvent(passed.id, "leader_pass", "rework", "acceptance", "supervisor", { note: "p2 only" });
    assert.equal((await acceptTask(passed.id, "supervisor", { artifact: passed.sha })).status, "done");
    const batch = await addCard(root, "batch-card", "from-batch\n", "batch");
    assert.equal((await acceptTask(batch.id, "supervisor", { artifact: batch.sha })).status, "done");
  });

  it("refuses an unowned worktree before marking the card done", async () => {
    const root = await initRepo("unowned-root");
    const outside = join(dir, "outside-copy");
    const task = createTask({ project: "demo", title: "unowned", role: "executor", workspacePath: root, brief: "demo fixture" });
    const branch = tempBranchName(cardMark(task.id), "unowned");
    await git(root, ["worktree", "add", "-b", branch, outside, "main"]);
    writeFileSync(join(outside, "README"), "outside\n");
    await git(outside, ["add", "README"]);
    await git(outside, ["commit", "-m", "outside"]);
    rememberTemp(task.id, root, branch, outside);
    appendEvent(task.id, "approve", "reviewing", "acceptance", "reviewer", { summary: "checked" });
    const main = (await git(root, ["rev-parse", "HEAD"])).trim();
    const sha = (await git(root, ["rev-parse", `refs/heads/${branch}`])).trim();
    await assert.rejects(() => acceptTask(task.id, "supervisor", { artifact: sha }), (err: unknown) => {
      assert.ok(err instanceof KanbanError);
      assert.equal(err.code, "conflict");
      return true;
    });
    assert.equal(getTask(task.id).status, "acceptance");
    assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), main);
    assert.equal((await git(root, ["rev-parse", `refs/heads/${branch}`])).trim(), sha);
  });

  it("keeps the only commit across cleanup, including when a remote base would otherwise delete the branch", async () => {
    const root = await initRepo("keep-root");
    const card = await addCard(root, "keep-card", "from-keep\n");
    const main = (await git(root, ["rev-parse", "HEAD"])).trim();
    assert.equal((await acceptTask(card.id, "supervisor", { artifact: card.sha })).status, "done");
    assert.equal(await settle(card), "pending");
    const skipped = readCleanupEvents(card.id).find((row) => row.action === "skip_worktree" && row.reason === "not_merged");
    assert.equal(skipped?.ok, false);
    assert.equal(existsSync(card.directory), true);
    assert.equal((await git(root, ["rev-parse", `refs/heads/${card.branch}`])).trim(), card.sha);
    assert.equal((await git(root, ["cat-file", "-t", card.sha])).trim(), "commit");
    assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), main);
    assert.equal(readCleanupEvents(card.id).some((row) => row.action === "delete_branch" && row.ok === true), false);
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(card.id);
    await settle(card, new Date(Date.now() + 24 * 60 * 60 * 1000));
    assert.equal((await git(root, ["rev-parse", `refs/heads/${card.branch}`])).trim(), card.sha);
    assert.equal((await git(root, ["cat-file", "-t", card.sha])).trim(), "commit");
    assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), main);
    assert.equal(readCleanupEvents(card.id).some((row) => row.action === "delete_branch" && row.ok === true), false);

    const originRoot = await initRepo("origin-root");
    const originCard = await addCard(originRoot, "origin-card", "from-origin\n");
    const originMain = (await git(originRoot, ["rev-parse", "HEAD"])).trim();
    assert.equal((await acceptTask(originCard.id, "supervisor", { artifact: originCard.sha })).status, "done");
    const bare = join(dir, "origin-remote.git");
    mkdirSync(bare, { recursive: true });
    await git(bare, ["init", "--bare", "-b", "main"]);
    await git(originRoot, ["remote", "add", "origin", bare]);
    await git(originRoot, ["push", "origin", `refs/heads/${originCard.branch}:refs/heads/main`]);
    await settle(originCard);
    assert.equal((await git(originRoot, ["rev-parse", `refs/heads/${originCard.branch}`])).trim(), originCard.sha);
    assert.equal((await git(originRoot, ["cat-file", "-t", originCard.sha])).trim(), "commit");
    assert.equal((await git(originRoot, ["rev-parse", "HEAD"])).trim(), originMain);
    assert.equal(readCleanupEvents(originCard.id).some((row) => row.action === "delete_branch" && row.ok === true), false);
    assert.equal(readCleanupEvents(originCard.id).some((row) => row.action === "keep_branch" && row.reason === ARTIFACT_KEEP_BRANCH), true);
  });
});
