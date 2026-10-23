/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { DEFAULT_NUDGE_GRACE_MS, DEFAULT_PROGRESS_GRACE_MS, loadConfig, saveConfig, setProjectCode } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { KanbanError } from "../server/errors";
import { startTask } from "./helpers/compat-dispatch";
import { applyFailure } from "../server/failures";
import { applyNudge, completeTask, requestChanges } from "../server/flow";
import type { Profile } from "../server/profiles";
import { registerTask } from "../server/register";
import { addComment, appendEvent, blockTask, claimStatus, createTask, getTask, listBoard, unblockTask } from "../server/store";
import { issueToken } from "../server/tokens";
import { handleTool } from "../server/tools";
import { seedFixtureProjects } from "./helpers/seed-projects";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "flow-"));
process.env.KANBAN_DATA_DIR = dir;
seedFixtureProjects(dir);
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_AGENTS_DIR;
});

describe("claim and review fuse", () => {
  it("lets only one of two concurrent claims succeed", async () => {
    const task = createTask({ project: "sandbox", title: "Concurrent claim", role: "executor" });
    closeDb();
    const go = join(dir, "go");
    const dbPath = join(dir, "kanban.db");
    const start = (name: string) =>
      new Promise<number>((resolve, reject) => {
        // claim-worker.mjs is plain JavaScript and does not use the suite language preload.
        // Node 22 re-runs inherited --import in the worker and cannot resolve that preload's
        // extensionless import. An explicit empty list also avoids re-passing Node's own
        // internal flags, which Worker rejects when they are copied into execArgv.
        const worker = new Worker(new URL("./claim-worker.mjs", import.meta.url), { execArgv: [], workerData: { dbPath, id: task.id, go } });
        const messages: unknown[] = [];
        worker.on("message", (message) => messages.push(message));
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`claim worker ${name} exited ${code}`));
          else resolve(Number(messages[1]));
        });
      });
    const pending = [start("a"), start("b")];
    await new Promise((resolve) => setTimeout(resolve, 50));
    closeSync(openSync(go, "w"));
    const changes = await Promise.all(pending);
    assert.equal(changes.reduce((sum, value) => sum + value, 0), 1);
    const row = getDb().prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status: string };
    assert.equal(row.status, "running");
  });

  it("stops on rework at the second rejection and still fuses a forced third", () => {
    const task = createTask({ project: "sandbox", title: "Three rejected reviews", role: "executor" });
    const cycle = () => {
      const current = getDb().prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status: string };
      if (current.status === "rework") claimStatus(task.id, "rework", "running", "test");
      else claimStatus(task.id, "ready", "running", "test");
      completeTask(task.id, "executor", "Updated", null);
      claimStatus(task.id, "in_review", "reviewing", "test");
      return requestChanges(task.id, "Still failing", "Add tests", "reviewer");
    };
    const first = cycle();
    assert.equal(first.status, "rework");
    assert.equal(first.review_round, 1);
    const second = cycle();
    assert.equal(second.status, "rework");
    assert.equal(second.review_round, 2);
    assert.equal(second.blocked_kind, null);
    assert.equal(second.agent_id, null);
    const hold = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'review_leader_hold'").get(task.id) as { n: number };
    assert.equal(hold.n, 1);
    const blocked = cycle();
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_kind, "needs_human");
    assert.equal(blocked.review_round, 3);
  });

  it("rejects an illegal complete and a bad blocked kind", async () => {
    const task = createTask({ project: "sandbox", title: "Invalid", role: "executor" });
    assert.throws(() => completeTask(task.id, "executor", "Too early", null), (err: unknown) => err instanceof KanbanError && err.code === "illegal_transition");
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("exec-block", task.id);
    await assert.rejects(handleTool("kanban_block", { id: task.id, kind: "nope", reason: "x" }, issueToken("executor", task.id, "exec-block")), (err: unknown) => err instanceof KanbanError && err.code === "invalid");
  });
});

