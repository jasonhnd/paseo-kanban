/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, loadConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { Profile } from "../server/profiles";
import { resetReconcileForTests, type TickOptions } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { addComment, blockTask, claimStatus, createTask, getTask, unblockTask } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";

const PROMPT = zhCN("transientRetry.reviewPrompt");
const MIN = 60_000;

let dir: string;
let agents: string;

const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];

const sent: Array<{ id: string; text: string }> = [];

function writeAgent(id: string): void {
  const folder = join(agents, "bucket");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ id, cwd: dir, archivedAt: null, lastStatus: "idle" }));
}

function saveRaw(extra: Record<string, unknown> = {}, auto = false): void {
  const body = {
    autoStart: { wait: auto },
    supervisorAgentId: "kanban-boss",
    supervisors: { wait: "leader-agent" },
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
    ...extra,
  };
  writeFileSync(join(dir, "kanban.config.json"), `${JSON.stringify(body, null, 2)}\n`);
}

function tick(now: Date, send?: TickOptions["send"], config?: KanbanConfig): Promise<unknown> {
  const launcher: TickOptions["launcher"] = {
    async create() {
      return { id: "new-agent" };
    },
    async send() {},
  };
  return runTick({
    profiles,
    launcher,
    now,
    send,
    config: config ?? loadConfig(),
    agentState: () => "alive",
    matrix: { state: "missing" },
    pools: {
      state: "fresh",
      message: "",
      generatedAt: now.toISOString(),
      ageMs: 0,
      dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
    },
  });
}

function retryRows(id: number): Array<{ sent?: boolean; attempt?: number }> {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'transient_retry' ORDER BY id").all(id) as Array<{
    data_json: string;
  }>;
  return rows.map((row) => JSON.parse(row.data_json) as { sent?: boolean; attempt?: number });
}

function blockRunning(title: string, agentId: string, kind: string, reason: string): number {
  writeAgent(agentId);
  const task = createTask({ project: "wait", title, role: "executor", workspacePath: dir });
  claimStatus(task.id, "ready", "running", "test");
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(agentId, task.id);
  blockTask(task.id, kind, reason, "executor");
  return task.id;
}

function stamp(id: number, at: Date): void {
  getDb().prepare("UPDATE tasks SET blocked_at = ? WHERE id = ?").run(at.toISOString(), id);
}

beforeEach(() => {
  // Leftover blocked cards must not be woken by a later test's simulated tick.
  dir = mkdtempSync(join(tmpdir(), "transient-"));
  process.env.KANBAN_DATA_DIR = dir;
  agents = join(dir, "agents");
  process.env.KANBAN_AGENTS_DIR = agents;
  mkdirSync(agents, { recursive: true });
  resetReconcileForTests();
  sent.length = 0;
  setWakeSender((id, text) => {
    sent.push({ id, text });
  });
  setAgentAliveCheck(() => true);
  saveRaw();
});

