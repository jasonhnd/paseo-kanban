import { runKanban } from "../server/cli";
/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { invalidateAgentIndex } from "../server/agent-index";
import { resetWakeSender, setWakeSender } from "../server/bus";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { approveTask } from "../server/flow";
import { resolveCliIdentity } from "../server/identity";
import { appendEvent, createTask, getTask } from "../server/store";
import { notifyChildren, retryUnattended } from "../server/wake";

mkdirSync(tmpdir(), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "wake-recipient-scope-"));
const agents = join(root, "agents", "fixture");
process.env.KANBAN_DATA_DIR = join(root, "data");
process.env.KANBAN_AGENTS_DIR = join(root, "agents");
const project = "wake_scope";
const sent: Array<{ id: string; text: string }> = [];

function writeAgent(id: string, labels: Record<string, string> = {}, lastStatus = "idle"): void {
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, `${id}.json`), JSON.stringify({ id, cwd: root, labels, lastStatus, archivedAt: lastStatus === "archived" ? "2026-10-03T00:00:00.000Z" : null }));
  invalidateAgentIndex();
}

function leader(state: "unregistered" | "archived" | "live"): void {
  const config = loadConfig();
  config.supervisorAgentId = "kanban-leader";
  config.supervisors = state === "unregistered" ? {} : { [project]: "project-leader" };
  config.projects = { [project]: { code: "WKS", defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } };
  saveConfig(config);
  writeAgent("project-leader", {}, state === "archived" ? "archived" : "idle");
}

function reviewing(creator: string): number {
  const task = createTask({ project, title: "Waiting for project acceptance", role: "executor", createdByAgent: creator });
  getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
  return task.id;
}

function notices(id: number, kind = "wake_acceptance"): Array<Record<string, unknown>> {
  return (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = ? ORDER BY id").all(id, kind) as Array<{ data_json: string }>).map(row => JSON.parse(row.data_json));
}

beforeEach(() => {
  sent.length = 0;
  getDb().exec("DELETE FROM events; DELETE FROM links; DELETE FROM tasks; DELETE FROM runs; DELETE FROM tokens;");
  writeAgent("schedule-creator", { "paseo.schedule-id": "weekly" });
  writeAgent("guest-creator");
  writeAgent("kanban-leader");
  setWakeSender((id, text) => { sent.push({ id, text }); });
});

after(() => {
  resetWakeSender();
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe("wake recipients must be able to handle project acceptance", () => {
  for (const creator of ["schedule-creator", "guest-creator"]) {
    for (const state of ["unregistered", "archived", "live"] as const) {
      it(`${creator} cannot take the acceptance wake when the project leader is ${state}`, async () => {
        leader(state);
        const role = creator.startsWith("schedule") ? "schedule" : "guest";
        assert.equal(resolveCliIdentity({ PASEO_AGENT_ID: creator }).role, role);
        const id = reviewing(creator);
        approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
        // Both identities remain unable to accept even a card they created.
        await assert.rejects(() => runKanban(["accept", String(id)], { PASEO_AGENT_ID: creator }), role === "schedule" ? new RegExp(localePattern(zhCNPart("leaderRegistry.error.schedule", 0, 4))) : new RegExp(localePattern(zhCNPart("identity.guestDenial", 4, 18))));
        assert.equal(getTask(id).status, "acceptance");
        const fallback = state !== "live";
        assert.deepEqual(sent.map(item => item.id), [fallback ? "kanban-leader" : "project-leader"]);
        assert.equal(notices(id)[0].fallback, fallback);
        assert.equal(notices(id)[0].delivered, true);
        assert.equal(Boolean(getTask(id).unattended_at), fallback);
        if (fallback) assert.match(sent[0].text, new RegExp(localePattern(zhCNPart("wake.fallback.note", 44, 50))));

        // A successful fallback does not spam, or stop a qualified leader taking over later.
        retryUnattended();
        assert.equal(sent.length, 1);
        if (fallback) {
          assert.ok(getTask(id).unattended_at);
          leader("live");
          retryUnattended();
          assert.deepEqual(sent.map(item => item.id), ["kanban-leader", "project-leader"]);
          assert.equal(getTask(id).unattended_at, null);
          retryUnattended();
          assert.equal(sent.length, 2);
        }
      });
    }
  }

  it("a Kanban leader who created the card is still only fallback without a project leader", () => {
    leader("unregistered");
    const id = reviewing("kanban-leader");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    assert.deepEqual(sent.map(item => item.id), ["kanban-leader"]);
    assert.equal(notices(id)[0].fallback, true);
    assert.ok(getTask(id).unattended_at);
  });

  it("a registered project leader who created the card remains the primary recipient", () => {
    leader("live");
    const id = reviewing("project-leader");
    approveTask(id, zhCNPart("cardDrawer.verdict.approve", 2, 4));
    assert.deepEqual(sent.map(item => item.id), ["project-leader"]);
    assert.equal(notices(id)[0].fallback, false);
    assert.equal(getTask(id).unattended_at, null);
  });

  it("an old delivered schedule wake cannot suppress recovery to a qualified leader", () => {
    leader("unregistered");
    const id = reviewing("schedule-creator");
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(id);
    appendEvent(id, "approve", "reviewing", "acceptance", "reviewer", {});
    appendEvent(id, "wake_acceptance", null, "acceptance", "scheduler", { agentId: "schedule-creator", fallback: false, delivered: true });
    retryUnattended();
    assert.deepEqual(sent.map(item => item.id), ["kanban-leader"]);
    assert.ok(getTask(id).unattended_at);
    leader("live");
    retryUnattended();
    assert.deepEqual(sent.map(item => item.id), ["kanban-leader", "project-leader"]);
    assert.equal(getTask(id).unattended_at, null);
  });

  it("a schedule child builder and guest parent creator cannot consume the children wake", () => {
    leader("unregistered");
    const parent = createTask({ project, title: "demo fixture", role: "supervisor", initialStatus: "triage", createdByAgent: "guest-creator" });
    const child = createTask({ project, title: "demo fixture", role: "reader", parentIds: [parent.id], createdByAgent: "schedule-creator" });
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(child.id);
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(parent.id);
    notifyChildren(parent.id);
    assert.deepEqual(sent.map(item => item.id), ["kanban-leader"]);
    assert.equal(notices(parent.id, "wake_children")[0].fallback, true);
    assert.ok(getTask(parent.id).unattended_at);
    leader("live");
    retryUnattended();
    assert.ok(sent.some(item => item.id === "project-leader"));
    assert.equal(getTask(parent.id).unattended_at, null);
  });
});
