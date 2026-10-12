/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { PREREQUISITE_IDLE_MS, scanPrerequisiteAttention } from "../server/dependency-attention";
import { applyNudge } from "../server/flow";
import { isProjectPaused, pausedProjectsPath, readPausedProjects } from "../server/paused";
import { prMergeState, resetMergeCache, setGhRunner, writeContract, type GhRunner } from "../server/pr";
import { resetStallScanForTests, scanStalled } from "../server/stall";
import { appendEvent, claimStatus, createTask } from "../server/store";
import { approveTask } from "../server/flow";
import {
  notifyParentMergeProblem,
  resetAgentAliveCheck,
  resetBoardWakeForTests,
  retryUnattended,
  setAgentAliveCheck,
} from "../server/wake";

// The paused list lives in a temp state dir; the cockpit's real state directory is never touched.
const dir = mkdtempSync(join(tmpdir(), "paused-projects-"));
const rolesDir = join(dir, "fleet");
mkdirSync(rolesDir, { recursive: true });
process.env.KANBAN_DATA_DIR = dir;

process.env.HOME = dir;
const pausedFile = join(rolesDir, "paused-projects.json");

const PR = "https://github.com/acme/widgets/pull/9";
const MIN = 60_000;
const sent: Array<{ id: string; text: string }> = [];

function pause(...projects: string[]): void {
  writeFileSync(pausedFile, JSON.stringify(projects.map((project) => ({ project, since: "2026-10-03T18:29:49+09:00", note: "Test" }))));
}

function resume(): void {
  rmSync(pausedFile, { force: true });
}

function count(taskId: number, like: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind LIKE ?").get(taskId, like) as { n: number }).n;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function config(): KanbanConfig {
  return {
    autoStart: { wake: false, chain: false },
    supervisorAgentId: "kanban-boss",
    supervisors: { demo_tasks: "demo_tasks-leader", other: "other-leader" },
    concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
  };
}

after(() => {
  resetWakeSender();
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  setGhRunner(null);
  resetMergeCache();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ROLES_STATE_DIR;
});

beforeEach(() => {
  sent.length = 0;
  resume();
  resetBoardWakeForTests();
  resetStallScanForTests();
  resetMergeCache();
  getDb().exec("DELETE FROM events; DELETE FROM tasks;");
  saveConfig(config());
  setAgentAliveCheck(() => true);
  setWakeSender((id, text) => { sent.push({ id, text }); });
});

describe("F5: reading the paused list", () => {
  it("reads only the unified root Fleet project pause list", () => {
    assert.equal(pausedProjectsPath(), null);
    pause("demo_tasks", "demo_web");
    assert.equal(pausedProjectsPath(), pausedFile);
    assert.deepEqual([...readPausedProjects()].sort(), ["demo_tasks", "demo_web"]);
    assert.equal(isProjectPaused("demo_tasks"), true);
    assert.equal(isProjectPaused("other"), false);
    assert.equal(isProjectPaused(null), false);
  });

  it("treats a missing, broken or wrong-shaped file as nothing paused, and never writes it", () => {
    assert.equal(isProjectPaused("demo_tasks"), false);
    for (const content of ["{broken", "{}", '"demo_tasks"', ""]) {
      writeFileSync(pausedFile, content);
      assert.equal(isProjectPaused("demo_tasks"), false, content);
    }
    pause("demo_tasks");
    assert.equal(isProjectPaused("demo_tasks"), true);
    writeFileSync(pausedFile, "{broken");
    assert.equal(isProjectPaused("demo_tasks"), false);
  });

  it("ignores rows without a project name", () => {
    writeFileSync(pausedFile, JSON.stringify([{ note: "x" }, null, 3, { project: "" }, { project: "demo_tasks" }]));
    assert.deepEqual([...readPausedProjects()], ["demo_tasks"]);
  });
});

function reviewing(project: string): number {
  const task = createTask({ project, title: `Review ${project}`, role: "executor", workspacePath: dir, createdByAgent: "creator" });
  getDb().prepare("UPDATE tasks SET status = 'reviewing', handoff_json = ? WHERE id = ?").run(JSON.stringify({ summary: "Finished" }), task.id);
  return task.id;
}

