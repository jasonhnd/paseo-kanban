/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { rememberEpisode, type DaemonEpisode } from "../server/daemon-log";
import { agentCwdMissing, resetMissingCwdForTests } from "../server/missing-cwd";
import type { PoolSnapshot } from "../server/pools";
import { resetRestartScanForTests, restartBoardMessage, RESTART_BOARD_TTL_MS, restartInterrupt, scanRestartStalls } from "../server/restart-stall";
import { boardExtras } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { activityFromSnapshot, activityInstant, lastTimelineStamp, resetStallScanForTests } from "../server/stall";
import { createTask, getTask, listBoard } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "restart-stall-"));
process.env.KANBAN_DATA_DIR = dir;

const restartAt = "2026-09-28T00:45:47.478Z";
const episode: DaemonEpisode = { id: "2026-09-28T00:45:42.311Z", at: restartAt };
const before = "2026-09-28T00:45:41.000Z";
const afterRestart = "2026-09-28T00:46:10.000Z";

const sent: Array<{ id: string; text: string }> = [];
const pools: PoolSnapshot = {
  state: "fresh",
  message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
  generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};

function config(): KanbanConfig {
  const saved: KanbanConfig = {
    autoStart: { restart: false },
    supervisorAgentId: "kanban-boss",
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
    restartStallGraceMs: 120_000,
    stallIdleMs: 10 * 60_000,
  };
  saveConfig(saved);
  return saved;
}

function open(agentId: string, status: "running" | "reviewing" = "running"): number {
  const task = createTask({ project: "restart", title: agentId, role: status === "reviewing" ? "reviewer" : "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = ? WHERE id = ?").run(status, agentId, task.id);
  return task.id;
}

function events(taskId: number, kind: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number };
  return row.n;
}

function scan(
  now: Date,
  last: Record<string, string | null>,
  extra?: { cwdMissing?: (agentId: string) => string | null; episode?: DaemonEpisode | null; intervalMs?: number },
) {
  return scanRestartStalls({
    now,
    config: config(),
    intervalMs: extra?.intervalMs,
    episode: extra?.episode === undefined ? episode : extra.episode,
    cwdMissing: extra?.cwdMissing,
    lastActivity: (agentId) => last[agentId] ?? null,
    send: async (id, text) => {
      sent.push({ id, text });
    },
  });
}

