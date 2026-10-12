/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import { UI_ACTOR } from "../shared/actors";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import type { ListedWorkspace } from "../server/placement";
import { directoryForProject, listAgentChoices, type AgentFile } from "../server/open";
import { addComment, appendEvent, createTask } from "../server/store";
import { isLeaderSessionTitle, notifySupervisorRegistered, supervisorCliNote, supervisorRegisterBlock, supervisorView } from "../server/supervisor";
import { ensureSupervisorToken } from "../server/tokens";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "supervisor-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("registered supervisor", () => {
  it("sends a CLI note and keeps the supervisor token out of events and comments", async () => {
    const token = ensureSupervisorToken();
    assert.ok(token.length >= 32);
    const sent: Array<{ agentId: string; text: string }> = [];
    const result = await notifySupervisorRegistered("agent-supervisor", async (agentId, text) => {
      sent.push({ agentId, text });
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].agentId, "agent-supervisor");
    assert.equal(sent[0].text, supervisorCliNote());
    assert.match(result.message, /bin\/kanban/);
    assert.match(result.message, new RegExp("<leader>" + localePattern(zhCNPart("tools.ownCardsOnly", 2, 4)) + localePattern(zhCNPart("routing.effortSource.profile", 2, 4)) + localePattern(zhCNPart("server.tierSet", 17, 19))));
    assert.equal(result.message.includes(token), false);
    assert.equal(JSON.stringify(result).includes(token), false);

    const task = createTask({ project: "sandbox", title: "Ordinary task", role: "executor" });
    addComment(task.id, UI_ACTOR, result.message);
    appendEvent(task.id, "supervisor_registered", null, null, UI_ACTOR, { delivered: result.delivered, agentId: result.agentId });
    const comments = getDb().prepare("SELECT body FROM comments").all() as Array<{ body: string }>;
    const events = getDb().prepare("SELECT data_json FROM events").all() as Array<{ data_json: string }>;
    assert.ok(comments.length > 0);
    assert.ok(events.length > 0);
    for (const row of comments) assert.equal(row.body.includes(token), false);
    for (const row of events) assert.equal(row.data_json.includes(token), false);
  });

  it("lists hand-opened agents in the main workspace and prompts when the supervisor is gone", () => {
    const agents = join(dir, "agents");
    process.env.KANBAN_AGENTS_DIR = agents;
    process.env.KANBAN_PROJECT_ROOT = dir;
    const listed: ListedWorkspace[] = [
      { id: "wks-main", name: "main", directory: dir, projectRoot: dir, projectId: null, kind: "local_checkout", archived: false, pinned: false },
      { id: "wks-other", name: (zhCNPart("workspaceRecreate.claimLost", 5, 7) + zhCNPart("nativeSessions.restore.done", 0, 2)), directory: dir, projectRoot: dir, projectId: null, kind: "local_checkout", archived: false, pinned: false },
      { id: "wks-tree", name: "branch", directory: join(dir, "wt"), projectRoot: dir, projectId: null, kind: "worktree", archived: false, pinned: false },
    ];
    function writeAgent(id: string, extra: Record<string, unknown>) {
      const folder = join(agents, id.slice(0, 2));
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, `${id}.json`),
        JSON.stringify({
          id,
          cwd: dir,
          workspaceId: "wks-main",
          labels: {},
          title: id,
          provider: "cursor",
          createdAt: "2026-09-27T00:00:00.000Z",
          lastStatus: "idle",
          ...extra,
        }),
      );
    }
    writeAgent("boss-open", { title: "【\u603b\u7ba1】A", createdAt: "2026-09-27T02:00:00.000Z" });
    writeAgent("plain-closed", { title: "Closed session", lastStatus: "closed", createdAt: "2026-09-27T01:00:00.000Z" });
    writeAgent("worker-kanban", { title: "Kanban worker", labels: { kanban: "1", role: "executor" } });
    writeAgent("other-room", { title: "Another workspace", workspaceId: "wks-other" });
    writeAgent("gone-archived", { title: "Archived <leader>", archivedAt: "2026-09-27T03:00:00.000Z" });

    const choices = listAgentChoices(listed);
    assert.deepEqual(choices.agents.map((item) => item.id), ["boss-open", "plain-closed"]);
    assert.equal(choices.suggestedId, "boss-open");
    assert.equal(choices.agents.find((item) => item.id === "plain-closed")?.closed, true);
    assert.equal(choices.agents.some((item) => item.id === "worker-kanban"), false);

    const alive = supervisorView("boss-open", agentFile("boss-open", { title: "【\u603b\u7ba1】A" }));
    assert.equal(alive.headline, zhCN("supervisor.view.headline", {"title":"【\u603b\u7ba1】A"}));
    assert.equal(alive.prompt, null);
    const closed = supervisorView("plain-closed", agentFile("plain-closed", { title: "Closed session", lastStatus: "closed" }));
    assert.equal(closed.headline, zhCN("supervisor.view.headline", {"title":"Closed session"}));
    assert.match(closed.prompt ?? "", new RegExp(zhCN("settingsPanel.agent.closed")));
    assert.match(closed.prompt ?? "", new RegExp(localePattern(zhCNPart("supervisor.register.archived", 14, 18))));
    const archived = supervisorView("gone-archived", agentFile("gone-archived", { title: "Archived <leader>", archivedAt: "2026-09-27T03:00:00.000Z" }));
    assert.equal(archived.headline, zhCN("supervisor.view.headline", {"title":"Archived <leader>"}));
    assert.match(archived.prompt ?? "", new RegExp(zhCN("missingCwd.report.isArchived")));
    assert.match(archived.prompt ?? "", new RegExp(localePattern(zhCNPart("supervisor.register.archived", 14, 18))));
    assert.equal(supervisorView(null, null).headline, zhCN("supervisor.view.unregistered"));
    assert.match(supervisorRegisterBlock("closed") ?? "", new RegExp(localePattern(zhCNPart("supervisor.register.archived", 14, 18))));
    assert.match(supervisorRegisterBlock("archived") ?? "", new RegExp(localePattern(zhCNPart("supervisor.register.archived", 14, 18))));
    assert.equal(supervisorRegisterBlock("alive"), null);

    createTask({ project: "sandbox", title: "No workspace", role: "executor", workspacePath: dir });
    const found = directoryForProject("sandbox", listed);
    assert.equal(found, dir);
    assert.deepEqual(listAgentChoices(listed, found ?? undefined).agents.map((item) => item.id), ["boss-open", "plain-closed"]);
  });
});

