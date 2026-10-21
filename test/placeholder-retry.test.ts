/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { cardMark } from "../server/card-ref";
import { closeDb, getDb } from "../server/db";
import { runDoctor } from "../server/doctor";
import { PLACEHOLDER_NAME, placeholderAgentIdsFromText } from "../server/missing-cwd";
import { readCleanupEvents } from "../server/archive-book";
import { appendEvent, createTask, getTask } from "../server/store";
import { settleTempWorkspace } from "../server/temp-workspace";
import { tempBranchName } from "../server/workspace";

const dir = mkdtempSync(join(tmpdir(), "placeholder-retry-"));
const trees = join(dir, "worktrees");
process.env.KANBAN_DATA_DIR = join(dir, "data");
process.env.KANBAN_WORKTREES_ROOT = trees;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
mkdirSync(join(process.env.KANBAN_AGENTS_DIR, "bucket"));
mkdirSync(trees);
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function retry(name: string, eventOnly = false) {
  const root = join(dir, name);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "noreply@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "README"), "base\n");
  git(root, "add", "README");
  git(root, "commit", "-qm", "base");
  const task = createTask({ project: name, title: name, role: "executor", workspacePath: root });
  const branch = tempBranchName(cardMark(task.id), name);
  const first = join(trees, `kanban-${cardMark(task.id).toLowerCase().replaceAll("_", "-")}-${name}`);
  const current = `${first}-r1`;
  // The first attempt lost its checkout/workspace; patrol left only this README.
  mkdirSync(first);
  writeFileSync(join(first, PLACEHOLDER_NAME), "agent: gone-agent\n");
  appendEvent(task.id, "cwd_placeholder", null, null, "test", { path: first, agentId: "gone-agent" });
  if (!eventOnly) appendEvent(task.id, "worktree_created", null, null, "test", {
    directory: first, root, branch, base: "main", temp: true, discarded: true,
  });
  git(root, "worktree", "add", "-qb", branch, current, "main");
  appendEvent(task.id, "worktree_created", null, null, "test", { directory: current, root, branch, base: "main", temp: true });
  appendEvent(task.id, "temp_workspace", null, null, "test", { directory: current, root, base: "main" });
  getDb().prepare("UPDATE tasks SET status = 'done', workspace_path = ?, workspace_kind = 'worktree', workspace_base = 'main' WHERE id = ?").run(current, task.id);
  const settle = () => settleTempWorkspace({
    task: getTask(task.id), events: readCleanupEvents(task.id), now: new Date(),
    record: data => appendEvent(task.id, "cleanup", null, null, "test", data),
    archiveWorkspace: async () => {}, decideWorkspace: async () => ({ action: "skip", reason: "gone" }),
  });
  const doctor = () => runDoctor({ wake: false, persist: false, sources: {
    agents: { agents: [], paseoIds: [] },
    dirs: { root: trees, worktrees: git(root, "worktree", "list", "--porcelain").split("\n")
      .filter(line => line.startsWith("worktree ")).map(line => line.slice(9)),
      list: () => readdirSync(trees).map(name => join(trees, name)),
      placeholderAgents: path => existsSync(join(path, PLACEHOLDER_NAME))
        ? placeholderAgentIdsFromText(readFileSync(join(path, PLACEHOLDER_NAME), "utf8")) : null },
  } });
  return { root, id: task.id, branch, first, current, settle, doctor };
}

for (const eventOnly of [false, true]) {
  it(`collects the failed attempt and successful -r1 checkout (${eventOnly ? "placeholder event" : "discarded creation"})`, async () => {
    const card = await retry(`retry-${eventOnly}`, eventOnly);
    const finding = (await card.doctor()).findings.find(item => item.object === card.first);
    assert.equal(finding?.taskId, card.id, "doctor recognizes the same recorded owner as cleanup");
    assert.equal(await card.settle(), "settled");
    assert.equal(existsSync(card.first), false);
    assert.equal(existsSync(card.current), false);
    assert.equal((await card.doctor()).findings.some(item => item.object === card.first || item.object === card.current), false);
  });
}

for (const unsafe of ["extra", "foreign", "worktree", "symlink", "live-agent"] as const) {
  it(`retains and reports an unsafe historical placeholder: ${unsafe}`, async () => {
    const card = await retry(`unsafe-${unsafe}`);
    if (unsafe === "extra") writeFileSync(join(card.first, "keep.txt"), "uncommitted work\n");
    if (unsafe === "foreign") {
      const other = createTask({ project: "other", title: "Other owner", role: "executor", workspacePath: card.root });
      appendEvent(other.id, "cwd_placeholder", null, null, "test", { path: card.first, agentId: "foreign-agent" });
    }
    if (unsafe === "worktree") {
      rmSync(card.first, { recursive: true });
      git(card.root, "worktree", "add", "-q", "--detach", card.first, "main");
      writeFileSync(join(card.first, PLACEHOLDER_NAME), "agent: gone-agent\n");
      writeFileSync(join(card.first, "keep.txt"), "uncommitted work\n");
    }
    if (unsafe === "symlink") {
      const target = join(dir, "outside-placeholder");
      mkdirSync(target);
      writeFileSync(join(target, PLACEHOLDER_NAME), "agent: gone-agent\n");
      rmSync(card.first, { recursive: true });
      symlinkSync(target, card.first);
    }
    if (unsafe === "live-agent") writeFileSync(join(process.env.KANBAN_AGENTS_DIR!, "bucket", "gone-agent.json"), JSON.stringify({
      id: "gone-agent", cwd: card.first, labels: {}, provider: "claude",
    }));
    try {
      assert.equal(await card.settle(), "pending");
      assert.equal(existsSync(join(card.first, PLACEHOLDER_NAME)), true);
      assert.ok(readCleanupEvents(card.id).some(row => row.directory === card.first && row.ok === false && row.error));
      assert.equal(getDb().prepare("SELECT 1 FROM events WHERE task_id = ? AND kind = 'temp_workspace_cleaned'").get(card.id), undefined);
      const finding = (await card.doctor()).findings.find(item => item.object === card.first);
      assert.ok(finding);
      if (unsafe !== "live-agent") {
        const failed = readCleanupEvents(card.id).find(row => row.directory === card.first && row.ok === false);
        assert.ok(finding.evidence.includes(failed!.error!), "doctor and cleanup share the refusal reason");
      }
      if (unsafe === "extra" || unsafe === "worktree") assert.equal(readFileSync(join(card.first, "keep.txt"), "utf8"), "uncommitted work\n");
    } finally {
      if (unsafe === "live-agent") rmSync(join(process.env.KANBAN_AGENTS_DIR!, "bucket", "gone-agent.json"));
    }
  });
}

it("does not infer ownership from a neighboring card-like path", async () => {
  const card = await retry("unknown-neighbor");
  const unknown = `${card.first}-r99`;
  mkdirSync(unknown);
  writeFileSync(join(unknown, PLACEHOLDER_NAME), "agent: unrelated-agent\n");
  assert.equal(await card.settle(), "settled");
  assert.equal(existsSync(unknown), true);
  assert.equal((await card.doctor()).findings.find(item => item.object === unknown)?.severity, "red");
});
