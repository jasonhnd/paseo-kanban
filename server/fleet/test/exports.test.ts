// fleet-quota/v1 exports built from the legacy file shapes (server/exports.ts). Demo data only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CockpitInfo, Decisions, PausedProjects, DecisionsOpen, DispatchMatrix, PoolStatus, readContractFile } from "../../contract";
import type { DispatchMatrix as LegacyMatrix } from "../../../shared/fleet/dispatch";
import {
  buildCockpitInfo,
  buildDecisionsExport,
  buildPausedProjectsExport,
  buildDecisionsOpenExport,
  buildDispatchMatrixExport,
  buildPoolStatusExport,
  contractPriorityMode,
  exportableDecisions,
  isoOrNull,
} from "../exports";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("pool-status export", () => {
  const pools = {
    "demo-a": { usedPct: 53, resetsAt: "2030-01-01T13:00:00.330616+00:00", dispatchable: true, deprioritize: false, prefer: true, reason: "ahead", plan: "x", paceState: "ok" },
    "demo-b": { usedPct: 140, resetsAt: "bad", dispatchable: false, deprioritize: true, prefer: false, onlyRoles: ["reviewer"], reason: "" },
  };

  test("maps legacy rows to the contract and validates", () => {
    const out = PoolStatus.parse(buildPoolStatusExport(pools, { order: ["demo-a", "demo-b"], until: "x", mode: "quota", needPerDay: {} }, "1.2.3", NOW));
    assert.equal(out.producerVersion, "1.2.3");
    assert.equal(out.generatedAt, NOW.toISOString());
    assert.deepEqual(out.pools["demo-a"], { dispatchable: true, deprioritize: false, prefer: true, usedPct: 53, resetsAt: "2030-01-01T13:00:00.330Z", onlyRoles: null, reason: "ahead" });
    assert.deepEqual(out.pools["demo-b"], { dispatchable: false, deprioritize: true, prefer: false, usedPct: 100, resetsAt: null, onlyRoles: ["reviewer"], reason: null });
    assert.deepEqual(out.priority, { order: ["demo-a", "demo-b"], mode: "auto" });
  });

  test("priority mode: manual is the user's order, anything else is automatic", () => {
    assert.equal(contractPriorityMode("manual"), "user");
    assert.equal(contractPriorityMode("quota"), "auto");
    assert.equal(contractPriorityMode(undefined), "auto");
    assert.equal(buildPoolStatusExport(pools, null, "0", NOW).priority, null);
  });
});

describe("dispatch-matrix export", () => {
  test("wraps the matrix in the envelope and keeps quota|manual", () => {
    const matrix: LegacyMatrix = {
      version: 1,
      generatedAt: "2029-12-31T23:59:00.000Z",
      defaultTier: "L2",
      roles: {
        executor: { L1: [{ profile: "Demo executor", effort: "low" }], L2: [{ profile: "Demo helper", effort: null, paused: true }] },
        reviewer: { byExecutorFamily: { demo: { L2: [{ profile: "Demo reviewer", effort: "high" }] } } },
      },
      downgradeWhenTight: ["L1"],
      priority: { order: ["demo-a"], until: "2030-01-01T00:30:00+00:00", mode: "manual" },
    };
    const out = DispatchMatrix.parse(buildDispatchMatrixExport(matrix, "0", NOW));
    assert.equal(out.generatedAt, NOW.toISOString());
    assert.deepEqual(out.priority, { order: ["demo-a"], until: "2030-01-01T00:30:00.000Z", mode: "manual" });
    assert.deepEqual(out.roles, matrix.roles);
  });

  test("the shipped base matrix fits the contract", () => {
    const base = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "shared/fleet/default-dispatch.example.json"), "utf8")) as LegacyMatrix;
    assert.doesNotThrow(() => DispatchMatrix.parse(buildDispatchMatrixExport(base, "0", NOW)));
  });
});

