/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, loadConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { approveTask, requestChanges } from "../server/flow";
import { runTick } from "./helpers/compat-schedule";
import { appendEvent, createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { eventHeadline } from "../shared/labels";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "standalone-review-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });

function setSupervisor(project: string, agentId: string): void {
  const stored = loadConfig();
  stored.supervisors[project] = agentId;
  saveConfig(stored);
}

const sent: Array<{ id: string; text: string }> = [];

function config(): KanbanConfig {
  return {
    autoStart: { solo: true },
    supervisorAgentId: "kanban-boss",
    supervisors: { solo: "proj-boss" },
    concurrency: {
      global: 50,
      pools: { ...DEFAULT_CONCURRENCY.pools, alternate: 50 },
      roles: { ...DEFAULT_CONCURRENCY.roles, executor: 50, reviewer: 50 },
    },
  };
}

function acceptanceMoves(id: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'request_changes' AND to_status = 'acceptance'")
    .get(id) as { n: number };
  return row.n;
}

before(() => {
  saveConfig(config());
  setWakeSender((id, text) => {
    sent.push({ id, text });
  });
  setAgentAliveCheck((id) => id === "creator" || id === "proj-boss" || id === "kanban-boss");
});

after(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

describe("standalone review cards", () => {
  it("shows reviewRejected on the board from the request_changes event", () => {
    const board = readFileSync(new URL("../client/card-drawer.tsx", import.meta.url), "utf8");
    assert.match(board, /eventHeadline\(item\.kind, item\.data\)/);
    const data = JSON.stringify({ reason: "Missing tests", findings: "Boundary not covered", summary: zhCN("labels.caption.reviewReject", {summary:"Missing tests"}) });
    assert.equal(eventHeadline("request_changes", data), zhCN("labels.caption.reviewReject", {summary:"Missing tests"}));
  });

  it("sends request_changes to acceptance and wakes the creator", () => {
    sent.length = 0;
    setSupervisor("solo", "creator");
    const task = createTask({
      project: "solo",
      title: "Sample text",
      role: "reviewer",
      workspacePath: dir,
      createdByAgent: "creator",
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', review_round = 2 WHERE id = ?").run(task.id);
    const returned = requestChanges(task.id, "Missing tests", "Boundary not covered", "reviewer");
    assert.equal(returned.status, "acceptance");
    assert.equal(returned.blocked_kind, null);
    assert.equal(returned.executor_agent_id, null);
    const stored = JSON.parse(returned.handoff_json ?? "") as { summary: string; handoff: { reason: string; findings: string } };
    assert.equal(stored.summary, "Missing tests");
    assert.equal(stored.handoff.reason, "Missing tests");
    assert.equal(stored.handoff.findings, "Boundary not covered");
    const event = getDb()
      .prepare("SELECT from_status, to_status, data_json FROM events WHERE task_id = ? AND kind = 'request_changes'")
      .get(task.id) as { from_status: string; to_status: string; data_json: string };
    assert.equal(event.from_status, "reviewing");
    assert.equal(event.to_status, "acceptance");
    assert.equal(eventHeadline("request_changes", event.data_json), zhCN("labels.caption.reviewReject", {summary:"Missing tests"}));
    const note = sent.find((item) => item.text.includes(`${cardMark(task.id)} `));
    assert.ok(note);
    assert.equal(note.id, "creator");
    setSupervisor("solo", "proj-boss");
    assert.equal(note.text.startsWith(zhCN("wake.review.changes")), true);
    assert.match(note.text, new RegExp("Missing tests"));
    assert.match(note.text, new RegExp(localePattern(zhCNPart("wake.review.fixNext", 0, 21))));
    assert.equal(sent.some((item) => item.id === "kanban-boss" && item.text.includes(`${cardMark(task.id)} `)), false);
  });

  it("wakes the project supervisor when the creator is gone", () => {
    sent.length = 0;
    const task = createTask({
      project: "solo",
      title: "Creator left",
      role: "reviewer",
      workspacePath: dir,
      createdByAgent: "gone",
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
    requestChanges(task.id, (zhCNPart("boardView.cmd.reworkReason", 1, 3) + "Demo text"), (zhCNPart("workspaceRecreate.noDirectoryReturned", 2, 4) + "Demo text"), "reviewer");
    const note = sent.find((item) => item.text.includes(`${cardMark(task.id)} `));
    assert.ok(note);
    assert.equal(note.id, "proj-boss");
    assert.equal(note.text.startsWith(zhCN("wake.review.changes")), true);
    assert.equal(sent.some((item) => item.id === "kanban-boss" && item.text.includes(`${cardMark(task.id)} `)), false);
  });

  it("starts an approve wake with approved", async () => {
    sent.length = 0;
    setSupervisor("solo", "creator");
    const task = createTask({
      project: "solo",
      title: "Review approved",
      role: "reviewer",
      workspacePath: dir,
      createdByAgent: "creator",
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
    const approved = await approveTask(task.id, (zhCNPart("history.noMatch", 0, 2) + zhCNPart("doctor.format.none", 6, 8)));
    assert.equal(approved.status, "acceptance");
    const note = sent.find((item) => item.text.includes(`${cardMark(task.id)} `));
    assert.ok(note);
    assert.equal(note.id, "creator");
    setSupervisor("solo", "proj-boss");
    assert.equal(note.text.startsWith(zhCN("wake.review.approved")), true);

    const executor = createTask({
      project: "solo",
      title: "Executor card passed",
      role: "executor",
      workspacePath: dir,
      createdByAgent: "creator",
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(executor.id);
    await approveTask(executor.id, "Executor card passed");
    const execNote = sent.find((item) => item.text.includes(`${cardMark(executor.id)} `));
    assert.ok(execNote);
    assert.equal(execNote.text.startsWith(zhCN("wake.review.approved")), false);
    assert.match(execNote.text, new RegExp(localePattern(zhCNPart("wake.acceptance.next", 0, 6))));
  });

  it("still sends an executor card back to the original executor", async () => {
    sent.length = 0;
    const task = createTask({
      project: "solo",
      title: "Executor rejected",
      role: "executor",
      workspacePath: dir,
      createdByAgent: "creator",
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', executor_agent_id = 'exec-1', agent_id = 'rev-1' WHERE id = ?").run(task.id);
    const returned = requestChanges(task.id, "Add tests", "Boundary unspecified", "reviewer");
    assert.equal(returned.status, "rework");
    assert.equal(returned.executor_agent_id, "exec-1");
    assert.equal(sent.some((item) => item.text.includes(`${cardMark(task.id)} `)), false);
    const sentTo: string[] = [];
    await startTask(
      task.id,
      {
        async create() {
          throw new Error((zhCNPart("cardParts.event.prFailed", 4, 6) + zhCNPart("boardView.note.accept", 42, 44) + "Demo text agent"));
        },
        async send(id) {
          sentTo.push(id);
        },
      },
      "scheduler",
    );
    assert.deepEqual(sentTo, ["exec-1"]);
    assert.equal(getTask(task.id).status, "running");
  });

  it("moves a reviewer card stuck in rework to acceptance once, without the missing-agent error", async () => {
    sent.length = 0;
    const task = createTask({
      project: "solo",
      title: "In rework",
      role: "reviewer",
      workspacePath: dir,
      createdByAgent: "creator",
    });
    getDb()
      .prepare("UPDATE tasks SET status = 'rework', executor_agent_id = NULL, hold_reason = ? WHERE id = ?")
      .run(zhCN("dispatch.noExecutorAgent"), task.id);
    appendEvent(task.id, "request_changes", "reviewing", "rework", "reviewer", {
      reason: "Five findings",
      findings: "Major: missing tests",
    });
    const calls: string[] = [];
    const launcher = {
      async create() {
        calls.push("create");
        return { id: "should-not" };
      },
      async send() {
        calls.push("send");
      },
    };
    const saved = config();
    await runTick({ profiles: [], launcher, config: saved, agentState: () => "alive" });
    assert.equal(getTask(task.id).status, "acceptance");
    assert.equal(getTask(task.id).hold_reason, null);
    const stored = JSON.parse(getTask(task.id).handoff_json ?? "") as { handoff: { reason: string; findings: string } };
    assert.equal(stored.handoff.reason, "Five findings");
    assert.equal(stored.handoff.findings, "Major: missing tests");
    assert.equal(acceptanceMoves(task.id), 1);
    const note = sent.find((item) => item.text.includes(`${cardMark(task.id)} `));
    assert.ok(note);
    assert.equal(note.text.startsWith(zhCN("wake.review.changes")), true);
    assert.match(note.text, new RegExp("Five findings"));
    assert.equal(getDb().prepare("SELECT id FROM events WHERE task_id = ? AND kind = 'board_wake'").get(task.id), undefined);
    assert.deepEqual(calls, []);

    await runTick({ profiles: [], launcher, config: saved, agentState: () => "alive" });
    assert.equal(getTask(task.id).status, "acceptance");
    assert.equal(acceptanceMoves(task.id), 1);
    assert.equal(sent.filter((item) => item.text.includes(`${cardMark(task.id)} `) && item.text.startsWith(zhCN("wake.review.changes"))).length, 1);

    const direct = createTask({
      project: "solo",
      title: "Start entry",
      role: "reviewer",
      workspacePath: dir,
      createdByAgent: "creator",
    });
    getDb().prepare("UPDATE tasks SET status = 'rework', executor_agent_id = NULL WHERE id = ?").run(direct.id);
    appendEvent(direct.id, "request_changes", "reviewing", "rework", "reviewer", { reason: "Reject directly", findings: "demo fixture" });
    const started = await startTask(
      direct.id,
      {
        async create() {
          throw new Error((zhCNPart("boardView.note.accept", 42, 44) + "Demo text"));
        },
        async send() {
          throw new Error((zhCNPart("boardView.note.accept", 42, 44) + "Demo text"));
        },
      },
      "scheduler",
    );
    assert.match(started.message, new RegExp(zhCN("lifecycleHooks.nudge.next.accept")));
    assert.equal(getTask(direct.id).status, "acceptance");
    assert.equal(acceptanceMoves(direct.id), 1);

    const bareRoom = join(dir, "bare");
    mkdirSync(bareRoom, { recursive: true });
    const bare = createTask({
      project: "solo",
      title: "Executor missing",
      role: "executor",
      workspacePath: bareRoom,
    });
    getDb().prepare("UPDATE tasks SET status = 'rework', executor_agent_id = NULL WHERE id = ?").run(bare.id);
    const opened: string[] = [];
    const startedBare = await startTask(
      bare.id,
      {
        async create() {
          opened.push("create");
          return { id: "new-exec" };
        },
        async send() {
          throw new Error((zhCNPart("dispatch.noExecutorAgent", 0, 7) + zhCNPart("routing.standaloneFallback", 9, 11) + "Do not return"));
        },
      },
      "scheduler",
      {
        profiles: [{ id: "exec", name: zhCN("labels.role.executor"), role: "executor", provider: "alternate", model: "grok-4.7", pool: "alternate" }],
        chosen: { id: "exec", name: zhCN("labels.role.executor"), role: "executor", provider: "alternate", model: "grok-4.7", pool: "alternate" },
        reason: "Redispatch",
      },
    );
    assert.deepEqual(opened, ["create"]);
    assert.match(startedBare.message, new RegExp(localePattern(zhCNPart("dispatch.started", 0, 3))));
    assert.equal(getTask(bare.id).executor_agent_id, "new-exec");
  });
});
