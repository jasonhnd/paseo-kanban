/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, loadConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { applyNudge, approveTask } from "../server/flow";
import { isPluginClosingError } from "../server/failures";
import { runTick } from "./helpers/compat-schedule";
import { blockTask, createTask, getTask, unblockTask } from "../server/store";
import { childrenAllFinished, noteTickFailure, noteTickSuccess, resetAgentAliveCheck, resetBoardWakeForTests, retryUnattended, setAgentAliveCheck, wakeKanbanSupervisor } from "../server/wake";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "wake-"));
process.env.KANBAN_DATA_DIR = dir;

function setSupervisor(project: string, agentId: string): void {
  const stored = loadConfig();
  stored.supervisors[project] = agentId;
  saveConfig(stored);
}

const sent: Array<{ id: string; text: string }> = [];

function config(supervisorAgentId: string | null, supervisors: Record<string, string>): KanbanConfig {
  const saved: KanbanConfig = {
    autoStart: { wake: false, chain: false },
    supervisorAgentId,
    supervisors,
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
  };
  saveConfig(saved);
  return saved;
}

after(() => {
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("three-layer wake", () => {
  it("tries the registered project leader, then the global supervisor, and retries after a leader comes back", async () => {
    setWakeSender((id, text) => {
      sent.push({ id, text });
    });
    const saved = config("global-boss", { wake: "proj-boss" });

    setAgentAliveCheck((id) => id === "creator" || id === "proj-boss" || id === "global-boss");
    setSupervisor("wake", "creator");
    const review = createTask({ project: "wake", title: "Waiting for acceptance", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "Documentation updated" }), review.id);
    approveTask(review.id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    assert.equal(getTask(review.id).status, "acceptance");
    assert.equal(getTask(review.id).unattended_at, null);
    assert.ok(sent.some((item) => item.id === "creator" && item.text.includes(`${cardMark(review.id)}`) && item.text.includes("Documentation updated")));
    assert.equal(sent.some((item) => item.id === "proj-boss" || item.id === "global-boss"), false);
    setSupervisor("wake", "proj-boss");
    assert.ok(sent.every(item => new RegExp(localePattern(zhCNPart("board.attention.memo", 0, 9))).test(item.text) && new RegExp(localePattern(zhCNPart("boardView.note.reversible", 16, 26))).test(item.text) && /--role batch/.test(item.text)));

    sent.length = 0;
    setAgentAliveCheck((id) => id === "proj-boss" || id === "global-boss");
    const stuck = createTask({ project: "wake", title: "demo fixture", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    blockTask(stuck.id, "needs_human", "Missing API guide", "executor");
    assert.equal(getTask(stuck.id).status, "blocked");
    assert.equal(getTask(stuck.id).unattended_at, null);
    assert.ok(sent.some((item) => item.id === "proj-boss" && item.text.includes(`${cardMark(stuck.id)}`) && item.text.includes("Missing API guide")));
    assert.equal(sent.some((item) => item.id === "global-boss" || item.id === "creator"), false);
    assert.ok(sent.every(item => new RegExp(localePattern(zhCNPart("boardView.note.reversible", 28, 34))).test(item.text) && /roles decide add/.test(item.text) && new RegExp(localePattern(zhCNPart("routing.noExecProfile", 0, 2)) + "\\u6ce8\\u660e\\u51b3\\u7b56 id").test(item.text)));
    const weak = createTask({ project: "wake", title: "demo fixture", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    blockTask(weak.id, "capability", "Cannot do", "executor");
    assert.ok(sent.some((item) => item.id === "proj-boss" && item.text.includes(`${cardMark(weak.id)}`) && item.text.includes(zhCN("blocked.kind.capability"))));
    const quota = createTask({ project: "wake", title: "demo fixture", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    const beforeQuota = sent.length;
    blockTask(quota.id, "quota", "No quota", "executor");
    assert.equal(sent.length, beforeQuota);
    assert.equal(getTask(quota.id).unattended_at, null);

    sent.length = 0;
    setAgentAliveCheck((id) => id === "global-boss");
    const parent = createTask({ project: "chain", title: "demo fixture", role: "supervisor", initialStatus: "triage", createdByAgent: "parent-creator" });
    const child = createTask({
      project: "chain",
      title: "demo fixture",
      role: "executor",
      workspacePath: dir,
      parentIds: [parent.id],
      createdByAgent: "builder",
    });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(child.id);
    await runTick({
      profiles: [],
      launcher: { async create() { return { id: "unused" }; }, async send() {} },
      config: saved,
    });
    assert.equal(getTask(parent.id).status, "acceptance");
    assert.ok(getTask(parent.id).unattended_at);
    const woke = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_children'").get(parent.id) as { data_json: string };
    const wokeData = JSON.parse(woke.data_json) as { agentId: string; fallback?: boolean };
    assert.equal(wokeData.agentId, "global-boss");
    assert.equal(wokeData.fallback, true);
    assert.ok(sent.some((item) => item.id === "global-boss" && item.text.includes(`${cardMark(parent.id)}`) && item.text.includes(zhCN("wake.gap.unregistered"))));
    assert.equal(sent.some((item) => item.id === "builder" || item.id === "parent-creator" || item.id === "proj-boss"), false);
    assert.ok(sent.every(item => new RegExp(localePattern(zhCNPart("board.attention.memo", 0, 9))).test(item.text) && /--role batch/.test(item.text)));

    sent.length = 0;
    setAgentAliveCheck(() => false);
    const lost = createTask({ project: "wake", title: "Unclaimed", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    blockTask(lost.id, "needs_human", "Nobody available", "executor");
    assert.equal(getTask(lost.id).status, "blocked");
    assert.ok(getTask(lost.id).unattended_at);
    assert.equal(sent.length, 0);
    const missed = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'unattended'").get(lost.id) as { data_json: string };
    assert.match(missed.data_json, new RegExp(zhCN("cardParts.alert.unattended")));

    sent.length = 0;
    setAgentAliveCheck((id) => id === "creator");
    setSupervisor("wake", "creator");
    await runTick({
      profiles: [],
      launcher: { async create() { return { id: "unused" }; }, async send() {} },
      config: saved,
    });
    assert.ok(sent.some((item) => item.id === "creator" && item.text.includes(`${cardMark(lost.id)}`) && item.text.includes("Nobody available")));
    assert.equal(getTask(lost.id).unattended_at, null);
    assert.equal(getTask(lost.id).status, "blocked");

    sent.length = 0;
    setAgentAliveCheck(() => false);
    const again = createTask({ project: "wake", title: "Status clears", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    blockTask(again.id, "needs_human", "Block first", "executor");
    assert.ok(getTask(again.id).unattended_at);
    unblockTask(again.id, "supervisor");
    assert.equal(getTask(again.id).unattended_at, null);
    assert.notEqual(getTask(again.id).status, "blocked");
  });

  it("wakes the Kanban supervisor without clearing unattended, then the project supervisor on the next tick", async () => {
    sent.length = 0;
    const saved = config("kanban-boss", {});
    setAgentAliveCheck((id) => id === "kanban-boss");
    const lost = createTask({ project: "orphan", title: "Neither layer exists", role: "executor", workspacePath: dir, createdByAgent: "gone" });
    blockTask(lost.id, "needs_human", "Nobody registered", "executor");
    assert.ok(getTask(lost.id).unattended_at);
    const note = sent.find((item) => item.id === "kanban-boss" && item.text.includes(`${cardMark(lost.id)}`));
    assert.ok(note);
    assert.match(note.text, new RegExp(localePattern(zhCNPart("relatedView.field.project", 0, 3)) + "orphan"));
    assert.match(note.text, new RegExp(zhCN("wake.gap.unregistered")));
    assert.match(note.text, new RegExp(localePattern(zhCNPart("wake.fallback.note", 3, 19))));
    assert.match(note.text, new RegExp(localePattern(zhCNPart("wake.fallback.note", 44, 50))));
    sent.length = 0;
    await runTick({
      profiles: [],
      launcher: { async create() { return { id: "unused" }; }, async send() {} },
      config: saved,
    });
    assert.equal(sent.filter((item) => item.text.includes(`${cardMark(lost.id)}`)).length, 0);
    assert.ok(getTask(lost.id).unattended_at);

    setAgentAliveCheck((id) => id === "proj-boss" || id === "kanban-boss");
    setSupervisor("orphan", "proj-boss");
    await runTick({
      profiles: [],
      launcher: { async create() { return { id: "unused" }; }, async send() {} },
      config: loadConfig(),
    });
    assert.ok(sent.some((item) => item.id === "proj-boss" && item.text.includes(`${cardMark(lost.id)}`) && item.text.includes("Nobody registered")));
    assert.equal(getTask(lost.id).unattended_at, null);
  });

  it("says the registered session is closed when that supervisor is gone", () => {
    sent.length = 0;
    config("kanban-boss", { closedproj: "closed-boss" });
    setAgentAliveCheck((id) => id === "kanban-boss");
    const lost = createTask({ project: "closedproj", title: "Session closed", role: "executor", workspacePath: dir, createdByAgent: "gone" });
    blockTask(lost.id, "needs_human", "<leader>Closed", "executor");
    const note = sent.find((item) => item.id === "kanban-boss");
    assert.match(note?.text ?? "", new RegExp(zhCN("wake.gap.closed", {"id":"closed-boss"})));
    assert.ok(getTask(lost.id).unattended_at);
  });

  it("does not say the children are done when a prerequisite enters acceptance", () => {
    sent.length = 0;
    config("kanban-boss", { links: "proj-boss" });
    setAgentAliveCheck((id) => id === "proj-boss" || id === "kanban-boss");
    const parent = createTask({ project: "links", title: "Sample text", role: "executor", workspacePath: dir, createdByAgent: "proj-boss" });
    const child = createTask({
      project: "links",
      title: "Unstarted child",
      role: "executor",
      workspacePath: dir,
      parentIds: [parent.id],
    });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(parent.id);
    assert.equal(childrenAllFinished(parent.id), false);
    assert.notEqual(getTask(child.id).status, "done");
    retryUnattended();
    assert.equal(sent.some((item) => item.text.includes(zhCNPart("wake.children.next", 5, 11))), false);
    const childrenWake = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'wake_children'").get(parent.id);
    assert.equal(childrenWake, undefined);
    assert.ok(sent.some((item) => item.id === "proj-boss" && item.text.includes(zhCNPart("wake.acceptance.next", 0, 6))));
  });

  it("wakes the Kanban supervisor once for a board problem", () => {
    sent.length = 0;
    config("kanban-boss", {});
    setAgentAliveCheck((id) => id === "kanban-boss");
    const held = createTask({ project: "board", title: "Start failed", role: "executor", workspacePath: dir });
    assert.equal(wakeKanbanSupervisor({ taskId: held.id, kind: "start_failed", detail: "launcher exploded" }), true);
    assert.equal(wakeKanbanSupervisor({ taskId: held.id, kind: "start_failed", detail: "launcher exploded" }), false);
    assert.equal(sent.filter((item) => item.id === "kanban-boss" && item.text.includes(zhCN("cardParts.event.startFailed"))).length, 1);
    assert.equal(wakeKanbanSupervisor({ taskId: null, kind: "tick_error", detail: "tick blew up" }), true);
    assert.equal(wakeKanbanSupervisor({ taskId: null, kind: "tick_error", detail: "tick blew up" }), false);
    assert.equal(wakeKanbanSupervisor({ taskId: held.id, kind: "archive_stuck", detail: "Leave to child card" }), true);
    const other = createTask({ project: "board", title: "Sample text agent Both blocked", role: "executor", workspacePath: dir });
    assert.equal(wakeKanbanSupervisor({ taskId: other.id, kind: "archive_stuck", detail: "agent-a", subject: "agent-a" }), true);
    assert.equal(wakeKanbanSupervisor({ taskId: other.id, kind: "archive_stuck", detail: "agent-a", subject: "agent-a" }), false);
    assert.equal(wakeKanbanSupervisor({ taskId: other.id, kind: "archive_stuck", detail: "agent-b", subject: "agent-b" }), true);
    assert.equal(sent.filter((item) => item.text.includes("agent-a") || item.text.includes("agent-b")).length, 2);
  });

  it("wakes once when a start fails, after a second missed nudge, and after two tick errors", async () => {
    sent.length = 0;
    const saved = config("kanban-boss", { holdproj: "proj-boss" });
    setAgentAliveCheck(() => true);
    const profiles: Profile[] = [
      { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "g", pool: "cursor" },
      { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
    ];
    const pools: PoolSnapshot = {
      state: "fresh",
      message: "test",
      generatedAt: null,
      dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
    };
    const held = createTask({ project: "holdproj", title: "Cannot start", role: "executor", workspacePath: dir });
    const launcher = { async create() { throw new Error("boom"); }, async send() {} };
    await runTick({ profiles, pools, launcher, config: saved });
    await runTick({ profiles, pools, launcher, config: saved });
    assert.match(getTask(held.id).hold_reason ?? "", /boom/);
    assert.equal(sent.filter((item) => item.text.includes(zhCN("cardParts.event.startFailed")) && item.text.includes(`${cardMark(held.id)}`)).length, 1);

    sent.length = 0;
    const running = createTask({ project: "holdproj", title: "demo fixture", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run("runner", running.id);
    const start = Date.parse("2026-09-30T12:00:00.000Z");
    const gap = 10 * 60_000;
    applyNudge(running.id, false, { nowMs: start });
    applyNudge(running.id, false, { nowMs: start + gap });
    applyNudge(running.id, false, { nowMs: start + 2 * gap });
    assert.equal(getTask(running.id).status, "in_review");
    assert.equal(sent.filter((item) => item.id === "kanban-boss" && item.text.includes(`${cardMark(running.id)}`) && item.text.includes(zhCNPart("wake.board.nudgeStuck", 13, 17))).length, 0);

    sent.length = 0;
    resetBoardWakeForTests();
    noteTickFailure("first");
    assert.equal(sent.length, 0);
    noteTickFailure("second");
    noteTickFailure("third");
    assert.equal(sent.filter((item) => item.text.includes(zhCN("wake.board.tickError"))).length, 1);
    noteTickSuccess();
    noteTickFailure("again");
    noteTickFailure("again");
    assert.equal(sent.filter((item) => item.text.includes(zhCN("wake.board.tickError"))).length, 2);
  });

  it("treats a plugin-closing start error as transient and wakes only after three in a row", async () => {
    assert.equal(isPluginClosingError("Transport not connected (status: disposed)"), true);
    assert.equal(isPluginClosingError("transport closed"), true);
    assert.equal(isPluginClosingError("client status: reconnecting"), true);
    assert.equal(isPluginClosingError("boom"), false);
    assert.equal(isPluginClosingError("rate limit exceeded"), false);
    sent.length = 0;
    const saved = config("kanban-boss", { reload: "proj-boss" });
    setAgentAliveCheck(() => true);
    const profiles: Profile[] = [
      { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "g", pool: "cursor" },
      { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
    ];
    const pools: PoolSnapshot = {
      state: "fresh",
      message: "test",
      generatedAt: null,
      dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
    };
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE status IN ('ready', 'running', 'reviewing', 'in_review', 'rework')").run();
    const card = createTask({ project: "reload", title: "Reload instant", role: "executor", workspacePath: dir });
    const closing = { async create(): Promise<never> { throw new Error("Transport not connected (status: disposed)"); }, async send() {} };
    const kanbanWakes = () => sent.filter((item) => item.id === "kanban-boss" && item.text.includes(`${cardMark(card.id)}`)).length;
    const transient = () =>
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'start_transient' ORDER BY id").all(card.id) as unknown as Array<{ data_json: string }>).map(
        (row) => (JSON.parse(row.data_json) as { streak: number }).streak,
      );

    await runTick({ profiles, pools, launcher: closing, config: saved });
    assert.equal(getTask(card.id).status, "ready");
    assert.match(getTask(card.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("schedule.pluginReloading", 0, 16)) + "1\\/3" + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.equal(kanbanWakes(), 0);
    assert.deepEqual(transient(), [1]);
    await runTick({ profiles, pools, launcher: closing, config: saved });
    assert.equal(getTask(card.id).status, "ready");
    assert.equal(kanbanWakes(), 0);
    assert.deepEqual(transient(), [1, 2]);
    await runTick({ profiles, pools, launcher: closing, config: saved });
    assert.equal(kanbanWakes(), 1);
    assert.ok(sent.some((item) => item.id === "kanban-boss" && item.text.includes(zhCN("cardParts.event.startFailed")) && item.text.includes(zhCNPart("flow.nudge.blocked", 0, 6))));
    assert.deepEqual(transient(), [1, 2, 3]);
    assert.equal(getTask(card.id).status, "ready");

    // A different error in between breaks the run, so two closing errors after it do not wake.
    sent.length = 0;
    const other = createTask({ project: "reload", title: "Other intermediate error", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(card.id);
    let script = ["Transport not connected (status: disposed)", "boom", "Transport not connected (status: disposed)", "status: disposed"];
    const mixed = {
      async create(): Promise<never> {
        const next = script[0] ?? "boom";
        script = script.slice(1);
        throw new Error(next);
      },
      async send() {},
    };
    resetBoardWakeForTests();
    getDb().prepare("DELETE FROM events WHERE task_id = ? AND kind = 'board_wake'").run(other.id);
    await runTick({ profiles, pools, launcher: mixed, config: saved });
    const afterFirst = sent.length;
    await runTick({ profiles, pools, launcher: mixed, config: saved });
    assert.equal(sent.filter((item) => item.text.includes(`${cardMark(other.id)}`) && item.text.includes(zhCN("cardParts.event.startFailed"))).length, 1);
    await runTick({ profiles, pools, launcher: mixed, config: saved });
    await runTick({ profiles, pools, launcher: mixed, config: saved });
    assert.equal(afterFirst, 0);
    const kinds = (getDb().prepare("SELECT kind FROM events WHERE task_id = ? AND kind IN ('start_transient', 'start_failed') ORDER BY id").all(other.id) as unknown as Array<{ kind: string }>).map((row) => row.kind);
    assert.deepEqual(kinds, ["start_transient", "start_failed", "start_transient", "start_transient"]);
    assert.match(getTask(other.id).hold_reason ?? "", new RegExp(localePattern(zhCNPart("missingCwd.none", 0, 1)) + "2\\/3" + localePattern(zhCNPart("missingCwd.none", 3, 4))));
  });
});
