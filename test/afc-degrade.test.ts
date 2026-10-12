/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
// The board without (or with a broken) fleet cockpit: every contract state (fresh, stale, invalid,
// absent) against dispatch, decisions and doctor. Fake data only; every path is a temp directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { cockpitHealth } from "../server/afc-sources";
import { loadConfig, saveConfig, doctorSettings } from "../server/config";
import { envelopeFor } from "../server/contract";
import { closeDb, getDb } from "../server/db";
import {
  addDecision, decisionBackend, decisionBoardExtras, DECISIONS_NOT_INSTALLED_MESSAGE, decisionsReadMessage,
  doneDecision, findDecision, listDecisions, readOpenDecisions, setDecideExec, waitingOnDecision,
} from "../server/decisions";
import { runDoctor, type DoctorBoard, type DoctorReport } from "../server/doctor";
import { addLocalDecision, listLocalDecisions, localDecisionsPath, nextDecisionId, runDecideCli } from "../server/local-decisions";
import { readCompatibilityDispatchMatrix as loadDispatchMatrix } from "../server/matrix";
import { poolsAbsentMessage, readCompatibilityPoolSnapshot as readPoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile } from "../server/routing";
import { resetReconcileForTests } from "../server/schedule";
import { runTick } from "./helpers/compat-schedule";
import { createTask, getTask } from "../server/store";
import { resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";
import { assertDecisionDecided } from "../server/wait-user";

const KEYS = [
  "PASEO_HOME", "KANBAN_DATA_DIR", "AFC_DATA_DIR", "AFC_LEGACY_DATA_DIR", "ROLES_STATE_DIR", "KANBAN_POOL_STATUS",
  "KANBAN_DISPATCH_MATRIX", "KANBAN_PASEO_CONFIG",
] as const;
const saved: Record<string, string | undefined> = {};
const root = mkdtempSync(join(tmpdir(), "ex-degrade-"));
let home: string;
let exportsDir: string;
let cockpitDir: string;

const MINUTE = 60_000;
const claude: Profile = { id: "a", name: "Executor A", role: "executor", family: "anthropic", provider: "claude", model: "claude-opus-5-5", pool: "claude-max" };
const grok: Profile = { id: "b", name: "Executor B", role: "candidate", candidateFor: "executor", family: "xai", provider: "grok", model: "grok-4.7", pool: "supergrok" };
const gpt: Profile = { id: "c", name: "Executor C", role: "candidate", candidateFor: "executor", family: "openai", provider: "codex", model: "gpt-6-astra", pool: "codex-pro" };
const reviewerX: Profile = { id: "rx", name: "Reviewer X", role: "reviewer", family: "xai", provider: "grok", model: "grok-4.7", pool: "review-x" };
const reviewerA: Profile = { id: "ra", name: "Reviewer A", role: "candidate", candidateFor: "reviewer", family: "anthropic", provider: "claude", model: "claude-opus-5-5", pool: "review-a" };
const profiles = [claude, grok, gpt, reviewerX, reviewerA];

/** A fresh, empty "only Kanban installed" home for each test: no cockpit files anywhere. */
beforeEach(() => {
  closeDb();
  resetReconcileForTests();
  home = mkdtempSync(join(root, "home-"));
  cockpitDir = join(home, "board-data", "fleet");
  exportsDir = join(home, "board-data", "exports", "fleet");
  process.env.PASEO_HOME = home;
  process.env.KANBAN_DATA_DIR = join(home, "board-data");
  process.env.KANBAN_PASEO_CONFIG = join(home, "config.json");
  // Standalone runs must not inherit a populated legacy directory when testing an absent cockpit.
  delete process.env.AFC_LEGACY_DATA_DIR;
  delete process.env.AFC_DATA_DIR;
  delete process.env.ROLES_STATE_DIR;
  delete process.env.KANBAN_POOL_STATUS;
  delete process.env.KANBAN_DISPATCH_MATRIX;
  mkdirSync(cockpitDir, { recursive: true });
  setAgentAliveCheck(() => true);
});

afterEach(() => {
  setDecideExec(null);
});

before(() => {
  for (const key of KEYS) saved[key] = process.env[key];
});

after(() => {
  closeDb();
  resetAgentAliveCheck();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function writeExport(file: string, body: Record<string, unknown>, generatedAt = new Date()): void {
  mkdirSync(exportsDir, { recursive: true });
  writeFileSync(join(exportsDir, file), JSON.stringify({ ...body, generatedAt: generatedAt.toISOString() }));
}

function pool(dispatchable: boolean, usedPct: number | null, extra: Record<string, unknown> = {}) {
  return { dispatchable, deprioritize: false, prefer: false, usedPct, resetsAt: null, onlyRoles: null, reason: null, ...extra };
}

function writePools(pools: Record<string, unknown>, generatedAt?: Date): void {
  writeExport("pool-status.json", { ...envelopeFor("poolStatus", "0.0.0"), pools, priority: null }, generatedAt);
}

function writeCockpit(cli: string | null, generatedAt?: Date): void {
  writeExport("cockpit.json", { ...envelopeFor("cockpit", "0.0.0"), dataDir: cockpitDir, cli, features: [] }, generatedAt);
}

function route(snapshot = readPoolSnapshot()) {
  return routeProfile({ profiles, role: "executor", review: false, byPool: {}, poolLimits: {}, snapshot });
}

function picked(decision: ReturnType<typeof routeProfile>): string {
  if (!decision.ok) throw new Error(decision.reason);
  return decision.profile.name;
}

function enableAutoStart(disabledPools: string[] = []): void {
  const config = loadConfig();
  config.autoStart = { demo: true };
  config.disabledPools = disabledPools;
  saveConfig(config);
}

describe("dispatch: pool-status in each contract state", () => {
  it("fresh: follows the export", () => {
    writePools({ "claude-max": pool(false, 90), supergrok: pool(true, 10), "codex-pro": pool(true, 10) });
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.state, "fresh");
    assert.equal(picked(route(snapshot)), grok.name);
  });

  it("stale: drops the old pause, keeps the base order and says how old the data is", () => {
    writePools({ "claude-max": pool(false, 40), supergrok: pool(true, 10, { prefer: true }) }, new Date(Date.now() - 50 * MINUTE));
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.state, "stale");
    const decision = route(snapshot);
    assert.equal(picked(decision), claude.name);
    assert.ok(decision.ok && new RegExp(localePattern(zhCNPart("pools.staleMessage", 4, 7)) + "\\d+ " + localePattern(zhCNPart("pools.staleMessage", 17, 27))).test(decision.reason), "the reason names the age and the base order");
  });

  it("invalid: logged once, then handled exactly like absent", () => {
    mkdirSync(exportsDir, { recursive: true });
    writeFileSync(join(exportsDir, "pool-status.json"), JSON.stringify({ schema: "fleet-quota/v1", producer: "agent-fleet-cockpit" }));
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    let first: ReturnType<typeof readPoolSnapshot>;
    try {
      first = readPoolSnapshot();
      readPoolSnapshot();
    } finally {
      console.error = original;
    }
    assert.equal(logged.filter((line) => line.includes("pool-status.json")).length, 1, "one log line for the same invalid file");
    assert.equal(first.state, "missing");
    assert.equal(first.failure, "invalid");
    assert.match(first.message, /invalid/);
    assert.equal(first.dispatchable("claude-max"), true);
    assert.equal(picked(route(first)), claude.name);
  });

  it("absent: base order with no vendor-specific snapshot requirement", () => {
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.state, "missing");
    assert.equal(snapshot.failure, "absent");
    assert.equal(snapshot.message, poolsAbsentMessage());
    assert.equal(picked(route(snapshot)), claude.name);
    const gptOnly = routeProfile({ profiles: [gpt, reviewerA], role: "executor", review: false, byPool: {}, poolLimits: {}, snapshot });
    assert.equal(gptOnly.ok, true, "a standalone board has no vendor-specific quota requirement");
  });

  it("absent: kanban.config.json disabledPools still stops a pool", () => {
    enableAutoStart(["claude-max"]);
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.dispatchable("claude-max"), false);
    assert.equal(picked(route(snapshot)), grok.name);
  });
});

