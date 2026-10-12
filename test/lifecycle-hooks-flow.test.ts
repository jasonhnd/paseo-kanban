/// <reference types="node" />
import { BOARD_AGENT_ENV } from "../server/agent-env";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { createLifecycleHooks, type LifecycleHookDeps } from "../server/lifecycle-hooks";

type Row = { id: number; status: string } | undefined;

interface Harness {
  calls: string[];
  errors: string[];
  sent: string[];
  responses: unknown[];
  hooks: ReturnType<typeof createLifecycleHooks>;
  context: PluginHookContext;
}

// Every dependency is a recording stub, so each branch of the kanban path can be driven directly.
function harness(overrides: Record<string, unknown> = {}, row: Row = { id: 7, status: "running" }): Harness {
  const calls: string[] = [];
  const errors: string[] = [];
  const sent: string[] = [];
  const responses: unknown[] = [];
  const paseo = {
    agents: {
      ref: () => ({
        respondToPermission: async (response: unknown) => { responses.push(response); },
        send: async (text: string) => { sent.push(text); },
        archive: async () => undefined,
      }),
    },
  };
  const deps = {
    hookObjects: { agent: () => true, workspace: () => true },
    bind: () => { calls.push("bind"); },
    schedulerReady: () => true,
    bindMemory: () => { calls.push("bindMemory"); },
    kick: async () => { calls.push("kick"); },
    createOptions: () => ({ baseUrl: "http://fixture", supervisorToken: null }),
    permissionContext: () => ({ kanban: true, autoAccept: true, role: "executor", taskId: 7 }),
    console: { error: (...args: unknown[]) => { errors.push(args.join(" ")); } },
    getDb: () => ({ prepare: () => ({ get: () => row }) }),
    decidePermission: () => ({ action: "allow" }),
    addComment: (...args: unknown[]) => { calls.push(`comment:${args[1]}`); },
    appendEvent: (...args: unknown[]) => { calls.push(`event:${args[1]}`); },
    getTask: () => ({ id: 7, status: "running", agent_id: "agent-1" }),
    planTurn: () => ({ action: "finished", finished: true }),
    lastUserMessageAtOf: () => undefined,
    readAgentPresence: async () => "idle",
    settleCanceledTurn: (...args: unknown[]) => { calls.push(`settle:${args[2]}`); },
    askPaseoAgent: async () => "absent",
    readAgentEndNote: async () => null,
    settleOpeningLoginBlip: async () => "ignore",
    readProfiles: () => [],
    applyFailure: (...args: unknown[]) => { calls.push(`failure:${args[1]}`); },
    classifyFailure: () => "other",
    reclaimTask: (id: number) => { calls.push(`reclaim:${id}`); },
    applyNudge: () => ({ action: "none" }),
    mcpNoteFor: () => null,
    readReclaimContext: async () => ({}),
    ...overrides,
  } as unknown as LifecycleHookDeps;
  return { calls, errors, sent, responses, hooks: createLifecycleHooks(deps), context: { paseo } as unknown as PluginHookContext };
}

const agentEvent = { agent: { id: "agent-1" } };

describe("lifecycle hooks: permission requests", () => {
  it("answers an allowed request with the selected action", async () => {
    const h = harness({ decidePermission: () => ({ action: "allow", selectedActionId: "once" }) });
    await h.hooks.permission({ ...agentEvent, request: { id: "r1", name: "bash" } } as never, h.context);
    assert.deepEqual(h.responses, [{ requestId: "r1", response: { behavior: "allow", selectedActionId: "once" } }]);
  });

  it("answers an allowed request without a selected action when none is given", async () => {
    const h = harness();
    await h.hooks.permission({ ...agentEvent, request: { id: "r1", name: "bash" } } as never, h.context);
    assert.deepEqual(h.responses, [{ requestId: "r1", response: { behavior: "allow" } }]);
  });

  it("denies, comments and records an event when the card is known", async () => {
    const h = harness({ decidePermission: () => ({ action: "deny", reason: "too wide" }) });
    await h.hooks.permission({ ...agentEvent, request: { id: "r2", name: "rm" } } as never, h.context);
    assert.deepEqual(h.responses, [{ requestId: "r2", response: { behavior: "deny", message: "too wide" } }]);
    assert.ok(h.calls.includes("comment:kanban"));
    assert.ok(h.calls.includes("event:permission_denied"));
  });

  it("denies without comment when the agent has no card", async () => {
    const h = harness({
      decidePermission: () => ({ action: "deny", reason: "no" }),
      permissionContext: () => ({ kanban: true, autoAccept: false, role: null, taskId: null }),
    });
    await h.hooks.permission({ ...agentEvent, request: { id: "r3", name: "rm" } } as never, h.context);
    assert.equal(h.responses.length, 1);
    assert.equal(h.calls.some((call) => call.startsWith("comment")), false);
  });

  it("does nothing for an ignored decision", async () => {
    const h = harness({ decidePermission: () => ({ action: "ignore" }) });
    await h.hooks.permission({ ...agentEvent, request: { id: "r4", name: "x" } } as never, h.context);
    assert.deepEqual(h.responses, []);
  });

  it("logs instead of throwing when deciding fails", async () => {
    const h = harness({ permissionContext: () => { throw new Error("db gone"); } });
    await h.hooks.permission({ ...agentEvent, request: { id: "r5", name: "x" } } as never, h.context);
    assert.deepEqual(h.errors, ["[paseo-kanban] permission db gone"]);
  });
});

