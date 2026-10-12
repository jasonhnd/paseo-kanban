import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { kanbanHelp, runKanban } from "../server/cli";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { unlinkTask } from "../server/flow";
import { taskParents } from "../server/parents";
import { canonicalKanbanTool } from "../server/permissions";
import { prMergeState, resetMergeCache, writeContract } from "../server/pr";
import { createTask, getTask } from "../server/store";
import { handleTool, toolDefs } from "../server/tools";

const dir = mkdtempSync(join(tmpdir(), "kanban-unlink-"));
process.env.KANBAN_DATA_DIR = dir;
saveConfig({ ...loadConfig(), supervisorAgentId: "board", supervisors: { unlink: "leader" } });
const identity = (agentId: string, role = "supervisor") => ({ role, taskId: null, agentId });
const card = (parents: number[] = []) => createTask({ project: "unlink", title: "demo fixture", role: "executor", parentIds: parents, createdByAgent: "creator" });
after(() => { resetMergeCache(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

it("restricts unlink to the registered project/board leader, including creator denial", async () => {
  const parent = card();
  const child = card([parent.id]);
  for (const who of [identity("other"), identity("creator"), identity("worker", "executor"), identity("review", "reviewer")]) {
    await assert.rejects(handleTool("kanban_unlink", { id: child.id, parent: parent.id }, null, who), new RegExp(localePattern(zhCNPart("doctor.safety.unsafe", 0, 2)) + "|" + localePattern(zhCNPart("taskLifecycle.error.notBlocked", 0, 2))));
    assert.equal(taskParents(child.id).length, 1);
  }
  await handleTool("kanban_unlink", { id: child.id, parent: parent.id }, null, identity("board"));
  assert.equal(getTask(child.id).status, "ready");
});

it("reports missing parent, missing edge and empty batch without partial deletion", async () => {
  const parent = card();
  const other = card();
  const child = card([parent.id]);
  const before = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'unlinked'").get()!.n;
  for (const parents of [[], [parent.id, 999999], [parent.id, other.id]]) {
    await assert.rejects(handleTool("kanban_unlink", { id: child.id, parents }, null, identity("leader")), new RegExp(localePattern(zhCNPart("flow.error.noParents", 0, 5)) + "|" + localePattern(zhCNPart("cardRef.error.noCard", 0, 5)) + "|" + localePattern(zhCNPart("flow.error.noSuchParent", 7, 13))));
    assert.deepEqual(taskParents(child.id).map(p => p.id), [parent.id]);
  }
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'unlinked'").get()!.n, before);
});

it("CLI accepts repeated/comma parents and clears waiting attention when the final gate is removed", async () => {
  const parents = [card(), card(), card()];
  const child = card(parents.map(p => p.id));
  getDb().prepare("UPDATE tasks SET hold_reason = 'old', unattended_at = 'before' WHERE id = ?").run(child.id);
  await runKanban(["unlink", String(child.id), "--parent", String(parents[0].id)], { PASEO_AGENT_ID: "leader" });
  assert.equal(getTask(child.id).status, "waiting");
  assert.equal(getTask(child.id).hold_reason, zhCN("parents.block.waitingParents"));
  await runKanban(["unlink", String(child.id), "--parents", `${parents[1].id},${parents[2].id}`, "--parents", String(parents[1].id)], { PASEO_AGENT_ID: "leader" });
  assert.equal(getTask(child.id).status, "ready");
  assert.equal(getTask(child.id).hold_reason, null);
  assert.equal(getTask(child.id).unattended_at, null);
  const events = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'unlinked'").all(child.id) as Array<{ data_json: string }>;
  assert.deepEqual(events.map(e => JSON.parse(e.data_json).parentId), parents.map(p => p.id));
});

it("reevaluation respects remaining PR merge gates and releases after their confirmed merge", async () => {
  const removed = card();
  const pr = "https://github.com/acme/unlink/pull/1";
  const remaining = createTask({ project: "unlink", title: "PR", role: "executor", contract: writeContract({ kind: "local-only", repo: null, pr, awaiting: false }) });
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(remaining.id);
  const child = card([removed.id, remaining.id]);
  unlinkTask(child.id, [removed.id], "supervisor");
  assert.equal(getTask(child.id).status, "waiting");
  assert.match(getTask(child.id).hold_reason!, new RegExp("PR " + localePattern(zhCNPart("worktreeGc.leftover.notMerged", 1, 3))));
  const extra = card();
  getDb().prepare("INSERT INTO links(task_id, parent_id) VALUES (?, ?)").run(child.id, extra.id);
  await prMergeState(pr, { run: async () => JSON.stringify({ state: "MERGED" }) });
  unlinkTask(child.id, [extra.id], "supervisor");
  assert.equal(getTask(child.id).status, "ready");
});

it("does not reopen finished cards or alter unrelated waiting cards", () => {
  const parent = card();
  const child = card([parent.id]);
  const unrelated = card([parent.id]);
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(child.id);
  unlinkTask(child.id, [parent.id], "supervisor");
  assert.equal(getTask(child.id).status, "done");
  assert.equal(getTask(unrelated.id).status, "waiting");
});

it("publishes CLI help and the MCP schema/permission name", () => {
  assert.match(kanbanHelp(), new RegExp("unlink <" + localePattern(zhCNPart("cardParts.event.wakeChildren", 2, 4)) + "> --parent"));
  assert.equal(canonicalKanbanTool("mcp__kanban__kanban_unlink"), "kanban_unlink");
  assert.ok(Object.hasOwn(toolDefs().find(t => t.name === "kanban_unlink")!.inputSchema.properties!, "parents"));
});
