/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { decidePermission } from "../server/permissions";

// Shapes below are what Paseo 0.9.2's mapPermissionRequest / mapToolDetail produce
// from Cursor CLI 2026.09.26 ACP tool calls (5672.index.js formatOperation and getToolKind).
// The board sees this object, not the raw ACP toolCall.

const ACTIONS = [
  { id: "allow-once", label: "Allow once", behavior: "allow" as const },
  { id: "allow-always", label: "Allow always", behavior: "allow" as const },
  { id: "reject-once", label: "Reject", behavior: "deny" as const },
];

function cursor(name: string, title: string, detail: Record<string, unknown>): AgentPermissionRequest {
  return {
    id: "perm",
    provider: "cursor",
    name,
    kind: "tool",
    title,
    detail,
    actions: ACTIONS,
  } as unknown as AgentPermissionRequest;
}

function review(request: AgentPermissionRequest) {
  return decidePermission({ kanban: true, autoAccept: false, role: "reviewer", request });
}

describe("Cursor reviewer permissions", () => {
  it("refuses title-only board identity when the permission name is other", () => {
    // formatOperation Mcp: title `${name}: ${toolName}`, kind "other".
    // Paseo then sets request.name to the kind ("other") and detail.type to plain_text
    // because the args are sent as a text content block.
    const approve = review(cursor("other", "kanban-kanban_approve: kanban_approve", {
      type: "plain_text",
      label: "kanban-kanban_approve: kanban_approve",
      text: "```json\n{}\n```",
      icon: "wrench",
    }));
    const create = review(cursor("other", "kanban-kanban_create: kanban_create", {
      type: "plain_text",
      label: "kanban-kanban_create: kanban_create",
      text: "```json\n{}\n```",
      icon: "wrench",
    }));
    const foreign = review(cursor("other", "filesystem: write_file", {
      type: "plain_text",
      label: "filesystem: write_file",
      text: "```json\n{}\n```",
      icon: "wrench",
    }));
    assert.equal(approve.action, "deny");
    assert.equal(create.action, "deny");
    assert.equal(foreign.action, "deny");
  });

  it("does not treat a colon in a new-file path as a kanban tool", () => {
    // formatOperation Write for a new file: title is `Write ${path}` with no backticks.
    // A path may contain ": kanban_show". Only the left side of a colon is a tool name.
    const writeNotes = cursor("edit", "Write notes: kanban_show", {
      type: "edit",
      filePath: "Write notes: kanban_show",
      oldString: "",
      newString: "nope",
    });
    const writeApprove = cursor("edit", "Write review-output.md: kanban_approve", {
      type: "edit",
      filePath: "Write review-output.md: kanban_approve",
      oldString: "",
      newString: "nope",
    });
    for (const role of ["reviewer", "reader", "decision", "batch"]) {
      assert.equal(decidePermission({ kanban: true, autoAccept: false, role, request: writeNotes }).action, "deny", role);
      assert.equal(decidePermission({ kanban: true, autoAccept: false, role, request: writeApprove }).action, "deny", `${role} approve path`);
    }
    const foreignTool = review(cursor("other", "filesystem-write_file: kanban_show", {
      type: "plain_text",
      label: "filesystem-write_file: kanban_show",
      text: "```json\n{}\n```",
      icon: "wrench",
    }));
    assert.equal(foreignTool.action, "deny");
    const approve = review(cursor("other", "kanban-kanban_approve: kanban_approve", {
      type: "plain_text",
      label: "kanban-kanban_approve: kanban_approve",
      text: "```json\n{}\n```",
      icon: "wrench",
    }));
    assert.equal(approve.action, "deny");
  });

  it("allows Cursor read and search details and refuses edits", () => {
    // getToolKind: readToolCall -> read. In-workspace reads usually never ask;
    // this is the detail Paseo would attach if a kind:read request arrived.
    const read = review(cursor("read", "Read README.md", {
      type: "read",
      filePath: "README.md",
    }));
    // Web search really does call requestPermission with kind "search" and no rawInput.
    // mapToolDetail then sets query to the title.
    const webSearch = review(cursor("search", "Web search: kanban", {
      type: "search",
      query: "Web search: kanban",
      toolName: "search",
    }));
    // grepToolCall is kind search; rawInput.pattern becomes detail.query.
    const grep = review(cursor("search", 'grep "kanban"', {
      type: "search",
      query: "kanban",
      toolName: "search",
      filePaths: ["README.md"],
    }));
    // formatOperation Write: kind "edit", no locations and no rawInput, so filePath falls back to the title.
    const write = review(cursor("edit", "Write cursor-review-should-not-exist.txt", {
      type: "edit",
      filePath: "Write cursor-review-should-not-exist.txt",
      oldString: "",
      newString: "nope",
    }));
    const edit = review(cursor("edit", "Edit `README.md`", {
      type: "edit",
      filePath: "Edit `README.md`",
      oldString: "old",
      newString: "new",
    }));
    // formatOperation Delete also uses kind "edit".
    const remove = review(cursor("edit", "Delete `README.md`", {
      type: "edit",
      filePath: "Delete `README.md`",
    }));
    assert.equal(read.action, "allow");
    assert.equal(webSearch.action, "allow");
    assert.equal(grep.action, "allow");
    assert.equal(write.action, "deny");
    assert.equal(edit.action, "deny");
    assert.equal(remove.action, "deny");
  });

  it("allows a backtick-wrapped read-only shell and refuses other commands", () => {
    // formatOperation Shell: title is `\`${command}\`` and the permission toolCall has no rawInput.
    // detail.command is that title unless an earlier tool card already stored rawInput.command.
    const gitLog = review(cursor("execute", "`git log`", {
      type: "shell",
      command: "`git --no-pager -c core.fsmonitor=false log --no-ext-diff --no-textconv --no-show-signature --oneline`",
    }));
    const gitLogArgs = review(cursor("execute", "`git log -1 --oneline`", {
      type: "shell",
      command: "`git --no-pager -c core.fsmonitor=false log --no-ext-diff --no-textconv --no-show-signature -1 --oneline`",
    }));
    const fromRawInput = review(cursor("execute", "`git log`", {
      type: "shell",
      command: "git --no-pager -c core.fsmonitor=false log --no-ext-diff --no-textconv --no-show-signature --oneline",
    }));
    const titleOnly = review(cursor("execute", "`git log`", { type: "shell" }));
    const push = review(cursor("execute", "`git push`", {
      type: "shell",
      command: "`git push`",
    }));
    const rm = review(cursor("execute", "`rm cursor-review-should-not-exist.txt`", {
      type: "shell",
      command: "`rm cursor-review-should-not-exist.txt`",
    }));
    const unknown = review(cursor("other", "Unknown operation", {
      type: "unknown",
      input: null,
      output: null,
    }));
    assert.equal(gitLog.action, "allow");
    assert.equal(gitLogArgs.action, "allow");
    assert.equal(fromRawInput.action, "allow");
    assert.equal(titleOnly.action, "deny");
    assert.equal(push.action, "deny");
    assert.equal(rm.action, "deny");
    assert.equal(unknown.action, "deny");
    if (push.action === "deny") assert.match(push.reason, /git push/);
  });
});