describe("role checks", () => {
  it("refuses a reviewer tool from an executor and a register from anyone but the supervisor", async () => {
    const task = createTask({ project: "sandbox", title: "demo fixture", role: "executor" });
    claimStatus(task.id, "ready", "running", "test");
    completeTask(task.id, "executor", "Handoff", null);
    claimStatus(task.id, "in_review", "reviewing", "test");
    const executor = issueToken("executor", task.id, "agent-1");
    await assert.rejects(() => handleTool("kanban_approve", { id: task.id, summary: "sample" }, executor), new RegExp(localePattern(zhCNPart("flow.error.cannotComplete", 7, 11))));
    await assert.rejects(() => handleTool("kanban_register", { project: "p", title: "t", role: "executor", profile: "p", provider: "alternate", model: "m", agent: "a" }, executor), new RegExp(localePattern(zhCNPart("flow.error.cannotComplete", 7, 11))));
    const reviewer = issueToken("reviewer", task.id, "agent-2");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-2", task.id);
    const approved = (await handleTool("kanban_approve", { id: task.id, summary: "sample" }, reviewer)) as { status: string };
    assert.equal(approved.status, "acceptance");
    const supervisor = issueToken("supervisor", null, null);
    const accepted = (await handleTool("kanban_accept", { id: task.id }, supervisor)) as { status: string };
    assert.equal(accepted.status, "done");
  });

  it("registers a running card and writes a backfill event", async () => {
    const supervisor = issueToken("supervisor", null, null);
    const task = (await handleTool(
      "kanban_register",
      {
        project: "demo_board",
        title: "Registered",
        role: "executor",
        profile: ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2)),
        provider: "alternate",
        model: "grok-4.7",
        thinking: "high",
        agent: "agent-backfill",
        brief: "demo fixture docs/briefs/M1-executor.md",
        startedAt: "2026-09-26T09:13:24.899Z",
      },
      supervisor,
    )) as { id: number; status: string; agent_id: string };
    assert.equal(task.status, "running");
    assert.equal(task.agent_id, "agent-backfill");
    const event = getDb().prepare("SELECT kind, data_json FROM events WHERE task_id = ? AND kind = 'registered'").get(task.id) as { kind: string; data_json: string };
    assert.match(event.data_json, new RegExp(zhCN("cardParts.event.registered")));
    const run = getDb().prepare("SELECT started_at FROM runs WHERE task_id = ?").get(task.id) as { started_at: string };
    assert.equal(run.started_at, "2026-09-26T09:13:24.899Z");
    const again = registerTask({
      project: "demo_board",
      title: "Registered",
      brief: "",
      role: "executor",
      profileName: ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2)),
      provider: "alternate",
      model: "grok-4.7",
      agentId: "agent-backfill",
      idempotencyKey: "same",
      startedAt: "2026-09-26T09:13:24.899Z",
    });
    const first = registerTask({
      project: "demo_board",
      title: "Registered",
      brief: "",
      role: "executor",
      profileName: ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2)),
      provider: "alternate",
      model: "grok-4.7",
      agentId: "agent-backfill",
      idempotencyKey: "same",
      startedAt: "2026-09-26T09:13:24.899Z",
    });
    assert.equal(first.id, again.id);
    assert.throws(() => registerTask({
      project: "demo_board",
      title: "No profile",
      brief: "",
      role: "executor",
      profileName: zhCN("labels.role.executor"),
      provider: "alternate",
      model: "grok-4.7",
      agentId: "missing-agent",
    }));
  });

  it("separates the card role from the reviewer who is working now", () => {
    const task = createTask({ project: "sandbox", title: "Review display", role: "executor" });
    const db = getDb();
    db.prepare(
      "UPDATE tasks SET status = 'reviewing', agent_id = ?, executor_agent_id = ?, executor_profile = ? WHERE id = ?",
    ).run("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2) + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("nativeSessions.sweep.progressChecked", 23, 25) + zhCNPart("missingCwd.none", 3, 4)), task.id);
    db.prepare(
      ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, started_at)\n       VALUES (?, ?, 'executor', '" + (zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2) + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("nativeSessions.sweep.progressChecked", 23, 25) + zhCNPart("missingCwd.none", 3, 4) + "', 'alternate', 'grok-4.7', 'xai', 1, 'high', '2026-09-26T09:13:24.899Z')"),
    ).run(task.id, "00000000-0000-4000-8000-000000000002");
    db.prepare(
      ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n       VALUES (?, ?, 'reviewer', '" + zhCN("labels.role.reviewer") + "', 'claude', 'claude-sonnet-5', 'anthropic', 0, '2026-09-26T11:33:00.000Z')"),
    ).run(task.id, "00000000-0000-4000-8000-000000000001");
    const card = listBoard().tasks.find((item) => item.id === task.id);
    assert.ok(card);
    assert.equal(card.roleLabel, zhCN("labels.role.executor"));
    assert.equal(card.currentText, ((zhCN("labels.role.reviewer") + " ") + "· claude-sonnet-5 · agent 00000000"));
    assert.equal(card.executorText, ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2) + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("nativeSessions.sweep.progressChecked", 23, 25) + zhCNPart("missingCwd.none", 3, 4) + " · grok-4.7 · high · agent 00000000"));
    assert.equal(card.startedAt, "2026-09-26T09:13:24.899Z");
  });

  it("shows the executor profile after the card is sent back", async () => {
    const agent = "87b7f37a-still-here";
    const reviewer = "00000000-0000-4000-8000-000000000003";
    const task = createTask({
      project: "sandbox",
      title: "Rework display",
      role: "executor",
      workspacePath: dir,
      profileOverride: ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2)),
    });
    const db = getDb();
    db.prepare("UPDATE tasks SET agent_id = ?, executor_agent_id = ?, executor_profile = ?, executor_family = ? WHERE id = ?").run(
      agent,
      agent,
      ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2)),
      "xai",
      task.id,
    );
    db.prepare(
      ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, started_at)\n       VALUES (?, ?, 'executor', '" + (zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2) + "', 'alternate', 'grok-4.7', 'xai', 1, 'high', '2026-09-26T09:13:24.899Z')"),
    ).run(task.id, agent);
    claimStatus(task.id, "ready", "running", "test");
    completeTask(task.id, "executor", "Handoff", null);
    claimStatus(task.id, "in_review", "reviewing", "test");
    db.prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(reviewer, task.id);
    db.prepare(
      ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, thinking_option_id, started_at, ended_at, end_kind)\n       VALUES (?, ?, 'reviewer', '" + zhCN("labels.role.reviewer") + "', 'claude', 'claude-sonnet-5', 'anthropic', 0, 'high', '2026-09-26T11:59:02.684Z', '2026-09-26T12:07:35.677Z', 'request_changes')"),
    ).run(task.id, reviewer);
    const returned = requestChanges(task.id, zhCNPart("boardView.round.leaderReject", 21, 25), (zhCNPart("pr.checks.headMoved", 16, 18) + zhCNPart("cardParts.event.tierChanged", 0, 1)), "reviewer");
    assert.equal(returned.status, "rework");
    await startTask(
      task.id,
      {
        async create() {
          throw new Error((zhCNPart("cardParts.event.prFailed", 4, 6) + zhCNPart("boardView.note.accept", 42, 44) + "Demo text agent"));
        },
        async send() {},
      },
      "supervisor",
    );
    const card = listBoard().tasks.find((item) => item.id === task.id);
    assert.ok(card);
    assert.equal(card.currentText, ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("doctor.branch.kept", 6, 9) + "· grok-4.7 · high · agent 87b7f37a"));
    assert.equal(card.profile, ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2)));
    assert.equal(card.model, "grok-4.7 · high");
    const latest = db.prepare(
      "SELECT role, profile_name, model, thinking_option_id, agent_id, ended_at FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1",
    ).get(task.id) as { role: string; profile_name: string; model: string; thinking_option_id: string; agent_id: string; ended_at: string | null };
    assert.equal(latest.role, "executor");
    assert.equal(latest.profile_name, ((zhCN("labels.role.executor") + " ") + "· Alternate " + zhCNPart("worktreeGc.branch.localGone", 0, 2)));
    assert.equal(latest.model, "grok-4.7");
    assert.equal(latest.thinking_option_id, "high");
    assert.equal(latest.agent_id, agent);
    assert.equal(latest.ended_at, null);
  });
});

