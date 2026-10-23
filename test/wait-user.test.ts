/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
// TEST_0255: wait-user keeps a <leader>-paused card in ready; EX reminder cards must cite a resolved decision.
// Atomic needs_human coverage uses the same fixture ids and never a live board.
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it, mock } from "node:test";
import { runKanban } from "../server/cli";
import { startTask } from "./helpers/compat-dispatch";
import { handleTool, toolDefs } from "../server/tools";
import { resolveCliIdentity } from "../server/identity";
import { acquireStartClaim, holdsStartClaim, releaseStartClaim } from "../server/start-claim";
import { issueToken } from "../server/tokens";
import { parseDecisionId, waitUser } from "../server/wait-user";
import { DEFAULT_CONCURRENCY, loadConfig, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { openEntry } from "../server/pools";
import type { Profile } from "../server/profiles";
import { cachedMergeState, prMergeState, resetMergeCache, setGhRunner } from "../server/pr";
import { runTick } from "./helpers/compat-schedule";
import { appendEvent, blockTask, createTask, getTask, unblockTask } from "../server/store";

const root = mkdtempSync(join(tmpdir(), "TEST_0255-"));
const agents = join(root, "agents");
const roles = join(join(root, "data"), "fleet");
mkdirSync(agents, { recursive: true });
mkdirSync(roles, { recursive: true });
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_AGENTS_DIR = agents;


const PROJECT = "wait_proj";
const OTHER = "other_proj";
const LEADER = "wait-leader";
const OTHER_LEADER = "other-leader";
const KANBAN = "kanban-leader";
const SCHEDULE = "sched-agent";
const DONE = "d1005-091216-1";
const OPEN = "d1005-091216-2";
const MISSING = "d1005-091216-9";
/** Filed in the board's own list (k-id), already decided. */
const LOCAL_DONE = "k1005-091216-1";
const PARENT_PR = "https://github.com/fixture/repo/pull/1";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
let ghCalls = 0;
const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "alternate", model: "grok-4.7", pool: "alternate" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];

function writeAgent(id: string, labels: Record<string, string> = {}): void {
  const bucket = join(agents, "Users-test-repo");
  mkdirSync(bucket, { recursive: true });
  writeFileSync(join(bucket, `${id}.json`), JSON.stringify({ id, cwd: root, title: id, provider: "claude", labels, lastStatus: "idle", archivedAt: null, createdAt: "2026-10-05T00:00:00.000Z" }));
}

function writeDecisions(): void {
  const row = (id: string, status: string) => ({ id, project: PROJECT, title: "t", detail: "d", blocking: false, agentId: null, source: "x", createdAt: "2026-10-05T00:00:00+09:00", status });
  writeFileSync(join(roles, "decisions.json"), JSON.stringify([row(DONE, "done"), row(OPEN, "open")]));
  mkdirSync(process.env.KANBAN_DATA_DIR!, { recursive: true });
  writeFileSync(join(process.env.KANBAN_DATA_DIR!, "kanban-decisions.json"), JSON.stringify([{ ...row(LOCAL_DONE, "done"), source: null }]));
}

function project(code: string) {
  return { code, defaultWorkspace: "dir" as const, baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, parallel: true };
}

function config(): KanbanConfig {
  const value = loadConfig();
  value.projects = { [PROJECT]: project("WTP"), [OTHER]: project("OTH") };
  value.supervisors = { [PROJECT]: LEADER, [OTHER]: OTHER_LEADER };
  value.supervisorAgentId = KANBAN;
  value.autoStart = { [PROJECT]: true, [OTHER]: true };
  value.concurrency = { ...DEFAULT_CONCURRENCY, global: 4 };
  saveConfig(value);
  return value;
}

beforeEach(() => {
  resetMergeCache();
  ghCalls = 0;
  setGhRunner(async () => { ghCalls++; throw new Error("wait-user must not query gh"); });
  rmSync(agents, { recursive: true, force: true });
  mkdirSync(agents, { recursive: true });
  config();
  for (const id of [LEADER, OTHER_LEADER, KANBAN]) writeAgent(id);
  writeAgent(SCHEDULE, { "paseo.schedule-id": "sched-1" });
  writeDecisions();
  getDb().exec("DELETE FROM events; DELETE FROM start_claims; DELETE FROM tasks; DELETE FROM links; DELETE FROM runs; DELETE FROM tokens;");
});