describe("decisions-open export", () => {
  test("open items only, with normalised fields", () => {
    const items = [
      { id: "d1", project: "DEMO", title: "Pick", detail: "A or B", blocking: true, agentId: "", createdAt: "2029-12-30T10:00:00+09:00", status: "open" },
      { id: "d2", project: "DEMO", title: "Done", detail: "", blocking: false, status: "done", createdAt: "2029-12-30T10:00:00+09:00" },
      { id: "d3", project: "DEMO", title: "No date", status: "open", agentId: "agent-demo" },
      "junk",
    ];
    const out = DecisionsOpen.parse(buildDecisionsOpenExport(items, "0", NOW));
    assert.deepEqual(out.items, [
      { id: "d1", project: "DEMO", title: "Pick", detail: "A or B", blocking: true, agentId: null, createdAt: "2029-12-30T01:00:00.000Z" },
      { id: "d3", project: "DEMO", title: "No date", detail: "", blocking: false, agentId: "agent-demo", createdAt: NOW.toISOString() },
    ]);
    assert.deepEqual(buildDecisionsOpenExport({ not: "a list" }, "0", NOW).items, []);
  });

  test("items with an empty project are left out and counted (Kanban before DEMO_0303 rejects the file)", () => {
    const items = [
      { id: "d1", project: "DEMO", title: "Kept", status: "open" },
      { id: "d2", project: "", title: "Empty", status: "open" },
      { id: "d3", project: "   ", title: "Blank", status: "open" },
      { id: "d4", title: "Missing", status: "open" },
      { id: "d5", project: "", title: "Closed", status: "done" },
    ];
    const counts: number[] = [];
    const out = DecisionsOpen.parse(buildDecisionsOpenExport(items, "0", NOW, (n) => counts.push(n)));
    assert.deepEqual(out.items.map((item) => item.id), ["d1"]);
    assert.deepEqual(counts, [3]);
    assert.deepEqual(exportableDecisions(items, NOW).skipped, 3);
  });
});

describe("cockpit info and writing", () => {
  test("cockpit.json says where the data and the CLI are", () => {
    const out = CockpitInfo.parse(buildCockpitInfo({ dataDir: "/data/demo", cli: null }, "0", NOW));
    assert.equal(out.dataDir, "/data/demo");
    assert.equal(out.cli, null);
    assert.deepEqual(out.features, ["quota", "dispatch-matrix", "decisions", "decisions-all", "paused-projects"]);
    assert.equal(out.ttlSeconds, 1800);
  });

  test("publish writes into KANBAN_DATA_DIR/exports/fleet and reads back fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-exports-test-"));
    dirs.push(dir);
    const previous = process.env.KANBAN_DATA_DIR;
    process.env.KANBAN_DATA_DIR = dir;
    try {
      const { publishPoolStatusExport } = await import("../exports");
      assert.equal(await publishPoolStatusExport({ "demo-a": { dispatchable: true } }, null, NOW.getTime()), true);
      const read = await readContractFile(join(dir, "exports", "fleet", "pool-status.json"), PoolStatus, { now: NOW });
      assert.equal(read.state, "fresh");
    } finally {
      if (previous === undefined) delete process.env.KANBAN_DATA_DIR;
      else process.env.KANBAN_DATA_DIR = previous;
    }
  });

  test("decisions-open.json on disk has no empty-project item; the skip is logged once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-exports-decisions-"));
    dirs.push(dir);
    const decisions = join(dir, "decisions.json");
    writeFileSync(decisions, JSON.stringify([
      { id: "d1", project: "DEMO", title: "Kept", status: "open" },
      { id: "d2", project: "", title: "Empty", status: "open" },
    ]));
    const previous = process.env.KANBAN_DATA_DIR;
    process.env.KANBAN_DATA_DIR = dir;
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      const { publishDecisionsOpenExport } = await import("../exports");
      assert.equal(await publishDecisionsOpenExport(decisions, NOW.getTime()), true);
      assert.equal(await publishDecisionsOpenExport(decisions, NOW.getTime()), true);
      const read = await readContractFile(join(dir, "exports", "fleet", "decisions-open.json"), DecisionsOpen, { now: NOW });
      assert.equal(read.state, "fresh");
      assert.deepEqual(read.state === "fresh" ? read.value.items.map((item) => item.id) : null, ["d1"]);
      const skips = logged.filter((line) => line.includes("skipped 1 open item(s) with an empty project"));
      assert.equal(skips.length, 1, logged.join("\n"));
    } finally {
      console.log = realLog;
      if (previous === undefined) delete process.env.KANBAN_DATA_DIR;
      else process.env.KANBAN_DATA_DIR = previous;
    }
  });

  test("timestamps: unparseable becomes null", () => {
    assert.equal(isoOrNull("2030-01-01T09:00:00+09:00"), "2030-01-01T00:00:00.000Z");
    assert.equal(isoOrNull("nope"), null);
    assert.equal(isoOrNull(42), null);
  });
});


