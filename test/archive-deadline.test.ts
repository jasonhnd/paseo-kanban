/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { cardMark } from "../server/card-ref";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { overdueAgentIds } from "../server/archive-book";
import { isLaneWorkspace } from "../server/lane-mark";
import { formatAudit, performAudit, type AuditView } from "../server/audit";
import { setWakeSender } from "../server/bus";
import { DEFAULT_ARCHIVE_DEADLINE_MS, DEFAULT_CONCURRENCY, loadConfig, saveConfig } from "../server/config";
import { enqueueCleanups, flushCleanups, installCleanup, noteOverdueArchives, type CleanupOps } from "../server/cleanup";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { acceptTask, completeTask } from "../server/flow";
import type { ListedWorkspace } from "../server/placement";
import type { Profile } from "../server/profiles";
import { appendEvent, createTask, getTask, listBoard } from "../server/store";
import { resetAgentAliveCheck, resetBoardWakeForTests, setAgentAliveCheck } from "../server/wake";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "deadline-"));
process.env.KANBAN_DATA_DIR = dir;
mkdirSync(dir, { recursive: true });

const executor: Profile = { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" };

function mainWorkspace(id: string): ListedWorkspace {
  return {
    id,
    name: "main",
    directory: dir,
    projectRoot: dir,
    projectId: "parent",
    kind: "local_checkout",
    archived: false,
  };
}

after(() => {
  installCleanup(null);
  resetAgentAliveCheck();
  resetBoardWakeForTests();
  setWakeSender(() => {});
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("archive deadline", () => {
  it("lists, shows, and wakes once when agents are still open 5 minutes after done", async () => {
    const ops: CleanupOps = {
      async archiveAgent() {
        throw new Error("Keep active");
      },
      async archiveWorkspace() {},
      async listAgents() {
        return [];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    installCleanup(ops);
    const task = createTask({ project: "late", title: "timed out", role: "executor", workspacePath: dir });
    await startTask(task.id, { async create() { return { id: "deadline-agent-1" }; }, async send() {} }, "test", { profiles: [executor], chosen: executor, reason: "Test" });
    completeTask(task.id, "executor", "Handoff", null);
    getDb().prepare("UPDATE tasks SET status = 'acceptance' WHERE id = ?").run(task.id);
    await acceptTask(task.id, "supervisor");
    enqueueCleanups();
    await flushCleanups();
    assert.equal(getTask(task.id).status, "done");

    const fresh: AuditView = {
      async listActiveAgents() {
        return [{ id: "deadline-agent-1", archived: false, workspaceId: null }];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const early = formatAudit(await performAudit(fresh));
    assert.match(early, new RegExp(zhCN("audit.unarchived", {"id":"deadline-agent-1"})));
    assert.equal(early.includes(zhCNPart("audit.overdue", 0, 5)), false);

    const doneAt = new Date(Date.now() - DEFAULT_ARCHIVE_DEADLINE_MS - 1000).toISOString();
    getDb().prepare("UPDATE events SET at = ? WHERE task_id = ? AND to_status = 'done'").run(doneAt, task.id);
    assert.deepEqual(overdueAgentIds(task.id), ["deadline-agent-1"]);

    const sent: Array<{ id: string; text: string }> = [];
    saveConfig({
      autoStart: {},
      supervisorAgentId: "kanban-boss",
      supervisors: {},
      concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
      archiveDeadlineMs: DEFAULT_ARCHIVE_DEADLINE_MS,
    });
    setAgentAliveCheck((id) => id === "kanban-boss");
    setWakeSender((id, text) => sent.push({ id, text }));
    resetBoardWakeForTests();
    enqueueCleanups();
    noteOverdueArchives();
    assert.equal(sent.filter((item) => item.text.includes(zhCN("archiveBook.label.overdue", {"agent":"deadline"}))).length, 1);
    enqueueCleanups();
    assert.equal(sent.filter((item) => item.text.includes(zhCN("archiveBook.label.overdue", {"agent":"deadline"}))).length, 1);
    assert.equal(listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote, zhCN("archiveBook.label.overdue", {"agent":"deadline"}));
    const late = formatAudit(await performAudit(fresh));
    assert.match(late, new RegExp(zhCN("archiveBook.label.overdue", {"agent":"deadline-agent-1"})));
    assert.equal(late.includes(zhCN("audit.unarchived", {"id":"deadline-agent-1"})), false);

    saveConfig({ ...loadConfig(), archiveDeadlineMs: 60 * 60_000 });
    assert.deepEqual(overdueAgentIds(task.id), []);
    assert.equal((listBoard().tasks.find((card) => card.id === task.id)?.cleanupNote ?? "").includes(zhCNPart("audit.overdue", 0, 5)), false);
    const widened = formatAudit(await performAudit(fresh));
    assert.match(widened, new RegExp(zhCN("audit.unarchived", {"id":"deadline-agent-1"})));
    assert.equal(widened.includes(zhCNPart("audit.overdue", 0, 5)), false);
  });

  it("lists a kanban workspace no unfinished card uses, and skips main and live cards", async () => {
    const done = createTask({ project: "rooms", title: "demo fixture", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'done', workspace_kind = 'worktree', paseo_workspace_id = 'wt-orphan' WHERE id = ?").run(done.id);
    const live = createTask({ project: "rooms", title: "Still in use", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', workspace_kind = 'worktree', paseo_workspace_id = 'wt-live' WHERE id = ?").run(live.id);
    const main = createTask({ project: "rooms", title: "Sample text", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'archived', paseo_workspace_id = 'main-ws' WHERE id = ?").run(main.id);
    const view: AuditView = {
      async listActiveAgents() {
        return [];
      },
      async inspectWorkspace(workspaceId) {
        if (workspaceId === "main-ws") return mainWorkspace("main-ws");
        if (workspaceId === "wt-live") {
          return { id: "wt-live", name: "live", directory: join(dir, "live"), projectRoot: dir, projectId: "parent", kind: "worktree", archived: false };
        }
        return { id: workspaceId, name: "orphan", directory: join(dir, "orphan"), projectRoot: dir, projectId: "parent", kind: "worktree", archived: false };
      },
    };
    const report = await performAudit(view);
    assert.deepEqual(report.unusedWorkspaces, ["wt-orphan"]);
    const text = formatAudit(report);
    assert.match(text, new RegExp(zhCN("audit.unusedWorkspace", {"id":"wt-orphan"})));
    assert.equal(text.includes("wt-live"), false);
    assert.equal(text.includes("main-ws"), false);
  });

  it("leaves a permanent lane workspace out of audit, the board note, and the wake", async () => {
    const laneId = "wks_000000000000";
    const laneDir = join(dir, "lanes", "kanban-lane-1");
    const byEvent = createTask({ project: "lanes", title: "Lane identified by event", role: "executor", workspacePath: join(dir, "not-a-lane-name") });
    getDb()
      .prepare("UPDATE tasks SET status = 'done', workspace_kind = 'lane', workspace_path = ?, paseo_workspace_id = ? WHERE id = ?")
      .run(join(dir, "not-a-lane-name"), laneId, byEvent.id);
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, from_status, to_status, actor, data_json) VALUES (?, ?, 'moved', 'acceptance', 'done', 'test', '{}')")
      .run(byEvent.id, new Date(Date.now() - DEFAULT_ARCHIVE_DEADLINE_MS - 1000).toISOString());
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'lane_bound', 'scheduler', ?)")
      .run(
        byEvent.id,
        new Date().toISOString(),
        JSON.stringify({
          lane: "kanban-lane-1",
          directory: laneDir,
          workspaceId: laneId,
          branch: "kanban/1-lane",
          base: "main",
          root: dir,
        }),
      );
    getDb()
      .prepare(
        ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n         VALUES (?, 'lane-agent-1', 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
      )
      .run(byEvent.id, new Date().toISOString());
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'cleanup', 'kanban', ?)")
      .run(byEvent.id, new Date().toISOString(), JSON.stringify({ action: "archive_agent", agentId: "lane-agent-1", ok: true }));
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'cleanup', 'kanban', ?)")
      .run(byEvent.id, new Date().toISOString(), JSON.stringify({ action: "archive_workspace", workspaceId: laneId, ok: false, outcome: "error", error: "Keep lane active" }));

    const byDirId = "wks_lane_directory";
    const byDir = createTask({ project: "lanes", title: "Lane identified by directory", role: "executor", workspacePath: join(dir, "repo", "kanban-lane-2") });
    getDb()
      .prepare("UPDATE tasks SET status = 'done', workspace_kind = 'worktree', workspace_path = ?, paseo_workspace_id = ? WHERE id = ?")
      .run(join(dir, "repo", "kanban-lane-2"), byDirId, byDir.id);

    const rememberedDir = join(dir, "remembered-lane");
    const byRememberedId = "wks_lane_remembered_dir";
    const byRemembered = createTask({ project: "lanes", title: "Event directory", role: "executor", workspacePath: rememberedDir });
    getDb()
      .prepare("UPDATE tasks SET status = 'done', workspace_kind = 'worktree', workspace_path = ?, paseo_workspace_id = ? WHERE id = ?")
      .run(rememberedDir, byRememberedId, byRemembered.id);
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, actor, data_json) VALUES (?, ?, 'lane_bound', 'scheduler', ?)")
      .run(
        byRemembered.id,
        new Date().toISOString(),
        JSON.stringify({
          lane: "kanban-lane-3",
          directory: rememberedDir,
          workspaceId: "some-other-id",
          branch: "kanban/3-lane",
          base: "main",
          root: dir,
        }),
      );

    assert.equal(isLaneWorkspace(laneId), true);
    assert.equal(isLaneWorkspace(byDirId, join(dir, "repo", "kanban-lane-2")), true);
    assert.equal(isLaneWorkspace(byRememberedId, rememberedDir), true);
    assert.deepEqual(overdueAgentIds(byEvent.id), []);

    const orphan = createTask({ project: "lanes", title: "Truly unused", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'done', workspace_kind = 'worktree', paseo_workspace_id = 'wt-still-orphan' WHERE id = ?").run(orphan.id);

    const view: AuditView = {
      async listActiveAgents() {
        return [];
      },
      async inspectWorkspace(workspaceId) {
        if (workspaceId === laneId) {
          return { id: laneId, name: "kanban/1-lane", directory: join(dir, "not-a-lane-name"), projectRoot: dir, projectId: "parent", kind: "worktree", archived: false };
        }
        if (workspaceId === byDirId) {
          return {
            id: byDirId,
            name: "current-branch",
            directory: join(dir, "repo", "kanban-lane-2"),
            projectRoot: dir,
            projectId: "parent",
            kind: "worktree",
            archived: false,
          };
        }
        if (workspaceId === byRememberedId) {
          return {
            id: byRememberedId,
            name: "checked-out",
            directory: rememberedDir,
            projectRoot: dir,
            projectId: "parent",
            kind: "worktree",
            archived: false,
          };
        }
        return { id: workspaceId, name: "orphan", directory: join(dir, "orphan"), projectRoot: dir, projectId: "parent", kind: "worktree", archived: false };
      },
    };
    const report = await performAudit(view);
    assert.equal(report.unusedWorkspaces.includes("wt-still-orphan"), true);
    assert.equal(report.unusedWorkspaces.includes(laneId), false);
    assert.equal(report.unusedWorkspaces.includes(byDirId), false);
    assert.equal(report.unusedWorkspaces.includes(byRememberedId), false);
    const text = formatAudit(report);
    assert.equal(text.includes(laneId), false);
    assert.equal(text.includes(byDirId), false);
    assert.equal(text.includes(byRememberedId), false);
    assert.equal(text.includes("Keep lane active"), false);
    assert.equal(text.includes(zhCN("archiveBook.label.overdue", {"agent":"lane-agent"})), false);
    assert.equal(listBoard().tasks.find((card) => card.id === byEvent.id)?.cleanupNote ?? null, null);
    assert.equal((listBoard().tasks.find((card) => card.id === byDir.id)?.cleanupNote ?? "").includes(byDirId), false);

    const sent: string[] = [];
    setAgentAliveCheck(() => true);
    setWakeSender((_id, body) => sent.push(body));
    resetBoardWakeForTests();
    noteOverdueArchives();
    assert.equal(sent.some((body) => body.includes(laneId) || body.includes(byDirId) || body.includes(byRememberedId)), false);
    assert.equal(sent.some((body) => body.includes(`${cardMark(byEvent.id)}`) && body.includes(zhCNPart("audit.overdue", 0, 5))), false);
  });

  it("does not list, note, or wake a temporary card after its agents were purged or cleanup finished", async () => {
    saveConfig({
      autoStart: {},
      supervisorAgentId: "kanban-boss",
      supervisors: {},
      concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
      archiveDeadlineMs: DEFAULT_ARCHIVE_DEADLINE_MS,
    });
    const ago = new Date(Date.now() - 10 * 60_000).toISOString();
    function doneCard(title: string, agentId: string): number {
      const task = createTask({ project: "late", title, role: "executor", workspacePath: dir });
      getDb().prepare("UPDATE tasks SET status = 'done', agent_id = ?, executor_agent_id = ? WHERE id = ?").run(agentId, agentId, task.id);
      getDb()
        .prepare(
          ("INSERT INTO runs (task_id, agent_id, role, profile_name, provider, model, family, auto_accept, started_at)\n           VALUES (?, ?, 'executor', '" + zhCN("labels.role.executor") + "', 'cursor', 'grok-4.7', 'xai', 0, ?)"),
        )
        .run(task.id, agentId, ago);
      appendEvent(task.id, "accept", "acceptance", "done", "test", {}, ago);
      return task.id;
    }
    const purgedId = "purged-agent-1111";
    const purged = doneCard((zhCNPart("missingCwd.purge.notesWritten", 8, 10) + zhCNPart("cleanup.error.unreadable", 2, 9)), purgedId);
    appendEvent(purged, "cleanup", null, null, "kanban", { action: "purge_agents", agentId: purgedId, ok: true }, ago);

    const closedId = "closed-agent-2222";
    const closed = doneCard((zhCNPart("tempWorkspace.settle.unowned", 14, 16) + "Demo text"), closedId);
    appendEvent(closed, "temp_workspace", null, null, "test", { name: "temp" }, ago);
    appendEvent(closed, "temp_workspace_cleaned", null, null, "kanban", { directory: dir }, ago);
    appendEvent(closed, "cleanup_finished", null, null, "kanban", {}, ago);

    assert.deepEqual(overdueAgentIds(purged), []);
    assert.deepEqual(overdueAgentIds(closed), []);
    assert.equal(listBoard().tasks.find((card) => card.id === purged)?.cleanupNote ?? null, null);
    assert.equal(listBoard().tasks.find((card) => card.id === closed)?.cleanupNote ?? null, null);

    const view: AuditView = {
      async listActiveAgents() {
        return [
          { id: purgedId, archived: false, workspaceId: null },
          { id: closedId, archived: false, workspaceId: null },
        ];
      },
      async inspectWorkspace() {
        return null;
      },
    };
    const text = formatAudit(await performAudit(view));
    assert.equal(text.includes(purgedId), false);
    assert.equal(text.includes(closedId), false);
    assert.equal(text.includes((zhCNPart("missingCwd.purge.notesWritten", 8, 10) + zhCNPart("cleanup.error.unreadable", 2, 9))), false);
    assert.equal(text.includes((zhCNPart("tempWorkspace.settle.unowned", 14, 16) + "Demo text")), false);

    const sent: string[] = [];
    setAgentAliveCheck((id) => id === "kanban-boss");
    setWakeSender((_id, body) => sent.push(body));
    resetBoardWakeForTests();
    noteOverdueArchives();
    noteOverdueArchives();
    assert.equal(sent.some((body) => body.includes(purgedId) || body.includes(closedId) || body.includes(cardMark(purged)) || body.includes(cardMark(closed))), false);
  });
});
