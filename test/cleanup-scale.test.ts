/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cardDue, dueCardIds, noteOverdueArchives } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { appendEvent, createTask } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "cleanup-scale-"));
process.env.KANBAN_DATA_DIR = dir;

const CARDS = 400;
const EVENTS_PER_CARD = 30;
const ROUND_LIMIT_MS = 1500;
const MIN = 60_000;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("cleanup rounds at board scale", () => {
  it("scans hundreds of finished cards and tens of thousands of events within a bounded time", () => {
    const db = getDb();
    const ago = new Date(Date.now() - 60 * MIN).toISOString();
    let failing = 0;
    for (let i = 0; i < CARDS; i += 1) {
      const agentId = `scale-agent-${i}`;
      const task = createTask({ project: "scale", title: `card ${i}`, role: "executor", workspacePath: dir });
      db.prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, task.id);
      db.prepare(
        ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n         VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
      ).run(task.id, agentId, ago);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {}, ago);
      for (let n = 0; n < EVENTS_PER_CARD; n += 1) appendEvent(task.id, "cleanup", null, null, "test", { action: "verify_agent", agentId, ok: true }, ago);
      // A few finished cards keep a failed archive line; those must still be looked at.
      const failedArchive = i % 100 === 0;
      appendEvent(task.id, "cleanup", null, null, "test", { action: "archive_agent", agentId, ok: !failedArchive, ...(failedArchive ? { error: "boom" } : {}) }, ago);
      // Some cards are done but their cleanup is still open, as on a live board.
      if (i % 4 !== 1) appendEvent(task.id, "cleanup_finished", null, null, "test", {}, ago);
      if (failedArchive) failing += 1;
    }
    assert.ok(failing > 0);
    const started = performance.now();
    for (let round = 0; round < 3; round += 1) {
      dueCardIds(new Date());
      noteOverdueArchives(new Date());
    }
    const perRoundMs = (performance.now() - started) / 3;
    console.log(`cleanup round ${perRoundMs.toFixed(1)}ms`);
    assert.ok(perRoundMs < ROUND_LIMIT_MS, `one cleanup round took ${perRoundMs.toFixed(0)}ms for ${CARDS} cards, limit ${ROUND_LIMIT_MS}ms`);
  });

  it("snapshot filtering gives the same due cards as checking each card on its own", () => {
    const now = new Date(Date.now() + 24 * 60 * MIN);
    const ids = (getDb().prepare("SELECT id FROM tasks").all() as Array<{ id: number }>).map((row) => row.id);
    const alone = ids.filter((id) => cardDue(id, now));
    assert.deepEqual(dueCardIds(now).sort((a, b) => a - b), alone.sort((a, b) => a - b));
    assert.ok(alone.length > 0, "the failing cards must be due so the comparison is not vacuous");
  });
});
