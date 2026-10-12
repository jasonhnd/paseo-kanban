/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { flushMergeChecks, resetMergeChecks } from "../server/auto-archive";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { acceptTask, linkTask } from "../server/flow";
import { mergeCardDependency, parentBlockReason, parentPulls, taskParents } from "../server/parents";
import { resetMergeCache, setGhRunner, writeContract } from "../server/pr";
import { promoteWaiting } from "../server/promote";
import { protocolFor } from "../server/protocol";
import { createTask, getTask, listBoard } from "../server/store";
import { formatResult, handleTool } from "../server/tools";
import { issueToken } from "../server/tokens";
import { setProjectCode } from "../server/config";

const dir = mkdtempSync(join(tmpdir(), "merge-card-"));
process.env.KANBAN_DATA_DIR = dir;
const PR = "https://github.com/acme/widgets/pull/264";
const contract = (pr = PR) => writeContract({ kind: "local-only", repo: null, pr, awaiting: false });
function parent(status = "done", pr = PR) {
  const task = createTask({ project: "merge", role: "executor", title: "PR Parent", contract: contract(pr) });
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
  return getTask(task.id);
}
const childInput = { project: "merge", role: "batch", title: "Merge work", brief: "demo fixture PR #264", workspacePath: dir };
const events = (id: number) => getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'merge_card_dependency'").all(id);

