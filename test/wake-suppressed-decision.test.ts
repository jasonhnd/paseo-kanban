/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { cardMark } from "../server/card-ref";
import { approveTask } from "../server/flow";
import { createTask, getTask } from "../server/store";
import {
  notifyAcceptance,
  resetAgentAliveCheck,
  resetBoardWakeForTests,
  retryUnattended,
  setAgentAliveCheck,
} from "../server/wake";

const dir = mkdtempSync(join(tmpdir(), "wake-suppressed-decision-"));
process.env.KANBAN_DATA_DIR = dir;
// approveTask reads the default decisions file inside the card flow, so point the cockpit state directory at the temp dir.

const decisionsFile = join(dir, "fleet", "decisions.json");
mkdirSync(join(dir, "fleet"), { recursive: true });
const MIN = 60_000;

const sent: Array<{ id: string; text: string }> = [];

function writeDecisions(rows: unknown): void {
  writeFileSync(decisionsFile, JSON.stringify(rows));
}

function openDecision(id: string, title: string): Record<string, unknown> {
  return { id, project: "demo_tasks", title, detail: "A / B / C", blocking: false, status: "open", createdAt: "2026-10-05T04:00:00Z", agentId: null };
}

function eventsOf(taskId: number, kind: string): Array<{ id: number; data: Record<string, unknown> }> {
  const rows = getDb().prepare("SELECT id, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{ id: number; data_json: string }>;
  return rows.map((row) => ({ id: row.id, data: JSON.parse(row.data_json) as Record<string, unknown> }));
}

/** Card 607 (XYZ_0087): reviewed and done, enters acceptance while an open decision names it. */
function acceptanceCard(): number {
  const task = createTask({ project: "demo_tasks", title: "Check screenshot", role: "executor", workspacePath: dir, createdByAgent: "creator" });
  getDb().prepare("UPDATE tasks SET status = 'reviewing', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "Finished" }), task.id);
  return task.id;
}

function ageSuppression(taskId: number, minutes: number): void {
  getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'wake_suppressed_decision'")
    .run(new Date(Date.now() - minutes * MIN).toISOString(), taskId);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

after(() => {
  resetWakeSender();
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("F4: an open decision that names the card no longer swallows the acceptance wake", () => {
  beforeEach(() => {
    sent.length = 0;
    resetBoardWakeForTests();
    getDb().exec("DELETE FROM events; DELETE FROM tasks;");
    saveConfig({
      autoStart: { wake: false, chain: false },
      supervisorAgentId: "kanban-boss",
      supervisors: { demo_tasks: "demo_tasks-leader" },
      concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
    });
    setAgentAliveCheck(() => true);
    setWakeSender((id, text) => { sent.push({ id, text }); });
    writeDecisions([]);
  });

  it("records wake_suppressed_decision with the decision id and sends nothing at first", async () => {
    const id = acceptanceCard();
    writeDecisions([openDecision("d1002-162257-1", `${cardMark(id)} Checking screenshot`)]);
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    notifyAcceptance(id, false, decisionsFile);
    notifyAcceptance(id, false, decisionsFile);
    await flush();
    assert.equal(getTask(id).status, "acceptance");
    assert.equal(sent.length, 0);
    assert.equal(eventsOf(id, "wake_acceptance").length, 0);
    const suppressed = eventsOf(id, "wake_suppressed_decision");
    assert.equal(suppressed.length, 1, "once per round");
    assert.deepEqual(suppressed[0]!.data.decisionIds, ["d1002-162257-1"]);
    assert.equal(suppressed[0]!.data.uncertain, false);
  });

  it("wakes the leader once after 30 minutes and says which decision mentions the card", async () => {
    const id = acceptanceCard();
    writeDecisions([openDecision("d1002-162257-1", `${cardMark(id)} Checking screenshot`)]);
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    notifyAcceptance(id, false, decisionsFile);
    ageSuppression(id, 29);
    retryUnattended(decisionsFile);
    await flush();
    assert.equal(sent.length, 0);
    ageSuppression(id, 31);
    retryUnattended(decisionsFile);
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.id, "demo_tasks-leader");
    assert.match(sent[0]!.text, new RegExp(localePattern(zhCNPart("waitUser.notFound", 0, 4)) + "d1002-162257-1 " + localePattern(zhCNPart("wake.decision.held", 10, 15))));
    assert.equal(eventsOf(id, "wake_acceptance").length, 1);
    retryUnattended(decisionsFile);
    await flush();
    assert.equal(sent.length, 1, "the override wake is sent once");
  });

  it("wakes after only 5 minutes when the decisions file cannot be trusted", async () => {
    const id = acceptanceCard();
    writeFileSync(decisionsFile, "{half written");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    notifyAcceptance(id, false, decisionsFile);
    const suppressed = eventsOf(id, "wake_suppressed_decision");
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0]!.data.uncertain, true);
    ageSuppression(id, 4);
    retryUnattended(decisionsFile);
    await flush();
    assert.equal(sent.length, 0);
    ageSuppression(id, 6);
    retryUnattended(decisionsFile);
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(eventsOf(id, "wake_acceptance").length, 1);
  });

  it("sends the missing wake as soon as the decision is closed", async () => {
    const id = acceptanceCard();
    writeDecisions([openDecision("d1", `${cardMark(id)} ${zhCNPart("tools.action.waitUser", 1, 4)}`)]);
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    notifyAcceptance(id, false, decisionsFile);
    retryUnattended(decisionsFile);
    await flush();
    assert.equal(sent.length, 0);
    writeDecisions([{ ...openDecision("d1", `${cardMark(id)} ${zhCNPart("tools.action.waitUser", 1, 4)}`), status: "done" }]);
    retryUnattended(decisionsFile);
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.id, "demo_tasks-leader");
    assert.doesNotMatch(sent[0]!.text, new RegExp(localePattern(zhCNPart("wake.decision.held", 10, 15))));
  });

  it("never leaves an acceptance card without a wake or a suppressed record (card 607 regression query)", () => {
    const id = acceptanceCard();
    writeDecisions([openDecision("d1", `${cardMark(id)} ${zhCNPart("tools.action.waitUser", 1, 4)}`)]);
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    notifyAcceptance(id, false, decisionsFile);
    const missing = getDb().prepare(
      `select count(*) as n from tasks t where status='acceptance' and not exists (
         select 1 from events w where w.task_id=t.id and w.kind in ('wake_acceptance','wake_suppressed_decision')
           and w.id > (select max(id) from events x where x.task_id=t.id and x.to_status='acceptance' and x.from_status is not null and x.from_status != x.to_status))`,
    ).get() as { n: number };
    assert.equal(missing.n, 0);
  });
});
