import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";
import { setLanguage } from "../shared/i18n";
import { DEFAULT_CONCURRENCY, parseConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { setWakeSender } from "../server/bus";
import { appendEvent, blockTask, createTask, getTask, unblockTask } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { scanRunBudgets, runBudgetSnapshot, type BudgetObservation } from "../server/run-budget";
import { parseCodexBudget, parseCanonicalBudget } from "../server/run-budget-source";
import { DEFAULT_RUN_BUDGET, effectiveRunBudget } from "../server/run-budget-config";

mkdirSync(tmpdir(), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "run-budget-"));
process.env.KANBAN_DATA_DIR = join(root, "board");
process.env.KANBAN_AGENTS_DIR = join(root, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
const now = new Date("2026-10-01T12:00:00Z");
const started = "2026-10-01T11:00:00Z";
let config: KanbanConfig;
let stopped: string[];
let sent: Array<{ id: string; text: string }>;

beforeEach(() => {
  closeDb();
  process.env.KANBAN_DATA_DIR = mkdtempSync(join(root, "board-"));
  setLanguage("en");
  config = { autoStart: {}, supervisors: { demo: "project-leader" }, supervisorAgentId: "board-leader", concurrency: DEFAULT_CONCURRENCY };
  saveConfig(config);
  stopped = [];
  sent = [];
  setAgentAliveCheck(() => true);
  setWakeSender((id, text) => { sent.push({ id, text }); });
});
after(() => { resetAgentAliveCheck(); closeDb(); rmSync(root, { recursive: true, force: true }); });

function card(role = "executor", status = "running") {
  const task = createTask({ project: "demo", title: "Budget fixture", role, createdByAgent: "stale-creator" });
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = ? WHERE id = ?").run(status, `agent-${task.id}`, task.id);
  mkdirSync(join(process.env.KANBAN_AGENTS_DIR!, "fixture"), { recursive: true });
  writeFileSync(join(process.env.KANBAN_AGENTS_DIR!, "fixture", `agent-${task.id}.json`), JSON.stringify({ id: `agent-${task.id}`, lastStatus: "idle", cwd: root }));
  appendEvent(task.id, "started", "ready", status, "scheduler", {}, started);
  return task.id;
}
function observation(count = 1, waiting = false, tokens = 100): BudgetObservation {
  return { source: "fixture", complete: true, notes: [], turns: Array.from({ length: count }, (_, i) => ({
    id: `call-${i}`, at: new Date(Date.parse(started) + (i + 1) * 1000).toISOString(),
    text: waiting ? "Continue waiting" : `Finished step ${i}`,
    tools: [{ name: waiting ? "functions.wait" : "functions.exec_command", command: waiting ? undefined : "npm test" }],
    inputTokens: tokens, outputTokens: 10, cachedInputTokens: Math.floor(tokens / 2),
  })) };
}
async function scan(sample = observation(), extra: Partial<Parameters<typeof scanRunBudgets>[0]> = {}) {
  await scanRunBudgets({ now, config, read: async () => sample, interrupt: async id => { stopped.push(id); }, ...extra });
}
function count(kind: string) {
  return Number((getDb().prepare("SELECT count(*) AS n FROM events WHERE kind = ?").get(kind) as { n: number }).n);
}

it("uses conservative defaults, project overrides and one-run card overrides", () => {
  assert.deepEqual(DEFAULT_RUN_BUDGET, { maxDurationMs: 10_800_000, maxTurns: 150, maxTokens: 30_000_000, maxConsecutiveWaits: 8 });
  const parsed = parseConfig({ runBudget: { maxTurns: 200 }, projects: { demo: { defaultWorkspace: "dir", runBudget: { maxTurns: 250 } } } });
  assert.equal(effectiveRunBudget("demo", parsed).maxTurns, 250);
  assert.equal(effectiveRunBudget("demo", parsed, { maxTurns: 300 }).maxTurns, 300);
  assert.throws(() => parseConfig({ runBudget: { maxTurns: -1 } }));
  assert.throws(() => parseConfig({ runBudget: { maxTokens: Infinity } }));
});
for (const [metric, limits, sample] of [
  ["duration", { maxDurationMs: 3_000_000 }, observation()],
  ["turns", { maxTurns: 2 }, observation(3)],
  ["tokens", { maxTokens: 200 }, observation(2)],
  ["wait", { maxConsecutiveWaits: 2 }, observation(3, true)],
] as const) {
  it(`brakes on ${metric}, preserves the agent and notifies the registered project leader`, async () => {
    const id = card(); config.runBudget = limits;
    await scan(sample);
    assert.equal(getTask(id).status, "blocked");
    assert.equal(getTask(id).blocked_kind, "needs_human");
    assert.equal(getTask(id).agent_id, `agent-${id}`);
    assert.deepEqual(stopped, [`agent-${id}`]);
    assert.equal(count("run_budget_braked"), 1);
    assert.equal(sent.filter(x => x.id === "project-leader").length, 1);
    assert.equal(sent.some(x => x.id === "stale-creator" || x.id === "board-leader"), false);
    assert.match(getTask(id).blocked_reason!, /actual|limit/);
    assert.match(getTask(id).blocked_reason!, /Recent/);
    await scan(sample);
    assert.equal(stopped.length, 1);
    assert.equal(sent.length, 1);
  });
}
it("covers execution, batch and reviewing cards without false braking below limits", async () => {
  const ids = [card(), card("batch"), card("reviewer", "reviewing")];
  await scan(observation(2));
  for (const id of ids) assert.ok(["running", "reviewing"].includes(getTask(id).status));
  assert.equal(stopped.length, 0);
  config.runBudget = { maxTurns: 1 };
  await scan(observation(2));
  assert.equal(stopped.length, 3);
});
it("writes one 80 percent warning and one leader notification per generation", async () => {
  const id = card(); config.runBudget = { maxTurns: 10 };
  await scan(observation(8)); await scan(observation(9)); await scan(observation(9));
  assert.equal(count("run_budget_warning"), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "project-leader");
  assert.equal(getTask(id).status, "running");
});
it("does not count cache reads twice and labels unavailable usage", async () => {
  const id = card(); await scan(observation(2));
  const state = runBudgetSnapshot(id)!;
  assert.equal(state.tokens, 220); assert.equal(state.cachedInputTokens, 100);
  const unknown = observation(3);
  for (const turn of unknown.turns) { delete turn.inputTokens; delete turn.outputTokens; delete turn.cachedInputTokens; }
  await scan(unknown); await scan(unknown);
  assert.match(JSON.stringify(runBudgetSnapshot(id)), /unavailable|partial/);
  assert.equal(count("run_budget_degraded"), 1);
});
it("deduplicates overlapping observations and resets a wait streak on productive work", async () => {
  const id = card(); config.runBudget = { maxConsecutiveWaits: 3 };
  await scan(observation(2, true)); await scan(observation(2, true));
  assert.equal(runBudgetSnapshot(id)!.turns, 2);
  const progress = observation(1); progress.turns[0].id = "progress"; progress.turns[0].at = "2026-10-01T11:01:00Z";
  await scan(progress);
  assert.equal(runBudgetSnapshot(id)!.consecutiveWaits, 0);
  assert.equal(stopped.length, 0);
});
it("excludes board-side background waits, including samples read after the wait ended", async () => {
  const id = card(); config.runBudget = { maxTurns: 1, maxConsecutiveWaits: 1 };
  appendEvent(id, "background_wait_started", "running", "running", "scheduler", { agentId: `agent-${id}` }, started);
  await scan(observation(4, true), { backgroundWaiting: () => true });
  assert.equal(runBudgetSnapshot(id)!.turns, 0);
  appendEvent(id, "background_wait_finished", "running", "running", "scheduler", { agentId: `agent-${id}` }, "2026-10-01T11:10:00Z");
  await scan(observation(4, true));
  assert.equal(runBudgetSnapshot(id)!.turns, 0);
  assert.equal(stopped.length, 0);
});
it("counts wall clock during background waits", async () => {
  const id = card(); config.runBudget = { maxDurationMs: 1_000 };
  await scan(observation(4, true), { backgroundWaiting: () => true });
  assert.equal(getTask(id).status, "blocked");
});
it("starts a fresh generation after unblock and consumes a one-run override with an audit", async () => {
  const id = card(); config.runBudget = { maxTurns: 1 }; await scan(observation(2));
  const old = runBudgetSnapshot(id)!.generation;
  unblockTask(id, "supervisor", { runBudget: { maxTurns: 5 }, reason: "One more attempt" });
  assert.equal(runBudgetSnapshot(id), null);
  await scan(observation(2), { now: new Date() });
  const state = runBudgetSnapshot(id)!;
  assert.notEqual(state.generation, old); assert.equal(state.turns, 0);
  assert.equal(state.limits.maxTurns, 5);
  assert.equal(count("run_budget_override"), 1);
  assert.equal(getTask(id).status, "running");
});
it("does not apply an observation from before an unblock or agent replacement", async () => {
  const id = card(); config.runBudget = { maxTurns: 1 };
  await scan(observation(2), { read: async () => {
    blockTask(id, "needs_human", "fixture", "supervisor"); unblockTask(id, "supervisor");
    getDb().prepare("UPDATE tasks SET agent_id = 'replacement' WHERE id = ?").run(id);
    return observation(2);
  } });
  assert.equal(getTask(id).status, "running"); assert.equal(stopped.length, 0);
});
it("concurrent ticks reserve the brake once", async () => {
  const id = card(); config.runBudget = { maxTurns: 1 };
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  const read = async () => { reads++; await gate; return observation(3); };
  const a = scan(observation(), { read }); const b = scan(observation(), { read });
  finish(); await Promise.all([a, b]);
  assert.equal(reads, 1); assert.equal(stopped.length, 1);
  assert.equal(count("run_budget_braked"), 1); assert.equal(sent.length, 1);
  assert.equal(getTask(id).status, "blocked");
});

it("counts Codex model calls inside one outer turn, deduplicating repeated usage events", () => {
  const lines = [];
  for (let i = 1; i <= 3; i++) {
    lines.push({ timestamp: started, type: "response_item", payload: { type: "function_call", name: "functions.wait", arguments: '{"cell_id":"fixture"}' } });
    const event = { timestamp: started, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: i * 100, output_tokens: i * 10, cached_input_tokens: i * 50 }, last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 } } } };
    lines.push(event, event);
  }
  const parsed = parseCodexBudget(lines.map(x => JSON.stringify(x)).join("\n"));
  assert.equal(parsed.turns.length, 3);
  assert.equal(parsed.turns.reduce((n, x) => n + x.inputTokens! + x.outputTokens!, 0), 330);
  assert.equal(parsed.turns.every(x => x.tools[0].name === "functions.wait"), true);
});
it("canonical fallback distinguishes waiting tools from real commands and marks tokens unavailable", () => {
  const parsed = parseCanonicalBudget([
    { seqStart: 1, seqEnd: 1, timestamp: started, turnId: "outer", item: { type: "assistant_message", text: "Continue waiting" } },
    { seqStart: 2, seqEnd: 2, timestamp: started, turnId: "outer", item: { type: "tool_call", name: "functions.wait", detail: {} } },
    { seqStart: 3, seqEnd: 3, timestamp: started, turnId: "outer", item: { type: "assistant_message", text: "Running tests" } },
    { seqStart: 4, seqEnd: 4, timestamp: started, turnId: "outer", item: { type: "tool_call", name: "functions.exec_command", detail: { type: "shell", command: "npm test" } } },
  ], true);
  assert.equal(parsed.turns.length, 2);
  assert.equal(parsed.turns[0].inputTokens, undefined);
  assert.match(parsed.notes.join(" "), /unavailable/);
});