beforeEach(() => {
  getDb().prepare("UPDATE tasks SET status = 'archived'").run();
  resetMergeCache();
  resetMergeChecks();
  // No real GitHub calls in these tests.
  setGhRunner(async () => JSON.stringify({ state: "OPEN", mergedAt: null }));
});
after(() => {
  setGhRunner(null);
  resetMergeCache();
  resetMergeChecks();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("batch merge card dependency", () => {
  for (const scenario of [
    { name: "brief PR #264", patch: {}, ready: true },
    { name: "real merge brief contains file paths and git refs", patch: { brief: "demo fixture PR #264 sample CI demo fixture e2e/menu-pointer.spec.js demo fixture Demo text push main/pre/preview , update first origin/dev" }, ready: true },
    { name: "title #264", patch: { title: "Sample text #264", brief: "" }, ready: true },
    { name: "same contract.pr", patch: { brief: "", contract: contract() }, ready: true },
    { name: "full link across projects", patch: { project: "other", brief: `merge ${PR}` }, ready: true },
    { name: "different PR number", patch: { brief: "Merge PR #265" }, ready: false },
    { name: "non-batch same PR", patch: { role: "executor" }, ready: false },
    { name: "same number, other repo URL", patch: { brief: "demo fixture https://github.com/other/repo/pull/264" }, ready: false },
    { name: "same number, other repo named", patch: { brief: "Merge other/repo PR #264" }, ready: false },
    { name: "same number, other repo declared separately", patch: { brief: "Repository: other/repo , merge PR #264" }, ready: false },
    { name: "same number, repo after the number", patch: { brief: "merge PR #264 (other/repo)" }, ready: false },
    { name: "same number, other repo homepage", patch: { brief: "demo fixture https://github.com/other/repo sample PR #264" }, ready: false },
    { name: "same number, other repo contract", patch: { contract: "github:other/repo" }, ready: false },
    { name: "cross-project bare number", patch: { project: "other" }, ready: false },
    { name: "qualified cross-project same repo", patch: { project: "other", brief: "merge acme/widgets#264" }, ready: true },
    { name: "number prefix does not match", patch: { brief: "demo fixture PR #2640" }, ready: false },
  ]) {
    it(`${scenario.name}: ${scenario.ready ? "done releases" : "still waits for merge"}`, () => {
      const p = parent();
      const child = createTask({ ...childInput, ...scenario.patch, parentIds: [p.id] });
      assert.equal(child.status, scenario.ready ? "ready" : "waiting");
      assert.equal(mergeCardDependency(child, p), scenario.ready ? PR : null);
      assert.equal(parentBlockReason(p, Date.now(), child) === null, scenario.ready);
      assert.deepEqual(parentPulls([p], child), scenario.ready ? [] : [PR]);
      assert.equal(events(child.id).length, scenario.ready ? 1 : 0);
      const shown = listBoard().tasks.find(task => task.id === child.id)!;
      assert.equal(shown.related.includes(zhCN("parents.mergeNote", {"number":"264"})), scenario.ready);
    });
  }

  it("unfinished PR parent still blocks; accept releases immediately without polling gh", async () => {
    const p = parent("acceptance");
    const child = createTask({ ...childInput, parentIds: [p.id] });
    assert.equal(child.status, "waiting");
    assert.equal(parentBlockReason(p, Date.now(), child), zhCN("parents.block.waitingParents"));
    acceptTask(p.id, "supervisor");
    assert.equal(getTask(child.id).status, "ready");
    assert.equal(events(child.id).length, 1);
    assert.deepEqual(JSON.parse(String(events(child.id)[0]!.data_json)), { parent: p.id, pr: PR });
  });

  it("only bypasses the matching parent and scheduler records once for old waiting cards", async () => {
    const p = parent();
    const other = parent("done", "https://github.com/acme/widgets/pull/265");
    const child = createTask({ ...childInput, parentIds: [p.id, other.id] });
    assert.equal(child.status, "waiting");
    assert.deepEqual(parentPulls(taskParents(child.id), child), ["https://github.com/acme/widgets/pull/265"]);
    promoteWaiting("test");
    await flushMergeChecks();
    promoteWaiting("test");
    assert.equal(getTask(child.id).status, "waiting");
    assert.equal(events(child.id).length, 1);
    getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'merge_card_dependency'").run(child.id);
    getDb().prepare("DELETE FROM links WHERE task_id = ? AND parent_id = ?").run(child.id, other.id);
    assert.deepEqual(promoteWaiting("test"), [child.id]);
    assert.deepEqual(promoteWaiting("test"), []);
    assert.equal(events(child.id).length, 1);
  });

  it("link recognizes matched PR, while create and link return non-blocking mismatch warnings", async () => {
    // TEST_0273: a card no longer configures its project by writing a short code; configure it first.
    setProjectCode("merge", "MER");
    const p = parent();
    const matched = createTask(childInput);
    assert.equal(linkTask(matched.id, p.id, "supervisor").status, "ready");
    linkTask(matched.id, p.id, "supervisor");
    assert.equal(events(matched.id).length, 1);
    const token = issueToken("supervisor", null, null);
    const mismatch = await handleTool("kanban_create", { ...childInput, brief: "merge PR #265", parents: [p.id] }, token) as ReturnType<typeof createTask>;
    assert.equal(mismatch.status, "waiting");
    assert.match(mismatch.warnings?.[0] ?? "", new RegExp(localePattern(zhCNPart("parents.mergeWarning", 14, 22))));
    assert.match(formatResult(mismatch), new RegExp(localePattern(zhCNPart("boardView.default.note", 0, 3)) + ".*" + localePattern(zhCNPart("parents.mergeWarning", 24, 34))));
    const unlinked = createTask({ ...childInput, title: "Merge PR #265", brief: "" });
    assert.match(unlinked.warnings?.[0] ?? "", new RegExp(localePattern(zhCNPart("parents.mergeWarning", 14, 22))));
    const linked = await handleTool("kanban_link", { id: unlinked.id, parent: p.id }, token) as ReturnType<typeof linkTask>;
    assert.equal(linked.status, "waiting");
    assert.match(linked.warnings?.[0] ?? "", new RegExp(localePattern(zhCNPart("parents.mergeWarning", 14, 22))));
  });

  it("manual start refreshes an old waiting card without waiting for scheduler", async () => {
    const p = parent();
    const child = createTask({ ...childInput, parentIds: [p.id] });
    getDb().prepare("UPDATE tasks SET status = 'waiting' WHERE id = ?").run(child.id);
    const result = await startTask(child.id, { create: async () => ({ id: "merge-agent" }), send: async () => {} }, "supervisor", {
      force: true,
      profiles: [],
      chosen: { id: "batch", name: zhCN("labels.role.batch"), role: "batch", family: "anthropic", provider: "claude", model: "sonnet" },
    });
    assert.equal(result.agentId, "merge-agent");
    assert.equal(getTask(child.id).status, "running");
  });

  it("executor and leader instructions explain merge dependencies", () => {
    for (const role of ["executor", "batch", "supervisor"]) {
      assert.match(protocolFor(role), new RegExp(localePattern(zhCNPart("parents.mergeNote", 0, 3)) + localePattern(zhCNPart("boardView.cmd.okToMerge", 0, 2)) + localePattern(zhCNPart("compat.source.cwdChanged", 34, 37)) + "PR \\u5361\\u540e\\u9762"));
    }
  });
});