describe("F5: a paused project's card is not woken", () => {
  it("writes no wake_* event and sends nothing when a paused project's card reaches acceptance", async () => {
    pause("demo_tasks");
    const id = reviewing("demo_tasks");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    retryUnattended();
    await flush();
    assert.equal(sent.length, 0);
    assert.equal(count(id, "wake%"), 0);
    assert.equal(count(id, "unattended"), 0);
  });

  it("wakes the other projects as before", async () => {
    pause("demo_tasks");
    const id = reviewing("other");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    await flush();
    assert.equal(sent.filter((item) => item.id === "other-leader").length, 1);
    assert.equal(count(id, "wake_acceptance"), 1);
  });

  it("wakes again once the project is resumed, or when the file is deleted or broken", async () => {
    pause("demo_tasks");
    const id = reviewing("demo_tasks");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    retryUnattended();
    assert.equal(sent.length, 0);
    resume();
    retryUnattended();
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(count(id, "wake_acceptance"), 1);

    pause("demo_tasks");
    const second = reviewing("demo_tasks");
    approveTask(second, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    writeFileSync(pausedFile, "{broken");
    retryUnattended();
    await flush();
    assert.equal(sent.length, 2);
  });

  it("does not send the Kanban leader a wake about a paused project's card (wake_parent_merge, event 868630)", async () => {
    pause("demo_tasks");
    setAgentAliveCheck((id) => id === "kanban-boss");
    const parent = createTask({
      project: "other", title: "Parent PR", role: "executor", workspacePath: dir,
      contract: writeContract({ kind: "local-only", repo: null, pr: PR, awaiting: false }),
    });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(parent.id);
    const child = createTask({ project: "demo_tasks", title: "Child", role: "executor", workspacePath: dir, parentIds: [parent.id] });
    const gh: GhRunner = async () => JSON.stringify({ state: "CLOSED", mergedAt: null });
    await prMergeState(PR, { run: gh });
    await notifyParentMergeProblem(parent.id);
    await flush();
    assert.equal(sent.length, 0);
    assert.equal(count(parent.id, "wake_parent_merge"), 0);
    resume();
    await notifyParentMergeProblem(parent.id);
    await flush();
    assert.equal(sent.length, 1, `child ${child.id} is told once it is no longer paused`);
  });
});

describe("F5: a paused project's agents are not nudged", () => {
  it("applyNudge neither reminds, hands in nor blocks", () => {
    pause("demo_tasks");
    const task = createTask({ project: "demo_tasks", title: "Paused executor card", role: "executor" });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-paused", task.id);
    const timeline = [{ type: "assistant_message", text: "After tests finish" }];
    const start = Date.parse("2026-10-05T04:00:00.000Z");
    for (const offset of [0, 10, 20, 30]) assert.equal(applyNudge(task.id, false, { nowMs: start + offset * MIN, timeline }).action, "none");
    resume();
    assert.equal(applyNudge(task.id, false, { nowMs: start + 40 * MIN, timeline }).action, "remind");
  });

  it("the idle scan sends no stall nudge for a paused project", async () => {
    pause("demo_tasks");
    const task = createTask({ project: "demo_tasks", title: "Paused stalled card", role: "decision" });
    claimStatus(task.id, "ready", "running", "test");
    getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("agent-idle", task.id);
    const now = new Date("2026-10-05T04:30:00.000Z");
    const since = new Date(now.getTime() - 20 * MIN).toISOString();
    const nudges: string[] = [];
    const scan = () => scanStalled({
      now, config: config(), intervalMs: 0, idleMs: 10 * MIN,
      agentActivity: () => ({ state: "idle", since }),
      send: async (id) => { nudges.push(id); },
    });
    await scan();
    assert.deepEqual(nudges, []);
    assert.equal(count(task.id, "stall_nudge"), 0);
    resume();
    resetStallScanForTests();
    await scan();
    assert.deepEqual(nudges, ["agent-idle"]);
  });
});

describe("F5: a paused project's prerequisites do not send reminders", () => {
  it("skips wake_prerequisite for a paused project's card", async () => {
    pause("demo_tasks");
    const start = new Date("2026-10-02T00:00:00.000Z");
    const parent = createTask({ project: "demo_tasks", title: "Parent", role: "executor", workspacePath: dir, createdByAgent: "creator" });
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(parent.id);
    appendEvent(parent.id, "fixture_entry", "reviewing", "acceptance", "test", {}, start.toISOString());
    createTask({ project: "demo_tasks", title: "Child", role: "executor", workspacePath: dir, parentIds: [parent.id] });
    const prereq = () => scanPrerequisiteAttention({
      now: new Date(start.getTime() + PREREQUISITE_IDLE_MS + 1), config: config(),
      send: async (id, text) => { sent.push({ id, text }); },
    });
    await prereq();
    assert.equal(sent.length, 0);
    assert.equal(count(parent.id, "wake_prerequisite"), 0);
    resume();
    await prereq();
    assert.equal(sent.length, 1);
  });
});

describe("F5: the module is wired into the board", () => {
  it("is read by the wake, stall and prerequisite code, not only by the module itself", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const out = execFileSync("git", ["grep", "-il", "paused", "--", "server/"], { cwd: root, encoding: "utf8" });
    for (const file of ["server/paused.ts", "server/wake.ts", "server/stall.ts", "server/dependency-attention.ts", "server/flow.ts", "server/restart-stall.ts", "server/acceptance-watch.ts", "server/schedule.ts"]) {
      assert.ok(out.includes(file), `${file} ${zhCNPart("history.noMatch", 0, 2)}Demo text`);
    }
  });
});