afterEach(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("transient retry", { concurrency: 1 }, () => {
  it("leaves a transient block alone until the wait has elapsed, then unblocks and prompts the same agent", async () => {
    const at = new Date("2026-10-01T00:00:00.000Z");
    const id = blockRunning((zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI"), "agent-ci", "transient", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI Finished running"));
    stamp(id, at);
    await tick(new Date(at.getTime() + 15 * MIN - 1));
    assert.equal(getTask(id).status, "blocked");
    assert.equal(getTask(id).blocked_kind, "transient");
    assert.equal(sent.length, 0);

    await tick(new Date(at.getTime() + 15 * MIN));
    const after = getTask(id);
    assert.equal(after.status, "running");
    assert.equal(after.agent_id, "agent-ci");
    assert.equal(after.blocked_kind, null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.id, "agent-ci");
    assert.equal(sent[0]?.text, PROMPT);
  });

  it("uses transientRetryMinutes and doubles the wait, capped at two hours", async () => {
    saveRaw({ transientRetryMinutes: 5, transientRetryLimit: 8 });
    const at = new Date("2026-10-01T02:00:00.000Z");
    const id = blockRunning("Custom interval", "agent-custom", "transient", "Wait for deployment");
    stamp(id, at);
    await tick(new Date(at.getTime() + 5 * MIN - 1));
    assert.equal(getTask(id).status, "blocked");
    await tick(new Date(at.getTime() + 5 * MIN));
    assert.equal(getTask(id).status, "running");
    assert.equal(sent.at(-1)?.text, PROMPT);

    blockTask(id, "transient", "Deployment pending", "executor");
    const second = new Date("2026-10-01T03:00:00.000Z");
    stamp(id, second);
    await tick(new Date(second.getTime() + 5 * MIN));
    assert.equal(getTask(id).status, "blocked");
    await tick(new Date(second.getTime() + 10 * MIN));
    assert.equal(getTask(id).status, "running");

    const delays = [20, 40, 80];
    let cursor = new Date("2026-10-01T04:00:00.000Z");
    for (const minutes of delays) {
      blockTask(id, "transient", zhCNPart("transientRetry.reviewPrompt", 52, 55), "executor");
      stamp(id, cursor);
      await tick(new Date(cursor.getTime() + minutes * MIN - 1));
      assert.equal(getTask(id).status, "blocked", `not yet due at ${minutes - 1} minutes`);
      await tick(new Date(cursor.getTime() + Math.min(minutes, 120) * MIN));
      assert.equal(getTask(id).status, "running", `due at ${Math.min(minutes, 120)} minutes`);
      cursor = new Date(cursor.getTime() + 3 * 60 * MIN);
    }
    blockTask(id, "transient", (zhCNPart("wake.board.poolStale", 4, 6) + "Demo text"), "executor");
    stamp(id, cursor);
    await tick(new Date(cursor.getTime() + 120 * MIN - 1));
    assert.equal(getTask(id).status, "blocked");
    await tick(new Date(cursor.getTime() + 120 * MIN));
    assert.equal(getTask(id).status, "running");
  });

  it("wakes the project leader once the retry limit is spent, and leaves other block kinds alone", async () => {
    saveRaw({ transientRetryLimit: 2 });
    const at = new Date("2026-10-01T05:00:00.000Z");
    const id = blockRunning((zhCNPart("archiveBook.label.restored", 3, 5) + zhCNPart("cardParts.event.prWait", 0, 2)), "agent-limit", "transient", (zhCN("boardView.external.headline") + zhCNPart("language.name.system", 2, 4)));
    stamp(id, at);
    await tick(new Date(at.getTime() + 15 * MIN));
    assert.equal(getTask(id).status, "running");
    blockTask(id, "transient", (zhCNPart("cardDrawer.handoff.none", 0, 2) + zhCNPart("panelPrefs.brokenNoBackup", 1, 2)), "executor");
    const second = new Date("2026-10-01T06:00:00.000Z");
    stamp(id, second);
    await tick(new Date(second.getTime() + 30 * MIN));
    assert.equal(getTask(id).status, "running");

    blockTask(id, "transient", "Third attempt still waiting", "executor");
    const third = new Date("2026-10-01T07:00:00.000Z");
    stamp(id, third);
    const before = sent.length;
    await tick(new Date(third.getTime() + 60 * MIN));
    const stuck = getTask(id);
    assert.equal(stuck.status, "blocked");
    assert.equal(stuck.blocked_kind, "transient");
    assert.equal(stuck.agent_id, "agent-limit");
    const wakes = sent.slice(before);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.id, "leader-agent");
    assert.match(wakes[0]?.text ?? "", new RegExp("Third attempt still waiting"));
    assert.equal(wakes.some((item) => item.text === PROMPT), false);

    await tick(new Date(third.getTime() + 60 * MIN + 1));
    assert.equal(sent.length, before + 1);
    assert.equal(getTask(id).status, "blocked");

    const human = blockRunning(zhCNPart("blocked.kind.needsHuman", 1, 3), "agent-human", "needs_human", "Missing decision");
    const rate = blockRunning(zhCN("blocked.kind.rateLimit"), "agent-rate", "rate_limit", zhCNPart("loginBlip.reopenLater", 6, 8));
    // Routine prerequisite-card waits now complete with waitingOn (TEST_0107).
    // Keep this retry-kind test on a real dependency failure.
    const dep = blockRunning("Missing dependency", "agent-dep", "dependency", (zhCNPart("db.migration.noDatabase", 0, 2) + "Demo text"));
    const cap = blockRunning(zhCNPart("configAlarm.running.none", 16, 18), "agent-cap", "capability", "Cannot run");
    const later = new Date(third.getTime() + 24 * 60 * MIN);
    for (const card of [human, rate, dep, cap]) stamp(card, at);
    await tick(later);
    assert.equal(getTask(human).status, "blocked");
    assert.equal(getTask(human).blocked_kind, "needs_human");
    assert.equal(getTask(rate).blocked_kind, "rate_limit");
    assert.equal(getTask(dep).blocked_kind, "dependency");
    assert.equal(getTask(cap).blocked_kind, "capability");
    const noise = sent.filter((item) => ["agent-human", "agent-rate", "agent-dep", "agent-cap"].includes(item.id));
    assert.equal(noise.length, 0);
  });

  it("returns a transient card to ready when the agent is gone, and a comment does not reset the backoff", async () => {
    const at = new Date("2026-10-01T08:00:00.000Z");
    const gone = createTask({ project: "wait", title: "Agent gone", role: "executor", workspacePath: dir });
    claimStatus(gone.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-missing", gone.id);
    blockTask(gone.id, "transient", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI"), "executor");
    stamp(gone.id, at);
    await tick(new Date(at.getTime() + 15 * MIN));
    const ready = getTask(gone.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.agent_id, null);
    assert.equal(sent.some((item) => item.id === "agent-missing"), false);

    const id = blockRunning((zhCNPart("tools.emptyComment", 0, 3) + zhCNPart("dispatch.reassignChanged", 17, 18)), "agent-note", "transient", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI"));
    stamp(id, at);
    await tick(new Date(at.getTime() + 15 * MIN));
    assert.equal(getTask(id).status, "running");
    blockTask(id, "transient", (zhCNPart("reclaimNote.result.running", 0, 2) + zhCNPart("tempWorkspace.placeholder.more", 1, 2)), "executor");
    addComment(id, "executor", ("CI " + zhCN("reclaimNote.result.running")));
    const second = new Date("2026-10-01T09:00:00.000Z");
    stamp(id, second);
    await tick(new Date(second.getTime() + 15 * MIN));
    assert.equal(getTask(id).status, "blocked");
    await tick(new Date(second.getTime() + 30 * MIN));
    assert.equal(getTask(id).status, "running");

    blockTask(id, "transient", "Unblock manually first", "executor");
    unblockTask(id, "supervisor");
    blockTask(id, "transient", (zhCNPart("nativeSessions.lock.busy", 7, 9) + "Demo text"), "executor");
    const fresh = new Date("2026-10-01T10:00:00.000Z");
    stamp(id, fresh);
    await tick(new Date(fresh.getTime() + 15 * MIN));
    assert.equal(getTask(id).status, "running");
    assert.equal(sent.at(-1)?.text, PROMPT);
  });

  it("stays blocked when the review prompt fails, and delivers it on a later tick", async () => {
    const at = new Date("2026-10-01T11:00:00.000Z");
    const id = blockRunning((zhCNPart("stall.call.send", 0, 2) + zhCN("compat.run.failed")), "agent-send", "transient", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI"));
    stamp(id, at);
    let calls = 0;
    const send: TickOptions["send"] = async (agentId, text) => {
      calls += 1;
      if (calls === 1) throw new Error("temporary send failure");
      sent.push({ id: agentId, text });
    };
    await tick(new Date(at.getTime() + 15 * MIN), send);
    assert.equal(calls, 1);
    assert.equal(getTask(id).status, "blocked");
    assert.equal(getTask(id).blocked_kind, "transient");
    assert.equal(retryRows(id).some((row) => row.sent === true), false);

    await tick(new Date(at.getTime() + 4 * 60 * MIN), send);
    assert.equal(calls, 2);
    const after = getTask(id);
    assert.equal(after.status, "running");
    assert.equal(after.agent_id, "agent-send");
    assert.equal(sent.at(-1)?.id, "agent-send");
    assert.equal(sent.at(-1)?.text, PROMPT);
    const rows = retryRows(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sent, true);
    assert.equal(rows[0]?.attempt, 1);
  });

  it("leaves a needs_human block that replaced the transient wait while the prompt was in flight", async () => {
    const at = new Date("2026-10-01T15:00:00.000Z");
    const id = blockRunning((zhCNPart("stall.call.send", 0, 2) + "Demo text"), "agent-human-race", "transient", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI"));
    stamp(id, at);
    const send: TickOptions["send"] = async () => {
      unblockTask(id, "supervisor");
      blockTask(id, "needs_human", "new human decision", "executor");
    };
    await tick(new Date(at.getTime() + 15 * MIN), send);
    const after = getTask(id);
    assert.equal(after.status, "blocked");
    assert.equal(after.blocked_kind, "needs_human");
    assert.equal(after.blocked_reason, "new human decision");
    assert.equal(after.agent_id, "agent-human-race");
    assert.equal(retryRows(id).some((row) => row.sent === true), false);
  });

  it("leaves a new transient block that started while the previous prompt was in flight", async () => {
    const at = new Date("2026-10-01T16:00:00.000Z");
    const id = blockRunning((zhCNPart("stall.call.send", 0, 2) + "Demo text"), "agent-transient-race", "transient", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI"));
    stamp(id, at);
    const send: TickOptions["send"] = async () => {
      unblockTask(id, "supervisor");
      blockTask(id, "transient", (zhCNPart("nativeSessions.lock.busy", 7, 9) + "Demo text"), "executor");
    };
    await tick(new Date(at.getTime() + 15 * MIN), send);
    const after = getTask(id);
    assert.equal(after.status, "blocked");
    assert.equal(after.blocked_kind, "transient");
    assert.equal(after.blocked_reason, (zhCNPart("nativeSessions.lock.busy", 7, 9) + "Demo text"));
    assert.equal(after.agent_id, "agent-transient-race");
    assert.equal(retryRows(id).length, 0);
  });

  it("keeps the backoff and the retry limit after the missing agent is replaced", async () => {
    const workspace = join(dir, "replace-ws");
    mkdirSync(workspace, { recursive: true });
    saveRaw(
      {
        transientRetryLimit: 2,
        autoStart: { replace: true },
        supervisors: { replace: "leader-agent" },
        concurrency: { global: 100, pools: { cursor: 100 }, roles: { executor: 100 } },
        projects: {
          replace: { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: false },
        },
      },
      false,
    );
    writeAgent("new-agent");
    const at = new Date("2026-10-01T12:00:00.000Z");
    const task = createTask({ project: "replace", title: "Redispatch after departure", role: "executor", workspacePath: workspace });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-left", task.id);
    blockTask(task.id, "transient", (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "CI"), "executor");
    stamp(task.id, at);

    await tick(new Date(at.getTime() + 15 * MIN));
    const replaced = getTask(task.id);
    assert.equal(replaced.status, "running");
    assert.equal(replaced.agent_id, "new-agent");
    const started = getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'started'").get(task.id);
    assert.ok(started);

    blockTask(task.id, "transient", (zhCNPart("compactEvents.apply.pruned", 20, 22) + "agent " + zhCNPart("transientRetry.leader.rechecked", 20, 23)), "executor");
    const second = new Date("2026-10-01T13:00:00.000Z");
    stamp(task.id, second);
    await tick(new Date(second.getTime() + 15 * MIN));
    assert.equal(getTask(task.id).status, "blocked");
    await tick(new Date(second.getTime() + 30 * MIN));
    assert.equal(getTask(task.id).status, "running");
    assert.equal(sent.filter((item) => item.id === "new-agent" && item.text === PROMPT).length, 1);

    blockTask(task.id, "transient", "Third attempt still wakes", "executor");
    const third = new Date("2026-10-01T14:00:00.000Z");
    stamp(task.id, third);
    const before = sent.length;
    await tick(new Date(third.getTime() + 60 * MIN));
    assert.equal(getTask(task.id).status, "blocked");
    assert.equal(getTask(task.id).blocked_kind, "transient");
    const wakes = sent.slice(before);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.id, "leader-agent");
    assert.match(wakes[0]?.text ?? "", new RegExp("Third attempt still wakes"));
  });
});
