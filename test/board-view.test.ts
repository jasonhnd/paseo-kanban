/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { leaderActionNote } from "../server/protocol";
import {
  holdRoundBlocks,
  attentionGroups,
  attentionOf,
  quietAttention,
  boardTabBadges,
  cardHint,
  dragCount,
  handlingGuide,
  handoffDigest,
  recentEvents,
  systemAlerts,
  type ViewTask,
} from "../shared/board-view";
import type { DecisionView } from "../shared/decisions";

function task(over: Partial<ViewTask> = {}): ViewTask {
  return {
    id: 1, code: "XYZ_0001", project: "demo_tasks", title: "t", status: "running", badge: zhCN("labels.status.running"), column: "doing", reviewRound: 0,
    blockedKind: null, blockedReason: null, nextStep: null, returnNote: null, tempNote: null, stallNote: null, mcpNote: null,
    unattended: false, awaitingMerge: false, related: ("demo_tasks · " + zhCNPart("boardView.drag", 0, 3) + "0 " + zhCNPart("missingCwd.purge.notThisCard", 4, 5)), ...over,
  };
}

function decision(over: Partial<DecisionView> = {}): DecisionView {
  return {
    id: "d1", project: "demo_tasks", title: "XYZ_0002 Release scope", detail: "A sample B", blocking: false, status: "open",
    createdAt: "2026-10-01T00:00:00Z", agentId: null, leader: { agentId: null, reason: null }, ...over,
  };
}

describe("compact card hint", () => {
  it("picks one hint, most important first", () => {
    assert.equal(cardHint(task()), null);
    assert.deepEqual(cardHint(task({ related: ("x · " + zhCNPart("boardView.drag", 0, 3) + "3 " + zhCNPart("missingCwd.purge.notThisCard", 4, 5)) })), { tone: "muted", text: zhCN("boardView.drag", {"count":"3"}) });
    assert.deepEqual(cardHint(task({ nextStep: (zhCN("blocked.prefix.quota") + "codex" + zhCN("nativeSessions.sweep.reasonSep") + "5 " + zhCNPart("doctor.hours", 8, 10) + zhCNPart("waitingMetrics.badWindow", 2, 4)), related: ("x · " + zhCNPart("boardView.drag", 0, 3) + "3 " + zhCNPart("missingCwd.purge.notThisCard", 4, 5)) })), { tone: "warning", text: (zhCN("blocked.prefix.quota") + "codex" + zhCN("nativeSessions.sweep.reasonSep") + "5 " + zhCNPart("doctor.hours", 8, 10) + zhCNPart("waitingMetrics.badWindow", 2, 4)) });
    assert.deepEqual(cardHint(task({ nextStep: (zhCN("blocked.prefix.external") + "CI\n" + zhCNPart("workspaceRecreate.claimLost", 5, 7)) })), { tone: "warning", text: (zhCN("blocked.prefix.external") + "CI") });
    assert.deepEqual(cardHint(task({ nextStep: (zhCNPart("blocked.nextStep", 0, 2) + zhCNPart("board.thisProject", 1, 2)) })), { tone: "muted", text: zhCN("blocked.nextStep", {"step":(zhCNPart("blocked.nextStep", 0, 2) + zhCNPart("board.thisProject", 1, 2))}) });
    assert.equal(cardHint(task({ unattended: true, returnNote: "x" }))?.text, zhCN("cardParts.alert.unattended"));
    assert.equal(cardHint(task({ leaderUnresponsive: true, unattended: true }))?.tone, "danger");
    assert.equal(cardHint(task({ status: "blocked", blockedReason: "Missing permission", nextStep: (zhCN("blocked.prefix.quota") + "x"), leaderHold: true }))?.text, (zhCNPart("cardParts.alert.blocked", 0, 3) + "Missing permission"));
    assert.equal(cardHint(task({ status: "rework", reviewRound: 2, leaderHold: true }))?.text, zhCN("boardView.hold.headline", {"round":"2","leader":"<leader>"}));
    assert.equal(cardHint(task({ status: "done", badge: zhCN("labels.badge.landConflict"), tempNote: (zhCNPart("tempMark.note.pending", 0, 4) + zhCN("labels.badge.conflictWord")) }))?.tone, "danger");
  });

  it("reads the drag count from the related line", () => {
    assert.equal(dragCount(("demo_tasks · " + zhCNPart("boardView.drag", 0, 3) + "12 " + zhCNPart("lane.prev", 2, 4) + "· " + zhCNPart("workspaceRecreate.claimLost", 5, 7))), 12);
    assert.equal(dragCount("demo_tasks"), 0);
  });
});

