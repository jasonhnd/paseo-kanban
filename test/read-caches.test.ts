/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { bucketsHolding, listAgentRecords, resetAgentIndexForTests } from "../server/agent-index";
import { ConfigFileError, loadConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { findAgentFile } from "../server/open";
import { projectRows } from "../server/project-rows";
import { appendEvent, createTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "read-caches-"));
const agents = join(dir, "agents");
mkdirSync(agents, { recursive: true });
const previous = { data: process.env.KANBAN_DATA_DIR, agents: process.env.KANBAN_AGENTS_DIR, ttl: process.env.KANBAN_AGENT_INDEX_TTL_MS };
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agents;

function writeAgent(bucket: string, id: string, body: Record<string, unknown> = {}): string {
  mkdirSync(join(agents, bucket), { recursive: true });
  const path = join(agents, bucket, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, title: `t-${id}`, lastStatus: "idle", archivedAt: null, ...body }));
  return path;
}

function age(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

afterEach(() => {
  resetAgentIndexForTests();
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [["KANBAN_DATA_DIR", previous.data], ["KANBAN_AGENTS_DIR", previous.agents], ["KANBAN_AGENT_INDEX_TTL_MS", previous.ttl]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agent bucket index", () => {
  it("sees a record written a moment ago when the TTL is zero (the test default)", () => {
    delete process.env.KANBAN_AGENT_INDEX_TTL_MS;
    assert.equal(findAgentFile("fresh-a"), null);
    writeAgent("b1", "fresh-a");
    assert.equal(findAgentFile("fresh-a")?.title, "t-fresh-a");
  });

  it("answers repeated misses from memory within the TTL and finds new records after it", async (t) => {
    // The TTL is measured with Date.now(); a fake clock keeps a slow machine from expiring it early.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    process.env.KANBAN_AGENT_INDEX_TTL_MS = "60";
    writeAgent("b2", "known-a");
    assert.equal(findAgentFile("late-a"), null);
    writeAgent("b3", "late-a");
    assert.equal(findAgentFile("late-a"), null, "a miss inside the TTL is served from the index");
    t.mock.timers.tick(90);
    assert.equal(findAgentFile("late-a")?.id, "late-a");
    assert.deepEqual(bucketsHolding(agents, "known-a"), ["b2"]);
  });

  it("re-reads record contents on every lookup even when the bucket is cached", () => {
    process.env.KANBAN_AGENT_INDEX_TTL_MS = "60000";
    const path = writeAgent("b4", "content-a", { lastStatus: "idle" });
    age(path, 3_600_000);
    assert.equal(findAgentFile("content-a")?.lastStatus, "idle");
    writeAgent("b4", "content-a", { lastStatus: "running" });
    assert.equal(findAgentFile("content-a")?.lastStatus, "running");
  });

  it("falls back to the other buckets when a cached record moves", () => {
    process.env.KANBAN_AGENT_INDEX_TTL_MS = "0";
    const first = writeAgent("move-1", "moved-a");
    assert.equal(findAgentFile("moved-a")?.id, "moved-a");
    rmSync(first);
    writeAgent("move-2", "moved-a");
    assert.equal(findAgentFile("moved-a")?.id, "moved-a");
    assert.deepEqual(bucketsHolding(agents, "moved-a"), ["move-2"]);
  });

  it("lists every record and reports an unreadable root as null", () => {
    process.env.KANBAN_AGENT_INDEX_TTL_MS = "0";
    writeAgent("list-1", "list-a");
    writeAgent("list-2", "list-b");
    const ids = (listAgentRecords(agents) ?? []).map((row) => row.id);
    assert.ok(ids.includes("list-a") && ids.includes("list-b"));
    assert.equal(listAgentRecords(join(dir, "no-such-root")), null);
    assert.equal(bucketsHolding(join(dir, "no-such-root"), "x"), null);
  });
});

describe("loadConfig memo", () => {
  const file = () => join(dir, "kanban.config.json");

  it("gives every caller its own copy", () => {
    writeFileSync(file(), JSON.stringify({ supervisors: { alpha: "agent-1" }, autoStart: { alpha: true } }));
    age(file(), 3_600_000);
    const first = loadConfig();
    const second = loadConfig();
    first.supervisors.alpha = "mutated";
    first.autoStart.beta = true;
    const third = loadConfig();
    assert.equal(second.supervisors.alpha, "agent-1");
    assert.equal(third.supervisors.alpha, "agent-1");
    assert.equal(third.autoStart.beta, undefined);
  });

  it("notices a rewritten file, including one with the same size", () => {
    writeFileSync(file(), JSON.stringify({ supervisors: { alpha: "aaaa" } }));
    age(file(), 3_600_000);
    assert.equal(loadConfig().supervisors.alpha, "aaaa");
    writeFileSync(file(), JSON.stringify({ supervisors: { alpha: "bbbb" } }));
    assert.equal(loadConfig().supervisors.alpha, "bbbb", "a file touched just now is always read again");
    age(file(), 3_600_000);
    assert.equal(loadConfig().supervisors.alpha, "bbbb");
    writeFileSync(file(), JSON.stringify({ supervisors: { alpha: "cccc", beta: "dddd" } }));
    age(file(), 1_800_000);
    assert.equal(loadConfig().supervisors.beta, "dddd");
  });

  it("does not remember a file that failed to parse", () => {
    writeFileSync(file(), "{ not json");
    age(file(), 3_600_000);
    assert.throws(() => loadConfig(), ConfigFileError, "a broken file is reported, not read as defaults (TEST_0273)");
    writeFileSync(file(), JSON.stringify({ supervisors: { alpha: "fixed" } }));
    age(file(), 3_600_000);
    assert.equal(loadConfig().supervisors.alpha, "fixed");
  });
});

describe("project rows leader action", () => {
  it("takes the newest event by the supervisor actor or the registered leader, per project", () => {
    const a = createTask({ project: "rows-a", title: "a", role: "executor", workspacePath: dir, actor: "kanban" });
    const b = createTask({ project: "rows-b", title: "b", role: "executor", workspacePath: dir, actor: "kanban" });
    writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ supervisors: { "rows-a": "leader-a", "rows-b": "leader-b" } }));
    appendEvent(a.id, "comment", null, null, "supervisor", {}, "2026-10-01T00:00:00.000Z");
    appendEvent(a.id, "comment", null, null, "leader-a", {}, "2026-10-02T00:00:00.000Z");
    appendEvent(a.id, "comment", null, null, "leader-b", {}, "2026-10-09T00:00:00.000Z");
    appendEvent(a.id, "comment", null, null, "scheduler", {}, "2026-10-10T00:00:00.000Z");
    appendEvent(b.id, "comment", null, null, "supervisor", {}, "2026-10-03T00:00:00.000Z");
    appendEvent(b.id, "comment", null, null, "leader-b", {}, "2026-10-09T00:00:00.000Z");
    const rows = Object.fromEntries(projectRows().map((row) => [row.project, row]));
    assert.equal(rows["rows-a"]!.lastLeaderActionAt, "2026-10-02T00:00:00.000Z");
    assert.equal(rows["rows-b"]!.lastLeaderActionAt, "2026-10-09T00:00:00.000Z");
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE actor = 'leader-b'").get()!.n, 2);
  });
});
