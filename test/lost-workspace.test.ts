/// <reference types="node" />
// Issue 3, problem 1: a host-archived card workspace must not leave the card running,
// and a registered leader must be able to hand in for the disappeared agent.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runKanban } from "../server/cli";
import { saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { AgentLauncher } from "../server/dispatch";
import { KanbanError } from "../server/errors";
import { completeTask, leaderReworkTask, pendingReworkReplacement, pollAwaitingPr } from "../server/flow";
import { startTask } from "./helpers/compat-dispatch";
import { acquireStartClaim, releaseStartClaim } from "../server/start-claim";
import { reclaimTask } from "../server/failures";
import { MISSING_CONFIRM_MS, resetReconcileForTests } from "../server/schedule";
import { appendEvent, blockTask, claimStatus, createTask, getTask, openExecutorRun, unblockTask } from "../server/store";
import { readContract, resetCheckCache, setGhRunner, type GhRunner } from "../server/pr";
import { issueToken, type Identity } from "../server/tokens";
import { handleTool } from "../server/tools";
import { protocolFor } from "../server/protocol";
import type { ListedWorkspace } from "../server/placement";
import { openEntry, type PoolSnapshot } from "../server/pools";
import { runTick } from "./helpers/compat-schedule";
import { setLanguage } from "../shared/i18n";

const LOST = "workspace \u88ab\u5bbf\u4e3b\u5f52\u6863/agent \u4e22\u5931";
const NO_CHECKOUT = "\u4e0d\u8981\u5728\u672c\u5361\u7684\u4e34\u65f6 worktree \u91cc\u628a PR \u7684 head \u5206\u652f checkout \u6210\u5f53\u524d\u5206\u652f";
const SEPARATE_REF = "\u7528\u72ec\u7acb\u7684\u672c\u5730\u5206\u652f\u6216 ref \u63a8\u9001";
const MERGE_WITHOUT_CHECKOUT = "\u6216\u8005\u76f4\u63a5 gh pr merge\uff0c\u4e0d\u8981 checkout head";
const ON_BEHALF_ZH = "\u4ee3\u4ea4";
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff01-\uff5e]/;
const EN_RULE = "do not check out the PR head branch as the current branch in this card's temporary worktree";
const EN_PUSH = "Push from a separate local branch or ref, or run gh pr merge without checking out the head";

const start = new Date("2026-10-01T08:45:00.000Z");
const pools: PoolSnapshot = {
  state: "fresh",
  message: "",
  generatedAt: start.toISOString(),
  dispatchable: () => true,
  entry: () => openEntry(),
  hasPool: () => true,
};
const kanbanLeader = "kanban-leader";
const projectLeader = "project-leader";
const otherLeader = "other-project-leader";
let dir: string;
let config: KanbanConfig;

function catalog(language: "en" | "zh-CN"): Record<string, string> {
  return JSON.parse(readFileSync(new URL(`../shared/locales/${language}.json`, import.meta.url), "utf8")) as Record<string, string>;
}

function protocolFile(language: "en" | "zh-CN", name: string): string {
  return readFileSync(new URL(`../server/protocol/${language}/${name}.md`, import.meta.url), "utf8");
}

function events(id: number, kind: string): Array<Record<string, unknown>> {
  return (getDb().prepare("SELECT actor, data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ actor: string; data_json: string }>).map((row) => ({
    actor: row.actor,
    ...(JSON.parse(row.data_json) as Record<string, unknown>),
  }));
}

function ws(id: string, archived: boolean): ListedWorkspace {
  return { id, name: null, directory: dir, projectRoot: null, projectId: null, kind: "worktree", archived };
}

function board(options: {
  list?: ListedWorkspace[] | Error;
  inspect?: ListedWorkspace | null | Error;
  agent?: { archived: boolean } | null | Error;
} = {}): AgentLauncher {
  const launcher: AgentLauncher = {
    async create() { return { id: "new-agent" }; },
    async send() {},
  };
  if (options.list instanceof Error) launcher.listWorkspaces = async () => { throw options.list; };
  else if (options.list) launcher.listWorkspaces = async () => options.list as ListedWorkspace[];
  if (options.inspect instanceof Error) launcher.inspectWorkspace = async () => { throw options.inspect; };
  else if ("inspect" in options) launcher.inspectWorkspace = async () => options.inspect as ListedWorkspace | null;
  if (options.agent instanceof Error) launcher.inspectAgent = async () => { throw options.agent; };
  else if ("agent" in options) launcher.inspectAgent = async () => options.agent as { archived: boolean } | null;
  return launcher;
}

