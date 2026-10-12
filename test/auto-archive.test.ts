/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import { UI_ACTOR } from "../shared/actors";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { autoArchiveDone, flushMergeChecks, MERGE_CHECK_CONCURRENCY, resetMergeChecks, setMergeCheckTimeout } from "../server/auto-archive";
import { setWakeSender } from "../server/bus";
import { drainCleanups, installCleanup, type CleanupOps } from "../server/cleanup";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import type { AgentLauncher } from "../server/dispatch";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { MERGE_BACKOFF_MS, mergeRetryAt, prMergeState, resetMergeCache, setGhRunner, writeContract, type GhRunner } from "../server/pr";
import { runTick } from "./helpers/compat-schedule";
import {
  archiveTask,
  archivedCount,
  boardSnapshot,
  createTask,
  getDetail,
  getTask,
  listBoard,
  listHistory,
  notifyFinished,
} from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "autoarch-"));
process.env.KANBAN_DATA_DIR = dir;

const HOUR = 60 * 60_000;
const T0 = new Date("2026-09-20T00:00:00.000Z");

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function config(patch: Partial<KanbanConfig> = {}): KanbanConfig {
  return {
    autoStart: {},
    supervisorAgentId: null,
    supervisors: {},
    concurrency: {
      global: DEFAULT_CONCURRENCY.global,
      pools: { ...DEFAULT_CONCURRENCY.pools },
      roles: { ...DEFAULT_CONCURRENCY.roles },
    },
    ...patch,
  };
}

let seq = 0;

/** A card that entered done at `doneAt`, with one agent opened for it. */
function doneCard(project: string, title: string, options: { doneAt?: Date; pr?: string } = {}): number {
  seq += 1;
  const contract = options.pr ? writeContract({ kind: "github", repo: "acme/widgets", pr: options.pr, awaiting: false }) : undefined;
  const task = createTask({ project, title, role: "executor", workspacePath: dir, contract: options.pr ? "github:acme/widgets" : undefined });
  const agentId = `agent-${project}-${seq}`;
  getDb()
    .prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ?, contract_json = COALESCE(?, contract_json) WHERE id = ?")
    .run(agentId, agentId, contract ?? null, task.id);
  getDb()
    .prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'accept', 'acceptance', 'done', 'test', '{}')")
    .run(task.id, (options.doneAt ?? T0).toISOString());
  return task.id;
}

function eventKinds(taskId: number): string[] {
  const rows = getDb().prepare("SELECT kind FROM events WHERE task_id = ? ORDER BY id").all(taskId) as unknown as Array<{ kind: string }>;
  return rows.map((row) => row.kind);
}

function gh(state: { merged: boolean; mergedAt?: string | null; fail?: boolean }, calls: string[] = []): GhRunner {
  return async (args) => {
    calls.push(args.join(" "));
    if (state.fail) throw new Error("gh: HTTP 502");
    assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
    return JSON.stringify({ state: state.merged ? "MERGED" : "OPEN", mergedAt: state.merged ? (state.mergedAt ?? null) : null });
  };
}

function cleanupHarness(): { ops: CleanupOps; archivedAgents: string[] } {
  const archivedAgents: string[] = [];
  return {
    archivedAgents,
    ops: {
      async archiveAgent(agentId) {
        archivedAgents.push(agentId);
      },
      async archiveWorkspace() {
        throw new Error((zhCN("missingCwd.report.directory") + "Demo text workspace"));
      },
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    },
  };
}

/** Earlier tests leave done and uncleaned cards behind. Settle them so each test sees only its own. */
function settleLeftovers(): void {
  const db = getDb();
  db.prepare("UPDATE tasks SET status = 'archived' WHERE status = 'done'").run();
  db.prepare(
    `INSERT INTO events (task_id, at, kind, actor, data_json)
     SELECT id, ?, 'cleanup_finished', 'test', '{}' FROM tasks
     WHERE id NOT IN (SELECT task_id FROM events WHERE kind = 'cleanup_finished')`,
  ).run(T0.toISOString());
}

