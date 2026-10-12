/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import { UI_ACTOR } from "../shared/actors";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { linkTask } from "../server/flow";
import { appendEvent, blockTask, createTask, listBoard } from "../server/store";
import {
  BOARD_COLUMNS,
  COLUMNS,
  assigneeLine,
  assignerLabel,
  boardColumnFor,
  briefAcceptance,
  briefHow,
  cardBadge,
  cardFaceTone,
  identityBits,
  relatedLine,
  statusLabel,
} from "../shared/labels";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "board-face-"));
process.env.KANBAN_DATA_DIR = dir;
const agents = join(dir, "agents");
process.env.KANBAN_AGENTS_DIR = agents;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

describe("display columns", () => {
  it("groups every internal status, including both kinds of blocked", () => {
    assert.deepEqual(BOARD_COLUMNS.map((column) => column.label), ["To Do", "Doing", "Done"]);
    assert.deepEqual(COLUMNS.map((column) => column.id), ["todo", "doing", "done", "archive"]);
    const cases: Array<[string, string | null, string]> = [
      ["triage", null, "todo"],
      ["draft", null, "todo"],
      ["waiting", null, "todo"],
      ["ready", null, "todo"],
      ["blocked", null, "todo"],
      ["blocked", "ready", "todo"],
      ["blocked", "draft", "todo"],
      ["blocked", "waiting", "todo"],
      ["blocked", "triage", "todo"],
      ["running", null, "doing"],
      ["in_review", null, "doing"],
      ["reviewing", null, "doing"],
      ["rework", null, "doing"],
      ["acceptance", null, "doing"],
      ["blocked", "running", "doing"],
      ["blocked", "in_review", "doing"],
      ["blocked", "reviewing", "doing"],
      ["blocked", "rework", "doing"],
      ["blocked", "acceptance", "doing"],
      ["done", null, "done"],
      ["archived", null, "archive"],
    ];
    for (const [status, from, column] of cases) {
      assert.equal(boardColumnFor(status, from), column, `${status}/${from ?? "none"}`);
    }
    assert.equal(statusLabel("acceptance"), zhCN("labels.status.acceptance"));
    assert.equal(cardBadge({ status: "acceptance", reviewRound: 0 }), zhCN("labels.status.acceptance"));
    assert.equal(cardBadge({ status: "rework", reviewRound: 2 }), zhCN("labels.badge.rework", {"round":"2"}));
    assert.equal(cardBadge({ status: "rework", reviewRound: 2, supervisorReject: true }), zhCN("labels.badge.reworkLeader", {"round":"2","leader":"<leader>"}));
    assert.equal(cardBadge({ status: "waiting", reviewRound: 0, parentIds: [7] }), zhCN("labels.badge.waitingParents", {"marks":"#7"}));
  });
});

