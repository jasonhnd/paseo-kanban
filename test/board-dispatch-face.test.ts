/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import { UI_ACTOR } from "../shared/actors";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { decisionBoardExtras } from "../server/decisions";
import { profileModels } from "../server/profile-models";
import { createTask, listBoard } from "../server/store";
import { assignerShortLabel, cardBadge, cardModelLabel, shortModelName } from "../shared/labels";

const dir = mkdtempSync(join(tmpdir(), "TEST_0170-"));
process.env.KANBAN_DATA_DIR = dir;
const profilesFile = join(dir, "paseo-config.json");
process.env.KANBAN_PASEO_CONFIG = profilesFile;
const project = "demo_board";

beforeEach(() => {
  const config = loadConfig();
  config.projects = { [project]: { code: "TEST", defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false } };
  config.supervisors = { [project]: "project-leader" };
  config.supervisorAgentId = "kanban-leader";
  saveConfig(config);
  writeFileSync(profilesFile, JSON.stringify({ daemon: { agentProfiles: [
    { id: "p1", name: "Executor · Sonnet (Claude candidate)", provider: "claude", model: "claude-sonnet-5-5" },
    { id: "p2", name: "Profile without model", provider: "claude" },
  ] } }));
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KANBAN_PASEO_CONFIG;
});

function addRun(taskId: number, profile: string | null, model: string | null) {
  getDb().prepare(`INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at) VALUES (?, ?, 'executor', ?, 'claude', ?, 'anthropic', 0, ?)`)
    .run(taskId, "agent-x", profile, model, new Date().toISOString());
}