describe("create maxRetries", () => {
  it("keeps an explicit 0 from kanban_create, including the string the CLI forwards", async () => {
    // TEST_0273: a card no longer configures its project by writing a short code; configure it first.
    setProjectCode("sandbox", "SAN");
    const supervisor = issueToken("supervisor", null, null);
    const zero = (await handleTool(
      "kanban_create",
      { project: "sandbox", title: "No retry", role: "executor", maxRetries: 0 },
      supervisor,
    )) as { id: number; max_retries: number };
    assert.equal(zero.max_retries, 0);
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = 'agent-zero-tool' WHERE id = ?").run(zero.id);
    assert.equal(applyFailure(zero.id, "socket hang up", "other"), "block");
    assert.equal(getTask(zero.id).fail_count, 1);
    assert.equal(getTask(zero.id).status, "blocked");
    assert.equal(getTask(zero.id).blocked_kind, "needs_human");

    const fallback = (await handleTool(
      "kanban_create",
      { project: "sandbox", title: "Default retry", role: "executor" },
      supervisor,
    )) as { max_retries: number };
    assert.equal(fallback.max_retries, 2);

    const fromCli = (await handleTool(
      "kanban_create",
      { project: "sandbox", title: "CLI zero attempts", role: "executor", maxRetries: "0" },
      supervisor,
    )) as { max_retries: number };
    assert.equal(fromCli.max_retries, 0);
  });
});

