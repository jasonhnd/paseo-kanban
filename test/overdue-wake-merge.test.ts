/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { overdueAgentIds } from "../server/archive-book";
import { setWakeSender } from "../server/bus";
import { DEFAULT_ARCHIVE_DEADLINE_MS, DEFAULT_CONCURRENCY, saveConfig } from "../server/config";
import { installCleanup, noteOverdueArchives } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { appendEvent, createTask } from "../server/store";
import { OVERDUE_LIST_MAX, OVERDUE_MERGE_WINDOW_MS, resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "overdue-merge-"));
process.env.KANBAN_DATA_DIR = dir;

const sent: Array<{ id: string; text: string }> = [];
const MIN = 60_000;

function setup(supervisors: Record<string, string> = {}): void {
  saveConfig({
    autoStart: {},
    supervisorAgentId: "kanban-boss",
    supervisors,
    concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
    archiveDeadlineMs: DEFAULT_ARCHIVE_DEADLINE_MS,
  });
  setAgentAliveCheck(() => true);
  setWakeSender((id, text) => sent.push({ id, text }));
  resetBoardWakeForTests();
  sent.length = 0;
}

/** A done card whose agent was never archived; temp adds a leftover temporary workspace. */
function overdueCard(project: string, title: string, agentId: string, opts: { temp?: boolean; doneAgoMs?: number } = {}): number {
  const ago = new Date(Date.now() - (opts.doneAgoMs ?? 20 * MIN)).toISOString();
  const task = createTask({ project, title, role: "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, task.id);
  getDb()
    .prepare(
      ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n       VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
    )
    .run(task.id, agentId, ago);
  appendEvent(task.id, "accept", "acceptance", "done", "test", {}, ago);
  if (opts.temp) appendEvent(task.id, "temp_workspace", null, null, "test", { name: title }, ago);
  return task.id;
}

function wakeRows(taskId: number): Array<{ at: string; data: { kind: string; subject: string; text: string } }> {
  const rows = getDb().prepare("SELECT at, data_json FROM events WHERE task_id = ? AND kind = 'board_wake'").all(taskId) as unknown as Array<{ at: string; data_json: string }>;
  return rows.map((row) => ({ at: row.at, data: JSON.parse(row.data_json) }));
}

after(() => {
  installCleanup(null);
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  setWakeSender(() => {});
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("overdue archive wakes merge", () => {
  it("sends one wake for a card whose agent and temporary workspace are both overdue", () => {
    setup();
    const id = overdueCard("merge-one", "Both unavailable", "both-agent-1111", { temp: true });
    noteOverdueArchives();
    noteOverdueArchives();
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", new RegExp(zhCN("archiveBook.label.overdue", {"agent":"both-age"})));
    assert.match(sent[0]?.text ?? "", new RegExp(localePattern(zhCNPart("tempWorkspace.audit.latePrefix", 0, 16))));
    assert.equal(wakeRows(id).length, 1);
  });

  it("does not wake again for the other kind inside the merge window, but does after it", () => {
    setup();
    const id = overdueCard("merge-window", "Report one first", "window-agent-2222");
    noteOverdueArchives();
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", new RegExp(localePattern(zhCNPart("audit.overdue", 0, 5))));
    appendEvent(id, "temp_workspace", null, null, "test", { name: "late" }, new Date(Date.now() - 20 * MIN).toISOString());
    noteOverdueArchives(new Date(Date.now() + 10 * MIN));
    assert.equal(sent.length, 1);
    noteOverdueArchives(new Date(Date.now() + OVERDUE_MERGE_WINDOW_MS + MIN));
    assert.equal(sent.length, 2);
    assert.match(sent[1]?.text ?? "", new RegExp(localePattern(zhCNPart("tempWorkspace.audit.latePrefix", 0, 16))));
    assert.equal(sent[1]?.text.includes(zhCNPart("audit.overdue", 0, 5)), false);
    noteOverdueArchives(new Date(Date.now() + 2 * OVERDUE_MERGE_WINDOW_MS));
    assert.equal(sent.length, 2);
  });

  it("sends one wake per project, lists the first cards and counts the rest, and goes to that project's leader", () => {
    setup({ "merge-many": "many-leader" });
    const total = OVERDUE_LIST_MAX + 3;
    const ids = Array.from({ length: total }, (_, i) => overdueCard("merge-many", `Batch-${i}`, `many-agent-${i}`, { temp: i % 2 === 0 }));
    const other = overdueCard("merge-other", zhCNPart("paseo.worktree.wrongProject", 14, 19), "other-agent-9999");
    noteOverdueArchives();
    assert.equal(sent.length, 2);
    const many = sent.find((item) => item.text.includes("merge-many"));
    assert.equal(many?.id, "many-leader");
    assert.equal(many?.text.split("\n").filter((line) => line.includes("Batch-")).length, OVERDUE_LIST_MAX);
    assert.match(many?.text ?? "", new RegExp(zhCN("wake.overdue.more", {"count":"3"})));
    assert.equal(sent.find((item) => item.text.includes("merge-other"))?.id, "kanban-boss");
    assert.equal(wakeRows(ids[total - 1] ?? 0).length, 1);
    assert.equal(wakeRows(other).length, 1);
    noteOverdueArchives();
    assert.equal(sent.length, 2);
  });

  it("does not call an agent stuck while its turn is still running or just ended", () => {
    setup();
    const id = overdueCard("merge-turn", zhCN("reclaimNote.result.running"), "turn-agent-3333");
    const waitAt = new Date(Date.now() - 2 * MIN).toISOString();
    appendEvent(id, "cleanup", null, null, "kanban", { action: "wait_turn", agentId: "turn-agent-3333", ok: false, reason: "turn" }, waitAt);
    noteOverdueArchives();
    assert.deepEqual(overdueAgentIds(id), []);
    assert.equal(sent.length, 0);

    appendEvent(id, "cleanup", null, null, "kanban", { action: "turn_idle", agentId: "turn-agent-3333", ok: true });
    noteOverdueArchives(new Date(Date.now() + 5 * MIN));
    assert.equal(sent.length, 0);
  });

  it("calls the agent stuck once the grace after its turn ended has passed", () => {
    setup();
    const id = overdueCard("merge-grace", (zhCNPart("settings.thresholds.nudgeGraceMs", 2, 4) + "Demo text"), "grace-agent-4444");
    appendEvent(id, "cleanup", null, null, "kanban", { action: "turn_idle", agentId: "grace-agent-4444", ok: true });
    noteOverdueArchives(new Date(Date.now() + 5 * MIN));
    assert.equal(sent.length, 0);
    noteOverdueArchives(new Date(Date.now() + 11 * MIN));
    const mine = sent.filter((item) => item.text.includes("merge-grace"));
    assert.equal(mine.length, 1);
    assert.match(mine[0]?.text ?? "", new RegExp(zhCN("archiveBook.label.overdue", {"agent":"grace-ag"})));
  });

  it("holds a leftover temporary workspace back while the agent's turn is in its grace", () => {
    setup();
    const id = overdueCard("merge-temp-grace", (zhCNPart("blocked.kind.transient", 0, 2) + "Demo text turn"), "tg-agent-5555", { temp: true });
    appendEvent(id, "cleanup", null, null, "kanban", { action: "turn_idle", agentId: "tg-agent-5555", ok: true });
    noteOverdueArchives(new Date(Date.now() + 5 * MIN));
    assert.equal(sent.length, 0);
    noteOverdueArchives(new Date(Date.now() + 11 * MIN));
    const mine = sent.filter((item) => item.text.includes("merge-temp-grace"));
    assert.equal(mine.length, 1);
    assert.match(mine[0]?.text ?? "", new RegExp(localePattern(zhCNPart("tempWorkspace.audit.latePrefix", 0, 16))));
  });

  it("keeps a retryable failure after the turn ended inside the grace, then calls it stuck", () => {
    setup();
    const id = overdueCard("merge-retry", (zhCNPart("doctor.cleanup.suggestion", 59, 61) + zhCN("prefsControls.font.md")), "retry-agent-6666");
    appendEvent(id, "cleanup", null, null, "kanban", { action: "turn_idle", agentId: "retry-agent-6666", ok: true });
    appendEvent(id, "cleanup", null, null, "kanban", {
      action: "purge_agents", agentId: "retry-agent-6666", ok: false, retryAt: new Date(Date.now() + 5 * MIN).toISOString(),
    });
    noteOverdueArchives(new Date(Date.now() + 30_000));
    assert.equal(sent.filter((item) => item.text.includes("merge-retry")).length, 0);
    noteOverdueArchives(new Date(Date.now() + 11 * MIN));
    assert.equal(sent.filter((item) => item.text.includes("merge-retry")).length, 1);
  });

  it("does not wake for a temporary workspace while the last note is a stale wait_turn", () => {
    setup();
    const id = overdueCard("merge-stale-wait", (zhCNPart("doctor.matrix.stale", 4, 6) + zhCNPart("cardParts.event.prWait", 0, 2)), "stale-agent-7777", { temp: true });
    appendEvent(id, "cleanup", null, null, "kanban", {
      action: "wait_turn", agentId: "stale-agent-7777", ok: false, retryAt: new Date(Date.now() - 2 * MIN).toISOString(),
    }, new Date(Date.now() - 5 * MIN).toISOString());
    noteOverdueArchives();
    assert.equal(sent.filter((item) => item.text.includes("merge-stale-wait")).length, 0);
  });

  it("lists the lowest card numbers first when deadline and temp-only cards mix past the limit", () => {
    setup();
    const ids: number[] = [];
    for (let i = 0; i < OVERDUE_LIST_MAX + 2; i += 1) {
      const temp = i % 2 === 0;
      const id = overdueCard("merge-order", `Ordering-${i}`, `order-agent-${i}`, { temp });
      if (temp) {
        // Temp-only card: its agent is already put away, so only the workspace is left.
        appendEvent(id, "cleanup", null, null, "kanban", { action: "purge_agents", agentId: `order-agent-${i}`, ok: true });
      }
      ids.push(id);
    }
    noteOverdueArchives();
    const text = sent.find((item) => item.text.includes("merge-order"))?.text ?? "";
    const listed = text.split("\n").filter((line) => line.includes("Ordering-"));
    assert.equal(listed.length, OVERDUE_LIST_MAX);
    assert.equal(listed.some((line) => line.includes("Ordering-10") || line.includes("Ordering-11")), false);
    assert.match(text, new RegExp(zhCN("wake.overdue.more", {"count":"2"})));
  });
});
