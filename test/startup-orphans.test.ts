/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { DEFAULT_CONCURRENCY, saveConfig, type KanbanConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { startTask } from "./helpers/compat-dispatch";
import { bindScheduler, resetSchedulerForTests } from "../server/loop";
import { launcherFrom, listActivePaseoAgents, type AgentListItem } from "../server/paseo";
import type { PoolSnapshot } from "../server/pools";
import type { Profile } from "../server/profiles";
import { createStartupReconciler } from "../server/startup-orphans";
import { appendEvent, createTask, getTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "test-0079-orphans-"));
process.env.KANBAN_DATA_DIR = dir;
const profiles: Profile[] = [
  { id: "ex", name: zhCN("labels.role.executor"), role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
  { id: "rv", name: zhCN("labels.role.reviewer"), role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];
const pools: PoolSnapshot = {
  state: "fresh", message: (zhCNPart("compat.name.offlineTest", 2, 4) + zhCNPart("profiles.testSnapshot", 5, 7)), generatedAt: new Date().toISOString(),
  dispatchable: () => true,
  entry: () => ({ dispatchable: true, deprioritize: false, prefer: false, resetsAt: null, reason: null, onlyRoles: null }),
};
const config: KanbanConfig = {
  autoStart: { orphans: true }, supervisorAgentId: null, supervisors: {},
  concurrency: { global: DEFAULT_CONCURRENCY.global, pools: { ...DEFAULT_CONCURRENCY.pools }, roles: { ...DEFAULT_CONCURRENCY.roles } },
};
function task(name: string) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  return createTask({ project: "orphans", title: name, role: "executor", workspacePath: root });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const startedAt = new Date("2026-10-01T08:23:00Z");
function agent(id: string, taskId: number, extra: Partial<AgentListItem> = {}): AgentListItem {
  return { id, archived: false, workspaceId: "wks", cwd: dir, createdAt: "2026-10-01T08:22:59Z", labels: { kanban: "1", kanban_task: String(taskId), role: "executor" }, ...extra };
}
function discarded(taskId: number) {
  const rows = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'orphan_agent_discarded'").all(taskId) as unknown as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json));
}
beforeEach(() => {
  resetSchedulerForTests();
  getDb().prepare("UPDATE tasks SET status = 'archived'").run();
});
after(() => { resetSchedulerForTests(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe("startup reconciliation barrier", () => {
  it("waits before dispatching even with overlapping scheduler kicks", async () => {
    const card = task("scheduler-barrier");
    const gate = deferred();
    const calls: string[] = [];
    const launcher = {
      async beforeStart() { calls.push("reconcile"); await gate.promise; calls.push("archived"); },
      async create() { calls.push("create"); return { id: "scheduler-agent" }; },
      async send() {},
    };
    const scheduler = bindScheduler({ ready: () => ({ launcher, profiles, config, pools, agentState: () => "alive" }), intervalMs: 3_600_000 });
    const kicks = Promise.all([scheduler.kick(), scheduler.kick()]);
    await new Promise((resolve) => setImmediate(resolve));
    const before = [...calls];
    const status = getTask(card.id).status;
    gate.resolve();
    await kicks;
    assert.deepEqual(before, ["reconcile"]);
    assert.equal(status, "ready");
    assert.ok(calls.indexOf("archived") < calls.indexOf("create"));
    assert.equal(calls.filter((call) => call === "create").length, 1);
    scheduler.release();
  });

  it("also gates a direct plugin start", async () => {
    const card = task("direct-barrier");
    const gate = deferred();
    let created = false;
    const launcher = {
      beforeStart: () => gate.promise,
      async create() { created = true; return { id: "direct-agent" }; },
      async send() {},
    };
    const pending = startTask(card.id, launcher, "test", { profiles, chosen: profiles[0], reason: "Test" });
    await new Promise((resolve) => setImmediate(resolve));
    const before = created;
    gate.resolve();
    await pending;
    assert.equal(before, false);
    assert.equal(created, true);
  });
});

describe("startup orphan reconciliation", () => {
  it("archives an old unregistered kanban agent from a paginated daemon list before dispatch", async () => {
    const card = task("old-orphan");
    const calls: string[] = [];
    const old = agent("old-agent", card.id);
    const paseo = {
      agents: {
        async list(input: { scope: string; page: { cursor?: string } }) {
          assert.equal(input.scope, "active");
          calls.push(`list:${input.page.cursor ?? "first"}`);
          return input.page.cursor
            ? { entries: [{ agent: { ...old, archivedAt: null } }], pageInfo: { nextCursor: null } }
            : { entries: [{ agent: { id: "personal", archivedAt: null } }], pageInfo: { nextCursor: "second" } };
        },
        ref(id: string) { return { async archive() { calls.push(`archive:${id}`); } }; },
        async create() {
          assert.ok(calls.includes("archive:old-agent"));
          calls.push("create");
          return { id: "replacement-agent" };
        },
      },
    } as unknown as PaseoApi;
    const reconcile = createStartupReconciler({ startedAt, listAgents: () => listActivePaseoAgents(paseo), archiveAgent: (id) => paseo.agents.ref(id).archive().then(() => undefined) });
    const adapter = launcherFrom(paseo, reconcile);
    const launcher = { beforeStart: adapter.beforeStart, create: adapter.create, async send() {} };
    const scheduler = bindScheduler({ ready: () => ({ launcher, profiles, config, pools, agentState: () => "alive" }), intervalMs: 3_600_000 });
    await scheduler.kick();
    await scheduler.kick();
    assert.deepEqual(calls, ["list:first", "list:second", "archive:old-agent", "create"]);
    assert.equal(getTask(card.id).agent_id, "replacement-agent");
    const events = discarded(card.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].agentId, "old-agent");
    assert.equal(events[0].cwd, dir);
    assert.match(events[0].reason, new RegExp(localePattern(zhCNPart("startupOrphans.reason", 13, 20))));
    scheduler.release();
  });

  it("preserves each registration source, unlabelled agents, leaders, and agents newer than the process", async () => {
    const card = task("preserved-agents");
    getDb().prepare("UPDATE tasks SET agent_id = ?, executor_agent_id = ? WHERE id = ?").run("current", "executor", card.id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, started_at, ended_at) VALUES (?, ?, 'executor', ?, ?)").run(card.id, "run", startedAt.toISOString(), startedAt.toISOString());
    appendEvent(card.id, "agent_opened", null, null, "test", { agentId: "opened" });
    saveConfig({ ...config, supervisorAgentId: "fallback-leader", supervisors: { orphans: "project-leader" } });
    const ids = ["current", "executor", "run", "opened", "fallback-leader", "project-leader"];
    const listed = [
      ...ids.map((id) => agent(id, card.id)),
      agent("personal", card.id, { labels: {} }),
      agent("missing-kanban", card.id, { labels: { kanban_task: String(card.id) } }),
      agent("kanban-zero", card.id, { labels: { kanban: "0", kanban_task: String(card.id) } }),
      agent("missing-task", card.id, { labels: { kanban: "1" } }),
      agent("invalid-task", card.id, { labels: { kanban: "1", kanban_task: "invalid" } }),
      agent("unknown-task", 9999999),
      agent("label-leader", card.id, { labels: { kanban: "1", kanban_task: String(card.id), role: "supervisor" } }),
      agent("title-leader", card.id, { title: "<leader> · Kanban" }),
      agent("legacy-leader", card.id, { title: "【\u603b\u7ba1】Kanban" }),
      agent("new", card.id, { createdAt: "2026-10-01T08:23:01Z" }),
      agent("same-time", card.id, { createdAt: startedAt.toISOString() }),
      agent("missing-time", card.id, { createdAt: null }),
      agent("invalid-time", card.id, { createdAt: "invalid" }),
      agent("archived", card.id, { archived: true }),
    ];
    const archived: string[] = [];
    const reconcile = createStartupReconciler({ startedAt, listAgents: async () => listed, archiveAgent: async (id) => { archived.push(id); } });
    await reconcile();
    assert.deepEqual(archived, []);
    assert.deepEqual(discarded(card.id), []);
    saveConfig(config);
  });

  it("shares an in-flight reconciliation and retries list or archive failure without dispatch", async () => {
    const card = task("retry-orphan");
    const gate = deferred();
    let scans = 0;
    let archives = 0;
    let creates = 0;
    const reconcile = createStartupReconciler({
      startedAt,
      async listAgents() {
        scans += 1;
        if (scans === 1) throw new Error("list unavailable");
        await gate.promise;
        return [agent("retry-agent", card.id)];
      },
      async archiveAgent() { archives += 1; if (archives === 1) throw new Error("archive unavailable"); },
    });
    const launcher = { beforeStart: reconcile, async create() { creates += 1; return { id: "retry-replacement" }; }, async send() {} };
    const scheduler = bindScheduler({ ready: () => ({ launcher, profiles, config, pools, agentState: () => "alive" }), intervalMs: 3_600_000 });
    await scheduler.kick();
    assert.equal(creates, 0);
    assert.equal(getTask(card.id).status, "ready");
    const kick = scheduler.kick();
    const first = reconcile();
    const second = reconcile();
    assert.equal(first, second);
    const failed = assert.rejects(first, /archive unavailable/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scans, 2);
    assert.equal(creates, 0);
    gate.resolve();
    await Promise.all([kick, failed]);
    assert.equal(creates, 0);
    assert.deepEqual(discarded(card.id), []);
    await scheduler.kick();
    assert.equal(creates, 1);
    assert.equal(scans, 3);
    assert.equal(archives, 2);
    assert.equal(discarded(card.id).length, 1);
    await reconcile();
    assert.equal(scans, 3);
    scheduler.release();
  });

  it("does not dispatch after a truncated daemon list", async () => {
    const card = task("truncated-list");
    let pages = 0;
    const paseo = {
      agents: {
        async list() { pages += 1; return { entries: [], pageInfo: { nextCursor: `page-${pages}` } }; },
      },
    } as unknown as PaseoApi;
    let archived = false;
    const reconcile = createStartupReconciler({ startedAt, listAgents: () => listActivePaseoAgents(paseo), async archiveAgent() { archived = true; } });
    await assert.rejects(reconcile, new RegExp(localePattern(zhCNPart("paseo.shape.tooManyPages", 16, 24))));
    assert.equal(pages, 50);
    assert.equal(archived, false);
    assert.equal(getTask(card.id).status, "ready");
  });
});
