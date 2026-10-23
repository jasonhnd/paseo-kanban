/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { agentsMarkedForRelease } from "../server/archive-book";
import { kanbanHelp, runKanban } from "../server/cli";
import { loadConfig, saveConfig, setProjectWorkspace } from "../server/config";
import { flushCleanups, installCleanup } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import { latestChangeNote, conflictReviewNote, leaderReworkTask } from "../server/flow";
import type { AgentPresence } from "../server/presence";
import { canonicalKanbanTool } from "../server/permissions";
import type { Profile } from "../server/profiles";
import { appendEvent, createTask, getTask, requestAgentReleases, setReleaseListener, setFinishedListener } from "../server/store";
import { issueToken } from "../server/tokens";
import { handleTool, toolDefs } from "../server/tools";

const dir = mkdtempSync(join(tmpdir(), "leader-decision-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
saveConfig({ ...loadConfig(), supervisorAgentId: "kanban-leader", supervisors: { adjudicate: "project-leader", other: "other-leader" } });
const leader = { PASEO_AGENT_ID: "project-leader" };
const identity = { role: "supervisor", taskId: null, agentId: "project-leader" };
const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "alternate", model: "grok-4.7", pool: "alternate" };
const reviewer: Profile = { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };

function card(status = "blocked", round = 3) {
  const cwd = join(dir, `room-${getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n}`);
  mkdirSync(cwd, { recursive: true });
  const task = createTask({ project: "adjudicate", title: "demo fixture", role: "executor", workspacePath: cwd, brief: "Original goal", createdByAgent: "other-leader" });
  getDb().prepare(("UPDATE tasks SET status = ?, executor_agent_id = ?, agent_id = ?, review_round = ?,\n    blocked_kind = 'needs_human', blocked_reason = '" + zhCNPart("flow.comment.round3", 0, 5) + "', blocked_from = 'reviewing', blocked_at = 'before',\n    hold_reason = 'Wait for ruling', cooldown_until = 'later', nudge_count = 3, handoff_json = ? WHERE id = ?"))
    .run(status, `ex-${task.id}`, `rv-${task.id}`, round, "{\"summary\":\"Old handoff\"}", task.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, ?, 'reviewer', ?)").run(task.id, `rv-${task.id}`, new Date().toISOString());
  return getTask(task.id);
}
function presence(value: AgentPresence) { return { agentPresence: () => value }; }
function clearHolds(id: number) {
  const task = getTask(id);
  for (const name of ["blocked_kind", "blocked_reason", "blocked_from", "blocked_at", "hold_reason", "cooldown_until"] as const) assert.equal(task[name], null);
  assert.equal(task.nudge_count, 0);
}
function event(id: number, kind: string) {
  const row = getDb().prepare("SELECT from_status, to_status, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(id, kind) as { from_status: string; to_status: string; data_json: string };
  return { ...row, data: JSON.parse(row.data_json) };
}

after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe("leader adjudication", () => {
  it("documents CLI and MCP contracts", async () => {
    assert.match(kanbanHelp(), new RegExp("rework <" + localePattern(zhCNPart("taskCreate.error.noTag", 22, 28)) + "reason"));
    assert.match(kanbanHelp(), new RegExp("pass <" + localePattern(zhCNPart("taskCreate.error.noTag", 22, 28)) + "note"));
    assert.match(kanbanHelp(), /--count-round/);
    assert.deepEqual(toolDefs().find(t => t.name === "kanban_rework")?.inputSchema.required, ["id", "reason"]);
    assert.deepEqual(toolDefs().find(t => t.name === "kanban_pass")?.inputSchema.required, ["id", "note"]);
    assert.equal(canonicalKanbanTool("mcp__kanban__kanban_rework"), "kanban_rework");
    assert.equal(canonicalKanbanTool("kanban-kanban_pass"), "kanban_pass");
    const task = card();
    assert.equal(await runKanban(["rework", String(task.id), "--help"], leader), kanbanHelp());
    assert.equal(getTask(task.id).status, "blocked");
  });

  for (const status of ["blocked", "acceptance", "reviewing", "in_review", "rework"]) {
    it(`returns ${status} to its living executor without counting a round`, async () => {
      const task = card(status);
      const result = await runKanban(["rework", String(task.id), "--reason", "Add permission tests"], leader, presence("idle")) as typeof task;
      assert.equal(result.status, "rework");
      assert.equal(result.agent_id, task.executor_agent_id);
      assert.equal(result.executor_agent_id, task.executor_agent_id);
      assert.equal(result.review_round, 3);
      assert.equal(result.brief, "Original goal");
      assert.equal(result.handoff_json, task.handoff_json);
      clearHolds(task.id);
      const recorded = event(task.id, "leader_rework");
      assert.equal(recorded.from_status, status);
      assert.equal(recorded.to_status, "rework");
      assert.equal(recorded.data.reason, "Add permission tests");
      assert.equal(recorded.data.countRound, false);
      assert.equal(recorded.data.fromStatus, status);
    });
  }

  it("counts only --count-round, even past the third-round fuse, and honors --agent", async () => {
    const task = card();
    const result = await runKanban(["rework", String(task.id), "--reason", (zhCNPart("wake.blocked.needsHuman", 9, 11) + zhCNPart("cardParts.event.tierChanged", 0, 1)), "--agent", "chosen-executor", "--count-round"], leader, presence("running")) as typeof task;
    assert.equal(result.status, "rework");
    assert.equal(result.review_round, 4);
    assert.equal(result.agent_id, "chosen-executor");
    assert.equal(result.executor_agent_id, "chosen-executor");
    assert.equal(event(task.id, "leader_rework").data.countRound, true);
  });

  for (const state of ["missing", "archived", "closed"] as const) {
    it(`requeues when the executor is ${state}, appends this round and retains its workspace`, async () => {
      const task = card();
      getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree', paseo_workspace_id = 'old-ws' WHERE id = ?").run(task.id);
      appendEvent(task.id, "temp_workspace", null, null, "test", { directory: task.workspace_path });
      const result = await handleTool("kanban_rework", { id: task.id, reason: "Fix conflicting section" }, null, identity, presence(state)) as typeof task;
      assert.equal(result.status, "ready");
      assert.equal(result.agent_id, null);
      assert.equal(result.executor_agent_id, null);
      assert.equal(result.workspace_path, task.workspace_path);
      assert.equal(result.paseo_workspace_id, "old-ws");
      assert.equal(result.review_round, 3);
      assert.equal(result.brief, ("Original goal" + "\n\n## " + zhCNPart("flow.brief.thisRound", 3, 11) + "\nFix conflicting section\n"));
      assert.equal(result.handoff_json, task.handoff_json);
      clearHolds(task.id);
    });
  }

  it("does not treat an unknown presence as proof of departure", async () => {
    const task = card();
    await runKanban(["rework", String(task.id), "--reason", zhCNPart("wake.blocked.needsHuman", 9, 11)], leader, presence("unknown"));
    assert.equal(getTask(task.id).status, "rework");
    assert.equal(getTask(task.id).executor_agent_id, task.executor_agent_id);
  });

  it("sends the adjudicated reason through the resume path despite a newer comment or old conflict", async () => {
    const task = card();
    appendEvent(task.id, "land_conflict", "acceptance", "rework", "test", { reason: "Old conflict" });
    requestAgentReleases(task.id, [{ agentId: task.executor_agent_id!, role: "executor" }]);
    await runKanban(["rework", String(task.id), "--reason", (zhCNPart("cardDrawer.handoff.title", 0, 2) + zhCNPart("boardView.cmd.ruling", 1, 3))], leader, presence("idle"));
    assert.ok(!agentsMarkedForRelease(task.id).includes(task.executor_agent_id!));
    await handleTool("kanban_comment", { id: task.id, text: "Later status comment" }, null, identity);
    assert.equal(latestChangeNote(task.id), (zhCNPart("cardDrawer.handoff.title", 0, 2) + zhCNPart("boardView.cmd.ruling", 1, 3)));
    assert.equal(conflictReviewNote(task.id), null);
    const sent: string[] = [];
    await startTask(task.id, { async create() { throw new Error("should resume"); }, async send(id, text) { sent.push(`${id}:${text}`); } }, "scheduler");
    assert.equal(getTask(task.id).status, "running");
    assert.match(sent[0], new RegExp(zhCN("cardDrawer.verdict.leaderRework", {"leader":"^ex-\\d+:<leader>"})));
    assert.match(sent[0], new RegExp(localePattern(zhCNPart("cardDrawer.handoff.title", 0, 2)) + localePattern(zhCNPart("boardView.cmd.ruling", 1, 3))));
    assert.doesNotMatch(sent[0], new RegExp("Later status comment|Old conflict"));
    const token = issueToken("reviewer", task.id, `rv-${task.id}`);
    await assert.rejects(() => handleTool("kanban_approve", { id: task.id, summary: "Old review" }, token), new RegExp(localePattern(zhCNPart("tools.tokenNotCardAgent", 14, 21))));
  });

  it("starts the replacement executor off the main workspace rather than reviewing the old handoff", async () => {
    const task = card();
    setProjectWorkspace("adjudicate", { alwaysTemp: true });
    await runKanban(["rework", String(task.id), "--reason", (zhCNPart("nativeSessions.uncarded.seen", 6, 8) + zhCNPart("reviewHold.next.check", 17, 19))], leader, presence("missing"));
    const copy = join(dir, `copy-${task.id}`);
    mkdirSync(copy);
    mkdirSync(join(copy, ".git"));
    const main = {
      id: "main-ws", name: "<leader>", directory: task.workspace_path, projectRoot: task.workspace_path,
      projectId: "adjudicate", kind: "local_checkout", archived: false,
    };
    const opened: Array<{ cwd: string; workspaceId?: string; prompt?: string }> = [];
    const archived: string[] = [];
    let copyCreated = false;
    const launcher: AgentLauncher = {
      async listWorkspaces() { return [main, ...(copyCreated ? [{ ...main, id: "copy-ws", directory: copy, kind: "worktree" }] : [])]; },
      async create(options) { opened.push(options); return { id: "new-executor", workspaceId: options.workspaceId ?? main.id }; },
      async send() { throw new Error("missing executor must not resume"); },
      async archiveAgent(id) { archived.push(id); },
      async createWorktree() { copyCreated = true; return { directory: copy, workspaceId: "copy-ws", name: "copy" }; },
    };
    await startTask(task.id, launcher, "scheduler", { chosen: executor, profiles: [executor, reviewer], reason: "test" });
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).executor_agent_id, "new-executor");
    assert.deepEqual(archived, []);
    assert.equal(opened[0].cwd, copy);
    assert.equal(opened[0].workspaceId, "copy-ws");
    assert.match(opened[0].prompt!, new RegExp(localePattern(zhCNPart("flow.brief.thisRound", 3, 11)) + "\\n" + localePattern(zhCNPart("nativeSessions.uncarded.seen", 6, 8)) + localePattern(zhCNPart("reviewHold.next.check", 17, 19))));
  });

  for (const status of ["blocked", "reviewing", "in_review", "rework"]) {
    it(`passes ${status} to acceptance and keeps its round and handoff`, async () => {
      const task = card(status);
      const result = await runKanban(["pass", String(task.id), "--note", (zhCNPart("doctor.ambiguous.suggestion", 44, 46) + "Demo text")], leader) as typeof task;
      assert.equal(result.status, "acceptance");
      assert.equal(result.review_round, 3);
      assert.equal(result.handoff_json, task.handoff_json);
      assert.equal(event(task.id, "leader_pass").data.note, (zhCNPart("doctor.ambiguous.suggestion", 44, 46) + "Demo text"));
      assert.equal(event(task.id, "leader_pass").from_status, status);
      clearHolds(task.id);
    });
  }

  it("rejects workers, another project's leader, and an unregistered creator on CLI and MCP", async () => {
    const task = card();
    const token = issueToken("executor", task.id, task.executor_agent_id!);
    for (const [cmd, flag, tool] of [["rework", "--reason", "kanban_rework"], ["pass", "--note", "kanban_pass"]]) {
      await assert.rejects(() => runKanban([cmd, String(task.id), flag, zhCNPart("boardView.cmd.reason", 1, 3)], { KANBAN_TOKEN: token }, presence("idle")), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
      await assert.rejects(() => handleTool(tool, { id: task.id, reason: "demo fixture", note: "demo fixture" }, token), new RegExp(localePattern(zhCNPart("cli.onlyLeader.rebind", 0, 10))));
      await assert.rejects(() => runKanban([cmd, String(task.id), flag, zhCNPart("boardView.cmd.reason", 1, 3)], { PASEO_AGENT_ID: "other-leader" }, presence("idle")), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
      await assert.rejects(() => handleTool(tool, { id: task.id, reason: "demo fixture", note: "demo fixture" }, null, { ...identity, agentId: "other-leader" }), new RegExp(localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    }
    assert.equal(getTask(task.id).status, "blocked");
  });

  it("allows the Kanban leader to adjudicate across projects using MCP", async () => {
    const task = card();
    const boss = { ...identity, agentId: "kanban-leader" };
    await handleTool("kanban_rework", { id: task.id, reason: "Fallback ruling", countRound: true }, null, boss, presence("missing"));
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(getTask(task.id).review_round, 4);
    const second = card();
    await handleTool("kanban_pass", { id: second.id, note: "Fallback pass" }, null, boss);
    assert.equal(getTask(second.id).status, "acceptance");
  });

  it("rejects missing text and illegal states without mutation", async () => {
    for (const cmd of ["rework", "pass"]) {
      const task = card();
      await assert.rejects(() => runKanban([cmd, String(task.id)], leader, presence("idle")), new RegExp(localePattern(zhCNPart("config.emptyProject", 2, 6))));
      assert.equal(getTask(task.id).status, "blocked");
      const running = card("running");
      await assert.rejects(() => runKanban([cmd, String(running.id), cmd === "pass" ? "--note" : "--reason", zhCNPart("boardView.cmd.reason", 1, 3)], leader, presence("idle")), new RegExp(localePattern(zhCNPart("flow.error.cannotReject", 0, 3))));
      assert.equal(getTask(running.id).status, "running");
    }
  });

  it("does not overwrite a concurrent pass while checking executor presence", async () => {
    const task = card();
    await assert.rejects(() => leaderReworkTask(task.id, "Old ruling", { presence: async () => {
      await handleTool("kanban_pass", { id: task.id, note: "Sample text" }, null, identity);
      return "idle" as const;
    } }), new RegExp(localePattern(zhCNPart("flow.error.statusChanged", 11, 17))));
    assert.equal(getTask(task.id).status, "acceptance");
  });

  it("sends a done card with a land conflict back to its kept directory, and refuses a plain done card", async () => {
    const task = card("done");
    await assert.rejects(() => leaderReworkTask(task.id, "x", { presence: async () => "idle" as const }), new RegExp(zhCN("flow.error.cannotRuleRework", {"status":zhCN("labels.status.done")})));
    appendEvent(task.id, "land_pending", null, "done", "test", { reason: "conflict", branch: "kanban/x", base: "main", conflict: true, files: ["a.ts"] });
    const before = getTask(task.id);
    const out = await leaderReworkTask(task.id, zhCNPart("boardView.done.conflictChoice", 10, 17), { presence: async () => "idle" as const });
    assert.equal(out.status, "rework");
    assert.equal(out.workspace_path, before.workspace_path);
    assert.equal(out.review_round, before.review_round);
  });

  it("preserves the embedded executor token for pass followed by immediate rework", async () => {
    const task = card();
    const token = issueToken("executor", task.id, task.executor_agent_id!);
    await runKanban(["pass", String(task.id), "--note", "Submit for acceptance first"], leader);
    await runKanban(["rework", String(task.id), "--reason", (zhCNPart("tempWorkspace.branch.keptAfterRetriesComment", 32, 34) + "Demo text")], leader, presence("idle"));
    await startTask(task.id, { async create() { throw new Error("should resume"); }, async send() {} }, "scheduler");
    await handleTool("kanban_complete", { id: task.id, summary: "Completed addition", handoff: {} }, token);
    assert.equal(getTask(task.id).status, "in_review");
  });

  it("cancels executor release even when cleanup is awaiting its activity", async () => {
    const task = card("acceptance");
    let checked!: () => void;
    const checking = new Promise<void>(resolve => { checked = resolve; });
    let finishInspect!: () => void;
    const resume = new Promise<void>(resolve => { finishInspect = resolve; });
    const archived: string[] = [];
    installCleanup({
      async inspectAgent(id) {
        if (id === task.executor_agent_id) { checked(); await resume; }
        return { archived: false, busy: false };
      },
      async archiveAgent(id) { archived.push(id); },
      async archiveWorkspace() { throw new Error("nonterminal workspace must stay"); },
      async listAgents() { return []; },
      async inspectWorkspace() { return null; },
    });
    try {
      requestAgentReleases(task.id, [{ agentId: task.executor_agent_id!, role: "executor" }]);
      await checking;
      await runKanban(["rework", String(task.id), "--reason", (zhCNPart("wake.blocked.needsHuman", 9, 11) + zhCN("labels.status.rework"))], leader, presence("idle"));
      finishInspect();
      await flushCleanups();
      assert.ok(!archived.includes(task.executor_agent_id!));
      assert.ok(archived.includes(task.agent_id!));
      assert.equal(getTask(task.id).status, "rework");
    } finally {
      finishInspect();
      await flushCleanups();
      setReleaseListener(null);
      setFinishedListener(null);
    }
  });
});
