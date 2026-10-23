import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { closeDb, getDb } from "../server/db";
import { appendEvent, archiveTask, blockTask, createTask, getTask, unblockTask } from "../server/store";
import { costEstimate, publishRunCosts } from "../server/run-cost";
import { runBudgetSnapshot, scanRunBudgets } from "../server/run-budget";
import { leaderReworkTask } from "../server/flow";
import { resetRunBudget } from "../server/run-budget-control";
import { applyFailure } from "../server/failures";
import { DEFAULT_CONCURRENCY, saveConfig } from "../server/config";
import { estimateRunCost } from "../shared/fleet/run-cost";

const root = mkdtempSync(join(tmpdir(), "run-cost-demo-"));
const saved = { ...process.env };
const start = "2026-10-01T10:00:00.000Z";
const end = "2026-10-01T11:00:00.000Z";
let dir: string;
const put = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));
function quota(pct: number, at: string, resetsAt = "2026-10-08T00:00:00Z") {
  put(join(dir, "fleet/pool-status.json"), { generatedAt: at, pools: { demo: { usedPct: pct, observedAt: at, resetsAt } } });
}
beforeEach(() => {
  closeDb(); dir = mkdtempSync(join(root, "board-"));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_PASEO_CONFIG = join(dir, "paseo.json");
  mkdirSync(join(dir, "fleet"));
  put(process.env.KANBAN_PASEO_CONFIG, { daemon: { agentProfiles: [{ name: "Demo", pool: "demo", provider: "codex", model: "demo-sol" }] } });
  put(join(dir, "kanban.config.json"), { projects: { demo: { code: "DEMO" } } });
  quota(10, start);
});
after(() => {
  closeDb(); rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
function run(tags: string[] = []) {
  quota(10, start);
  const task = createTask({ project: "demo", title: "Cost fixture", role: "executor", tags, tier: "L3" });
  const db = getDb();
  const id = Number(db.prepare("INSERT INTO runs (task_id,agent_id,role,profile_name,provider,model,effort,started_at) VALUES (?,?,'executor','Demo','codex','demo-sol','high',?)").run(task.id, `agent-${task.id}`, start).lastInsertRowid);
  return { id, taskId: task.id, agentId: `agent-${task.id}` };
}
function budget(r: ReturnType<typeof run>, status = "available", generation = `${r.agentId}:${r.id}:1`) {
  getDb().prepare("INSERT OR REPLACE INTO run_budget_state VALUES (?,?,?)").run(r.taskId, generation, JSON.stringify({ generation, agentId: r.agentId,
    startedAt: start, observedAt: end, tokenStatus: status, inputTokens: 900, outputTokens: 100, cachedInputTokens: 400, turns: 3, notes: [] }));
}
function finish(id: number, kind = "complete") {
  quota(12, end);
  getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = ? WHERE id = ?").run(end, kind, id);
  return publishRunCosts(getDb(), dir).records;
}
for (const kind of ["complete", "approve", "run_budget", "cancel", "rate_limit", "credential", "other", "startup_archived", "rebound", "cloud_restart"]) {
  test(`records ${kind} exactly once using the existing generation's budget`, () => {
    const r = run(); budget(r);
    const [cost] = finish(r.id, kind);
    assert.equal(cost.runId, r.id); assert.equal(cost.cardCode, "DEMO_0001");
    assert.equal(cost.role, "executor"); assert.equal(cost.tier, "L3"); assert.equal(cost.cardType, "code");
    assert.equal(cost.pool, "demo"); assert.equal(cost.provider, "codex"); assert.equal(cost.model, "demo-sol"); assert.equal(cost.effort, "high");
    assert.equal(cost.tokensIn, 900); assert.equal(cost.tokensOut, 100); assert.equal(cost.tokensCached, 400);
    assert.equal(cost.quotaPctBefore, 10); assert.equal(cost.quotaPctAfter, 12); assert.equal(cost.quotaPctDelta, 2);
    assert.equal(cost.wallMs, 3_600_000); assert.equal(cost.turns, 3); assert.equal(cost.source, "measured"); assert.equal(cost.finishedAt, end);
    assert.equal(finish(r.id, kind).length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, "fleet/run-costs.json"), "utf8")).records.length, 1);
  });
}
test("unknown tokens stay null, while stale quota and partial tokens carry reasons", () => {
  const r = run(["ops"]);
  let [cost] = finish(r.id);
  assert.equal(cost.cardType, "ops"); assert.equal(cost.tokensIn, null); assert.equal(cost.turns, null); assert.equal(cost.source, "partial");
  assert.ok(cost.notes.some(n => /token/i.test(n)));
  const second = run(); budget(second, "partial");
  quota(12, start);
  getDb().prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(end, second.id);
  cost = publishRunCosts(getDb(), dir).records.find(r => r.runId === second.id)!;
  assert.equal(cost.source, "partial"); assert.ok(cost.notes.some(n => /quota.*stale|stale.*quota/i.test(n)));
});
test("another run's budget cannot leak into reused agents, and missing quota stays unknown", () => {
  const r = run(); budget(r, "available", `${r.agentId}:9999:1`);
  put(join(dir, "fleet/pool-status.json"), {});
  // Both endpoints missing, including when the record predates tracking.
  getDb().prepare("DELETE FROM run_cost_snapshots WHERE run_id = ?").run(r.id);
  const [cost] = finish(r.id);
  assert.equal(cost.tokensIn, null); assert.equal(cost.quotaPctBefore, null); assert.equal(cost.source, "partial");
});
test("quota reset boundaries and future readings do not produce negative or invented cost", () => {
  const r = run(); budget(r);
  quota(2, end, "2026-10-15T00:00:00Z");
  getDb().prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(end, r.id);
  const [cost] = publishRunCosts(getDb(), dir).records;
  assert.equal(cost.quotaPctDelta, null); assert.equal(cost.source, "partial"); assert.ok(cost.notes.some(n => /reset/i.test(n)));
});
test("rollback cannot publish a cost and concurrent SQL endings retain all runs", () => {
  const a = run(); const b = run();
  getDb().exec("BEGIN"); finish(a.id); getDb().exec("ROLLBACK");
  assert.equal(publishRunCosts(getDb(), dir).records.length, 0);
  finish(a.id); finish(b.id);
  assert.equal(publishRunCosts(getDb(), dir).records.length, 2);
});
test("estimates group model, effort and card type with optional role/tier, without missing-data dilution", () => {
  const a = run(); budget(a); finish(a.id);
  const b = run(); budget(b); finish(b.id);
  const c = run(); finish(c.id);
  const query = { model: "demo-sol", effort: "high", cardType: "code", role: "executor", tier: "L3" };
  const estimate = costEstimate(query, dir);
  assert.equal(estimate.avgQuotaPct, 2); assert.equal(estimate.avgTokens, 1000); assert.equal(estimate.samples, 3);
  assert.equal(estimate.tokenSamples, 2); assert.equal(estimate.quotaSamples, 3);
  assert.equal(costEstimate({ ...query, effort: "low" }, dir).samples, 0);
  assert.equal(estimateRunCost([{}, { profile: "legacy", tokens: 100 }], query).samples, 0);
  put(join(dir, "fleet/run-costs.json"), { byProfileEffort: [] });
  assert.equal(costEstimate(query, dir).samples, 0);
});