describe("dispatch: the matrix export in each contract state", () => {
  const body = {
    version: 1,
    defaultTier: "L2",
    downgradeWhenTight: [],
    roles: {
      executor: { L2: [{ profile: claude.name, effort: "high", paused: true }, { profile: grok.name, effort: "high" }] },
      reviewer: { byExecutorFamily: { anthropic: { L2: [{ profile: reviewerX.name }] }, xai: { L2: [{ profile: reviewerA.name }] } } },
    },
  };

  function routeWithMatrix(snapshotState: "fresh" | "absent") {
    if (snapshotState === "fresh") writePools({ "claude-max": pool(true, 10), supergrok: pool(true, 10) });
    process.env.KANBAN_DISPATCH_MATRIX = join(exportsDir, "dispatch-matrix.json");
    const load = loadDispatchMatrix();
    assert.equal(load.state, "ok");
    const matrix = load.state === "ok" ? load.matrix : null;
    return { matrix, decision: routeProfile({ profiles, role: "executor", review: false, byPool: {}, poolLimits: {}, snapshot: readPoolSnapshot(), matrix, tier: "L2" }) };
  }

  it("fresh: honours paused", () => {
    writeExport("dispatch-matrix.json", { ...envelopeFor("dispatchMatrix", "0.0.0"), ...body });
    const { matrix, decision } = routeWithMatrix("fresh");
    assert.equal(matrix?.stale, false);
    assert.equal(picked(decision), grok.name);
  });

  it("stale: ignores paused even with a fresh pool snapshot, and says so", () => {
    writeExport("dispatch-matrix.json", { ...envelopeFor("dispatchMatrix", "0.0.0"), ...body }, new Date(Date.now() - 50 * MINUTE));
    const { matrix, decision } = routeWithMatrix("fresh");
    assert.equal(matrix?.stale, true);
    assert.ok((matrix?.ageMs ?? 0) >= 49 * MINUTE);
    assert.equal(picked(decision), claude.name);
    assert.ok(decision.ok && /dispatch matrix is \d+ minutes stale/.test(decision.reason));
  });

  it("a legacy matrix without an envelope is never stale", () => {
    mkdirSync(exportsDir, { recursive: true });
    writeFileSync(join(exportsDir, "dispatch-matrix.json"), JSON.stringify(body));
    const { matrix, decision } = routeWithMatrix("fresh");
    assert.equal(matrix?.stale, undefined);
    assert.equal(picked(decision), grok.name);
  });

  it("absent: no matrix, the profiles' own order", () => {
    assert.equal(loadDispatchMatrix(Date.now(), join(exportsDir, "dispatch-matrix.json")).state, "missing");
  });
});