describe("attention list", () => {
  it("includes blocked, acceptance, unresponsive, held, decision and land-pending cards only", () => {
    const rows = [
      task({ id: 1, status: "blocked", blockedKind: "needs_human" }),
      task({ id: 2, status: "acceptance", code: "XYZ_0002", badge: zhCN("labels.status.acceptance") }),
      task({ id: 3, leaderUnresponsive: true, status: "acceptance", code: "XYZ_0003" }),
      task({ id: 4, status: "rework", leaderHold: true, reviewRound: 2, code: "XYZ_0004" }),
      task({ id: 5, status: "done", badge: zhCN("labels.badge.landPending"), code: "XYZ_0005" }),
      task({ id: 6, status: "done", badge: zhCN("labels.badge.landConflict"), code: "XYZ_0006" }),
      task({ id: 7, status: "running", code: "XYZ_0007" }),
      task({ id: 8, status: "waiting", code: "XYZ_0008", nextStep: (zhCN("blocked.prefix.quota") + "x") }),
      task({ id: 9, status: "in_review", code: "XYZ_0009", nextStep: (zhCN("blocked.prefix.external") + "CI") }),
    ];
    const ids = rows.map((row) => attentionOf(row, [])?.task.id).filter(Boolean);
    assert.deepEqual(ids, [1, 2, 3, 4, 5, 6]);
    assert.equal(attentionOf(task({ status: "done", badge: zhCN("labels.status.done"), awaitingMerge: true }), [])?.reason, zhCN("cardDrawer.pr.awaiting"));
    assert.equal(attentionOf(task({ status: "done", badge: zhCN("labels.status.done") }), []), null);
    assert.equal(attentionOf(task({ id: 10, code: "XYZ_0010" }), [decision({ title: "XYZ_0010 Needs decision" })])?.reason, zhCN("boardView.attention.decision"));
  });

  it("groups by project with the most urgent project and card first", () => {
    const rows = [
      task({ id: 1, project: "a", status: "acceptance" }),
      task({ id: 2, project: "b", status: "acceptance" }),
      task({ id: 3, project: "b", status: "blocked" }),
      task({ id: 4, project: "a", status: "blocked" }),
      task({ id: 5, project: "b", leaderUnresponsive: true, status: "acceptance" }),
    ];
    const groups = attentionGroups(rows, []);
    // Both projects have a blocked card; the one with more cards waiting comes first.
    assert.deepEqual(groups.map((group) => group.project), ["b", "a"]);
    assert.deepEqual(groups[0]!.items.map((item) => item.task.id), [3, 5, 2]);
    assert.deepEqual(groups[1]!.items.map((item) => item.task.id), [4, 1]);
  });

  it("counts tab badges, red on blocked or red system alerts", () => {
    const rows = [task({ id: 1, status: "blocked", column: "todo" }), task({ id: 2, status: "running" }), task({ id: 3, status: "done", column: "done" })];
    const quiet = boardTabBadges({ tasks: rows, decisions: [decision()], projects: 3, alerts: [] });
    assert.deepEqual(quiet.overview, { count: 2, danger: false });
    assert.deepEqual(quiet.attention, { count: 1, danger: true });
    assert.deepEqual(quiet.decisions, { count: 1, danger: false });
    assert.equal(quiet.projects.count, 3);
    const calm = boardTabBadges({ tasks: [task({ id: 4, status: "acceptance" })], decisions: [], projects: 1, alerts: [{ tone: "warning", text: "x" }] });
    assert.deepEqual(calm.attention, { count: 1, danger: false });
    const red = boardTabBadges({ tasks: [], decisions: [decision({ blocking: true })], projects: 1, alerts: [{ tone: "danger", text: "x" }] });
    assert.deepEqual(red.attention, { count: 1, danger: true });
    assert.equal(red.decisions.danger, true);
  });

  it("keeps merge waits out of the urgent list and the badge", () => {
    const rows = [
      task({ id: 1, status: "acceptance" }),
      task({ id: 2, status: "done", badge: zhCN("labels.status.done"), awaitingMerge: true }),
      task({ id: 3, status: "done", badge: zhCN("labels.badge.landPending") }),
      task({ id: 4, status: "done", badge: zhCN("labels.badge.landConflict") }),
    ];
    assert.deepEqual(attentionGroups(rows, []).flatMap((group) => group.items.map((item) => item.task.id)), [4, 1]);
    assert.deepEqual(quietAttention(rows, []).map((item) => item.task.id), [2, 3]);
    assert.equal(boardTabBadges({ tasks: rows, decisions: [], projects: 1, alerts: [], doctorReds: 2 }).attention.count, 4);
    assert.equal(boardTabBadges({ tasks: [], decisions: [], projects: 1, alerts: [], doctorReds: 1 }).attention.danger, true);
  });

  it("turns board problems into alerts", () => {
    const base = { schedulerReady: true, schedulerIdle: null, matrixMessage: null, missingCwdMessage: null, tempWorkspaceMessage: null, restartMessage: null, pool: { state: "fresh", message: "" } };
    assert.deepEqual(systemAlerts(base), []);
    const alerts = systemAlerts({ ...base, schedulerReady: false, missingCwdMessage: (zhCNPart("lane.createdNoDirectory", 6, 9) + zhCNPart("compat.workspaces.noArchivedAt", 12, 14)), pool: { state: "stale", message: zhCN("doctor.quota.stale") } });
    assert.deepEqual(alerts.map((alert) => alert.tone), ["danger", "danger", "warning"]);
  });
});