test("missing quota and tokens are unknown, including old open runs without start snapshots", () => {
  const r = run();
  put(join(dir, "fleet/pool-status.json"), {});
  getDb().prepare("DELETE FROM run_cost_snapshots WHERE run_id = ?").run(r.id);
  getDb().prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(end, r.id);
  const [cost] = publishRunCosts(getDb(), dir).records;
  assert.equal(cost.source, "unknown"); assert.equal(cost.tokensIn, null); assert.equal(cost.quotaPctDelta, null);
});
test("archive cancellation and provider failure use the same durable lifecycle", () => {
  const a = run(); budget(a);
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(a.agentId, a.taskId);
  archiveTask(a.taskId, "supervisor");
  const b = run(); budget(b);
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(b.agentId, b.taskId);
  applyFailure(b.taskId, "Demo failure", "rate_limit", new Date(end));
  const costs = publishRunCosts(getDb(), dir).records;
  assert.equal(costs.length, 2); assert.equal(costs[1].tokensIn, 900);
});
test("a real budget brake closes the run and resume creates a new independently metered run", async () => {
  const r = run();
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  mkdirSync(join(process.env.KANBAN_AGENTS_DIR, "fixture"), { recursive: true });
  put(join(process.env.KANBAN_AGENTS_DIR, "fixture", `${r.agentId}.json`), { id: r.agentId, lastStatus: "idle", cwd: dir });
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(r.agentId, r.taskId);
  const config = { autoStart: {}, supervisors: {}, supervisorAgentId: null, concurrency: DEFAULT_CONCURRENCY, runBudget: { maxTurns: 1 } };
  saveConfig(config); quota(12, end);
  await scanRunBudgets({ now: new Date(end), config, interrupt: async () => {}, read: async () => ({ source: "fixture", complete: true, notes: [],
    turns: [{ id: "call", at: "2026-10-01T10:01:00Z", text: "Done", tools: [], inputTokens: 20, outputTokens: 10 }] }) });
  assert.equal(getTask(r.taskId).status, "blocked");
  const first = publishRunCosts(getDb(), dir).records;
  assert.equal(first.length, 1); assert.equal(first[0].tokensIn, 20);
  unblockTask(r.taskId, "supervisor");
  const runs = getDb().prepare("SELECT id, ended_at FROM runs WHERE task_id = ? ORDER BY id").all(r.taskId);
  assert.equal(runs.length, 2); assert.equal(runs[1].ended_at, null);
  getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = 'complete' WHERE id = ?").run(new Date().toISOString(), runs[1].id);
  const costs = publishRunCosts(getDb(), dir).records;
  assert.equal(costs.length, 2); assert.equal(costs[1].tokensIn, null, "the old generation is not charged again");
});