describe("only Kanban installed: a new card starts in the base order", () => {
  const launcher = { async create() { return { id: "agent-under-test" }; }, async send() {} };

  it("with no pool-status export at all, the scheduler starts the first executor in the base order", async () => {
    enableAutoStart();
    assert.equal(cockpitHealth().installed, false);
    const workspace = mkdtempSync(join(home, "repo-"));
    const task = createTask({ project: "demo", title: "first card", role: "executor", workspacePath: workspace });
    await runTick({ profiles, launcher, agentState: () => "alive", pools: readPoolSnapshot(), matrix: { state: "missing" } });
    const started = getTask(task.id);
    assert.equal(started.status, "running");
    assert.equal(started.executor_profile, claude.name);
  });

  it("disabledPools moves work to the next available vendor without a cockpit", async () => {
    enableAutoStart(["claude-max", "supergrok"]);
    const workspace = mkdtempSync(join(home, "repo-"));
    const task = createTask({ project: "demo", title: "gpt only", role: "executor", workspacePath: workspace });
    await runTick({ profiles, launcher, agentState: () => "alive", pools: readPoolSnapshot(), matrix: { state: "missing" } });
    const started = getTask(task.id);
    assert.equal(started.status, "running");
    assert.equal(started.executor_profile, gpt.name);
  });
});

