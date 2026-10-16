/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { runKanban } from "../server/cli";
import { loadConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { runDoctor } from "../server/doctor";
import { resetReconcileForTests, type TickOptions } from "../server/schedule";
import { blockTask, claimStatus, createTask, getDetail, getTask, listBoard, unblockTask } from "../server/store";
import { formatResult, handleTool, toolDefs } from "../server/tools";
import { issueToken } from "../server/tokens";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { setLanguage } from "../shared/i18n";
import { attentionOf, cardHint } from "../shared/board-view";
import { cardFaceTone } from "../shared/labels";
import { runTick } from "./helpers/compat-schedule";

let dir: string;
let due: Date;
const sent: string[] = [];

function agent(id: string, archivedAt: string | null = null): void {
  mkdirSync(join(dir, "agents", "bucket"), { recursive: true });
  writeFileSync(join(dir, "agents", "bucket", `${id}.json`), JSON.stringify({ id, cwd: dir, archivedAt, lastStatus: "idle" }));
}

function running(id = "scheduled-agent"): number {
  const task = createTask({ project: "demo", title: "Timed step", role: "executor", workspacePath: dir });
  claimStatus(task.id, "ready", "running", "test");
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(id, task.id);
  return task.id;
}

function wait(id: number, until = due.toISOString()): void {
  blockTask(id, "scheduled", "Window opens later", "executor", { until });
}

function tick(now: Date, send?: TickOptions["send"]): Promise<unknown> {
  return runTick({
    profiles: [], launcher: { async create() { throw new Error("unexpected dispatch"); }, async send() {} },
    now, send, config: loadConfig(), agentState: () => "alive", matrix: { state: "missing" },
    pools: { state: "fresh", message: "", generatedAt: now.toISOString(), ageMs: 0, dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }) },
  });
}

