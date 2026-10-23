/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { kanbanHelp, runKanban } from "../server/cli";
import { DEFAULT_CONCURRENCY, saveConfig, setProjectCode, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { modelSupportsEffort, resetEffortCatalogForTests } from "../server/effort";
import { KanbanError } from "../server/errors";
import { completeTask } from "../server/flow";
import { openEntry, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getDetail, getTask } from "../server/store";
import { handleTool } from "../server/tools";
import { issueToken } from "../server/tokens";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";
import { cardEffortLabel } from "../shared/labels";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "effort-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_POOL_STATUS = join(dir, "no-such-pools.json");
const work = join(dir, "work");
mkdirSync(work, { recursive: true });

const executor: Profile = {
  id: "exec",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  thinkingOptionId: "high",
  pool: "alternate",
};
const reviewer: Profile = {
  id: "rev",
  name: zhCN("labels.role.reviewer"),
  role: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "claude-sonnet-5",
  thinkingOptionId: "medium",
  pool: "claude-max",
};
const reader: Profile = {
  id: "read",
  name: zhCN("labels.role.reader"),
  role: "reader",
  family: "anthropic",
  provider: "claude",
  model: "claude-sonnet-5",
  thinkingOptionId: "high",
  pool: "claude-max",
};

const sent: Array<{ id: string; text: string }> = [];

beforeEach(() => resetEffortCatalogForTests());

function config(): KanbanConfig {
  const value: KanbanConfig = {
    autoStart: { effort: true },
    supervisorAgentId: "boss",
    supervisors: {},
    concurrency: {
      global: 50,
      pools: { ...DEFAULT_CONCURRENCY.pools, alternate: 50, "claude-max": 50 },
      roles: { executor: 50, reviewer: 50, reader: 50 },
    },
  };
  saveConfig(value);
  return value;
}

const pools: PoolSnapshot = {
  state: "fresh",
  message: zhCNPart("compat.name.offlineTest", 2, 4),
  generatedAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  ageMs: 0,
  dispatchable: () => true,
  entry: () => openEntry(),
};

function catalog(provider: string): { models: Array<{ id: string; aliases?: string[]; thinkingOptions: Array<{ id: string }> }> } {
  if (provider === "alternate") {
    return { models: [{ id: "grok-4.7", aliases: ["grok"], thinkingOptions: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }] }] };
  }
  return {
    models: [{ id: "claude-sonnet-5", thinkingOptions: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }] }],
  };
}

function launcher(onConfig?: (thinking: string | undefined) => void, listModels?: AgentLauncher["listModels"]): AgentLauncher {
  let n = 0;
  return {
    async create(options) {
      n += 1;
      onConfig?.(options.config.thinkingOptionId);
      return { id: `effort-agent-${n}` };
    },
    async send() {},
    listModels,
  };
}

function startedReason(taskId: number): string {
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'started' ORDER BY id DESC LIMIT 1").get(taskId) as {
    data_json: string;
  };
  return String((JSON.parse(row.data_json) as { reason?: string }).reason ?? "");
}

function runEffort(taskId: number, role: string): string | null {
  const row = getDb().prepare("SELECT effort FROM runs WHERE task_id = ? AND role = ? ORDER BY id DESC LIMIT 1").get(taskId, role) as {
    effort: string | null;
  };
  return row.effort;
}

