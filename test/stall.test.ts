/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { cliFallback } from "../server/fallback";
import type { PoolSnapshot } from "../server/pools";
import { runTick } from "./helpers/compat-schedule";
import { activityFromSnapshot, resetStallScanForTests, type AgentActivity } from "../server/stall";
import { appendEvent, blockTask, createTask, getTask, listBoard } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "stall-"));
process.env.KANBAN_DATA_DIR = dir;

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
    autoStart: { stall: false },
    supervisorAgentId: "kanban-boss",
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
  saveConfig(saved);
  return saved;
}

function open(role: string, agentId: string, status: "running" | "reviewing" | "blocked" | "acceptance" | "in_review" = "running"): number {
  const task = createTask({ project: "stall", title: agentId, role, workspacePath: dir });
  if (status === "blocked") {
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(agentId, task.id);
    blockTask(task.id, "needs_human", "Wait for agent", "executor");
    return task.id;
  }
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = ? WHERE id = ?").run(status, agentId, task.id);
  return task.id;
}

function events(taskId: number, kind: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number };
  return row.n;
}

after(() => {
  resetStallScanForTests();
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("stalled running cards", () => {
  beforeEach(() => {
    sent.length = 0;
    resetStallScanForTests();
    resetBoardWakeForTests();
    setAgentAliveCheck(() => true);
    setWakeSender((id, text) => {
      sent.push({ id, text });
    });
  });

  it("nudges once, then wakes the Kanban supervisor once", async () => {
    const now = new Date("2026-09-27T02:00:00.000Z");
    const since = new Date(now.getTime() - 11 * 60_000).toISOString();
    const running = open("decision", "idle-reader");
    const reviewing = open("reviewer", "idle-reviewer", "reviewing");
    const activity = async (agentId: string): Promise<AgentActivity> => ({ state: "idle", since });
    const tick = (at: Date) =>
      runTick({
        now: at,
        profiles: [],
        pools,
        config: config(),
        launcher: { async create() { return { id: "nope" }; }, async send() {} },
        agentState: () => "alive",
        stallIntervalMs: 0,
        stallIdleMs: 10 * 60_000,
        agentActivity: activity,
        send: async (id, text) => {
          sent.push({ id, text });
        },
      });
    await tick(now);
    assert.equal(events(running, "stall_nudge"), 1);
    assert.equal(events(reviewing, "stall_nudge"), 1);
    assert.equal(events(running, "board_wake"), 0);
    assert.equal(listBoard("stall").tasks.find((card) => card.id === running)?.stallNote, null);
    const nudge = sent.find((item) => item.id === "idle-reader");
    assert.ok(nudge);
    assert.match(nudge.text, /bin\/paseo-kanban complete/);
    assert.doesNotMatch(nudge.text, /paseo-kanban\.mjs/);
    assert.match(nudge.text, /PASEO_AGENT_ID/);
    assert.match(nudge.text, new RegExp("\\u5982\\u679c\\u4f60\\u5728\\u7b49\\u540e\\u53f0\\u7ed3\\u679c\\uff0c\\u8bf7\\u73b0\\u5728\\u8bfb\\u53d6\\u7ed3\\u679c\\uff0c\\u4e0d\\u8981\\u518d\\u6b21\\u7ed3\\u675f\\u56de\\u5408"));
    assert.equal(nudge.text.includes(cliFallback()), true);
    assert.doesNotMatch(nudge.text, new RegExp(localePattern(zhCNPart("stall.nudge.quiet", 44, 46)) + localePattern(zhCNPart("compat.skip.kanbanEnv", 14, 16)) + localePattern(zhCNPart("tempWorkspace.drop.placeholderAgentsDeleted", 2, 5)) + "KANBAN_TOKEN"));

    await tick(new Date(now.getTime() + 10 * 60_000));
    assert.equal(events(running, "stall_nudge"), 1);
    assert.equal(events(running, "board_wake"), 1);
    assert.equal(events(running, "stalled"), 1);
    // A review card asks the leader to rule. It does not get the old stall wake.
    assert.equal(events(reviewing, "review_ruling"), 1);
    assert.equal(events(reviewing, "stalled"), 0);
    assert.equal(events(reviewing, "board_wake"), 1);
    assert.equal(events(reviewing, "approve"), 0);
    const note = listBoard("stall").tasks.find((card) => card.id === running)?.stallNote ?? "";
    assert.equal(note, zhCN("stall.label", {"minutes":"21"}));
    const reviewNote = listBoard("stall").tasks.find((card) => card.id === reviewing)?.stallNote ?? "";
    assert.equal(reviewNote, "");
    assert.equal(sent.filter((item) => item.id === "kanban-boss").length, 2);
    assert.ok(sent.some((item) => item.id === "kanban-boss" && item.text.includes(zhCNPart("boardView.cmd.ruling", 1, 3))));

    await tick(new Date(now.getTime() + 30 * 60_000));
    assert.equal(events(running, "board_wake"), 1);
    assert.equal(events(reviewing, "board_wake"), 1);
    assert.equal(events(reviewing, "review_ruling"), 1);
    assert.equal(sent.filter((item) => item.id === "kanban-boss").length, 2);
    assert.equal(getTask(running).status, "running");
    assert.equal(getTask(reviewing).status, "reviewing");
    assert.equal(events(running, "auto_complete"), 0);
    assert.equal(events(reviewing, "auto_complete"), 0);
  });

  it("auto-completes a quiet executor ten minutes after one nudge, and not before", async () => {
    const now = new Date("2026-09-27T04:00:00.000Z");
    const since = new Date(now.getTime() - 11 * 60_000).toISOString();
    const running = open("executor", "quiet-exec");
    const tick = (at: Date) =>
      runTick({
        now: at,
        profiles: [],
        pools,
        config: config(),
        launcher: { async create() { return { id: "nope" }; }, async send() {} },
        agentState: () => "alive",
        stallIntervalMs: 0,
        stallIdleMs: 10 * 60_000,
        agentActivity: async () => ({ state: "idle", since, lastAssistant: (zhCNPart("flow.auto.prefix", 29, 32) + "Demo text stall" + zhCN("common.comma") + "Demo text") }),
        send: async (id, text) => {
          sent.push({ id, text });
        },
      });
    await tick(now);
    assert.equal(events(running, "stall_nudge"), 1);
    assert.equal(events(running, "auto_complete"), 0);
    assert.equal(getTask(running).status, "running");
    assert.match(sent.find((item) => item.id === "quiet-exec")?.text ?? "", new RegExp(localePattern(zhCNPart("flow.auto.prefix", 3, 5))));
    await tick(new Date(now.getTime() + 10 * 60_000 - 1));
    assert.equal(events(running, "auto_complete"), 0);
    assert.equal(getTask(running).status, "running");
    await tick(new Date(now.getTime() + 10 * 60_000));
    assert.equal(events(running, "auto_complete"), 1);
    assert.equal(events(running, "stall_nudge"), 1);
    assert.equal(events(running, "board_wake"), 0);
    const done = getTask(running);
    assert.equal(done.status, "in_review");
    const data = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'auto_complete'").get(running) as { data_json: string }).data_json,
    ) as { lastMessage?: string; to?: string };
    assert.equal(data.lastMessage, (zhCNPart("flow.auto.prefix", 29, 32) + "Demo text stall" + zhCN("common.comma") + "Demo text"));
    await tick(new Date(now.getTime() + 30 * 60_000));
    assert.equal(events(running, "auto_complete"), 1);
  });

  it("records one nudge for an archived executor, then auto-completes even if the nudge cannot be delivered", async () => {
    const now = new Date("2026-09-27T05:00:00.000Z");
    const since = new Date(now.getTime() - 11 * 60_000).toISOString();
    const running = open("executor", "archived-exec");
    const tick = (at: Date) =>
      runTick({
        now: at,
        profiles: [],
        pools,
        config: config(),
        launcher: { async create() { return { id: "nope" }; }, async send() {} },
        agentState: () => "alive",
        stallIntervalMs: 0,
        stallIdleMs: 10 * 60_000,
        agentActivity: async () => ({ state: "archived", since, lastAssistant: (zhCNPart("tempWorkspace.wip.commitMessage", 12, 15) + "Demo text") }),
        send: async () => {
          throw new Error(("agent " + zhCN("missingCwd.report.isArchived")));
        },
      });
    await tick(now);
    assert.equal(events(running, "stall_nudge"), 1);
    assert.equal(events(running, "auto_complete"), 0);
    assert.equal(getTask(running).status, "running");
    await tick(new Date(now.getTime() + 10 * 60_000));
    assert.equal(getTask(running).status, "in_review");
    assert.equal(events(running, "auto_complete"), 1);
    assert.equal(events(running, "reclaimed"), 0);
  });

  it("asks the leader to rule on a quiet review and does not approve", async () => {
    const now = new Date("2026-09-27T06:00:00.000Z");
    const since = new Date(now.getTime() - 11 * 60_000).toISOString();
    const reviewing = open("reviewer", "quiet-reviewer", "reviewing");
    const tick = (at: Date) =>
      runTick({
        now: at,
        profiles: [],
        pools,
        config: config(),
        launcher: { async create() { return { id: "nope" }; }, async send() {} },
        agentState: () => "alive",
        stallIntervalMs: 0,
        stallIdleMs: 10 * 60_000,
        agentActivity: async () => ({ state: "idle", since, lastAssistant: ("Reviewed diff" + zhCNPart("nudge.failed.noMessage", 4, 7) + "Demo text") }),
        send: async (id, text) => {
          sent.push({ id, text });
        },
      });
    await tick(now);
    assert.equal(events(reviewing, "stall_nudge"), 1);
    assert.equal(events(reviewing, "review_ruling"), 0);
    assert.equal(getTask(reviewing).status, "reviewing");
    await tick(new Date(now.getTime() + 10 * 60_000));
    assert.equal(getTask(reviewing).status, "reviewing");
    assert.equal(events(reviewing, "review_ruling"), 1);
    assert.equal(events(reviewing, "approve"), 0);
    assert.equal(events(reviewing, "auto_complete"), 0);
    const ruling = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'review_ruling'").get(reviewing) as { data_json: string }).data_json,
    ) as { lastMessage?: string };
    assert.equal(ruling.lastMessage, ("Reviewed diff" + zhCNPart("nudge.failed.noMessage", 4, 7) + "Demo text"));
    const wake = sent.find((item) => item.id === "kanban-boss" && item.text.includes(zhCNPart("boardView.cmd.ruling", 1, 3)));
    assert.ok(wake);
    assert.match(wake.text, new RegExp("Reviewed diff" + localePattern(zhCNPart("nudge.failed.noMessage", 4, 7)) + "Demo text"));
    await tick(new Date(now.getTime() + 30 * 60_000));
    assert.equal(events(reviewing, "review_ruling"), 1);
    assert.equal(events(reviewing, "approve"), 0);
  });

  it("does not treat a busy, fresh, blocked, closed, finished, or unreadable agent as stalled", async () => {
    const now = new Date("2026-09-27T03:00:00.000Z");
    const longAgo = new Date(now.getTime() - 30 * 60_000).toISOString();
    const justNow = new Date(now.getTime() - 60_000).toISOString();
    const busy = open("executor", "busy-agent");
    const fresh = open("executor", "fresh-agent");
    const unknown = open("executor", "unknown-agent");
    const broken = open("executor", "broken-agent");
    const gone = open("executor", "gone-agent");
    const finished = open("reader", "finished-agent", "acceptance");
    const blocked = open("executor", "blocked-agent", "blocked");
    const seen: string[] = [];
    sent.length = 0;
    await runTick({
      now,
      profiles: [],
      pools,
      config: config(),
      launcher: { async create() { return { id: "nope" }; }, async send() {} },
      agentState: (agentId) => (agentId === "gone-agent" ? "closed" : "alive"),
      stallIntervalMs: 0,
      stallIdleMs: 10 * 60_000,
      agentActivity: async (agentId) => {
        seen.push(agentId);
        if (agentId === "busy-agent") return { state: "busy" };
        if (agentId === "fresh-agent") return { state: "idle", since: justNow };
        if (agentId === "unknown-agent") return { state: "unknown" };
        if (agentId === "broken-agent") throw new Error(zhCNPart("doctor.matrix.unknown", 4, 7));
        return { state: "idle", since: longAgo };
      },
      send: async (id, text) => {
        sent.push({ id, text });
      },
    });
    assert.equal(seen.includes("gone-agent"), false);
    assert.equal(seen.includes("finished-agent"), false);
    assert.equal(seen.includes("blocked-agent"), false);
    assert.equal(events(busy, "stall_nudge"), 0);
    assert.equal(events(fresh, "stall_nudge"), 0);
    assert.equal(events(unknown, "stall_nudge"), 0);
    assert.equal(events(broken, "stall_nudge"), 0);
    assert.equal(events(gone, "stall_nudge"), 0);
    assert.equal(events(blocked, "stall_nudge"), 0);
    assert.equal(events(gone, "reclaimed"), 1);
    assert.equal(getTask(gone).status, "ready");
    assert.equal(getTask(busy).status, "running");
    assert.equal(getTask(finished).status, "acceptance");
    assert.equal(getTask(blocked).status, "blocked");
    assert.equal(events(busy, "board_wake") + events(fresh, "board_wake") + events(unknown, "board_wake") + events(broken, "board_wake") + events(blocked, "board_wake"), 0);
  });

  it("reads idle from a finished turn and refuses to guess when the clock is missing", () => {
    assert.equal(activityFromSnapshot({ status: "running", updatedAt: "2026-09-27T00:00:00.000Z" }).state, "busy");
    assert.equal(activityFromSnapshot({ status: "idle", activeTurn: { turnId: "t" }, updatedAt: "2026-09-27T00:00:00.000Z" }).state, "busy");
    assert.equal(activityFromSnapshot({ status: "closed", updatedAt: "2026-09-27T00:00:00.000Z" }).state, "unknown");
    const archived = activityFromSnapshot({ status: "idle", archivedAt: "2026-09-27T01:00:00.000Z", updatedAt: "2026-09-27T01:00:00.000Z" });
    assert.equal(archived.state, "archived");
    assert.equal(archived.since, "2026-09-27T01:00:00.000Z");
    assert.equal(activityFromSnapshot({ status: "idle" }).state, "unknown");
    assert.equal(activityFromSnapshot(null).state, "unknown");
    const idle = activityFromSnapshot({
      status: "idle",
      updatedAt: "2026-09-27T01:00:00.000Z",
      lastActivityAt: "2026-09-27T02:00:00.000Z",
      attentionReason: "finished",
      attentionTimestamp: "2026-09-27T02:25:00.000Z",
    });
    assert.equal(idle.state, "idle");
    assert.equal(idle.since, "2026-09-27T02:25:00.000Z");
  });

  it("starts idle at the newest clock, not a stale finished attention", () => {
    const stale = "2026-09-30T00:01:00.000Z";
    const moved = "2026-09-30T01:22:00.000Z";
    const fromActivity = activityFromSnapshot({
      status: "idle",
      attentionReason: "finished",
      attentionTimestamp: stale,
      lastActivityAt: moved,
      updatedAt: stale,
    });
    assert.equal(fromActivity.state, "idle");
    assert.equal(fromActivity.since, moved);
    const fromUpdated = activityFromSnapshot({
      status: "idle",
      attentionReason: "finished",
      attentionTimestamp: stale,
      lastActivityAt: stale,
      updatedAt: moved,
    });
    assert.equal(fromUpdated.since, moved);
    const fromTimeline = activityFromSnapshot(
      {
        status: "idle",
        attentionReason: "finished",
        attentionTimestamp: stale,
        lastActivityAt: stale,
        updatedAt: stale,
      },
      moved,
    );
    assert.equal(fromTimeline.since, moved);
    assert.equal(fromTimeline.lastAt, moved);
  });

  it("does not report a stall inside 90 minutes of a comment, unblock, or resume", async () => {
    const now = new Date("2026-09-30T01:31:47.000Z");
    const stale = "2026-09-30T00:01:00.000Z";
    const idleMs = 90 * 60_000;
    const commented = open("executor", "comment-agent");
    const unblocked = open("executor", "unblock-agent");
    const resumed = open("executor", "resume-agent");
    const stranger = open("executor", "stranger-card");
    const nudgedOnly = open("executor", "nudged-agent");
    const quiet = open("executor", "quiet-agent");
    const commentedLongAgo = open("executor", "old-comment-agent");
    const replied = open("executor", "replied-agent");
    appendEvent(commented, "nudge", null, "running", "comment-agent", { count: 1, action: "remind" }, "2026-09-30T01:21:00.000Z");
    appendEvent(commented, "comment", null, "running", "comment-agent", { agentId: "comment-agent" }, "2026-09-30T01:22:00.000Z");
    appendEvent(unblocked, "unblocked", "blocked", "running", "supervisor", {}, "2026-09-30T01:20:00.000Z");
    appendEvent(resumed, "resumed", "rework", "running", "scheduler", { agentId: "resume-agent" }, "2026-09-30T01:25:00.000Z");
    appendEvent(stranger, "comment", null, "running", "someone-else", { agentId: "someone-else" }, "2026-09-30T01:30:00.000Z");
    appendEvent(nudgedOnly, "nudge", null, "running", "nudged-agent", { count: 1, action: "remind" }, "2026-09-30T01:21:00.000Z");
    appendEvent(commentedLongAgo, "comment", null, "running", "old-comment-agent", { agentId: "old-comment-agent" }, stale);
    appendEvent(replied, "stall_nudge", null, "running", "scheduler", { agentId: "replied-agent" }, "2026-09-30T00:01:30.000Z");
    appendEvent(replied, "comment", null, "running", "replied-agent", { agentId: "replied-agent" }, "2026-09-30T01:22:00.000Z");

    const tick = (at: Date) =>
      runTick({
        now: at,
        profiles: [],
        pools,
        config: config(),
        launcher: { async create() { return { id: "nope" }; }, async send() {} },
        agentState: () => "alive",
        stallIntervalMs: 0,
        stallIdleMs: idleMs,
        agentActivity: async () => ({ state: "idle", since: stale, lastAt: stale }),
        send: async (id, text) => {
          sent.push({ id, text });
        },
      });

    await tick(now);
    assert.equal(events(commented, "stall_nudge"), 0);
    assert.equal(events(unblocked, "stall_nudge"), 0);
    assert.equal(events(resumed, "stall_nudge"), 0);
    assert.equal(events(stranger, "stall_nudge"), 1);
    // A turn-end nudge already counts. The idle scan must not send a second stall_nudge.
    assert.equal(events(nudgedOnly, "stall_nudge"), 0);
    assert.equal(events(nudgedOnly, "auto_complete"), 0);
    assert.equal(events(nudgedOnly, "stalled"), 0);
    assert.equal(getTask(nudgedOnly).status, "running");
    assert.equal(events(quiet, "stall_nudge"), 1);
    assert.equal(events(commentedLongAgo, "stall_nudge"), 1);
    assert.equal(events(replied, "board_wake"), 0);
    assert.equal(events(replied, "stall_nudge"), 1);

    const freshUnblock = open("executor", "fresh-unblock");
    const unblockAt = "2026-09-30T00:02:00.000Z";
    appendEvent(freshUnblock, "unblocked", "blocked", "running", "supervisor", {}, unblockAt);
    await tick(new Date(Date.parse(unblockAt) + idleMs - 1_000));
    assert.equal(events(freshUnblock, "stall_nudge"), 0);
    await tick(new Date(Date.parse(unblockAt) + idleMs));
    assert.equal(events(freshUnblock, "stall_nudge"), 1);
  });
});