describe("card face", () => {
  it("fills the five facts and the empty fallbacks", () => {
    assert.equal(briefHow(""), zhCN("labels.brief.none"));
    assert.deepEqual(briefAcceptance(""), { text: zhCN("labels.brief.noAcceptance"), missing: true });
    assert.deepEqual(briefAcceptance((zhCNPart("taskLifecycle.error.notBlocked", 0, 2) + zhCNPart("nativeSessions.archive.targetExists", 2, 4) + "\n" + zhCNPart("missingCwd.purge.noTitle", 1, 4) + zhCNPart("settings.projects.base", 1, 2))), { text: zhCN("labels.brief.noAcceptance"), missing: true });
    const brief = [("## " + zhCNPart("nativeSessions.archive.targetExists", 2, 4)), "Use three board columns", "Visible on mobile", "", ("## " + zhCNPart("labels.brief.noAcceptance", 4, 8)), "- Three column titles are To Do、Doing、Done", ("- " + zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("cardDrawer.verdict.approve", 2, 4))].join("\n");
    assert.equal(briefHow(brief), "Use three board columns\nVisible on mobile");
    assert.deepEqual(briefAcceptance(brief), { text: "Three column titles are To Do、Doing、Done", missing: false });
    assert.equal(briefHow((zhCNPart("profileRules.tag.highRisk", 62, 64) + zhCNPart("labels.role.executor", 1, 2) + "\nSecond line\nThird line")), (zhCNPart("profileRules.tag.highRisk", 62, 64) + zhCNPart("labels.role.executor", 1, 2) + "\nSecond line"));
    assert.equal(assignerLabel({ createdBy: UI_ACTOR, createdByAgent: null, agentTitle: null }), zhCN("labels.assigner.user"));
    assert.equal(assignerLabel({ createdBy: "supervisor", createdByAgent: null, agentTitle: null }), zhCN("labels.assigner.unknown"));
    assert.equal(assignerLabel({ createdBy: "supervisor", createdByAgent: "abcdefghijk", agentTitle: null }), "abcdefgh");
    assert.equal(assignerLabel({ createdBy: "supervisor", createdByAgent: "abcdefghijk", agentTitle: "【Legacy leader】DEMO" }), "【Legacy leader】DEMO");
    assert.equal(relatedLine({ project: "paseo", parents: [], reviewOf: null, tags: [] }), "paseo");
    assert.equal(
      relatedLine({
        project: "paseo",
        parents: [{ id: 3, title: "Parent work" }],
        reviewOf: { id: 9, title: "Sample text" },
        tags: ["high-risk"],
      }),
      ("paseo · " + zhCNPart("boardView.attention.parentPr", 0, 3) + "#3 Parent work · " + zhCNPart("labels.related.reviewOf", 0, 3) + "#9 Sample text · high-risk"),
    );
    assert.equal(assigneeLine({ started: false, profileOverride: null, roleLabel: zhCN("labels.role.executor"), profile: null, model: null }), zhCN("labels.assignee.auto"));
    assert.equal(assigneeLine({ started: false, profileOverride: ((zhCN("labels.role.executor") + " ") + "· Opus"), roleLabel: zhCN("labels.role.executor"), profile: null, model: null }), (zhCNPart("labels.assignee.auto", 0, 3) + (zhCN("labels.role.executor") + " ") + "· Opus"));
    assert.equal(
      assigneeLine({ started: true, profileOverride: null, roleLabel: zhCN("labels.role.executor"), profile: ((zhCN("labels.role.executor") + " ") + "· Grok"), model: "grok-4.7" }),
      ((zhCN("labels.role.executor") + " ") + "· " + (zhCN("labels.role.executor") + " ") + "· Grok · grok-4.7"),
    );
  });

  it("reads the five facts off a stored card, including a user intake and a missing acceptance section", () => {
    mkdirSync(join(agents, "bucket"), { recursive: true });
    writeFileSync(
      join(agents, "bucket", "boss-agent.json"),
      JSON.stringify({ id: "boss-agent", title: "【Legacy leader】DEMO", cwd: dir, labels: {}, archivedAt: null, lastStatus: "idle" }),
    );
    const parent = createTask({ project: "face", title: "Parent work", role: "executor", workspacePath: dir });
    const tasked = createTask({
      project: "face",
      title: "Five items",
      role: "executor",
      workspacePath: dir,
      profileOverride: ((zhCN("labels.role.executor") + " ") + "· Opus"),
      brief: "## Goal\nExplain five items\n\n## Acceptance criteria\n- Visible on the card face",
      createdByAgent: "boss-agent",
      tags: ["high-risk"],
    });
    linkTask(tasked.id, parent.id, "test");
    const card = listBoard("face").tasks.find((item) => item.id === tasked.id);
    assert.ok(card);
    assert.equal(card.column, "todo");
    assert.match(card.badge, new RegExp(`${(zhCN("labels.badge.waitingParentsBare") + " ")}${cardMark(parent.id)}`));
    assert.equal(card.assigner, "【Legacy leader】DEMO");
    assert.match(card.related, new RegExp(`face · ${(zhCN("cardDrawer.links.parent") + " ")}${cardMark(parent.id)} Parent work · high-risk`));
    assert.equal(card.assignee, (zhCNPart("labels.assignee.auto", 0, 3) + (zhCN("labels.role.executor") + " ") + "· Opus"));
    assert.equal(card.goal, "Explain five items");
    assert.equal(card.acceptance, "Visible on the card face");
    assert.equal(card.acceptanceMissing, false);

    const intake = createTask({
      project: "face",
      title: "User intake",
      role: "supervisor",
      brief: "",
      actor: UI_ACTOR,
      initialStatus: "triage",
    });
    const dropped = listBoard("face").tasks.find((item) => item.id === intake.id);
    assert.ok(dropped);
    assert.equal(dropped.assigner, zhCN("labels.assigner.user"));
    assert.equal(dropped.goal, zhCN("labels.brief.none"));
    assert.equal(dropped.acceptance, zhCN("labels.brief.noAcceptance"));
    assert.equal(dropped.acceptanceMissing, true);
    assert.equal(dropped.related, ("face · " + zhCNPart("boardView.drag", 0, 3) + "0 " + zhCNPart("missingCwd.purge.notThisCard", 4, 5)));
    assert.equal(dropped.assignee, zhCN("labels.assignee.auto"));

    const unknown = createTask({ project: "face", title: "Unclaimed", role: "executor", workspacePath: dir, brief: "demo fixture Demo text Second line" });
    const plain = listBoard("face").tasks.find((item) => item.id === unknown.id);
    assert.ok(plain);
    assert.equal(plain.assigner, zhCN("labels.assigner.unknown"));
    assert.equal(plain.goal, "demo fixture Demo text Second line");

    const running = createTask({ project: "face", title: "Blocked after start", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(running.id);
    const blocked = blockTask(running.id, "needs_human", "Missing an API guide", "test");
    const held = listBoard("face").tasks.find((item) => item.id === blocked.id);
    assert.ok(held);
    assert.equal(held.column, "doing");
    assert.equal(held.badge, zhCN("labels.status.blocked"));
    assert.equal(held.blockedReason, "Missing an API guide");
  });

  it("marks a finished card that is still waiting to land, and names conflict files", () => {
    const task = createTask({ project: "face", title: "Waiting to land", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    appendEvent(task.id, "temp_workspace", null, null, "test", {});
    appendEvent(task.id, "land_pending", null, "done", "test", {
      reason: "Sample text",
      branch: "kanban/x",
      base: "main",
    });
    const waiting = listBoard("face").tasks.find((item) => item.id === task.id);
    assert.ok(waiting);
    assert.equal(waiting.badge, zhCN("labels.badge.landPending"));
    assert.match(waiting.tempNote ?? "", new RegExp(`${zhCNPart("tempMark.note.pending", 0, 4)}${cardMark(task.id)}`));
    assert.match(waiting.tempNote ?? "", new RegExp("Sample text"));

    appendEvent(task.id, "land_pending", null, "done", "test", {
      reason: "Sample text",
      branch: "kanban/x",
      base: "main",
      conflict: true,
      files: ["README.md", "shared/labels.ts"],
    });
    const conflicted = listBoard("face").tasks.find((item) => item.id === task.id);
    assert.ok(conflicted);
    assert.equal(conflicted.badge, zhCN("labels.badge.landConflict"));
    assert.match(conflicted.tempNote ?? "", /README\.md/);
    assert.match(conflicted.tempNote ?? "", /shared\/labels\.ts/);
    assert.equal(cardFaceTone({ status: "done", badge: zhCN("labels.badge.landPending"), returnNote: null, unattended: false, awaitingMerge: false, acceptanceMissing: false }), "warning");
    assert.equal(cardFaceTone({ status: "done", badge: zhCN("labels.badge.landConflict"), returnNote: null, unattended: false, awaitingMerge: false, acceptanceMissing: false }), "danger");
    assert.equal(cardFaceTone({ status: "done", badge: zhCN("labels.status.done"), returnNote: null, unattended: false, awaitingMerge: false, acceptanceMissing: false }), "success");
  });

  it("keeps role, current, former executor, and start on one wrapping footer", () => {
    const bits = identityBits({
      roleLabel: zhCN("labels.role.executor"),
      currentText: ((zhCN("labels.role.executor") + " ") + "· " + (zhCN("labels.role.executor") + " ") + "· Grok · grok-4.7 · medium · agent abcdef12"),
      currentPress: true,
      executorText: ((zhCN("labels.role.executor") + " ") + "· Opus · agent 12345678"),
      executorPress: true,
      startedLabel: zhCN("identityLines.started", {"when":"2026-10-01 11:00","elapsed":("4 " + zhCNPart("ui.duration.underMinute", 5, 7))}),
    });
    assert.deepEqual(
      bits.map((bit) => bit.label),
      [zhCN("labels.identity.role"), zhCN("labels.identity.current"), zhCN("labels.identity.executor"), zhCN("labels.identity.started")],
    );
    assert.equal(bits[0]?.value, zhCN("labels.role.executor"));
    assert.match(bits[1]?.value ?? "", /grok-4\.7/);
    assert.match(bits[1]?.value ?? "", /abcdef12/);
    assert.equal(bits[1]?.press, true);
    assert.match(bits[2]?.value ?? "", /Opus/);
    assert.match(bits[3]?.value ?? "", new RegExp(localePattern(zhCNPart("identityLines.started", 9, 13)) + "4 " + localePattern(zhCNPart("ui.duration.underMinute", 5, 7))));
    const quiet = identityBits({
      roleLabel: zhCN("labels.role.reviewer"),
      currentText: null,
      currentPress: false,
      executorText: null,
      executorPress: false,
      startedLabel: null,
    });
    assert.deepEqual(
      quiet.map((bit) => `${bit.label} ${bit.value}`),
      [((zhCN("labels.identity.role") + " ") + zhCN("labels.role.reviewer")), ((zhCN("labels.identity.current") + " ") + zhCN("labels.identity.unassigned"))],
    );
    assert.equal(quiet.some((bit) => bit.press), false);
  });
});
