/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setWakeSender } from "../server/bus";
import { runKanban } from "../server/cli";
import { loadConfig, saveConfig, setProjectSupervisor } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { createTask, getTask } from "../server/store";
import { notifyChildren, notifyTask, resetAgentAliveCheck, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "handover-"));
process.env.KANBAN_DATA_DIR = dir;
// TEST_0188: takeover checks read agent records; an empty fixture directory means every old session is gone.
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
const project = "handover_proj";
const KANBAN = "kanban-boss";

after(() => {
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  const config = loadConfig();
  config.projects = { [project]: { code: "HOV", defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } };
  config.supervisors = {};
  config.supervisorAgentId = KANBAN;
  saveConfig(config);
  getDb().prepare("DELETE FROM events").run();
  getDb().prepare("DELETE FROM tasks").run();
});

function card(by: string, status = "triage", proj = project) {
  const task = createTask({ project: proj, title: `Task ${by}`, role: "executor", workspacePath: dir, createdByAgent: by });
  getDb().prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
  return task.id;
}

function events(id: number) {
  return getDb().prepare("SELECT kind, actor, data_json FROM events WHERE task_id = ? AND kind = 'creator_changed'").all(id) as Array<{ actor: string; data_json: string }>;
}

describe("handover", () => {
  it("moves open cards, records creator_changed, and updates the registry", async () => {
    setProjectSupervisor(project, "old");
    const open = card("old");
    const done = card("old", "done");
    const other = card("someone");
    const result = (await runKanban(["handover", "--project", "HOV", "--to", "new"], { PASEO_AGENT_ID: "new" })) as { taskIds: number[] };
    assert.deepEqual(result.taskIds, [open]);
    assert.equal(getTask(open).created_by_agent, "new");
    assert.equal(getTask(done).created_by_agent, "old");
    assert.equal(getTask(other).created_by_agent, "someone");
    assert.equal(loadConfig().supervisors[project], "new");
    const [event] = events(open);
    assert.deepEqual(JSON.parse(event.data_json), { from: "old", to: "new", reason: zhCN("handover.reason") });
  });

  it("dry-run writes nothing", async () => {
    setProjectSupervisor(project, "old");
    const open = card("old");
    const result = (await runKanban(["handover", "--project", project, "--to", "new", "--dry-run"], { PASEO_AGENT_ID: "new" })) as { taskIds: number[]; dryRun: boolean };
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.taskIds, [open]);
    assert.equal(getTask(open).created_by_agent, "old");
    assert.equal(loadConfig().supervisors[project], "old");
    assert.equal(events(open).length, 0);
  });

  it("honours --from when nobody is registered, and requires it otherwise", async () => {
    const open = card("ghost");
    await assert.rejects(() => runKanban(["handover", "--project", project, "--to", "new"], { PASEO_AGENT_ID: "new" }), /--from/);
    await runKanban(["handover", "--project", project, "--to", "new", "--from", "ghost"], { PASEO_AGENT_ID: "new" });
    assert.equal(getTask(open).created_by_agent, "new");
  });

  it("allows the Kanban leader, refuses a third party", async () => {
    setProjectSupervisor(project, "old");
    const open = card("old");
    await assert.rejects(() => runKanban(["handover", "--project", project, "--to", "new"], { PASEO_AGENT_ID: "stranger" }), new RegExp("Kanban <leader>" + localePattern(zhCNPart("handover.error.authority", 31, 38))));
    assert.equal(getTask(open).created_by_agent, "old");
    await runKanban(["handover", "--project", project, "--to", "new"], { PASEO_AGENT_ID: KANBAN });
    assert.equal(getTask(open).created_by_agent, "new");
  });

  it("--kanban-leader switches supervisorAgentId and moves the old Kanban leader's cards across projects", async () => {
    const a = card(KANBAN);
    const b = card(KANBAN, "triage", "other_proj");
    await runKanban(["handover", "--kanban-leader", "--to", "kanban-new"], { PASEO_AGENT_ID: "kanban-new" });
    assert.equal(loadConfig().supervisorAgentId, "kanban-new");
    assert.equal(getTask(a).created_by_agent, "kanban-new");
    assert.equal(getTask(b).created_by_agent, "kanban-new");
    assert.equal(events(b).length, 1);
  });

  it("supervise prints a handover hint that actually works after the registry is overwritten", async () => {
    setProjectSupervisor(project, "old");
    const open = card("old");
    const result = (await runKanban(["supervise", "--project", "HOV"], { PASEO_AGENT_ID: "fresh" })) as { hint: string };
    assert.equal(result.hint, zhCN("leaderRegistry.supervise.hint", {"project":"HOV","agent":"f","from":"resh --from old"}));
    await runKanban(["handover", "--project", "HOV", "--to", "fresh", "--from", "old"], { PASEO_AGENT_ID: "fresh" });
    assert.equal(getTask(open).created_by_agent, "fresh");
  });

  it("refuses no identity, workers and third parties without touching db or config", async () => {
    setProjectSupervisor(project, "old");
    const open = card("old");
    getDb().prepare("UPDATE tasks SET agent_id = 'worker-x' WHERE id = ?").run(open);
    const before = JSON.stringify(loadConfig());
    for (const env of [{}, { PASEO_AGENT_ID: "worker-x" }, { PASEO_AGENT_ID: "stranger" }]) {
      await assert.rejects(() => runKanban(["handover", "--project", project, "--to", "arbitrary"], env), new RegExp("forbidden|" + localePattern(zhCNPart("taskLifecycle.error.notBlocked", 0, 2)) + "|" + localePattern(zhCNPart("cardDrawer.handoff.title", 2, 4))));
      await assert.rejects(() => runKanban(["handover", "--kanban-leader", "--to", "arbitrary"], env));
    }
    assert.equal(getTask(open).created_by_agent, "old");
    assert.equal(JSON.stringify(loadConfig()), before);
    assert.equal(events(open).length, 0);
  });
});

describe("wake skips a stale creator", () => {
  it("children notice goes to the registered leader when parent and builder are both stale", () => {
    const sent: string[] = [];
    setWakeSender((id) => { sent.push(id); });
    setProjectSupervisor(project, "current");
    setAgentAliveCheck((id) => id === "stale" || id === "current" || id === KANBAN);
    const parent = card("stale", "waiting");
    const child = card("stale", "done");
    getDb().prepare("INSERT INTO links (task_id, parent_id) VALUES (?, ?)").run(child, parent);
    notifyChildren(parent);
    assert.deepEqual(sent, ["current"]);
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_children'").get(parent) as { data_json: string };
    const data = JSON.parse(row.data_json) as { agentId: string; fallbackFrom: string };
    assert.equal(data.agentId, "current");
    assert.equal(data.fallbackFrom, "stale");
  });

  it("wakes the registered leader and records fallbackFrom", () => {
    const sent: string[] = [];
    setWakeSender((id) => { sent.push(id); });
    setProjectSupervisor(project, "current");
    setAgentAliveCheck((id) => id === "stale" || id === "current" || id === KANBAN);
    const id = card("stale", "acceptance");
    notifyTask(getTask(id), "acceptance", zhCNPart("wake.acceptance.next", 0, 3));
    assert.deepEqual(sent, ["current"]);
    const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'wake_acceptance'").get(id) as { data_json: string };
    const data = JSON.parse(row.data_json) as { agentId: string; fallbackFrom: string };
    assert.equal(data.agentId, "current");
    assert.equal(data.fallbackFrom, "stale");
  });
});