after(() => {
  resetStallScanForTests();
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  resetMissingCwdForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("stall after daemon restart", { concurrency: 1 }, () => {
  beforeEach(() => {
    sent.length = 0;
    resetStallScanForTests();
    resetRestartScanForTests();
    resetBoardWakeForTests();
    resetMissingCwdForTests();
    setAgentAliveCheck(() => true);
    setWakeSender((id, text) => {
      sent.push({ id, text });
    });
  });

  it("reads a busy agent's clock and the newest timeline stamp", () => {
    const busy = activityFromSnapshot({ status: "running", updatedAt: before, activeTurn: { turnId: "t" } });
    assert.equal(busy.state, "busy");
    assert.equal(busy.lastAt, before);
    assert.equal(activityInstant({ updatedAt: before, lastActivityAt: "2026-09-28T00:40:00.000Z" }, afterRestart), afterRestart);
    assert.equal(lastTimelineStamp([{ timestamp: before }, { timestamp: afterRestart }, { timestamp: "nope" }]), afterRestart);
    assert.equal(lastTimelineStamp(null), null);
  });

  it("nudges running and reviewing cards whose last activity is before the restart, once", async () => {
    const running = open("dead-exec");
    const reviewing = open("dead-review", "reviewing");
    const moved = open("alive-exec");
    const quiet = open("unknown-exec");
    const restartMs = Date.parse(restartAt);
    const clocks: Record<string, string | null> = {
      "dead-exec": before,
      "dead-review": before,
      "alive-exec": afterRestart,
      "unknown-exec": null,
    };
    await scan(new Date(restartMs + 60_000), clocks);
    assert.equal(events(running, "stalled_after_restart"), 0);
    assert.equal(sent.length, 0);
    assert.equal(restartBoardMessage(restartMs + 60_000), null);

    await scan(new Date(restartMs + 120_000), clocks);
    assert.equal(events(running, "stalled_after_restart"), 1);
    assert.equal(events(reviewing, "stalled_after_restart"), 1);
    assert.equal(events(moved, "stalled_after_restart"), 0);
    assert.equal(events(quiet, "stalled_after_restart"), 0);
    assert.equal(sent.filter((item) => item.id === "dead-exec").length, 1);
    assert.equal(sent.find((item) => item.id === "dead-exec")?.text, restartInterrupt());
    assert.equal(sent.find((item) => item.id === "dead-review")?.text, restartInterrupt());
    assert.equal(sent.some((item) => item.id === "alive-exec" || item.id === "unknown-exec"), false);
    const note = restartBoardMessage(restartMs + 120_000);
    const clock = `${new Date(restartMs).getHours().toString().padStart(2, "0")}:${new Date(restartMs).getMinutes().toString().padStart(2, "0")}`;
    assert.equal(note, `${zhCNPart("restartStall.board", 0, 3)}${clock} ${zhCNPart("restartStall.board", 11, 15)}2 ${zhCNPart("restartStall.board", 23, 42)}`);
    const recent = new Date(Date.now() - 60_000).toISOString();
    rememberEpisode({ id: episode.id, at: recent });
    assert.match(boardExtras().restartMessage ?? "", new RegExp("2 " + localePattern(zhCNPart("missingCwd.purge.notThisCard", 4, 6))));
    rememberEpisode(episode);

    await scan(new Date(restartMs + 180_000), clocks);
    assert.equal(events(running, "stalled_after_restart"), 1);
    assert.equal(sent.filter((item) => item.id === "dead-exec").length, 1);
    assert.equal(getTask(running).status, "running");
    assert.equal(getTask(reviewing).status, "reviewing");
  });

  it("wakes the Kanban supervisor once when the nudged agent is still quiet after 10 minutes", async () => {
    const running = open("still-dead");
    const resumed = open("resumed");
    const restartMs = Date.parse(restartAt);
    const clocks: Record<string, string | null> = { "still-dead": before, resumed: before };
    await scan(new Date(restartMs + 120_000), clocks);
    clocks.resumed = new Date(restartMs + 130_000).toISOString();
    await scan(new Date(restartMs + 120_000 + 10 * 60_000), clocks);
    assert.equal(events(running, "stall_nudge"), 0);
    assert.equal(events(running, "board_wake"), 1);
    assert.equal(events(resumed, "board_wake"), 0);
    assert.equal(sent.filter((item) => item.id === "kanban-boss").length, 1);
    const note = listBoard("restart").tasks.find((card) => card.id === running)?.stallNote ?? "";
    assert.match(note, new RegExp("^" + localePattern(zhCNPart("stall.label", 0, 13)) + "\\d+ " + localePattern(zhCNPart("stall.label", 23, 28)) + "$"));
    await scan(new Date(restartMs + 120_000 + 30 * 60_000), clocks);
    assert.equal(events(running, "board_wake"), 1);
    assert.equal(sent.filter((item) => item.id === "kanban-boss").length, 1);
  });

  it("does not message an agent whose working directory is gone", async () => {
    const previous = process.env.KANBAN_AGENTS_DIR;
    const agents = mkdtempSync(join(dir, "agents-"));
    const missing = join(dir, "no-such-workspace");
    process.env.KANBAN_AGENTS_DIR = agents;
    try {
      mkdirSync(join(agents, "aa"));
      writeFileSync(
        join(agents, "aa", "gone-agent.json"),
        JSON.stringify({ id: "gone-agent", cwd: missing, updatedAt: before }),
      );
      const running = open("gone-agent");
      assert.equal(agentCwdMissing("gone-agent"), missing);
      await scan(new Date(Date.parse(restartAt) + 120_000), { "gone-agent": before }, { cwdMissing: agentCwdMissing });
      assert.equal(sent.length, 0);
      assert.equal(events(running, "stalled_after_restart"), 1);
      assert.equal(events(running, "wake_skipped_missing_cwd"), 1);
      assert.equal(getTask(running).status, "ready");
      const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'stalled_after_restart'").get(running) as {
        data_json: string;
      };
      const data = JSON.parse(row.data_json) as { sent?: boolean };
      assert.equal(data.sent, false);
    } finally {
      if (previous === undefined) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = previous;
      resetMissingCwdForTests();
    }
  });

  it("follows the same check from a scheduler tick", async () => {
    const running = open("tick-exec");
    await runTick({
      now: new Date(Date.parse(restartAt) + 120_000),
      profiles: [],
      pools,
      config: config(),
      launcher: { async create() { return { id: "nope" }; }, async send() {} },
      agentState: () => "alive",
      stallIntervalMs: 0,
      watchDaemonRestart: true,
      daemonEpisode: episode,
      agentActivity: async () => ({ state: "busy", lastAt: before }),
      send: async (id, text) => {
        sent.push({ id, text });
      },
    });
    assert.equal(events(running, "stalled_after_restart"), 1);
    assert.equal(events(running, "stall_nudge"), 0);
    assert.equal(sent.filter((item) => item.id === "tick-exec").length, 1);
  });

  it("does not scan again until stallIntervalMs has passed", async () => {
    const running = open("throttled-exec");
    const restartMs = Date.parse(restartAt);
    const clocks = { "throttled-exec": before };
    await scan(new Date(restartMs + 120_000), clocks, { intervalMs: 5 * 60_000 });
    assert.equal(sent.filter((item) => item.id === "throttled-exec").length, 1);
    await scan(new Date(restartMs + 180_000), clocks, { intervalMs: 5 * 60_000 });
    assert.equal(sent.filter((item) => item.id === "throttled-exec").length, 1);
    assert.equal(events(running, "stalled_after_restart"), 1);
    await scan(new Date(restartMs + 120_000 + 5 * 60_000), clocks, { intervalMs: 5 * 60_000 });
    assert.equal(events(running, "stalled_after_restart"), 1);
    assert.equal(sent.filter((item) => item.id === "throttled-exec").length, 1);
  });

  it("hides the banner when no card was handled and after an hour", async () => {
    const quietAt = "2026-09-28T05:00:00.000Z";
    const quiet = { id: quietAt, at: quietAt };
    await scan(new Date(Date.parse(quietAt) + 120_000), {}, { episode: quiet, intervalMs: 0 });
    assert.equal(restartBoardMessage(Date.parse(quietAt) + 120_000), null);

    const bannerAt = "2026-09-28T06:00:00.000Z";
    const banner = { id: bannerAt, at: bannerAt };
    open("banner-exec");
    await scan(new Date(Date.parse(bannerAt) + 120_000), { "banner-exec": before }, { episode: banner, intervalMs: 0 });
    const shown = restartBoardMessage(Date.parse(bannerAt) + 120_000);
    assert.match(shown ?? "", new RegExp("1 " + localePattern(zhCNPart("missingCwd.purge.notThisCard", 4, 6))));
    assert.equal(restartBoardMessage(Date.parse(bannerAt) + RESTART_BOARD_TTL_MS - 1), shown);
    assert.equal(restartBoardMessage(Date.parse(bannerAt) + RESTART_BOARD_TTL_MS), null);
  });
});
