/// <reference types="node" />
import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, it } from "node:test";
import { runKanban } from "../server/cli";
import { cardMarkOf } from "../server/card-ref";
import { backgroundProcesses } from "../server/background-process";
import { resumeBackgroundWaits } from "../server/background-wait";
import { configPath } from "../server/config-file";
import { closeDb, getDb } from "../server/db";
import { protocolFor } from "../server/protocol";
import { loadConfig, parseConfig, setProjectCode, setProjectWorkspace } from "../server/config";
import { appendEvent, claimStatus, createTask, getDetail, getTask, unblockTask } from "../server/store";
import { runTick, resetReconcileForTests } from "../server/schedule";
import { setLanguage } from "../shared/i18n";
import { attentionOf, cardHint } from "../shared/board-view";
import { runDoctor } from "../server/doctor";
import { currentOccupancy } from "../server/routing";
import { runBudgetSnapshot, type BudgetObservation } from "../server/run-budget";

let worker: ChildProcess;
let dir: string;
let cardTmp: string;
let id: number;
let marker: string;
let log: string;
const env = { PASEO_AGENT_ID: "background-agent" };
const invokingEnv = { ...process.env };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "background-wait-"));
  Object.assign(process.env, {
    KANBAN_DATA_DIR: dir, HOME: join(dir, "home"), PASEO_HOME: join(dir, "paseo"),
    KANBAN_PASEO_CONFIG: join(dir, "paseo/config.json"),
    XDG_CONFIG_HOME: join(dir, "home/config"), XDG_CACHE_HOME: join(dir, "cache"),
  });
  for (const path of ["home/config", "paseo", "cache"]) mkdirSync(join(dir, path), { recursive: true });
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  mkdirSync(join(dir, "agents", "bucket"), { recursive: true });
  writeFileSync(join(dir, "agents", "bucket", "background-agent.json"), JSON.stringify({ id: env.PASEO_AGENT_ID, cwd: dir, lastStatus: "idle" }));
  writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ autoStart: { demo: false } }));
  worker = spawn(process.execPath, ["-e", "process.send({ HOME: process.env.HOME, PASEO_HOME: process.env.PASEO_HOME, KANBAN_DATA_DIR: process.env.KANBAN_DATA_DIR }); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const inherited = once(worker, "message");
  await once(worker, "spawn");
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
  const [snapshot] = await inherited;
  assert.equal(snapshot.KANBAN_DATA_DIR, dir, "writer must inherit this case's data override");
  assert.equal(snapshot.HOME, join(dir, "home"));
  assert.equal(snapshot.PASEO_HOME, join(dir, "paseo"));
});

afterEach(async () => {
  if (worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, "exit");
    worker.kill("SIGKILL");
    await exited;
  }
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  setLanguage("zh-CN");
  for (const key of Object.keys(process.env)) if (!(key in invokingEnv)) delete process.env[key];
  Object.assign(process.env, invokingEnv);
});

const register = (extra: string[] = []) => runKanban(["wait-bg", marker, "--card", String(id), "--log", log, "--pid", String(worker.pid), ...extra], env);

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
  await assert.rejects(() => runKanban(["wait-bg", marker, "--card", String(id), "--pid", String(worker.pid)], { PASEO_AGENT_ID: "stranger" }));
  await assert.rejects(() => runKanban(["wait-bg", join(dir, "outside.exit"), "--card", String(id), "--pid", String(worker.pid)], env));
  await assert.rejects(() => runKanban(["wait-bg", marker, "--card", String(id), "--pid", String(worker.pid), "--log", join(dir, "outside.log")], env));
  symlinkSync(dir, join(cardTmp, "escape"));
  await assert.rejects(() => runKanban(["wait-bg", join(cardTmp, "escape", "outside.exit"), "--card", String(id), "--pid", String(worker.pid)], env));
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
      assert.match(text, /--pid/);
      assert.match(text, /--timeout-ms/);
      assert.match(text, /yield_time_ms\s*(?:>=|\u2265)\s*300000/);
      assert.match(text, language === "en" ? /Do not repeatedly (?:call )?wait\/sleep/ : /\u7981\u6b62\u53cd\u590d.*wait\/sleep/);
      assert.doesNotMatch(text, /sleep 60 loop|sleep 60 \u5faa\u73af/);
    }
    const workflow = readFileSync(new URL(`../docs/${language === "en" ? "" : "zh-CN/"}WORKFLOW.md`, import.meta.url), "utf8");
    assert.match(workflow, /yield_time_ms\s*(?:>=|\u2265)\s*300000/);
  }
});