describe("how to handle", () => {
  const parents = [{ code: "XYZ_0000", title: "Parent", status: "running" }];
  const cases: Array<[string, ViewTask, RegExp[], RegExp[], boolean]> = [
    ["acceptance", task({ status: "acceptance" }), [new RegExp("diff " + localePattern(zhCNPart("boardView.note.accept", 7, 12))), new RegExp("30 " + localePattern(zhCNPart("ui.duration.underMinute", 5, 7))), new RegExp(localePattern(zhCNPart("boardView.note.reversible", 16, 26)))], [/^bin\/kanban accept XYZ_0001$/, /^bin\/kanban rework XYZ_0001 --reason/], true],
    ["blocked needs_human", task({ status: "blocked", blockedKind: "needs_human", blockedReason: "Missing key" }), [new RegExp(zhCN("boardView.blocked.where", {"reason":"Missing key"})), new RegExp(localePattern(zhCNPart("boardView.blocked.whoHuman", 0, 2))), /roles decide add/], [/unblock XYZ_0001$/, /rework XYZ_0001/, /pass XYZ_0001/, /archive XYZ_0001$/], true],
    ["waiting", task({ status: "waiting" }), [new RegExp(localePattern(zhCNPart("cardDrawer.pr.awaiting", 0, 2)) + "XYZ_0000 Parent" + localePattern(zhCNPart("boardView.waiting.parent", 16, 22)) + zhCN("labels.status.running") + "」"), new RegExp(localePattern(zhCNPart("boardView.default.working", 12, 19)))], [], false],
    ["quota wait", task({ status: "waiting", nextStep: (zhCN("blocked.prefix.quota") + "codex-pro" + zhCN("nativeSessions.sweep.reasonSep") + zhCNPart("waitingMetrics.badWindow", 2, 4)) }), [new RegExp(zhCN("blocked.prefix.quota") + "codex-pro" + zhCN("nativeSessions.sweep.reasonSep") + localePattern(zhCNPart("waitingMetrics.badWindow", 2, 4))), new RegExp(localePattern(zhCNPart("boardView.default.working", 12, 19)))], [], false],
    ["external wait", task({ status: "in_review", nextStep: (zhCN("blocked.prefix.external") + "CI") }), [new RegExp(zhCN("blocked.prefix.external") + "CI"), new RegExp(localePattern(zhCNPart("boardView.default.working", 12, 19)))], [], false],
    ["round-2 hold", task({ status: "rework", reviewRound: 2, leaderHold: true }), [new RegExp(localePattern(zhCNPart("flow.comment.round2", 0, 5))), new RegExp("rework " + localePattern(zhCNPart("boardView.hold.options", 15, 19))), new RegExp("pass " + localePattern(zhCNPart("reviewHold.next.pass", 47, 54))), new RegExp(localePattern(zhCNPart("reviewHold.next.check", 17, 21)))], [new RegExp("rework XYZ_0001 --reason \"<" + localePattern(zhCNPart("reviewHold.next.rework", 41, 45))), /pass XYZ_0001 --note/], true],
    ["done awaiting merge", task({ status: "done", awaitingMerge: true, project: "demo_tasks" }), [new RegExp(zhCN("boardView.cmd.okToMerge")), new RegExp(localePattern(zhCNPart("boardView.done.landStep", 24, 27)))], [new RegExp("comment XYZ_0001 \"" + zhCN("boardView.cmd.okToMerge") + "\""), /--role batch/], true],
    ["done land pending", task({ status: "done", badge: zhCN("labels.badge.landPending") }), [new RegExp(localePattern(zhCNPart("boardView.done.landStep", 24, 27)))], [/--role batch/], false],
    ["done land conflict", task({ status: "done", badge: zhCN("labels.badge.landConflict") }), [new RegExp(zhCN("labels.badge.conflictWord")), new RegExp(localePattern(zhCNPart("boardView.cmd.resolveConflict", 1, 6)) + "|" + localePattern(zhCNPart("boardView.done.conflictWhere", 14, 21))), new RegExp(localePattern(zhCNPart("schedule.sendBack", 4, 8))), new RegExp(localePattern(zhCNPart("boardView.done.landStep", 24, 27)))], [/rework XYZ_0001/, new RegExp("--role batch --workspace <" + localePattern(zhCNPart("boardView.cmd.repoDir", 1, 6)))], true],
    ["waiting parent PR closed", task({ status: "waiting", nextStep: (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "XYZ_0000 " + zhCNPart("wake.parentMerge.next", 11, 19) + "PR " + zhCNPart("boardView.parentPr.closed", 3, 9)) }), [new RegExp(zhCN("boardView.parentPr.closed")), /unlink/, new RegExp(localePattern(zhCNPart("boardView.parentPr.archivedUnmerged", 4, 6)))], [/unlink XYZ_0001 --parent/], true],
    ["waiting parent archived", task({ status: "waiting", nextStep: (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "XYZ_0000 " + zhCNPart("wake.parentMerge.next", 11, 19) + zhCN("boardView.parentPr.archivedUnmerged")) }), [new RegExp(zhCN("boardView.parentPr.archivedUnmerged")), /unlink/], [/unlink XYZ_0001 --parent/], true],
  ];
  for (const [name, row, texts, commands, needsPerson] of cases) {
    it(`${name}: says what to do and gives copyable commands`, () => {
      const guide = handlingGuide(row, { parents });
      const body = [guide.headline, ...guide.steps].join("\n");
      for (const pattern of texts) assert.match(body, pattern, `${name} missing ${pattern}`);
      assert.equal(guide.commands.length >= commands.length, true);
      for (const pattern of commands) assert.ok(guide.commands.some((command) => pattern.test(command)), `${name} missing command ${pattern}`);
      assert.equal(guide.needsPerson, needsPerson);
    });
  }

  it("keeps a parent PR problem in the attention list even after the leader commented, but not an ordinary PR wait", () => {
    const stuck = task({ status: "waiting", unattended: false, nextStep: (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "XYZ_0000 " + zhCNPart("wake.parentMerge.next", 11, 19) + "PR " + zhCNPart("boardView.parentPr.closed", 3, 9)) });
    assert.equal(attentionOf(stuck, [])?.reason, zhCN("boardView.attention.parentPr"));
    assert.equal(attentionOf(stuck, [])?.quiet, false);
    const ordinary = task({ status: "waiting", nextStep: zhCN("parents.block.waitingPr", {"card":"XYZ_0000"}) });
    assert.equal(attentionOf(ordinary, []), null);
    const guide = handlingGuide(ordinary, { parents: [{ code: "XYZ_0000", title: "Parent", status: "done" }] });
    assert.equal(guide.needsPerson, false);
    assert.ok(guide.commands.some((command) => /start XYZ_0001/.test(command)));
    assert.equal(handlingGuide(stuck, { parents: [{ code: "XYZ_0000", title: "Parent", status: "done" }] }).commands.some((command) => /start /.test(command)), false);
  });

  it("tells the user the leader is unresponsive and mentions a linked decision on acceptance", () => {
    const guide = handlingGuide(task({ status: "acceptance", leaderUnresponsive: true }), { parents: [], decisionCount: 1 });
    const body = guide.steps.join("\n");
    assert.match(body, new RegExp("2 " + localePattern(zhCNPart("boardView.accept.leaderSilent", 15, 23))));
    assert.match(body, /roles decide done/);
  });

  it("keeps the wording tied to the leader protocol", () => {
    const every = [
      handlingGuide(task({ status: "acceptance" })),
      handlingGuide(task({ status: "done", awaitingMerge: true })),
      handlingGuide(task({ status: "rework", leaderHold: true, reviewRound: 2 })),
    ].flatMap((guide) => guide.steps).join("\n");
    for (const phrase of [("30 " + zhCNPart("ui.duration.underMinute", 5, 7)), zhCNPart("boardView.note.reversible", 16, 26), "roles decide add", zhCNPart("boardView.done.landStep", 24, 27), zhCN("boardView.cmd.okToMerge"), "--role batch", "pass"]) {
      assert.ok(every.includes(phrase), `guide lost ${phrase}`);
    }
    for (const phrase of [("30 " + zhCNPart("ui.duration.underMinute", 5, 7)), zhCNPart("boardView.note.reversible", 16, 26), "roles decide add", zhCN("labels.role.batch"), zhCN("boardView.cmd.okToMerge"), "--role batch"]) {
      assert.ok(leaderActionNote().includes(phrase), `protocol lost ${phrase}`);
    }
  });
});

