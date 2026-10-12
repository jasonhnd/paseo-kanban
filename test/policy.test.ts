/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { BLOCKED_KINDS, isBlockedKind } from "../shared/blocked";
import { inOpeningGrace, judgeNudge, lastUserMessageAtOf, progressCoversTurn, timelineShowsWork, withinNudgeInterval } from "../server/nudge";
import { canonicalKanbanTool, decidePermission } from "../server/permissions";
import { buildAgentConfig, selectProfile, type Profile } from "../server/profiles";
import { assertTransition } from "../server/state";

const cursor: Profile = {
  id: "role_executor_cursor_local",
  name: "Executor · Cursor Local (candidate)",
  role: "candidate",
  candidateFor: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  modeId: "agent",
  thinkingOptionId: "high",
  featureValues: { fast: "false", auto_accept: true },
};

const officialReviewer: Profile = {
  id: "role_reviewer",
  name: zhCN("labels.role.reviewer"),
  role: "reviewer",
  family: "anthropic",
  provider: "claude",
  model: "claude-sonnet-5",
};

function request(detail: { type: string; filePath?: string }, name?: string): AgentPermissionRequest {
  return {
    id: "perm",
    agentId: "a",
    provider: "test",
    name: name ?? detail.type,
    kind: "tool",
    detail,
    actions: [{ id: "allow" }, { id: "deny" }],
  } as unknown as AgentPermissionRequest;
}

function named(toolName: string): AgentPermissionRequest {
  return request({ type: "unknown" }, toolName);
}

const NAME_FORMS = (tool: string): string[] => [tool, `kanban_${tool}`, `mcp__kanban__${tool}`, `kanban/${tool}`, `kanban-${tool}`];

const REVIEWER_ALLOW = ["kanban_show", "kanban_list", "kanban_comment", "kanban_block", "kanban_approve", "kanban_request_changes"];
const READER_ALLOW = ["kanban_show", "kanban_list", "kanban_comment", "kanban_block", "kanban_complete"];
const NEVER = ["kanban_create", "kanban_accept", "kanban_archive"];

describe("state machine", () => {
  it("allows the work path and rejects a skip", () => {
    assert.doesNotThrow(() => assertTransition("ready", "running"));
    assert.doesNotThrow(() => assertTransition("running", "in_review"));
    assert.doesNotThrow(() => assertTransition("reviewing", "rework"));
    assert.doesNotThrow(() => assertTransition("rework", "acceptance"));
    assert.doesNotThrow(() => assertTransition("acceptance", "done"));
    assert.throws(() => assertTransition("done", "running"), new RegExp(localePattern(zhCNPart("flow.error.cannotReject", 0, 3))));
    assert.throws(() => assertTransition("archived", "ready"), new RegExp(localePattern(zhCNPart("flow.error.cannotReject", 0, 3))));
  });
});

describe("profiles", () => {
  it("passes mode, thinking, and feature values through unchanged", () => {
    const config = buildAgentConfig(cursor);
    assert.equal(config.provider, "cursor/grok-4.7");
    assert.equal(config.modeId, "agent");
    assert.equal(config.thinkingOptionId, "high");
    assert.deepEqual(config.featureValues, { fast: "false", auto_accept: true });
    assert.equal(typeof config.featureValues?.fast, "string");
    assert.equal(config.featureValues?.auto_accept, true);
  });

  it("skips a reviewer with the executor's actual model", () => {
    const sameFamily: Profile = { ...officialReviewer, family: "anthropic", model: " GROK-4.7 " };
    const pick = selectProfile([cursor, sameFamily, officialReviewer], {
      role: "reviewer",
      executorFamily: "xai", executorModel: "grok-4.7",
      review: true,
    });
    assert.equal(pick.ok, true);
    if (pick.ok) assert.equal(pick.profile.family, "anthropic");
  });

  it("blocks when every reviewer shares the executor's actual model", () => {
    const sameFamily: Profile = { ...officialReviewer, family: "anthropic", model: " GROK-4.7 " };
    const pick = selectProfile([cursor, sameFamily], { role: "reviewer", executorFamily: "xai", executorModel: "grok-4.7", review: true });
    assert.equal(pick.ok, false);
  });

  it("matches a unique profile name prefix", () => {
    const pick = selectProfile([cursor, officialReviewer], {
      role: "executor",
      profileOverride: "Executor · Cursor Local",
      review: false,
    });
    assert.equal(pick.ok, true);
    if (pick.ok) assert.equal(pick.profile.id, "role_executor_cursor_local");
  });
});