describe("short labels", () => {
  it("shortens model ids by shape, not by a table", () => {
    assert.equal(shortModelName("claude-sonnet-5-5"), "Claude Sonnet 5.5");
    assert.equal(shortModelName("claude-sonnet-5-5[1m]"), "Claude Sonnet 5.5");
    assert.equal(shortModelName("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
    assert.equal(shortModelName("gpt-6.1-sol"), "GPT-6.1-Sol");
    assert.equal(shortModelName("openai-codex:gpt-6-astra"), "GPT-6-Astra");
    assert.equal(shortModelName("grok-4.7"), "Grok 4.7");
    assert.equal(shortModelName("something-else"), "something-else");
    assert.equal(shortModelName(""), null);
  });

  it("shows unassigned before any run, then the model, the profile's model, the profile name", () => {
    assert.equal(cardModelLabel({ hasRun: false, model: "grok-4.7", profileModel: null, profile: zhCN("labels.role.executor") }), zhCN("labels.model.unassigned"));
    assert.equal(cardModelLabel({ hasRun: true, model: "grok-4.7", profileModel: "gpt-6.1-sol", profile: zhCN("labels.role.executor") }), "Grok 4.7");
    assert.equal(cardModelLabel({ hasRun: true, model: null, profileModel: "gpt-6.1-sol", profile: zhCN("labels.role.executor") }), "GPT-6.1-Sol");
    assert.equal(cardModelLabel({ hasRun: true, model: null, profileModel: null, profile: ((zhCN("labels.role.executor") + " ") + "· Sample profile") }), ((zhCN("labels.role.executor") + " ") + "· Sample profile"));
    assert.equal(cardModelLabel({ hasRun: true, model: null, profileModel: null, profile: null }), zhCN("labels.model.unrecorded"));
  });

  it("names the sender as project leader, Kanban leader, user or titled agent, never an id", () => {
    const base = { createdBy: null, projectLeaderId: "pl", kanbanLeaderId: "kl", projectCode: "TEST", project, agentTitle: null };
    assert.equal(assignerShortLabel({ ...base, createdByAgent: "pl" }), "TEST <leader>");
    assert.equal(assignerShortLabel({ ...base, createdByAgent: "kl" }), "Kanban <leader>");
    assert.equal(assignerShortLabel({ ...base, createdBy: UI_ACTOR, createdByAgent: null }), zhCN("labels.assigner.user"));
    assert.equal(assignerShortLabel({ ...base, createdByAgent: "abcdef12-0000", agentTitle: (zhCNPart("identity.guestDenial", 102, 104) + " agent " + zhCN("missingCwd.report.title")) }), (zhCNPart("identity.guestDenial", 102, 104) + " agent " + zhCN("missingCwd.report.title")));
    assert.equal(assignerShortLabel({ ...base, createdByAgent: "abcdef12-0000" }), zhCN("labels.assigner.otherAgent"));
    assert.equal(assignerShortLabel({ ...base, createdByAgent: "pl", projectCode: null }), `${project} <leader>`);
  });

  it("uses the plain status names on the face", () => {
    assert.equal(cardBadge({ status: "running", reviewRound: 0 }), zhCN("labels.status.running"));
    assert.equal(cardBadge({ status: "in_review", reviewRound: 0 }), zhCN("labels.status.inReview"));
    assert.equal(cardBadge({ status: "acceptance", reviewRound: 0 }), zhCN("labels.status.acceptance"));
  });
});

describe("board card face fields", () => {
  it("fills sender and unassigned for a card with no run", () => {
    const task = createTask({ project, title: "Not started", role: "executor", workspacePath: dir, createdByAgent: "project-leader" });
    const card = listBoard().tasks.find((row) => row.id === task.id)!;
    assert.equal(card.assignerShort, "TEST <leader>");
    assert.equal(card.modelShort, zhCN("labels.model.unassigned"));
  });

  it("reads the model from the run, falls back to the profile's model, then to the profile name", () => {
    const kanbanTask = createTask({ project, title: "A", role: "executor", workspacePath: dir, createdByAgent: "kanban-leader" });
    addRun(kanbanTask.id, "Executor · Sonnet (Claude candidate)", "claude-sonnet-5-5");
    const viaProfile = createTask({ project, title: "B", role: "executor", workspacePath: dir });
    addRun(viaProfile.id, "Executor · Sonnet (Claude candidate)", null);
    const nameOnly = createTask({ project, title: "C", role: "executor", workspacePath: dir });
    addRun(nameOnly.id, "Profile without model", null);
    const byId = new Map(listBoard().tasks.map((row) => [row.id, row]));
    assert.equal(byId.get(kanbanTask.id)!.assignerShort, "Kanban <leader>");
    assert.equal(byId.get(kanbanTask.id)!.modelShort, "Claude Sonnet 5.5");
    assert.equal(byId.get(viaProfile.id)!.modelShort, "Claude Sonnet 5.5");
    assert.equal(byId.get(nameOnly.id)!.modelShort, "Profile without model");
  });

  it("survives an unreadable profile file", () => {
    writeFileSync(profilesFile, "{not json");
    assert.equal(profileModels().size, 0);
    const task = createTask({ project, title: "D", role: "executor", workspacePath: dir });
    addRun(task.id, "Sample profile", null);
    assert.equal(listBoard().tasks.find((row) => row.id === task.id)!.modelShort, "Sample profile");
  });
});

describe("decisions are re-read on every call", () => {
  it("returns the current file content each time, with no process-level cache", () => {
    const file = join(dir, "decisions.json");
    const row = (id: string) => ({ id, project, title: `t-${id}`, detail: "d", blocking: false, status: "open", createdAt: "2026-10-03T00:00:00Z", agentId: null });
    writeFileSync(file, JSON.stringify([row("a")]));
    const first = decisionBoardExtras({}, undefined, { path: file });
    writeFileSync(file, JSON.stringify([row("a"), row("b")]));
    const second = decisionBoardExtras({}, undefined, { path: file });
    writeFileSync(file, JSON.stringify([{ ...row("a"), status: "done" }]));
    const third = decisionBoardExtras({}, undefined, { path: file });
    assert.deepEqual([first, second, third].map((snap) => snap.decisions.items.length), [1, 2, 0]);
  });
});
