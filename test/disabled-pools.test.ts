/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_LOGIN_BLIP_RETRY_MS, loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { applyLoginBlip } from "../server/login-blip";
import { readCompatibilityPoolSnapshot as readPoolSnapshot, STALE_MS } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile } from "../server/routing";
import { boardExtras, resetReconcileForTests } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { appendEvent, createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";

const envKeys = ["KANBAN_DATA_DIR", "KANBAN_POOL_STATUS", "KANBAN_DISPATCH_MATRIX"] as const;
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const root = mkdtempSync(join(tmpdir(), "kanban-disabled-pools-"));
let dir: string;
let file: string;
const cursor: Profile = { id: "cursor", name: "Executor · Cursor", role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" };
const grok: Profile = { ...cursor, id: "grok", name: "Executor · Grok", role: "candidate", candidateFor: "executor", provider: "grok", pool: "supergrok" };
const claude: Profile = { ...grok, id: "claude", name: "Executor · Claude", family: "anthropic", provider: "claude", model: "opus", pool: "claude-max" };
const reviewer: Profile = { ...claude, id: "reviewer", name: zhCN("labels.role.reviewer"), role: "reviewer", candidateFor: undefined };
const profiles = [cursor, grok, claude, reviewer];
const launcher = { async create() { return { id: "cursor-agent" }; }, async send() {} };

function configure(disabledPools: string[]) {
  const config = loadConfig();
  config.disabledPools = disabledPools;
  config.autoStart = { test: true };
  saveConfig(config);
  return config;
}

beforeEach(() => {
  closeDb();
  resetReconcileForTests();
  dir = mkdtempSync(join(root, "case-"));
  file = join(dir, "pool-status.json");
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_POOL_STATUS = file;
  process.env.KANBAN_DISPATCH_MATRIX = join(dir, "missing-matrix.json");
  writeFileSync(file, JSON.stringify({ pools: { cursor: { dispatchable: true, usedPct: 12 }, supergrok: { dispatchable: true }, "claude-max": { dispatchable: true } } }));
  setAgentAliveCheck(() => true);
});

after(() => {
  closeDb();
  resetAgentAliveCheck();
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("disabledPools", () => {
  it("defaults to empty, normalizes string names, and survives config saves", () => {
    assert.deepEqual(loadConfig().disabledPools, []);
    writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ disabledPools: [" cursor ", "cursor", "", 1, "supergrok"] }));
    const config = loadConfig();
    assert.deepEqual(config.disabledPools, ["cursor", "supergrok"]);
    config.autoStart.test = false;
    saveConfig(config);
    assert.deepEqual(loadConfig().disabledPools, ["cursor", "supergrok"]);
    for (const invalid of [null, "cursor", {}]) {
      writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ disabledPools: invalid }));
      assert.deepEqual(loadConfig().disabledPools, []);
    }
  });

  it("overrides EX entries and exposes the reason without rewriting EX", () => {
    configure(["cursor"]);
    const original = readFileSync(file, "utf8");
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.dispatchable("cursor"), false);
    assert.equal(snapshot.entry("cursor").reason, zhCN("pools.disabledByConfig", {"pool":"cursor"}));
    assert.equal(snapshot.entry("cursor").usedPct, 12);
    assert.equal(snapshot.dispatchable("supergrok"), true);
    assert.match(boardExtras().pool.message, new RegExp(zhCN("pools.disabledByConfig", {"pool":"cursor"})));
    // A subsequent EX rewrite cannot clear the local stop switch.
    writeFileSync(file, original);
    assert.equal(readPoolSnapshot().dispatchable("cursor"), false);
    assert.equal(readFileSync(file, "utf8"), original);
    configure([]);
    assert.equal(readPoolSnapshot().dispatchable("cursor"), true);
    assert.equal(readPoolSnapshot().entry("cursor").reason, null);
  });

  it("keeps disabled pools closed for stale, absent, malformed and unlisted EX pools", () => {
    configure(["cursor", "unlisted"]);
    const old = new Date(Date.now() - STALE_MS - 1000);
    utimesSync(file, old, old);
    assert.equal(readPoolSnapshot().state, "stale");
    assert.equal(readPoolSnapshot().dispatchable("cursor"), false);
    assert.equal(readPoolSnapshot().dispatchable("unlisted"), false);
    for (const body of ["{bad", JSON.stringify({ pools: {} })]) {
      writeFileSync(file, body);
      assert.equal(readPoolSnapshot().dispatchable("cursor"), false);
    }
    process.env.KANBAN_POOL_STATUS = join(dir, "absent.json");
    assert.equal(readPoolSnapshot().state, "missing");
    assert.equal(readPoolSnapshot().dispatchable("cursor"), false);
    assert.match(readPoolSnapshot().message, new RegExp(zhCN("pools.disabledByConfig", {"pool":"cursor"})));
  });

  it("queues instead of using Cursor when other executor pools are full, then restores it", () => {
    configure(["cursor"]);
    const input = { profiles, role: "executor", review: false, byPool: { "claude-max": 1, supergrok: 1 }, poolLimits: { "claude-max": 1, supergrok: 1 } };
    const held = routeProfile({ ...input, snapshot: readPoolSnapshot() });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.equal(held.action, "hold");
      assert.match(held.reason, new RegExp(zhCN("pools.disabledByConfig", {"pool":"cursor"})));
    }
    configure([]);
    const resumed = routeProfile({ ...input, snapshot: readPoolSnapshot() });
    assert.equal(resumed.ok, true);
    if (resumed.ok) assert.equal(resumed.profile.pool, "cursor");
  });

  it("uses another available pool and holds an explicitly pinned Cursor profile", async () => {
    configure(["cursor"]);
    const selected = routeProfile({ profiles, role: "executor", review: false, byPool: {}, poolLimits: {}, snapshot: readPoolSnapshot() });
    assert.equal(selected.ok, true);
    if (selected.ok) assert.equal(selected.profile.pool, "supergrok");
    const task = createTask({ project: "test", title: "Sample text Cursor", role: "executor", profileOverride: cursor.name, workspacePath: dir });
    let creates = 0;
    await startTask(task.id, { ...launcher, async create() { creates++; return { id: "unexpected" }; } }, "scheduler", { profiles });
    assert.equal(creates, 0);
    assert.equal(getTask(task.id).status, "ready");
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp(zhCN("pools.disabledByConfig", {"pool":"cursor"})));
  });

  it("keeps an existing Cursor agent running while holding new work, then starts queued work on removal", async () => {
    configure([]);
    const running = createTask({ project: "test", title: "Sample text", role: "executor", workspacePath: dir, profileOverride: cursor.name });
    await startTask(running.id, launcher, "scheduler", { profiles });
    assert.equal(getTask(running.id).status, "running");
    const agent = getTask(running.id).agent_id;
    const queued = createTask({ project: "test", title: "Waiting", role: "executor", workspacePath: dir, profileOverride: cursor.name });
    configure(["cursor"]);
    let creates = 0;
    const tickLauncher = { ...launcher, async create() { creates++; return { id: "new-cursor-agent" }; } };
    await runTick({ profiles, launcher: tickLauncher, agentState: () => "alive" });
    assert.equal(creates, 0);
    assert.equal(getTask(running.id).status, "running");
    assert.equal(getTask(running.id).agent_id, agent);
    assert.equal(getTask(queued.id).status, "ready");
    assert.match(getTask(queued.id).hold_reason ?? "", new RegExp(zhCN("pools.disabledByConfig", {"pool":"cursor"})));
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(running.id);
    configure([]);
    await runTick({ profiles, launcher: tickLauncher, agentState: () => "alive" });
    assert.equal(creates, 1);
    assert.equal(getTask(queued.id).status, "running");
  });

  it("preserves the local stop reason on rework with a living original agent", async () => {
    configure([]);
    const task = createTask({ project: "test", title: "Rework paused", role: "executor", workspacePath: dir, profileOverride: cursor.name });
    await startTask(task.id, launcher, "scheduler", { profiles });
    const originalAgent = getTask(task.id).executor_agent_id;
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
    appendEvent(task.id, "request_changes", "reviewing", "rework", "reviewer", { reason: "Add tests" });
    configure(["cursor"]);
    let creates = 0;
    let sends = 0;
    await runTick({ profiles, agentState: () => "alive", launcher: {
      async create() { creates++; return { id: "unexpected" }; },
      async send() { sends++; },
    } });
    const held = getTask(task.id);
    assert.equal(held.status, "rework");
    assert.equal(held.executor_agent_id, originalAgent);
    assert.match(held.hold_reason ?? "", new RegExp(zhCN("pools.disabledByConfig", {"pool":"cursor"})));
    assert.equal(creates, 0);
    assert.equal(sends, 0);
  });

  it("preserves the local stop reason on a pinned login reopen and creates no agent", async () => {
    configure([]);
    const task = createTask({ project: "test", title: "Login restart paused", role: "executor", workspacePath: dir, profileOverride: cursor.name });
    await startTask(task.id, launcher, "scheduler", { profiles });
    const now = new Date();
    const agent = getTask(task.id).agent_id!;
    assert.equal(applyLoginBlip(task.id, agent, 1, now), "requeue");
    configure(["cursor"]);
    let creates = 0;
    await runTick({ profiles, now: new Date(now.getTime() + DEFAULT_LOGIN_BLIP_RETRY_MS), agentState: () => "alive", launcher: {
      async create() { creates++; return { id: "unexpected" }; },
      async send() { assert.fail("must not send a login reopen to a stopped pool"); },
    } });
    assert.equal(getTask(task.id).status, "ready");
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp(zhCN("pools.disabledByConfig", {"pool":"cursor"})));
    assert.equal(creates, 0);
  });

  it("preserves the local stop reason when reserving a reviewer on a disabled pool", () => {
    configure(["claude-max"]);
    const held = routeProfile({ profiles: [cursor, reviewer], role: "executor", review: false, byPool: {}, poolLimits: {}, snapshot: readPoolSnapshot() });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.equal(held.action, "hold");
      assert.match(held.reason, new RegExp(zhCN("routing.poolClosedWhy", {"pool":(zhCNPart("rebind.hint.review", 0, 3) + "claude-max"),"reason":zhCN("pools.disabledByConfig", {pool:"claude-max"})})));
    }
  });

});