describe("permissions", () => {
  it("ignores agents that are not kanban", () => {
    assert.deepEqual(decidePermission({ kanban: false, autoAccept: true, role: "executor", request: request({ type: "shell" }) }), { action: "ignore" });
  });

  it("allows a profile whose auto_accept is true", () => {
    const decision = decidePermission({ kanban: true, autoAccept: true, role: "executor", request: request({ type: "shell" }) });
    assert.equal(decision.action, "allow");
  });

  it("keeps a reviewer on the read-only list and denies everyone else", () => {
    const read = decidePermission({ kanban: true, autoAccept: false, role: "reviewer", request: request({ type: "read", filePath: "README.md" }) });
    const write = decidePermission({ kanban: true, autoAccept: false, role: "reviewer", request: request({ type: "write", filePath: "README.md" }) });
    const executor = decidePermission({ kanban: true, autoAccept: false, role: "executor", request: request({ type: "read", filePath: "README.md" }) });
    assert.equal(read.action, "allow");
    assert.equal(write.action, "deny");
    assert.equal(executor.action, "deny");
  });

  it("recognizes every prefix providers put on a kanban tool", () => {
    assert.equal(canonicalKanbanTool("kanban_show"), "kanban_show");
    assert.equal(canonicalKanbanTool("kanban_kanban_show"), "kanban_show");
    assert.equal(canonicalKanbanTool("mcp__kanban__kanban_show"), "kanban_show");
    assert.equal(canonicalKanbanTool("kanban/kanban_show"), "kanban_show");
    assert.equal(canonicalKanbanTool("mcp__kanban__kanban_kanban_approve"), "kanban_approve");
    assert.equal(canonicalKanbanTool("kanban-kanban_show"), "kanban_show");
    assert.equal(canonicalKanbanTool("kanban-kanban_approve"), "kanban_approve");
    assert.equal(canonicalKanbanTool("kanban-kanban_kanban_approve"), "kanban_approve");
    assert.equal(canonicalKanbanTool("kanban-cat"), null);
    assert.equal(canonicalKanbanTool("cat"), null);
  });

  it("lets each read-only role call its kanban tools under every name form, and refuses create, accept, and archive", () => {
    const roles: Array<{ role: string; allow: string[]; deny: string[] }> = [
      { role: "reviewer", allow: REVIEWER_ALLOW, deny: [...NEVER, "kanban_complete"] },
      { role: "reader", allow: READER_ALLOW, deny: [...NEVER, "kanban_approve", "kanban_request_changes"] },
      { role: "decision", allow: READER_ALLOW, deny: [...NEVER, "kanban_approve", "kanban_request_changes"] },
      { role: "batch", allow: READER_ALLOW, deny: [...NEVER, "kanban_approve", "kanban_request_changes"] },
    ];
    for (const { role, allow, deny } of roles) {
      for (const tool of allow) {
        for (const form of NAME_FORMS(tool)) {
          const decision = decidePermission({ kanban: true, autoAccept: false, role, request: named(form) });
          assert.equal(decision.action, "allow", `${role} ${form}`);
        }
      }
      for (const tool of deny) {
        for (const form of NAME_FORMS(tool)) {
          const decision = decidePermission({ kanban: true, autoAccept: false, role, request: named(form) });
          assert.equal(decision.action, "deny", `${role} ${form}`);
        }
      }
    }
    const doubled = decidePermission({
      kanban: true,
      autoAccept: false,
      role: "reviewer",
      request: named("kanban_kanban_show"),
    });
    assert.equal(doubled.action, "allow");
    const cursorTitle = decidePermission({
      kanban: true,
      autoAccept: false,
      role: "reviewer",
      request: named("kanban-kanban_approve: kanban_approve"),
    });
    // A colon title in the name field is text, not a structured tool field (TEST_0184 P2-20).
    assert.equal(cursorTitle.action, "deny");
    const cursorCreate = decidePermission({
      kanban: true,
      autoAccept: false,
      role: "reviewer",
      request: named("kanban-kanban_create: kanban_create"),
    });
    assert.equal(cursorCreate.action, "deny");
    const executor = decidePermission({ kanban: true, autoAccept: false, role: "executor", request: named("kanban_show") });
    assert.equal(executor.action, "deny");
  });
});