test("future or malformed quota readings are unknown and end records publish after commit", async () => {
  const r = run();
  quota(20, "2026-10-01T12:00:00Z");
  getDb().prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(end, r.id);
  await Promise.resolve();
  const file = JSON.parse(readFileSync(join(dir, "fleet/run-costs.json"), "utf8"));
  assert.equal(file.records[0].quotaPctAfter, null);
  assert.equal(file.records[0].source, "partial");
  const b = run();
  put(join(dir, "fleet/pool-status.json"), { pools: { demo: 20 } });
  getDb().prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(end, b.id);
  assert.equal(publishRunCosts(getDb(), dir).records[1].quotaPctAfter, null);
});
test("an unchanged quota sample cannot claim measured cost", () => {
  const r = run(); budget(r);
  quota(10, start);
  getDb().prepare("UPDATE run_budget_state SET state_json = json_set(state_json, '$.observedAt', ?) WHERE task_id = ?")
    .run("2026-10-01T10:59:59Z", r.taskId);
  getDb().prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(end, r.id);
  const [cost] = publishRunCosts(getDb(), dir).records;
  assert.equal(cost.quotaPctDelta, null, "reusing one reading is not a measured zero");
  assert.equal(cost.source, "partial");
  assert.ok(cost.notes.some(note => /no new quota reading/i.test(note)));
});

