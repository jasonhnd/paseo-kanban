/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { confirmEffort, EFFORT_CATALOG_TTL_MS, resetEffortCatalogForTests } from "../server/effort";
import { type DispatchMatrix, type MatrixLoad } from "../server/matrix";
import { openEntry, type PoolSnapshot } from "../server/pools";
import { type Profile } from "../server/profiles";
import { runTick } from "./helpers/compat-schedule";
import { blockTask, createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const dir = mkdtempSync(join(tmpdir(), "TEST_0092-effort-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_POOL_STATUS = join(dir, "missing-pools.json");
const primary: Profile = { id: "gpt", name: "Executor · GPT-6.1-Sol", role: "executor", family: "openai", provider: "codex", model: "gpt-6.1-sol", pool: "codex-pro", thinkingOptionId: "high" };
const next: Profile = { ...primary, id: "next", name: "Executor · Backup", role: "candidate", candidateFor: "executor", model: "gpt-6-sol" };
const reviewer: Profile = { id: "review", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "claude-sonnet-5", pool: "claude-max" };
const profiles = [primary, next, reviewer];
const pools: PoolSnapshot = { state: "fresh", message: zhCNPart("compat.name.offlineTest", 2, 4), generatedAt: null, updatedAt: null, ageMs: 0, hasPool: () => true, entry: () => openEntry(), dispatchable: () => true };
const sent: string[] = [];
let serial = 0;

beforeEach(() => {
  resetEffortCatalogForTests();
  resetBoardWakeForTests();
  setAgentAliveCheck((id) => id === "boss");
  sent.length = 0;
  setWakeSender((_id, message) => { sent.push(message); });
});
after(() => {
  setWakeSender(() => {});
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(mode: "matrix" | "roster", selected = profiles, snapshot = pools) {
  const project = `catalog-${++serial}`;
  const room = join(dir, project);
  mkdirSync(room);
  const autoStart = Object.fromEntries((getDb().prepare("SELECT DISTINCT project FROM tasks").all() as Array<{ project: string }>).map((row) => [row.project, false]));
  autoStart[project] = true;
  const config: KanbanConfig = { autoStart, supervisorAgentId: "boss", supervisors: {}, concurrency: { global: 100, roles: { executor: 100, reviewer: 100 }, pools: { "codex-pro": 100, "claude-max": 100 } } };
  saveConfig(config);
  const matrix: DispatchMatrix = { version: 1, generatedAt: "2026-10-02T00:00:00Z", defaultTier: "L3", downgradeWhenTight: ["L1", "L2"], executor: { L3: selected.filter((p) => p.role === "executor" || (p.role === "candidate" && p.candidateFor === "executor")).map((p) => ({ profile: p.name, effort: "high", paused: false })) }, reviewerFamilies: { openai: { L3: [{ profile: reviewer.name, effort: "high", paused: false }] } }, star: {} };
  const load: MatrixLoad = mode === "matrix" ? { state: "ok", matrix, path: join(dir, "matrix.json") } : { state: "missing" };
  const task = createTask({ project, title: "Confirm depth", role: "executor", workspacePath: room, tier: "L3", ...(mode === "roster" ? { effort: "high" } : {}) });
  const created: Array<Parameters<AgentLauncher["create"]>[0]> = [];
  const launcher = (listModels: AgentLauncher["listModels"]): AgentLauncher => ({ listModels, async create(options) { created.push(options); return { id: `${project}-agent` }; }, async send() {} });
  const tick = (agentLauncher: AgentLauncher) => runTick({ profiles: selected, config, pools: snapshot, matrix: load, launcher: agentLauncher });
  return { task, created, launcher, tick, config, matrix };
}

function count(taskId: number, kind: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number }).n;
}

describe("effort catalog failures and candidate fallback", () => {
  for (const mode of ["matrix", "roster"] as const) {
    it(`${mode}: disconnected catalog holds without blocking or counting start failures`, async () => {
      const f = fixture(mode);
      const bad = f.launcher(async () => { throw new Error("Transport not connected (status: disconnected)"); });
      for (let i = 0; i < 4; i++) {
        const result = await f.tick(bad);
        const row = getTask(f.task.id);
        assert.equal(row.status, "ready");
        assert.equal(row.blocked_kind, null);
        assert.equal(row.fail_count, 0);
        assert.match(row.hold_reason ?? "", new RegExp(zhCN("effort.catalogHold")));
        assert.ok(result.held.some((item) => item.id === row.id));
      }
      assert.equal(f.created.length, 0);
      for (const kind of ["blocked", "start_transient", "board_wake"]) assert.equal(count(f.task.id, kind), 0);
      assert.equal(sent.length, 0);
      await f.tick(f.launcher(async () => ({ models: [{ id: primary.model!, thinkingOptions: [{ id: "high" }] }] })));
      assert.equal(getTask(f.task.id).status, "running");
    });

    it(`${mode}: skips unsupported candidate and starts the next eligible profile`, async () => {
      const f = fixture(mode);
      const result = await f.tick(f.launcher(async () => ({ models: [{ id: primary.model!, thinkingOptions: [{ id: "low" }] }, { id: next.model!, thinkingOptions: [{ id: "high" }] }] })));
      assert.ok(result.started.includes(f.task.id));
      assert.equal(getTask(f.task.id).executor_profile, next.name);
      assert.equal(f.created[0]?.config.provider, `${next.provider}/${next.model}`);
      assert.equal(f.created[0]?.config.thinkingOptionId, "high");
      const event = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started'").get(f.task.id) as { data_json: string };
      assert.match(event.data_json, new RegExp((zhCNPart("routing.sum.skipped", 0, 3) + "Executor · GPT-6\\.1-Sol" + zhCNPart("parents.mergeNote", 3, 5) + zhCNPart("routing.noEffortSupport", 1, 6) + "high")));
      assert.equal(count(f.task.id, "blocked"), 0);
    });

    it(`${mode}: all unsupported candidates hold and wake the leader once`, async () => {
      const f = fixture(mode);
      const limited = f.launcher(async () => ({ models: [primary, next].map((p) => ({ id: p.model!, thinkingOptions: [{ id: "low" }] })) }));
      await f.tick(limited);
      await f.tick(limited);
      const row = getTask(f.task.id);
      assert.equal(row.status, "ready");
      assert.equal(row.blocked_kind, null);
      assert.match(row.hold_reason ?? "", new RegExp(zhCN("routing.noEffortSupport", {"effort":"high"})));
      assert.equal(f.created.length, 0);
      assert.equal(count(row.id, "blocked"), 0);
      assert.equal(count(row.id, "board_wake"), 1);
      assert.equal(sent.length, 1);
    });

    it(`${mode}: cached catalog can select a supported fallback during a disconnect`, async () => {
      const f = fixture(mode);
      await confirmEffort(async () => ({ models: [{ id: primary.model!, thinkingOptions: [{ id: "low" }] }, { id: next.model!, thinkingOptions: [{ id: "high" }] }] }), primary, "high");
      await f.tick(f.launcher(async () => { throw new Error("disconnected"); }));
      assert.equal(getTask(f.task.id).status, "running");
      assert.equal(getTask(f.task.id).executor_profile, next.name);
      assert.equal(sent.length, 0);
    });

    it(`${mode}: an explicit unsupported profile holds without silently switching`, async () => {
      const f = fixture(mode);
      getDb().prepare("UPDATE tasks SET profile_override = ? WHERE id = ?").run(primary.name, f.task.id);
      await f.tick(f.launcher(async () => ({ models: [{ id: primary.model!, thinkingOptions: [{ id: "low" }] }, { id: next.model!, thinkingOptions: [{ id: "high" }] }] })));
      assert.equal(getTask(f.task.id).status, "ready");
      assert.equal(getTask(f.task.id).blocked_kind, null);
      assert.equal(f.created.length, 0);
      assert.equal(sent.length, 1);
    });

    for (const gate of ["quota", "concurrency"] as const) {
      it(`${mode}: unsupported primary does not bypass the fallback's ${gate} gate`, async () => {
        const spare = { ...next, pool: "spare" };
        const snapshot: PoolSnapshot = { ...pools, entry: (pool) => ({ ...openEntry(), dispatchable: gate !== "quota" || pool !== "spare" }) };
        const f = fixture(mode, [primary, spare, reviewer], snapshot);
        if (gate === "concurrency") f.config.concurrency.pools.spare = 0;
        saveConfig(f.config);
        await f.tick(f.launcher(async () => ({ models: [{ id: primary.model!, thinkingOptions: [{ id: "low" }] }, { id: spare.model!, thinkingOptions: [{ id: "high" }] }] })));
        const row = getTask(f.task.id);
        assert.equal(row.status, "ready");
        assert.equal(row.blocked_kind, null);
        assert.match(row.hold_reason ?? "", new RegExp(zhCN("routing.noEffortSupport", {"effort":"high"})));
        assert.equal(f.created.length, 0);
        assert.equal(sent.length, 0, "a capacity or quota wait is not confirmation that all profiles lack support");
      });
    }

    it(`${mode}: legacy unsupported-depth quota block can retry with a different profile`, async () => {
      const f = fixture(mode);
      blockTask(f.task.id, "quota", `${primary.name} ${zhCNPart("routing.noEffortSupport", 0, 6)}high`, "test");
      await f.tick(f.launcher(async () => ({ models: [{ id: primary.model!, thinkingOptions: [{ id: "low" }] }, { id: next.model!, thinkingOptions: [{ id: "high" }] }] })));
      assert.equal(getTask(f.task.id).status, "running");
      assert.equal(getTask(f.task.id).executor_profile, next.name);
      assert.equal(count(f.task.id, "blocked"), 1);
    });
  }

  it("distinguishes successful support, confirmed rejection, and read errors", async () => {
    const profile = { provider: "unit-tristate", model: "model" };
    assert.equal(await confirmEffort(async () => { throw new Error("disconnected"); }, profile, "high"), "unavailable");
    assert.equal(await confirmEffort(async () => ({ models: [{ id: "model", thinkingOptions: [{ id: "high" }] }] }), profile, "high"), "supported");
    assert.equal(await confirmEffort(async () => ({ models: [{ id: "model", thinkingOptions: [{ id: "low" }] }] }), profile, "high"), "unsupported");
  });

  it("uses a recent successful provider catalog during a disconnect", async () => {
    const profile = { provider: "unit-cache", model: "model" };
    const good = async () => ({ models: [{ id: "model", aliases: ["alias"], thinkingOptions: [{ id: "high" }] }] });
    await confirmEffort(good, profile, "high");
    const down = async () => { throw new Error("disconnected"); };
    assert.equal(await confirmEffort(down, { ...profile, model: "alias" }, "high"), "supported");
    assert.equal(await confirmEffort(down, profile, "max"), "unsupported");
    assert.equal(await confirmEffort(down, { ...profile, provider: "other-provider" }, "high"), "unavailable");
  });

  it("treats missing interfaces, error responses, absent and malformed catalogs as unreadable", async () => {
    const profile = { provider: "bad-catalog", model: "model" };
    assert.equal(await confirmEffort(undefined, profile, "high"), "unavailable");
    assert.equal(await confirmEffort(async () => ({ error: "Transport not connected (status: disconnected)" }), profile, "high"), "unavailable");
    assert.equal(await confirmEffort(async () => ({}), profile, "high"), "unavailable");
    assert.equal(await confirmEffort(async () => ({ models: [{ id: "model", thinkingOptions: null }] } as unknown as { models: [] }), profile, "high"), "unavailable");
    assert.equal(await confirmEffort(async () => ({ models: [] }), profile, "high"), "unsupported");
  });

  it("times out a hung catalog read without treating it as rejection", async () => {
    const result = await confirmEffort(() => new Promise(() => {}), { provider: "hung", model: "model" }, "high", { timeoutMs: 5 });
    assert.equal(result, "unavailable");
  });

  it("expires cached catalogs at five minutes and failed reads do not extend their lifetime", async () => {
    let now = 1000;
    const profile = { provider: "expiry", model: "model" };
    const options = { now: () => now, timeoutMs: 5 };
    await confirmEffort(async () => ({ models: [{ id: "model", thinkingOptions: [{ id: "high" }] }] }), profile, "high", options);
    now += EFFORT_CATALOG_TTL_MS - 1;
    const down = async () => ({ error: "disconnected" });
    assert.equal(await confirmEffort(down, profile, "high", options), "supported");
    now++;
    assert.equal(await confirmEffort(down, profile, "high", options), "unavailable");
    // A timed-out request resolving later must not populate the cache.
    let finish!: (value: { models: [] }) => void;
    assert.equal(await confirmEffort(() => new Promise((resolve) => { finish = resolve; }), profile, "high", options), "unavailable");
    finish({ models: [] });
    await Promise.resolve();
    assert.equal(await confirmEffort(down, profile, "high", options), "unavailable");
  });

  it("matrix: tries the next profile at the requested depth before L1/L2 downgrades", async () => {
    const f = fixture("matrix");
    getDb().prepare("UPDATE tasks SET tier = 'L2' WHERE id = ?").run(f.task.id);
    f.matrix.executor.L2 = [primary, next].map((p) => ({ profile: p.name, effort: "medium", paused: false }));
    f.matrix.reviewerFamilies.openai!.L2 = [{ profile: reviewer.name, effort: "medium", paused: false }];
    await f.tick(f.launcher(async () => ({ models: [{ id: primary.model!, thinkingOptions: [{ id: "low" }] }, { id: next.model!, thinkingOptions: [{ id: "medium" }] }] })));
    assert.equal(getTask(f.task.id).executor_profile, next.name);
    assert.equal(f.created[0]?.config.thinkingOptionId, "medium");
  });

  it("matrix: lowers once only after the full list rejects the requested L2 depth", async () => {
    const f = fixture("matrix");
    getDb().prepare("UPDATE tasks SET tier = 'L2' WHERE id = ?").run(f.task.id);
    f.matrix.executor.L2 = [primary, next].map((p) => ({ profile: p.name, effort: "medium", paused: false }));
    f.matrix.reviewerFamilies.openai!.L2 = [{ profile: reviewer.name, effort: "medium", paused: false }];
    await f.tick(f.launcher(async () => ({ models: [primary, next].map((p) => ({ id: p.model!, thinkingOptions: [{ id: "low" }] })) })));
    assert.equal(getTask(f.task.id).executor_profile, primary.name);
    assert.equal(f.created[0]?.config.thinkingOptionId, "low");
  });

  it("matrix: does not escape the matrix to an unsupported-list outsider", async () => {
    const f = fixture("matrix");
    f.matrix.executor.L3 = [{ profile: primary.name, effort: "high", paused: false }];
    await f.tick(f.launcher(async () => ({ models: [{ id: primary.model!, thinkingOptions: [{ id: "low" }] }, { id: next.model!, thinkingOptions: [{ id: "high" }] }] })));
    assert.equal(getTask(f.task.id).status, "ready");
    assert.equal(f.created.length, 0);
    assert.equal(sent.length, 1);
  });
});