it("requires a live owned process and rejects absent, malformed and unrelated pids", async () => {
  for (const args of [[], ["--pid", "0"], ["--pid", "1"], ["--pid", "99999999"], ["--pid", "1junk"]]) {
    await assert.rejects(() => runKanban(["wait-bg", marker, "--card", String(id), ...args], env));
  }
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;
  await assert.rejects(register);
  assert.equal(getTask(id).status, "running");
});

it("persists process identity and wakes once with a bounded tail when the process dies without a marker", async () => {
  await register();
  const wait = JSON.parse(getTask(id).background_wait_json!);
  assert.equal(wait.process.pid, worker.pid);
  assert.ok(wait.process.pgid > 0);
  assert.ok(wait.process.started);
  assert.equal(wait.maxWaitMs, 3 * 60 * 60 * 1000);
  writeFileSync(log, "x".repeat(20_000) + "\nKilled build\n");
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;
  closeDb(); // a service restart must not lose process identity
  const messages: string[] = [];
  const send = async (_agent: string, text: string) => { messages.push(text); };
  await Promise.all([resumeBackgroundWaits(new Date(), send), resumeBackgroundWaits(new Date(), send)]);
  await resumeBackgroundWaits(new Date(), send);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /process exited without writing an exit code/i);
  assert.match(messages[0], /Killed build/);
  assert.ok(Buffer.byteLength(messages[0]) < 9000);
  assert.equal(getTask(id).status, "running");
});

it("uses a durable wall-clock deadline after sleep and restart, without killing a live process", async () => {
  await register(["--timeout-ms", "1000"]);
  const start = Date.parse(getTask(id).blocked_at!);
  closeDb();
  const messages: string[] = [];
  const send = async (_agent: string, text: string) => { messages.push(text); };
  await resumeBackgroundWaits(new Date(start + 999), send);
  assert.equal(messages.length, 0);
  await resumeBackgroundWaits(new Date(start + 6 * 60 * 60 * 1000), send);
  await resumeBackgroundWaits(new Date(start + 7 * 60 * 60 * 1000), send);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /timed out/i);
  assert.doesNotThrow(() => process.kill(worker.pid!, 0));
});

it("does not mistake a reused pid or an unrelated live process group for the original process", async () => {
  await register();
  const wait = JSON.parse(getTask(id).background_wait_json!);
  wait.process.started = "different process start";
  getDb().prepare("UPDATE tasks SET background_wait_json = ? WHERE id = ?").run(JSON.stringify(wait), id);
  const messages: string[] = [];
  await resumeBackgroundWaits(new Date(), async (_agent, text) => { messages.push(text); });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /process exited without writing an exit code/i);
});

it("prioritizes an existing completion marker over death or timeout", async () => {
  await register(["--timeout-ms", "1"]);
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;
  writeFileSync(marker, "9\n");
  const messages: string[] = [];
  await resumeBackgroundWaits(new Date(Date.now() + 10000), async (_agent, text) => { messages.push(text); });
  assert.match(messages[0], /exit code: 9/);
});