describe("decisions: cockpit installed vs not installed", () => {
  it("not installed: decisions go to the board's own list and show on the board", async () => {
    assert.deepEqual(decisionBackend(), { kind: "local", path: localDecisionsPath() });
    const added = await addDecision({ project: "demo", title: "Pick a name for DEMO_0001", detail: "A: one; B: two. Recommended: A", blocking: true });
    assert.equal(added.backend, "local");
    assert.match(added.id ?? "", /^k\d{4}-\d{6}-\d+$/, "new local ids never look like the cockpit's d-ids");
    const read = readOpenDecisions();
    assert.equal(read.notInstalled, true);
    assert.equal(read.message, DECISIONS_NOT_INSTALLED_MESSAGE);
    assert.deepEqual(read.items.map((item) => item.id), [added.id]);
    const board = decisionBoardExtras({}, "demo", { target: () => ({ agentId: null, reason: null }) });
    assert.equal(board.decisions.message, null, "not installed is not an error on the board");
    assert.equal(board.decisions.items.length, 1);
    assert.equal(waitingOnDecision({ id: 1, project: "demo", code_seq: 1 }, read), false);
  });

  it("not installed: wait-user checks the board's own list", async () => {
    const added = await addDecision({ project: "demo", title: "t", detail: "A: x; B: y. Recommended: A" });
    const id = added.id ?? "";
    assert.throws(() => assertDecisionDecided(id), new RegExp(localePattern(zhCNPart("waitUser.notDecided", 17, 21)) + "|open"));
    await doneDecision(id, "A");
    assert.doesNotThrow(() => assertDecisionDecided(id));
    assert.throws(() => assertDecisionDecided("d0101-000000-9"), new RegExp(zhCN("missingCwd.report.missing") + "|" + localePattern(zhCNPart("boardCards.reviewed.missing", 1, 4))));
    assert.equal((await listDecisions()).items?.length, 0);
    assert.equal((await listDecisions({ all: true })).items?.length, 1);
  });

  it("not installed and the board's own list is broken: uncertain, never overwritten", async () => {
    mkdirSync(process.env.KANBAN_DATA_DIR!, { recursive: true });
    writeFileSync(localDecisionsPath(), "{broken");
    const read = readOpenDecisions();
    assert.equal(read.uncertain, true);
    assert.equal(read.message, decisionsReadMessage());
    await assert.rejects(() => addDecision({ project: "demo", title: "t", detail: "d" }), /cannot be read/);
    assert.equal(readFileSync(localDecisionsPath(), "utf8"), "{broken");
  });

  it("installed (fresh or stale cockpit.json): spawns its command line without --json and reads the new id", async () => {
    for (const age of [0, 120 * MINUTE]) {
      writeCockpit("/opt/example/bin/cockpit", new Date(Date.now() - age));
      const calls: Array<{ cmd: string; args: string[] }> = [];
      setDecideExec(async (cmd, args) => {
        calls.push({ cmd, args });
        return "added d1008-120000-3\n";
      });
      const added = await addDecision({ project: "demo", title: "t", detail: "d", blocking: true, agentId: "agent-x", source: "kanban" });
      assert.deepEqual(added, { backend: "cockpit", id: "d1008-120000-3", output: "added d1008-120000-3\n" });
      assert.equal(calls[0].cmd, "/opt/example/bin/cockpit");
      assert.deepEqual(calls[0].args, ["decide", "add", "--project", "demo", "--title", "t", "--detail", "d", "--blocking", "--agent", "agent-x", "--source", "kanban"]);
      assert.equal(calls[0].args.includes("--json"), false);
      await doneDecision("d1008-120000-3", "A");
      assert.deepEqual(calls[1].args, ["decide", "done", "d1008-120000-3", "--note", "A"]);
      assert.equal(existsLocal(), false, "nothing was written to the board's own list");
    }
  });

  it("invalid cockpit.json is handled as absent: the board's own list", () => {
    mkdirSync(exportsDir, { recursive: true });
    writeFileSync(join(exportsDir, "cockpit.json"), "{");
    assert.equal(decisionBackend().kind, "local");
  });

  it("installed with an open row left in the board's own list: both are shown", () => {
    writeExport("decisions-open.json", {
      ...envelopeFor("decisionsOpen", "0.0.0"),
      items: [{ id: "d1008-100000-1", project: "demo", title: "from cockpit", detail: "", blocking: false, agentId: null, createdAt: new Date().toISOString() }],
    });
    const local = addLocalDecision({ project: "demo", title: "left over", detail: "" });
    const read = readOpenDecisions();
    assert.equal(read.notInstalled, undefined);
    assert.deepEqual(new Set(read.items.map((item) => item.id)), new Set(["d1008-100000-1", local.id]));
  });
});

