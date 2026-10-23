/// <reference types="node" />
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { closeDb, getDb } from "../server/db";
import { bucketsHolding, invalidateAgentIndex, resetAgentIndexForTests } from "../server/agent-index";
import { PLACEHOLDER_NAME, forgetPurgedAgent, loadCwdAgents, patrolMissingCwds, resetMissingCwdForTests, setMissingCwdHooks } from "../server/missing-cwd";
import { round, takePerfSummary } from "../server/perf";

const saved = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), "agent-snapshot-"));
const agents = join(dir, "agents");
const agentic = join(dir, "agentic-root");
const AGENT_COUNT = 120;
process.env.KANBAN_DATA_DIR = join(dir, "data");
process.env.KANBAN_AGENTS_DIR = agents;
process.env.KANBAN_PROJECTS_ROOT = agentic;
process.env.KANBAN_WORKTREES_ROOT = join(dir, "trees");
process.env.KANBAN_AGENT_INDEX_TTL_MS = "60000";

function writeAgent(id: string, cwd: string, archivedAt: string | null = null): void {
  mkdirSync(join(agents, "bucket"), { recursive: true });
  writeFileSync(join(agents, "bucket", `${id}.json`), JSON.stringify({ id, cwd, title: id, provider: "cursor", labels: {}, archivedAt }));
}
function io(): { readFile: number; stat: number } {
  const loop = takePerfSummary(Date.now() + 10 * 60_000)?.loops.snapshot;
  return { readFile: loop?.io.readFile ?? 0, stat: loop?.io.stat ?? 0 };
}

describe("agent record snapshot", () => {
  beforeEach(() => { resetMissingCwdForTests(); resetAgentIndexForTests(); rmSync(agents, { recursive: true, force: true }); });
  after(() => { closeDb(); process.env = saved; rmSync(dir, { recursive: true, force: true }); });

  it("a second listing reads no agent json and stats nothing within one snapshot", () => {
    for (let i = 0; i < AGENT_COUNT; i++) writeAgent(`a${i}`, join(dir, "present"));
    takePerfSummary(Date.now() + 10 * 60_000);
    round("snapshot", () => { loadCwdAgents(); loadCwdAgents(); loadCwdAgents(); });
    const counts = io();
    assert.ok(counts.readFile <= AGENT_COUNT, `readFile ${counts.readFile} should be one pass at most`);
    assert.ok(counts.stat <= AGENT_COUNT * 2 + 4, `stat ${counts.stat} should be one pass at most`);
  });

  it("after invalidation an unchanged record is not read again, a changed one is", () => {
    for (let i = 0; i < AGENT_COUNT; i++) writeAgent(`a${i}`, join(dir, "present"));
    loadCwdAgents();
    takePerfSummary(Date.now() + 10 * 60_000);
    writeAgent("a3", join(dir, "moved"));
    invalidateAgentIndex();
    let listed: ReturnType<typeof loadCwdAgents> = [];
    round("snapshot", () => { listed = loadCwdAgents(); });
    assert.equal(io().readFile, 1);
    assert.equal(listed.find((agent) => agent.id === "a3")?.cwd, join(dir, "moved"));
  });

  it("patrol does not give an archived agent a placeholder directory", async () => {
    const live = join(agentic, "live-gone");
    const archived = join(agentic, "archived-gone");
    writeAgent("live", live);
    writeAgent("old", archived, "2026-09-27T01:00:00.000Z");
    setMissingCwdHooks({ log: () => {} });
    await patrolMissingCwds();
    assert.equal(existsSync(join(live, PLACEHOLDER_NAME)), true);
    assert.equal(existsSync(archived), false);
  });

  it("20 purges out of 120 agents cost no re-listing, and the purged ones leave the list and the index", () => {
    for (let i = 0; i < AGENT_COUNT; i++) writeAgent(`a${i}`, join(dir, "present"));
    loadCwdAgents();
    takePerfSummary(Date.now() + 10 * 60_000);
    let listed: ReturnType<typeof loadCwdAgents> = [];
    round("snapshot", () => {
      for (let i = 0; i < 20; i++) {
        rmSync(join(agents, "bucket", `a${i}.json`));
        forgetPurgedAgent(`a${i}`);
        listed = loadCwdAgents();
      }
    });
    const loop = takePerfSummary(Date.now() + 10 * 60_000)?.loops.snapshot;
    assert.equal(loop?.io.readdir ?? 0, 0, "no directory is listed again");
    assert.ok((loop?.io.stat ?? 0) <= 2, `stat ${loop?.io.stat}`);
    assert.equal(loop?.io.readFile ?? 0, 0);
    assert.equal(listed.length, AGENT_COUNT - 20);
    assert.equal(listed.some((agent) => agent.id === "a0"), false);
    assert.deepEqual(bucketsHolding(agents, "a0"), []);
    assert.deepEqual(bucketsHolding(agents, "a50"), ["bucket"]);
  });

  it("a record written after the purge still shows up once the index is looked at again", () => {
    for (let i = 0; i < 5; i++) writeAgent(`a${i}`, join(dir, "present"));
    loadCwdAgents();
    rmSync(join(agents, "bucket", "a0.json"));
    forgetPurgedAgent("a0");
    writeAgent("fresh", join(dir, "present"));
    invalidateAgentIndex();
    assert.ok(loadCwdAgents().some((agent) => agent.id === "fresh"));
    assert.equal(loadCwdAgents().some((agent) => agent.id === "a0"), false);
  });
});

describe("db migrate failure", () => {
  it("reports the real error, not a second close failure", () => {
    closeDb();
    process.env.KANBAN_DATA_DIR = join(dir, "data2");
    getDb(); closeDb();
    const raw = new DatabaseSync(join(dir, "data2", "kanban.db"));
    raw.exec("INSERT INTO tasks(project, title, role, status, created_at, updated_at) VALUES ('p','t','executor','done','x','x')");
    raw.exec(`INSERT INTO native_session_queue(agent_id, task_id, home, provider, session_id, cwd, status) VALUES ('ag', 1, 'h', 'cursor', 's', '/c', 'pending')`);
    raw.exec("CREATE TRIGGER boom BEFORE UPDATE ON native_session_queue BEGIN SELECT RAISE(ABORT, 'real-migrate-error'); END");
    raw.close();
    assert.throws(() => getDb(), /real-migrate-error/);
  });
});