describe("leader session titles", () => {
  it("accepts the old titles and the new <leader> titles", () => {
    assert.equal(isLeaderSessionTitle("【\u603b\u7ba1】A"), true);
    assert.equal(isLeaderSessionTitle("【\u603b\u7ba1】Kanban"), true);
    assert.equal(isLeaderSessionTitle("  【\u603b\u7ba1】EX  "), true);
    assert.equal(isLeaderSessionTitle("\u603b\u7ba1Kanban"), true);
    assert.equal(isLeaderSessionTitle("<leader> · A"), true);
    assert.equal(isLeaderSessionTitle("<leader> · Kanban"), true);
    assert.equal(isLeaderSessionTitle("<leader> · demo_board"), true);
    assert.equal(isLeaderSessionTitle("Closed session"), false);
    assert.equal(isLeaderSessionTitle("<leader>"), false);
    assert.equal(isLeaderSessionTitle("<leader>"), false);
    assert.equal(isLeaderSessionTitle("<leader>·Kanban"), false);
  });

  it("suggests an agent whose title is the new leader form", () => {
    const agents = join(dir, "agents");
    process.env.KANBAN_AGENTS_DIR = agents;
    process.env.KANBAN_PROJECT_ROOT = dir;
    const listed: ListedWorkspace[] = [
      { id: "wks-main", name: "main", directory: dir, projectRoot: dir, projectId: null, kind: "local_checkout", archived: false, pinned: false },
    ];
    const folder = join(agents, "le");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "leader-new.json"),
      JSON.stringify({
        id: "leader-new",
        cwd: dir,
        workspaceId: "wks-main",
        labels: {},
        title: "<leader> · A",
        provider: "cursor",
        createdAt: "2026-09-29T00:00:00.000Z",
        lastStatus: "idle",
      }),
    );
    const choices = listAgentChoices(listed, dir);
    assert.equal(choices.suggestedId, "leader-new");
  });
});

function agentFile(id: string, extra: Partial<AgentFile>): AgentFile {
  return {
    id,
    cwd: dir,
    workspaceId: "wks-main",
    labels: {},
    featureValues: null,
    createdAt: null,
    archivedAt: null,
    lastStatus: "idle",
    updatedAt: null,
    lastActivityAt: null,
    lastUserMessageAt: null,
    attentionReason: null,
    attentionTimestamp: null,
    lastError: null,
    title: id,
    provider: "cursor",
    model: null,
    ...extra,
  };
}
