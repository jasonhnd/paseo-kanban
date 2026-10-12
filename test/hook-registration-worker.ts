/// <reference types="node" />
import { zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, mock } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";

// Keep the registered lifecycle callbacks, store, flow and permission decisions real.
mock.module(new URL("../server/mcp.ts", import.meta.url).href, {
  namedExports: { startMcpServer: async () => ({ url: "http://fixture", port: 0, replaced: false, close: async () => {} }) },
});
// Retain the real loop for the timer regression below; disable its kick in contribute only.
const loop = await import("../server/loop");
let schedulerReady: (() => import("../server/loop").SchedulerDeps | null) | undefined;
mock.module(new URL("../server/loop.ts", import.meta.url).href, {
  namedExports: { ...loop, bindScheduler: (options: { ready: typeof schedulerReady }) => {
    schedulerReady = options.ready;
    return { reused: false, kick: async () => {}, release() {} };
  } },
});
mock.module(new URL("../server/early-bind.ts", import.meta.url).href, {
  namedExports: { startEarlyBind: () => ({ stop() {} }) },
});
const missing = await import("../server/missing-cwd");
mock.module(new URL("../server/missing-cwd.ts", import.meta.url).href, {
  namedExports: { ...missing, startMissingCwdPatrol: () => () => {} },
});
const { default: contribute } = await import("../index.server");
const { closeDb, getDb } = await import("../server/db");
const { registerTask } = await import("../server/register");
const { leaderReworkTask } = await import("../server/flow");
const { hookObjects } = await import("../server/hook-objects");
const { getTask } = await import("../server/store");
const { loadConfig, saveConfig } = await import("../server/config");

const registration = (agentId: string) => ({ project: "hooks", title: "Existing agent", brief: "fixture", role: "executor", profileName: "fixture", provider: "codex", model: "fixture", agentId, startedAt: "2026-09-26T00:00:00Z" });

async function withPlugin(run: (handlers: Map<string, (event: unknown, context: { paseo: PaseoApi }) => unknown>, paseo: PaseoApi, replies: unknown[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "TEST_0094-register-"));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  mkdirSync(process.env.KANBAN_AGENTS_DIR);
  saveConfig({ ...loadConfig(), supervisorAgentId: null, supervisors: {} });
  const handlers = new Map<string, (event: unknown, context: { paseo: PaseoApi }) => unknown>();
  const server = { before: () => () => {}, handle: () => {}, on: (name: string, fn: (event: unknown, context: { paseo: PaseoApi }) => unknown) => { handlers.set(name, fn); return () => {}; } } as unknown as PluginServerContext;
  const replies: unknown[] = [];
  const paseo = { agents: {
    ref: (id: string) => ({ respondToPermission: async (reply: unknown) => { replies.push({ id, reply }); }, send: async () => {}, archive: async () => {} }),
    subscribe: () => () => {},
    list: async () => ({ entries: [], subscription: { release: async () => {} } }),
  } } as unknown as PaseoApi;
  const unload = contribute(server);
  try { await run(handlers, paseo, replies); }
  finally { await unload(); loop.resetSchedulerForTests(); closeDb(); rmSync(dir, { recursive: true, force: true }); }
}

async function permission(handlers: Map<string, (event: unknown, context: { paseo: PaseoApi }) => unknown>, paseo: PaseoApi, id: string) {
  await handlers.get("agent.permission_requested")!({ agent: { id }, request: { id: "read-permission", name: "Read" } }, { paseo });
}
async function failedTurn(handlers: Map<string, (event: unknown, context: { paseo: PaseoApi }) => unknown>, paseo: PaseoApi, id: string) {
  await handlers.get("agent.turn_ended")!({ agent: { id }, outcome: { kind: "failed", error: { message: "quota exceeded" } }, timeline: [] }, { paseo });
}

it("scheduler readiness initializes the client recovered by an unrelated event when early bind is unavailable", async (t) => {
  await withPlugin(async (handlers, paseo) => {
    const subscribe = t.mock.method(paseo.agents, "subscribe");
    assert.ok(schedulerReady);
    assert.equal(schedulerReady(), null);
    await handlers.get("agent.created")!({ agent: { id: "unrelated-schedule" } }, { paseo });
    assert.equal(hookObjects.agent({ id: "unrelated-schedule" }), false);
    assert.equal(subscribe.mock.callCount(), 0);
    const deps = schedulerReady(); // The same ready callback used by the periodic loop.
    assert.ok(deps?.launcher);
    assert.equal(subscribe.mock.callCount(), 1);
    assert.ok(schedulerReady()?.launcher);
    assert.equal(subscribe.mock.callCount(), 1);
  });
});

