import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { downstreamCounts, orderByDownstream } from "../server/downstream";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { createTask, getDetail, getTask, listBoard } from "../server/store";
import { openEntry } from "../server/pools";
import { runTick } from "./helpers/compat-schedule";
import { resetMergeCache, setGhRunner, prMergeState, writeContract } from "../server/pr";
import type { Profile } from "../server/profiles";

const dir = mkdtempSync(join(tmpdir(), "kanban-downstream-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];
beforeEach(() => {
  getDb().exec("DELETE FROM links; DELETE FROM events; DELETE FROM runs; DELETE FROM tasks");
  resetMergeCache();
});
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); setGhRunner(null); });
function card(title: string, parents: number[] = [], priority = 0, project = "chain") {
  return createTask({ project, title, role: "executor", workspacePath: dir, parentIds: parents, priority });
}
function graph() {
  const older = card(zhCNPart("doctorConfig.code.evidence", 41, 43));
  const root = card((zhCNPart("boardView.drag", 0, 2) + "Demo text"));
  const left = card("Left", [root.id]);
  const right = card("Right", [root.id]);
  const leaf = card("Convergence", [left.id, right.id]);
  return { older, root, left, right, leaf };
}
function config(patch: Partial<KanbanConfig> = {}): KanbanConfig {
  const value = { autoStart: { chain: true }, supervisors: {}, supervisorAgentId: null,
    concurrency: { ...DEFAULT_CONCURRENCY, global: 1 },
    projects: { chain: { defaultWorkspace: "dir" as const, baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: false } }, ...patch };
  saveConfig(value);
  return value;
}
async function tick(cfg = config(), poolOpen = true) {
  return runTick({ profiles, config: cfg, matrix: { state: "missing" },
    pools: { state: "fresh", generatedAt: new Date().toISOString(), updatedAt: null, ageMs: 0, message: zhCNPart("compat.name.offlineTest", 2, 4),
      dispatchable: (pool) => pool !== "cursor" || poolOpen,
      entry: (pool) => ({ ...openEntry(), dispatchable: pool !== "cursor" || poolOpen }) },
    launcher: { async create() { return { id: "test-agent" }; }, async send() {} },
    agentState: () => "alive",
  });
}

it("reads the graph once, deduplicates diamonds, and includes cross-project descendants in filtered cards", () => {
  const { root, leaf } = graph();
  const extra = card(zhCNPart("board.allProjectsBoard", 0, 3), [leaf.id], 0, "other");
  const db = getDb();
  const original = db.prepare;
  let reads = 0;
  db.prepare = function(sql: string) { reads++; return original.call(this, sql); };
  let counts: Map<number, number>;
  try { counts = downstreamCounts(); } finally { db.prepare = original; }
  assert.equal(reads, 1);
  assert.equal(counts.get(root.id), 4);
  assert.equal(counts.get(extra.id), 0);
  assert.equal(listBoard("chain").tasks.find(t => t.id === root.id)?.downstreamCount, 4);
  assert.equal(getDetail(root.id).task.downstreamCount, 4);
  assert.match(listBoard("chain").tasks.find(t => t.id === root.id)!.related, new RegExp(zhCN("boardView.drag", {"count":"4"})));
});

it("ignores finished and triage dependencies, bounds cycles, and refreshes after status changes", () => {
  const { root, left, right, leaf } = graph();
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(left.id);
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(right.id);
  assert.equal(downstreamCounts().get(root.id) ?? 0, 0);
  getDb().prepare("UPDATE tasks SET status = 'triage' WHERE id = ?").run(root.id);
  getDb().prepare("UPDATE tasks SET status = 'waiting' WHERE id IN (?, ?)").run(left.id, right.id);
  assert.equal(downstreamCounts().get(root.id) ?? 0, 0);
  getDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(root.id);
  assert.equal(downstreamCounts().get(root.id), 3);
  getDb().prepare("INSERT INTO links(parent_id, task_id) VALUES (?, ?)").run(leaf.id, root.id);
  assert.equal(downstreamCounts().get(root.id), 3);
});