async function blockedFinding(id: number, now: Date) {
  const report = await runDoctor({ now, wake: false, persist: false, sources: {} });
  return report.findings.find(item => item.id === `card:blocked:${id}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scheduled-wait-"));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({
    autoStart: { demo: false }, supervisorAgentId: "board-leader", supervisors: { demo: "project-leader" },
  }));
  due = new Date(Date.now() + 3_600_000);
  sent.length = 0;
  resetReconcileForTests();
  setAgentAliveCheck(() => true);
  setWakeSender(id => { sent.push(id); });
  agent("scheduled-agent");
});

afterEach(() => {
  resetAgentAliveCheck();
  resetWakeSender();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  setLanguage("zh-CN");
});

describe("scheduled waits", { concurrency: 1 }, () => {
  it("accepts an offset timestamp through CLI and persists its UTC instant", async () => {
    const id = running();
    const offset = new Date(due.getTime() + 9 * 3_600_000).toISOString().replace("Z", "+09:00");
    await runKanban(["block", String(id), "--kind", "scheduled", "--until", offset, "--reason", "Timed step"], { PASEO_AGENT_ID: "scheduled-agent" });
    closeDb();
    assert.equal(getTask(id).status, "blocked");
    assert.equal((getTask(id) as unknown as { scheduled_until: string }).scheduled_until, due.toISOString());
  });

  it("rejects missing, invalid, offset-free, past and more-than-seven-day timestamps without changing the card", async () => {
    const id = running();
    const token = issueToken("executor", id, "scheduled-agent");
    const values = [undefined, "nonsense", due.toISOString().slice(0, -1), "2030-02-30T12:00:00Z", new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 8 * 86_400_000).toISOString(), 42];
    for (const until of values) {
      await assert.rejects(() => handleTool("kanban_block", { id, kind: "scheduled", until, reason: "Timed step" }, token), error => {
        assert.match(String(error), /ISO|wait-user/);
        return true;
      });
      assert.equal(getTask(id).status, "running");
    }
    await handleTool("kanban_block", { id, kind: "scheduled", until: new Date(Date.now() + 7 * 86_400_000).toISOString(), reason: "Timed step" }, token);
    assert.equal(getTask(id).blocked_kind, "scheduled");
  });

  it("rejects until on other block kinds", async () => {
    const id = running();
    await assert.rejects(() => runKanban(["block", String(id), "--kind", "transient", "--until", due.toISOString(), "--reason", "Timed step"], { PASEO_AGENT_ID: "scheduled-agent" }));
    assert.equal(getTask(id).status, "running");
  });

  it("does not retry, page the leader or raise a blocked doctor finding before the time", async () => {
    const id = running();
    wait(id);
    getDb().prepare("UPDATE tasks SET blocked_at = ? WHERE id = ?").run(new Date(due.getTime() - 6 * 3_600_000).toISOString(), id);
    await tick(new Date(due.getTime() - 1));
    assert.equal(getTask(id).status, "blocked");
    assert.deepEqual(sent, []);
    assert.equal(await blockedFinding(id, new Date(due.getTime() - 1)), undefined);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind IN ('transient_retry', 'transient_exhausted')").get(id)?.n, 0);
  });

  it("survives restart and wakes the original agent once at the deadline", async () => {
    const id = running();
    wait(id);
    closeDb();
    await tick(due);
    assert.equal(getTask(id).status, "running");
    assert.deepEqual(sent, ["scheduled-agent"]);
    closeDb();
    await tick(new Date(due.getTime() + 1));
    assert.deepEqual(sent, ["scheduled-agent"]);
    assert.equal((getTask(id) as unknown as { scheduled_until: string | null }).scheduled_until, null);
  });

  it("serializes concurrent ticks so only one sends the due prompt", async () => {
    const id = running();
    wait(id);
    await Promise.all([tick(due, async agentId => { sent.push(agentId); await new Promise(resolve => setTimeout(resolve, 10)); }), tick(due, async agentId => { sent.push(agentId); })]);
    assert.deepEqual(sent, ["scheduled-agent"]);
    assert.equal(getTask(id).status, "running");
  });

  it("keeps failed delivery pending across restart, then retries successfully once", async () => {
    const id = running();
    wait(id);
    await tick(due, async () => { throw new Error("delivery unavailable"); });
    assert.equal(getTask(id).status, "blocked");
    closeDb();
    await tick(new Date(due.getTime() + 1));
    await tick(new Date(due.getTime() + 2));
    assert.deepEqual(sent, ["scheduled-agent"]);
    assert.equal(getTask(id).status, "running");
  });

  it("reuses the persisted message ID when acceptance succeeded but its response was lost", async () => {
    const id = running();
    wait(id);
    const accepted = new Set<string>();
    const attempts: string[] = [];
    let first = true;
    setWakeSender((agentId, _text, options) => {
      assert.ok(options?.messageId);
      attempts.push(options.messageId);
      if (!accepted.has(options.messageId)) { accepted.add(options.messageId); sent.push(agentId); }
      if (first) { first = false; throw new Error("acknowledgement lost"); }
    });
    await tick(due);
    assert.equal(getTask(id).status, "blocked");
    closeDb();
    await tick(due);
    await tick(due);
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts).size, 1);
    assert.deepEqual(sent, ["scheduled-agent"]);
    assert.equal(getTask(id).status, "running");
  });

  it("recovers an expired persisted send lease after a restart", async () => {
    const id = running();
    wait(id);
    getDb().prepare("UPDATE tasks SET scheduled_claim_id = 'interrupted', scheduled_claim_until = ? WHERE id = ?")
      .run(new Date(Date.now() + 60_000).toISOString(), id);
    closeDb();
    await tick(due);
    assert.equal(getTask(id).status, "blocked");
    assert.deepEqual(sent, []);
    getDb().prepare("UPDATE tasks SET scheduled_claim_until = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), id);
    closeDb();
    await tick(due);
    assert.deepEqual(sent, ["scheduled-agent"]);
    assert.equal(getTask(id).status, "running");
  });

  it("upgrades an existing task database without changing the card", () => {
    const id = running();
    for (const column of ["scheduled_until", "scheduled_wake_id", "scheduled_claim_id", "scheduled_claim_until"]) {
      getDb().exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
    }
    closeDb();
    assert.equal(getTask(id).status, "running");
    wait(id);
    assert.equal(getTask(id).scheduled_until, due.toISOString());
  });

  it("does not consume the wait before the wake transport is ready", async () => {
    const id = running();
    wait(id);
    resetWakeSender();
    await tick(due);
    assert.equal(getTask(id).status, "blocked");
    setWakeSender(agentId => { sent.push(agentId); });
    await tick(due);
    assert.deepEqual(sent, ["scheduled-agent"]);
  });

  it("returns missing or archived agents to ready for the existing redispatch loop", async () => {
    for (const agentId of ["departed-agent", "archived-agent"]) {
      if (agentId === "archived-agent") agent(agentId, new Date().toISOString());
      const id = running(agentId);
      wait(id);
      await tick(due);
      assert.equal(getTask(id).status, "ready");
      assert.equal(getTask(id).agent_id, null);
    }
    assert.deepEqual(sent, []);
  });

  it("does not release a replacement wait written while sending", async () => {
    const id = running();
    wait(id);
    const replacement = new Date(due.getTime() + 3_600_000).toISOString();
    await tick(due, async () => {
      unblockTask(id, "supervisor");
      wait(id, replacement);
    });
    assert.equal(getTask(id).status, "blocked");
    assert.equal((getTask(id) as unknown as { scheduled_until: string }).scheduled_until, replacement);
  });

  it("starts the normal doctor overdue threshold at the deadline", async () => {
    const id = running();
    wait(id);
    assert.equal(await blockedFinding(id, new Date(due.getTime() + 2 * 3_600_000 - 1)), undefined);
    assert.equal((await blockedFinding(id, new Date(due.getTime() + 2 * 3_600_000)))?.severity, "red");
  });

  it("shows the localized local-time wait on board, list and detail", async () => {
    const id = running();
    wait(id);
    for (const [language, pattern] of [["en", /Scheduled wait until /], ["zh-CN", /\u5b9a\u65f6\u7b49\u5f85\u5230 /]] as const) {
      setLanguage(language);
      const card = listBoard("demo").tasks.find(item => item.id === id)!;
      assert.match(card.badge, pattern);
      assert.match(getDetail(id).task.badge, pattern);
      assert.match(formatResult(listBoard("demo")), pattern);
      assert.match(formatResult(getTask(id)), pattern);
      const token = issueToken("executor", id, "scheduled-agent");
      assert.match(formatResult(await handleTool("kanban_list", {}, token)), pattern);
      assert.match(cardHint(card)!.text, pattern);
      assert.equal(attentionOf(card, []), null);
      assert.equal(cardFaceTone(card), "warning");
      assert.ok(card.badge.includes(String(due.getFullYear())));
      assert.equal(card.scheduledUntil, due.toISOString());
      const schema = toolDefs(language).find(tool => tool.name === "kanban_block")!.inputSchema;
      assert.ok((schema.properties as Record<string, unknown>).until);
    }
  });

  it("allows only the assigned worker to schedule and the scoped leader to unblock", async () => {
    const id = running();
    const other = running("other-agent");
    const token = issueToken("executor", id, "scheduled-agent");
    const foreign = issueToken("executor", other, "other-agent");
    const args = { id, kind: "scheduled", until: due.toISOString(), reason: "Timed step" };
    await assert.rejects(() => handleTool("kanban_block", args, foreign), { code: "forbidden" });
    await handleTool("kanban_block", args, token);
    await assert.rejects(() => handleTool("kanban_unblock", { id }, token), { code: "forbidden" });
    await runKanban(["unblock", String(id)], { PASEO_AGENT_ID: "project-leader" });
    assert.equal(getTask(id).status, "running");
    await tick(due);
    assert.deepEqual(sent, []);
  });
});