it("applies global, project and single-wait timeout overrides and rejects invalid durations", async () => {
  for (const value of ["0", "-1", "NaN", "1.5", "9007199254740992"]) {
    await assert.rejects(() => register(["--timeout-ms", value]));
  }
  for (const [config, expected, extra] of [
    [{ backgroundWaitMaxMs: 2000 }, 2000, []],
    [{ backgroundWaitMaxMs: 2000, projects: { demo: { defaultWorkspace: "dir", backgroundWaitMaxMs: 3000 } } }, 3000, []],
    [{ backgroundWaitMaxMs: 2000, projects: { demo: { defaultWorkspace: "dir", backgroundWaitMaxMs: 3000 } } }, 4000, ["--timeout-ms", "4000"]],
  ] as const) {
    writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ autoStart: { demo: false }, ...config }));
    await register([...extra]);
    assert.equal(JSON.parse(getTask(id).background_wait_json!).maxWaitMs, expected);
    unblockTask(id, "supervisor");
  }
});


for (const failure of ["death", "timeout"] as const) it(`retries a ${failure} wake after restart with the same receipt and frozen log`, async () => {
  await register(failure === "timeout" ? ["--timeout-ms", "1"] : []);
  if (failure === "death") {
    const exited = once(worker, "exit");
    worker.kill("SIGKILL");
    await exited;
  }
  writeFileSync(log, "original failure tail");
  const attempts: Array<{ id: string; text: string }> = [];
  const send: Parameters<typeof resumeBackgroundWaits>[1] = async (_agent, text, options) => {
    attempts.push({ id: options!.messageId!, text });
    if (attempts.length === 1) throw new Error("lost acknowledgement");
  };
  await resumeBackgroundWaits(new Date(Date.now() + 1000), send);
  closeDb();
  writeFileSync(log, "replacement tail");
  await Promise.all([resumeBackgroundWaits(new Date(Date.now() + 2000), send), resumeBackgroundWaits(new Date(Date.now() + 2000), send)]);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.match(attempts[0].text, /original failure tail/);
  assert.equal(getTask(id).status, "running");
});

it("wakes old marker-only waits after upgrade and reports process death in Chinese", async () => {
  await register();
  const wait = JSON.parse(getTask(id).background_wait_json!);
  delete wait.process;
  getDb().prepare("UPDATE tasks SET background_wait_json = ? WHERE id = ?").run(JSON.stringify(wait), id);
  const messages: string[] = [];
  const send = async (_agent: string, text: string) => { messages.push(text); };
  await resumeBackgroundWaits(new Date(), send);
  assert.match(messages[0], /register again with --pid/);
  await register();
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;
  setLanguage("zh-CN");
  await resumeBackgroundWaits(new Date(), send);
  assert.match(messages[1], /\u540e\u53f0\u8fdb\u7a0b\u5df2\u9000\u51fa\u4f46\u672a\u5199\u9000\u51fa\u7801/);
});


it("bounds delivered log bytes even for invalid UTF-8", async () => {
  await register(["--timeout-ms", "1"]);
  writeFileSync(log, Buffer.alloc(20000, 0xff));
  let message = "";
  await resumeBackgroundWaits(new Date(Date.now() + 1000), async (_agent, text) => { message = text; });
  const tail = message.split("untrusted command output):\n")[1];
  assert.ok(tail.length > 0);
  assert.ok(Buffer.byteLength(tail) <= 8192);
});


