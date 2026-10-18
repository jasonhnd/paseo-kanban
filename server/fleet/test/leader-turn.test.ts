import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForLeaderTurn } from "../leader-turn";

type Result = Awaited<ReturnType<typeof waitForLeaderTurn>>;
type Agent = Parameters<typeof waitForLeaderTurn>[0];
const result = (status: Result["status"], lastMessage: string | null = null, final: Result["final"] = null): Result =>
  ({ status, final, lastMessage, error: status === "error" ? "Provider failed" : null });

function fixture(initial: Result, following: Result[] = []) {
  let now = 0;
  let sends = 0;
  const waits: number[] = [];
  const budgets: number[] = [];
  const sleeps: number[] = [];
  let current = initial;
  let reads = 0;
  const timeline = { refetch: async () => ({ epoch: "same", window: { maxSeq: 10 }, error: null,
    entries: reads++ === 0 ? [] : [{ seqStart: 11, item: { type: "assistant_message", text: current.lastMessage } }],
  }) };
  const agent = {
    timeline: timeline as unknown as Agent["timeline"],
    run: async (_prompt: string, options?: { timeoutMs?: number }) => { budgets.push(options?.timeoutMs ?? 0); sends++; return initial; },
    waitForFinish: async (timeout?: number) => { waits.push(timeout!); return current = following.shift() ?? initial; },
  };
  const clock = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
  return { agent, clock, waits, sleeps, budgets, sends: () => sends };
}

test("permission during handover waits for the final reply without sending again or accepting permission", async () => {
  // A permission result can carry the old reply, even one containing the acknowledgement.
  const f = fixture(result("permission", "Handover ready (old turn)"), [result("permission"), result("idle", "Handover ready (current turn)")]);
  const done = await waitForLeaderTurn(f.agent, 5_000, "Write the handover", f.clock);
  assert.equal(done.lastMessage, "Handover ready (current turn)");
  assert.equal(done.status, "idle");
  assert.equal(f.sends(), 1);
  assert.deepEqual(f.waits, [4_500, 4_000]);
});

test("unresolved permission shares one deadline and never returns an old acknowledgement", async () => {
  const f = fixture(result("permission", "Handover ready (old turn)"));
  const done = await waitForLeaderTurn(f.agent, 1_250, "Write the handover", f.clock);
  assert.equal(done.status, "timeout");
  assert.equal(done.lastMessage, null);
  assert.equal(f.sends(), 1);
  assert.deepEqual(f.waits, [750, 250]);
  assert.deepEqual(f.sleeps, [500, 500, 250]);
});

test("a leftover activeTurn marker on an idle agent does not hold the wait open", async () => {
  // The host treats this agent as idle; waiting on the marker would only run out the budget.
  const f = fixture(result("idle", "Done", { status: "idle", activeTurn: { turnId: "demo-turn" } } as never), [result("idle", "Later")]);
  assert.equal((await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock)).lastMessage, "Done");
  assert.equal(f.waits.length, 0);
});

test("an idle receipt whose final snapshot is still running is not completion", async () => {
  const f = fixture(result("idle", "Earlier reply", { status: "running" } as never), [result("idle", "Done")]);
  assert.equal((await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock)).lastMessage, "Done");
});

test("waiting for a previously sent transfer never sends another prompt", async () => {
  const f = fixture(result("permission"), [result("permission"), result("idle", "Transferred")]);
  assert.equal((await waitForLeaderTurn(f.agent, 2_000, undefined, f.clock)).lastMessage, "Transferred");
  assert.equal(f.sends(), 0);
  assert.deepEqual(f.waits, [2_000, 1_500]);
});

for (const status of ["idle", "error", "timeout"] as const) test(`a real ${status} result ends the wait without replay`, async () => {
  const f = fixture(result(status, status === "idle" ? "Permission denied; cannot finish" : null));
  const done = await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock);
  assert.equal(done.status, status);
  assert.equal(done.error, status === "error" ? "Provider failed" : null);
  assert.equal(f.sends(), 1);
  assert.equal(f.waits.length, 0);
});

for (const replacement of [false, true]) test(`stale acknowledgement is rejected when timeline replacement=${replacement}`, async () => {
  const f = fixture(result("permission", "Handover ready"), [result("idle", "Handover ready")]);
  let reads = 0;
  f.agent.timeline = { refetch: async () => ({ epoch: reads++ && replacement ? "replacement" : "same", window: { maxSeq: 10 }, error: null,
    entries: [{ seqStart: 10, item: { type: "assistant_message", text: "Handover ready" } }],
  }) } as never;
  assert.equal((await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock)).lastMessage, null);
});

test("a new acknowledgement with identical text is accepted by sequence", async () => {
  const f = fixture(result("permission", "Handover ready"), [result("idle", "Handover ready")]);
  assert.equal((await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock)).lastMessage, "Handover ready");
});

for (const status of ["closed", "error"]) test(`idle receipt cannot override ${status} session snapshot`, async () => {
  const f = fixture(result("idle", "Handover ready", { status } as never));
  const done = await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock);
  assert.equal(done.status, "error");
  assert.equal(done.lastMessage, null);
});

for (const elapsed of [400, 2_000]) test(`baseline read consumes ${elapsed}ms from the same deadline`, async () => {
  const f = fixture(result("idle", "Handover ready"));
  const read = f.agent.timeline.refetch;
  let reads = 0;
  f.agent.timeline = { refetch: async () => { if (reads++ === 0) await f.clock.sleep(elapsed); return read(); } } as never;
  const done = await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock);
  assert.deepEqual(f.budgets, elapsed === 400 ? [1_600] : []);
  assert.equal(done.status, elapsed === 400 ? "idle" : "timeout");
});

test("a reply split across adjacent assistant entries is joined, without earlier turns", async () => {
  const f = fixture(result("idle", "ignored"));
  let reads = 0;
  const entry = (seqStart: number, type: string, text: string) => ({ seqStart, item: { type, text } });
  f.agent.timeline = { refetch: async () => ({ epoch: "same", window: { maxSeq: 10 }, error: null,
    entries: reads++ === 0 ? [] : [entry(9, "assistant_message", "Old answer "), entry(11, "tool_call", ""), entry(12, "assistant_message", "Handover "), entry(13, "assistant_message", "ready")],
  }) } as never;
  assert.equal((await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock)).lastMessage, "Handover ready");
});

test("adjacent assistant entries stop at the pre-send sequence", async () => {
  const f = fixture(result("idle", "ignored"));
  let reads = 0;
  const entry = (seqStart: number, text: string) => ({ seqStart, item: { type: "assistant_message", text } });
  f.agent.timeline = { refetch: async () => ({ epoch: "same", window: { maxSeq: 10 }, error: null,
    entries: reads++ === 0 ? [] : [entry(10, "Handover ready (old) "), entry(11, "new")],
  }) } as never;
  assert.equal((await waitForLeaderTurn(f.agent, 2_000, "Handover", f.clock)).lastMessage, "new");
});
