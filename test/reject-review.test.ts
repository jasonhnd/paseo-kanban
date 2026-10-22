import { seedLegacyLinkedReview } from "./helpers/legacy-review";
/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { kanbanHelp, runKanban } from "../server/cli";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { KanbanError } from "../server/errors";
import { approveTask, pollAwaitingPr, rejectTask, requestChanges } from "../server/flow";
import type { Profile } from "../server/profiles";
import { resetCheckCache, setGhRunner, type GhRunner } from "../server/pr";
import { runTick } from "./helpers/compat-schedule";
import { blockTask, createTask, getTask, listBoard, setFinishedListener } from "../server/store";
import { issueToken } from "../server/tokens";
import { handleTool } from "../server/tools";
import { setProjectCode } from "../server/config";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "reject-review-"));
process.env.KANBAN_DATA_DIR = dir;
const agents = join(dir, "agents");
process.env.KANBAN_AGENTS_DIR = agents;

const profile: Profile = {
  id: "exec",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
};

function agentFile(id: string, archivedAt: string | null, lastStatus: string): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(
    join(agents, "bucket", `${id}.json`),
    JSON.stringify({ id, title: id, cwd: dir, labels: {}, archivedAt, lastStatus }),
  );
}

function handoff(summary: string): string {
  return JSON.stringify({ summary, handoff: { files: ["README.md"] } });
}

