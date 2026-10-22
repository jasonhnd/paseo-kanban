/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { runKanban } from "../server/cli";
import { cardMarkOf } from "../server/card-ref";
import { resumeBackgroundWaits } from "../server/background-wait";
import { closeDb, getDb } from "../server/db";
import { protocolFor } from "../server/protocol";
import { loadConfig } from "../server/config";
import { appendEvent, claimStatus, createTask, getDetail, getTask, unblockTask } from "../server/store";
import { runTick, resetReconcileForTests } from "../server/schedule";
import { setLanguage } from "../shared/i18n";
import { attentionOf, cardHint } from "../shared/board-view";
import { runDoctor } from "../server/doctor";
import { currentOccupancy } from "../server/routing";
import { runBudgetSnapshot, type BudgetObservation } from "../server/run-budget";

let dir: string;
let cardTmp: string;
let id: number;
let marker: string;
let log: string;
const env = { PASEO_AGENT_ID: "background-agent" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "background-wait-"));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  mkdirSync(join(dir, "agents", "bucket"), { recursive: true });
  writeFileSync(join(dir, "agents", "bucket", "background-agent.json"), JSON.stringify({ id: env.PASEO_AGENT_ID, cwd: dir, lastStatus: "idle" }));
  writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ autoStart: { demo: false } }));
  const task = createTask({ project: "demo", title: "Long build", role: "executor", workspacePath: dir });
  id = task.id;
  claimStatus(id, "ready", "running", "test");
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(env.PASEO_AGENT_ID, id);
  cardTmp = join(dir, cardMarkOf(getTask(id)));
  mkdirSync(cardTmp);
  appendEvent(id, "card_tmp_prepared", null, null, "scheduler", { path: cardTmp });
  marker = join(cardTmp, "build.exit");
  log = join(cardTmp, "build.log");
  setLanguage("en");
  resetReconcileForTests();
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  setLanguage("zh-CN");
});

const register = () => runKanban(["wait-bg", marker, "--card", String(id), "--log", log], env);

it("releases model capacity while retaining the directory used by the background writer", async () => {
  await register();
  const occupancy = currentOccupancy([]);
  assert.equal(occupancy.global, 0);
  assert.equal(occupancy.workspaces.has(dir), true);
  writeFileSync(marker, "0\n");
  await resumeBackgroundWaits(new Date(), async () => {});
  assert.equal(currentOccupancy([]).global, 1);
});

