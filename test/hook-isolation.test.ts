/// <reference types="node" />
import { BOARD_AGENT_ENV } from "../server/agent-env";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { createLifecycleHooks, type LifecycleHookDeps } from "../server/lifecycle-hooks";
import { createHookBinding } from "../server/hook-binding";
import type { PaseoApi } from "@getpaseo/client";
import { fastestUnder } from "./helpers/timing";

const CALLBACK_BUDGET_MS = 5;

// Call the same typed factory used for registration. Every side effect is a trap.
const trap = () => assert.fail("non-kanban hook touched a dependency or logged");
function callbacks(extras: Partial<LifecycleHookDeps> = {}) {
  return createLifecycleHooks({
    hookObjects: { agent: () => false, workspace: () => false },
    console: { error: trap }, bind: trap, bindMemory: trap, schedulerReady: () => true, kick: trap, getDb: trap,
    createOptions: trap, permissionContext: trap, ...extras,
  } as LifecycleHookDeps);
}
const context = { get paseo() { return assert.fail("Paseo context accessed"); } } as unknown as PluginHookContext;

describe("lifecycle hook isolation", () => {
  it("returns non-kanban creation unchanged, without even inspecting config, in under 5ms", async (t) => {
    const request = { env: {}, get config() { return assert.fail("config accessed"); } };
    const handler = callbacks().before;
    const { best, runs } = await fastestUnder(CALLBACK_BUDGET_MS, async () => {
      const begin = performance.now();
      assert.equal(await handler({ request }, context), undefined);
      return performance.now() - begin;
    });
    assert.ok(best < CALLBACK_BUDGET_MS, `fastest of ${runs.length} runs ${best.toFixed(3)}ms (runs ${runs.map((ms) => ms.toFixed(1)).join(", ")})`);
    t.diagnostic(`non-kanban agent.create callback: ${best.toFixed(3)}ms`);
  });

  it("passes the SDK before-hook cancellation signal to mandatory-only injection", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const hooks = callbacks({ createOptions: () => ({ baseUrl: "http://fixture", supervisorToken: null }) });
    const next = await hooks.before({ request: {
      config: { provider: "codex", cwd: "/tmp/TEST_0100", systemPrompt: "existing" },
      env: { [BOARD_AGENT_ENV]: "1" },
    } }, { signal: cancel.signal } as PluginHookContext);
    assert.equal(next?.config.systemPrompt, "existing");
    assert.ok(next?.config.mcpServers?.kanban);
  });

  it("returns all unrelated lifecycle events without bind, DB, files, scheduling, or logs", async (t) => {
    // The registry used in production is loaded at startup, never by the callback.
    const gate = { agent: () => false, workspace: () => false };
    const hooks = callbacks({ hookObjects: gate });
    for (const name of ["permission", "turn", "archived", "created", "workspace"] as const) {
      const handler = hooks[name];
      const event = { agent: { id: "schedule-agent", workspaceId: "shared-main" }, workspace: { id: "personal-workspace" } } as unknown as Parameters<typeof hooks.permission>[0] & Parameters<typeof hooks.turn>[0] & Parameters<typeof hooks.archived>[0] & Parameters<typeof hooks.workspace>[0];
      const { best, runs } = await fastestUnder(CALLBACK_BUDGET_MS, async () => {
        const begin = performance.now();
        assert.equal(await handler(event, context), undefined);
        return performance.now() - begin;
      });
      assert.ok(best < CALLBACK_BUDGET_MS, `${name}: fastest of ${runs.length} runs ${best.toFixed(3)}ms (runs ${runs.map((ms) => ms.toFixed(1)).join(", ")})`);
      t.diagnostic(`${name} callback: ${best.toFixed(3)}ms`);
    }
  });

  it("recovers from an unavailable early client using one memory-only bind in under 5ms", async (t) => {
    for (const name of ["turn", "created", "workspace"] as const) {
      let initialized = 0;
      let binding = createHookBinding(() => { initialized++; });
      let paseo = new Proxy({} as PaseoApi, { get: trap });
      let hooks = callbacks({ schedulerReady: binding.ready, bindMemory: binding.bindMemory });
      let event = {} as Parameters<typeof hooks.turn>[0] & Parameters<typeof hooks.workspace>[0];
      // Each attempt starts from a fresh, unbound binding; the last one is checked below.
      const { best, runs } = await fastestUnder(CALLBACK_BUDGET_MS, async () => {
        initialized = 0;
        binding = createHookBinding(() => { initialized++; });
        paseo = new Proxy({} as PaseoApi, { get: trap });
        hooks = callbacks({ schedulerReady: binding.ready, bindMemory: binding.bindMemory });
        event = { agent: { id: "unrelated" }, workspace: { id: "personal" } } as unknown as
          Parameters<typeof hooks.turn>[0] & Parameters<typeof hooks.workspace>[0];
        assert.equal(binding.ready(), false);
        const begin = performance.now();
        assert.equal(await hooks[name](event, { paseo } as PluginHookContext), undefined);
        return performance.now() - begin;
      });
      assert.ok(best < CALLBACK_BUDGET_MS, `${name}: fastest of ${runs.length} runs ${best.toFixed(3)}ms (runs ${runs.map((ms) => ms.toFixed(1)).join(", ")})`);
      t.diagnostic(`${name} memory fallback: ${best.toFixed(3)}ms`);
      assert.equal(binding.ready(), true);
      assert.equal(binding.current(), paseo);
      assert.equal(initialized, 0); // No subscription, cleanup install or other initialization yet.
      await hooks[name](event, context); // Once bound, context must not even be inspected.
      assert.equal(binding.current(), paseo);
      assert.equal(initialized, 0);
      binding.activate(); // The scheduler's existing timer performs deferred initialization.
      assert.equal(initialized, 1);
      binding.activate();
      assert.equal(initialized, 1);
    }
  });

  it("skips missing fallback clients and never replaces a bound client", async () => {
    const binding = createHookBinding(trap);
    const hooks = callbacks({ schedulerReady: binding.ready, bindMemory: binding.bindMemory });
    const event = { agent: { id: "unrelated" } } as Parameters<typeof hooks.created>[0];
    await hooks.created(event, {} as PluginHookContext);
    await hooks.created(event, context);
    assert.equal(binding.ready(), false);
    const first = {} as PaseoApi;
    binding.bindMemory(first);
    binding.bindMemory({} as PaseoApi);
    assert.equal(binding.current(), first);
  });
});