after(() => {
  setFinishedListener(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

describe("reject and reviewed cards", () => {
  it("documents reject and --reviews", () => {
    assert.match(kanbanHelp(), new RegExp("reject <" + localePattern(zhCNPart("taskCreate.error.noTag", 22, 28)) + "reason"));
    assert.match(kanbanHelp(), new RegExp("--reviews <" + localePattern(zhCNPart("boardView.cmd.parentCode", 3, 6))));
    assert.match(kanbanHelp(), new RegExp(localePattern(zhCNPart("taskCreate.error.reviewsRole", 10, 15))));
    assert.match(kanbanHelp(), new RegExp(zhCN("flow.error.reviewerReject")));
  });

  it("sends an executor card back to Doing on review reject and on supervisor reject", async () => {
    const reviewed = createTask({ project: "back", title: "Executor rejected", role: "executor", workspacePath: dir, brief: "demo fixture" });
    getDb()
      .prepare("UPDATE tasks SET status = 'reviewing', review_round = 0, executor_agent_id = 'exec-live', agent_id = 'rev-1' WHERE id = ?")
      .run(reviewed.id);
    const returned = requestChanges(reviewed.id, "Add tests", "Boundary unspecified", "reviewer");
    assert.equal(returned.status, "rework");
    assert.equal(returned.review_round, 1);
    assert.equal(returned.executor_agent_id, "exec-live");
    const face = listBoard("back").tasks.find((card) => card.id === reviewed.id);
    assert.equal(face?.column, "doing");
    assert.equal(face?.badge, zhCN("labels.badge.rework", {"round":"1"}));
    assert.match(face?.returnNote ?? "", new RegExp("Add tests"));
    const sent: string[] = [];
    await startTask(
      reviewed.id,
      {
        async create() {
          throw new Error((zhCNPart("schedule.sendBack", 4, 8) + zhCNPart("rebind.error.unknown", 13, 17) + "Demo text"));
        },
        async send(id, text) {
          sent.push(`${id}:${text}`);
        },
      },
      "scheduler",
    );
    assert.match(sent[0] ?? "", new RegExp("^exec-live:" + zhCN("labels.caption.reviewRejectBare") + localePattern(zhCNPart("dispatch.reworkIntro", 8, 11)) + "1 " + localePattern(zhCNPart("dispatch.reworkIntro", 19, 21))));

    const bossRoom = join(dir, "boss");
    mkdirSync(bossRoom, { recursive: true });
    const accepted = createTask({ project: "back", title: "Leader rejected", role: "executor", workspacePath: bossRoom, brief: "demo fixture" });
    getDb()
      .prepare("UPDATE tasks SET status = 'acceptance', review_round = 1, executor_agent_id = 'exec-live', handoff_json = ? WHERE id = ?")
      .run(handoff((zhCNPart("flow.brief.priorHandoff", 3, 5) + "Demo text")), accepted.id);
    const rejected = rejectTask(accepted.id, (zhCNPart("flow.error.reviewerReject", 3, 7) + zhCN("common.colon") + "Demo text"), "supervisor");
    assert.equal(rejected.status, "rework");
    assert.equal(rejected.review_round, 2);
    assert.equal(rejected.agent_id, "exec-live");
    const again = listBoard("back").tasks.find((card) => card.id === accepted.id);
    assert.equal(again?.column, "doing");
    assert.equal(again?.badge, zhCN("labels.badge.reworkLeader", {"round":"2","leader":"<leader>"}));
    assert.match(again?.returnNote ?? "", new RegExp(localePattern(zhCNPart("flow.error.reviewerReject", 3, 7))));
    const boss: string[] = [];
    await startTask(
      accepted.id,
      {
        async create() {
          throw new Error((zhCNPart("schedule.sendBack", 4, 8) + zhCNPart("rebind.error.unknown", 13, 17) + "Demo text"));
        },
        async send(id, text) {
          boss.push(`${id}:${text}`);
        },
      },
      "scheduler",
    );
    assert.match(boss[0] ?? "", new RegExp("^exec-live:<leader>" + zhCN("boardView.round.single") + localePattern(zhCNPart("dispatch.reworkIntro", 8, 11)) + "2 " + localePattern(zhCNPart("dispatch.reworkIntro", 19, 21))));
  });

  it("opens a new executor when the old one is archived, and puts the reason on the brief", async () => {
    agentFile("gone-exec", "2026-09-27T00:00:00.000Z", "idle");
    const goneRoom = join(dir, "gone");
    mkdirSync(goneRoom, { recursive: true });
    const task = createTask({ project: "gone", title: "Agent gone", role: "executor", workspacePath: goneRoom, brief: "Original goal" });
    getDb()
      .prepare("UPDATE tasks SET status = 'acceptance', executor_agent_id = 'gone-exec', handoff_json = ? WHERE id = ?")
      .run(handoff((zhCNPart("compat.tick.last", 0, 2) + zhCNPart("cardDrawer.handoff.title", 2, 4) + zhCNPart("rebind.error.neverRan", 11, 13))), task.id);
    const rejected = rejectTask(task.id, zhCNPart("flow.error.reviewerReject", 3, 7), "supervisor");
    assert.equal(rejected.status, "rework");
    assert.equal(rejected.executor_agent_id, null);
    assert.match(rejected.brief, new RegExp(zhCN("flow.brief.rejected") + "\\n" + localePattern(zhCNPart("flow.error.reviewerReject", 3, 7))));
    assert.match(rejected.brief, new RegExp(localePattern(zhCNPart("flow.brief.priorHandoff", 3, 8))));
    assert.match(rejected.brief, new RegExp(localePattern(zhCNPart("compat.tick.last", 0, 2)) + localePattern(zhCNPart("cardDrawer.handoff.title", 2, 4)) + localePattern(zhCNPart("rebind.error.neverRan", 11, 13))));
    const created: string[] = [];
    await startTask(
      task.id,
      {
        async create(options) {
          created.push(options.prompt ?? "");
          return { id: "new-exec" };
        },
        async send() {
          throw new Error((zhCNPart("boardView.accept.external", 0, 4) + zhCNPart("taskLifecycle.blockIgnored.archived", 3, 7) + "Demo text"));
        },
      },
      "scheduler",
      { profiles: [profile], chosen: profile, reason: "Redispatch" },
    );
    assert.equal(created.length, 1);
    assert.match(created[0] ?? "", new RegExp(localePattern(zhCNPart("flow.error.reviewerReject", 3, 7))));
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).executor_agent_id, "new-exec");

    agentFile("gone-review", null, "closed");
    const executed = createTask({ project: "gone", title: "Agent closed during review", role: "executor", workspacePath: dir, brief: "Goal remains" });
    getDb()
      .prepare("UPDATE tasks SET status = 'reviewing', executor_agent_id = 'gone-review', agent_id = 'rev', handoff_json = ? WHERE id = ?")
      .run(handoff((zhCN("labels.role.executor") + zhCNPart("cardDrawer.handoff.title", 2, 4))), executed.id);
    const back = requestChanges(executed.id, (zhCN("labels.role.reviewer") + zhCNPart("flow.error.reviewerReject", 5, 7)), "Missing tests", "reviewer");
    assert.equal(back.status, "rework");
    assert.equal(back.executor_agent_id, null);
    assert.match(back.brief, new RegExp(zhCN("labels.role.reviewer") + localePattern(zhCNPart("flow.error.reviewerReject", 5, 7))));
    assert.match(back.brief, new RegExp(zhCN("labels.role.executor") + localePattern(zhCNPart("cardDrawer.handoff.title", 2, 4))));
  });

  it("sends the reviewed card back to rework and finishes the review card", () => {
    const original = createTask({ project: "of", title: "Sample text", role: "executor", workspacePath: dir, brief: "Do it" });
    getDb()
      .prepare("UPDATE tasks SET status = 'acceptance', executor_agent_id = 'exec-live', review_round = 0, handoff_json = ? WHERE id = ?")
      .run(handoff("Previously completed"), original.id);
    const review = createTask({
      project: "of",
      title: "Review this",
      role: "reviewer",
      workspacePath: dir,
      reviewOf: original.id,
      createdByAgent: "boss",
    });
    assert.equal(review.review_of, original.id);
    const related = listBoard("of").tasks.find((card) => card.id === review.id);
    assert.match(related?.related ?? "", new RegExp(`${zhCNPart("labels.related.reviewOf", 0, 3)}${cardMark(original.id)} ${"Sample text"}`));
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'reviewer-1' WHERE id = ?").run(review.id);
    const done = requestChanges(review.id, (zhCNPart("boardView.cmd.reworkReason", 1, 3) + zhCN("missingCwd.report.title")), (zhCNPart("taskCreate.error.noProjectTitle", 3, 6) + zhCNPart("settings.projects.base", 1, 2)), "reviewer");
    assert.equal(done.status, "done");
    assert.equal(done.id, review.id);
    const stored = JSON.parse(done.handoff_json ?? "") as { summary: string };
    assert.equal(stored.summary, (zhCNPart("boardView.cmd.reworkReason", 1, 3) + zhCN("missingCwd.report.title")));
    const again = getTask(original.id);
    assert.equal(again.status, "rework");
    assert.equal(again.review_round, 1);
    assert.equal(again.agent_id, "exec-live");
    const originFace = listBoard("of").tasks.find((card) => card.id === original.id);
    assert.equal(originFace?.column, "doing");
    assert.equal(originFace?.badge, zhCN("labels.badge.rework", {"round":"1"}));
  });

  it("reopens a done card when the review that points at it is rejected", () => {
    const original = createTask({ project: "reopen", title: "Already done", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'done', executor_agent_id = 'exec-live', handoff_json = ? WHERE id = ?").run(handoff((zhCNPart("reclaimNote.check", 9, 11) + zhCNPart("doctorLive.unreadable", 2, 3))), original.id);
    const review = createTask({ project: "reopen", title: "Review once more", role: "reviewer", workspacePath: dir, reviewOf: original.id });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(review.id);
    requestChanges(review.id, zhCNPart("dispatch.parentsNotDone", 2, 5), "Missed", "reviewer");
    const again = getTask(original.id);
    assert.equal(again.status, "rework");
    const event = getDb()
      .prepare("SELECT from_status, to_status, data_json FROM events WHERE task_id = ? AND kind = 'request_changes'")
      .get(original.id) as { from_status: string; to_status: string; data_json: string };
    assert.equal(event.from_status, "done");
    assert.equal(event.to_status, "rework");
    assert.equal(JSON.parse(event.data_json).reopened, true);
    assert.equal(getTask(review.id).status, "done");

    const archived = createTask({ project: "reopen", title: "Already archived", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'archived', executor_agent_id = 'exec-live' WHERE id = ?").run(archived.id);
    const againReview = createTask({ project: "reopen", title: "Review archived card", role: "reviewer", workspacePath: dir, reviewOf: archived.id });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(againReview.id);
    requestChanges(againReview.id, zhCN("cardParts.event.reopened"), (zhCNPart("tempWorkspace.branch.keptAfterRetriesComment", 32, 34) + zhCNPart("cardParts.fact.goal", 4, 5)), "reviewer");
    assert.equal(getTask(archived.id).status, "rework");
    assert.equal(getTask(againReview.id).status, "done");
    const reopened = getDb()
      .prepare("SELECT from_status, to_status FROM events WHERE task_id = ? AND kind = 'request_changes'")
      .get(archived.id) as { from_status: string; to_status: string };
    assert.equal(reopened.from_status, "archived");
    assert.equal(reopened.to_status, "rework");
  });

  it("keeps a review card with no reviews target on the acceptance path", () => {
    const review = createTask({ project: "plain", title: "No target card", role: "reviewer", workspacePath: dir, createdByAgent: "creator" });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(review.id);
    const returned = requestChanges(review.id, zhCNPart("boardView.cmd.reworkReason", 1, 3), zhCNPart("compat.line.unexplained", 1, 3), "reviewer");
    assert.equal(returned.status, "acceptance");
    assert.equal(returned.review_of, null);
  });

  it("lets only a supervisor reject, and only from acceptance", async () => {
    // TEST_0273: a card no longer configures its project by writing a short code; configure it first.
    setProjectCode("gate", "GAT");
    const ready = createTask({ project: "gate", title: "Not yet at acceptance", role: "executor", workspacePath: dir });
    assert.throws(() => rejectTask(ready.id, "Too early", "supervisor"), (err: unknown) => err instanceof KanbanError && err.code === "illegal_transition");
    const waiting = createTask({ project: "gate", title: "Waiting for acceptance", role: "executor", workspacePath: dir, createdByAgent: "owner" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(waiting.id);
    await assert.rejects(handleTool("kanban_reject", { id: waiting.id, reason: "Failed" }, issueToken("executor", waiting.id, "exec")), new RegExp(localePattern(zhCNPart("tools.denial.reject", 0, 13))));
    await assert.rejects(handleTool("kanban_reject", { id: waiting.id, reason: "Failed" }, issueToken("reviewer", waiting.id, "rev")), new RegExp(localePattern(zhCNPart("tools.denial.reject", 0, 13))));
    await assert.rejects(handleTool("kanban_reject", { id: waiting.id, reason: "Failed" }, issueToken("supervisor", null, "stranger")), new RegExp(localePattern(zhCNPart("dispatch.noExecutorAgent", 14, 18))));
    const supervisor = issueToken("supervisor", null, null);
    await assert.rejects(handleTool("kanban_reject", { id: ready.id, reason: "Failed" }, supervisor), new RegExp(localePattern(zhCNPart("flow.error.cannotReject", 0, 3))));
    const rejected = await handleTool("kanban_reject", { id: waiting.id, reason: "Missing acceptance criteria" }, supervisor);
    assert.equal((rejected as { status: string }).status, "rework");
    await assert.rejects(
      () => runKanban(["create", "--project", "gate", "--title", "Bad reference", "--role", "reviewer", "--reviews", "99999"], { KANBAN_DATA_DIR: dir }),
      new RegExp(localePattern(zhCNPart("cardRef.error.noCard", 0, 5))),
    );
    await assert.rejects(
      () => runKanban(["create", "--project", "gate", "--title", (zhCNPart("wake.review.fixNext", 5, 8) + "Demo text"), "--role", "executor", "--reviews", String(ready.id)], { KANBAN_DATA_DIR: dir }),
      new RegExp(localePattern(zhCNPart("taskCreate.error.reviewsRole", 10, 15))),
    );
  });

  it("notifies cleanup when a review card with --reviews is rejected into done", () => {
    const original = createTask({ project: "heard", title: "demo fixture", role: "executor", workspacePath: dir, brief: "demo fixture" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance', executor_agent_id = 'exec-live' WHERE id = ?").run(original.id);
    const review = createTask({ project: "heard", title: "Reviewer", role: "reviewer", workspacePath: dir, reviewOf: original.id });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'rev-live' WHERE id = ?").run(review.id);
    const heard: number[] = [];
    setFinishedListener((task) => {
      heard.push(task.id);
    });
    try {
      const done = requestChanges(review.id, zhCNPart("boardView.cmd.reworkReason", 1, 3), "Missing tests", "reviewer");
      assert.equal(done.id, review.id);
      assert.equal(done.status, "done");
      assert.deepEqual(heard, [review.id]);
      assert.equal(getTask(original.id).status, "rework");
    } finally {
      setFinishedListener(null);
    }
  });

  it("refuses to reject a reviewer card and does not start it on the next tick", async () => {
    const opened: string[] = [];
    const launcher = {
      async create(options: { prompt?: string }) {
        opened.push(options.prompt ?? "");
        return { id: "should-not-open" };
      },
      async send() {
        opened.push("send");
      },
    };
    const pools = {
      state: "fresh" as const,
      message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
      generatedAt: new Date().toISOString(),
      dispatchable: () => true,
      entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
    };
    for (const reviewOf of [null, 1] as const) {
      const original = createTask({ project: "stay", title: "demo fixture", role: "executor", workspacePath: dir });
      const review = createTask({
        project: "stay",
        title: reviewOf ? "Linked review" : "Unlinked review",
        role: "reviewer",
        workspacePath: dir,
        ...(reviewOf ? { reviewOf: original.id } : {}),
      });
      getDb().prepare("UPDATE tasks SET status = 'acceptance', agent_id = 'rev-accept' WHERE id = ?").run(review.id);
      assert.throws(
        () => rejectTask(review.id, zhCNPart("flow.error.reviewerReject", 3, 7), "supervisor"),
        (err: unknown) => err instanceof KanbanError && err.code === "illegal_transition" && new RegExp(zhCN("flow.error.reviewerReject")).test(err.message),
      );
      assert.equal(getTask(review.id).status, "acceptance");
      const reviewerProfile: Profile = {
        id: "rv",
        name: zhCN("labels.role.reviewer"),
        role: "reviewer",
        family: "anthropic",
        provider: "claude",
        model: "sonnet",
        pool: "claude-max",
      };
      await assert.rejects(
        () => startTask(review.id, launcher, "scheduler", { profiles: [reviewerProfile], chosen: reviewerProfile, reason: "Test" }),
        new RegExp(localePattern(zhCNPart("flow.error.cannotReject", 0, 3))),
      );
      const names = getDb().prepare("SELECT DISTINCT project FROM tasks").all() as Array<{ project: string }>;
      const autoStart: Record<string, boolean> = {};
      for (const row of names) autoStart[row.project] = false;
      await runTick({
        launcher,
        profiles: [],
        pools,
        config: { autoStart, supervisorAgentId: null, supervisors: {}, concurrency: { global: 1, pools: {}, roles: {} } },
      });
      assert.equal(getTask(review.id).status, "acceptance");
      assert.equal(getTask(review.id).agent_id, "rev-accept");
      assert.equal(opened.some((text) => text.includes(`${cardMark(review.id)}`)), false);
    }
  });

  it("leaves a running original card unchanged when the review card is rejected", () => {
    const original = createTask({ project: "busy", title: "Working", role: "executor", workspacePath: dir, brief: "still running" });
    getDb().prepare("UPDATE tasks SET status = 'running', executor_agent_id = 'exec-live', agent_id = 'exec-live' WHERE id = ?").run(original.id);
    const review = createTask({ project: "busy", title: "Review active work", role: "reviewer", workspacePath: dir, reviewOf: original.id });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(review.id);
    assert.throws(
      () => requestChanges(review.id, zhCNPart("vacuum.held", 16, 18), zhCN("reclaimNote.result.running"), "reviewer"),
      (err: unknown) => err instanceof KanbanError && err.code === "illegal_transition",
    );
    assert.equal(getTask(original.id).status, "running");
    assert.equal(getTask(original.id).agent_id, "exec-live");
    assert.equal(getTask(review.id).status, "reviewing");
    const note = getDb().prepare("SELECT body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(review.id) as { body: string };
    assert.match(note.body, new RegExp(localePattern(zhCNPart("flow.comment.rejectFailed", 0, 6))));
    assert.match(note.body, new RegExp(localePattern(zhCNPart("vacuum.held", 16, 18))));
  });

  it("clears blocked columns when a blocked card returns to rework", () => {
    const original = createTask({ project: "hold", title: "Reject after blocking", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', executor_agent_id = 'exec-live' WHERE id = ?").run(original.id);
    blockTask(original.id, "needs_human", "Wait for agent", "test");
    const review = createTask({ project: "hold", title: "Review blocked card", role: "reviewer", workspacePath: dir, reviewOf: original.id });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(review.id);
    requestChanges(review.id, (zhCNPart("boardView.cmd.okToMerge", 0, 2) + zhCNPart("wake.blocked.needsHuman", 9, 11)), "Human provided it", "reviewer");
    const again = getTask(original.id);
    assert.equal(again.status, "rework");
    assert.equal(again.blocked_kind, null);
    assert.equal(again.blocked_reason, null);
    assert.equal(again.blocked_from, null);
    assert.equal(again.blocked_at, null);
    assert.equal(again.hold_reason, null);
    assert.equal(again.cooldown_until, null);
  });

  it("sends an in_review target back when a manual review requests changes", () => {
    const original = createTask({ project: "queued", title: "Taken over", role: "executor", workspacePath: dir, brief: "Submitted work" });
    getDb()
      .prepare("UPDATE tasks SET status = 'in_review', review_round = 0, executor_agent_id = 'exec-live', agent_id = 'exec-live', handoff_json = ? WHERE id = ?")
      .run(handoff("Submitted work"), original.id);
    const review = seedLegacyLinkedReview({
      project: "queued",
      title: "Manual review",
      role: "reviewer",
      workspacePath: dir,
      reviewOf: original.id,
    });
    assert.equal(getTask(original.id).status, "in_review");
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'reviewer-1' WHERE id = ?").run(review.id);
    const done = requestChanges(review.id, "Add tests", "Boundary unspecified", "reviewer");
    assert.equal(done.id, review.id);
    assert.equal(done.status, "done");
    const again = getTask(original.id);
    assert.equal(again.status, "rework");
    assert.equal(again.review_round, 1);
    assert.equal(again.executor_agent_id, "exec-live");
    const event = getDb()
      .prepare("SELECT from_status, to_status, data_json FROM events WHERE task_id = ? AND kind = 'request_changes'")
      .get(original.id) as { from_status: string; to_status: string; data_json: string };
    assert.equal(event.from_status, "in_review");
    assert.equal(event.to_status, "rework");
    assert.equal(JSON.parse(event.data_json).reviewRound, 1);
  });

  it("parks the second linked rejection when the target is still in_review", () => {
    const original = createTask({ project: "queued-hold", title: "Taken over again", role: "executor", workspacePath: dir, brief: "Submitted work" });
    getDb()
      .prepare("UPDATE tasks SET status = 'in_review', review_round = 1, executor_agent_id = 'exec-live', agent_id = 'exec-live' WHERE id = ?")
      .run(original.id);
    const review = seedLegacyLinkedReview({
      project: "queued-hold",
      title: "Second manual review",
      role: "reviewer",
      workspacePath: dir,
      reviewOf: original.id,
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'reviewer-2' WHERE id = ?").run(review.id);
    const done = requestChanges(review.id, "Still failing", "Add the missing case", "reviewer");
    assert.equal(done.status, "done");
    const held = getTask(original.id);
    assert.equal(held.status, "rework");
    assert.equal(held.review_round, 2);
    assert.equal(held.agent_id, null);
    assert.equal(held.executor_agent_id, "exec-live");
    const hold = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'review_leader_hold'").get(original.id) as { n: number };
    assert.equal(hold.n, 1);
  });

  it("records approval of a manual review while leaving its in_review target unchanged", async () => {
    const original = createTask({ project: "queued-ok", title: "Taken over", role: "executor", workspacePath: dir, brief: "Submitted work" });
    getDb()
      .prepare("UPDATE tasks SET status = 'in_review', review_round = 0, executor_agent_id = 'exec-live', agent_id = 'exec-live', handoff_json = ? WHERE id = ?")
      .run(handoff("Submitted work"), original.id);
    const review = seedLegacyLinkedReview({
      project: "queued-ok",
      title: "Manual review",
      role: "reviewer",
      workspacePath: dir,
      reviewOf: original.id,
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'reviewer-1' WHERE id = ?").run(review.id);
    const approved = await approveTask(review.id, "Looks right", "reviewer");
    assert.equal(approved.id, review.id);
    assert.equal(approved.status, "acceptance");
    assert.equal(getTask(review.id).status, "acceptance");
    const again = getTask(original.id);
    assert.equal(again.status, "in_review");
    assert.equal(again.review_round, 0);
    assert.equal(again.executor_agent_id, "exec-live");
    assert.equal(again.agent_id, "exec-live");
    const promoted = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'approve'").get(original.id) as { n: number };
    assert.equal(promoted.n, 0);
  });

  it("does not promote an in_review target when the review card's own checks later pass", async () => {
    const pr = "https://github.com/acme/widgets/pull/7";
    const sha = "abc123";
    const calls: string[] = [];
    let passing = false;
    const runner: GhRunner = async (args) => {
      const line = args.join(" ");
      calls.push(line);
      if (line.startsWith("pr view")) return JSON.stringify({ url: pr, headRefOid: sha, headRefName: "feature" });
      if (line.includes("/protection")) return JSON.stringify({ required_status_checks: { contexts: ["ci"] } });
      if (line.includes("/rules/")) {
        return JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
      }
      if (line.includes("/statuses")) return "[]";
      if (line.includes("check-runs")) {
        return JSON.stringify({
          check_runs: [{ name: "ci", status: passing ? "completed" : "in_progress", conclusion: passing ? "success" : null, html_url: "https://github.com/acme/widgets/runs/1" }],
        });
      }
      throw new Error(line);
    };
    const targetContract = JSON.stringify({ kind: "github", repo: "acme/widgets", pr, awaiting: false });
    const reviewContract = JSON.stringify({ kind: "github", repo: "acme/widgets", pr, awaiting: false });
    const original = createTask({
      project: "queued-poll",
      title: "GitHub target",
      role: "executor",
      workspacePath: dir,
      contract: "github:acme/widgets",
    });
    getDb()
      .prepare("UPDATE tasks SET status = 'in_review', review_round = 0, executor_agent_id = 'exec-live', agent_id = 'exec-live', contract_json = ? WHERE id = ?")
      .run(targetContract, original.id);
    const review = seedLegacyLinkedReview({
      project: "queued-poll",
      title: "GitHub manual review",
      role: "reviewer",
      workspacePath: dir,
      reviewOf: original.id,
      contract: "github:acme/widgets",
    });
    getDb()
      .prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'reviewer-1', contract_json = ? WHERE id = ?")
      .run(reviewContract, review.id);
    resetCheckCache();
    setGhRunner(runner);
    try {
      const pending = await approveTask(review.id, "Looks right", "reviewer");
      assert.equal(pending.status, "reviewing");
      assert.ok(calls.length > 0);
      assert.equal(JSON.parse(getTask(review.id).contract_json!).awaiting, true);
      assert.equal(getTask(original.id).status, "in_review");
      assert.equal(getTask(review.id).status, "reviewing");
      passing = true;
      resetCheckCache();
      const moved = await pollAwaitingPr();
      assert.ok(moved.includes(review.id));
      assert.ok(calls.length > 0);
      assert.equal(getTask(review.id).status, "acceptance");
      const again = getTask(original.id);
      assert.equal(again.status, "in_review");
      assert.equal(again.review_round, 0);
      assert.equal(again.executor_agent_id, "exec-live");
      assert.equal(again.agent_id, "exec-live");
      assert.equal(again.contract_json, targetContract);
      const promoted = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'approve'").get(original.id) as { n: number };
      const released = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'release_agent'").get(original.id) as { n: number };
      assert.equal(promoted.n, 0);
      assert.equal(released.n, 0);
    } finally {
      setGhRunner(null);
      resetCheckCache();
    }
  });

  it("leaves an acceptance or reviewing target in place when the manual review approves", async () => {
    for (const status of ["acceptance", "reviewing"] as const) {
      const original = createTask({ project: `queued-keep-${status}`, title: "Already placed", role: "executor", workspacePath: dir });
      getDb()
        .prepare("UPDATE tasks SET status = ?, review_round = 1, executor_agent_id = 'exec-live', agent_id = 'exec-live' WHERE id = ?")
        .run(status, original.id);
      const review = seedLegacyLinkedReview({
        project: `queued-keep-${status}`,
        title: "Manual review",
        role: "reviewer",
        workspacePath: dir,
        reviewOf: original.id,
      });
      getDb().prepare("UPDATE tasks SET status = 'reviewing', agent_id = 'reviewer-1' WHERE id = ?").run(review.id);
      const approved = await approveTask(review.id, "Looks right", "reviewer");
      assert.equal(approved.status, "acceptance");
      const again = getTask(original.id);
      assert.equal(again.status, status);
      assert.equal(again.review_round, 1);
      assert.equal(again.agent_id, "exec-live");
    }
  });

  it("refuses a duplicate manual review without claiming its queued target", () => {
    const original = createTask({ project: "queued-create", title: "Still queued", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'in_review', executor_agent_id = 'exec-live' WHERE id = ?").run(original.id);
    assert.throws(() => createTask({
      project: "queued-create",
      title: "Manual review",
      role: "reviewer",
      workspacePath: dir,
      reviewOf: original.id,
    }), (err: unknown) => err instanceof KanbanError && err.code === "conflict");
    assert.equal(getTask(original.id).status, "in_review");
    assert.equal(getTask(original.id).executor_agent_id, "exec-live");
  });

  it("still refuses request-changes on an in_review card that has no linked review", () => {
    const original = createTask({ project: "queued-direct", title: "Waiting inline", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'in_review', executor_agent_id = 'exec-live', agent_id = 'exec-live' WHERE id = ?").run(original.id);
    assert.throws(
      () => requestChanges(original.id, "Add tests", "Boundary unspecified", "reviewer"),
      (err: unknown) => err instanceof KanbanError && err.code === "illegal_transition",
    );
    assert.equal(getTask(original.id).status, "in_review");
    assert.equal(getTask(original.id).review_round, 0);
  });

  it("parks a third rejection of a finished card in Doing", () => {
    for (const status of ["done", "archived"] as const) {
      const original = createTask({ project: "third", title: `${status} Third round`, role: "executor", workspacePath: dir });
      getDb()
        .prepare("UPDATE tasks SET status = ?, review_round = 2, executor_agent_id = 'exec-live' WHERE id = ?")
        .run(status, original.id);
      const review = createTask({ project: "third", title: `Review ${status}`, role: "reviewer", workspacePath: dir, reviewOf: original.id });
      getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(review.id);
      requestChanges(review.id, "Still failing", "Third round", "reviewer");
      const blocked = getTask(original.id);
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.blocked_from, "rework");
      const face = listBoard("third").tasks.find((card) => card.id === original.id);
      assert.equal(face?.column, "doing");
      assert.equal(getTask(review.id).status, "done");
    }
  });
});