it("retries failed warning delivery without duplicating the warning comment", async () => {
  card(); config.runBudget = { maxTurns: 10 };
  setWakeSender(() => { throw new Error("fixture send rejected"); });
  await scan(observation(8));
  setWakeSender((id, text) => { sent.push({ id, text }); });
  await scan(observation(8)); await scan(observation(8));
  assert.equal(count("run_budget_warning"), 1); assert.equal(sent.length, 1);
});
it("retains a brake across a scheduler reload and retries a failed stop without another brake", async () => {
  const id = card(); config.runBudget = { maxTurns: 1 };
  await scan(observation(2), { interrupt: async () => { throw new Error("offline stop"); } });
  assert.equal(runBudgetSnapshot(id)!.interrupted, undefined);
  closeDb();
  await scan(observation(2), { now: new Date(now.getTime() + 60_000) });
  assert.equal(runBudgetSnapshot(id)!.interrupted, true);
  assert.equal(count("run_budget_braked"), 1); assert.equal(stopped.length, 1);
});
it("rejects unblock while the stop is in flight, then allows it after the stop settles", async () => {
  const id = card(); config.runBudget = { maxTurns: 1 };
  await scan(observation(2), { interrupt: async () => {
    assert.throws(() => unblockTask(id, "supervisor"), /pending/);
    stopped.push(`agent-${id}`);
  } });
  assert.doesNotThrow(() => unblockTask(id, "supervisor"));
});
it("resets counters after rework and does not carry an unblock override into another run", async () => {
  const id = card(); config.runBudget = { maxTurns: 1 }; await scan(observation(2));
  unblockTask(id, "supervisor", { runBudget: { maxTurns: 10 }, reason: "fixture" });
  await scan(observation(2), { now: new Date() });
  const prior = runBudgetSnapshot(id)!.generation;
  getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(id);
  appendEvent(id, "leader_rework", "running", "rework", "supervisor");
  getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id);
  appendEvent(id, "resumed", "rework", "running", "scheduler");
  await scan(observation(2), { now: new Date() });
  assert.notEqual(runBudgetSnapshot(id)!.generation, prior);
  assert.equal(runBudgetSnapshot(id)!.turns, 0);
  assert.equal(runBudgetSnapshot(id)!.limits.maxTurns, 1);
});
it("does not mistake a productive command with a repeated waiting reply for a wait round", async () => {
  const id = card(); config.runBudget = { maxConsecutiveWaits: 2 };
  const sample = observation(5, true);
  for (const turn of sample.turns) turn.tools = [{ name: "functions.exec_command", command: "npm run build" }];
  await scan(sample);
  assert.equal(getTask(id).status, "running");
  assert.equal(runBudgetSnapshot(id)!.consecutiveWaits, 0);
});
it("enforces wall clock even when activity collection fails", async () => {
  const id = card(); config.runBudget = { maxDurationMs: 1_000 };
  await scan(observation(), { read: async () => { throw new Error("offline activity"); } });
  assert.equal(getTask(id).status, "blocked");
  assert.equal(count("run_budget_degraded"), 1);
});
it("the scheduler invokes the budget brake before stall/reconcile can nudge it", async () => {
  const { runTick } = await import("./helpers/compat-schedule");
  const id = card(); config.runBudget = { maxTurns: 1 };
  const result = await runTick({ now, config, profiles: [], agentState: () => "alive",
    launcher: { create: async () => ({ id: "unused" }), send: async () => { throw new Error("must not nudge"); } },
    agentBudget: async () => observation(2), interruptAgent: async id => { stopped.push(id); },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(getTask(id).status, "blocked");
  assert.equal(stopped.length, 1);
  assert.equal(sent.length, 1);
});

it("R1 background registration and automatic resume retain the same budget generation", async () => {
  const id = card(); config.runBudget = { maxTurns: 3 };
  await scan(observation(1)); const generation = runBudgetSnapshot(id)!.generation;
  getDb().prepare("UPDATE tasks SET status = 'blocked', blocked_kind = 'background', blocked_from = 'running' WHERE id = ?").run(id);
  appendEvent(id, "background_wait", "running", "blocked", "executor", { agentId: `agent-${id}` }, "2026-10-01T11:00:02Z");
  await scan(observation(4, true));
  assert.equal(runBudgetSnapshot(id)!.turns, 1);
  getDb().prepare("UPDATE tasks SET status = 'running', blocked_kind = NULL WHERE id = ?").run(id);
  appendEvent(id, "unblocked", "blocked", "running", "scheduler", { via: "background_wait" }, "2026-10-01T11:10:00Z");
  appendEvent(id, "background_resumed", "blocked", "running", "scheduler", { agentId: `agent-${id}` }, "2026-10-01T11:10:00Z");
  const sample = observation(4, true);
  sample.turns.push({ id: "after-background", at: "2026-10-01T11:20:00Z", text: "Built successfully", tools: [], inputTokens: 10, outputTokens: 1 });
  await scan(sample);
  assert.equal(runBudgetSnapshot(id)!.generation, generation);
  assert.equal(runBudgetSnapshot(id)!.turns, 2);
  assert.equal(runBudgetSnapshot(id)!.durationMs, 3_600_000);
  assert.equal(getTask(id).status, "running");
});
it("retains occupancy until a budget stop is confirmed", async () => {
  const { currentOccupancy } = await import("../server/routing");
  const id = card(); config.runBudget = { maxTurns: 1 };
  getDb().prepare("UPDATE tasks SET workspace_path = ?, workspace_kind = 'dir' WHERE id = ?").run(root, id);
  await scan(observation(2), { interrupt: async () => { throw new Error("offline stop"); } });
  assert.equal(currentOccupancy([]).global, 1);
  assert.equal(currentOccupancy([]).workspaces.has(root), true);
  await scan(observation(2), { now: new Date(now.getTime() + 60_000) });
  assert.equal(currentOccupancy([]).global, 0);
  assert.equal(currentOccupancy([]).workspaces.has(root), false);
});
it("scopes warning receipts and in-flight sends to the run generation", async () => {
  const id = card(); config.runBudget = { maxTurns: 10 };
  const resolve: Array<() => void> = [];
  setWakeSender(() => new Promise<void>(done => { resolve.push(done); }));
  await scan(observation(8));
  const old = runBudgetSnapshot(id)!.generation;
  getDb().prepare("INSERT INTO runs (task_id,agent_id,role,started_at) VALUES (?,?,'executor',?)").run(id, `agent-${id}`, "2026-10-01T11:30:00Z");
  const sample = observation(8); sample.turns.forEach((turn, i) => { turn.at = new Date(Date.parse("2026-10-01T11:31:00Z") + i * 1000).toISOString(); });
  await scan(sample);
  assert.notEqual(runBudgetSnapshot(id)!.generation, old);
  assert.equal(resolve.length, 2);
  resolve[0](); await new Promise(done => setImmediate(done));
  assert.equal(count("wake_run_budget_warning"), 0);
  resolve[1](); await new Promise(done => setImmediate(done));
  await scan(sample);
  assert.equal(count("wake_run_budget_warning"), 1);
  assert.equal(resolve.length, 2);
});
it("deduplicates a generation warning delivered to the existing fallback leader", async () => {
  card(); config.runBudget = { maxTurns: 10 }; config.supervisors = {}; saveConfig(config);
  await scan(observation(8)); await scan(observation(9));
  assert.equal(sent.length, 1); assert.equal(sent[0].id, "board-leader");
});