test("a normal completion uses a recent complete snapshot without requiring identical milliseconds", () => {
  const r = run(); budget(r);
  getDb().prepare("UPDATE run_budget_state SET state_json = json_set(state_json, '$.observedAt', ?) WHERE task_id = ?")
    .run("2026-10-01T10:59:55Z", r.taskId);
  const [cost] = finish(r.id);
  assert.equal(cost.source, "measured"); assert.equal(cost.tokensIn, 900); assert.equal(cost.tokensOut, 100);
  assert.equal(cost.quotaPctDelta, 2);
  assert.ok(!cost.notes.some(note => /final interval|lower bound/i.test(note)));
});
for (const [status, at] of [
  ["partial", "2026-10-01T10:59:55Z"],
  ["available", "2026-10-01T10:55:00Z"],
  ["available", "2026-10-01T11:00:01Z"],
  ["available", "invalid"],
]) test(`incomplete or unsampled ending stays partial: ${status}, ${at}`, () => {
  const r = run(); budget(r, status);
  getDb().prepare("UPDATE run_budget_state SET state_json = json_set(state_json, '$.observedAt', ?) WHERE task_id = ?").run(at, r.taskId);
  const [cost] = finish(r.id);
  assert.equal(cost.source, "partial"); assert.equal(cost.tokensIn, 900);
  assert.ok(cost.notes.some(note => /lower bound/i.test(note)));
});

function assignedRun() {
  const r = run(); budget(r);
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(r.agentId, r.agentId, r.taskId);
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  mkdirSync(join(process.env.KANBAN_AGENTS_DIR, "fixture"), { recursive: true });
  put(join(process.env.KANBAN_AGENTS_DIR, "fixture", `${r.agentId}.json`), { id: r.agentId, lastStatus: "idle", cwd: dir });
  return r;
}
async function tailScan(count = 1) {
  const now = new Date(Date.now() + 1000);
  await scanRunBudgets({ now, config: { autoStart: {}, supervisors: {}, supervisorAgentId: null, concurrency: DEFAULT_CONCURRENCY },
    interrupt: async () => { throw new Error("This fixture must not brake"); },
    read: async () => ({ source: "fixture", complete: true, notes: [], turns: Array.from({ length: count }, (_, i) => ({
      id: `tail-${i}`, at: now.toISOString(), text: "Progress", tools: [], inputTokens: 50, outputTokens: 5, cachedInputTokens: 20,
    })) }) });
}
function finishResumed(r: ReturnType<typeof run>) {
  const ended = new Date(Date.now() + 5000).toISOString();
  quota(12, ended);
  getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = 'complete' WHERE id = ?").run(ended, r.id);
  return publishRunCosts(getDb(), dir).records.find(cost => cost.runId === r.id)!;
}
for (const via of [undefined, "quota_wait"]) test(`unblock retains the open run's pre-reset usage: ${via ?? "manual"}`, () => {
  const r = assignedRun();
  blockTask(r.taskId, "needs_human", "Demo decision", "executor");
  unblockTask(r.taskId, "supervisor", via ? { via } : undefined);
  assert.equal(runBudgetSnapshot(r.taskId), null);
  assert.equal(getDb().prepare("SELECT ended_at FROM runs WHERE id = ?").get(r.id)!.ended_at, null);
  const cost = finishResumed(r);
  assert.equal(cost.tokensIn, 900); assert.equal(cost.tokensOut, 100); assert.equal(cost.tokensCached, 400); assert.equal(cost.turns, 3);
  assert.equal(cost.source, "partial", "the reset-to-completion interval has no new observation");
});
test("usage before unblock is added to the new generation without counting repeat scans twice", async () => {
  const r = assignedRun();
  blockTask(r.taskId, "needs_human", "Demo decision", "executor"); unblockTask(r.taskId, "supervisor", { via: "quota_wait" });
  await tailScan(2); await tailScan(2);
  const cost = finishResumed(r);
  assert.equal("budgetGenerations" in cost, false, "private checkpoints must not leak into exported records");
  assert.equal(cost.tokensIn, 1000); assert.equal(cost.tokensOut, 110); assert.equal(cost.tokensCached, 440); assert.equal(cost.turns, 5);
});
test("repeated reset and a final snapshot from the carried generation count it only once", async () => {
  const r = assignedRun();
  blockTask(r.taskId, "needs_human", "Demo decision", "executor"); unblockTask(r.taskId, "supervisor");
  await tailScan(2);
  const tail = runBudgetSnapshot(r.taskId)!;
  const restore = () => getDb().prepare("INSERT OR REPLACE INTO run_budget_state VALUES (?,?,?)").run(r.taskId, tail.generation, JSON.stringify(tail));
  resetRunBudget(r.taskId); restore(); resetRunBudget(r.taskId); resetRunBudget(r.taskId); restore();
  const cost = finishResumed(r);
  assert.equal("budgetGenerations" in cost, false, "private checkpoints must not leak into exported records");
  assert.equal(cost.tokensIn, 1000); assert.equal(cost.tokensOut, 110); assert.equal(cost.tokensCached, 440); assert.equal(cost.turns, 5);
});
test("scanner generation changes carry the prior state before deleting its turns", async () => {
  const r = assignedRun();
  const old = runBudgetSnapshot(r.taskId)!;
  getDb().prepare("INSERT INTO run_budget_turns VALUES (?,?,?,?,?,?)")
    .run(r.taskId, old.generation, "fixture", "old-call", start, JSON.stringify({ id: "old-call", at: start, tools: [], inputTokens: 900, outputTokens: 100, cachedInputTokens: 400 }));
  appendEvent(r.taskId, "resumed", "blocked", "running", "scheduler", {}, new Date().toISOString());
  await tailScan();
  assert.notEqual(runBudgetSnapshot(r.taskId)!.generation, old.generation);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM run_budget_turns WHERE generation = ?").get(old.generation)!.n, 0);
  const cost = finishResumed(r);
  assert.equal(cost.tokensIn, 950); assert.equal(cost.tokensOut, 105); assert.equal(cost.tokensCached, 420); assert.equal(cost.turns, 4);
});
for (const resumed of [false, true]) test(`leader rework closes with all usage before reset: resumed=${resumed}`, async () => {
  const r = assignedRun();
  if (resumed) {
    blockTask(r.taskId, "needs_human", "Demo decision", "executor"); unblockTask(r.taskId, "supervisor");
    await tailScan();
  }
  blockTask(r.taskId, "needs_human", "Demo decision", "executor");
  await leaderReworkTask(r.taskId, "Fix the demo", { presence: () => "idle" });
  assert.equal(runBudgetSnapshot(r.taskId), null);
  assert.equal(getDb().prepare("SELECT end_kind FROM runs WHERE id = ?").get(r.id)!.end_kind, "leader_rework");
  const cost = publishRunCosts(getDb(), dir).records.find(cost => cost.runId === r.id)!;
  assert.equal(cost.tokensIn, resumed ? 950 : 900); assert.equal(cost.tokensOut, resumed ? 105 : 100);
  assert.equal(cost.tokensCached, resumed ? 420 : 400); assert.equal(cost.turns, resumed ? 4 : 3);
});