describe("decisions: filed without the cockpit, closed after it is installed", () => {
  it("ls shows the leftover, done closes it in the board's own list, and wait-user accepts it", async () => {
    const filed = await addDecision({ project: "demo", title: "Before the cockpit", detail: "A: x; B: y. Recommended: A" });
    assert.equal(filed.backend, "local");
    const id = filed.id ?? "";
    writeCockpit("/opt/example/bin/cockpit");
    const calls: string[][] = [];
    setDecideExec(async (_cmd, args) => {
      calls.push(args);
      if (args[1] === "ls") return "no open decisions\n";
      if (args[1] === "done") throw new Error(`unknown id ${args[2]}`);
      return "added d1008-120000-1\n";
    });
    assert.equal(decisionBackend().kind, "cockpit");
    const listed = await runDecideCli(["ls"]);
    assert.match(listed, /no open decisions/);
    assert.match(listed, new RegExp(`Still in the board's own list:\\n${id}\\s+\\[demo\\] Before the cockpit`));
    assert.throws(() => assertDecisionDecided(id), new RegExp(localePattern(zhCNPart("waitUser.notDecided", 17, 21)) + "|open"));
    assert.equal(await runDecideCli(["done", id, "--note", "A"]), `done ${id} (board's own list)`);
    assert.equal(calls.some((args) => args[1] === "done"), false, "a local id never goes to the cockpit");
    assert.doesNotThrow(() => assertDecisionDecided(id));
    assert.equal(readOpenDecisions().items.some((item) => item.id === id), false);
    assert.equal((await listDecisions()).leftovers.length, 0);
  });

  it("other ids still go to the cockpit, also when the board's own list is broken", async () => {
    writeCockpit("/opt/example/bin/cockpit");
    const calls: string[][] = [];
    setDecideExec(async (_cmd, args) => {
      calls.push(args);
      return `done ${args[2]}\n`;
    });
    mkdirSync(process.env.KANBAN_DATA_DIR!, { recursive: true });
    writeFileSync(localDecisionsPath(), "{broken");
    assert.deepEqual(await doneDecision("d1008-100000-1", null), { backend: "cockpit", output: "done d1008-100000-1\n" });
    assert.deepEqual(calls, [["decide", "done", "d1008-100000-1"]]);
    assert.deepEqual((await listDecisions()).leftovers, []);
  });
});

const SHARED_ID = "d1008-100000-1";

function localRow(id: string, status: "open" | "done" = "open") {
  return { id, project: "demo", title: `local ${id}`, detail: "", blocking: false, agentId: null, source: null, createdAt: new Date().toISOString(), status };
}

function writeLocalRows(rows: ReturnType<typeof localRow>[]): void {
  mkdirSync(process.env.KANBAN_DATA_DIR!, { recursive: true });
  writeFileSync(localDecisionsPath(), JSON.stringify(rows));
}

function writeCockpitOpen(ids: string[]): void {
  writeExport("decisions-open.json", {
    ...envelopeFor("decisionsOpen", "0.0.0"),
    items: ids.map((id) => ({ id, project: "demo", title: `cockpit ${id}`, detail: "", blocking: false, agentId: null, createdAt: new Date().toISOString() })),
  });
}

/** Cockpit installed with a fake command line; returns the args of every call. */
function fakeCockpit(): string[][] {
  writeCockpit("/opt/example/bin/cockpit");
  const calls: string[][] = [];
  setDecideExec(async (_cmd, args) => {
    calls.push(args);
    return `done ${args[2]}\n`;
  });
  return calls;
}

function localStatus(id: string): string | undefined {
  return listLocalDecisions({ all: true }).find((row) => row.id === id)?.status;
}