describe("lifecycle hooks: turn ended", () => {
  let outcome: Record<string, unknown>;
  beforeEach(() => { outcome = {}; });
  const turnEvent = () => ({ ...agentEvent, outcome, timeline: [] }) as never;

  it("only kicks the scheduler when no live card owns the agent", async () => {
    const h = harness({
      getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
      planTurn: () => { throw new Error("planTurn must not run without a card"); },
    });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(h.calls, ["bind", "kick"]);
    assert.deepEqual(h.errors, []);
  });

  it("only kicks when the card is no longer running or reviewing", async () => {
    const h = harness({}, { id: 7, status: "done" });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(h.calls, ["bind", "kick"]);
  });

  it("settles a canceled turn using the agent presence", async () => {
    const h = harness({ planTurn: () => ({ action: "canceled" }), readAgentPresence: async () => "closed" });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(h.calls, ["bind", "settle:closed", "kick"]);
  });

  it("passes the reclaim evidence of a departed agent: its turn's commands, workspace and the cancel reason", async () => {
    const settled: unknown[][] = [];
    const asked: unknown[][] = [];
    const found = { trail: { actions: ["gh pr merge #351 (exit code 0)"], otherCommands: 0 }, workspace: { id: "ws-1", archiving: true } };
    const h = harness({
      planTurn: () => ({ action: "canceled" }),
      readAgentPresence: async () => "archived",
      readReclaimContext: async (...args: unknown[]) => { asked.push(args.slice(1)); return found; },
      settleCanceledTurn: (...args: unknown[]) => { settled.push(args); },
    });
    const timeline = [{ type: "assistant_message", text: "x" }];
    await h.hooks.turn({ agent: { id: "agent-1", workspaceId: "ws-1" }, timeline, outcome: { kind: "canceled", reason: "agent closed" } } as never, h.context);
    assert.deepEqual(asked, [["agent-1", "ws-1", { timeline }]]);
    assert.deepEqual(settled, [[7, "agent-1", "archived", { ...found, cancelReason: "agent closed" }]]);
  });

  it("does not store a cancel reason that is not a short plain phrase", async () => {
    const settled: unknown[][] = [];
    const h = harness({
      planTurn: () => ({ action: "canceled" }),
      readAgentPresence: async () => "archived",
      settleCanceledTurn: (...args: unknown[]) => { settled.push(args); },
    });
    await h.hooks.turn({ agent: { id: "agent-1" }, timeline: [], outcome: { kind: "canceled", reason: 'failed: {"api_key":"REVIEW_SYNTHETIC"}' } } as never, h.context);
    assert.deepEqual(settled, [[7, "agent-1", "archived", {}]]);
  });

  it("does not store a cancel reason carrying a header or curl credential, with or without a colon (TEST_0300)", async () => {
    const reasons = [
      "Authorization: Bearer REVIEW_SYNTHETIC_7f3a9c",
      "curl -u deploy:REVIEW_SYNTHETIC_7f3a9c",
      "Authorization Bearer REVIEW_SYNTHETIC_7f3a9c",
      "bearer REVIEW_SYNTHETIC_7f3a9c",
      "Basic REVIEW_SYNTHETIC_7f3a9c",
      "curl -u deploy REVIEW_SYNTHETIC_7f3a9c",
      "curl --user deploy REVIEW_SYNTHETIC_7f3a9c",
      "curl -uuser hunter2",
      "-uuser REVIEW_SYNTHETIC_7f3a9c",
      "token REVIEW_SYNTHETIC_7f3a9c",
      "password REVIEW_SYNTHETIC_7f3a9c",
      "api_key REVIEW_SYNTHETIC_7f3a9c",
      "failed: closed",
    ];
    for (const reason of reasons) {
      const settled: unknown[][] = [];
      const h = harness({
        planTurn: () => ({ action: "canceled" }),
        readAgentPresence: async () => "archived",
        settleCanceledTurn: (...args: unknown[]) => { settled.push(args); },
      });
      await h.hooks.turn({ agent: { id: "agent-1" }, timeline: [], outcome: { kind: "canceled", reason } } as never, h.context);
      assert.deepEqual(settled, [[7, "agent-1", "archived", {}]], reason);
    }
  });

  it("does not read reclaim evidence when the canceled turn left the agent here", async () => {
    const settled: unknown[][] = [];
    const h = harness({
      planTurn: () => ({ action: "canceled" }),
      readAgentPresence: async () => "idle",
      readReclaimContext: async () => assert.fail("no evidence read for a live agent"),
      settleCanceledTurn: (...args: unknown[]) => { settled.push(args); },
    });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(settled, [[7, "agent-1", "idle", undefined]]);
  });

  it("stops after an opening login blip was settled", async () => {
    const h = harness({ settleOpeningLoginBlip: async () => "retry" });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(h.calls, ["bind", "kick"]);
  });

  it("logs the reason and kicks when the plan says skip", async () => {
    const h = harness({ planTurn: () => ({ action: "skip", reason: "still working" }) });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(h.errors, ["[paseo-kanban] turn still working"]);
    assert.deepEqual(h.calls, ["bind", "kick"]);
  });

  it("applies a failure with the pool of the last run's profile", async () => {
    const seen: unknown[] = [];
    const h = harness({
      getDb: () => ({ prepare: (sql: string) => ({ get: () => (sql.includes("FROM runs") ? { profile_name: "p1" } : { id: 7, status: "running" }) }) }),
      planTurn: () => ({ action: "failed", message: "boom", code: "E" }),
      readProfiles: () => [{ name: "p1", pool: "claude-max" }],
      applyFailure: (...args: unknown[]) => { seen.push(args[4]); },
    });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(seen, ["claude-max"]);
    assert.equal(h.calls.at(-1), "kick");
  });

  it("applies a failure with no pool when profiles cannot be read", async () => {
    const pools: unknown[] = [];
    const h = harness({
      planTurn: () => ({ action: "failed", message: "boom" }),
      readProfiles: () => { throw new Error("no profiles"); },
      applyFailure: (...args: unknown[]) => { pools.push(args[4]); },
    });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(pools, [null]);
    assert.deepEqual(h.errors, ["[paseo-kanban] profiles no profiles"]);
  });

  it("sends a plain reminder with the count for an ordinary card", async () => {
    const h = harness({ applyNudge: () => ({ action: "remind", count: 2 }) });
    await h.hooks.turn(turnEvent(), h.context);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0]!, /\u7b2c 2 \u6b21\u63d0\u9192/);
    assert.match(h.sent[0]!, /\u5982\u679c\u4f60\u5728\u7b49\u540e\u53f0\u7ed3\u679c\uff0c\u8bf7\u73b0\u5728\u8bfb\u53d6\u7ed3\u679c\uff0c\u4e0d\u8981\u518d\u6b21\u7ed3\u675f\u56de\u5408/);
  });

  it("prefixes the stale-MCP note on the reminder", async () => {
    const h = harness({ applyNudge: () => ({ action: "remind", count: 1 }), mcpNoteFor: () => "NOTE:" });
    await h.hooks.turn(turnEvent(), h.context);
    assert.match(h.sent[0]!, /^NOTE:\u8fd9\u662f\u7b2c 1 \u6b21\u63d0\u9192/);
  });

  it("does not remind when the nudge decision is not a reminder", async () => {
    const h = harness();
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(h.sent, []);
    assert.equal(h.calls.at(-1), "kick");
  });

  it("logs and still kicks when a dependency throws", async () => {
    const h = harness({ planTurn: () => { throw new Error("bad timeline"); } });
    await h.hooks.turn(turnEvent(), h.context);
    assert.deepEqual(h.errors, ["[paseo-kanban] turn bad timeline"]);
    assert.equal(h.calls.at(-1), "kick");
  });
});