it("keeps a finished GitHub parent blocking until the merge cache confirms it", async () => {
  const root = card("PR");
  card(zhCN("cardDrawer.links.child"), [root.id]);
  const pr = "https://github.com/test/repo/pull/1";
  getDb().prepare("UPDATE tasks SET status = 'done', contract_json = ? WHERE id = ?")
    .run(writeContract({ kind: "github", repo: "test/repo", pr, awaiting: false }), root.id);
  assert.equal(downstreamCounts().get(root.id), 1);
  setGhRunner(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-10-02T00:00:00Z" }));
  await prMergeState(pr);
  assert.equal(downstreamCounts().get(root.id) ?? 0, 0);
});

it("keeps explicit priority and stable ties while preferring larger downstream counts", () => {
  const rows = [{ id: 1, priority: 1 }, { id: 2, priority: 0 }, { id: 3, priority: 0 }, { id: 4, priority: 0 }];
  assert.deepEqual(orderByDownstream(rows, new Map([[2, 2], [3, 5], [4, 2]])).map(x => x.id), [1, 3, 2, 4]);
  assert.deepEqual(rows.map(x => x.id), [1, 2, 3, 4]);
});

it("starts the larger chain first and retains global concurrency plus a dispatch event", async () => {
  const { root, older, leaf } = graph();
  const result = await tick();
  assert.deepEqual(result.started, [root.id]);
  assert.equal(getTask(leaf.id).status, "waiting");
  assert.match(getTask(older.id).hold_reason ?? "", new RegExp(zhCN("schedule.globalFull")));
  const event = getDb().prepare("SELECT data_json, to_status FROM events WHERE kind = 'downstream_dispatched'").get() as { data_json: string; to_status: null };
  assert.equal(JSON.parse(event.data_json).downstreamCount, 3);
  assert.equal(event.to_status, null);
});

it("does not bypass an explicit priority, disabled project, quota, or unmet prerequisite", async () => {
  const { root, leaf } = graph();
  const priority = card((zhCNPart("routing.sum.rulePreferred", 7, 9) + zhCNPart("routing.effortSource.downgrade", 5, 6)), [], 1);
  assert.deepEqual((await tick()).started, [priority.id]);
  getDb().exec("UPDATE tasks SET status = 'ready', agent_id = NULL WHERE status = 'running'; DELETE FROM runs");
  assert.deepEqual((await tick(config({ autoStart: { chain: false } }))).started, []);
  assert.match(getTask(root.id).hold_reason ?? "", new RegExp(zhCN("schedule.autoStartOff")));
  assert.deepEqual((await tick(config(), false)).started, []);
  assert.equal(getTask(leaf.id).status, "waiting");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'downstream_dispatched'").get()?.n, 0);
});

it("does not bypass role or pool concurrency limits even with a large chain", async () => {
  const { root } = graph();
  const roleCap = config({ concurrency: { ...DEFAULT_CONCURRENCY, global: 10, roles: { ...DEFAULT_CONCURRENCY.roles, executor: 0 } } });
  assert.deepEqual((await tick(roleCap)).started, []);
  assert.match(getTask(root.id).hold_reason ?? "", new RegExp(zhCN("schedule.roleFull", {"role":zhCN("labels.role.executor")})));
  const poolCap = config({ concurrency: { ...DEFAULT_CONCURRENCY, global: 10, pools: { ...DEFAULT_CONCURRENCY.pools, cursor: 0 } } });
  assert.deepEqual((await tick(poolCap)).started, []);
  assert.match(getTask(root.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("schedule.globalFull", 2, 6))));
});

it("skips a larger chain on cooldown and starts the eligible smaller card", async () => {
  const { root, older } = graph();
  getDb().prepare("UPDATE tasks SET cooldown_until = ? WHERE id = ?")
    .run(new Date(Date.now() + 60_000).toISOString(), root.id);
  assert.deepEqual((await tick()).started, [older.id]);
  assert.match(getTask(root.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("failures.cooldown", 0, 2))));
});

it("retains directory locks and skips the held chain to use an available directory", async () => {
  const { root, older } = graph();
  const otherDir = join(dir, "free");
  mkdirSync(otherDir, { recursive: true });
  getDb().prepare("UPDATE tasks SET workspace_path = ? WHERE id = ?").run(otherDir, older.id);
  const busy = card("Directory occupied", [], 0, "busy");
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'busy-agent' WHERE id = ?").run(busy.id);
  assert.deepEqual((await tick(config({ concurrency: { ...DEFAULT_CONCURRENCY, global: 10 } }))).started, [older.id]);
  assert.match(getTask(root.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("schedule.sameWorkspace", 0, 6))));
});