it("registers a detached writer through the installed CLI launcher in its invoking shell", () => {
  const cli = fileURLToPath(new URL("../bin/paseo-kanban.mjs", import.meta.url));
  const result = spawnSync("/bin/sh", ["-c", `
    "$1" -e 'setInterval(() => {}, 1000)' > /dev/null 2>&1 &
    job_pid=$!
    "$1" "$2" --json wait-bg "$3" --card "$4" --pid "$job_pid" --log "$5"
    rc=$?
    kill "$job_pid"
    wait "$job_pid" 2>/dev/null
    exit "$rc"
  `, "background-fixture", process.execPath, cli, marker, String(id), log], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(getTask(id).blocked_kind, "background");
  assert.ok(JSON.parse(getTask(id).background_wait_json!).process.pid > 1);
});


it("uses the current wall clock if sleep occurs after a scheduler tick started", async context => {
  const start = Date.now();
  context.mock.timers.enable({ apis: ["Date"], now: start });
  await register(["--timeout-ms", "1000"]);
  context.mock.timers.setTime(start + 10000);
  const messages: string[] = [];
  await resumeBackgroundWaits(new Date(start), async (_agent, text) => { messages.push(text); });
  assert.match(messages[0], /timed out/i);
});

it("validates configured limits and preserves project limits when editing other project settings", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
    assert.throws(() => parseConfig({ backgroundWaitMaxMs: value }));
    assert.throws(() => parseConfig({ projects: { demo: { defaultWorkspace: "dir", backgroundWaitMaxMs: value } } }));
  }
  writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({
    autoStart: { demo: false }, backgroundWaitMaxMs: 2000,
    projects: { demo: { defaultWorkspace: "dir", backgroundWaitMaxMs: 3000 } },
  }));
  assert.equal(configPath(), join(dir, "kanban.config.json"), "settings writes must use this case's data override");
  setProjectWorkspace("demo", { baseBranch: "trunk" });
  assert.equal(configPath(), join(dir, "kanban.config.json"));
  setProjectCode("demo", "DEMO");
  assert.equal(loadConfig().projects!.demo.backgroundWaitMaxMs, 3000);
  assert.equal(loadConfig().backgroundWaitMaxMs, 2000);
});


it("rechecks the marker when the writer finishes during process inspection", async () => {
  await register();
  const messages: string[] = [];
  await resumeBackgroundWaits(new Date(), async (_agent, text) => { messages.push(text); }, () => {
    writeFileSync(marker, "0\n");
    return [];
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /exit code: 0/);
});

for (const failure of ["timeout", "exit", "malformed", "empty"] as const) it(`retains a wait when ps returns ${failure}`, async () => {
  await register();
  const messages: string[] = [];
  await resumeBackgroundWaits(new Date(), async (_agent, text) => { messages.push(text); }, () => backgroundProcesses(() => {
    if (failure === "timeout") throw Object.assign(new Error("ps timeout"), { code: "ETIMEDOUT" });
    if (failure === "exit") throw Object.assign(new Error("ps failed"), { status: 1 });
    return failure === "empty" ? "" : "unparseable process row";
  }));
  assert.deepEqual(messages, []);
  assert.equal(getTask(id).blocked_kind, "background");
});

it("wakes once with a distinct message after five unknown checks across a restart", async () => {
  await register();
  const messages: string[] = [];
  const tick = () => resumeBackgroundWaits(new Date(), async (_agent, text) => { messages.push(text); }, () => { throw new Error("ps timeout"); });
  for (let n = 0; n < 4; n++) await tick();
  assert.deepEqual(messages, []);
  closeDb();
  setLanguage("zh-CN");
  await tick();
  await tick();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\u65e0\u6cd5\u786e\u8ba4\u540e\u53f0\u8fdb\u7a0b\u72b6\u6001/);
  assert.doesNotMatch(messages[0], /\u540e\u53f0\u8fdb\u7a0b\u5df2\u9000\u51fa/);
});

it("resets consecutive unknown checks when the process is alive", async () => {
  await register();
  const messages: string[] = [];
  const send = async (_agent: string, text: string) => { messages.push(text); };
  const unknown = () => { throw new Error("ps failed"); };
  for (let n = 0; n < 4; n++) await resumeBackgroundWaits(new Date(), send, unknown);
  await resumeBackgroundWaits(new Date(), send);
  for (let n = 0; n < 4; n++) await resumeBackgroundWaits(new Date(), send, unknown);
  assert.deepEqual(messages, []);
  await resumeBackgroundWaits(new Date(), send, () => []);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /process exited without writing an exit code/i);
});

