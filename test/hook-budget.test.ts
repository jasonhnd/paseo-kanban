/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import { BOARD_AGENT_ENV } from "../server/agent-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { fastestUnder } from "./helpers/timing";
import { boundedCreateHook, CREATE_HOOK_BUDGET_MS, type CreateHookRequest } from "../server/inject";
import { HookObjects, hookObjects, watchHookObjects } from "../server/hook-objects";
import { launcherFrom } from "../server/paseo";
import type { PaseoApi, PaseoAgentUpdate } from "@getpaseo/client";

function request(): CreateHookRequest {
  return { config: { provider: "codex", cwd: "/tmp/TEST_0094", systemPrompt: "existing" }, env: { [BOARD_AGENT_ENV]: "1", KANBAN_TOKEN: "worker-token", KANBAN_ROLE: "executor" } };
}
const base = { baseUrl: "http://127.0.0.1:9", supervisorToken: "supervisor-fixture" };

describe("bounded create hook", () => {
  it("uses no filesystem for mandatory injection or the ordinary protocol", async () => {
    const original = fs.readFileSync;
    fs.readFileSync = (() => assert.fail("hook read a file")) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const next = await boundedCreateHook(request(), base);
      assert.equal(next?.env?.KANBAN_TOKEN, "worker-token");
      assert.match(next?.config.systemPrompt ?? "", new RegExp(localePattern(zhCNPart("permissions.deny.conflict", 11, 14)) + localePattern(zhCNPart("dispatch.prompt.readOnly", 3, 6))));
      assert.match(next?.config.systemPrompt ?? "", /^existing/);
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }
  });

  it("times out a stuck dependency within its local budget, retaining mandatory env and MCP", async (t) => {
    // The budget is a timer value, so drive it with a fake clock: real elapsed time on a loaded machine proves nothing.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const logs: string[] = [];
    let signal: AbortSignal | undefined;
    let late: ((value: CreateHookRequest) => void) | undefined;
    let optionalRequest: CreateHookRequest | undefined;
    let settled = false;
    const pending = Promise.resolve(boundedCreateHook(request(), {
      ...base, log: (message) => logs.push(message),
      optional: (value, abort) => { optionalRequest = value; signal = abort; return new Promise((resolve) => { late = resolve; }); },
    }));
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve)); // let the optional work start and the timer register
    t.mock.timers.tick(CREATE_HOOK_BUDGET_MS - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "must wait for the whole budget");
    t.mock.timers.tick(1);
    const next = await pending;
    assert.equal(next?.env?.KANBAN_TOKEN, "worker-token");
    assert.equal(next?.env?.[BOARD_AGENT_ENV], "1");
    assert.equal(next?.config.systemPrompt, "existing");
    const mcp = next?.config.mcpServers?.kanban;
    assert.ok(mcp?.type === "http");
    assert.equal(mcp.url.includes("token"), false);
    assert.equal(mcp.headers?.Authorization, "Bearer worker-token");
    assert.equal(signal?.aborted, true);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /timed out.*mandatory injection retained/);
    // A dependency that ignores abort can finish late, but cannot overwrite or mutate fallback.
    assert.ok(optionalRequest && late);
    optionalRequest.env!.KANBAN_TOKEN = "late";
    late(optionalRequest);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(next?.env?.KANBAN_TOKEN, "worker-token");
    assert.equal(logs.length, 1);
  });

  it("keeps mandatory injection on an optional rejection and survives a broken logger", async () => {
    const next = await boundedCreateHook(request(), { ...base, optional: async () => { throw new Error("dependency failed"); }, log: () => { throw new Error("logger failed"); } });
    assert.equal(next?.env?.KANBAN_TOKEN, "worker-token");
    assert.ok(next?.config.mcpServers?.kanban);
  });

  it("scrubs the supervisor snapshot even on timeout or before the MCP endpoint is ready", async () => {
    const input = request();
    input.env!.OTHER = base.supervisorToken;
    input.env!.KANBAN_TOKEN = base.supervisorToken;
    input.config.mcpServers = { other: { type: "http", url: `http://localhost/?${"token"}=${base.supervisorToken}`, headers: { Authorization: `Bearer ${base.supervisorToken}` } } };
    for (const baseUrl of [base.baseUrl, ""]) {
      const next = await boundedCreateHook(input, { ...base, baseUrl, budgetMs: 5, optional: () => new Promise(() => {}) });
      assert.equal(JSON.stringify(next).includes(base.supervisorToken), false);
      assert.equal(next?.env?.KANBAN_TOKEN, undefined);
    }
    assert.equal(input.env!.KANBAN_TOKEN, base.supervisorToken);
  });

  it("does not touch options or schedule optional work for unrelated requests", async () => {
    const input = { config: { provider: "codex", cwd: "/tmp/TEST_0094" } } as CreateHookRequest;
    const options = new Proxy(base, { get() { assert.fail("options accessed"); } });
    const { best, runs } = await fastestUnder(5, () => {
      const begin = performance.now();
      assert.equal(boundedCreateHook(input, options), undefined);
      return performance.now() - begin;
    });
    assert.ok(best < 5, `fastest of ${runs.length} runs ${best.toFixed(3)}ms`);
  });

  it("retains only mandatory injection for a pre-canceled SDK hook without starting optional work", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const next = await boundedCreateHook(request(), {
      ...base, signal: cancel.signal,
      optional: () => assert.fail("optional work started after cancellation"),
    });
    assert.equal(next?.config.systemPrompt, "existing");
    assert.ok(next?.config.mcpServers?.kanban);
    assert.equal(next?.env?.KANBAN_TOKEN, "worker-token");
  });

  it("skips queued optional work when the SDK cancels before its microtask", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const cancel = new AbortController();
    const pending = boundedCreateHook(request(), {
      ...base, signal: cancel.signal,
      optional: () => assert.fail("queued work started after cancellation"),
      log: () => assert.fail("cancellation left a live timer"),
    });
    cancel.abort();
    const next = await pending; // No timer advancement: abort resolves immediately.
    assert.equal(next?.config.systemPrompt, "existing");
    assert.ok(next?.config.mcpServers?.kanban);
    t.mock.timers.tick(CREATE_HOOK_BUDGET_MS);
  });

  it("cancels in-flight optional work immediately and ignores its late mutation or rejection", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const rejects of [false, true]) {
      const cancel = new AbortController();
      const remove = t.mock.method(cancel.signal, "removeEventListener");
      let optionalRequest!: CreateHookRequest;
      let signal!: AbortSignal;
      let resolve!: (value: CreateHookRequest) => void;
      let reject!: (error: Error) => void;
      const pending = boundedCreateHook(request(), {
        ...base, signal: cancel.signal,
        optional: (value, abort) => {
          optionalRequest = value; signal = abort;
          return new Promise<CreateHookRequest>((yes, no) => { resolve = yes; reject = no; });
        },
        log: () => assert.fail("late completion or canceled timer logged"),
      });
      await Promise.resolve(); // Start the optional dependency, then cancel while it is stuck.
      cancel.abort();
      const next = await pending;
      assert.equal(signal.aborted, true);
      assert.equal(remove.mock.callCount(), 1);
      assert.equal(next?.config.systemPrompt, "existing");
      assert.equal(next?.env?.KANBAN_TOKEN, "worker-token");
      assert.ok(next?.config.mcpServers?.kanban);
      optionalRequest.env!.KANBAN_TOKEN = "late";
      if (rejects) reject(new Error("late rejection"));
      else resolve(optionalRequest);
      await Promise.resolve();
      await Promise.resolve();
      t.mock.timers.tick(CREATE_HOOK_BUDGET_MS);
      assert.equal(next?.env?.KANBAN_TOKEN, "worker-token");
    }
  });

  it("removes the SDK cancellation listener after optional success or local timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const timeout of [false, true]) {
      const cancel = new AbortController();
      const remove = t.mock.method(cancel.signal, "removeEventListener");
      const pending = boundedCreateHook(request(), {
        ...base, signal: cancel.signal,
        ...(timeout ? { optional: () => new Promise<CreateHookRequest>(() => {}) } : {}),
      });
      if (timeout) t.mock.timers.tick(CREATE_HOOK_BUDGET_MS);
      const next = await pending;
      assert.equal(remove.mock.callCount(), 1);
      const prompt = next?.config.systemPrompt;
      cancel.abort();
      assert.equal(next?.config.systemPrompt, prompt);
    }
  });
});