after(() => {
  setWakeSender(() => {});
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("card effort", () => {
  it("stores each legal depth and rejects anything else", async () => {
    // TEST_0273: a card no longer configures its project by writing a short code; configure it first.
    setProjectCode("effort", "EFF");
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const row = createTask({ project: "effort", title: effort, role: "executor", workspacePath: work, effort });
      assert.equal(row.effort, effort);
      assert.equal(getDetail(row.id).task.effort, effort);
      assert.equal(cardEffortLabel(effort), `${zhCNPart("labels.card.effort", 0, 3)}${effort}${zhCNPart("effort.noteCard", 11, 17)}`);
    }
    const plain = createTask({ project: "effort", title: "Unspecified", role: "executor", workspacePath: work });
    assert.equal(plain.effort, null);
    assert.equal(getDetail(plain.id).task.effort, null);

    const created = (await runKanban(
      ["create", "--project", "effort", "--title", zhCNPart("compat.name.cliToken", 0, 3), "--role", "executor", "--workspace", work, "--effort", "high"],
      {},
    )) as { id: number; effort: string | null };
    assert.equal(created.effort, "high");
    assert.equal(getDetail(created.id).task.effort, "high");

    await assert.rejects(
      () => runKanban(["create", "--project", "effort", "--title", "Invalid", "--role", "executor", "--workspace", work, "--effort", "turbo"], {}),
      (err: unknown) => err instanceof KanbanError && err.message.includes((zhCNPart("tier.invalidValue", 18, 22) + "turbo」")) && err.message.includes("low、medium、high、xhigh、max"),
    );

    const token = issueToken("supervisor", null, null);
    const viaTool = (await handleTool(
      "kanban_create",
      { project: "effort", title: "demo fixture", role: "executor", workspace: work, effort: "medium" },
      token,
    )) as { id: number; effort: string | null };
    assert.equal(viaTool.effort, "medium");
    await assert.rejects(
      () => handleTool("kanban_create", { project: "effort", title: "demo fixture Invalid", role: "executor", workspace: work, effort: "ultra" }, token),
      (err: unknown) => err instanceof KanbanError && new RegExp(localePattern(zhCNPart("effort.invalidType", 0, 5))).test(err.message),
    );
    assert.match(kanbanHelp(), /--effort low\|medium\|high\|xhigh\|max/);
    assert.match(kanbanHelp(), new RegExp(localePattern(zhCNPart("wake.review.fixNext", 5, 8)) + localePattern(zhCNPart("boardView.cmd.resolveConflict", 14, 16)) + "\\u540e\\u53e6\\u5f00\\u7684\\u5ba1\\u67e5\\u4e0d\\u53d7\\u8fd9\\u4e2a\\u6df1\\u5ea6\\u5f71\\u54cd"));
    assert.match(kanbanHelp(), new RegExp(localePattern(zhCNPart("schedule.sendBack", 0, 5)) + localePattern(zhCNPart("rebind.event.reason", 13, 21)) + zhCN("common.comma") + localePattern(zhCNPart("matrix.badEffort", 9, 12)) + localePattern(zhCNPart("handover.registry.keep", 5, 6))));
  });

  it("matches a model by id or alias and ignores a model with no thinking options", () => {
    const models = [{ id: "grok-4.7", aliases: ["grok"], thinkingOptions: [{ id: "low" }, { id: "high" }] }];
    assert.equal(modelSupportsEffort(models, "grok-4.7", "low"), true);
    assert.equal(modelSupportsEffort(models, "grok", "high"), true);
    assert.equal(modelSupportsEffort(models, "grok-4.7", "max"), false);
    assert.equal(modelSupportsEffort([{ id: "haiku" }], "haiku", "low"), false);
  });

  it("overrides the executor thinking depth and leaves the later review on the reviewer profile", async () => {
    const seen: string[] = [];
    const task = createTask({ project: "effort", title: "demo fixture", role: "executor", workspacePath: work, effort: "low" });
    await startTask(task.id, launcher((thinking) => seen.push(thinking ?? ""), (provider) => Promise.resolve(catalog(provider))), "test", {
      profiles: [executor, reviewer],
      chosen: executor,
      reason: "Test start",
    });
    assert.deepEqual(seen, ["low"]);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(runEffort(task.id, "executor"), "low");
    assert.match(startedReason(task.id), new RegExp(zhCN("effort.noteCard", {"effort":"low"})));
    const thinking = getDb().prepare("SELECT thinking_option_id FROM runs WHERE task_id = ? AND role = 'executor'").get(task.id) as {
      thinking_option_id: string;
    };
    assert.equal(thinking.thinking_option_id, "low");

    completeTask(task.id, "executor", "Submitted", null);
    assert.equal(getTask(task.id).status, "in_review");
    const reviewSeen: string[] = [];
    await startTask(
      task.id,
      launcher((thinking) => reviewSeen.push(thinking ?? ""), async () => {
        throw new Error((zhCN("labels.role.reviewer") + "Demo text"));
      }),
      "test",
      { profiles: [executor, reviewer], chosen: reviewer, reason: "Open review" },
    );
    assert.deepEqual(reviewSeen, ["medium"]);
    assert.equal(getTask(task.id).status, "reviewing");
    assert.equal(runEffort(task.id, "reviewer"), "medium");
    assert.match(startedReason(task.id), new RegExp(zhCN("effort.noteProfile", {"effort":"medium"})));
    assert.doesNotMatch(startedReason(task.id), new RegExp(zhCN("routing.effortSource.card")));
  });

  it("records the profile depth when the card does not force one", async () => {
    const seen: string[] = [];
    const task = createTask({ project: "effort", title: "profile default", role: "executor", workspacePath: work });
    await startTask(task.id, launcher((thinking) => seen.push(thinking ?? ""), async () => {
      throw new Error("No model lookup without explicit depth");
    }), "test", {
      profiles: [executor],
      chosen: executor,
      reason: "Default start",
    });
    assert.deepEqual(seen, ["high"]);
    assert.equal(runEffort(task.id, "executor"), "high");
    assert.match(startedReason(task.id), new RegExp(zhCN("effort.noteProfile", {"effort":"high"})));
    getDb()
      .prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, 'old-run', 'executor', ?)")
      .run(task.id, "2026-09-01T00:00:00.000Z");
    const old = getDb().prepare("SELECT effort FROM runs WHERE agent_id = 'old-run'").get() as { effort: string | null };
    assert.equal(old.effort, null);
  });

  it("overrides a standalone reviewer and a reader, because that is the card's own role", async () => {
    const reviewSeen: string[] = [];
    const reviewCard = createTask({ project: "effort", title: "demo fixture Reviewer", role: "reviewer", workspacePath: work, effort: "xhigh" });
    await startTask(reviewCard.id, launcher((thinking) => reviewSeen.push(thinking ?? ""), (provider) => Promise.resolve(catalog(provider))), "test", {
      profiles: [reviewer],
      chosen: reviewer,
      reason: "Reviewer sample",
    });
    assert.deepEqual(reviewSeen, ["xhigh"]);
    assert.equal(runEffort(reviewCard.id, "reviewer"), "xhigh");
    assert.match(startedReason(reviewCard.id), new RegExp(zhCN("effort.noteCard", {"effort":"xhigh"})));

    const readSeen: string[] = [];
    const readCard = createTask({ project: "effort", title: "Reader", role: "reader", workspacePath: work, effort: "low" });
    await startTask(readCard.id, launcher((thinking) => readSeen.push(thinking ?? ""), (provider) => Promise.resolve(catalog(provider))), "test", {
      profiles: [reader],
      chosen: reader,
      reason: "Reader card",
    });
    assert.deepEqual(readSeen, ["low"]);
    assert.equal(runEffort(readCard.id, "reader"), "low");
  });

  it("keeps the original depth when the executor is sent back to rework", async () => {
    const reworkRoom = join(work, "rework");
    mkdirSync(reworkRoom, { recursive: true });
    const task = createTask({ project: "effort", title: "Rework", role: "executor", workspacePath: reworkRoom, effort: "low" });
    await startTask(task.id, launcher(undefined, (provider) => Promise.resolve(catalog(provider))), "test", {
      profiles: [executor],
      chosen: executor,
      reason: "Start first",
    });
    completeTask(task.id, "executor", "Submit first", null);
    getDb().prepare("UPDATE tasks SET status = 'rework' WHERE id = ?").run(task.id);
    let created = 0;
    await startTask(
      task.id,
      {
        async create() {
          created += 1;
          return { id: "should-not" };
        },
        async send() {},
      },
      "test",
    );
    assert.equal(created, 0);
    assert.equal(getTask(task.id).status, "running");
    const runs = getDb().prepare("SELECT effort, thinking_option_id, agent_id FROM runs WHERE task_id = ? ORDER BY id ASC").all(task.id) as Array<{
      effort: string | null;
      thinking_option_id: string | null;
      agent_id: string;
    }>;
    const latest = runs[runs.length - 1];
    assert.ok(latest);
    assert.equal(latest.effort, "low");
    assert.equal(latest.thinking_option_id, "low");
    assert.equal(latest.agent_id, runs[0]?.agent_id);
  });

  it("holds and wakes once when no eligible model can run the depth, then retries", async () => {
    setAgentAliveCheck((id) => id === "boss");
    resetBoardWakeForTests();
    sent.length = 0;
    setWakeSender((id, text) => {
      sent.push({ id, text });
    });
    const waitDir = join(dir, "wait");
    mkdirSync(waitDir, { recursive: true });
    const cfg = config();
    cfg.autoStart = { effort: false, "effort-wait": true };
    saveConfig(cfg);
    let created = 0;
    const limited: AgentLauncher = {
      async create() {
        created += 1;
        return { id: "should-not-open" };
      },
      async send() {},
      async listModels() {
        return { models: [{ id: "grok-4.7", thinkingOptions: [{ id: "high" }] }] };
      },
    };
    const task = createTask({ project: "effort-wait", title: "Insufficient depth", role: "executor", workspacePath: waitDir, effort: "max" });
    const result = await startTask(task.id, limited, "scheduler", { profiles: [executor, reviewer], chosen: executor, reason: "Ready to start" });
    assert.equal(created, 0);
    assert.match(result.message, new RegExp(zhCN("routing.skipNamed", {"name":zhCN("labels.role.executor"),"why":(zhCNPart("routing.noEffortSupport", 0, 6) + "max")})));
    const blocked = getTask(task.id);
    assert.equal(blocked.status, "ready");
    assert.equal(blocked.blocked_kind, null);
    assert.equal(blocked.blocked_reason, null);
    assert.equal(sent.length, 1);
    const wakes = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'board_wake'").get(task.id) as { n: number };
    assert.equal(wakes.n, 1);

    await runTick({
      profiles: [executor, reviewer],
      launcher: limited,
      config: cfg,
      pools,
      send: async (id, text) => {
        sent.push({ id, text });
      },
    });
    assert.equal(created, 0);
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(sent.length, 1);
    const still = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'blocked'").get(task.id) as { n: number };
    assert.equal(still.n, 0);

    const ready: AgentLauncher = {
      async create() {
        created += 1;
        return { id: "effort-later" };
      },
      async send() {},
      async listModels() {
        return { models: [{ id: "grok-4.7", thinkingOptions: [{ id: "high" }, { id: "max" }] }] };
      },
    };
    await runTick({
      profiles: [executor, reviewer],
      launcher: ready,
      config: cfg,
      pools,
      send: async (id, text) => {
        sent.push({ id, text });
      },
    });
    assert.equal(created, 1);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(runEffort(task.id, "executor"), "max");
    assert.match(startedReason(task.id), new RegExp(zhCN("effort.noteCard", {"effort":"max"})));
    assert.equal(sent.length, 1);
  });

  it("does not open or wake when the model catalog cannot be read", async () => {
    setAgentAliveCheck((id) => id === "boss");
    sent.length = 0;
    setWakeSender((id, text) => {
      sent.push({ id, text });
    });
    config();
    let created = 0;
    const task = createTask({ project: "effort", title: "Broken list", role: "executor", workspacePath: work, effort: "low" });
    await startTask(
      task.id,
      {
        async create() {
          created += 1;
          return { id: "nope" };
        },
        async send() {},
        async listModels() {
          throw new Error("catalog down");
        },
      },
      "scheduler",
      { profiles: [executor], chosen: executor, reason: "Ready to start" },
    );
    assert.equal(created, 0);
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).blocked_kind, null);
    assert.equal(getTask(task.id).blocked_reason, null);
    assert.equal(getTask(task.id).hold_reason, zhCN("effort.catalogHold"));
    assert.equal(sent.length, 0);
    const wakes = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'board_wake' AND task_id = ?").get(task.id) as { n: number };
    assert.equal(wakes.n, 0);
  });
});