it("register after plugin startup immediately enters permission, failure and archived handling", async () => {
  await withPlugin(async (handlers, paseo, replies) => {
    const id = "registered-after-startup";
    assert.equal(hookObjects.agent({ id }), false);
    const task = registerTask(registration(id));
    await permission(handlers, paseo, id);
    assert.deepEqual(replies, [{ id, reply: { requestId: "read-permission", response: { behavior: "allow" } } }]);
    await failedTurn(handlers, paseo, id);
    assert.equal(getTask(task.id).blocked_kind, "quota");
    assert.equal(getTask(task.id).status, "ready");
    const archived = registerTask(registration("registered-for-archive"));
    await handlers.get("agent.archived")!({ agent: { id: archived.agent_id } }, { paseo });
    assert.equal(getTask(archived.id).status, "running");
    assert.equal(getTask(archived.id).agent_id, archived.agent_id);
    // An idempotent registration may not adopt a different, unrelated input agent.
    const first = registerTask({ ...registration("idempotent-bound"), idempotencyKey: "same" });
    const again = registerTask({ ...registration("idempotent-unrelated"), idempotencyKey: "same" });
    assert.equal(again.id, first.id);
    assert.equal(hookObjects.agent({ id: "idempotent-unrelated" }), false);
  });
});

it("rework with an existing unlabelled agent immediately enters lifecycle handling", async () => {
  await withPlugin(async (handlers, paseo, replies) => {
    const task = registerTask(registration("old-executor"));
    getDb().prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(task.id);
    const id = "reassigned-after-startup";
    assert.equal(hookObjects.agent({ id }), false);
    await leaderReworkTask(task.id, zhCNPart("dispatch.reworkReassign", 2, 4), { agentId: id, presence: () => "idle" });
    // Model the scheduler's resumed run; rework binding itself must have registered the ID.
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
    getDb().prepare("INSERT INTO runs (task_id, agent_id, role, auto_accept, started_at) VALUES (?, ?, 'executor', 1, ?)").run(task.id, id, "2026-09-26T00:00:00Z");
    await permission(handlers, paseo, id);
    assert.equal(replies.length, 1);
    await failedTurn(handlers, paseo, id);
    assert.equal(getTask(task.id).blocked_kind, "quota");
  });
});

it("periodic scheduler refresh sees CLI register/rework without restart, even before Paseo is bound", async () => {
  await withPlugin(async (handlers, paseo, replies) => {
    const childSource = `
      import { registerTask } from './server/register.ts';
      import { leaderReworkTask } from './server/flow.ts';
      import { getDb } from './server/db.ts';
      const input = ${JSON.stringify(registration("cli-registered-after-startup"))};
      const registered = registerTask(input);
      const rework = registerTask({ ...input, agentId: 'cli-old-executor' });
      getDb().prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(rework.id);
      await leaderReworkTask(rework.id, 'CLI ${zhCNPart("dispatch.reworkReassign", 2, 4)}', { agentId: 'cli-reassigned-after-startup', presence: () => 'idle' });
      console.log(JSON.stringify({ registered: registered.id, rework: rework.id }));
    `;
    const ids = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: process.env, encoding: "utf8" })) as { registered: number; rework: number };
    assert.equal(hookObjects.agent({ id: "cli-registered-after-startup" }), false);
    assert.equal(hookObjects.agent({ id: "cli-reassigned-after-startup" }), false);
    mock.timers.enable({ apis: ["setInterval"] });
    const scheduler = loop.bindScheduler({ ready: () => null });
    try {
      mock.timers.tick(60_000);
      assert.equal(hookObjects.agent({ id: "cli-registered-after-startup" }), true);
      assert.equal(hookObjects.agent({ id: "cli-reassigned-after-startup" }), true);
      await permission(handlers, paseo, "cli-registered-after-startup");
      assert.equal(replies.length, 1);
      await failedTurn(handlers, paseo, "cli-registered-after-startup");
      assert.equal(getTask(ids.registered).blocked_kind, "quota");
      getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(ids.rework);
      getDb().prepare("INSERT INTO runs (task_id, agent_id, role, auto_accept, started_at) VALUES (?, 'cli-reassigned-after-startup', 'executor', 1, ?)").run(ids.rework, "2026-09-26T00:00:00Z");
      await permission(handlers, paseo, "cli-reassigned-after-startup");
      assert.equal(replies.length, 2);
      await failedTurn(handlers, paseo, "cli-reassigned-after-startup");
      assert.equal(getTask(ids.rework).blocked_kind, "quota");
      // Lifecycle gates remain pure: an unrelated object must not even inspect context.
      await handlers.get("agent.permission_requested")!({ agent: { id: "unrelated-schedule" } }, { get paseo() { return assert.fail("non-kanban context accessed"); } });
      assert.equal(replies.length, 2);
    } finally { scheduler.release(); mock.timers.reset(); }
  });
});
