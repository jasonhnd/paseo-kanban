/// <reference types="node" />
// The board reads the cockpit's fleet-quota/v1 exports first, falls back to the cockpit's legacy
// state files, and treats "neither" as "the cockpit is not installed".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { envelopeFor } from "../server/contract";
import { closeDb } from "../server/db";
import { readCompatibilityPoolSnapshot as readPoolSnapshot } from "../server/pools";
import { readCompatibilityDispatchMatrix as loadDispatchMatrix, realDispatchMatrixPath } from "../server/matrix";
import { decisionBoardExtras, DECISIONS_NOT_INSTALLED_MESSAGE, decisionsReadMessage, readOpenDecisions } from "../server/decisions";
import { cockpitCli, cockpitStateFile, contractPath } from "../server/afc-sources";
import { decisionBackend, LEGACY_DECIDE_COMMAND } from "../server/decisions";
import { localDecisionsPath } from "../server/local-decisions";

const root = mkdtempSync(join(tmpdir(), "ex-contract-sources-"));
const board = join(root, "board");
const cockpitData = join(board, "fleet");
const exportsDir = join(board, "exports", "fleet");
const legacyDir = cockpitData;
const saved: Record<string, string | undefined> = {};
const KEYS = ["KANBAN_DATA_DIR", "AFC_DATA_DIR", "ROLES_STATE_DIR", "KANBAN_POOL_STATUS", "KANBAN_DISPATCH_MATRIX"] as const;

before(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.KANBAN_DATA_DIR = join(root, "board");
  delete process.env.AFC_DATA_DIR;
  delete process.env.ROLES_STATE_DIR;
  delete process.env.KANBAN_POOL_STATUS;
  delete process.env.KANBAN_DISPATCH_MATRIX;
});

after(() => {
  closeDb();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(cockpitData, { recursive: true, force: true });
  rmSync(exportsDir, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });
  mkdirSync(exportsDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });
});

const MINUTE = 60_000;

/** Write one export; `generatedAt` ages the envelope. */
function writeExport(file: string, body: Record<string, unknown>, generatedAt = new Date()): void {
  writeFileSync(join(exportsDir, file), JSON.stringify({ ...body, generatedAt: generatedAt.toISOString() }));
}

function poolState(dispatchable: boolean, usedPct: number | null) {
  return { dispatchable, deprioritize: false, prefer: false, usedPct, resetsAt: null, onlyRoles: null, reason: null };
}

const MATRIX_BODY = {
  version: 1,
  defaultTier: "L2",
  downgradeWhenTight: ["L1"],
  roles: { executor: { L2: [{ profile: "Example executor", effort: "high" }] } },
};

describe("quota snapshot source", () => {
  it("uses the contract export when it is there", () => {
    writeExport("pool-status.json", { ...envelopeFor("poolStatus", "0.0.0"), pools: { "pool-a": poolState(false, 40) }, priority: null });
    writeFileSync(join(legacyDir, "pool-status.json"), JSON.stringify({ pools: { "pool-a": { dispatchable: true } } }));
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.state, "fresh");
    assert.equal(snapshot.dispatchable("pool-a"), false, "the contract value wins over the legacy file");
  });

  it("judges staleness by generatedAt and ttlSeconds * 3", () => {
    const old = new Date(Date.now() - 46 * MINUTE);
    writeExport("pool-status.json", { ...envelopeFor("poolStatus", "0.0.0"), pools: { "pool-a": poolState(false, 10) }, priority: null }, old);
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.state, "stale");
    assert.equal(snapshot.dispatchable("pool-a"), true, "a stale pause is dropped; only the stop line applies");
    assert.ok((snapshot.ageMs ?? 0) >= 45 * MINUTE);
  });

  it("falls back to the legacy file when the export is missing or invalid", () => {
    writeFileSync(join(legacyDir, "pool-status.json"), JSON.stringify({ pools: { "pool-a": { dispatchable: false } } }));
    assert.equal(readPoolSnapshot().dispatchable("pool-a"), false);
    writeFileSync(join(exportsDir, "pool-status.json"), JSON.stringify({ schema: "something-else" }));
    assert.equal(readPoolSnapshot().dispatchable("pool-a"), false);
  });

  it("treats neither as the cockpit not installed", () => {
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.state, "missing");
    assert.equal(snapshot.failure, "absent");
    assert.equal(snapshot.dispatchable("pool-a"), true);
  });
});

describe("dispatch matrix source", () => {
  it("uses the contract export when it is there", () => {
    writeExport("dispatch-matrix.json", { ...envelopeFor("dispatchMatrix", "0.0.0"), ...MATRIX_BODY });
    writeFileSync(join(legacyDir, "dispatch-matrix.json"), JSON.stringify({ ...MATRIX_BODY, defaultTier: "L3" }));
    assert.equal(realDispatchMatrixPath(), contractPath("dispatchMatrix"));
    const load = loadDispatchMatrix(Date.now(), realDispatchMatrixPath());
    assert.equal(load.state, "ok");
    assert.equal(load.state === "ok" && load.matrix.defaultTier, "L2");
  });

  it("falls back to the legacy file", () => {
    writeFileSync(join(legacyDir, "dispatch-matrix.json"), JSON.stringify({ ...MATRIX_BODY, defaultTier: "L3" }));
    const load = loadDispatchMatrix(Date.now(), realDispatchMatrixPath());
    assert.equal(load.state === "ok" && load.matrix.defaultTier, "L3");
  });

  it("is missing when neither exists", () => {
    assert.equal(loadDispatchMatrix(Date.now(), realDispatchMatrixPath()).state, "missing");
  });
});