describe("v1.1 decision and pause exports", () => {
  test("full decisions retain all statuses, owner and valid later comments", () => {
    const rows = ["open", "done", "shelved", "outdated", "decided"].map((status, index) => ({
      id: `demo-${index}`, project: "demo", status, owner: "demo <leader>",
      userComments: [{ at: NOW.toISOString(), note: "Demo note" }, { at: "bad", note: "ignored" }],
    }));
    const full = Decisions.parse(buildDecisionsExport(rows, "1.2.3", NOW));
    assert.equal(full.contractVersion, "1.3.0");
    assert.deepEqual(full.items.map((row) => row.status), rows.map((row) => row.status));
    assert.equal(full.items[1].owner, "demo <leader>");
    assert.deepEqual(full.items[1].userComments, [{ at: NOW.toISOString(), note: "Demo note" }]);
    assert.deepEqual(buildDecisionsOpenExport(rows, "1.2.3", NOW).items.map((row) => row.id), ["demo-0"]);
  });

  test("paused projects normalize names and dates without private fields", () => {
    const out = PausedProjects.parse(buildPausedProjectsExport([
      { project: " demo ", since: NOW.toISOString(), note: "Demo pause", internal: "omitted" },
      { project: "other", since: "unknown" }, { project: "" }, null,
    ], "1.2.3", NOW));
    assert.equal(out.contractVersion, "1.3.0");
    assert.deepEqual(out.projects, [
      { project: "demo", since: NOW.toISOString(), note: "Demo pause" },
      { project: "other", since: null, note: "" },
    ]);
  });

  test("writers publish full status and pauses atomically and preserve exports on corrupt state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afc-exports-complete-"));
    dirs.push(dir);
    const previous = process.env.KANBAN_DATA_DIR;
    process.env.KANBAN_DATA_DIR = dir;
    const decisions = join(dir, "decisions.json");
    const paused = join(dir, "paused-projects.json");
    try {
      const { publishDecisionsOpenExport, publishPausedProjectsExport } = await import("../exports");
      writeFileSync(decisions, JSON.stringify([{ id: "demo", status: "done", project: "demo" }]));
      writeFileSync(paused, JSON.stringify([{ project: "demo", since: NOW.toISOString(), note: "Demo pause" }]));
      assert.equal(await publishDecisionsOpenExport(decisions, NOW.getTime()), true);
      assert.equal(await publishPausedProjectsExport(paused, NOW.getTime()), true);
      const full = await readContractFile(join(dir, "exports", "fleet", "decisions.json"), Decisions, { now: NOW });
      const pause = await readContractFile(join(dir, "exports", "fleet", "paused-projects.json"), PausedProjects, { now: NOW });
      assert.equal(full.state, "fresh");
      assert.equal(full.state === "fresh" && full.value.items[0].status, "done");
      assert.equal(pause.state, "fresh");
      const before = readFileSync(join(dir, "exports", "fleet", "decisions.json"), "utf8");
      writeFileSync(decisions, "{broken");
      assert.equal(await publishDecisionsOpenExport(decisions, NOW.getTime()), false);
      assert.equal(readFileSync(join(dir, "exports", "fleet", "decisions.json"), "utf8"), before);
      const { readdirSync } = await import("node:fs");
      assert.equal(readdirSync(join(dir, "exports", "fleet")).some((name) => name.endsWith(".tmp")), false);
    } finally {
      if (previous === undefined) delete process.env.KANBAN_DATA_DIR; else process.env.KANBAN_DATA_DIR = previous;
    }
  });
});