describe("lifecycle hooks: archived, created, workspace", () => {
  it("reclaims a running card whose agent was archived", async () => {
    const h = harness({ readAgentPresence: async () => "archived" });
    await h.hooks.archived(agentEvent as never, h.context);
    assert.deepEqual(h.calls, ["bind", "reclaim:7", "kick"]);
  });

  // TEST_0299: Paseo's auto-archive-on-merge took TEST2_0165's agent 4 seconds after its own gh pr merge.
  it("records the agent's last commands and the merged PR on the reclaim", async () => {
    const reclaims: unknown[][] = [];
    const asked: unknown[][] = [];
    const found = {
      trail: { actions: ["gh pr merge #354 --squash (exit code 0)"], otherCommands: 0 },
      workspace: { id: "ws-9", archiving: true, pullRequest: { url: "https://github.com/o/r/pull/354", merged: true } },
    };
    const h = harness({
      readAgentPresence: async () => "archived",
      readReclaimContext: async (...args: unknown[]) => { asked.push(args.slice(1)); return found; },
      reclaimTask: (...args: unknown[]) => { reclaims.push(args); },
    });
    await h.hooks.archived({ agent: { id: "agent-1", workspaceId: "ws-9" } } as never, h.context);
    assert.deepEqual(asked, [["agent-1", "ws-9"]]);
    assert.equal(reclaims.length, 1);
    assert.equal(reclaims[0]![0], 7);
    assert.deepEqual(reclaims[0]![2], { source: "agent.archived", apiState: "archived", ...found });
  });

  it("an unknown presence still reclaims: the archived event itself is the evidence", async () => {
    const h = harness({ readAgentPresence: async () => "unknown" });
    await h.hooks.archived(agentEvent as never, h.context);
    assert.deepEqual(h.calls, ["bind", "reclaim:7", "kick"]);
  });

  for (const presence of ["running", "idle"] as const) {
    it(`keeps the card when Paseo still reports the agent ${presence} and unarchived`, async () => {
      const h = harness({ readAgentPresence: async () => presence });
      await h.hooks.archived(agentEvent as never, h.context);
      assert.deepEqual(h.calls, ["bind", "event:archive_event_kept", "kick"]);
    });
  }

  it("does not reclaim when the card moved on while the evidence was read", async () => {
    let reads = 0;
    const h = harness({
      readAgentPresence: async () => "archived",
      getTask: () => (reads++ < 1 ? { id: 7, status: "running", agent_id: "agent-1" } : { id: 7, status: "acceptance", agent_id: "agent-1" }),
    });
    await h.hooks.archived(agentEvent as never, h.context);
    assert.deepEqual(h.calls, ["bind", "kick"]);
  });

  it("ignores an archived event for an agent the card no longer holds", async () => {
    const h = harness({ readAgentPresence: async () => "archived", getTask: () => ({ id: 7, status: "running", agent_id: "agent-2" }) });
    await h.hooks.archived(agentEvent as never, h.context);
    assert.deepEqual(h.calls, ["bind", "kick"]);
  });

  it("leaves a card without a running state alone", async () => {
    const h = harness({}, { id: 7, status: "done" });
    await h.hooks.archived(agentEvent as never, h.context);
    assert.deepEqual(h.calls, ["bind", "kick"]);
  });

  it("skips the round when the event carries no paseo client", async () => {
    const h = harness();
    await h.hooks.archived(agentEvent as never, {} as PluginHookContext);
    assert.deepEqual(h.calls, []);
    assert.match(h.errors[0]!, /no paseo client/);
  });

  it("logs and kicks when an archived event lacks an agent id", async () => {
    const h = harness({ hookObjects: { agent: () => true, workspace: () => true } });
    await h.hooks.archived({ agent: {} } as never, h.context);
    assert.match(h.errors[0]!, /no agent\.id/);
    assert.deepEqual(h.calls, ["bind", "kick"]);
  });

  it("logs and still kicks when reclaiming throws", async () => {
    const h = harness({ readAgentPresence: async () => "archived", reclaimTask: () => { throw new Error("locked"); } });
    await h.hooks.archived(agentEvent as never, h.context);
    assert.deepEqual(h.errors, ["[paseo-kanban] archived locked"]);
    assert.equal(h.calls.at(-1), "kick");
  });

  it("binds and kicks on agent and workspace creation", () => {
    const h = harness();
    h.hooks.created(agentEvent as never, h.context);
    h.hooks.workspace({ workspace: { id: "w1" } } as never, h.context);
    assert.deepEqual(h.calls, ["bind", "kick", "bind", "kick"]);
  });

  it("does nothing on creation events without a paseo client", () => {
    const h = harness();
    h.hooks.created(agentEvent as never, {} as PluginHookContext);
    h.hooks.workspace({ workspace: { id: "w1" } } as never, {} as PluginHookContext);
    assert.deepEqual(h.calls, []);
  });

  it("logs when binding fails on creation events", () => {
    const h = harness({ bind: () => { throw new Error("no daemon"); } });
    h.hooks.created(agentEvent as never, h.context);
    h.hooks.workspace({ workspace: { id: "w1" } } as never, h.context);
    assert.deepEqual(h.errors, ["[paseo-kanban] agent.created no daemon", "[paseo-kanban] workspace.created no daemon"]);
  });

  it("swallows a throwing create hook and returns the request unchanged", () => {
    const h = harness({ createOptions: () => { throw new Error("config"); } });
    const request = { env: { [BOARD_AGENT_ENV]: "1" }, config: { provider: "codex", cwd: "/tmp/x" } };
    assert.equal(h.hooks.before({ request } as never, h.context), undefined);
    assert.match(h.errors[0]!, /agent\.create hook swallowed config/);
  });
});