it("keeps R3 accounting and unconfirmed-stop capacity across a real background wait", async context => {
  const start = Date.now();
  context.mock.timers.enable({ apis: ["Date"], now: start });
  const config = loadConfig();
  config.runBudget = { maxTurns: 3 };
  const profile = { id: "fixture", name: "Fixture executor", provider: "codex", role: "executor", pool: "demo" };
  getDb().prepare("INSERT INTO runs (task_id,agent_id,role,profile_name,started_at) VALUES (?,?,'executor',?,?)")
    .run(id, env.PASEO_AGENT_ID, profile.name, new Date(start).toISOString());
  const sample: BudgetObservation = { source: "fixture", complete: true, notes: [], turns: [
    { id: "initial", at: new Date(start).toISOString(), text: "Start build", tools: [], inputTokens: 10, outputTokens: 1 },
  ] };
  let reads = 0;
  let stops = 0;
  let wakes = 0;
  const tick = () => runTick({
    now: new Date(), profiles: [profile], config, matrix: { state: "missing" },
    launcher: { async create() { throw new Error("unexpected model creation"); }, async send() { throw new Error("unexpected nudge"); } },
    agentState: () => "alive", agentActivity: () => ({ state: "busy", lastAt: new Date().toISOString() }),
    agentBudget: async () => { reads++; return sample; },
    interruptAgent: async agent => {
      assert.equal(agent, env.PASEO_AGENT_ID);
      if (++stops === 1) throw new Error("stop not confirmed");
    },
    send: async agent => { assert.equal(agent, env.PASEO_AGENT_ID); wakes++; },
    pools: { state: "fresh", message: "", generatedAt: null, dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }) },
  });
  assert.deepEqual((await tick()).errors, []);
  const generation = runBudgetSnapshot(id)!.generation;
  context.mock.timers.setTime(start + 2000);
  await register();
  for (let i = 0; i < 4; i++) sample.turns.push({
    id: `late-wait-${i}`, at: new Date(start + 3000 + i * 1000).toISOString(),
    text: "Continue waiting", tools: [{ name: "functions.wait" }], inputTokens: 1000, outputTokens: 1,
  });
  for (let minute = 1; minute <= 30; minute++) {
    context.mock.timers.setTime(start + minute * 60_000);
    assert.deepEqual((await tick()).errors, []);
  }
  assert.equal(reads, 1, "the budget collector also stays asleep during a registered wait");
  assert.equal(wakes, 0);
  assert.equal(currentOccupancy([profile]).global, 0);
  assert.equal(currentOccupancy([profile]).workspaces.has(dir), true);
  writeFileSync(marker, "0\n");
  await tick();
  assert.equal(wakes, 1);
  assert.equal(runBudgetSnapshot(id)!.generation, generation);
  sample.turns.push({ id: "after", at: new Date(start + 1_801_000).toISOString(), text: "Check result", tools: [], inputTokens: 10, outputTokens: 1 });
  context.mock.timers.setTime(start + 1_802_000);
  await tick();
  assert.equal(runBudgetSnapshot(id)!.generation, generation);
  assert.equal(runBudgetSnapshot(id)!.turns, 2);
  assert.equal(runBudgetSnapshot(id)!.tokens, 22, "late timeline pages exclude the wait interval");
  assert.equal(runBudgetSnapshot(id)!.consecutiveWaits, 0);
  assert.equal(runBudgetSnapshot(id)!.durationMs, 1_802_000, "wall-clock budget survives the wait");
  sample.turns.push({ id: "third", at: new Date(start + 1_803_000).toISOString(), text: "Finish check", tools: [] });
  context.mock.timers.setTime(start + 1_804_000);
  await tick();
  assert.equal(getTask(id).blocked_kind, "needs_human");
  assert.equal(stops, 1);
  const pending = currentOccupancy([profile]);
  assert.equal(pending.global, 1);
  assert.equal(pending.byPool.demo, 1);
  assert.equal(pending.byRole.executor, 1);
  assert.equal(pending.workspaces.has(dir), true);
  context.mock.timers.setTime(start + 1_864_000);
  await tick();
  assert.equal(stops, 2);
  assert.equal(runBudgetSnapshot(id)!.interrupted, true);
  assert.deepEqual(currentOccupancy([profile]), { global: 0, byPool: {}, byRole: {}, workspaces: new Set() });
  assert.equal(wakes, 1, "budget retries never wake the executor");
});

it("waits thirty simulated minutes without model polling or stall wakes, then wakes once with exit code and log tail", async () => {
  await register();
  assert.equal(getTask(id).blocked_kind, "background");
  assert.match(getDetail(id).task.badge, /Waiting for background task/);
  assert.equal(attentionOf(getDetail(id).task, []), null);
  assert.equal(cardHint(getDetail(id).task)?.tone, "warning");
  const start = Date.now();
  const messages: string[] = [];
  let activityReads = 0;
  const tick = (minute: number) => runTick({
    now: new Date(start + minute * 60_000), profiles: [], config: loadConfig(), matrix: { state: "missing" },
    launcher: { async create() { throw new Error("unexpected model creation"); }, async send() {} },
    agentState: () => "alive", agentActivity: () => { activityReads++; return { state: messages.length ? "busy" : "idle", lastAt: new Date(start).toISOString() }; },
    stallIntervalMs: 0, stallIdleMs: 0,
    send: async (agent, text) => { assert.equal(agent, env.PASEO_AGENT_ID); messages.push(text); },
    pools: { state: "fresh", message: "", generatedAt: null, dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }) },
  });
  for (let minute = 0; minute < 30; minute++) {
    if (minute === 15) closeDb();
    await tick(minute);
    assert.equal(getTask(id).status, "blocked");
    assert.equal(messages.length, 0);
  }
  assert.equal(activityReads, 0, "background waits never enter the idle-agent scanner");
  const report = await runDoctor({ now: new Date(start + 4 * 3_600_000), wake: false, persist: false, sources: {} });
  assert.equal(report.findings.some(f => f.id === `card:blocked:${id}`), false);
  writeFileSync(log, "x".repeat(20_000) + "\nBuild finished\n");
  writeFileSync(marker + ".pending", "7\n");
  renameSync(marker + ".pending", marker);
  await tick(30);
  await tick(31);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /exit code: 7/);
  assert.match(messages[0], /Build finished/);
  assert.ok(messages[0].length < 10_000);
  assert.equal(getTask(id).status, "running");
  assert.ok(1 + messages.length <= 10, "one initial turn plus one completion turn");
});

