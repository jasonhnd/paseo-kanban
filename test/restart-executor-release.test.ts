/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { requestChanges } from "../server/flow";
import { createTask, getTask, unblockTask } from "../server/store";
import type { Profile } from "../server/profiles";

const dir = mkdtempSync(join(tmpdir(), "restart-release-"));
const agents = join(dir, "agents");
mkdirSync(agents);
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = agents;
const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "openai", provider: "codex", model: "test" };
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

for (const historyOnly of [false, true]) {
  it(`third rejection → archived reviewer unblock → scheduler replaces ${historyOnly ? "runs-only" : "bound"} executor`, async () => {
    const cwd = join(dir, `room-${historyOnly}`);
    mkdirSync(cwd);
    const task = createTask({ project: "restart", title: "third rejection", role: "executor", workspacePath: cwd });
    const old = `old-${historyOnly}`;
    const reviewer = `review-${historyOnly}`;
    const current = `new-${historyOnly}`;
    writeFileSync(join(agents, `${reviewer}.json`), JSON.stringify({ id: reviewer, archivedAt: "2026-10-06T00:00:00Z" }));
    getDb().prepare("UPDATE tasks SET status = 'reviewing', review_round = 2, agent_id = ?, executor_agent_id = ? WHERE id = ?").run(reviewer, old, task.id);
    getDb().prepare(("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, started_at, ended_at, end_kind) VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'codex', ?, ?, 'complete')")).run(task.id, old, "2026-10-06T00:00:00Z", "2026-10-06T01:00:00Z");
    assert.equal(requestChanges(task.id, "third failure", "regression").status, "blocked");
    assert.equal(unblockTask(task.id, "supervisor").status, "ready");
    if (historyOnly) getDb().prepare("UPDATE tasks SET executor_agent_id = NULL WHERE id = ?").run(task.id);
    await startTask(task.id, { async create() { return { id: current }; }, async send() {} }, "scheduler", { profiles: [executor], chosen: executor, reason: "test" });
    assert.equal(getTask(task.id).executor_agent_id, current);
    const released = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'release_agent'").all(task.id) as Array<{ data_json: string }>;
    const ids = released.map(row => JSON.parse(row.data_json).agentId);
    assert.equal(ids.filter(id => id === old).length, 1, "superseded executor enters cleanup exactly once");
    assert.ok(!ids.includes(current), "current executor is never released");
  });
}