function runningCard(role = "executor", status = role === "reviewer" ? "reviewing" : "running") {
  const task = createTask({ project: "live", title: "Lost workspace", role, workspacePath: dir, createdByAgent: "creator-agent" });
  getDb().prepare("UPDATE tasks SET status = ?, agent_id = 'old-agent', executor_agent_id = 'old-agent', updated_at = ? WHERE id = ?")
    .run(status, start.toISOString(), task.id);
  getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, 'old-agent', ?, ?)")
    .run(task.id, role, start.toISOString());
  return task;
}

function bind(id: number, workspaceId: string | null): void {
  getDb().prepare("UPDATE tasks SET paseo_workspace_id = ? WHERE id = ?").run(workspaceId, id);
}

function tick(launcher: AgentLauncher, elapsed = 0, agentState: (agentId: string | null) => "alive" | "missing" | "archived" = () => "alive") {
  return runTick({
    now: new Date(start.getTime() + elapsed),
    config,
    pools,
    matrix: { state: "missing" },
    profiles: [],
    launcher,
    agentState,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lost-workspace-"));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  process.env.KANBAN_DISPATCH_MATRIX = join(dir, "missing-matrix.json");
  setLanguage("zh-CN");
  resetReconcileForTests();
  config = {
    autoStart: { live: false },
    supervisors: { live: projectLeader, other: otherLeader },
    supervisorAgentId: kanbanLeader,
    concurrency: { global: 50, pools: {}, roles: {} },
    archiveTimeoutMs: 15,
  };
  saveConfig(config);
});

afterEach(() => {
  setGhRunner(null);
  closeDb();
  delete process.env.KANBAN_AGENTS_DIR;
  delete process.env.KANBAN_DISPATCH_MATRIX;
  rmSync(dir, { recursive: true, force: true });
});

describe("executor and batch rules forbid checking out a PR head", () => {
  it("tells both roles, in both languages, to push from another ref or merge without checkout", () => {
    for (const role of ["executor", "batch"] as const) {
      const english = protocolFor(role, { language: "en", worktree: role === "executor" });
      assert.equal(CJK.test(english), false);
      assert.match(english, new RegExp(EN_RULE));
      assert.match(english, new RegExp(EN_PUSH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(english, /switch back to this card's branch before gh pr merge/);
      const chinese = protocolFor(role, { language: "zh-CN", worktree: role === "executor" });
      assert.ok(chinese.includes(NO_CHECKOUT));
      assert.ok(chinese.includes(SEPARATE_REF));
      assert.ok(chinese.includes(MERGE_WITHOUT_CHECKOUT));
    }
    assert.ok(protocolFile("en", "cli-help").includes("--on-behalf"));
    assert.ok(protocolFile("en", "cli-help").includes("supervisorAgentId"));
    assert.ok(protocolFile("en", "cli-help").includes("onBehalf"));
    assert.equal(CJK.test(protocolFile("en", "cli-help")), false);
    assert.ok(protocolFile("zh-CN", "cli-help").includes("--on-behalf"));
    assert.ok(protocolFile("zh-CN", "cli-help").includes("supervisorAgentId"));
    assert.ok(protocolFile("zh-CN", "cli-help").includes(ON_BEHALF_ZH));
  });
});

describe("reconcile blocks a card whose bound workspace is gone", () => {
  async function startupCard() {
    const cwd = join(dir, 'startup-copy');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const task = createTask({ project: 'live', title: 'Rework startup', role: 'executor', workspacePath: cwd });
    getDb().prepare("UPDATE tasks SET status = 'acceptance', workspace_kind = 'worktree', executor_agent_id = 'departed' WHERE id = ?").run(task.id);
    appendEvent(task.id, 'worktree_created', null, null, 'test', {
      directory: cwd, root: dir, workspaceId: 'ws-startup', branch: `kanban/${task.id}-startup`, base: 'main', temp: true,
    });
    await leaderReworkTask(task.id, 'Fix archive startup', { presence: () => 'archived' });
    let archived = false;
    let generation = '';
    let creates = 0;
    const proof = { archived: true, busy: false, workspaceId: 'ws-startup', merged: true,
      timelineComplete: true, toolCalls: 0, pullRequestUrl: 'https://github.com/o/r/pull/22' };
    const launcher: AgentLauncher = {
      async send() {},
      async create(options) { generation = options.labels?.kanban_start_generation ?? ''; return { id: `startup-${++creates}`, workspaceId: 'ws-startup' }; },
      async listWorkspaces() { return [{ ...ws('ws-startup', archived), directory: cwd, projectRoot: dir, kind: 'worktree' }]; },
      async inspectStartup() { return { ...proof, generation }; },
    };
    const profile = { id: 'ex', name: 'Demo executor', role: 'executor', provider: 'codex', model: 'demo', family: 'openai' };
    const startAgain = () => startTask(task.id, launcher, 'test', { chosen: profile, profiles: [profile] });
    await startAgain();
    return { task, launcher, proof, startAgain, archive: () => { archived = true; }, restore: () => { archived = false; }, creates: () => creates };
  }

  it('safely restores pending rework after a proven zero-tool startup archive, including after reload', async () => {
    const f = await startupCard();
    f.archive();
    closeDb();
    await tick(f.launcher, Date.now() - start.getTime(), () => 'archived');
    assert.equal(getTask(f.task.id).status, 'ready');
    assert.ok(pendingReworkReplacement(f.task.id));
    assert.equal(events(f.task.id, 'rework_startup_retry').length, 1);
    assert.equal(events(f.task.id, 'blocked').length, 0);
    await tick(f.launcher, Date.now() - start.getTime(), () => 'archived');
    assert.equal(events(f.task.id, 'rework_startup_retry').length, 1);
    assert.equal(f.creates(), 1);
  });

  for (const missing of ['tool', 'timeline', 'merge', 'agent', 'generation', 'lookup', 'expired'] as const) {
    it(`keeps needs_human when startup safety cannot be proven: ${missing}`, async () => {
      const f = await startupCard();
      f.archive();
      if (missing === 'tool') f.proof.toolCalls = 1;
      if (missing === 'timeline') f.proof.timelineComplete = false;
      if (missing === 'merge') f.proof.merged = false;
      if (missing === 'agent') f.proof.archived = false;
      if (missing === 'generation') f.launcher.inspectStartup = async () => ({ ...f.proof, generation: 'another-create' });
      if (missing === 'lookup') f.launcher.inspectStartup = async () => { throw new Error('timeline unavailable'); };
      await tick(f.launcher, Date.now() - start.getTime() + (missing === 'expired' ? 180_000 : 0), () => 'archived');
      const next = getTask(f.task.id);
      assert.equal(next.status, 'blocked');
      assert.equal(next.blocked_kind, 'needs_human');
      assert.ok(next.blocked_reason?.includes(`kanban/${f.task.id}-startup`), 'explain the recoverable branch');
      assert.equal(events(f.task.id, 'rework_startup_retry').length, 0);
      assert.equal(f.creates(), 1);
    });
  }

  it('bounds repeated safe startup retries across generations', async () => {
    const f = await startupCard();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      f.archive();
      await tick(f.launcher, Date.now() - start.getTime(), () => 'archived');
      if (attempt < 2) {
        assert.equal(getTask(f.task.id).status, 'ready');
        f.restore();
        await f.startAgain();
      }
    }
    assert.equal(getTask(f.task.id).status, 'blocked');
    assert.equal(events(f.task.id, 'rework_startup_retry').length, 2);
    assert.equal(f.creates(), 3);
  });

  it('ignores an archive proof that finishes after the card is handed in', async () => {
    const f = await startupCard();
    f.archive();
    f.launcher.inspectStartup = async () => {
      completeTask(f.task.id, 'executor', 'Delivered during proof lookup', { files: [], verification: 'passed', risks: [] });
      return { ...f.proof, generation: 'stale' };
    };
    await tick(f.launcher, Date.now() - start.getTime(), () => 'archived');
    assert.equal(getTask(f.task.id).status, 'in_review');
    assert.equal(events(f.task.id, 'blocked').length, 0);
    assert.equal(events(f.task.id, 'rework_startup_retry').length, 0);
  });

  for (const changed of ['agent', 'workspace', 'generation', 'claim'] as const) {
    it(`does not apply a startup retry after its ${changed} changes during proof lookup`, async () => {
      const f = await startupCard();
      const proof = f.launcher.inspectStartup!;
      f.archive();
      let token: string | null = null;
      f.launcher.inspectStartup = async (...args) => {
        const evidence = await proof(...args);
        if (changed === 'agent') getDb().prepare("UPDATE tasks SET agent_id = 'new-current-agent' WHERE id = ?").run(f.task.id);
        if (changed === 'workspace') bind(f.task.id, 'replacement-workspace');
        if (changed === 'generation') appendEvent(f.task.id, 'rework_startup', null, null, 'test', { generation: 'new-generation' });
        if (changed === 'claim') token = acquireStartClaim(f.task.id);
        return evidence;
      };
      try {
        await tick(f.launcher, Date.now() - start.getTime(), () => 'archived');
        assert.equal(getTask(f.task.id).status, 'running');
        assert.equal(events(f.task.id, 'rework_startup_retry').length, 0);
        assert.equal(events(f.task.id, 'blocked').length, 0);
        assert.equal(f.creates(), 1);
      } finally { if (token) releaseStartClaim(f.task.id, token); }
    });
  }

  it('does not reuse a startup permit for a later resumed run on the same agent', async () => {
    const f = await startupCard();
    appendEvent(f.task.id, 'resumed', 'rework', 'running', 'test', { agentId: getTask(f.task.id).agent_id });
    f.archive();
    await tick(f.launcher, Date.now() - start.getTime(), () => 'archived');
    assert.equal(getTask(f.task.id).status, 'blocked');
    assert.equal(events(f.task.id, 'rework_startup_retry').length, 0);
  });

  for (const tools of [0, 1]) {
    it(`checks startup safety when a host hook reclaims before reconcile, with ${tools} tool calls`, async () => {
      const f = await startupCard();
      f.archive();
      f.proof.toolCalls = tools;
      assert.equal(reclaimTask(f.task.id), 'reclaimed');
      await f.startAgain();
      assert.equal(getTask(f.task.id).status, tools === 0 ? 'ready' : 'blocked');
      assert.equal(events(f.task.id, 'rework_startup_retry').length, tools === 0 ? 1 : 0);
      if (tools === 0) assert.ok(pendingReworkReplacement(f.task.id));
      assert.equal(f.creates(), 1);
    });
  }

  it("stores a recoverable needs_human reason in both catalogs", () => {
    const en = catalog("en")["schedule.lostWorkspace.reason"];
    const zh = catalog("zh-CN")["schedule.lostWorkspace.reason"];
    assert.equal(typeof en, "string");
    assert.equal(CJK.test(en ?? ""), false);
    assert.ok(zh?.includes(LOST));
    assert.equal(typeof catalog("en")["flow.error.onBehalfLeaderOnly"], "string");
    assert.equal(typeof catalog("zh-CN")["flow.onBehalf.note"], "string");
    assert.ok(catalog("zh-CN")["flow.onBehalf.note"]?.includes(ON_BEHALF_ZH));
    assert.equal(CJK.test(catalog("en")["flow.onBehalf.note"] ?? ""), false);
  });

  for (const lookup of ["inspect", "list"] as const) {
    for (const changed of ["completed", "status", "agent", "workspace"] as const) {
      it(`ignores a late ${lookup} result after the card's ${changed} changes`, async () => {
        const task = runningCard();
        bind(task.id, "ws-card");
        let resolveLookup!: () => void;
        let enteredLookup!: () => void;
        const pending = new Promise<void>((resolve) => { resolveLookup = resolve; });
        const entered = new Promise<void>((resolve) => { enteredLookup = resolve; });
        const launcher = board();
        if (lookup === "inspect") launcher.inspectWorkspace = async () => {
          enteredLookup();
          await pending;
          return ws("ws-card", true);
        };
        else launcher.listWorkspaces = async () => {
          enteredLookup();
          await pending;
          return [ws("ws-card", true)];
        };
        const reconciling = tick(launcher);
        await entered;
        if (changed === "completed") completeTask(task.id, "executor", "Handed in during lookup", { files: [], verification: "passed", risks: [] });
        if (changed === "status") getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
        if (changed === "agent") getDb().prepare("UPDATE tasks SET agent_id = 'replacement-agent' WHERE id = ?").run(task.id);
        if (changed === "workspace") bind(task.id, "replacement-workspace");
        const expected = getTask(task.id);
        resolveLookup();
        await reconciling;
        const actual = getTask(task.id);
        assert.equal(actual.status, expected.status);
        assert.equal(actual.agent_id, expected.agent_id);
        assert.equal(actual.paseo_workspace_id, expected.paseo_workspace_id);
        assert.equal(events(task.id, "blocked").length, 0);
        assert.equal(events(task.id, "reclaimed").length, 0);
      });
    }
  }

  it("blocks a still-live agent when the bound workspace is archived", async () => {
    const task = runningCard();
    bind(task.id, "ws-card");
    await tick(board({ list: [ws("ws-card", true), ws("other", false)] }));
    const next = getTask(task.id);
    assert.equal(next.status, "blocked");
    assert.equal(next.blocked_kind, "needs_human");
    assert.equal(next.blocked_from, "running");
    assert.equal(next.agent_id, "old-agent");
    assert.equal(next.blocked_reason, catalog("zh-CN")["schedule.lostWorkspace.reason"]);
    const blocked = events(task.id, "blocked")[0];
    assert.equal(blocked?.cause, "host_workspace_or_agent_lost");
    assert.equal(blocked?.workspaceId, "ws-card");
    assert.equal(blocked?.agentId, "old-agent");
    assert.equal(blocked?.agentGone, false);
    assert.equal(blocked?.actor, "scheduler");
  });

  it("blocks during start grace when the workspace is already gone", async () => {
    const task = runningCard();
    bind(task.id, "ws-card");
    getDb().prepare("UPDATE tasks SET agent_id = NULL, updated_at = ? WHERE id = ?").run(start.toISOString(), task.id);
    await tick(board({ list: [ws("ws-card", true)] }));
    assert.equal(getTask(task.id).status, "blocked");
    assert.equal(events(task.id, "blocked")[0]?.agentGone, true);
  });

  it("blocks a reviewing card and a batch card the same way", async () => {
    for (const role of ["reviewer", "batch", "decision"] as const) {
      const task = runningCard(role);
      bind(task.id, `ws-${role}`);
      await tick(board({ inspect: ws(`ws-${role}`, true), list: [ws(`ws-${role}`, false)] }));
      assert.equal(getTask(task.id).status, "blocked", role);
      assert.equal(getTask(task.id).blocked_kind, "needs_human");
    }
  });

  it("blocks when the id is missing from a non-empty list, and when inspect returns null", async () => {
    const missing = runningCard();
    bind(missing.id, "ws-missing");
    await tick(board({ list: [ws("someone-else", false)] }));
    assert.equal(getTask(missing.id).status, "blocked");
    const inspected = runningCard("batch");
    bind(inspected.id, "ws-inspect");
    await tick(board({ inspect: null, list: [ws("ws-inspect", false)] }));
    assert.equal(getTask(inspected.id).status, "blocked");
  });

  it("does not guess when the list is empty, throws, or the launcher cannot see workspaces", async () => {
    const empty = runningCard();
    bind(empty.id, "ws-empty");
    await tick(board({ list: [] }), 0, () => "missing");
    await tick(board({ list: [] }), MISSING_CONFIRM_MS, () => "missing");
    assert.equal(getTask(empty.id).status, "ready");
    const thrown = runningCard();
    bind(thrown.id, "ws-throw");
    await tick(board({ list: new Error("offline"), agent: { archived: true } }), MISSING_CONFIRM_MS, () => "archived");
    assert.equal(getTask(thrown.id).status, "running");
    assert.equal(events(thrown.id, "blocked").length, 0);
    const blind = runningCard();
    bind(blind.id, "ws-blind");
    await tick(board(), 0, () => "alive");
    assert.equal(getTask(blind.id).status, "running");
  });

  it("keeps quiet handoff when the agent is archived but the workspace is still live", async () => {
    const task = runningCard();
    bind(task.id, "ws-live");
    const launcher = board({ list: [ws("ws-live", false)], agent: { archived: true } });
    await tick(launcher, 0, () => "missing");
    await tick(launcher, MISSING_CONFIRM_MS, () => "missing");
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).agent_id, "old-agent");
    assert.equal(events(task.id, "reclaimed").length, 0);
    assert.equal(events(task.id, "blocked").length, 0);
  });

  it("still reclaims an ordinary missing agent that has no workspace id", async () => {
    const task = runningCard();
    const launcher = board({ agent: null });
    await tick(launcher, 0, () => "missing");
    await tick(launcher, MISSING_CONFIRM_MS, () => "missing");
    assert.equal(getTask(task.id).status, "ready");
    assert.equal(events(task.id, "reclaimed").length, 1);
    assert.equal(events(task.id, "blocked").length, 0);
  });

  it("blocks instead of reclaiming when the agent is gone and the workspace is archived", async () => {
    const task = runningCard("batch");
    bind(task.id, "ws-both");
    const launcher = board({ list: [ws("ws-both", true)], agent: null });
    await tick(launcher, 0, () => "missing");
    const next = getTask(task.id);
    assert.equal(next.status, "blocked");
    assert.notEqual(next.status, "ready");
    assert.equal(events(task.id, "reclaimed").length, 0);
    assert.equal(events(task.id, "blocked")[0]?.agentGone, true);
  });
});

describe("complete --on-behalf", () => {
  const handoff = { files: [], verification: "passed", risks: [] };

  function leader(agentId: string): Identity {
    return { role: "supervisor", taskId: null, agentId };
  }

  function forbid(work: Promise<unknown>, message: string) {
    return assert.rejects(work, (error: unknown) => error instanceof KanbanError && error.code === "forbidden" && error.message === message);
  }

  it("lets the Kanban leader and the project leader hand in, and records onBehalf", async () => {
    const viaCli = runningCard();
    await runKanban(["complete", String(viaCli.id), "--on-behalf", "--summary", "Handed in", "--handoff", JSON.stringify(handoff)], { PASEO_AGENT_ID: kanbanLeader });
    assert.equal(getTask(viaCli.id).status, "in_review");
    const cliEvent = events(viaCli.id, "complete")[0];
    assert.equal(cliEvent?.onBehalf, true);
    assert.equal(cliEvent?.actorAgentId, kanbanLeader);
    assert.equal(cliEvent?.actor, kanbanLeader);
    assert.equal(cliEvent?.note, catalog("zh-CN")["flow.onBehalf.note"]);

    const viaTool = runningCard("batch");
    const done = await handleTool("kanban_complete", { id: viaTool.id, summary: "Batch hand-in", handoff, onBehalf: true }, null, leader(projectLeader));
    assert.equal((done as { status: string }).status, "acceptance");
    const toolEvent = events(viaTool.id, "complete")[0];
    assert.equal(toolEvent?.onBehalf, true);
    assert.equal(toolEvent?.actorAgentId, projectLeader);
    assert.equal(toolEvent?.note, catalog("zh-CN")["flow.onBehalf.note"]);

    const blocked = runningCard();
    bind(blocked.id, "ws-card");
    await tick(board({ list: [ws("ws-card", true)] }));
    assert.equal(getTask(blocked.id).status, "blocked");
    await handleTool("kanban_complete", { id: blocked.id, summary: "After the archive", handoff, onBehalf: true }, null, leader(kanbanLeader));
    assert.equal(getTask(blocked.id).status, "in_review");
    assert.equal(events(blocked.id, "complete")[0]?.onBehalf, true);
  });

  const pr = "https://github.com/acme/widgets/pull/7";
  function checks(mode: "pending" | "pass" | "fail" | "error"): GhRunner {
    return async (args) => {
      if (mode === "error") throw new Error("Demo check lookup unavailable");
      const line = args.join(" ");
      if (line.startsWith("pr view")) return JSON.stringify({ url: pr, headRefOid: "abc123", headRefName: "feature" });
      if (line.includes("/protection")) return JSON.stringify({ required_status_checks: { contexts: ["ci"] } });
      if (line.includes("/rules/")) return JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
      if (line.includes("/statuses")) return "[]";
      if (line.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: "ci", status: mode === "pending" ? "in_progress" : "completed", conclusion: mode === "pending" ? null : mode === "pass" ? "success" : "failure" }] });
      throw new Error(line);
    };
  }

  async function pendingBatch(blocked: boolean) {
    const task = runningCard("batch");
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(JSON.stringify({ kind: "github", repo: "acme/widgets", pr, awaiting: false }), task.id);
    if (blocked) {
      bind(task.id, "ws-card");
      await tick(board({ inspect: ws("ws-card", true) }));
      assert.equal(getTask(task.id).status, "blocked");
    }
    setGhRunner(checks("pending"));
    await assert.rejects(
      () => handleTool("kanban_complete", { id: task.id, summary: "Leader submitted while checks pending", handoff: { ...handoff, pr, waitingOn: "Required CI checks" }, onBehalf: true }, null, leader(projectLeader)),
      (error: unknown) => error instanceof KanbanError && error.code === "pr_checks",
    );
    assert.equal(getTask(task.id).status, blocked ? "blocked" : "running");
    assert.equal(readContract(getTask(task.id).contract_json).awaiting, true);
    assert.equal(events(task.id, "complete").length, 0);
    return task;
  }

  for (const blocked of [false, true]) {
    it(`preserves the real delegate through pending checks and a database reopen (${blocked ? "blocked" : "running"})`, async () => {
      const task = await pendingBatch(blocked);
      const saved = getTask(task.id).handoff_json;
      const runs = getDb().prepare("SELECT ended_at FROM runs WHERE task_id = ?").all(task.id) as Array<{ ended_at: string | null }>;
      assert.equal(runs[0]?.ended_at, null);
      closeDb();
      setGhRunner(checks("pending"));
      assert.deepEqual(await pollAwaitingPr(), []);
      assert.equal(events(task.id, "complete").length, 0);
      setGhRunner(checks("pass"));
      assert.deepEqual(await pollAwaitingPr(), [task.id]);
      assert.equal(getTask(task.id).status, "acceptance");
      assert.equal(getTask(task.id).handoff_json, saved);
      assert.equal(readContract(getTask(task.id).contract_json).awaiting, false);
      const event = events(task.id, "complete")[0];
      assert.equal(event?.actor, projectLeader);
      assert.equal(event?.actorAgentId, projectLeader);
      assert.equal(event?.onBehalf, true);
      assert.equal(event?.note, catalog("zh-CN")["flow.onBehalf.note"]);
      assert.equal(event?.summary, "Leader submitted while checks pending");
      const ended = getDb().prepare("SELECT ended_at, end_kind FROM runs WHERE task_id = ?").get(task.id) as { ended_at: string | null; end_kind: string };
      assert.ok(ended.ended_at);
      assert.equal(ended.end_kind, "complete");
      assert.deepEqual(await pollAwaitingPr(), []);
      assert.equal(events(task.id, "complete").length, 1);
    });
  }

  function assertWorkerStillRunning(id: number, agentId: string): void {
    const task = getTask(id);
    assert.equal(task.status, "running");
    assert.equal(task.agent_id, agentId);
    assert.equal(events(id, "complete").length, 0);
    const run = getDb().prepare("SELECT ended_at FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id) as { ended_at: string | null };
    assert.equal(run.ended_at, null);
    assert.equal(events(id, "release_agent").some((event) => event.agentId === agentId), false);
  }

  function nextRun(id: number, agentId: string): void {
    getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = 'replaced' WHERE task_id = ? AND ended_at IS NULL").run(start.toISOString(), id);
    getDb().prepare("UPDATE tasks SET agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, id);
    openExecutorRun(id);
  }

  for (const submittedBlocked of [false, true]) {
    it(`invalidates pending delegated checks after unblock and reassignment (${submittedBlocked ? "submitted blocked" : "submitted running"})`, async () => {
      const task = await pendingBatch(submittedBlocked);
      if (!submittedBlocked) blockTask(task.id, "needs_human", "Worker disappeared after submission", "test");
      assert.equal(unblockTask(task.id, "supervisor").status, "ready");
      assert.equal(getTask(task.id).agent_id, null);
      claimStatus(task.id, "ready", "running", "test");
      nextRun(task.id, "replacement-agent");
      closeDb();
      setGhRunner(checks("pass"));
      assert.deepEqual(await pollAwaitingPr(), []);
      assertWorkerStillRunning(task.id, "replacement-agent");
      assert.equal(readContract(getTask(task.id).contract_json).awaiting, false);
      assert.deepEqual(await pollAwaitingPr(), []);
      // The new worker can still submit its own work under the same checks gate.
      await completeTask(task.id, "batch", "Replacement worker finished", { ...handoff, pr });
      assert.equal(getTask(task.id).status, "acceptance");
      assert.equal(events(task.id, "complete")[0]?.actor, "batch");
      assert.equal(events(task.id, "complete")[0]?.onBehalf, undefined);
    });
  }

  it("invalidates the old submission even when unblock resumes the same agent and run", async () => {
    const task = await pendingBatch(true);
    const agents = join(dir, "agents", "demo");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "old-agent.json"), JSON.stringify({ id: "old-agent", cwd: dir, archivedAt: null }));
    assert.equal(unblockTask(task.id, "supervisor").status, "running");
    setGhRunner(checks("pass"));
    assert.deepEqual(await pollAwaitingPr(), []);
    assertWorkerStillRunning(task.id, "old-agent");
  });

  it("does not apply an old delegate's checks to a new run on the same agent", async () => {
    const task = await pendingBatch(false);
    nextRun(task.id, "old-agent");
    setGhRunner(checks("pass"));
    assert.deepEqual(await pollAwaitingPr(), []);
    assertWorkerStillRunning(task.id, "old-agent");
  });

  it("rechecks the submission generation after a checks lookup is already in flight", async () => {
    const task = await pendingBatch(false);
    resetCheckCache();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    const pass = checks("pass");
    setGhRunner(async (args) => {
      if (args.join(" ").startsWith("pr view")) {
        entered();
        await pending;
      }
      return pass(args);
    });
    const polling = pollAwaitingPr();
    await started;
    nextRun(task.id, "old-agent");
    resume();
    assert.deepEqual(await polling, []);
    assertWorkerStillRunning(task.id, "old-agent");
  });

  it("requires a fresh hand-in when a legacy delegate has no submission generation", async () => {
    const task = await pendingBatch(false);
    const saved = JSON.parse(getTask(task.id).handoff_json!);
    delete saved.completion.generation;
    getDb().prepare("UPDATE tasks SET handoff_json = ? WHERE id = ?").run(JSON.stringify(saved), task.id);
    setGhRunner(checks("pass"));
    assert.deepEqual(await pollAwaitingPr(), []);
    assertWorkerStillRunning(task.id, "old-agent");
    assert.equal(readContract(getTask(task.id).contract_json).awaiting, false);
    await handleTool("kanban_complete", { id: task.id, summary: "Fresh leader hand-in", handoff: { ...handoff, pr }, onBehalf: true }, null, leader(projectLeader));
    assert.equal(getTask(task.id).status, "acceptance");
    assert.equal(events(task.id, "complete")[0]?.actorAgentId, projectLeader);
  });

  it("keeps the submitted recovery blocked on lookup errors and failed required checks", async () => {
    const task = await pendingBatch(true);
    setGhRunner(checks("error"));
    assert.deepEqual(await pollAwaitingPr(), []);
    assert.equal(getTask(task.id).status, "blocked");
    setGhRunner(checks("fail"));
    assert.deepEqual(await pollAwaitingPr(), [task.id]);
    assert.equal(getTask(task.id).status, "blocked");
    assert.equal(readContract(getTask(task.id).contract_json).awaiting, false);
    setGhRunner(checks("pass"));
    assert.deepEqual(await pollAwaitingPr(), []);
    assert.equal(events(task.id, "complete").length, 0);
  });

  it("does not resume an unsubmitted blocked card, a review submission, or a newer block", async () => {
    const unsubmitted = runningCard("batch");
    blockTask(unsubmitted.id, "needs_human", "No handoff submitted", "test");
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(JSON.stringify({ kind: "github", repo: "acme/widgets", pr, awaiting: true }), unsubmitted.id);
    const review = runningCard();
    blockTask(review.id, "needs_human", "Review must be claimed", "test");
    await handleTool("kanban_complete", { id: review.id, summary: "Submit for review", handoff: { ...handoff, pr }, onBehalf: true }, null, leader(projectLeader));
    assert.equal(getTask(review.id).status, "in_review");
    const changed = await pendingBatch(true);
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(changed.id);
    blockTask(changed.id, "needs_human", "New human decision required", "test");
    setGhRunner(checks("pass"));
    assert.deepEqual(await pollAwaitingPr(), []);
    assert.equal(getTask(unsubmitted.id).status, "blocked");
    assert.equal(getTask(review.id).status, "in_review");
    assert.equal(getTask(changed.id).status, "blocked");
    assert.equal(events(changed.id, "complete").length, 0);
  });

  it("refuses every other identity, including a worker who passes the flag", async () => {
    const message = catalog("zh-CN")["flow.error.onBehalfLeaderOnly"] ?? "";
    const task = runningCard();
    const worker = issueToken("executor", task.id, "old-agent");
    await forbid(handleTool("kanban_complete", { id: task.id, summary: "Worker tried", handoff, onBehalf: true }, worker), message);
    await forbid(handleTool("kanban_complete", { summary: "Worker tried", handoff, onBehalf: "true" }, worker), message);
    assert.equal(getTask(task.id).status, "running");
    assert.equal(events(task.id, "complete").length, 0);

    await forbid(handleTool("kanban_complete", { id: task.id, summary: "Other project", handoff, onBehalf: true }, null, leader(otherLeader)), message);
    await forbid(handleTool("kanban_complete", { id: task.id, summary: "Creator", handoff, onBehalf: true }, null, leader("creator-agent")), message);
    await forbid(handleTool("kanban_complete", { id: task.id, summary: "Anonymous", handoff, onBehalf: true }, null, leader("")), message);
    await forbid(handleTool("kanban_complete", { id: task.id, summary: "Guest", handoff, onBehalf: true }, null, { role: "guest", taskId: null, agentId: "guest-agent" }), message);
    await forbid(handleTool("kanban_complete", { id: task.id, summary: "Schedule", handoff, onBehalf: true }, null, { role: "schedule", taskId: null, agentId: "schedule-agent" }), message);
    await forbid(runKanban(["complete", String(task.id), "--on-behalf", "--summary", "Anonymous shell", "--handoff", JSON.stringify(handoff)], {}), message);
    assert.equal(getTask(task.id).status, "running");

    await assert.rejects(
      () => handleTool("kanban_complete", { id: task.id, summary: "No flag", handoff }, null, leader(kanbanLeader)),
      (error: unknown) => error instanceof KanbanError && error.code === "forbidden",
    );
    const own = await handleTool("kanban_complete", { id: task.id, summary: "Own handoff", handoff }, worker);
    assert.equal((own as { status: string }).status, "in_review");
    assert.equal(events(task.id, "complete")[0]?.onBehalf, undefined);
  });
});