describe("decisions: the same id in the cockpit's list and the board's own list", () => {
  it("done without --source refuses and closes neither", async () => {
    const calls = fakeCockpit();
    writeCockpitOpen([SHARED_ID]);
    writeLocalRows([localRow(SHARED_ID)]);
    await assert.rejects(() => doneDecision(SHARED_ID, "A"), (err: Error) => {
      assert.match(err.message, /in both/);
      assert.match(err.message, /--source local/);
      assert.match(err.message, /--source cockpit/);
      return true;
    });
    await assert.rejects(() => runDecideCli(["done", SHARED_ID]), /--source local/);
    assert.deepEqual(calls, [], "the cockpit was not asked to close it");
    assert.equal(localStatus(SHARED_ID), "open", "the board's own row was not closed");
    assert.equal(readOpenDecisions().items.filter((item) => item.id === SHARED_ID).length, 1, "the board shows the id once");
  });

  it("--source local closes only the board's own row", async () => {
    const calls = fakeCockpit();
    writeCockpitOpen([SHARED_ID]);
    writeLocalRows([localRow(SHARED_ID)]);
    assert.equal(await runDecideCli(["done", SHARED_ID, "--source", "local", "--note", "A"]), `done ${SHARED_ID} (board's own list)`);
    assert.deepEqual(calls, []);
    assert.equal(localStatus(SHARED_ID), "done");
  });

  it("--source cockpit closes only the cockpit's row", async () => {
    const calls = fakeCockpit();
    writeCockpitOpen([SHARED_ID]);
    writeLocalRows([localRow(SHARED_ID)]);
    assert.equal(await runDecideCli(["done", SHARED_ID, "--source", "cockpit", "--note", "A"]), `done ${SHARED_ID}`);
    assert.deepEqual(calls, [["decide", "done", SHARED_ID, "--note", "A"]]);
    assert.equal(localStatus(SHARED_ID), "open");
  });

  it("an id in the cockpit's full decisions.json (already done there) also counts as in both", async () => {
    const calls = fakeCockpit();
    delete process.env.ROLES_STATE_DIR;
    writeFileSync(join(cockpitDir, "decisions.json"), JSON.stringify([{ ...localRow(SHARED_ID, "done") }]));
    writeLocalRows([localRow(SHARED_ID)]);
    await assert.rejects(() => doneDecision(SHARED_ID, null), /in both/);
    assert.deepEqual(calls, []);
    assert.equal(findDecisionSource(SHARED_ID), "cockpit", "lookup order matches the board: the cockpit first");
  });

  it("an old d-id only in the board's own list is closed there without --source", async () => {
    const calls = fakeCockpit();
    writeCockpitOpen(["d1008-100000-2"]);
    writeLocalRows([localRow(SHARED_ID)]);
    assert.deepEqual(await doneDecision(SHARED_ID, null), { backend: "local", output: `done ${SHARED_ID} (board's own list)` });
    assert.deepEqual(calls, []);
  });

  it("a d-id in the own list while the cockpit's list cannot be read is not guessed; a k-id still closes locally", async () => {
    const calls = fakeCockpit();
    writeFileSync(join(cockpitDir, "decisions.json"), "{broken");
    writeLocalRows([localRow(SHARED_ID), localRow("k1008-100000-1")]);
    await assert.rejects(() => doneDecision(SHARED_ID, null), /cannot be read.*--source local/);
    assert.equal((await doneDecision("k1008-100000-1", null)).backend, "local");
    assert.deepEqual(calls, []);
  });

  it("--source is checked: unknown values and cockpit without a cockpit are refused", async () => {
    await assert.rejects(() => runDecideCli(["done", "k1008-100000-1", "--source", "ex"]), /local or cockpit/);
    writeLocalRows([localRow("k1008-100000-1")]);
    await assert.rejects(() => runDecideCli(["done", "k1008-100000-1", "--source", "cockpit"]), /not installed/);
    assert.equal(localStatus("k1008-100000-1"), "open");
    assert.equal(await runDecideCli(["done", "k1008-100000-1", "--source", "local"]), "done k1008-100000-1");
  });
});

function findDecisionSource(id: string): string | null {
  const found = findDecision(id);
  return found.found ? found.source : null;
}

function existsLocal(): boolean {
  try {
    readFileSync(localDecisionsPath());
    return true;
  } catch {
    return false;
  }
}