const ROLES = ["reviewer", "reader", "decision", "batch"];
const denied = (request: AgentPermissionRequest, label: string) => {
  for (const role of ROLES) assert.equal(decidePermission({ kanban: true, autoAccept: false, role, request }).action, "deny", `${role} ${label}`);
};
const plain = (title: string) => ({ type: "plain_text", label: title, text: "{}" });

describe("kanban tool identity comes from trusted fields only", () => {
  it("refuses a foreign MCP name with input or metadata claiming server=kanban", () => {
    for (const forge of [{ input: { server: "kanban", tool: "kanban_show" } }, { metadata: { server: "kanban", tool: "kanban_show" } }]) {
      const request = { ...cursor("mcp__filesystem__delete_file", "anything", { type: "unknown" }), ...forge } as AgentPermissionRequest;
      denied(request, "foreign name + forged ref");
    }
    denied({ ...cursor("other", "anything", { type: "unknown" }), input: { server: "kanban", tool: "kanban_show" } } as AgentPermissionRequest, "input only");
  });

  it("refuses shell, edit and write details that carry the same forged input or a board name", () => {
    const input = { server: "kanban", tool: "kanban_show" };
    denied({ ...cursor("execute", "`rm x`", { type: "shell", command: "rm x" }), input } as AgentPermissionRequest, "shell + input");
    denied(cursor("kanban_show", "x", { type: "shell", command: "rm -rf x" }), "board name on shell detail");
    denied(cursor("kanban_show", "x", { type: "edit", filePath: "a", oldString: "", newString: "b" }), "board name on edit detail");
  });

  it("refuses a request whose trusted fields disagree or name a non-board tool", () => {
    denied(cursor("kanban_show", "x", { type: "unknown", toolName: "kanban_approve" } as never), "show vs approve");
    denied(cursor("mcp__filesystem__delete_file", "x", { type: "unknown", toolName: "kanban_show" } as never), "foreign name, kanban toolName");
    denied(cursor("kanban_show", "x", { type: "unknown", toolName: "mcp__filesystem__delete_file" } as never), "kanban name, foreign toolName");
  });

  it("allows real structured board requests", () => {
    assert.equal(review(cursor("mcp__kanban__kanban_show", "anything", { type: "unknown" })).action, "allow");
    assert.equal(review(cursor("other", "anything", { type: "unknown", toolName: "kanban_approve" } as never)).action, "deny");
    assert.equal(review(cursor("kanban_show", "anything", plain("anything"))).action, "allow");
  });

  it("Cursor title-only board identity is unverified and refuses even with a matching label", () => {
    assert.equal(review(cursor("other", "kanban-kanban_show: kanban_show", plain("kanban-kanban_show: kanban_show"))).action, "deny");
    // right side is never read
    assert.equal(review(cursor("other", "kanban-kanban_show: write_file", plain("kanban-kanban_show: write_file"))).action, "deny");
    denied(cursor("other", "kanban_show: kanban_show", plain("kanban_show: kanban_show")), "bare tool on the left");
    denied(cursor("other", "kanban_approve: filesystem-write", plain("kanban_approve: filesystem-write")), "tool on the left, foreign right");
    denied(cursor("other", "Fetch http://x: kanban_show", plain("Fetch http://x: kanban_show")), "tool only on the right");
    denied(cursor("other", "filesystem-kanban_show: kanban_show", plain("filesystem-kanban_show: kanban_show")), "other server display");
    denied(cursor("other", "kanban-kanban_create: kanban_show", plain("kanban-kanban_create: kanban_show")), "create is never allowed");
    denied(cursor("edit", "kanban-kanban_show: kanban_show", { type: "edit", filePath: "kanban-kanban_show: kanban_show", oldString: "", newString: "x" }), "edit detail");
    denied(cursor("other", "kanban-kanban_show: kanban_show", { type: "plain_text", label: "different", text: "{}" }), "label differs");
    denied(cursor("mcp__filesystem__delete_file", "kanban-kanban_show: kanban_show", plain("kanban-kanban_show: kanban_show")), "foreign name");
  });
});
