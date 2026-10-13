import assert from "node:assert/strict";
import { it } from "node:test";
import { callWithRetry, isPluginUnavailable, isReadRpc, PluginUpdateError, READ_RETRY_DELAYS, READ_RETRY_BUDGET_MS } from "../client/rpc-policy";
const missing = () => new Error("Request failed: Plugin is not available: paseo-kanban");
const virtual = () => { let now = 0; const waits: number[] = []; return { waits, clock: { now: () => now, wait: async (ms: number) => { waits.push(ms); now += ms; } }, advance: (ms: number) => { now += ms; } }; };
it("recognizes the unavailable diagnostic, not arbitrary handler errors or validation errors", () => {
  for (const e of [missing(), "Plugin not available", { message: "Plugin is not available: paseo-kanban", code: "handler_error" }]) assert.equal(isPluginUnavailable(e), true);
  for (const e of [new Error("handler_error"), { code: "handler_error" }, new Error("Invalid data"), new Error("permission denied"), null]) assert.equal(isPluginUnavailable(e), false);
});
it("only retries audited reads and empty mixed read/write inputs", () => {
  for (const name of ["board.snapshot", "kanban.board", "board.panel-prefs", "kanban.panel-prefs", "kanban.board-tab", "config.read"]) assert.equal(isReadRpc(name, {}), true);
  for (const name of ["board.panel-prefs", "kanban.panel-prefs", "kanban.board-tab"]) assert.equal(isReadRpc(name, { fontStep: "lg" }), false);
  assert.equal(isReadRpc("board.access", { refresh: false }), true);
  for (const [name, input] of [["board.access", { refresh: true }], ["kanban.start", {}], ["board.decide-reply", {}], ["config.write", {}], ["future.read", {}], ["kanban.panel-prefs", null], ["board.access", { refresh: "true" }]] as const) assert.equal(isReadRpc(name, input), false);
});
it("recovers several failed reads using backoff and always releases the updating state", async () => {
  const v = virtual(), states: boolean[] = []; let calls = 0;
  assert.equal(await callWithRetry("board.snapshot", {}, async () => { if (++calls < 4) throw missing(); return "new snapshot"; }, active => states.push(active), v.clock), "new snapshot");
  assert.deepEqual(v.waits, [500, 1000, 2000]); assert.equal(calls, 4); assert.deepEqual(states, [true, false]);
});
it("exhausts at five retries within fifteen seconds and returns an actionable read error", async () => {
  const v = virtual(), states: boolean[] = []; let calls = 0;
  await assert.rejects(callWithRetry("kanban.board", {}, async () => { calls++; throw missing(); }, active => states.push(active), v.clock), PluginUpdateError);
  assert.equal(calls, 6); assert.deepEqual(v.waits, READ_RETRY_DELAYS); assert.ok(v.waits.reduce((a,b) => a+b, 0) < READ_RETRY_BUDGET_MS); assert.deepEqual(states, [true, false]);
});
it("includes request time in the retry budget", async () => {
  const v = virtual(); let calls = 0;
  await assert.rejects(callWithRetry("kanban.board", {}, async () => { calls++; v.advance(8000); throw missing(); }, () => {}, v.clock), PluginUpdateError);
  assert.equal(calls, 3); assert.deepEqual(v.waits, [500, 1000]);
});
it("does not retry writes, refresh actions, unknown RPCs or nontransient errors", async () => {
  for (const [method, input] of [["kanban.start", {}], ["board.decide-reply", {}], ["kanban.panel-prefs", { fontStep: "lg" }], ["board.panel-prefs", { tab: "home" }], ["kanban.board-tab", { tab: "decisions" }], ["board.access", { refresh: true }], ["future.read", {}]] as const) {
    let calls = 0; const v = virtual();
    await assert.rejects(callWithRetry(method, input, async () => { calls++; throw missing(); }, () => assert.fail("write must not enter retry state"), v.clock), PluginUpdateError);
    assert.equal(calls, 1); assert.deepEqual(v.waits, []);
  }
  const cause = new Error("handler_error: real bug"); let calls = 0;
  await assert.rejects(callWithRetry("kanban.board", {}, async () => { calls++; throw cause; }, () => assert.fail()), error => error === cause);
  assert.equal(calls, 1);
});
it("stops on a permanent error after a transient one", async () => {
  let calls = 0; const states: boolean[] = []; const v = virtual(), cause = new Error("bad response schema");
  await assert.rejects(callWithRetry("board.snapshot", {}, async () => { if (++calls === 1) throw missing(); throw cause; }, active => states.push(active), v.clock), error => error === cause);
  assert.equal(calls, 2); assert.deepEqual(states, [true, false]);
});
it("bounds a hanging retry and clears its progress state", async () => {
  let calls = 0, now = 0; const states: boolean[] = [];
  await assert.rejects(callWithRetry("board.snapshot", {}, async () => { if (++calls === 1) throw missing(); return new Promise<never>(() => {}); }, active => states.push(active), { now: () => now, wait: async () => { now = READ_RETRY_BUDGET_MS - 1; } }), PluginUpdateError);
  assert.equal(calls, 2); assert.deepEqual(states, [true, false]);
});