test("cost records canonicalize both legacy profile pools and historical exports", () => {
  put(process.env.KANBAN_PASEO_CONFIG!, { daemon: { agentProfiles: [{ name: "Demo", pool: "supergrok", provider: "grok", model: "grok-demo" }] } });
  const task = createTask({ project: "demo", title: "Shared cost fixture", role: "executor", tier: "L3" });
  put(join(dir, "fleet/pool-status.json"), { generatedAt: start, pools: { "x-ultra": { usedPct: 10, observedAt: start, resetsAt: "2026-10-08T00:00:00Z" } } });
  const id = Number(getDb().prepare("INSERT INTO runs (task_id,agent_id,role,profile_name,provider,model,started_at) VALUES (?,?,'executor','Demo','grok','grok-demo',?)").run(task.id, "demo-shared-agent", start).lastInsertRowid);
  put(join(dir, "fleet/pool-status.json"), { generatedAt: end, pools: { "x-ultra": { usedPct: 12, observedAt: end, resetsAt: "2026-10-08T00:00:00Z" } } });
  getDb().prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(end, id);
  const record = publishRunCosts(getDb(), dir).records[0];
  assert.equal(record.pool, "x-ultra"); assert.equal(record.quotaPctDelta, 2);
  getDb().prepare("UPDATE run_cost_snapshots SET record_json = json_set(record_json, '$.pool', 'cursor') WHERE run_id = ?").run(id);
  assert.equal(publishRunCosts(getDb(), dir).records[0].pool, "x-ultra");
});