describe("open decisions source", () => {
  const item = { id: "d0101-000000-1", project: "demo", title: "Pick one", detail: "A or B", blocking: true, agentId: null, createdAt: "2026-01-01T00:00:00Z" };

  it("uses the contract export and keeps owner and notes from the full list", () => {
    writeExport("decisions-open.json", { ...envelopeFor("decisionsOpen", "0.0.0"), items: [item] });
    writeFileSync(join(legacyDir, "decisions.json"), JSON.stringify([
      { ...item, status: "open", owner: "demo <leader>" },
      { ...item, id: "d0101-000000-2", status: "open" },
    ]));
    const read = readOpenDecisions();
    assert.deepEqual(read.items.map((row) => row.id), ["d0101-000000-1"], "only what the export lists is open");
    assert.equal(read.items[0].owner, "demo <leader>");
    assert.equal(read.message, null);
  });

  it("falls back to the full decisions.json", () => {
    writeFileSync(join(legacyDir, "decisions.json"), JSON.stringify([{ ...item, status: "open" }, { ...item, id: "d0101-000000-3", status: "done" }]));
    assert.deepEqual(readOpenDecisions().items.map((row) => row.id), ["d0101-000000-1"]);
  });

  it("skips a contract row the board cannot use and keeps the others", () => {
    const bad = { ...item, id: "d0101-000000-9", project: "" };
    writeExport("decisions-open.json", { ...envelopeFor("decisionsOpen", "0.0.0"), items: [bad, item] });
    const read = readOpenDecisions();
    assert.deepEqual(read.items.map((row) => row.id), ["d0101-000000-1"]);
    assert.equal(read.message, null);
    assert.equal(read.uncertain, undefined);
  });

  it("falls back to the full decisions.json when the export is broken JSON", () => {
    writeFileSync(join(exportsDir, "decisions-open.json"), "{broken");
    writeFileSync(join(legacyDir, "decisions.json"), JSON.stringify([{ ...item, status: "open" }]));
    const read = readOpenDecisions();
    assert.deepEqual(read.items.map((row) => row.id), ["d0101-000000-1"]);
    assert.equal(read.message, null);
  });

  it("is uncertain when the export is broken and there is no full list", () => {
    writeFileSync(join(exportsDir, "decisions-open.json"), "{broken");
    assert.deepEqual(readOpenDecisions(), { items: [], message: decisionsReadMessage(), uncertain: true });
  });

  it("is quietly not installed when neither exists", () => {
    const read = readOpenDecisions();
    assert.deepEqual(read.items, []);
    assert.equal(read.uncertain, undefined);
    assert.equal(read.notInstalled, true);
    assert.equal(read.message, DECISIONS_NOT_INSTALLED_MESSAGE);
    const board = decisionBoardExtras({}, undefined, { target: () => ({ agentId: null, reason: null }) });
    assert.deepEqual(board.decisions, { message: null, items: [] }, "the board shows no read error");
  });
});

describe("cockpit command line", () => {
  it("comes from cockpit.json, and is null without it", () => {
    assert.equal(cockpitCli(), null);
    assert.deepEqual(decisionBackend(), { kind: "local", path: localDecisionsPath() }, "no cockpit at all: the board's own list");
    writeFileSync(join(legacyDir, "decisions.json"), "[]");
    assert.deepEqual(decisionBackend(), { kind: "cockpit", cli: LEGACY_DECIDE_COMMAND }, "an older cockpit without the export: its command on PATH");
    writeExport("cockpit.json", { ...envelopeFor("cockpit", "0.0.0"), dataDir: cockpitData, cli: "/opt/example/bin/ex.mjs", features: [] });
    assert.equal(cockpitCli(), "/opt/example/bin/ex.mjs");
    assert.deepEqual(decisionBackend(), { kind: "cockpit", cli: "/opt/example/bin/ex.mjs" });
  });
});

describe("cockpit state files without ROLES_STATE_DIR", () => {
  it("are found in the cockpit's plugin-data directory, and are null when absent", () => {
    const env = { KANBAN_DATA_DIR: board, KANBAN_PASEO_CONFIG: join(root, "no-paseo-config.json") };
    assert.equal(cockpitStateFile("decisions.json", env), null);
    writeFileSync(join(cockpitData, "decisions.json"), "[]");
    assert.equal(cockpitStateFile("decisions.json", env), join(cockpitData, "decisions.json"));
  });

  it("do not read a previously registered sibling plugin", () => {
    const install = join(root, "cockpit-install");
    mkdirSync(join(install, "plugin"), { recursive: true });
    writeFileSync(join(install, "paused-projects.json"), "[]");
    const config = join(root, "paseo-config.json");
    writeFileSync(config, JSON.stringify({ plugins: { "agent-fleet-cockpit": { path: join(install, "plugin") } } }));
    const env = { KANBAN_DATA_DIR: board, KANBAN_PASEO_CONFIG: config };
    assert.equal(cockpitStateFile("paused-projects.json", env), null);
    assert.throws(() => cockpitStateFile("paused-projects.json", { ...env, AFC_DATA_DIR: install }), /Retired storage override/);
  });
});