describe("detail helpers", () => {
  it("shows five recent events by default and twenty when expanded, newest first", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
    assert.deepEqual(recentEvents(events, false).map((e) => e.id), [30, 29, 28, 27, 26]);
    assert.equal(recentEvents(events, true).length, 20);
    assert.equal(recentEvents(events.slice(0, 3), true).length, 3);
  });

  it("reads the handoff summary, verification and risks, and survives bad JSON", () => {
    const json = JSON.stringify({ summary: "demo fixture", handoff: { files: ["a", "b"], verification: "Green", risks: zhCN("doctor.none") } });
    assert.deepEqual(handoffDigest(json), { summary: "demo fixture", verification: "Green", risks: zhCN("doctor.none"), files: "a\nb" });
    assert.deepEqual(handoffDigest(JSON.stringify({ summary: "x", handoff: JSON.stringify({ verification: "v" }) })).verification, "v");
    assert.equal(handoffDigest("not json").summary, "");
    assert.equal(handoffDigest(null).summary, "");
  });
});

describe("holdRoundBlocks titles", () => {
  it("does not call a lone rejection round 2", () => {
    const [block] = holdRoundBlocks([{ at: "2026-10-01T03:00:00Z", reason: "r", findings: "" }]);
    assert.equal(block!.title.startsWith(zhCNPart("flow.comment.round2", 0, 5)), false);
    assert.match(block!.title, new RegExp("^" + zhCN("boardView.round.single")));
  });

  it("labels a leader rejected as round 1 and omits an unknown time", () => {
    const blocks = holdRoundBlocks([
      { at: "", kind: "rejected", reason: "a", findings: "" },
      { at: "2026-10-01T03:00:00Z", kind: "request_changes", reason: "b", findings: "" },
    ]);
    assert.equal(blocks[0]!.title, zhCN("boardView.round.leaderReject", {"round":"1"}));
    assert.match(blocks[1]!.title, new RegExp("^" + localePattern(zhCNPart("flow.comment.round2", 0, 5)) + zhCN("boardView.round.single") + " · 2026-10-01 03:00"));
  });
});
