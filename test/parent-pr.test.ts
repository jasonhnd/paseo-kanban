/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { flushMergeChecks, resetMergeChecks } from "../server/auto-archive";
import { DEFAULT_CONCURRENCY, loadConfig, saveConfig, setProjectWorkspace, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { AgentLauncher } from "../server/dispatch";
import { setWakeSender } from "../server/bus";
import { parentBlockReason, parentPulls, parentMergeProblem, refreshStartBlockReason } from "../server/parents";
import { promoteWaiting } from "../server/promote";
import { notifyParentMergeProblem, resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { MERGE_CACHE_MS, prMergeState, resetMergeCache, setGhRunner, writeContract, type GhRunner } from "../server/pr";
import { runTick } from "./helpers/compat-schedule";
import { addComment, appendEvent, createTask, getTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "parent-pr-"));
process.env.KANBAN_DATA_DIR = dir;

const PR = "https://github.com/acme/widgets/pull/7";

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
const pools: PoolSnapshot = {
  state: "fresh",
  message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
  generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};
const config: KanbanConfig = {
  autoStart: { gate: true },
  supervisorAgentId: null,
  supervisors: {},
  concurrency: {
    global: 5,
    pools: { ...DEFAULT_CONCURRENCY.pools, alternate: 5, "claude-max": 5 },
    roles: { ...DEFAULT_CONCURRENCY.roles, executor: 5 },
  },
};

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function launcher(): AgentLauncher {
  let n = 0;
  return {
    async create() {
      n += 1;
      return { id: `parent-pr-${n}` };
    },
    async send() {},
  };
}

function gh(state: { merged: boolean; closed?: boolean; fail?: boolean }): { run: GhRunner; calls: string[] } {
  const calls: string[] = [];
  const run: GhRunner = async (args) => {
    calls.push(args.join(" "));
    if (state.fail) throw new Error(("gh " + zhCNPart("compat.daemon.connectFailed", 0, 3)));
    return JSON.stringify({ state: state.merged ? "MERGED" : state.closed ? "CLOSED" : "OPEN", mergedAt: state.merged ? "2026-09-27T01:00:00Z" : null });
  };
  return { run, calls };
}

function doneParent(title: string, contract?: string): number {
  const task = createTask({
    project: "gate",
    title,
    role: "executor",
    workspacePath: room(title),
    ...(contract ? { contract } : {}),
  });
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  return task.id;
}

beforeEach(() => {
  resetMergeCache();
  resetMergeChecks();
  setGhRunner(null);
  getDb().prepare("UPDATE tasks SET status = 'archived' WHERE status != 'archived'").run();
  saveConfig(config);
  setAgentAliveCheck(() => false);
  setWakeSender(() => {});
});

after(() => {
  resetAgentAliveCheck();
  setGhRunner(null);
  resetMergeCache();
  resetMergeChecks();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("a child waits for the parent pull request", () => {
  for (const kind of ["local-only", "github"] as const) it(`${kind}: waits for merge, reuses cache and backs off after gh errors`, async () => {
    const contract = writeContract({ kind, repo: "acme/widgets", pr: PR, awaiting: false });
    const parent = doneParent(zhCNPart("boardView.attention.parentPr", 0, 5), contract);
    const child = createTask({
      project: "gate",
      title: "Child",
      role: "executor",
      workspacePath: room("child"),
      parentIds: [parent],
    });
    assert.equal(child.status, "waiting");

    const open = gh({ merged: false });
    setGhRunner(open.run);
    const first = await runTick({ profiles: [executor, reviewer], launcher: launcher(), config, pools, agentState: () => "alive" });
    await flushMergeChecks();
    assert.equal(first.started.includes(child.id), false);
    assert.equal(getTask(child.id).status, "waiting");
    assert.equal(getTask(child.id).hold_reason, `${zhCNPart("cardDrawer.pr.awaiting", 0, 2)}${cardMark(parent)} ${zhCNPart("parents.block.waitingPr", 9, 16)}`);
    assert.match(open.calls[0] ?? "", /^pr view 7 --repo acme\/widgets --json state,mergedAt$/);

    const second = await runTick({ profiles: [executor, reviewer], launcher: launcher(), config, pools, agentState: () => "alive" });
    assert.equal(second.started.includes(child.id), false);
    assert.equal(open.calls.length, 1);

    resetMergeCache();
    const broken = gh({ merged: false, fail: true });
    setGhRunner(broken.run);
    await runTick({ profiles: [executor, reviewer], launcher: launcher(), config, pools, agentState: () => "alive" });
    await flushMergeChecks();
    await runTick({ profiles: [executor, reviewer], launcher: launcher(), config, pools, agentState: () => "alive" });
    assert.equal(getTask(child.id).status, "waiting");
    assert.equal(getTask(child.id).hold_reason, `${zhCNPart("cardDrawer.pr.awaiting", 0, 2)}${cardMark(parent)} ${zhCNPart("wake.parentMerge.next", 11, 19)}gh ${zhCNPart("compat.daemon.connectFailed", 0, 3)}`);
    assert.equal(broken.calls.length, 1, "error backoff avoids another gh call");

    resetMergeCache();
    const merged = gh({ merged: true });
    setGhRunner(merged.run);
    await runTick({ profiles: [executor, reviewer], launcher: launcher(), config, pools, agentState: () => "alive" });
    await flushMergeChecks();
    // The merge is seen by the background check and releases the child in the same round, so it may start in either tick.
    await runTick({ profiles: [executor, reviewer], launcher: launcher(), config, pools, agentState: () => "alive" });
    assert.equal(getTask(child.id).status, "running");
  });

  it("starts a child as soon as a non-PR parent is done", async () => {
    const parent = doneParent((zhCNPart("worktreeGc.branch.localGone", 0, 2) + zhCN("cardDrawer.links.parent")));
    const child = createTask({
      project: "gate",
      title: "Do not read PR",
      role: "executor",
      workspacePath: room("local-child"),
      parentIds: [parent],
    });
    assert.equal(child.status, "ready");
    const result = await runTick({ profiles: [executor, reviewer], launcher: launcher(), config, pools, agentState: () => "alive" });
    assert.ok(result.started.includes(child.id));
  });
});


describe("terminal parent PR problems", () => {
  const tick = () => runTick({ profiles: [], launcher: launcher(), config: { ...config, autoStart: {} }, pools, agentState: () => "alive" });
  for (const kind of ["local-only", "github"] as const) {
    for (const archived of [false, true]) {
      it(`${kind}: ${archived ? "archived" : "closed unmerged"} parent shows reason and wakes project leader once`, async () => {
        saveConfig({ ...config, supervisors: { gate: "project-leader" } });
        setAgentAliveCheck((id) => id === "project-leader");
        const sent: Array<{ id: string; text: string }> = [];
        setWakeSender((id, text) => { sent.push({ id, text }); });
        const parent = doneParent("terminal", writeContract({ kind, repo: "acme/widgets", pr: PR, awaiting: false }));
        if (archived) getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(parent);
        const child = createTask({ project: "gate", title: "terminal-child", role: "executor", parentIds: [parent] });
        assert.equal(child.status, "waiting");
        const mock = gh({ merged: false, closed: !archived });
        setGhRunner(mock.run);
        await tick();
        await flushMergeChecks();
        await tick();
        const reason = archived ? zhCN("boardView.parentPr.archivedUnmerged") : zhCN("boardView.parentPr.closed");
        assert.equal(getTask(child.id).hold_reason, `${zhCNPart("cardDrawer.pr.awaiting", 0, 2)}${cardMark(parent)} ${zhCNPart("wake.parentMerge.next", 11, 19)}${reason}`);
        assert.equal(getTask(child.id).status, "waiting");
        assert.deepEqual(sent.map((item) => item.id), ["project-leader"]);
        assert.ok(sent[0]?.text.includes(reason));
        await tick();
        assert.equal(sent.length, 1);
        assert.equal(mock.calls.length, 1);
        const events = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_parent_merge'").all(parent);
        assert.equal(events.length, 1);
      });
    }
  }

  it("closed PR can reopen and later merge using the existing TTL, shared by multiple children", async () => {
    const parent = doneParent("reopened", writeContract({ kind: "local-only", repo: null, pr: PR, awaiting: false }));
    const children = [1, 2].map((n) => createTask({ project: "gate", title: `sibling-${n}`, role: "executor", parentIds: [parent] }));
    const now = Date.now();
    const state = { merged: false, closed: true };
    const mock = gh(state);
    setGhRunner(mock.run);
    promoteWaiting("test", now);
    await flushMergeChecks();
    promoteWaiting("test", now + 1);
    assert.equal(mock.calls.length, 1);
    state.closed = false;
    await prMergeState(PR, { now: now + MERGE_CACHE_MS });
    assert.equal(parentBlockReason(getTask(parent)), `${zhCNPart("cardDrawer.pr.awaiting", 0, 2)}${cardMark(parent)} ${zhCNPart("parents.block.waitingPr", 9, 16)}`);
    state.merged = true;
    await prMergeState(PR, { now: now + 2 * MERGE_CACHE_MS });
    assert.deepEqual(parentPulls([getTask(parent)]), []);
    assert.deepEqual(promoteWaiting("test", now + 2 * MERGE_CACHE_MS), children.map((child) => child.id));
    assert.equal(mock.calls.length, 3);
  });

  it("an archived parent with a merged PR releases children without a problem wake", async () => {
    const parent = doneParent("merged-archive", writeContract({ kind: "local-only", repo: null, pr: PR, awaiting: false }));
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(parent);
    const mock = gh({ merged: true });
    await prMergeState(PR, { run: mock.run });
    const sent: string[] = [];
    setWakeSender((_id, text) => { sent.push(text); });
    const child = createTask({ project: "gate", title: "merged-child", role: "executor", parentIds: [parent] });
    assert.equal(child.status, "ready");
    assert.equal(parentBlockReason(getTask(parent)), null);
    assert.deepEqual(parentPulls([getTask(parent)]), []);
    assert.deepEqual(sent, []);
  });

  it("retries a missing leader and a failed delivery, then deduplicates the successful wake", async () => {
    const parent = doneParent("retry-wake", writeContract({ kind: "local-only", repo: null, pr: PR, awaiting: false }));
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(parent);
    const child = createTask({ project: "gate", title: "retry-child", role: "executor", parentIds: [parent] });
    setGhRunner(gh({ merged: false }).run);
    await tick();
    await flushMergeChecks();
    assert.ok(getTask(child.id).unattended_at);
    saveConfig({ ...config, supervisors: { gate: "project-leader" } });
    setAgentAliveCheck((id) => id === "project-leader");
    let attempts = 0;
    setWakeSender(() => { attempts += 1; throw new Error("delivery failed"); });
    await tick();
    assert.ok(attempts > 0);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'wake_parent_merge'").get(child.id)?.n, 0);
    const sent: string[] = [];
    setWakeSender((_id, text) => { sent.push(text); });
    await tick();
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(getTask(child.id).unattended_at, null);
  });

  it("only GitHub PR URLs gate a local-only parent; unfinished parents still block", () => {
    const local = { id: 1, status: "done", contract_json: writeContract({ kind: "local-only", repo: null, pr: "https://example.com/pull/7", awaiting: false }) };
    assert.equal(parentBlockReason(local), null);
    assert.deepEqual(parentPulls([local]), []);
    const unfinished = { ...local, status: "running", contract_json: writeContract({ kind: "local-only", repo: null, pr: PR, awaiting: false }) };
    assert.equal(parentBlockReason(unfinished), zhCN("parents.block.waitingParents"));
    assert.deepEqual(parentPulls([unfinished]), []);
  });

  it("clears missing-leader attention when an archived parent PR finally merges", async () => {
    const parent = doneParent("attention-merge", writeContract({ kind: "local-only", repo: null, pr: PR, awaiting: false }));
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(parent);
    const child = createTask({ project: "gate", title: "attention-child", role: "executor", parentIds: [parent] });
    const now = Date.now();
    setGhRunner(gh({ merged: false }).run);
    promoteWaiting("test", now);
    await flushMergeChecks();
    assert.ok(getTask(child.id).unattended_at);
    await prMergeState(PR, { now: now + MERGE_CACHE_MS, run: gh({ merged: true }).run });
    assert.deepEqual(promoteWaiting("test", now + MERGE_CACHE_MS), [child.id]);
    assert.equal(getTask(child.id).unattended_at, null);
  });
});


describe("parent merge notices are grouped and acknowledged", () => {
  function setup(archived = false) {
    saveConfig({ ...config, supervisorAgentId: "board-leader", supervisors: { gate: "project-leader" } });
    setAgentAliveCheck(id => id === "project-leader");
    const sent: Array<{ id: string; text: string }> = [];
    setWakeSender((id, text) => { sent.push({ id, text }); });
    const parent = doneParent("grouped", writeContract({ kind: "local-only", repo: null, pr: PR, awaiting: false }));
    if (archived) getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(parent);
    const children = Array.from({ length: 5 }, (_, n) => createTask({ project: "gate", title: `group-child-${n}`, role: "executor", parentIds: [parent] }));
    return { parent, children, sent };
  }

  for (const archived of [false, true]) it(`sends one ${archived ? "archived" : "closed"} notice listing all five children, even across repeated/concurrent sweeps`, async () => {
    const { parent, children, sent } = setup(archived);
    await prMergeState(PR, { run: gh({ merged: false, closed: !archived }).run });
    await Promise.all(children.map(() => notifyParentMergeProblem(parent)));
    promoteWaiting("test");
    await notifyParentMergeProblem(parent);
    assert.equal(sent.length, 1);
    for (const child of children) assert.ok(sent[0].text.includes(cardMark(child.id)));
    const wakes = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_parent_merge'").all(parent) as Array<{ data_json: string }>;
    assert.equal(wakes.length, 1);
    assert.deepEqual(JSON.parse(wakes[0].data_json).taskIds, children.map(c => c.id));
    const extra = createTask({ project: "gate", title: "later sibling", role: "executor", parentIds: [parent] });
    await notifyParentMergeProblem(parent);
    assert.equal(sent.length, 1, "a new child does not repeat the same parent/reason notice");
    assert.equal(getTask(extra.id).status, "waiting");
    resetMergeCache();
    await notifyParentMergeProblem(parent);
    await prMergeState(PR, { run: gh({ merged: false, closed: !archived }).run });
    await notifyParentMergeProblem(parent);
    assert.equal(sent.length, 1, "cold cache/restart does not create a false reason change");
  });

  for (const location of ["parent", "child"] as const) {
    for (const actor of ["supervisor", "project-leader"]) it(`${actor} comment on ${location} acknowledges a fallback wake and prevents escalation`, async () => {
      const { parent, children, sent } = setup(true);
      setAgentAliveCheck(id => id === "board-leader");
      await prMergeState(PR, { run: gh({ merged: false }).run });
      await notifyParentMergeProblem(parent);
      assert.deepEqual(sent.map(item => item.id), ["board-leader"]);
      const id = location === "parent" ? parent : children[3].id;
      if (actor === "supervisor") addComment(id, actor, (zhCNPart("nativeSessions.kept.leader", 9, 11) + zhCNPart("tools.action.link", 3, 5) + zhCN("common.comma") + zhCNPart("dispatch.reworkNoWorkspace", 23, 25) + zhCNPart("parents.mergeNote", 0, 3)));
      else appendEvent(id, "comment", null, getTask(id).status, actor, {});
      setAgentAliveCheck(id => id === "project-leader");
      await notifyParentMergeProblem(parent);
      assert.equal(sent.length, 1);
      for (const child of children) {
        assert.equal(getTask(child.id).unattended_at, null);
        assert.match(parentBlockReason(getTask(parent))!, new RegExp(localePattern(zhCNPart("boardView.parentPr.archivedUnmerged", 0, 6))));
      }
    });
  }

  it("worker/other leader comments and comments before the wake do not suppress project escalation", async () => {
    const { parent, children, sent } = setup(true);
    addComment(parent, "supervisor", "old comment");
    setAgentAliveCheck(id => id === "board-leader");
    await prMergeState(PR, { run: gh({ merged: false }).run });
    await notifyParentMergeProblem(parent);
    appendEvent(children[0].id, "comment", null, "waiting", "worker", {});
    appendEvent(parent, "comment", null, "archived", "other-leader", {});
    setAgentAliveCheck(id => id === "project-leader");
    await notifyParentMergeProblem(parent);
    await notifyParentMergeProblem(parent);
    assert.deepEqual(sent.map(item => item.id), ["board-leader", "project-leader"]);
  });

  it("a known reopen followed by close starts a new wake episode, even after acknowledgement", async () => {
    const { parent, children, sent } = setup();
    const state = { merged: false, closed: true };
    const run = gh(state).run;
    await prMergeState(PR, { run, cacheMs: 0 });
    await notifyParentMergeProblem(parent);
    appendEvent(parent, "comment", null, "done", "project-leader", {});
    await notifyParentMergeProblem(parent);
    assert.equal(sent.length, 1);
    state.closed = false;
    await prMergeState(PR, { run, cacheMs: 0 });
    await notifyParentMergeProblem(parent);
    assert.equal(sent.length, 1);
    state.closed = true;
    await prMergeState(PR, { run, cacheMs: 0 });
    await notifyParentMergeProblem(parent);
    await notifyParentMergeProblem(parent);
    assert.equal(sent.length, 2);
    getDb().prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(parent);
    await notifyParentMergeProblem(parent);
    assert.equal(sent.length, 3, "adding archived to the reason triggers one new notice");
    state.merged = true;
    await prMergeState(PR, { run, cacheMs: 0 });
    await notifyParentMergeProblem(parent);
    assert.deepEqual(promoteWaiting("test"), children.map(c => c.id));
    assert.equal(sent.length, 3);
  });

  it("retains old child-based dedup records and applies their leader acknowledgement", async () => {
    const { parent, children, sent } = setup(true);
    appendEvent(children[0].id, "wake_parent_merge", null, "waiting", "scheduler", { parentId: parent, reason: zhCN("boardView.parentPr.archivedUnmerged"), agentId: "board-leader", fallback: true });
    appendEvent(children[4].id, "comment", null, "waiting", "project-leader", {});
    await prMergeState(PR, { run: gh({ merged: false }).run });
    await notifyParentMergeProblem(parent);
    assert.equal(sent.length, 0);
  });

  it("notifies each affected project once for a shared cross-project parent", async () => {
    const { parent, sent } = setup();
    saveConfig({ ...config, supervisors: { gate: "project-leader", other: "other-leader" } });
    setAgentAliveCheck(id => ["project-leader", "other-leader"].includes(id));
    const other = createTask({ project: "other", title: "cross-project child", role: "executor", parentIds: [parent] });
    await prMergeState(PR, { run: gh({ merged: false, closed: true }).run });
    await notifyParentMergeProblem(parent);
    await notifyParentMergeProblem(parent);
    assert.deepEqual(sent.map(item => item.id), ["project-leader", "other-leader"]);
    assert.ok(sent[1].text.includes(cardMark(other.id)));
  });
});


describe("project waitParentPr switch", () => {
  for (const wait of [undefined, true, false]) it(`accepted parent with open PR: waitParentPr=${wait}`, async () => {
    if (wait !== undefined) setProjectWorkspace("gate", { waitParentPr: wait });
    const parent = doneParent("switch-parent", writeContract({ kind: "github", repo: "acme/widgets", pr: PR, awaiting: false }));
    const mock = gh({ merged: false });
    setGhRunner(mock.run);
    const child = createTask({ project: "gate", title: "switch-child", role: "executor", workspacePath: room("switch-child"), parentIds: [parent] });
    assert.equal(child.status, wait === false ? "ready" : "waiting");
    const reason = await refreshStartBlockReason([getTask(parent)], child);
    if (wait === false) {
      assert.equal(reason, null);
      assert.equal(parentBlockReason(getTask(parent), Date.now(), child), null);
      assert.deepEqual(parentPulls([getTask(parent)], child), []);
      assert.equal(mock.calls.length, 0);
      const result = await runTick({ profiles: [executor, reviewer], launcher: launcher(), config, pools, agentState: () => "alive" });
      assert.ok(result.started.includes(child.id));
      assert.equal(getTask(child.id).hold_reason, null);
    } else assert.match(reason ?? "", new RegExp("PR #7 " + localePattern(zhCNPart("worktreeGc.leftover.notMerged", 1, 3))));
  });

  it("still waits for acceptance and suppresses PR problem wakes only for opted-out children", async () => {
    setProjectWorkspace("skip-pr", { waitParentPr: false });
    saveConfig({ ...loadConfig(), supervisors: { "skip-pr": "skip-leader", gate: "gate-leader" } });
    setAgentAliveCheck(() => true);
    const sent: string[] = [];
    setWakeSender((id) => { sent.push(id); });
    const parent = doneParent("wake-switch", writeContract({ kind: "github", repo: "acme/widgets", pr: PR, awaiting: false }));
    getDb().prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(parent);
    const skipped = createTask({ project: "skip-pr", title: "skip", role: "executor", parentIds: [parent] });
    const waiting = createTask({ project: "gate", title: "wait", role: "executor", parentIds: [parent] });
    assert.equal(skipped.status, "waiting");
    assert.equal(await refreshStartBlockReason([getTask(parent)], skipped), zhCN("parents.block.waitingParents"));
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(parent);
    await prMergeState(PR, { run: gh({ merged: false, closed: true }).run });
    assert.equal(parentMergeProblem(getTask(parent), skipped), null);
    await notifyParentMergeProblem(parent);
    assert.deepEqual(sent, ["gate-leader"]);
    assert.deepEqual(promoteWaiting("test"), [skipped.id]);
    assert.equal(getTask(waiting.id).status, "waiting");
  });
});
