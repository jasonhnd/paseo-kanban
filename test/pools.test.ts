/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { onlyRolesBlock, openEntry, parseOnlyRoles, quotaBrief, readCompatibilityPoolSnapshot as readPoolSnapshot } from "../server/pools";

const dir = mkdtempSync(join(tmpdir(), "kanban-pools-"));
const file = join(dir, "pool-status.json");
const previous = process.env.KANBAN_POOL_STATUS;
// readPoolSnapshot overlays disabledPools from loadConfig; keep the real data/ config out of these tests.
const previousDataDir = process.env.KANBAN_DATA_DIR;
process.env.KANBAN_DATA_DIR = join(dir, "data");

function write(pools: unknown): void {
  writeFileSync(file, JSON.stringify({ generatedAt: "2026-09-30T00:00:00.000Z", pools }));
  process.env.KANBAN_POOL_STATUS = file;
}

after(() => {
  if (previousDataDir === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  if (previous === undefined) delete process.env.KANBAN_POOL_STATUS;
  else process.env.KANBAN_POOL_STATUS = previous;
});

describe("parseOnlyRoles", () => {
  it("keeps a string list and drops blanks", () => {
    assert.deepEqual(parseOnlyRoles([" reviewer ", "reviewer", "", "decision"]), ["reviewer", "decision"]);
  });

  it("treats a missing value, a non-array, and an empty array as no limit", () => {
    assert.equal(parseOnlyRoles(undefined), null);
    assert.equal(parseOnlyRoles("reviewer"), null);
    assert.equal(parseOnlyRoles([]), null);
    assert.equal(parseOnlyRoles([1, false, ""]), null);
  });
});

describe("readPoolSnapshot onlyRoles", () => {
  it("reads a role list and mentions it on the snapshot line", () => {
    write({
      "claude-max": { dispatchable: true, onlyRoles: ["reviewer"] },
      cursor: { dispatchable: true },
    });
    const snapshot = readPoolSnapshot();
    assert.deepEqual(snapshot.entry("claude-max").onlyRoles, ["reviewer"]);
    assert.equal(snapshot.entry("cursor").onlyRoles, null);
    assert.equal(snapshot.entry("missing").onlyRoles, null);
    assert.equal(snapshot.dispatchable("claude-max"), true);
    assert.match(snapshot.message, new RegExp(zhCN("pools.freshMessage")));
    assert.match(snapshot.message, new RegExp(zhCN("pools.onlyFor", {"pool":"claude-max","roles":zhCN("labels.role.reviewer")})));
    assert.doesNotMatch(snapshot.message, new RegExp("cursor " + localePattern(zhCNPart("pools.onlyFor", 7, 9))));
  });

  it("keeps an old snapshot with no onlyRoles fully open", () => {
    write({ "claude-max": { dispatchable: true, deprioritize: true, reason: "Lower priority" } });
    const snapshot = readPoolSnapshot();
    const entry = snapshot.entry("claude-max");
    assert.equal(entry.dispatchable, true);
    assert.equal(entry.deprioritize, true);
    assert.equal(entry.reason, "Lower priority");
    assert.equal(entry.onlyRoles, null);
    assert.equal(snapshot.message, zhCN("pools.freshMessage"));
    assert.equal(onlyRolesBlock(entry, "claude-max", "decision"), null);
  });

  it("treats an empty onlyRoles array as no limit", () => {
    write({ "claude-max": { dispatchable: true, onlyRoles: [] } });
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.entry("claude-max").onlyRoles, null);
    assert.equal(snapshot.message, zhCN("pools.freshMessage"));
    assert.equal(onlyRolesBlock(openEntry(), "claude-max", "decision"), null);
  });
});

describe("quotaBrief", () => {
  it("keeps usedPct when the snapshot wrote a number", () => {
    write({ cursor: { dispatchable: false, usedPct: 91, onlyRoles: ["executor"] }, "claude-max": { dispatchable: true, usedPct: "91" } });
    const snapshot = readPoolSnapshot();
    assert.equal(snapshot.entry("cursor").usedPct, 91);
    assert.equal(snapshot.entry("claude-max").usedPct, null);
    assert.equal(snapshot.dispatchable("cursor"), false);
    const brief = quotaBrief({ snapshot, pool: "cursor", matrixGeneratedAt: "2026-10-01T01:00:00.000Z" });
    assert.equal(brief.generatedAt, "2026-09-30T00:00:00.000Z");
    assert.equal(brief.state, "fresh");
    assert.equal(brief.dispatchable, false);
    assert.equal(brief.usedPct, 91);
    assert.deepEqual(brief.onlyRoles, ["executor"]);
    assert.equal(brief.matrixGeneratedAt, "2026-10-01T01:00:00.000Z");
  });

  it("returns null fields when the snapshot is missing", () => {
    const brief = quotaBrief({ snapshot: null, pool: "cursor", matrixGeneratedAt: null });
    assert.equal(brief.generatedAt, null);
    assert.equal(brief.state, null);
    assert.equal(brief.dispatchable, null);
    assert.equal(brief.usedPct, null);
    assert.equal(brief.onlyRoles, null);
    assert.equal(brief.pool, "cursor");
    assert.equal(brief.matrixGeneratedAt, null);
    process.env.KANBAN_POOL_STATUS = join(dir, "gone.json");
    const unread = quotaBrief({ snapshot: readPoolSnapshot(), pool: "cursor" });
    assert.equal(unread.generatedAt, null);
    assert.equal(unread.state, null);
    assert.equal(unread.dispatchable, null);
    assert.equal(unread.usedPct, null);
    assert.equal(unread.onlyRoles, null);
  });
});

describe("onlyRolesBlock", () => {
  it("names the pool and the allowed roles", () => {
    const entry = { ...openEntry(), onlyRoles: ["reviewer"] };
    assert.equal(onlyRolesBlock(entry, "claude-max", "reviewer"), null);
    assert.equal(onlyRolesBlock(entry, "claude-max", "decision"), zhCN("pools.onlyFor", {"pool":"claude-max","roles":zhCN("labels.role.reviewer")}));
    assert.equal(onlyRolesBlock(entry, "claude-max", null), zhCN("pools.onlyFor", {"pool":"claude-max","roles":zhCN("labels.role.reviewer")}));
  });
});