describe("lifecycle object identity", () => {
  it("tracks CLI-created agents through labeled SDK updates and releases the background subscription", async () => {
    const objects = new HookObjects();
    let listener: ((update: PaseoAgentUpdate) => void) | undefined;
    let unsubscribed = 0;
    let released = 0;
    const api = { agents: {
      subscribe: (fn: typeof listener) => { listener = fn; return () => { unsubscribed++; }; },
      list: async () => ({ entries: [{ agent: { id: "cli-existing", labels: { kanban: "1" } } }], subscription: { release: async () => { released++; } } }),
    } } as unknown as PaseoApi;
    const stop = watchHookObjects(api, objects);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(objects.agent({ id: "cli-existing" }), true);
    assert.ok(listener);
    listener({ kind: "upsert", agent: { id: "cli-new", labels: { kanban: "1" } } } as unknown as PaseoAgentUpdate);
    listener({ kind: "upsert", agent: { id: "schedule-new", labels: {} } } as unknown as PaseoAgentUpdate);
    assert.equal(objects.agent({ id: "cli-new" }), true);
    assert.equal(objects.agent({ id: "schedule-new" }), false);
    stop();
    listener({ kind: "upsert", agent: { id: "after-stop", labels: { kanban: "1" } } } as unknown as PaseoAgentUpdate);
    assert.equal(objects.agent({ id: "after-stop" }), false);
    assert.equal(unsubscribed, 1);
    assert.equal(released, 1);
  });

  it("releases a late subscription snapshot after stopping, and consumes subscription failures", async () => {
    let deliver: ((value: unknown) => void) | undefined;
    let released = 0;
    const api = { agents: { subscribe: () => () => {}, list: () => new Promise((resolve) => { deliver = resolve; }) } } as unknown as PaseoApi;
    const stop = watchHookObjects(api, new HookObjects());
    stop();
    assert.ok(deliver);
    deliver({ entries: [], subscription: { release: async () => { released++; } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(released, 1);
    const logs: string[] = [];
    const failing = { agents: { subscribe: () => () => {}, list: async () => { throw new Error("offline"); } } } as unknown as PaseoApi;
    const release = watchHookObjects(failing, new HookObjects(), (message) => logs.push(message));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logs.length, 1);
    release();
  });
  it("recognizes marked events and known IDs, never unrelated agents sharing a workspace", () => {
    const objects = new HookObjects();
    objects.rememberAgent("worker");
    objects.rememberWorkspace("kanban-worktree");
    assert.equal(objects.agent({ id: "worker" }), true);
    assert.equal(objects.agent({ id: "manual" }), false);
    assert.equal(objects.agent({ labels: { kanban: "1" } }), true);
    assert.equal(objects.agent({ env: { [BOARD_AGENT_ENV]: "1" } }), true);
    assert.equal(objects.workspace({ id: "kanban-worktree" }), true);
    assert.equal(objects.workspace({ id: "personal" }), false);
    assert.equal(objects.agent(undefined), false);
    assert.equal(objects.workspace(undefined), false);
  });

  it("remembers newly created kanban agents/workspaces before subsequent SDK events", async () => {
    const api = { workspaces: { ref: () => ({ agents: { create: async () => ({ id: "new-worker" }) } }), create: async () => ({ id: "new-workspace", current: () => ({ workspaceDirectory: "/tmp/TEST_0094" }) }) }, agents: { create: async () => ({ id: "new-manual" }) } } as unknown as PaseoApi;
    const launcher = launcherFrom(api);
    await launcher.create({ config: request().config, env: request().env, cwd: "/tmp/TEST_0094", title: "worker", prompt: "work", workspaceId: "main" });
    assert.equal(hookObjects.agent({ id: "new-worker" }), true);
    await launcher.create({ config: request().config, cwd: "/tmp/TEST_0094", title: "manual", prompt: "work" });
    assert.equal(hookObjects.agent({ id: "new-manual" }), false);
    await launcher.createDirectoryWorkspace!({ cwd: "/tmp/TEST_0094" });
    assert.equal(hookObjects.workspace({ id: "new-workspace" }), true);
  });
});
