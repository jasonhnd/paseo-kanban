/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, DEFAULT_LOGIN_BLIP_RETRY_MS, loadConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { classifyFailure } from "../server/failures";
import { applyNudge } from "../server/flow";
import { endNoteOf, loginBlipReason, settleOpeningLoginBlip } from "../server/login-blip";
import { readAgentRecord } from "../server/open";
import { readAgentEndNote } from "../server/paseo";
import type { Profile } from "../server/profiles";
import { resetReconcileForTests, type TickOptions } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "login-blip-"));
process.env.KANBAN_DATA_DIR = dir;
const agents = join(dir, "agents");
process.env.KANBAN_AGENTS_DIR = agents;
mkdirSync(agents, { recursive: true });
const poolFile = join(dir, "pool-status.json");
process.env.KANBAN_POOL_STATUS = poolFile;

const primary: Profile = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  pool: "alternate",
};
const same: Profile = {
  id: "alt",
  name: "Executor·Sample text",
  role: "executor",
  family: "xai",
  provider: "alternate",
  model: "grok-4.7",
  pool: "alternate",
};
const profiles = [primary, same];

const sent: string[] = [];
const archived: string[] = [];

function limits(): KanbanConfig["concurrency"] {
  return {
    global: DEFAULT_CONCURRENCY.global,
    pools: { ...DEFAULT_CONCURRENCY.pools, alternate: 5 },
    roles: { ...DEFAULT_CONCURRENCY.roles, executor: 5 },
  };
}

function enable(project: string): KanbanConfig {
  const rows = getDb().prepare("SELECT DISTINCT project FROM tasks").all() as Array<{ project: string }>;
  const autoStart: Record<string, boolean> = {};
  for (const row of rows) autoStart[row.project] = row.project === project;
  autoStart[project] = true;
  const config: KanbanConfig = {
    autoStart,
    supervisorAgentId: "kanban-boss",
    supervisors: {},
    concurrency: limits(),
  };
  saveConfig(config);
  return loadConfig();
}

function launcher(): TickOptions["launcher"] {
  let n = 0;
  return {
    async create() {
      n += 1;
      return { id: `agent-${n}` };
    },
    async send() {},
  };
}