describe("local decisions list", () => {
  it("new ids are k<MMDD>-<HHMMSS>-<n> and count up within a second; old d-ids are kept", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    assert.equal(nextDecisionId([], at), "k0102-030405-1");
    writeLocalRows([localRow("d0102-030405-1")]);
    const first = addLocalDecision({ project: "demo", title: "a", detail: "" }, { now: at });
    const second = addLocalDecision({ project: "demo", title: "b", detail: "" }, { now: at });
    assert.equal(first.id, "k0102-030405-1");
    assert.equal(second.id, "k0102-030405-2");
    assert.deepEqual(listLocalDecisions().map((row) => row.id), ["d0102-030405-1", "k0102-030405-1", "k0102-030405-2"]);
  });

  it("writes atomically: no temp file is left beside the list", () => {
    addLocalDecision({ project: "demo", title: "a", detail: "" });
    const leftovers = readdirSync(process.env.KANBAN_DATA_DIR!).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    assert.equal(listLocalDecisions().length, 1);
  });

  it("rejects an empty project or title", () => {
    assert.throws(() => addLocalDecision({ project: " ", title: "a", detail: "" }), /--project/);
    assert.throws(() => addLocalDecision({ project: "demo", title: "", detail: "" }), /--title/);
  });

  it("paseo-kanban decide add|ls|done works without the cockpit", async () => {
    const added = JSON.parse(await runDecideCli(["add", "--project", "demo", "--title", "Ship it?", "--detail", "A: yes; B: no. Recommended: A", "--blocking", "--json"]));
    assert.equal(added.backend, "local");
    const id = added.id as string;
    assert.match(await runDecideCli(["ls"]), new RegExp(`${id}\\s+\\[demo\\] Ship it\\? \\(blocking\\)`));
    assert.equal(await runDecideCli(["done", id, "--note", "A"]), `done ${id}`);
    assert.equal(await runDecideCli(["ls"]), "No open decisions.");
    assert.match(await runDecideCli(["ls", "--all"]), /blocking, done/);
    assert.match(await runDecideCli([]), /Usage: paseo-kanban decide/);
    await assert.rejects(() => runDecideCli(["bogus"]), /Unknown decide command/);
    await assert.rejects(() => runDecideCli(["done", "d0101-000000-1"]), /not in the local list/);
  });
});

describe("doctor: contract states", () => {
  const NOW = new Date();

  function board(): DoctorBoard {
    const pools = readPoolSnapshot(NOW.getTime());
    const quota = pools.state === "missing" ? "missing" : pools.state;
    const matrix = loadDispatchMatrix(NOW.getTime(), join(exportsDir, "dispatch-matrix.json"));
    return {
      plugin: "running", quota, quotaAgeMs: pools.ageMs ?? null, matrix: matrix.state === "ok" ? "ok" : "missing", matrixAgeMs: null,
      tickAt: NOW.toISOString(), missingCwdCount: 0, contracts: cockpitHealth(NOW),
    };
  }

  async function diagnose(): Promise<DoctorReport> {
    getDb();
    return runDoctor({ now: NOW, sources: { board: board() }, settings: doctorSettings(null) });
  }

  const boardFindings = (report: DoctorReport) => report.findings.filter((item) => item.id.startsWith("board:") && item.id !== "board:tick");

  it("absent: one info note, no yellow and no red about quota or matrix", async () => {
    const report = await diagnose();
    const found = boardFindings(report);
    assert.deepEqual(found.map((item) => [item.id, item.severity]), [["board:cockpit", "info"]]);
    assert.equal(found[0].symptom, "fleet cockpit not installed");
  });

  it("stale: yellow with how long, never red", async () => {
    writeCockpit("/opt/example/bin/cockpit");
    writePools({ "claude-max": pool(true, 10) }, new Date(NOW.getTime() - 50 * MINUTE));
    const found = boardFindings(await diagnose());
    const stale = found.find((item) => item.id === "board:contract:poolStatus");
    assert.equal(stale?.severity, "yellow");
    assert.match(stale?.evidence ?? "", /^5\d minutes old \(stale after 45 minutes\)$/);
    assert.equal(found.some((item) => item.severity === "red"), false);
    assert.equal(found.some((item) => item.id === "board:quota"), false, "the contract finding already covers it");
  });

  it("invalid: yellow with the reason, never red", async () => {
    writeCockpit("/opt/example/bin/cockpit");
    mkdirSync(exportsDir, { recursive: true });
    writeFileSync(join(exportsDir, "dispatch-matrix.json"), "{not json");
    const found = boardFindings(await diagnose());
    const invalid = found.find((item) => item.id === "board:contract:dispatchMatrix");
    assert.equal(invalid?.severity, "yellow");
    assert.match(invalid?.evidence ?? "", /bad JSON/);
    assert.equal(found.some((item) => item.severity === "red"), false);
  });

  it("fresh: nothing about contracts", async () => {
    writeCockpit("/opt/example/bin/cockpit");
    writePools({ "claude-max": pool(true, 10) });
    writeExport("dispatch-matrix.json", { ...envelopeFor("dispatchMatrix", "0.0.0"), version: 1, defaultTier: "L2", downgradeWhenTight: [], roles: {} });
    writeExport("decisions-open.json", { ...envelopeFor("decisionsOpen", "0.0.0"), items: [] });
    assert.deepEqual(boardFindings(await diagnose()), []);
  });
});