describe("nudge fuse", () => {
  const executor: Profile = {
    id: "ex",
    name: zhCN("labels.role.executor"),
    role: "executor",
    family: "xai",
    provider: "alternate",
    model: "grok-4.7",
    pool: "alternate",
  };
  const reviewer: Profile = {
    id: "rv",
    name: zhCN("labels.role.reviewer"),
    role: "reviewer",
    family: "anthropic",
    provider: "claude",
    model: "sonnet",
    pool: "claude-max",
  };

  it("still blocks a decision card on the third miss (reader and batch cards are handed in, see nudge-turn-end.test.ts)", () => {
    for (const role of ["decision"] as const) {
      const task = createTask({ project: "sandbox", title: `${role}Three attempts`, role });
      claimStatus(task.id, "ready", "running", "test");
      getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(`${role}-fuse`, task.id);
      const start = Date.parse("2026-09-30T04:00:00.000Z");
      const gap = 10 * 60_000;
      assert.equal(applyNudge(task.id, false, { nowMs: start }).action, "remind");
      assert.equal(applyNudge(task.id, false, { nowMs: start + gap }).action, "remind");
      assert.equal(applyNudge(task.id, false, { nowMs: start + 2 * gap }).action, "block");
      assert.equal(getTask(task.id).status, "blocked");
      assert.equal(getTask(task.id).blocked_kind, "needs_human");
      const autos = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'auto_complete'").get(task.id) as { n: number };
      assert.equal(autos.n, 0);
    }
  });

  it("hands the card to review ten minutes after the first missed finish", async () => {
    const task = createTask({ project: "sandbox", title: "demo fixture", role: "executor" });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-fuse", task.id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, provider, model, family, started_at) VALUES (?, 'agent-fuse', 'executor', 'alternate', 'grok-4.7', 'xai', ?)").run(task.id, '2026-09-29T23:00:00.000Z');
    const start = Date.parse("2026-09-30T00:00:00.000Z");
    const gap = 10 * 60_000;
    const timeline = [
      { type: "assistant_message", text: (zhCNPart("readonlyWorktree.leftovers.sentence", 13, 16) + "server/stall.ts" + zhCN("common.comma") + zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("cardDrawer.handoff.none", 0, 2) + "Finished running") },
      { type: "user_message", text: (zhCN("labels.assigner.user") + "Demo text") },
    ];
    assert.equal(applyNudge(task.id, false, { nowMs: start, timeline }).action, "remind");
    assert.equal(getTask(task.id).status, "running");
    assert.equal(applyNudge(task.id, false, { nowMs: start + gap - 1, timeline }).action, "none");
    assert.equal(getTask(task.id).status, "running");
    const handed = applyNudge(task.id, false, { nowMs: start + gap, timeline });
    assert.equal(handed.action, "handoff");
    const row = getTask(task.id);
    assert.equal(row.status, "in_review");
    assert.equal(row.blocked_kind, null);
    const event = getDb().prepare("SELECT to_status, data_json FROM events WHERE task_id = ? AND kind = 'auto_complete'").get(task.id) as {
      to_status: string;
      data_json: string;
    };
    assert.equal(event.to_status, "in_review");
    const data = JSON.parse(event.data_json) as { lastMessage?: string };
    assert.equal(data.lastMessage, (zhCNPart("readonlyWorktree.leftovers.sentence", 13, 16) + "server/stall.ts" + zhCN("common.comma") + zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("cardDrawer.handoff.none", 0, 2) + "Finished running"));
    assert.equal(applyNudge(task.id, false, { nowMs: start + 2 * gap, timeline }).action, "none");
    assert.equal(getTask(task.id).status, "in_review");
    const work = join(dir, "auto-review");
    mkdirSync(work, { recursive: true });
    getDb().prepare("UPDATE tasks SET workspace_path = ? WHERE id = ?").run(work, task.id);
    await startTask(task.id, { async create() { return { id: "review-after-auto" }; }, async send() {} }, "test", {
      profiles: [executor, reviewer],
      chosen: reviewer,
      reason: "Reviewer",
    });
    const opened = getTask(task.id);
    assert.equal(opened.status, "reviewing");
    assert.equal(opened.agent_id, "review-after-auto");
  });

  it("clears the counter when a reader enters acceptance", () => {
    const task = createTask({ project: "sandbox", title: "Reader completion", role: "reader" });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET nudge_count = 3 WHERE id = ?").run(task.id);
    const done = completeTask(task.id, "reader", zhCNPart("decisions.row.expand", 2, 4), null);
    assert.ok(!(done instanceof Promise));
    assert.equal(done.status, "acceptance");
    assert.equal(getTask(task.id).nudge_count, 0);
  });

  it("clears three execution nudges when a reviewer opens, then reminds once", async () => {
    let n = 0;
    const launcher = {
      async create() {
        n += 1;
        return { id: n === 1 ? "exec-nudge" : "review-nudge" };
      },
      async send() {},
    };
    const work = join(dir, "nudge-review");
    mkdirSync(work, { recursive: true });
    const task = createTask({ project: "sandbox", title: "Reset on review start", role: "executor", workspacePath: work });
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: executor, reason: "Executor" });
    getDb().prepare("UPDATE tasks SET nudge_count = 3 WHERE id = ?").run(task.id);
    const reviewed = completeTask(task.id, "executor", "Handoff", null);
    assert.ok(!(reviewed instanceof Promise));
    assert.equal(reviewed.status, "in_review");
    assert.equal(getTask(task.id).nudge_count, 0);

    getDb().prepare("UPDATE tasks SET nudge_count = 3 WHERE id = ?").run(task.id);
    await startTask(task.id, launcher, "test", { profiles: [executor, reviewer], chosen: reviewer, reason: "Reviewer" });
    const opened = getTask(task.id);
    assert.equal(opened.status, "reviewing");
    assert.equal(opened.agent_id, "review-nudge");
    assert.equal(opened.nudge_count, 0);

    const aged = new Date(Date.now() - 120_000).toISOString();
    getDb().prepare("UPDATE runs SET started_at = ? WHERE task_id = ? AND agent_id = ? AND ended_at IS NULL").run(aged, task.id, "review-nudge");
    const once = applyNudge(task.id, false);
    assert.equal(once.action, "remind");
    assert.equal(once.count, 1);
    const after = getTask(task.id);
    assert.equal(after.status, "reviewing");
    assert.equal(after.blocked_kind, null);
    assert.equal(after.nudge_count, 1);
  });

  it("clears the counter when rework opens a new executor", async () => {
    const work = join(dir, "nudge-rework");
    mkdirSync(work, { recursive: true });
    const task = createTask({ project: "sandbox", title: "New executor for rework", role: "executor", workspacePath: work });
    getDb().prepare("UPDATE tasks SET status = 'rework', nudge_count = 3, agent_id = NULL, executor_agent_id = NULL WHERE id = ?").run(task.id);
    await startTask(task.id, { async create() { return { id: "rework-exec" }; }, async send() {} }, "test", {
      profiles: [executor],
      chosen: executor,
      reason: "New sample",
    });
    const opened = getTask(task.id);
    assert.equal(opened.status, "running");
    assert.equal(opened.agent_id, "rework-exec");
    assert.equal(opened.nudge_count, 0);
  });

  it("does not count a turn that ends before the opening grace", async () => {
    assert.equal(loadConfig().nudgeGraceMs, DEFAULT_NUDGE_GRACE_MS);
    saveConfig({ ...loadConfig(), nudgeGraceMs: 45_000 });
    assert.equal(loadConfig().nudgeGraceMs, 45_000);

    const work = join(dir, "nudge-grace");
    mkdirSync(work, { recursive: true });
    const task = createTask({ project: "sandbox", title: "Just started", role: "executor", workspacePath: work });
    await startTask(task.id, { async create() { return { id: "grace-exec" }; }, async send() {} }, "test", {
      profiles: [executor],
      chosen: executor,
      reason: "Start",
    });
    const fresh = applyNudge(task.id, false, { lastUserMessageAt: null, graceMs: 60_000 });
    assert.equal(fresh.action, "none");
    assert.equal(getTask(task.id).nudge_count, 0);
    assert.equal(getTask(task.id).status, "running");

    const now = new Date().toISOString();
    const justStarted = applyNudge(task.id, false, { lastUserMessageAt: now, graceMs: 60_000 });
    assert.equal(justStarted.action, "none");
    assert.equal(getTask(task.id).nudge_count, 0);

    const aged = new Date(Date.now() - 120_000).toISOString();
    getDb().prepare("UPDATE runs SET started_at = ? WHERE task_id = ? AND agent_id = ? AND ended_at IS NULL").run(aged, task.id, "grace-exec");
    const reminded = applyNudge(task.id, false, { lastUserMessageAt: aged, graceMs: 60_000 });
    assert.equal(reminded.action, "remind");
    assert.equal(reminded.count, 1);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).blocked_kind, null);
  });

  it("does not count a turn when this agent wrote progress, and counts again after progressGraceMs", async () => {
    assert.equal(loadConfig().progressGraceMs, DEFAULT_PROGRESS_GRACE_MS);
    saveConfig({ ...loadConfig(), progressGraceMs: 30 * 60_000 });
    assert.equal(loadConfig().progressGraceMs, 30 * 60_000);
    const grace = 30 * 60_000;
    const now = Date.parse("2026-09-29T03:00:00.000Z");

    const task = createTask({ project: "sandbox", title: "Progress recorded", role: "decision" });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-progress", task.id);
    const token = issueToken("reader", task.id, "agent-progress");
    await handleTool("kanban_comment", { text: (zhCNPart("cardDrawer.pr.notAwaiting", 1, 3) + "Demo text") }, token);
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'comment'").run(new Date(now - 60_000).toISOString(), task.id);
    const comment = getDb().prepare("SELECT actor, kind FROM events WHERE task_id = ? AND kind = 'comment'").get(task.id) as {
      actor: string;
      kind: string;
    };
    assert.equal(comment.actor, "agent-progress");
    assert.equal(comment.kind, "comment");
    const covered = applyNudge(task.id, false, { nowMs: now, progressGraceMs: grace });
    assert.equal(covered.action, "none");
    assert.equal(covered.count, 0);
    assert.equal(getTask(task.id).nudge_count, 0);
    assert.equal(getTask(task.id).status, "running");
    const still = applyNudge(task.id, false, { nowMs: now + 10 * 60_000, progressGraceMs: grace });
    assert.equal(still.action, "none");
    assert.equal(getTask(task.id).nudge_count, 0);

    const plain = createTask({ project: "sandbox", title: "No progress recorded", role: "decision" });
    claimStatus(plain.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-plain", plain.id);
    addComment(plain.id, "reader", (zhCN("cardDrawer.comments.title") + "Demo text"));
    const missed = applyNudge(plain.id, false, { nowMs: now, progressGraceMs: grace });
    assert.equal(missed.action, "remind");
    assert.equal(missed.count, 1);
    assert.equal(getTask(plain.id).nudge_count, 1);

    const other = createTask({ project: "sandbox", title: "Another agent's progress", role: "decision" });
    claimStatus(other.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-other", other.id);
    appendEvent(other.id, "comment", null, "running", "stranger", {}, new Date(now - 60_000).toISOString());
    const ignored = applyNudge(other.id, false, { nowMs: now, progressGraceMs: grace });
    assert.equal(ignored.action, "remind");
    assert.equal(ignored.count, 1);

    const stale = createTask({ project: "sandbox", title: "Stale progress", role: "decision" });
    claimStatus(stale.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-stale", stale.id);
    appendEvent(stale.id, "comment", null, "running", "agent-stale", {}, new Date(now - grace - 1).toISOString());
    const resumed = applyNudge(stale.id, false, { nowMs: now, progressGraceMs: grace });
    assert.equal(resumed.action, "remind");
    assert.equal(resumed.count, 1);
    assert.equal(getTask(stale.id).nudge_count, 1);

    appendEvent(stale.id, "comment", null, "running", "agent-stale", {}, new Date(now + 60_000).toISOString());
    const again = applyNudge(stale.id, false, { nowMs: now + 2 * 60_000, progressGraceMs: grace });
    assert.equal(again.action, "none");
    assert.equal(getTask(stale.id).nudge_count, 1);

    const expired = applyNudge(stale.id, false, { nowMs: now + 32 * 60_000, progressGraceMs: grace });
    assert.equal(expired.action, "remind");
    assert.equal(expired.count, 2);
    assert.equal(getTask(stale.id).status, "running");
    assert.equal(getTask(stale.id).blocked_kind, null);
  });

  it("counts one nudge across three short turns, then hands off after the interval", () => {
    const task = createTask({ project: "sandbox", title: "Reminder interval", role: "executor" });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-burst", task.id);
    const start = Date.parse("2026-09-30T15:47:52.000Z");
    const interval = 10 * 60_000;
    const first = applyNudge(task.id, false, { nowMs: start });
    const second = applyNudge(task.id, false, { nowMs: start + 3_000 });
    const third = applyNudge(task.id, false, { nowMs: start + 7_000 });
    assert.equal(first.action, "remind");
    assert.equal(first.count, 1);
    assert.equal(second.action, "none");
    assert.equal(second.count, 1);
    assert.equal(third.action, "none");
    assert.equal(third.count, 1);
    assert.equal(getTask(task.id).nudge_count, 1);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).blocked_kind, null);
    const nudges = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'nudge'").get(task.id) as { n: number };
    assert.equal(nudges.n, 1);

    const early = applyNudge(task.id, false, { nowMs: start + interval - 1 });
    assert.equal(early.action, "none");
    assert.equal(early.count, 1);
    const later = applyNudge(task.id, false, { nowMs: start + interval });
    assert.equal(later.action, "handoff");
    assert.equal(getTask(task.id).status, "in_review");
    assert.equal(getTask(task.id).blocked_kind, null);
    const blocked = applyNudge(task.id, false, { nowMs: start + 2 * interval });
    assert.equal(blocked.action, "none");
    assert.equal(getTask(task.id).status, "in_review");
  });

  it("counts Read and Bash turns that never call a finish tool, and skips only a still-running sub-agent", () => {
    const task = createTask({ project: "sandbox", title: "Finished but forgot completion", role: "executor" });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-tools", task.id);
    const start = Date.parse("2026-09-30T16:00:00.000Z");
    const interval = 10 * 60_000;
    const tools = [
      { type: "tool_call", name: "Read", status: "completed", detail: { type: "read", filePath: "server/flow.ts" } },
      { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "npm test" } },
    ];
    const at = (offset: number, timeline: unknown[]) => {
      const clock: Parameters<typeof applyNudge>[2] = { nowMs: start + offset };
      Object.assign(clock, { timeline });
      return applyNudge(task.id, false, clock);
    };
    const first = at(0, tools);
    assert.equal(first.action, "remind");
    assert.equal(first.count, 1);
    const second = at(interval, tools);
    assert.equal(second.action, "handoff");
    assert.equal(getTask(task.id).status, "in_review");
    assert.equal(getTask(task.id).blocked_kind, null);
    const third = at(2 * interval, tools);
    assert.equal(third.action, "none");
    assert.equal(getTask(task.id).status, "in_review");

    const open = createTask({ project: "sandbox", title: "Subtask still running", role: "decision" });
    claimStatus(open.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-child", open.id);
    const childAt = (offset: number, timeline: unknown[]) => {
      const clock: Parameters<typeof applyNudge>[2] = { nowMs: start + offset };
      Object.assign(clock, { timeline });
      return applyNudge(open.id, false, clock);
    };
    assert.equal(childAt(0, []).count, 1);
    const running = childAt(interval, [
      { type: "tool_call", name: "Task", status: "running", callId: "child", detail: { type: "sub_agent", description: "Rerun subtask", log: "" } },
    ]);
    assert.equal(running.action, "none");
    assert.equal(running.count, 1);
    assert.equal(getTask(open.id).status, "running");
    const done = childAt(2 * interval, [
      { type: "tool_call", name: "Task", status: "completed", callId: "child", detail: { type: "sub_agent", log: "" } },
    ]);
    assert.equal(done.action, "remind");
    assert.equal(done.count, 2);
  });

  it("clears nudge_count when unblocking back to the same running agent", () => {
    const root = process.env.KANBAN_AGENTS_DIR ?? "";
    mkdirSync(join(root, "bucket"), { recursive: true });
    writeFileSync(join(root, "bucket", "agent-back.json"), JSON.stringify({ id: "agent-back", cwd: dir, archivedAt: null, lastStatus: "idle" }));
    const task = createTask({ project: "sandbox", title: "Reset after unblocking", role: "executor" });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ?, nudge_count = 3 WHERE id = ?").run("agent-back", task.id);
    blockTask(task.id, "needs_human", zhCN("flow.nudge.blocked"), "test");
    const restored = unblockTask(task.id, "supervisor");
    assert.equal(restored.status, "running");
    assert.equal(restored.agent_id, "agent-back");
    assert.equal(restored.nudge_count, 0);
    assert.equal(getTask(task.id).nudge_count, 0);

    getDb().prepare("UPDATE tasks SET nudge_count = 0 WHERE id = ?").run(task.id);
    blockTask(task.id, "needs_human", "Block again", "test");
    const again = unblockTask(task.id, "supervisor");
    assert.equal(again.status, "running");
    assert.equal(again.agent_id, "agent-back");
    assert.equal(again.nudge_count, 0);
  });

  it("returns a blocked running card to ready when the agent is archived, missing, or purged", () => {
    const root = process.env.KANBAN_AGENTS_DIR ?? "";
    mkdirSync(join(root, "bucket"), { recursive: true });
    const write = (id: string, archivedAt: string | null) => {
      writeFileSync(
        join(root, "bucket", `${id}.json`),
        JSON.stringify({ id, cwd: dir, archivedAt, lastStatus: "idle" }),
      );
    };
    const blockRunning = (title: string, agentId: string) => {
      const task = createTask({ project: "sandbox", title, role: "executor" });
      claimStatus(task.id, "ready", "running", "test");
      getDb().prepare("UPDATE tasks SET agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, task.id);
      getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'executor', ?)").run(task.id, agentId, new Date().toISOString());
      blockTask(task.id, "needs_human", zhCN("cardParts.event.fused"), "test");
      return task.id;
    };

    write("agent-archived", "2026-09-30T00:00:00.000Z");
    const archived = blockRunning(zhCN("missingCwd.report.isArchived"), "agent-archived");
    const afterArchived = unblockTask(archived, "supervisor");
    assert.equal(afterArchived.status, "ready");
    assert.equal(afterArchived.agent_id, null);
    assert.equal(afterArchived.executor_agent_id, "agent-archived");
    const archivedEvent = getDb().prepare("SELECT to_status, data_json FROM events WHERE task_id = ? AND kind = 'unblocked'").get(archived) as {
      to_status: string;
      data_json: string;
    };
    assert.equal(archivedEvent.to_status, "ready");
    const archivedData = JSON.parse(archivedEvent.data_json) as { reason?: string; note?: string };
    assert.equal(archivedData.reason, "agent_archived");
    assert.match(archivedData.note ?? "", new RegExp(zhCN("labels.status.archived")));
    const archivedRun = getDb().prepare("SELECT end_kind FROM runs WHERE task_id = ?").get(archived) as { end_kind: string };
    assert.equal(archivedRun.end_kind, "unblocked");

    const missing = blockRunning(zhCNPart("nativeSessions.uncarded.recordGone", 8, 11), "agent-missing");
    const afterMissing = unblockTask(missing, "supervisor");
    assert.equal(afterMissing.status, "ready");
    assert.equal(afterMissing.agent_id, null);
    const missingData = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'unblocked'").get(missing) as { data_json: string }).data_json,
    ) as { reason?: string; note?: string };
    assert.equal(missingData.reason, "agent_gone");
    assert.match(missingData.note ?? "", new RegExp(localePattern(zhCNPart("cleanup.reason.gone", 2, 4))));

    write("agent-purged", null);
    const purged = blockRunning(zhCN("compactEvents.verb.deleted"), "agent-purged");
    appendEvent(purged, "agent_purged", null, null, "kanban", { agentId: "agent-purged" });
    const afterPurged = unblockTask(purged, "supervisor");
    assert.equal(afterPurged.status, "ready");
    assert.equal(afterPurged.agent_id, null);
    const purgedData = JSON.parse(
      (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'unblocked'").get(purged) as { data_json: string }).data_json,
    ) as { reason?: string };
    assert.equal(purgedData.reason, "agent_purged");

    write("agent-garbled", null);
    writeFileSync(join(root, "bucket", "agent-garbled.json"), "{");
    const garbled = blockRunning(zhCNPart("doctor.matrix.unknown", 4, 7), "agent-garbled");
    const afterGarbled = unblockTask(garbled, "supervisor");
    assert.equal(afterGarbled.status, "running");
    assert.equal(afterGarbled.agent_id, "agent-garbled");

    write("agent-reviewer", "2026-09-30T00:00:00.000Z");
    const reviewing = createTask({ project: "sandbox", title: "Reviewer archived", role: "executor" });
    claimStatus(reviewing.id, "ready", "running", "test");
    claimStatus(reviewing.id, "running", "in_review", "test");
    claimStatus(reviewing.id, "in_review", "reviewing", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-reviewer", reviewing.id);
    blockTask(reviewing.id, "needs_human", (zhCN("labels.role.reviewer") + zhCN("cardParts.event.fused")), "test");
    const afterReview = unblockTask(reviewing.id, "supervisor");
    assert.equal(afterReview.status, "ready");
    assert.equal(afterReview.agent_id, null);
  });

  it("returns to ready when the agent root directory does not exist, and keeps the card when that path cannot be listed", () => {
    const previous = process.env.KANBAN_AGENTS_DIR;
    const blockRunning = (title: string, agentId: string) => {
      const task = createTask({ project: "sandbox", title, role: "executor" });
      claimStatus(task.id, "ready", "running", "test");
      getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(agentId, task.id);
      blockTask(task.id, "needs_human", zhCN("cardParts.event.fused"), "test");
      return task.id;
    };
    const missingRoot = join(dir, "agents-root-missing");
    const gone = blockRunning((zhCNPart("nativeAgentIndex.error.rootSymlink", 6, 9) + zhCN("missingCwd.report.missing")), "gone-agent");
    process.env.KANBAN_AGENTS_DIR = missingRoot;
    try {
      const restored = unblockTask(gone, "supervisor");
      assert.equal(restored.status, "ready");
      assert.equal(restored.agent_id, null);
      const data = JSON.parse(
        (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'unblocked'").get(gone) as { data_json: string }).data_json,
      ) as { reason?: string };
      assert.equal(data.reason, "agent_gone");
    } finally {
      if (previous === undefined) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = previous;
    }

    const notDir = join(dir, "agents-root-not-a-directory");
    writeFileSync(notDir, "not a directory\n");
    const kept = blockRunning((zhCNPart("nativeAgentIndex.error.rootSymlink", 6, 9) + zhCNPart("settings.candidates.unavailable", 0, 3)), "kept-agent");
    process.env.KANBAN_AGENTS_DIR = notDir;
    try {
      const restored = unblockTask(kept, "supervisor");
      assert.equal(restored.status, "running");
      assert.equal(restored.agent_id, "kept-agent");
    } finally {
      if (previous === undefined) delete process.env.KANBAN_AGENTS_DIR;
      else process.env.KANBAN_AGENTS_DIR = previous;
    }
  });
});