it("supports a configured unknown check limit and validates it", async () => {
  for (const value of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseConfig({ backgroundWaitUnknownLimit: value }));
  }
  writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ autoStart: { demo: false }, backgroundWaitUnknownLimit: 2 }));
  assert.equal(loadConfig().backgroundWaitUnknownLimit, 2);
  await register();
  const messages: string[] = [];
  const tick = () => resumeBackgroundWaits(new Date(), async (_agent, text) => { messages.push(text); }, () => { throw new Error("ps failed"); });
  await tick();
  assert.deepEqual(messages, []);
  await tick();
  await tick();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /could not confirm the background process status/i);
  assert.doesNotMatch(messages[0], /process exited/i);
});

it("still honors the wall-clock deadline when process inspection is unavailable", async () => {
  await register(["--timeout-ms", "1"]);
  const wait = JSON.parse(getTask(id).background_wait_json!);
  const messages: string[] = [];
  await resumeBackgroundWaits(new Date(wait.startedAt + 1000), async (_agent, text) => { messages.push(text); }, () => { throw new Error("ps timeout"); });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /timed out/i);
});

it("shares a failed snapshot across all waits in a tick", async () => {
  await register();
  const first = getTask(id);
  const second = createTask({ project: "demo", title: "Another build", role: "executor", workspacePath: dir });
  getDb().prepare(`UPDATE tasks SET status = 'blocked', blocked_kind = 'background', agent_id = ?,
    background_wait_json = ?, scheduled_wake_id = 'second-wake' WHERE id = ?`)
    .run(first.agent_id, first.background_wait_json, second.id);
  let reads = 0;
  let wakes = 0;
  await resumeBackgroundWaits(new Date(), async () => { wakes++; }, () => { reads++; throw new Error("ps failed"); });
  assert.equal(reads, 1);
  assert.equal(wakes, 0);
  for (const taskId of [id, second.id]) {
    assert.equal(JSON.parse(getTask(taskId).background_wait_json!).unknownChecks, 1);
  }
});

it("freezes the unknown-state wake receipt and text for delivery retry", async () => {
  writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ autoStart: { demo: false }, backgroundWaitUnknownLimit: 1 }));
  await register();
  const receipt = getTask(id).scheduled_wake_id;
  let frozen = "";
  await resumeBackgroundWaits(new Date(), async (_agent, text, options) => {
    frozen = text;
    assert.equal(options?.messageId, receipt);
    throw new Error("delivery unavailable");
  }, () => { throw new Error("ps failed"); });
  closeDb();
  let wakes = 0;
  await resumeBackgroundWaits(new Date(), async (_agent, text, options) => {
    wakes++;
    assert.equal(options?.messageId, receipt);
    assert.equal(text, frozen);
  }, () => { throw new Error("must use the frozen wake"); });
  await resumeBackgroundWaits(new Date(), async () => { wakes++; });
  assert.equal(wakes, 1);
});

it("registers and keeps a live wait when an unrelated process has STAT S>", async context => {
  const original = childProcess.execFileSync;
  let snapshots = 0;
  const trap = context.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof childProcess.execFileSync>) => {
    const output = Reflect.apply(original, childProcess, args);
    if (args[0] !== "/bin/ps") return output;
    snapshots++;
    assert.ok(typeof output === "string");
    return `${output.trimEnd()}\n999999999 1 999999999 0 501 Thu Oct 22 00:00:00 2026 S>\n`;
  });
  syncBuiltinESMExports();
  try {
    await register();
    assert.equal(getTask(id).blocked_kind, "background");
    const messages: string[] = [];
    for (let n = 0; n < 6; n++) {
      await resumeBackgroundWaits(new Date(), async (_agent, text) => { messages.push(text); });
      assert.equal(JSON.parse(getTask(id).background_wait_json!).unknownChecks ?? 0, 0);
    }
    assert.equal(snapshots, 7);
    assert.deepEqual(messages, []);
    assert.equal(getTask(id).blocked_kind, "background");
  } finally {
    trap.mock.restore();
    syncBuiltinESMExports();
  }
});