function blips(taskId: number): Array<{ agentId?: string; attempt?: number; profile?: string }> {
  const rows = getDb()
    .prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'login_blip' ORDER BY id`)
    .all(taskId) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as { agentId?: string; attempt?: number; profile?: string });
}

function stamp(taskId: number, at: string): void {
  getDb().prepare(`UPDATE runs SET started_at = ? WHERE task_id = ? AND ended_at IS NULL`).run(at, taskId);
}

async function blip(taskId: number, now: Date, note: string | null): Promise<"requeue" | "block" | "ignore"> {
  const task = getTask(taskId);
  return settleOpeningLoginBlip({
    taskId,
    agentId: task.agent_id ?? "",
    outcome: { kind: "completed" },
    timeline: [],
    lastUserMessageAt: null,
    now,
    readNote: async () => note,
    archive: async (agentId) => {
      archived.push(agentId);
    },
  });
}

beforeEach(() => {
  resetReconcileForTests();
  resetBoardWakeForTests();
  sent.length = 0;
  archived.length = 0;
  setWakeSender((_id, text) => {
    sent.push(text);
  });
  setAgentAliveCheck(() => true);
  writeFileSync(poolFile, JSON.stringify({ generatedAt: new Date().toISOString(), pools: { alternate: { dispatchable: true } } }));
});

after(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
  delete process.env.KANBAN_POOL_STATUS;
});

describe("login blip classification", () => {
  it("treats a first-turn login phrase as transient and leaves other auth errors as credential", () => {
    assert.equal(classifyFailure("Not logged in", "authentication_failed", { opening: true, priorBlips: 0 }), "transient");
    assert.equal(classifyFailure("Please run /login", undefined, { opening: true, priorBlips: 1 }), "transient");
    assert.equal(classifyFailure("authentication_failed", undefined, { opening: true, priorBlips: 2 }), "credential");
    assert.equal(classifyFailure("Not logged in", undefined, { opening: false, priorBlips: 0 }), "credential");
    assert.equal(classifyFailure("Not logged in"), "credential");
    assert.equal(classifyFailure("401 Unauthorized", undefined, { opening: true, priorBlips: 0 }), "credential");
    assert.equal(classifyFailure("invalid api key", undefined, { opening: true, priorBlips: 0 }), "credential");
    assert.equal(classifyFailure("authentication error", undefined, { opening: true, priorBlips: 0 }), "credential");
  });

  it("reads the end reason from the outcome or the last non-user timeline line", () => {
    assert.equal(endNoteOf({ kind: "failed", error: { message: "Please run /login", code: "authentication_failed" } }, []), "authentication_failed Please run /login");
    assert.equal(
      endNoteOf({ kind: "completed" }, [
        { type: "user_message", text: "Not logged in · Please run /login" },
        { type: "assistant_message", text: "Not logged in" },
      ]),
      "Not logged in",
    );
    assert.equal(endNoteOf({ kind: "completed" }, [{ type: "user_message", text: "Not logged in" }]), null);
    assert.equal(endNoteOf({ kind: "completed" }, [{ item: { type: "error", message: "authentication_failed" } }]), "authentication_failed");
  });
});

describe("login blip retry", () => {
  it("does not nudge, records login_blip, and reopens the same profile after the wait", async () => {
    assert.equal(DEFAULT_LOGIN_BLIP_RETRY_MS, 90_000);
    const work = join(dir, "once");
    mkdirSync(work, { recursive: true });
    const task = createTask({ project: "blip", title: "Initial login missing", role: "executor", workspacePath: work });
    const open = launcher();
    const opened = await startTask(task.id, open, "test", { profiles, chosen: same, reason: "demo fixture" });
    const now = new Date("2026-09-29T00:00:00.000Z");
    stamp(task.id, now.toISOString());
    const first = await settleOpeningLoginBlip({
      taskId: task.id,
      agentId: opened.agentId ?? "",
      outcome: { kind: "failed", error: { message: "Not logged in · Please run /login", code: "authentication_failed" } },
      timeline: [{ type: "user_message", text: "brief mentions Not logged in" }],
      lastUserMessageAt: null,
      now,
      archive: async (agentId) => {
        archived.push(agentId);
      },
    });
    assert.equal(first, "requeue");
    const queued = getTask(task.id);
    assert.equal(queued.status, "ready");
    assert.equal(queued.nudge_count, 0);
    assert.equal(queued.blocked_kind, "transient");
    const nudgeCount = getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'nudge'`).get(task.id) as { n: number };
    assert.equal(nudgeCount.n, 0);
    assert.deepEqual(blips(task.id), [{ agentId: opened.agentId, attempt: 1, profile: "Executor·Sample text" }]);
    assert.deepEqual(archived, [opened.agentId]);

    const config = enable("blip");
    const early = await runTick({
      profiles,
      launcher: open,
      now,
      config,
      agentState: () => "alive",
    });
    assert.equal(early.started.includes(task.id), false);
    assert.match(getTask(task.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("failures.cooldown", 0, 3))));

    const later = new Date(now.getTime() + DEFAULT_LOGIN_BLIP_RETRY_MS);
    const released = await runTick({
      profiles,
      launcher: open,
      now: later,
      config: loadConfig(),
      agentState: () => "alive",
    });
    assert.ok(released.started.includes(task.id));
    const again = getTask(task.id);
    assert.equal(again.status, "running");
    assert.equal(again.nudge_count, 0);
    assert.notEqual(again.agent_id, opened.agentId);
    const run = getDb()
      .prepare(`SELECT profile_name FROM runs WHERE task_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(task.id) as { profile_name: string };
    assert.equal(run.profile_name, "Executor·Sample text");
  });

  it("blocks and wakes on the third login blip", async () => {
    const work = join(dir, "three");
    mkdirSync(work, { recursive: true });
    const task = createTask({ project: "third", title: "Three login failures", role: "executor", workspacePath: work });
    const config = enable("third");
    const open = launcher();
    await startTask(task.id, open, "test", { profiles, chosen: same, reason: "demo fixture" });
    let now = new Date("2026-09-29T01:00:00.000Z");
    stamp(task.id, now.toISOString());
    assert.equal(await blip(task.id, now, "Not logged in"), "requeue");
    assert.equal(await blip(task.id, now, "Not logged in"), "ignore");

    now = new Date(now.getTime() + DEFAULT_LOGIN_BLIP_RETRY_MS);
    const second = await runTick({ profiles, launcher: open, now, config: loadConfig(), agentState: () => "alive" });
    assert.ok(second.started.includes(task.id));
    stamp(task.id, now.toISOString());
    assert.equal(await blip(task.id, now, "Please run /login"), "requeue");

    now = new Date(now.getTime() + DEFAULT_LOGIN_BLIP_RETRY_MS);
    const third = await runTick({ profiles, launcher: open, now, config, agentState: () => "alive" });
    assert.ok(third.started.includes(task.id));
    stamp(task.id, now.toISOString());
    assert.equal(await blip(task.id, now, "authentication_failed"), "block");

    const blocked = getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_kind, "needs_human");
    assert.equal(blocked.blocked_reason, loginBlipReason());
    assert.equal(blocked.nudge_count, 0);
    assert.deepEqual(
      blips(task.id).map((row) => row.attempt),
      [1, 2, 3],
    );
    assert.equal(blips(task.id)[2]?.agentId, blocked.agent_id);
    const wake = getDb().prepare(`SELECT data_json FROM events WHERE task_id = ? AND kind = 'board_wake'`).get(task.id) as { data_json: string };
    const data = JSON.parse(wake.data_json) as { kind?: string };
    assert.equal(data.kind, "fused");
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", new RegExp(localePattern(zhCNPart("loginBlip.reopenLater", 0, 5))));
  });

  it("still nudges an ordinary empty turn that is not the opening round", async () => {
    const work = join(dir, "nudge");
    mkdirSync(work, { recursive: true });
    const task = createTask({ project: "plain", title: "Ordinary empty turn", role: "executor", workspacePath: work });
    const opened = await startTask(task.id, launcher(), "test", { profiles, chosen: primary, reason: "Executor" });
    const aged = new Date(Date.now() - 120_000).toISOString();
    stamp(task.id, aged);
    const ignored = await settleOpeningLoginBlip({
      taskId: task.id,
      agentId: opened.agentId ?? "",
      outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text: (zhCNPart("reclaimNote.result.running", 0, 2) + "Demo text") }],
      lastUserMessageAt: aged,
      readNote: async () => null,
    });
    assert.equal(ignored, "ignore");
    assert.equal(blips(task.id).length, 0);
    const decision = applyNudge(task.id, false, { lastUserMessageAt: aged, graceMs: 60_000 });
    assert.equal(decision.action, "remind");
    assert.equal(decision.count, 1);
    assert.equal(getTask(task.id).nudge_count, 1);
    assert.equal(getTask(task.id).status, "running");
  });

  it("does not invent a login blip when the turn and the reader have no end reason", async () => {
    const work = join(dir, "quiet");
    mkdirSync(work, { recursive: true });
    const task = createTask({ project: "quiet", title: "No end reason", role: "executor", workspacePath: work });
    const opened = await startTask(task.id, launcher(), "test", { profiles, chosen: primary, reason: "Executor" });
    const now = new Date();
    stamp(task.id, now.toISOString());
    const ignored = await settleOpeningLoginBlip({
      taskId: task.id,
      agentId: opened.agentId ?? "",
      outcome: { kind: "completed" },
      timeline: [{ type: "user_message", text: "Not logged in · Please run /login" }],
      lastUserMessageAt: null,
      now,
      readNote: async () => null,
    });
    assert.equal(ignored, "ignore");
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).nudge_count, 0);
    assert.equal(blips(task.id).length, 0);
  });
});

describe("agent end note", () => {
  it("reads lastError from the agent record when the live timeline has nothing", async () => {
    mkdirSync(join(agents, "aa"), { recursive: true });
    writeFileSync(
      join(agents, "aa", "file-only.json"),
      JSON.stringify({ id: "file-only", cwd: dir, archivedAt: null, labels: {}, lastError: "Not logged in" }),
    );
    const recorded = readAgentRecord("file-only");
    assert.equal(recorded.state, "ok");
    if (recorded.state === "ok") assert.equal(recorded.file.lastError, "Not logged in");

    const paseo = {
      agents: {
        ref() {
          return {
            async refresh() {
              throw new Error("daemon down");
            },
            current() {
              return null;
            },
            timeline: {
              async refetch() {
                return { entries: [{ item: { type: "user_message", text: "Please run /login" } }] };
              },
            },
          };
        },
      },
    } as unknown as PaseoApi;
    assert.equal(await readAgentEndNote(paseo, "file-only"), "Not logged in");

    const live = {
      agents: {
        ref() {
          return {
            async refresh() {
              return { agent: { lastError: "" } };
            },
            current() {
              return null;
            },
            timeline: {
              async refetch() {
                return { entries: [{ item: { type: "assistant_message", text: "authentication_failed" } }] };
              },
            },
          };
        },
      },
    } as unknown as PaseoApi;
    assert.equal(await readAgentEndNote(live, "missing-file"), "authentication_failed");
  });
});
