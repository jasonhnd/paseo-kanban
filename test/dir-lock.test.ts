/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { runKanban } from "./helpers/compat-cli";
import { setProjectWorkspace } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { type AgentLauncher } from "../server/dispatch";
import { startTask } from "./helpers/compat-dispatch";
import type { Profile } from "../server/profiles";
import { appendEvent, createTask, getTask, setHold } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "dir-lock-"));
process.env.KANBAN_DATA_DIR = dir;
mkdirSync(dir, { recursive: true });

const executor: Profile = { id: "ex", name: "dir-lock-exec", role: "executor", family: "xai", provider: "alternate", model: "grok-4.7", pool: "alternate" };
const reader: Profile = { id: "rd", name: "dir-lock-reader", role: "reader", provider: "alternate", model: "grok-4.7" };
const reviewer: Profile = { id: "rv", name: "dir-lock-review", role: "reviewer", family: "anthropic", provider: "alternate", model: "grok-4.7" };

function room(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function launcher(): AgentLauncher & { created: string[]; sent: string[] } {
  const created: string[] = [];
  const sent: string[] = [];
  const api: AgentLauncher & { created: string[]; sent: string[] } = {
    created,
    sent,
    async create() {
      const id = `agent-${created.length + 1}`;
      created.push(id);
      return { id };
    },
    async send(agentId) {
      sent.push(agentId);
    },
  };
  return api;
}

function pick(role: Profile) {
  return { profiles: [executor, reader, reviewer], chosen: role, reason: "Test" };
}

function eventData(taskId: number, kind: string): Record<string, unknown> {
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(taskId, kind) as
    | { data_json: string }
    | undefined;
  return JSON.parse(row?.data_json ?? "{}") as Record<string, unknown>;
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("directory lock on manual start", () => {
  beforeEach(() => {
    setProjectWorkspace("lock", { parallel: false });
  });

  it("refuses a second file-changing card, then starts it with --force and clears the hold", async () => {
    const path = room("held");
    const box = launcher();
    const holder = createTask({ project: "lock", title: "Directory occupied", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const second = createTask({ project: "lock", title: "Ready to start", role: "executor", workspacePath: path });
    setHold(second.id, zhCN("schedule.sameWorkspace"));
    await assert.rejects(() => startTask(second.id, box, "test", pick(executor)), new RegExp(zhCN("dispatch.sameWorkspaceBusy", {"card":"[A-Z0-9]+_\\d+","title":"Directory occupied"})));
    assert.equal(getTask(second.id).status, "ready");
    assert.equal(getTask(second.id).hold_reason, zhCN("schedule.sameWorkspace"));
    assert.equal(box.created.length, 1);

    await startTask(second.id, box, "test", { ...pick(executor), force: true });
    assert.equal(getTask(second.id).status, "running");
    assert.equal(getTask(second.id).hold_reason, null);
    assert.equal(eventData(second.id, "started").forced, true);
    assert.equal(box.created.length, 2);
  });

  it("lets a reader and a reviewer start in a directory an executor already holds", async () => {
    const path = room("readers");
    const box = launcher();
    const holder = createTask({ project: "lock", title: "Executor running", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const reading = createTask({ project: "lock", title: "demo fixture", role: "reader", workspacePath: path });
    setHold(reading.id, zhCN("schedule.sameWorkspace"));
    await startTask(reading.id, box, "test", pick(reader));
    assert.equal(getTask(reading.id).status, "running");
    assert.equal(getTask(reading.id).hold_reason, null);
    assert.equal(eventData(reading.id, "started").forced, undefined);

    const review = createTask({ project: "lock", title: "Reviewer", role: "reviewer", workspacePath: path });
    getDb().prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(review.id);
    await startTask(review.id, box, "test", pick(reviewer));
    assert.equal(getTask(review.id).status, "reviewing");
    assert.equal(eventData(review.id, "started").forced, undefined);
  });

  it("does not lock a worktree card against the directory", async () => {
    const path = room("tree");
    const box = launcher();
    const holder = createTask({ project: "lock", title: "Directory executor", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    const copy = createTask({ project: "lock", title: "demo fixture", role: "executor", workspacePath: path });
    mkdirSync(join(path, ".git"));
    appendEvent(copy.id, "worktree_created", null, null, "test", { directory: path, branch: "kanban/copy", workspaceId: "wt-copy" });
    getDb().prepare("UPDATE tasks SET workspace_kind = 'worktree' WHERE id = ?").run(copy.id);
    await startTask(copy.id, box, "test", pick(executor));
    assert.equal(getTask(copy.id).status, "running");
    assert.equal(eventData(copy.id, "started").forced, undefined);
  });

  it("clears the hold when a card starts with the directory free", async () => {
    const path = room("free");
    const task = createTask({ project: "lock", title: "Empty directory", role: "executor", workspacePath: path });
    setHold(task.id, zhCN("schedule.sameWorkspace"));
    await startTask(task.id, launcher(), "test", pick(executor));
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).hold_reason, null);
    assert.equal(eventData(task.id, "started").forced, undefined);
  });

  it("resumes only with --force while another card holds the directory, and clears the hold", async () => {
    const path = room("resume");
    const box = launcher();
    const task = createTask({ project: "lock", title: "Rework", role: "executor", workspacePath: path });
    await startTask(task.id, box, "test", pick(executor));
    const agentId = getTask(task.id).executor_agent_id;
    getDb().prepare("UPDATE tasks SET status = 'rework', hold_reason = ? WHERE id = ?").run(zhCN("schedule.sameWorkspace"), task.id);
    const holder = createTask({ project: "lock", title: "demo fixture Editing", role: "executor", workspacePath: path });
    await startTask(holder.id, box, "test", pick(executor));
    await assert.rejects(() => startTask(task.id, box, "test", pick(executor)), new RegExp(zhCN("dispatch.sameWorkspaceBusy", {"card":"[A-Z0-9]+_\\d+","title":"demo fixture Editing"})));
    assert.equal(getTask(task.id).status, "rework");
    assert.equal(getTask(task.id).hold_reason, zhCN("schedule.sameWorkspace"));
    assert.equal(box.sent.length, 0);
    await startTask(task.id, box, "test", { ...pick(executor), force: true });
    assert.equal(getTask(task.id).status, "running");
    assert.equal(getTask(task.id).hold_reason, null);
    assert.equal(eventData(task.id, "resumed").forced, true);
    assert.deepEqual(box.sent, [agentId]);
  });

  it("rejects from the command line unless --force, and does not open Paseo", async () => {
    const path = room("cli");
    const config = join(dir, "paseo-config.json");
    writeFileSync(
      config,
      JSON.stringify({
        daemon: {
          agentProfiles: [
            { ...executor, id: "cli-ex", name: "dir-lock-cli", pool: "dir-lock" },
            { ...reviewer, id: "cli-rv", name: "dir-lock-cli-review", provider: "claude", model: "demo-review", pool: "dir-lock-review" },
          ],
        },
      }),
    );
    const previousConfig = process.env.KANBAN_PASEO_CONFIG;
    const previousPools = process.env.KANBAN_POOL_STATUS;
    process.env.KANBAN_PASEO_CONFIG = config;
    process.env.KANBAN_POOL_STATUS = join(dir, "no-pools.json");
    const box = launcher();
    try {
      const holder = createTask({ project: "lock", title: "CLI occupancy", role: "executor", workspacePath: path });
      await startTask(holder.id, box, "test", pick(executor));
      const second = createTask({ project: "lock", title: "CLI start", role: "executor", workspacePath: path });
      await assert.rejects(() => runKanban(["start", String(second.id)], {}, { launcher: box }), new RegExp(zhCN("dispatch.sameWorkspaceBusy", {"card":"[A-Z0-9]+_\\d+","title":"CLI occupancy"})));
      assert.equal(getTask(second.id).status, "ready");
      assert.equal(box.created.length, 1);
      await runKanban(["start", String(second.id), "--force"], {}, { launcher: box });
      assert.equal(getTask(second.id).status, "running");
      assert.equal(eventData(second.id, "started").forced, true);
      const help = String(await runKanban(["start", "--help"]));
      assert.match(help, /--force/);
      assert.match(help, new RegExp(localePattern(zhCNPart("reviewHold.next.pass", 48, 51))));
    } finally {
      if (previousConfig === undefined) delete process.env.KANBAN_PASEO_CONFIG;
      else process.env.KANBAN_PASEO_CONFIG = previousConfig;
      if (previousPools === undefined) delete process.env.KANBAN_POOL_STATUS;
      else process.env.KANBAN_POOL_STATUS = previousPools;
    }
  });
});