describe("blocked kinds and nudges", () => {
  it("accepts only the contract enum", () => {
    for (const kind of BLOCKED_KINDS) assert.equal(isBlockedKind(kind), true);
    assert.equal(isBlockedKind("needs_info"), false);
  });

  it("keeps counted nudges at least one interval apart", () => {
    const start = Date.parse("2026-09-30T15:47:52.000Z");
    const interval = 10 * 60_000;
    const first = new Date(start).toISOString();
    assert.equal(withinNudgeInterval(null, start, interval), false);
    assert.equal(withinNudgeInterval(first, start + 7_000, interval), true);
    assert.equal(withinNudgeInterval(first, start + interval - 1, interval), true);
    assert.equal(withinNudgeInterval(first, start + interval, interval), false);
  });

  it("treats only a still-running sub-agent as work, not a finished Read or Bash", () => {
    assert.equal(timelineShowsWork([{ type: "assistant_message", text: (zhCNPart("reclaimNote.result.running", 0, 2) + zhCNPart("client.panel.title", 0, 1)) }]), false);
    assert.equal(timelineShowsWork([{ type: "tool_call", name: "Read", status: "completed", detail: { type: "read" } }]), false);
    assert.equal(timelineShowsWork([{ type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell" } }]), false);
    assert.equal(
      timelineShowsWork([{ type: "tool_call", name: "Task", status: "completed", detail: { type: "sub_agent" } }]),
      false,
    );
    assert.equal(
      timelineShowsWork([{ item: { type: "tool_call", name: "Task", status: "running", callId: "child", detail: { type: "sub_agent" } } }]),
      true,
    );
    assert.equal(
      timelineShowsWork([
        { type: "tool_call", name: "Task", status: "running", callId: "child", detail: { type: "sub_agent" } },
        { type: "tool_call", name: "Task", status: "completed", callId: "child", detail: { type: "sub_agent" } },
      ]),
      false,
    );
    assert.equal(timelineShowsWork([{ type: "notification", message: "Background agent is still running" }]), true);
    assert.equal(timelineShowsWork([{ type: "notification", message: "Background agent didn't finish" }]), false);
  });

  it("blocks on the third turn without a finish tool", () => {
    assert.equal(judgeNudge(0, false).action, "remind");
    assert.equal(judgeNudge(1, false).action, "remind");
    assert.equal(judgeNudge(2, false).action, "block");
    assert.deepEqual(judgeNudge(2, true), { count: 0, action: "none" });
    assert.deepEqual(judgeNudge(1, false, true), { count: 1, action: "none" });
    assert.deepEqual(judgeNudge(1, true, true), { count: 0, action: "none" });
  });

  it("treats a progress comment as covering the turn only inside the grace window", () => {
    const grace = 30 * 60_000;
    const now = Date.parse("2026-09-29T03:00:00.000Z");
    const recent = new Date(now - 5 * 60_000).toISOString();
    const stale = new Date(now - grace - 1).toISOString();
    const nudged = new Date(now - 10 * 60_000).toISOString();
    const before = new Date(now - 20 * 60_000).toISOString();
    const after = new Date(now - 60_000).toISOString();
    assert.equal(progressCoversTurn([recent], null, now, grace), true);
    assert.equal(progressCoversTurn([stale], null, now, grace), false);
    assert.equal(progressCoversTurn([], null, now, grace), false);
    assert.equal(progressCoversTurn([before], nudged, now, grace), false);
    assert.equal(progressCoversTurn([before, after], nudged, now, grace), true);
    assert.equal(progressCoversTurn([stale, after], null, now, grace), false);
  });

  it("does not treat an opening turn as finished", () => {
    const grace = 60_000;
    const opened = Date.parse("2026-09-29T00:00:00.000Z");
    const started = new Date(opened).toISOString();
    assert.equal(inOpeningGrace(started, null, opened + 1_000, grace), true);
    assert.equal(inOpeningGrace(started, started, opened + 1_000, grace), true);
    assert.equal(inOpeningGrace(null, null, opened + 1_000, grace), false);
    assert.equal(inOpeningGrace(started, null, opened + grace, grace), false);
    assert.equal(inOpeningGrace(started, started, opened + grace + 1, grace), false);
    const later = new Date(opened + 10 * 60_000).toISOString();
    assert.equal(inOpeningGrace(started, later, opened + 10 * 60_000 + 1_000, grace), false);
    assert.equal(lastUserMessageAtOf({ lastUserMessageAt: started }), started);
    assert.equal(lastUserMessageAtOf({ lastUserMessageAt: "" }), null);
    assert.equal(lastUserMessageAtOf({}), undefined);
  });
});