it("deduplicates concurrent ticks and retries an ambiguous send with the same persisted receipt and text", async () => {
  await register();
  writeFileSync(marker, "0\n");
  writeFileSync(log, "first result");
  const accepted = new Set<string>();
  const attempts: Array<{ id: string; text: string }> = [];
  const send: Parameters<typeof resumeBackgroundWaits>[1] = async (_agent, text, options) => {
    assert.ok(options?.messageId);
    accepted.add(options.messageId);
    attempts.push({ id: options.messageId, text });
    if (attempts.length === 1) throw new Error("acknowledgement lost");
  };
  await resumeBackgroundWaits(new Date(), send);
  assert.equal(getTask(id).status, "blocked");
  closeDb();
  setLanguage("zh-CN");
  writeFileSync(log, "changed after send");
  await Promise.all([resumeBackgroundWaits(new Date(), send), resumeBackgroundWaits(new Date(), send)]);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(accepted.size, 1);
  assert.equal(getTask(id).status, "running");
});

it("keeps a manual replacement wait intact and never wakes a cancelled or reassigned wait", async () => {
  await register();
  writeFileSync(marker, "0\n");
  await resumeBackgroundWaits(new Date(), async () => {
    unblockTask(id, "supervisor");
    await register();
  });
  assert.equal(getTask(id).status, "blocked");
  let wakes = 0;
  getDb().prepare("UPDATE tasks SET agent_id = 'replacement-agent' WHERE id = ?").run(id);
  await resumeBackgroundWaits(new Date(), async () => { wakes++; });
  assert.equal(wakes, 0);
  unblockTask(id, "supervisor");
  await resumeBackgroundWaits(new Date(), async () => { wakes++; });
  assert.equal(wakes, 0);
});

it("authorizes only the assigned worker and confines marker and log reads to its prepared temporary directory", async () => {
  await assert.rejects(() => runKanban(["wait-bg", marker, "--card", String(id)], { PASEO_AGENT_ID: "stranger" }));
  await assert.rejects(() => runKanban(["wait-bg", join(dir, "outside.exit"), "--card", String(id)], env));
  await assert.rejects(() => runKanban(["wait-bg", marker, "--card", String(id), "--log", join(dir, "outside.log")], env));
  symlinkSync(dir, join(cardTmp, "escape"));
  await assert.rejects(() => runKanban(["wait-bg", join(cardTmp, "escape", "outside.exit"), "--card", String(id)], env));
  assert.equal(getTask(id).status, "running");
});

it("reports malformed markers once instead of silently waiting forever; missing transport retains the result", async () => {
  await register();
  writeFileSync(marker, "not an exit code");
  await resumeBackgroundWaits(new Date());
  assert.equal(getTask(id).status, "blocked");
  const messages: string[] = [];
  await resumeBackgroundWaits(new Date(), async (_id, text) => { messages.push(text); });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /invalid completion marker/i);
});

it("injects the no-polling rule and wait-bg usage for every role in both languages", () => {
  for (const language of ["en", "zh-CN"] as const) {
    for (const role of ["executor", "reviewer", "reader", "decision", "batch", "supervisor"]) {
      const text = protocolFor(role, { language });
      assert.match(text, /wait-bg/);
      assert.match(text, language === "en" ? /Do not repeatedly (?:call )?wait\/sleep/ : /\u7981\u6b62\u53cd\u590d.*wait\/sleep/);
      assert.doesNotMatch(text, /sleep 60 loop|sleep 60 \u5faa\u73af/);
    }
  }
});
