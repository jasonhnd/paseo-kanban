/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/alive";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { cardMark } from "../server/card-ref";
import { kanbanHelp } from "../server/cli";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { leaderPassTask, leaderReworkTask, rejectTask, requestChanges } from "../server/flow";
import { protocolFor } from "../server/protocol";
import { openEntry, type PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { awaitingLeaderHold, leaderHoldReason } from "../server/review-hold";
import { runTick } from "./helpers/compat-schedule";
import { retryReviewHolds } from "../server/wake";
import { createTask, getTask } from "../server/store";
import { toolDefs } from "../server/tools";

const dir = mkdtempSync(join(tmpdir(), "review-hold-"));
process.env.KANBAN_DATA_DIR = dir;
mkdirSync(dir, { recursive: true });
saveConfig({ ...loadConfig(), supervisorAgentId: "kanban-leader", supervisors: { round2: "project-leader" } });

const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" };

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function reviewing(title: string, round = 0) {
  const task = createTask({
    project: "round2",
    title,
    role: "executor",
    workspacePath: room(title),
    brief: "demo fixture",
    createdByAgent: "project-leader",
  });
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'reviewing', review_round = ?, executor_agent_id = ?, executor_profile = ?, agent_id = ? WHERE id = ?`,
    )
    .run(round, `exec-${task.id}`, executor.name, `rev-${task.id}`, task.id);
  return getTask(task.id);
}

function events(id: number, kind: string): Array<Record<string, unknown>> {
  return (
    getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{
      data_json: string;
    }>
  ).map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
}

function countKind(kind: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind) as { n: number }).n;
}

function flushWakes(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Drive one card to the second review rejection. The caller owns the wake sender and the alive check. */
function rejectTwice(title: string) {
  const task = reviewing(title);
  requestChanges(task.id, (zhCNPart("profileRules.tag.highRisk", 62, 64) + "Demo text"), "Boundary unspecified", "reviewer");
  getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = ? WHERE id = ?").run(`rev-${task.id}`, task.id);
  const held = requestChanges(task.id, "Second round missing permission checks", "Admin path untested", "reviewer");
  return held;
}

after(() => {
  resetAgentAliveCheck();
  setWakeSender(() => {});
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("round-2 leader hold", () => {
  it("documents the second-round stop in help, tools, and the leader rules", () => {
    assert.match(kanbanHelp(), new RegExp(zhCN("flow.comment.round2") + localePattern(zhCNPart("wake.blocked.boardNeedsHuman", 6, 8)) + zhCN("labels.status.rework")));
    assert.match(kanbanHelp(), new RegExp(localePattern(zhCNPart("reviewHold.next.check", 17, 21))));
    assert.match(kanbanHelp(), new RegExp(localePattern(zhCNPart("flow.comment.round3", 0, 5)) + zhCN("cardParts.event.fused") + "\\u4ec5\\u4f5c\\u88c1\\u5b9a\\u53d1\\u56de\\u540e\\u7684\\u515c\\u5e95"));
    assert.match(toolDefs().find((tool) => tool.name === "kanban_request_changes")?.description ?? "", new RegExp(localePattern(zhCNPart("flow.comment.round2", 0, 4)) + localePattern(zhCNPart("dispatch.prompt.lastReview", 6, 9)) + zhCN("boardView.round.single") + localePattern(zhCNPart("wake.blocked.boardNeedsHuman", 6, 8)) + zhCN("labels.status.rework")));
    assert.match(toolDefs().find((tool) => tool.name === "kanban_rework")?.description ?? "", new RegExp("rework " + localePattern(zhCNPart("cardCode.noFreeCode", 12, 14))));
    assert.match(toolDefs().find((tool) => tool.name === "kanban_pass")?.description ?? "", new RegExp(localePattern(zhCNPart("reviewHold.next.pass", 48, 54))));
    assert.match(protocolFor("supervisor"), new RegExp(localePattern(zhCNPart("reviewHold.lead.title", 14, 22))));
    assert.match(protocolFor("supervisor"), /bin\/kanban pass/);
    assert.match(protocolFor("supervisor"), new RegExp(localePattern(zhCNPart("reviewHold.next.check", 17, 21))));
  });

  it("sends the first review rejection back and does not record a hold", () => {
    const task = reviewing((zhCNPart("profileRules.tag.highRisk", 62, 64) + zhCNPart("reviewHold.lead.rounds", 1, 2)));
    const back = requestChanges(task.id, "Add boundary coverage", "Empty string untested", "reviewer");
    assert.equal(back.status, "rework");
    assert.equal(back.review_round, 1);
    assert.equal(back.agent_id, `exec-${task.id}`);
    assert.equal(back.executor_agent_id, `exec-${task.id}`);
    assert.equal(back.hold_reason, null);
    assert.equal(awaitingLeaderHold(task.id), false);
    assert.equal(events(task.id, "review_leader_hold").length, 0);
    assert.equal(events(task.id, "wake_review_hold").length, 0);
  });

  it("parks the second review rejection, keeps the executor, and wakes with both rounds", async () => {
    const task = reviewing("Second round");
    requestChanges(task.id, (zhCNPart("profileRules.tag.highRisk", 62, 64) + "Demo text"), "Boundary unspecified", "reviewer");
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = ? WHERE id = ?").run(`rev-${task.id}`, task.id);
    const sent: string[] = [];
    setAgentAliveCheck((id) => id === "project-leader");
    setWakeSender((id, text) => {
      sent.push(`${id}\n${text}`);
    });
    try {
      const held = requestChanges(task.id, "Second round missing permission checks", "Admin path untested", "reviewer");
      assert.equal(held.status, "rework");
      assert.equal(held.review_round, 2);
      assert.equal(held.blocked_kind, null);
      assert.equal(held.agent_id, null);
      assert.equal(held.executor_agent_id, `exec-${task.id}`);
      assert.equal(held.hold_reason, leaderHoldReason());
      assert.equal(awaitingLeaderHold(task.id), true);
      const hold = events(task.id, "review_leader_hold");
      assert.equal(hold.length, 1);
      assert.equal(hold[0]?.reviewRound, 2);
      const rounds = hold[0]?.rounds as Array<{ reason: string }>;
      assert.match(rounds[0]?.reason ?? "", new RegExp(localePattern(zhCNPart("profileRules.tag.highRisk", 62, 64)) + "Demo text"));
      assert.match(rounds[1]?.reason ?? "", new RegExp("Second round missing permission checks"));
      assert.match(String(hold[0]?.lead), new RegExp(localePattern(zhCNPart("reviewHold.lead.rounds", 0, 4))));
      assert.match(String(hold[0]?.next), new RegExp(`bin/kanban rework ${cardMark(task.id)}`));
      assert.match(String(hold[0]?.next), new RegExp(`bin/kanban pass ${cardMark(task.id)}`));
      assert.match(String(hold[0]?.next), new RegExp(localePattern(zhCNPart("reviewHold.next.pass", 48, 54))));
      assert.match(String(hold[0]?.next), new RegExp(localePattern(zhCNPart("reviewHold.next.check", 0, 21))));
      assert.equal(sent.length, 1);
      assert.match(sent[0] ?? "", /^project-leader\n/);
      assert.match(sent[0] ?? "", new RegExp(localePattern(zhCNPart("profileRules.tag.highRisk", 62, 64)) + "Demo text"));
      assert.match(sent[0] ?? "", new RegExp("Second round missing permission checks"));
      assert.match(sent[0] ?? "", new RegExp(localePattern(zhCNPart("boardView.hold.threeWays", 0, 4))));
      await flushWakes();
      const wake = events(task.id, "wake_review_hold");
      assert.equal(wake.length, 1);
      assert.equal(wake[0]?.agentId, "project-leader");
      assert.equal(wake[0]?.fallback, false);
      assert.equal(wake[0]?.delivered, true);
      assert.equal(getTask(task.id).unattended_at, null);
    } finally {
      resetAgentAliveCheck();
      setWakeSender(() => {});
    }
  });

  it("retries a round-2 wake after a throw and a rejected promise, then sends once", async () => {
    setAgentAliveCheck((id) => id === "project-leader");
    let attempts = 0;
    setWakeSender(() => {
      attempts += 1;
      throw new Error("Transport disconnected");
    });
    try {
      const held = rejectTwice((zhCNPart("stall.call.send", 0, 2) + "Demo text"));
      await flushWakes();
      assert.equal(attempts, 1);
      assert.equal(getTask(held.id).status, "rework");
      assert.ok(getTask(held.id).unattended_at);
      assert.equal(events(held.id, "wake_review_hold").filter((row) => row.delivered === true).length, 0);
      assert.equal(events(held.id, "wake_review_hold").filter((row) => row.delivered === false).length, 1);

      setWakeSender(() => {
        attempts += 1;
        return Promise.reject(new Error("Transport rejected"));
      });
      retryReviewHolds();
      await flushWakes();
      assert.equal(attempts, 2);
      assert.equal(events(held.id, "wake_review_hold").filter((row) => row.delivered === true).length, 0);
      assert.ok(getTask(held.id).unattended_at);

      const sent: string[] = [];
      setWakeSender((id) => {
        attempts += 1;
        sent.push(id);
      });
      retryReviewHolds();
      await flushWakes();
      assert.deepEqual(sent, ["project-leader"]);
      assert.equal(events(held.id, "wake_review_hold").filter((row) => row.delivered === true).length, 1);
      assert.equal(getTask(held.id).unattended_at, null);
      const delivered = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM events
           WHERE task_id = ? AND kind = 'wake_review_hold'
             AND json_extract(data_json, '$.delivered') = 1
             AND json_extract(data_json, '$.fallback') IS NOT 1
             AND json_extract(data_json, '$.agentId') IS NOT NULL`,
        )
        .get(held.id) as { n: number };
      assert.equal(delivered.n, 1);

      retryReviewHolds();
      await flushWakes();
      assert.deepEqual(sent, ["project-leader"]);
      assert.equal(attempts, 3);
    } finally {
      resetAgentAliveCheck();
      setWakeSender(() => {});
    }
  });

  it("keeps a round-2 wake retryable when no sender is bound, then delivers once", async () => {
    setAgentAliveCheck((id) => id === "project-leader");
    resetWakeSender();
    try {
      const held = rejectTwice((zhCNPart("stall.call.send", 0, 2) + zhCNPart("boardView.alert.schedulerNotReady", 2, 4) + zhCNPart("relatedView.pr.unbound", 1, 3)));
      await flushWakes();
      assert.equal(getTask(held.id).status, "rework");
      assert.ok(getTask(held.id).unattended_at);
      assert.equal(events(held.id, "wake_review_hold").filter((row) => row.delivered === true).length, 0);

      const sent: string[] = [];
      setWakeSender((id) => {
        sent.push(id);
      });
      retryReviewHolds();
      await flushWakes();
      assert.deepEqual(sent, ["project-leader"]);
      assert.equal(events(held.id, "wake_review_hold").filter((row) => row.delivered === true).length, 1);
      assert.equal(getTask(held.id).unattended_at, null);

      retryReviewHolds();
      await flushWakes();
      assert.deepEqual(sent, ["project-leader"]);
    } finally {
      resetAgentAliveCheck();
      setWakeSender(() => {});
    }
  });

  it("does not park a leader acceptance reject that happens to reach round 2", () => {
    const task = reviewing(zhCNPart("boardView.round.leaderReject", 21, 25));
    requestChanges(task.id, zhCNPart("dispatch.prompt.readReview", 8, 12), "Add one", "reviewer");
    getDb().prepare("UPDATE tasks SET status = 'acceptance', agent_id = NULL WHERE id = ?").run(task.id);
    const rejected = rejectTask(task.id, (zhCNPart("flow.error.reviewerReject", 3, 7) + zhCN("common.colon") + "Demo text"), "supervisor");
    assert.equal(rejected.status, "rework");
    assert.equal(rejected.review_round, 2);
    assert.equal(rejected.agent_id, `exec-${task.id}`);
    assert.equal(awaitingLeaderHold(task.id), false);
    assert.equal(events(task.id, "review_leader_hold").length, 0);
  });

  it("parks the original card when a separate review card is rejected the second time", () => {
    const original = reviewing(zhCNPart("workspaceRecreate.reviewedCopyMissing", 0, 3));
    requestChanges(original.id, (zhCNPart("taskCreate.error.noProjectTitle", 3, 6) + zhCNPart("compat.board.notObject", 2, 3)), (zhCNPart("config.unknownProject", 19, 21) + "Demo text"), "reviewer");
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(original.id);
    const review = createTask({
      project: "round2",
      title: "Review target card",
      role: "reviewer",
      workspacePath: room("Review target card"),
      reviewOf: original.id,
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'rev-separate' WHERE id = ?").run(review.id);
    const done = requestChanges(review.id, "Still wrong on second attempt", (zhCNPart("labels.brief.noAcceptance", 4, 8) + "Demo text"), "reviewer");
    assert.equal(done.status, "done");
    const held = getTask(original.id);
    assert.equal(held.status, "rework");
    assert.equal(held.review_round, 2);
    assert.equal(held.agent_id, null);
    assert.equal(held.executor_agent_id, `exec-${original.id}`);
    assert.equal(events(original.id, "review_leader_hold").length, 1);
    assert.equal(events(review.id, "review_leader_hold").length, 0);
  });

  it("refuses to start a held card and does not let the scheduler resume or reassign it", async () => {
    const held = reviewing(zhCNPart("audit.summary.stalled", 1, 3));
    requestChanges(held.id, zhCNPart("archiveBook.reason.waitTurn", 2, 4), "A", "reviewer");
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(held.id);
    requestChanges(held.id, "Round two", "B", "reviewer");
    await assert.rejects(
      () => startTask(held.id, { async create() { throw new Error("Do not create anew"); }, async send() { throw new Error("Do not return"); } }, "scheduler"),
      new RegExp(localePattern(zhCNPart("reviewHold.holdReason", 10, 23))),
    );
    assert.equal(getTask(held.id).status, "rework");

    const moving = reviewing("Return normally");
    requestChanges(moving.id, "One round only", "C", "reviewer");
    assert.equal(getTask(moving.id).review_round, 1);
    const actions: string[] = [];
    const pools: PoolSnapshot = {
      state: "fresh",
      message: "",
      generatedAt: new Date().toISOString(),
      dispatchable: () => true,
      entry: () => openEntry(),
      hasPool: () => true,
    };
    const result = await runTick({
      profiles: [executor],
      pools,
      matrix: { state: "missing" },
      config: {
        ...loadConfig(),
        concurrency: { global: 20, roles: { executor: 20, reviewer: 20 }, pools: { cursor: 20 } },
      },
      launcher: {
        async create() {
          actions.push("create");
          return { id: "new-exec" };
        },
        async send(id) {
          actions.push(`send:${id}`);
        },
      },
      agentState: () => "alive",
    });
    assert.equal(getTask(held.id).status, "rework");
    assert.equal(getTask(held.id).agent_id, null);
    assert.equal(actions.includes(`send:exec-${held.id}`), false);
    assert.equal(getTask(moving.id).status, "running");
    assert.equal(actions.includes(`send:exec-${moving.id}`), true);
    assert.equal(result.started.includes(held.id), false);
    assert.equal(result.started.includes(moving.id), true);
  });

  it("does not reopen a held card when the old executor is archived", async () => {
    const held = reviewing((zhCN("labels.status.archived") + zhCNPart("settings.error.poolName", 7, 9) + zhCNPart("flow.rework.unreadable", 2, 4)));
    requestChanges(held.id, zhCNPart("archiveBook.reason.waitTurn", 2, 4), "A", "reviewer");
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(held.id);
    requestChanges(held.id, "Round two", "B", "reviewer");
    const executorId = `exec-${held.id}`;
    const opened: string[] = [];
    await runTick({
      profiles: [executor],
      pools: {
        state: "fresh",
        message: "",
        generatedAt: new Date().toISOString(),
        dispatchable: () => true,
        entry: () => openEntry(),
        hasPool: () => true,
      },
      matrix: { state: "missing" },
      config: {
        ...loadConfig(),
        concurrency: { global: 20, roles: { executor: 20, reviewer: 20 }, pools: { cursor: 20 } },
      },
      launcher: {
        async create(options) {
          opened.push(options.cwd);
          return { id: `opened-${opened.length}` };
        },
        async send() {},
        async inspectAgent(id) {
          return { archived: id === executorId };
        },
      },
      agentState: (id) => (id === executorId ? "archived" : "alive"),
    });
    const parked = getTask(held.id);
    assert.equal(parked.status, "rework");
    assert.equal(parked.agent_id, null);
    assert.equal(parked.executor_agent_id, executorId);
    assert.equal(parked.hold_reason, leaderHoldReason());
    assert.equal(awaitingLeaderHold(held.id), true);
    assert.equal(events(held.id, "rework_reopen_queued").length, 0);
    assert.equal(events(held.id, "rework_reopened").length, 0);
    assert.equal(opened.includes(parked.workspace_path ?? ""), false);
  });

  it("lets the leader send the held card back, then fuses the next review rejection", async () => {
    const task = reviewing((zhCNPart("dispatch.awaitingLeader", 21, 24) + "Third round"));
    requestChanges(task.id, (zhCNPart("archiveBook.reason.waitTurn", 2, 4) + zhCNPart("nativeSessions.skipLabel.other", 2, 4)), "Details", "reviewer");
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
    const held = requestChanges(task.id, "Second-round reason", "Still missing", "reviewer");
    const before = new Date(Date.now() - 86_400_000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'review_leader_hold'").run(before, task.id);
    const ruled = await leaderReworkTask(held.id, (zhCNPart("leaderRegistry.supervise.byCode", 1, 3) + "Demo text"), { presence: () => "idle" });
    assert.equal(ruled.status, "rework");
    assert.equal(ruled.review_round, 2);
    assert.equal(ruled.agent_id, `exec-${task.id}`);
    assert.equal(ruled.hold_reason, null);
    assert.equal(awaitingLeaderHold(task.id), false);
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = ? WHERE id = ?").run(`rev-${task.id}`, task.id);
    const blocked = requestChanges(task.id, "Third round still fails", ("P0 " + zhCNPart("nativeSessions.kept.running", 6, 8)), "reviewer");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_kind, "needs_human");
    assert.equal(blocked.review_round, 3);
    assert.match(blocked.blocked_reason ?? "", new RegExp(zhCN("flow.comment.round3")));
    assert.equal(events(task.id, "review_leader_hold").length, 1);
    const row = getDb()
      .prepare(
        `SELECT ROUND((julianday(r.at) - julianday(h.at)) * 86400) AS seconds
         FROM events h
         LEFT JOIN events r ON r.id = (
           SELECT MIN(id) FROM events
           WHERE task_id = h.task_id AND id > h.id AND kind IN ('leader_rework', 'leader_pass')
         )
         WHERE h.task_id = ? AND h.kind = 'review_leader_hold'`,
      )
      .get(task.id) as { seconds: number };
    assert.ok(row.seconds >= 86_000);
  });

  it("passes a held card without raising the round, and does not count that as another hold", async () => {
    const before = countKind("review_leader_hold");
    const task = reviewing(zhCNPart("reviewHold.next.pass", 37, 42));
    requestChanges(task.id, zhCNPart("archiveBook.reason.waitTurn", 2, 4), "A", "reviewer");
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
    const held = requestChanges(task.id, "Second round only copy", "P2", "reviewer");
    const passed = await leaderPassTask(held.id, (zhCNPart("reviewHold.next.pass", 37, 42) + zhCN("common.comma") + zhCNPart("cardDrawer.verdict.approve", 2, 4) + zhCNPart("reviewHold.next.pass", 47, 51)));
    assert.equal(passed.status, "acceptance");
    assert.equal(passed.review_round, 2);
    assert.equal(passed.blocked_kind, null);
    assert.equal(passed.hold_reason, null);
    assert.equal(events(task.id, "leader_pass")[0]?.note, (zhCNPart("reviewHold.next.pass", 37, 42) + zhCN("common.comma") + zhCNPart("cardDrawer.verdict.approve", 2, 4) + zhCNPart("reviewHold.next.pass", 47, 51)));
    assert.equal(countKind("review_leader_hold"), before + 1);
    const open = getDb()
      .prepare(
        `SELECT r.id AS ruling FROM events h
         LEFT JOIN events r ON r.id = (
           SELECT MIN(id) FROM events
           WHERE task_id = h.task_id AND id > h.id AND kind IN ('leader_rework', 'leader_pass')
         )
         WHERE h.task_id = ? AND h.kind = 'review_leader_hold'`,
      )
      .get(task.id) as { ruling: number | null };
    assert.equal(typeof open.ruling, "number");
  });

  it("still fuses when review_round is already 2, instead of parking a second time", () => {
    const task = reviewing((zhCNPart("cleanup.reason.gone", 0, 2) + zhCNPart("reviewHold.lead.rounds", 0, 2)), 2);
    const blocked = requestChanges(task.id, "Reject again", "Third round", "reviewer");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.review_round, 3);
    assert.match(blocked.blocked_reason ?? "", new RegExp(zhCN("flow.comment.round3")));
    assert.equal(events(task.id, "review_leader_hold").length, 0);
  });
});