after(() => {
  resetMergeCache();
  setGhRunner(null);
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const env = (id: string) => ({ PASEO_AGENT_ID: id });

function readyCard(proj = PROJECT): number {
  return createTask({ project: proj, title: "Pause pending", role: "executor", workspacePath: root }).id;
}

async function tick(): Promise<{ created: number; started: number[]; nudged: number }> {
  let created = 0;
  let nudged = 0;
  const result = await runTick({
    profiles, config: config(), matrix: { state: "missing" },
    pools: { state: "fresh", generatedAt: new Date().toISOString(), updatedAt: null, ageMs: 0, message: zhCNPart("compat.name.offlineTest", 2, 4),
      dispatchable: () => true, entry: () => ({ ...openEntry(), dispatchable: true }) },
    launcher: { async create() { created++; return { id: "test-agent" }; }, async send() { nudged++; } },
    agentState: () => "alive",
  });
  return { created, started: result.started, nudged };
}

const kinds = (id: number) => (getDb().prepare("SELECT kind FROM events WHERE task_id = ? ORDER BY id").all(id) as Array<{ kind: string }>).map((row) => row.kind);

function mockPrepare(db: { prepare: (sql: string) => unknown }, impl: (sql: string) => unknown) {
  return mock.method(db, "prepare", impl);
}

function mockExec(db: { exec: (sql: string) => unknown }, impl: (sql: string) => unknown) {
  return mock.method(db, "exec", impl);
}
const decisionText = localePattern(zhCNPart("waitUser.decisionRequired", 15, 20));
const holdFor = (decision: string) => zhCN("waitUser.hold", { decision });

function humanCard(): number {
  const id = readyCard();
  blockTask(id, "needs_human", "fixture decision", "supervisor");
  return id;
}

/** An already admitted child, before the leader temporarily blocked it for a decision. */
function humanCardWithPrParent(from = "ready", parentStatus = "done"): { id: number; parent: number } {
  const parent = readyCard();
  getDb().prepare("UPDATE tasks SET status = ?, contract_json = ? WHERE id = ?")
    .run(parentStatus, JSON.stringify({ kind: "github", repo: "fixture/repo", pr: PARENT_PR }), parent);
  const id = createTask({ project: PROJECT, title: "admitted child with PR parent", role: "executor", workspacePath: root, parentIds: [parent] }).id;
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(from, id);
  blockTask(id, "needs_human", "fixture decision", "supervisor");
  assert.equal(getTask(id).blocked_from, from);
  return { id, parent };
}

/** Guard fresh CLI and scheduler processes: record any attempted gh invocation locally. */
function noGhProcessEnv(): { env: NodeJS.ProcessEnv; log: string } {
  const bin = mkdtempSync(join(root, "no-gh-"));
  const log = join(bin, "calls");
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nappendFileSync(${JSON.stringify(log)}, "gh called\\n");\nprocess.exit(91);\n`, { mode: 0o755 });
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PASEO_AGENT_ID: LEADER, KANBAN_LANGUAGE: "zh-CN" }, log };
}

function cliWait(id: number, extra: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [join(repoRoot, "bin/paseo-kanban.mjs"), "wait-user", String(id), ...extra, "--json"], {
    cwd: repoRoot, env, encoding: "utf8",
  });
}

describe("atomic needs_human wait-user", () => {
  it("does not bypass a real parent or unmerged-PR dependency hidden behind a human block", () => {
    const parent = readyCard();
    const id = createTask({ project: PROJECT, title: "human block with parent", role: "executor", workspacePath: root, parentIds: [parent] }).id;
    assert.equal(getTask(id).status, "waiting");
    blockTask(id, "needs_human", "fixture decision", "supervisor");
    const before = getTask(id);
    const links = getDb().prepare("SELECT * FROM links WHERE task_id = ?").all(id);
    assert.throws(() => waitUser(id, OPEN, "supervisor"), { code: "not_ready" });
    assert.deepEqual(getTask(id), before);
    getDb().prepare("UPDATE tasks SET status = 'done', contract_json = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "github", repo: "fixture/repo", pr: PARENT_PR }), parent);
    assert.throws(() => waitUser(id, OPEN, "supervisor"), { code: "not_ready" });
    assert.deepEqual(getTask(id), before);
    getDb().prepare("UPDATE tasks SET contract_json = ? WHERE id = ?").run(JSON.stringify({ kind: "local-only" }), parent);
    assert.equal(waitUser(id, OPEN, "supervisor").wait_decision, OPEN);
    assert.deepEqual(getDb().prepare("SELECT * FROM links WHERE task_id = ?").all(id), links);
    assert.equal(ghCalls, 0);
  });

  it("accepts one cold-cache CLI invocation for an admitted child with a done PR parent and audits blocked to ready", async () => {
    const { id } = humanCardWithPrParent();
    assert.equal(cachedMergeState(PARENT_PR), null);
    assert.equal(loadConfig().autoStart[PROJECT], true);
    const noGh = noGhProcessEnv();
    const db = getDb();
    db.prepare("UPDATE tasks SET fail_count = 2, executor_family = 'openai', review_round = 2 WHERE id = ?").run(id);
    const history = kinds(id);
    const result = cliWait(id, ["--decision", OPEN], noGh.env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const task = getTask(id);
    assert.equal(task.status, "ready");
    assert.equal(task.wait_decision, OPEN);
    assert.equal(task.hold_reason, holdFor(OPEN));
    for (const key of ["blocked_kind", "blocked_reason", "blocked_from", "blocked_at"] as const) assert.equal(task[key], null);
    assert.equal(task.fail_count, 2);
    assert.equal(task.executor_family, "openai");
    assert.equal(task.review_round, 2);
    assert.deepEqual(kinds(id), [...history, "wait_user"]);
    const event = db.prepare("SELECT from_status, to_status, data_json FROM events WHERE task_id = ? AND kind = 'wait_user'").get(id) as { from_status: string; to_status: string; data_json: string };
    assert.equal(event.from_status, "blocked");
    assert.equal(event.to_status, "ready");
    assert.equal(JSON.parse(event.data_json).decision, OPEN);
    assert.equal(existsSync(noGh.log), false, "fresh CLI never invokes gh");
    assert.equal(ghCalls, 0);
    assert.deepEqual(await tick(), { created: 0, started: [], nudged: 0 });
  });

  it("allows cold-cache handler conversion after leaving waiting only when every parent status is satisfied", async () => {
    for (const parentStatus of ["done", "archived", "triage"]) {
      for (const from of ["ready", "running", "reviewing", "in_review", "rework"]) {
        const { id } = humanCardWithPrParent(from, parentStatus);
        const links = getDb().prepare("SELECT * FROM links WHERE task_id = ?").all(id);
        assert.equal(cachedMergeState(PARENT_PR), null);
        await handleTool("kanban_wait_user", { id, decision: OPEN }, null, resolveCliIdentity(env(LEADER)));
        assert.equal(getTask(id).status, "ready", `${parentStatus}/${from}`);
        assert.equal(getTask(id).wait_decision, OPEN);
        assert.deepEqual(getDb().prepare("SELECT * FROM links WHERE task_id = ?").all(id), links);
      }
    }
    for (const parentStatus of ["ready", "waiting", "blocked", "running", "reviewing", "in_review", "rework", "acceptance"]) {
      const { id } = humanCardWithPrParent("ready", parentStatus);
      const before = getTask(id);
      const events = kinds(id);
      await assert.rejects(() => handleTool("kanban_wait_user", { id, decision: OPEN }, null, resolveCliIdentity(env(LEADER))), { code: "not_ready" });
      assert.deepEqual(getTask(id), before);
      assert.deepEqual(kinds(id), events);
    }
    assert.equal(ghCalls, 0);
  });

  it("still refuses an admitted child when the cache explicitly says its parent's PR is unmerged", async () => {
    for (const state of ["OPEN", "CLOSED"]) {
      resetMergeCache();
      await prMergeState(PARENT_PR, { run: async () => JSON.stringify({ state, mergedAt: null }) });
      assert.equal(cachedMergeState(PARENT_PR)?.merged, false);
      for (const parentStatus of ["done", "archived", "triage"]) {
        const { id } = humanCardWithPrParent("ready", parentStatus);
        const before = getTask(id);
        const events = kinds(id);
        await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", OPEN], env(LEADER)), { code: "not_ready" });
        assert.deepEqual(getTask(id), before);
        assert.deepEqual(kinds(id), events);
      }
    }
    assert.equal(ghCalls, 0);
  });

  it("rolls back both ready and blocked paths when event insertion fails", async () => {
    for (const id of [readyCard(), humanCard()]) {
      const db = getDb();
      const before = getTask(id);
      const events = kinds(id);
      db.exec("CREATE TEMP TRIGGER fail_wait_event BEFORE INSERT ON events WHEN NEW.kind = 'wait_user' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
      try {
        await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", OPEN], env(LEADER)), /injected event failure/);
      } finally {
        db.exec("DROP TRIGGER fail_wait_event");
      }
      assert.deepEqual(getTask(id), before);
      assert.deepEqual(kinds(id), events);
    }
  });

  it("a second SQLite connection sees blocked during event insertion and ready plus hold only after commit", async () => {
    const id = humanCard();
    const db = getDb();
    const reader = new DatabaseSync(join(process.env.KANBAN_DATA_DIR!, "kanban.db"), { readOnly: true });
    const prepare = db.prepare.bind(db);
    let observed = false;
    const hooked = mockPrepare(db, (sql: string) => {
      if (sql.includes("INSERT INTO events")) {
        const row = reader.prepare("SELECT status, wait_decision FROM tasks WHERE id = ?").get(id) as { status: string; wait_decision: string | null };
        assert.equal(row.status, "blocked");
        assert.equal(row.wait_decision, null);
        assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'ready' AND wait_decision IS NULL").get() as { n: number }).n, 0);
        observed = true;
      }
      return prepare(sql);
    });
    try {
      await runKanban(["wait-user", String(id), "--decision", OPEN], env(LEADER));
      assert.ok(observed, "observed the event write before commit");
      const row = reader.prepare("SELECT status, wait_decision FROM tasks WHERE id = ?").get(id) as { status: string; wait_decision: string | null };
      assert.equal(row.status, "ready");
      assert.equal(row.wait_decision, OPEN);
    } finally { hooked.mock.restore(); reader.close(); }
  });

  it("validates even direct helper ids before mutation", () => {
    const id = readyCard();
    const before = getTask(id);
    assert.throws(() => waitUser(id, "bad", "supervisor"), new RegExp(decisionText));
    assert.deepEqual(getTask(id), before);
  });

  it("rejects malformed ids and unauthorized CLI or handler identities before any state write", async () => {
    const id = humanCard();
    const worker = readyCard();
    getDb().prepare("UPDATE tasks SET agent_id = 'fixture-worker' WHERE id = ?").run(worker);
    const before = getTask(id);
    const history = kinds(id);
    const token = issueToken("executor", worker, "fixture-worker");
    for (const caller of [env(OTHER_LEADER), env("fixture-worker"), { KANBAN_TOKEN: token }]) {
      await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", OPEN], caller));
    }
    for (const agentId of [OTHER_LEADER, "fixture-worker"]) {
      await assert.rejects(() => handleTool("kanban_wait_user", { id, decision: OPEN }, null, resolveCliIdentity(env(agentId))));
    }
    await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", "invalid"], env(LEADER)), new RegExp(decisionText));
    assert.deepEqual(getTask(id), before);
    assert.deepEqual(kinds(id), history);
    await handleTool("kanban_wait_user", { id, decision: OPEN }, null, resolveCliIdentity(env(KANBAN)));
    assert.equal(getTask(id).wait_decision, OPEN);
  });

  it("refuses all other block kinds and all other statuses without changing holds or history", () => {
    for (const kind of ["dependency", "capability", "quota", "rate_limit", "transient", null]) {
      const id = humanCard();
      getDb().prepare("UPDATE tasks SET blocked_kind = ? WHERE id = ?").run(kind, id);
      const before = getTask(id);
      assert.throws(() => waitUser(id, OPEN, "supervisor"), { code: "illegal_transition" });
      assert.deepEqual(getTask(id), before);
    }
    for (const status of ["draft", "waiting", "triage", "running", "in_review", "reviewing", "rework", "acceptance", "done", "archived"]) {
      const id = readyCard();
      getDb().prepare("UPDATE tasks SET status = ?, hold_reason = 'existing hold' WHERE id = ?").run(status, id);
      const before = getTask(id);
      assert.throws(() => waitUser(id, OPEN, "supervisor"), { code: "illegal_transition" });
      assert.deepEqual(getTask(id), before);
    }
  });

  it("is idempotent for the same decision and preserves a different existing decision", () => {
    const id = humanCard();
    waitUser(id, OPEN, "supervisor");
    const before = getTask(id);
    const history = kinds(id);
    assert.deepEqual(waitUser(id, OPEN, "supervisor"), before);
    assert.throws(() => waitUser(id, DONE, "supervisor"), { code: "conflict" });
    assert.deepEqual(getTask(id), before);
    assert.deepEqual(kinds(id), history);
    blockTask(id, "needs_human", "another human block", "supervisor");
    const blocked = getTask(id);
    assert.throws(() => waitUser(id, DONE, "supervisor"), { code: "conflict" });
    assert.deepEqual(getTask(id), blocked);
    assert.equal(waitUser(id, OPEN, "supervisor").wait_decision, OPEN);
  });

  it("rolls back the transition, inserted event and leader tag changes when a later event fails", async () => {
    const id = humanCard();
    const db = getDb();
    db.prepare("UPDATE tasks SET tags = ? WHERE id = ?").run(JSON.stringify(["leader-unresponsive"]), id);
    const before = getTask(id);
    const history = kinds(id);
    db.exec("CREATE TEMP TRIGGER fail_responsive BEFORE INSERT ON events WHEN NEW.kind = 'leader_responsive' BEGIN SELECT RAISE(ABORT, 'injected later event failure'); END");
    try {
      await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", OPEN], env(LEADER)), /injected later event failure/);
    } finally { db.exec("DROP TRIGGER fail_responsive"); }
    assert.deepEqual(getTask(id), before);
    assert.deepEqual(kinds(id), history);
  });

  it("does not clear a blocked start claim, resumable agent, runs, cleanup generation or review linkage", () => {
    const id = humanCard();
    const claim = acquireStartClaim(id)!;
    const before = getTask(id);
    assert.throws(() => waitUser(id, OPEN, "supervisor"), { code: "conflict" });
    assert.ok(holdsStartClaim(id, claim));
    assert.deepEqual(getTask(id), before);
    releaseStartClaim(id, claim);
    writeAgent("fixture-assigned");
    getDb().prepare("UPDATE tasks SET agent_id = 'fixture-assigned', executor_agent_id = 'fixture-executor', executor_family = 'openai', blocked_from = 'running', review_of = 77, fail_count = 3 WHERE id = ?").run(id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at) VALUES (?, 'fixture-assigned', 'executor', ?)").run(id, new Date().toISOString());
    appendEvent(id, "cleanup", null, null, "kanban", { action: "verify_agent", generation: 4 });
    const active = getTask(id);
    const runs = getDb().prepare("SELECT * FROM runs WHERE task_id = ?").all(id);
    const events = getDb().prepare("SELECT * FROM events WHERE task_id = ?").all(id);
    for (const from of ["running", "reviewing"]) {
      getDb().prepare("UPDATE tasks SET blocked_from = ? WHERE id = ?").run(from, id);
      assert.throws(() => waitUser(id, OPEN, "supervisor"), { code: "conflict" });
    }
    rmSync(join(agents, "Users-test-repo", "fixture-assigned.json"));
    const converted = waitUser(id, OPEN, "supervisor");
    for (const key of ["agent_id", "executor_agent_id", "executor_family", "review_of", "fail_count"] as const) assert.equal(converted[key], active[key]);
    assert.deepEqual(getDb().prepare("SELECT * FROM runs WHERE task_id = ?").all(id), runs);
    assert.deepEqual(getDb().prepare("SELECT * FROM events WHERE task_id = ? AND kind != 'wait_user'").all(id), events);
  });

  it("rechecks state changed by a second connection after authorization but before the transaction", async () => {
    const db = getDb();
    const second = new DatabaseSync(join(process.env.KANBAN_DATA_DIR!, "kanban.db"));
    const exec = db.exec.bind(db);
    let mutate: (() => void) | null = null;
    const hooked = mockExec(db, (sql: string) => {
      if (sql === "BEGIN IMMEDIATE" && mutate) { const action = mutate; mutate = null; action(); }
      return exec(sql);
    });
    try {
      for (const [status, kind] of [["running", "needs_human"], ["reviewing", "needs_human"], ["blocked", "dependency"]]) {
        const id = humanCard();
        mutate = () => { second.prepare("UPDATE tasks SET status = ?, blocked_kind = ? WHERE id = ?").run(status, kind, id); };
        await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", OPEN], env(LEADER)), { code: "illegal_transition" });
        assert.equal(getTask(id).status, status);
        assert.equal(getTask(id).wait_decision, null);
        assert.ok(!kinds(id).includes("wait_user"));
      }
      const id = humanCard();
      mutate = () => { second.prepare("INSERT INTO start_claims (task_id, token, pid, at) VALUES (?, 'other-start', ?, ?)").run(id, process.pid, new Date().toISOString()); };
      await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", OPEN], env(LEADER)), { code: "conflict" });
      assert.ok(holdsStartClaim(id, "other-start"));
    } finally { hooked.mock.restore(); second.close(); }
  });

  it("preserves a ready start claim while preventing launch, and refuses wait after running is claimed", async () => {
    const id = readyCard();
    const claim = acquireStartClaim(id)!;
    waitUser(id, OPEN, "supervisor");
    assert.ok(holdsStartClaim(id, claim));
    releaseStartClaim(id, claim);
    await runKanban(["unwait", String(id)], env(LEADER));
    let created = 0;
    await startTask(id, { async create() {
      created++;
      assert.throws(() => waitUser(id, OPEN, "supervisor"), { code: "illegal_transition" });
      return { id: "fixture-running" };
    }, async send() {} }, "scheduler", { profiles, chosen: profiles[0], reason: "fixture" });
    assert.equal(created, 1);
    assert.equal(getTask(id).status, "running");
  });

  it("serializes independent CLI wait and unblock requests without losing the hold", async (context) => {
    const id = humanCard();
    const invoke = (command: string, extra: string[] = []) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(repoRoot, "bin/paseo-kanban.mjs"), command, String(id), ...extra, "--json"], {
        cwd: repoRoot, env: { ...process.env, PASEO_AGENT_ID: LEADER, KANBAN_LANGUAGE: "zh-CN" },
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, output }));
    });
    const [wait, unblock, repeat] = await Promise.all([
      invoke("wait-user", ["--decision", OPEN]),
      invoke("unblock"),
      invoke("wait-user", ["--decision", OPEN]),
    ]);
    assert.equal(wait.code, 0, wait.output);
    assert.equal(repeat.code, 0, repeat.output);
    // A lost unblock update is serialized: the catalog conflict text has no status word.
    const serializedUnblock = new RegExp([
      "blocked",
      localePattern(zhCN("labels.status.blocked")),
      localePattern(zhCNPart("taskLifecycle.error.statusChanged", 10)),
    ].join("|"));
    assert.ok(unblock.code === 0 || serializedUnblock.test(unblock.output), unblock.output);
    if (unblock.code !== 0 && unblock.output.includes(zhCNPart("taskLifecycle.error.statusChanged", 10))) {
      context.diagnostic("serialized unblock lost-update conflict; the decision hold stays");
    }
    assert.equal(getTask(id).status, "ready");
    assert.equal(getTask(id).wait_decision, OPEN);
    assert.equal(kinds(id).filter(kind => kind === "wait_user").length, 1);
    assert.deepEqual(await tick(), { created: 0, started: [], nudged: 0 });
    assert.throws(() => unblockTask(id, "supervisor"), { code: "illegal_transition" });
  });

  it("keeps autoStart true with a cold PR cache and an independent process ticking before, during and after the CLI commit", async (context) => {
    const { id } = humanCardWithPrParent();
    assert.equal(cachedMergeState(PARENT_PR), null);
    assert.equal(loadConfig().autoStart[PROJECT], true);
    const noGh = noGhProcessEnv();
    const child = fork(fileURLToPath(new URL("./helpers/wait-user-scheduler.ts", import.meta.url)), [String(id)], {
      cwd: repoRoot, env: noGh.env, execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    type Sample = { kind: string; created?: number; before?: { status: string; decision: string | null }; after?: { status: string; decision: string | null }; started?: number[]; message?: string };
    const samples: Sample[] = [];
    let output = "";
    child.stdout!.on("data", chunk => { output += chunk; });
    child.stderr!.on("data", chunk => { output += chunk; });
    child.on("message", message => { samples.push(message as Sample); });
    const closed = new Promise<number | null>(resolve => child.on("close", resolve));
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!check()) {
        assert.ok(!samples.some(row => row.kind === "error"), JSON.stringify(samples));
        assert.ok(Date.now() < deadline, output + JSON.stringify(samples));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    try {
      await until(() => samples.some(row => row.kind === "ready"));
      child.send("loop");
      await until(() => samples.filter(row => row.kind === "tick").length >= 3);
      const cli = spawn(process.execPath, [join(repoRoot, "bin/paseo-kanban.mjs"), "wait-user", String(id), "--decision", OPEN, "--json"], { cwd: repoRoot, env: noGh.env });
      cli.stdout.on("data", chunk => { output += chunk; });
      cli.stderr.on("data", chunk => { output += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { cli.on("error", reject); cli.on("close", resolve); });
      assert.equal(code, 0, output);
      await until(() => samples.filter(row => row.kind === "tick" && row.after?.decision === OPEN).length >= 10);
      child.send("stop");
      assert.equal(await closed, 0, output);
      const ticks = samples.filter(row => row.kind === "tick");
      for (const row of ticks) {
        assert.equal(row.created, 0);
        assert.deepEqual(row.started, []);
        for (const observation of [row.before!, row.after!]) {
          assert.ok(observation.status === "blocked" || (observation.status === "ready" && observation.decision === OPEN), JSON.stringify(row));
        }
      }
      context.diagnostic(`independent SQLite scheduler: ${ticks.length} ticks, cold CLI PR cache, done PR parent, blocked_from=ready, autoStart=true, create=0, no ready-without-hold samples`);
      await runKanban(["unwait", String(id)], env(LEADER));
      assert.deepEqual((await tick()).started, [id]);
      assert.equal(getTask(id).status, "running");
      assert.equal(existsSync(noGh.log), false, "CLI and scheduler never invoke gh");
    } finally {
      if (child.exitCode === null) { child.kill(); await closed; }
    }
  });
});

describe("wait-user / unwait", () => {
  it("keeps the card ready, shows sample, and the scheduler neither starts nor nudges it", async () => {
    const id = readyCard();
    await runKanban(["wait-user", String(id), "--decision", DONE], env(LEADER));
    const waiting = getTask(id);
    assert.equal(waiting.status, "ready");
    assert.equal(waiting.hold_reason, `${zhCNPart("waitUser.hold", 0, 4)}${DONE}`);
    assert.ok(kinds(id).includes("wait_user"));
    const first = await tick();
    assert.deepEqual(first, { created: 0, started: [], nudged: 0 });
    assert.equal(getTask(id).status, "ready");
    assert.equal(getTask(id).hold_reason, `${zhCNPart("waitUser.hold", 0, 4)}${DONE}`);
    const listed = (await runKanban(["list", "--project", PROJECT], env(LEADER))) as { tasks: Array<{ id: number; nextStep: string | null }> };
    assert.match(listed.tasks.find((task) => task.id === id)?.nextStep ?? "", new RegExp(`${zhCNPart("waitUser.hold", 0, 4)}${DONE}`));
  });

  it("starts again after unwait and records wait_user_cleared", async () => {
    const id = readyCard();
    await runKanban(["wait-user", String(id), "--decision", DONE], env(LEADER));
    await tick();
    await runKanban(["unwait", String(id)], env(LEADER));
    assert.ok(kinds(id).includes("wait_user_cleared"));
    assert.equal(getTask(id).hold_reason, null);
    const after = await tick();
    assert.deepEqual(after.started, [id]);
    assert.equal(getTask(id).status, "running");
  });

  it("accepts both id formats: the cockpit's d-ids and the board's own k-ids", async () => {
    for (const good of [DONE, LOCAL_DONE]) assert.equal(parseDecisionId(` ${good} `), good);
    const id = readyCard();
    await runKanban(["wait-user", String(id), "--decision", LOCAL_DONE], env(LEADER));
    assert.equal(getTask(id).wait_decision, LOCAL_DONE);
    assert.ok(kinds(id).includes("wait_user"));
  });

  it("rejects a decision id that is not [dk]0000-000000-N", async () => {
    const id = readyCard();
    for (const bad of ["abc", "d1005-91216-1", "d1005-091216-", "x1005-091216-1", "k1005-91216-1", "dk1005-091216-1"]) {
      await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", bad], env(LEADER)), new RegExp(localePattern(zhCNPart("waitUser.decisionRequired", 15, 20))));
    }
    await assert.rejects(() => runKanban(["wait-user", String(id)], env(LEADER)), /--decision/);
    assert.equal(getTask(id).hold_reason, null);
  });

  it("is limited to the project's <leader> or the Kanban <leader>", async () => {
    const id = readyCard();
    await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", DONE], env(OTHER_LEADER)), new RegExp(localePattern(zhCNPart("doctor.safety.unsafe", 0, 2)) + ".*" + localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", DONE], env(SCHEDULE)), new RegExp(localePattern(zhCNPart("leaderRegistry.error.schedule", 0, 4))));
    writeAgent("stranger");
    await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", DONE], env("stranger")), new RegExp(localePattern(zhCNPart("cardParts.event.registered", 1, 3))));
    await assert.rejects(() => runKanban(["unwait", String(id)], env(OTHER_LEADER)), new RegExp(localePattern(zhCNPart("doctor.safety.unsafe", 0, 2)) + ".*" + localePattern(zhCNPart("doctorConfig.code.global", 14, 18))));
    assert.equal(getTask(id).hold_reason, null);
    await runKanban(["wait-user", String(id), "--decision", DONE], env(KANBAN));
    assert.equal(getTask(id).hold_reason, `${zhCNPart("waitUser.hold", 0, 4)}${DONE}`);
  });

  it("does not open an agent when wait-user lands while a start is already in flight", async () => {
    const id = readyCard();
    let created = 0;
    const launcher = {
      async create() { created++; return { id: "raced-agent" }; },
      async send() {},
      async listWorkspaces() {
        waitUser(id, DONE, "supervisor");
        return [{ id: "main-ws", name: "main", directory: root, projectRoot: root, projectId: "p", kind: "local_checkout", archived: false }];
      },
    };
    await assert.rejects(() => startTask(id, launcher, "scheduler", { profiles: [profiles[0]], chosen: profiles[0], reason: "Test" }), new RegExp(localePattern(zhCNPart("tools.action.waitUser", 1, 4))));
    assert.equal(created, 0);
    assert.equal(getTask(id).status, "ready");
    assert.equal(getTask(id).wait_decision, DONE);
  });

  it("scheduler skips quietly when wait-user lands during the start window, and starts after unwait (TEST_0258)", async () => {
    const id = readyCard();
    let created = 0;
    let drop = true;
    const launcher = {
      async create() { created++; return { id: "test-agent" }; },
      async send() {},
      async listWorkspaces() {
        if (drop) { drop = false; waitUser(id, DONE, "supervisor"); }
        return [{ id: "main-ws", name: "main", directory: root, projectRoot: root, projectId: "p", kind: "local_checkout", archived: false }];
      },
    };
    const run = () => runTick({
      profiles, config: config(), matrix: { state: "missing" },
      pools: { state: "fresh", generatedAt: new Date().toISOString(), updatedAt: null, ageMs: 0, message: zhCNPart("compat.name.offlineTest", 2, 4),
        dispatchable: () => true, entry: () => ({ ...openEntry(), dispatchable: true }) },
      launcher, agentState: () => "alive",
    });
    const first = await run();
    assert.deepEqual(first.started, []);
    assert.ok(!first.held.some((item) => item.id === id && new RegExp(localePattern(zhCNPart("dispatch.waitingUser", 3, 7))).test(item.reason)));
    assert.equal(created, 0);
    assert.ok(!kinds(id).includes("start_failed"));
    assert.ok(!kinds(id).includes("start_transient"));
    assert.equal(getTask(id).status, "ready");
    assert.equal(getTask(id).wait_decision, DONE);
    assert.equal(getTask(id).hold_reason, `${zhCNPart("waitUser.hold", 0, 4)}${DONE}`);
    await runKanban(["unwait", String(id)], env(LEADER));
    const second = await run();
    assert.deepEqual(second.started, [id]);
    assert.equal(getTask(id).status, "running");
  });

  it("refuses a manual start while waiting", async () => {
    const id = readyCard();
    waitUser(id, DONE, "supervisor");
    const launcher = { async create() { throw new Error("must not open"); }, async send() {} };
    await assert.rejects(() => startTask(id, launcher, "supervisor", { profiles: [profiles[0]], chosen: profiles[0], reason: "Test" }), /unwait/);
  });

  it("only applies to a ready card", async () => {
    const id = readyCard();
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id);
    await assert.rejects(() => runKanban(["wait-user", String(id), "--decision", DONE], env(LEADER)), new RegExp("ready|" + zhCN("labels.status.ready")));
  });

  it("documents wait-user in the help text", async () => {
    const help = (await runKanban(["help"], env(LEADER))) as string;
    assert.match(help, /wait-user/);
    assert.match(help, /unwait/);
    assert.match(help, /wait-user.*block/);
  });
});

describe("EX reminder guard on create", () => {
  const create = (id: string, extra: string[] = [], title = zhCNPart("restartStall.call.send", 4, 6)) =>
    runKanban(["create", "--project", PROJECT, "--title", title, "--role", "reader", "--workspace", root, "--brief", "x", ...extra], env(id));

  it("rejects a schedule agent without --decision", async () => {
    await assert.rejects(() => create(SCHEDULE), /--decision/);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 0);
  });

  it("accepts a schedule agent citing a decided sample and records it", async () => {
    const card = (await create(SCHEDULE, ["--decision", DONE])) as { id: number };
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'created'").get(card.id) as { data_json: string };
    assert.equal(JSON.parse(row.data_json).decision, DONE);
  });

  it("rejects an open, missing, malformed decision or an unreadable file", async () => {
    await assert.rejects(() => create(SCHEDULE, ["--decision", OPEN]), new RegExp(zhCN("relatedView.tier.unset") + "|" + localePattern(zhCNPart("waitUser.notDecided", 17, 21)) + "|open"));
    await assert.rejects(() => create(SCHEDULE, ["--decision", MISSING]), new RegExp(zhCN("missingCwd.report.missing") + "|" + localePattern(zhCNPart("boardCards.reviewed.missing", 1, 4))));
    await assert.rejects(() => create(SCHEDULE, ["--decision", "nope"]), new RegExp(localePattern(zhCNPart("waitUser.decisionRequired", 15, 20))));
    rmSync(join(roles, "decisions.json"));
    await assert.rejects(() => create(SCHEDULE, ["--decision", DONE]), new RegExp(localePattern(zhCNPart("doctor.matrix.unknown", 4, 7)) + "|" + zhCN("missingCwd.report.missing") + "|" + localePattern(zhCNPart("boardCards.reviewed.missing", 1, 4))));
  });

  it("also guards a card whose title or brief says EX sample, whoever creates it", async () => {
    await assert.rejects(() => create(LEADER, [], (zhCNPart("waitUser.reminderNeedsDecision", 0, 8) + zhCN("common.colon") + zhCNPart("boardView.tab.attention", 1, 3) + zhCNPart("decisions.readFailed", 0, 3))), /--decision/);
    await assert.rejects(() => runKanban(["create", "--project", PROJECT, "--title", zhCNPart("tempWorkspace.placeholder.notDirectory", 6, 8), "--role", "reader", "--workspace", root, "--brief", (zhCNPart("missingCwd.purge.source", 20, 22) + " " + zhCNPart("waitUser.reminderNeedsDecision", 0, 8))], env(LEADER)), /--decision/);
    const ok = (await create(LEADER, ["--decision", DONE], (zhCNPart("waitUser.reminderNeedsDecision", 0, 8) + zhCN("common.colon") + zhCNPart("boardView.tab.attention", 1, 3) + zhCNPart("decisions.readFailed", 0, 3)))) as { id: number };
    assert.ok(ok.id > 0);
  });

  it("leaves an ordinary <leader> unaffected, and --decision is optional but recorded", async () => {
    const plain = (await create(LEADER)) as { id: number };
    assert.ok(plain.id > 0);
    const withDecision = (await create(LEADER, ["--decision", OPEN])) as { id: number };
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'created'").get(withDecision.id) as { data_json: string };
    assert.equal(JSON.parse(row.data_json).decision, OPEN);
    await assert.rejects(() => create(LEADER, ["--decision", "bad"]), new RegExp(localePattern(zhCNPart("waitUser.decisionRequired", 15, 20))));
  });
});

describe("kanban_create tool contract", () => {
  const scheduleIdentity = () => resolveCliIdentity(env(SCHEDULE));
  const args = (extra: Record<string, unknown> = {}) => ({ project: PROJECT, title: "demo fixture", role: "reader", workspace: root, brief: "x", ...extra });

  it("declares decision in the MCP schema and explains the guard", () => {
    const def = toolDefs().find((tool) => tool.name === "kanban_create")!;
    const decision = (def.inputSchema as { properties: Record<string, { description?: string }> }).properties.decision;
    assert.match(decision.description ?? "", /d1005-091216-1/);
    assert.match(decision.description ?? "", /decisions\.json/);
    assert.match(decision.description ?? "", /\bdone\b/);
    assert.ok(toolDefs().some((tool) => tool.name === "kanban_wait_user"));
  });

  it("enforces the guard through handleTool, not only the CLI", async () => {
    await assert.rejects(() => handleTool("kanban_create", args(), null, scheduleIdentity()), new RegExp("--decision|" + localePattern(zhCNPart("decisions.readFailed", 0, 3))));
    await assert.rejects(() => handleTool("kanban_create", args({ decision: OPEN }), null, scheduleIdentity()), new RegExp(zhCN("relatedView.tier.unset") + "|" + localePattern(zhCNPart("waitUser.notDecided", 17, 21))));
    const ok = (await handleTool("kanban_create", args({ decision: DONE }), null, scheduleIdentity())) as { id: number };
    assert.ok(ok.id > 0);
  });
});