beforeEach(() => {
  settleLeftovers();
  resetMergeChecks();
  setMergeCheckTimeout(null);
  resetMergeCache();
  setGhRunner(null);
  setWakeSender(() => {});
});

after(() => {
  installCleanup(null);
  setGhRunner(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("auto archive of done cards", () => {
  it("archives a card 24 hours after it was done, not before", async () => {
    const id = doneCard("aa-time", (zhCNPart("wake.decision.held", 18, 20) + "24 " + zhCNPart("doctor.hours", 8, 10)));
    assert.deepEqual(await autoArchiveDone({ now: at(23 * HOUR), config: config() }), []);
    assert.equal(getTask(id).status, "done");
    assert.deepEqual(await autoArchiveDone({ now: at(24 * HOUR), config: config() }), [id]);
    assert.equal(getTask(id).status, "archived");
    const row = getDb().prepare("SELECT kind, from_status, to_status, actor, data_json FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id) as {
      kind: string;
      from_status: string;
      to_status: string;
      actor: string;
      data_json: string;
    };
    assert.equal(row.kind, "auto_archived");
    assert.equal(row.from_status, "done");
    assert.equal(row.to_status, "archived");
    assert.equal(row.actor, "scheduler");
    assert.equal(JSON.parse(row.data_json).reason, zhCN("cardParts.event.autoArchived"));
  });

  it("uses the configured wait", async () => {
    const id = doneCard("aa-conf", "One hour");
    assert.deepEqual(await autoArchiveDone({ now: at(HOUR - 1), config: config({ autoArchiveAfterMs: HOUR }) }), []);
    assert.deepEqual(await autoArchiveDone({ now: at(HOUR), config: config({ autoArchiveAfterMs: HOUR }) }), [id]);
  });

  it("does not touch cards in other statuses", async () => {
    const task = createTask({ project: "aa-other", title: "Still ready", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(T0.toISOString(), task.id);
    await autoArchiveDone({ now: at(100 * HOUR), config: config() });
    assert.equal(getTask(task.id).status, "ready");
  });

  it("runs from the scheduler tick", async () => {
    const id = doneCard("aa-tick", zhCN("doctor.object.scheduler"));
    saveConfig(config({ autoStart: { "aa-tick": false } }));
    setGhRunner(gh({ merged: false }));
    await runTick({ profiles: [], launcher: { async create() { return { id: "x" }; }, async send() {} }, now: at(25 * HOUR), config: config({ autoStart: { "aa-tick": false } }) });
    assert.equal(getTask(id).status, "archived");
  });
});

describe("auto archive of GitHub PR cards", () => {
  for (const kind of ["github", "local-only"] as const) it(`${kind}: keeps an unmerged PR card in done and shows ${zhCNPart("relatedView.pr.awaiting", 1, 4)}`, async () => {
    const pr = "https://github.com/acme/widgets/pull/101";
    const id = doneCard("aa-pr", zhCNPart("lane.prNotMerged", 4, 7), { pr });
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(writeContract({ kind, repo: "acme/widgets", pr, awaiting: false }), id);
    assert.equal(listBoard("aa-pr").tasks.find((card) => card.id === id)?.awaitingMerge, true);
    const calls: string[] = [];
    const run = gh({ merged: false }, calls);
    assert.deepEqual(autoArchiveDone({ now: at(48 * HOUR), config: config(), run }), []);
    await flushMergeChecks();
    assert.deepEqual(autoArchiveDone({ now: at(48 * HOUR + 60_000), config: config(), run }), []);
    await flushMergeChecks();
    assert.equal(getTask(id).status, "done");
    assert.equal(calls.length, 1);
    assert.equal(listBoard("aa-pr").tasks.find((card) => card.id === id)?.awaitingMerge, true);
  });

  for (const kind of ["github", "local-only"] as const) it(`${kind}: archives 24 hours after the merge, not 24 hours after done`, async () => {
    const pr = "https://github.com/acme/widgets/pull/102";
    const id = doneCard("aa-merge", zhCNPart("boardView.done.prStep", 3, 6), { pr });
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(writeContract({ kind, repo: "acme/widgets", pr, awaiting: false }), id);
    const mergedAt = at(30 * HOUR).toISOString();
    const run = gh({ merged: true, mergedAt });
    assert.deepEqual(autoArchiveDone({ now: at(31 * HOUR), config: config(), run }), []);
    await flushMergeChecks();
    assert.equal(getTask(id).status, "done");
    assert.equal(listBoard("aa-merge").tasks.find((card) => card.id === id)?.awaitingMerge, false);
    assert.deepEqual(await autoArchiveDone({ now: at(54 * HOUR - 1), config: config(), run }), []);
    assert.deepEqual(await autoArchiveDone({ now: at(54 * HOUR), config: config(), run }), [id]);
    const last = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'auto_archived'").get(id) as { data_json: string };
    assert.equal(JSON.parse(last.data_json).mergedAt, mergedAt);
  });

  it("does not archive when gh fails, and asks again next round", async () => {
    const pr = "https://github.com/acme/widgets/pull/103";
    const id = doneCard("aa-err", ("gh " + zhCNPart("wake.board.tickError", 10, 12)), { pr });
    const state = { merged: true, mergedAt: at(HOUR).toISOString(), fail: true };
    const calls: string[] = [];
    const run = gh(state, calls);
    assert.deepEqual(autoArchiveDone({ now: at(72 * HOUR), config: config(), run }), []);
    await flushMergeChecks();
    assert.equal(getTask(id).status, "done");
    state.fail = false;
    assert.deepEqual(autoArchiveDone({ now: at(72 * HOUR + 60_000), config: config(), run }), []);
    await flushMergeChecks();
    assert.deepEqual(autoArchiveDone({ now: at(72 * HOUR + 60_000), config: config(), run }), [id]);
    assert.equal(calls.length, 2);
  });

  it("caches an open PR for a while and a merged PR for good", async () => {
    const pr = "https://github.com/acme/widgets/pull/104";
    const state = { merged: false, mergedAt: null as string | null };
    const calls: string[] = [];
    const run = gh(state, calls);
    assert.equal((await prMergeState(pr, { now: 0, run })).merged, false);
    assert.equal((await prMergeState(pr, { now: 5 * 60_000, run })).merged, false);
    assert.equal(calls.length, 1);
    state.merged = true;
    state.mergedAt = "2026-09-20T01:00:00Z";
    assert.equal((await prMergeState(pr, { now: 11 * 60_000, run })).merged, true);
    assert.equal((await prMergeState(pr, { now: 1000 * 60_000, run })).mergedAt, "2026-09-20T01:00:00Z");
    assert.equal(calls.length, 2);
  });

  it("shares one gh call between callers asking about the same PR at once", async () => {
    const pr = "https://github.com/acme/widgets/pull/106";
    const calls: string[] = [];
    let release: (value: string) => void = () => {};
    const run: GhRunner = (args) => {
      calls.push(args.join(" "));
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const first = prMergeState(pr, { now: 0, run });
    const second = prMergeState(pr, { now: 0, run });
    assert.equal(calls.length, 1);
    release(JSON.stringify({ state: "MERGED", mergedAt: "2026-09-20T02:00:00Z" }));
    assert.deepEqual(await first, await second);
    assert.equal(calls.length, 1);
  });

  it("backs off 1, 5, then 30 minutes after gh errors in a row", async () => {
    const pr = "https://github.com/acme/widgets/pull/107";
    const state = { merged: false, fail: true };
    const calls: string[] = [];
    const run = gh(state, calls);
    const MIN = 60_000;
    let now = 0;
    for (const wait of [MERGE_BACKOFF_MS[0], MERGE_BACKOFF_MS[1], MERGE_BACKOFF_MS[2], MERGE_BACKOFF_MS[2]]) {
      const before = calls.length;
      assert.ok((await prMergeState(pr, { now, run })).error);
      assert.equal(calls.length, before + 1);
      assert.equal(mergeRetryAt(pr), now + wait);
      assert.match((await prMergeState(pr, { now: now + wait - 1, run })).error ?? "", new RegExp(localePattern(zhCNPart("pr.gh.backoff", 8, 12))));
      assert.equal(calls.length, before + 1);
      now += wait;
    }
    assert.deepEqual([MERGE_BACKOFF_MS[0], MERGE_BACKOFF_MS[1], MERGE_BACKOFF_MS[2]], [MIN, 5 * MIN, 30 * MIN]);
    state.fail = false;
    assert.equal((await prMergeState(pr, { now, run })).error, null);
    assert.equal(mergeRetryAt(pr), null);
  });

  it("only calls gh read-only", async () => {
    const calls: string[] = [];
    setGhRunner(async (args) => {
      calls.push(args.join(" "));
      return JSON.stringify({ state: "OPEN", mergedAt: null });
    });
    await prMergeState("https://github.com/acme/widgets/pull/105");
    assert.match(calls[0] ?? "", /^pr view 105 --repo acme\/widgets --json state,mergedAt$/);
  });
});

describe("archive events and cleanup", () => {
  it("keeps auto and manual archives apart", async () => {
    const auto = doneCard("aa-kind", zhCNPart("history.auto", 0, 2));
    const manualDone = doneCard("aa-kind", (zhCNPart("cardDrawer.command.selectByHand", 1, 3) + zhCN("labels.status.archived") + zhCNPart("restartStall.interrupt", 23, 27)), { doneAt: at(20 * HOUR) });
    const dropped = createTask({ project: "aa-kind", title: "Dropped", role: "executor", workspacePath: dir });
    await autoArchiveDone({ now: at(25 * HOUR), config: config() });
    archiveTask(manualDone, UI_ACTOR);
    archiveTask(dropped.id, "supervisor");
    assert.ok(eventKinds(auto).includes("auto_archived"));
    assert.ok(!eventKinds(auto).includes("archived"));
    assert.ok(eventKinds(manualDone).includes("archived"));
    assert.ok(!eventKinds(manualDone).includes("auto_archived"));
    const items = listHistory({ project: "aa-kind" }).items;
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.deepEqual({ outcome: byId.get(auto)?.outcome, auto: byId.get(auto)?.auto }, { outcome: "done", auto: true });
    assert.deepEqual({ outcome: byId.get(manualDone)?.outcome, auto: byId.get(manualDone)?.auto }, { outcome: "done", auto: false });
    assert.deepEqual({ outcome: byId.get(dropped.id)?.outcome, auto: byId.get(dropped.id)?.auto }, { outcome: "abandoned", auto: false });
  });

  it("does not archive agents again when a cleaned-up card is auto archived", async () => {
    const harness = cleanupHarness();
    const release = installCleanup(harness.ops);
    try {
      const id = doneCard("aa-clean", (zhCNPart("boardView.accept.external", 14, 17) + zhCNPart("nativeSessions.sweep.progressStart", 9, 12)));
      notifyFinished(getTask(id));
      await drainCleanups(at(HOUR));
      assert.deepEqual(harness.archivedAgents, [getTask(id).agent_id]);
      const before = eventKinds(id).filter((kind) => kind === "cleanup" || kind === "cleanup_finished").length;
      await autoArchiveDone({ now: at(25 * HOUR), config: config() });
      await drainCleanups(at(25 * HOUR));
      await autoArchiveDone({ now: at(26 * HOUR), config: config() });
      await drainCleanups(at(26 * HOUR));
      assert.equal(getTask(id).status, "archived");
      assert.equal(harness.archivedAgents.length, 1);
      assert.equal(eventKinds(id).filter((kind) => kind === "cleanup" || kind === "cleanup_finished").length, before);
      assert.equal(eventKinds(id).filter((kind) => kind === "auto_archived").length, 1);
    } finally {
      release();
    }
  });

  it("still cleans up once when the card was never cleaned before the auto archive", async () => {
    const id = doneCard("aa-late", (zhCNPart("boardView.accept.external", 14, 17) + "Demo text"));
    const harness = cleanupHarness();
    const release = installCleanup(harness.ops);
    try {
      await autoArchiveDone({ now: at(25 * HOUR), config: config() });
      await drainCleanups(at(25 * HOUR));
      await drainCleanups(at(26 * HOUR));
      assert.deepEqual(harness.archivedAgents, [getTask(id).agent_id]);
      assert.equal(eventKinds(id).filter((kind) => kind === "cleanup_finished").length, 1);
    } finally {
      release();
    }
  });
});

describe("board and history", () => {
  it("leaves archived cards out of the board payload and reports their count", () => {
    const live = createTask({ project: "aa-board", title: "Still working", role: "executor", workspacePath: dir });
    const gone = createTask({ project: "aa-board", title: "archived", role: "executor", workspacePath: dir });
    archiveTask(gone.id, UI_ACTOR);
    const snapshot = boardSnapshot("aa-board");
    assert.deepEqual(snapshot.tasks.map((card) => card.id), [live.id]);
    assert.equal(snapshot.archivedCount, 1);
    assert.ok(snapshot.projects.includes("aa-board"));
    assert.ok(boardSnapshot().tasks.every((card) => card.status !== "archived"));
    assert.equal(boardSnapshot().archivedCount, archivedCount());
    assert.equal(getDetail(gone.id).task.status, "archived");
  });

  it("gives a done card its finish time", () => {
    const id = doneCard("aa-finish", (zhCN("labels.status.done") + zhCNPart("missingCwd.report.checkedAt", 2, 4)), { doneAt: at(2 * HOUR) });
    assert.equal(listBoard("aa-finish").tasks[0]?.finishedAt, at(2 * HOUR).toISOString());
    assert.equal(getDetail(id).task.finishedAt, at(2 * HOUR).toISOString());
  });

  it("pages history newest first", () => {
    const ids: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const task = createTask({ project: "aa-page", title: `Page ${i}`, role: "executor", workspacePath: dir });
      archiveTask(task.id, UI_ACTOR);
      getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND kind = 'archived'").run(at(i * 60_000).toISOString(), task.id);
      ids.push(task.id);
    }
    const first = listHistory({ project: "aa-page", offset: 0, limit: 20 });
    assert.equal(first.total, 25);
    assert.deepEqual(first.items.map((item) => item.id), ids.slice(5).reverse());
    const second = listHistory({ project: "aa-page", offset: 20, limit: 20 });
    assert.deepEqual(second.items.map((item) => item.id), ids.slice(0, 5).reverse());
    assert.equal(listHistory({ project: "aa-page", offset: 0 }).items.length, 20);
  });

  it("filters history by project and searches by card number or title", () => {
    const a = createTask({ project: "aa-find", title: "Fix login 100% freeze", role: "executor", workspacePath: dir });
    const b = createTask({ project: "aa-find", title: "Documentation", role: "executor", workspacePath: dir });
    const other = createTask({ project: "aa-elsewhere", title: "Fix login", role: "executor", workspacePath: dir });
    for (const id of [a.id, b.id, other.id]) archiveTask(id, UI_ACTOR);
    assert.deepEqual(listHistory({ project: "aa-find" }).items.map((item) => item.id).sort(), [a.id, b.id].sort());
    assert.deepEqual(listHistory({ project: "aa-find", query: "login" }).items.map((item) => item.id), [a.id]);
    assert.deepEqual(listHistory({ query: "Fix login" }).items.map((item) => item.id).sort(), [a.id, other.id].sort());
    assert.deepEqual(listHistory({ query: `#${b.id}` }).items.map((item) => item.id), [b.id]);
    assert.deepEqual(listHistory({ project: "aa-find", query: String(b.id) }).items.map((item) => item.id), [b.id]);
    assert.deepEqual(listHistory({ project: "aa-find", query: "100%" }).items.map((item) => item.id), [a.id]);
    assert.deepEqual(listHistory({ project: "aa-find", query: "%" }).items.map((item) => item.id), [a.id]);
    assert.equal(listHistory({ project: "aa-find", query: (zhCNPart("missingCwd.purge.gone", 9, 12) + zhCNPart("missingCwd.purge.notThisCard", 4, 5)) }).total, 0);
  });
});

describe("merge checks never hold up the scheduler", () => {
  const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" };
  const reviewer: Profile = { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" };
  const pools: PoolSnapshot = {
    state: "fresh",
    message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)),
    generatedAt: new Date().toISOString(),
    dispatchable: () => true,
    entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
  };
  let n = 0;
  const launcher: AgentLauncher = {
    async create() {
      n += 1;
      return { id: `agent-hang-${n}` };
    },
    async send() {},
  };

  /** The hung gh never returns, so only a regression reaches this; a slow machine must not. */
  const HANG_GUARD_MS = 10_000;

  function within<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
    return Promise.race([work, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
  }

  it("a gh that never returns does not stall the next tick or other cards starting", async () => {
    const calls: string[] = [];
    setGhRunner((args) => {
      calls.push(args.join(" "));
      return new Promise<string>(() => {});
    });
    setMergeCheckTimeout(40);
    const prs = [201, 202, 203].map((num) => doneCard("aa-hang", `${zhCNPart("wake.board.archiveStuck", 2, 4)} ${num}`, { pr: `https://github.com/acme/widgets/pull/${num}` }));
    const first = createTask({ project: "aa-go", title: "Start normally 1", role: "executor", workspacePath: join(dir, "go-1") });
    mkdirSync(join(dir, "go-1"), { recursive: true });
    const tickConfig = config({ autoStart: { "aa-go": true, "aa-hang": false } });
    tickConfig.concurrency = { ...tickConfig.concurrency, pools: { ...tickConfig.concurrency.pools, cursor: 5 } };
    saveConfig(tickConfig);

    const tick1 = await within(runTick({ profiles: [executor, reviewer], launcher, pools, agentState: () => "alive", now: at(48 * HOUR), config: tickConfig }), HANG_GUARD_MS);
    assert.notEqual(tick1, "timeout");
    assert.equal(getTask(first.id).status, "running");
    assert.equal(calls.length, MERGE_CHECK_CONCURRENCY);

    const slotDeadline = Date.now() + HANG_GUARD_MS;
    while (calls.length < 3 && Date.now() < slotDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 3, "a timed-out check gives its slot to the next PR");

    mkdirSync(join(dir, "go-2"), { recursive: true });
    const second = createTask({ project: "aa-go", title: "Start normally 2", role: "executor", workspacePath: join(dir, "go-2") });
    const tick2 = await within(runTick({ profiles: [executor, reviewer], launcher, pools, agentState: () => "alive", now: at(48 * HOUR + 2 * 60_000), config: tickConfig }), HANG_GUARD_MS);
    assert.notEqual(tick2, "timeout");
    assert.equal(getTask(second.id).status, "running");
    assert.equal(calls.length, 3, "a PR still waiting on gh is not asked again");
    for (const id of prs) assert.equal(getTask(id).status, "done");
  });

  it("backs off after gh errors instead of asking every round", async () => {
    const pr = "https://github.com/acme/widgets/pull/210";
    const id = doneCard("aa-back", zhCNPart("doctor.cleanup.suggestion", 59, 61), { pr });
    const calls: string[] = [];
    const run = gh({ merged: false, fail: true }, calls);
    const MIN = 60_000;
    const round = async (ms: number) => {
      autoArchiveDone({ now: at(48 * HOUR + ms), config: config(), run });
      await flushMergeChecks();
      return calls.length;
    };
    assert.equal(await round(0), 1);
    assert.equal(await round(30_000), 1);
    assert.equal(await round(MIN), 2);
    assert.equal(await round(MIN + 4 * MIN), 2);
    assert.equal(await round(MIN + 5 * MIN), 3);
    assert.equal(await round(6 * MIN + 29 * MIN), 3);
    assert.equal(await round(6 * MIN + 30 * MIN), 4);
    assert.equal(getTask(id).status, "done");
  });
});
