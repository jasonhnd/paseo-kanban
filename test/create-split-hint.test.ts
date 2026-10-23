/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { runKanban } from "../server/cli";
import { closeDb } from "../server/db";
import { createTask, setProfileHintSource } from "../server/task-create";
import { getTask } from "../server/store";
import { formatResult, handleTool } from "../server/tools";
import { issueToken } from "../server/tokens";
import { setProjectCode } from "../server/config";
import { protocolFor } from "../server/protocol";
import { getLanguage, setLanguage } from "../shared/i18n";

const dir = mkdtempSync(join(tmpdir(), "split-hint-"));
process.env.KANBAN_DATA_DIR = dir;
const initialLanguage = getLanguage();
after(() => { closeDb(); setLanguage(initialLanguage); rmSync(dir, { recursive: true, force: true }); });
const input = { project: "split-demo", role: "executor", workspacePath: dir };
const create = (title: string, brief = "") => createTask({ ...input, title, brief });

it("tells leaders to split before dispatch in both generated protocols", () => {
  assert.match(protocolFor("supervisor", { language: "en" }), /Before dispatch.*more than one hour.*more than one task.*split.*parallel/);
  assert.match(protocolFor("supervisor", { language: "en" }), /Per-card resource brakes.*fallback/);
  assert.match(protocolFor("supervisor", { language: "zh-CN" }), /\u6d3e\u5361\u524d.*\u8d85\u8fc7 1 \u5c0f\u65f6.*\u4e0d\u6b62\u4e00\u4ef6\u4e8b.*\u5148\u62c6.*\u5e76\u884c/);
  assert.match(protocolFor("supervisor", { language: "zh-CN" }), /token.*\u515c\u5e95/);
});

it("returns a localized, non-blocking warning for clear parallel actions", () => {
  for (const language of ["en", "zh-CN"] as const) {
    setLanguage(language);
    for (const title of ["\u4fee\u590d\u767b\u5f55\uff1b\u66f4\u65b0\u6587\u6863", "\u65b0\u589e\u5bfc\u51fa\uff0b\u8fc1\u79fb\u914d\u7f6e\uff0b\u5220\u9664\u65e7\u63a5\u53e3", "\u4fee\u590d\u767b\u5f55\u3001\u66f4\u65b0\u6587\u6863\u3001\u8fc1\u79fb\u914d\u7f6e", "Fix login; update docs; migrate settings", "\u4fee\u590d\u767b\u5f55\u3001\u8865\u6d4b\u8bd5", "Test export; investigate login"]) {
      const task = create(title);
      assert.equal(task.status, "ready");
      assert.equal(task.warnings?.length, 1, title);
      assert.match(task.warnings![0], language === "en" ? /Consider splitting/ : /\u5efa\u8bae\u62c6\u5206/);
      assert.ok(formatResult(task).includes(task.warnings![0]));
    }
  }
});

it("recognizes explicit estimates over an hour and numbered work lists", () => {
  for (const brief of ["\u9884\u8ba1\u8017\u65f6\uff1a90 \u5206\u949f", "\u9884\u8ba1 1.5 \u5c0f\u65f6", "Estimated duration: 2 hours", "Estimate: 1h 30m", "Tasks:\n1. Fix login\n\n2. Update docs\n\n3. Migrate settings", "\u9884\u8ba1\u8d85\u8fc7 1 \u5c0f\u65f6", "Tasks:\n1. Fix login\n2. Update docs\n3. Migrate settings", "\u8981\u505a\uff1a\n1\u3001\u4fee\u590d\u767b\u5f55\n2\u3001\u66f4\u65b0\u6587\u6863\n3\u3001\u8fc1\u79fb\u914d\u7f6e"]) {
    assert.equal(create("Demo feature", brief).warnings?.length, 1, brief);
  }
});

it("avoids noun lists, acceptance checklists, unrelated durations and one-hour estimates", () => {
  for (const [title, brief] of [
    ["\u4fee\u590d\u767b\u5f55", ""], ["\u4fee\u590d\u767b\u5f55\u3001\u6ce8\u518c\u3001\u9000\u51fa\u7684\u9519\u8bef", ""],
    ["Fix login; logout; registration", ""], ["\u4fee\u590d + \u53f7\u89e3\u6790", ""],
    ["Demo feature", "\u9a8c\u6536\uff1a\n1. \u4fee\u590d\u540e\u767b\u5f55\u6210\u529f\n2. \u66f4\u65b0\u540e\u4ecd\u517c\u5bb9\n3. \u5220\u9664\u540e\u53ef\u6062\u590d"],
    ["Demo feature", "Acceptance:\n1. Check login\n2. Test logout\n3. Verify settings"],
    ["Demo feature", "\u9884\u8ba1 60 \u5206\u949f"], ["Demo feature", "Estimate: 1 hour"],
    ["Demo feature", "Session timeout: 2 hours; retain logs for 90 minutes"],
    ["Demo feature", "\u9884\u8ba1 30 \u5206\u949f\u3002\u4f1a\u8bdd\u8fc7\u671f\u4e3a 2 \u5c0f\u65f6"],
    // Deliberate conservative misses: prose without separators and unknown action words.
    ["Fix login and update docs", ""], ["\u68b3\u7406\u63a5\u53e3\uff1b\u6da6\u8272\u6587\u6848", ""],
    ["Demo feature", "1. Fix login\n2. Update docs"],
  ]) assert.equal(create(title, brief).warnings, undefined, `${title}: ${brief}`);
});

it("shares the warning and opt-out through CLI and MCP without storing the hint", async () => {
  setProjectCode(input.project, "SPL");
  const title = "Fix login; update docs";
  const argv = ["create", "--project", input.project, "--role", input.role, "--workspace", dir, "--title", title];
  const cli = await runKanban(argv, {}) as ReturnType<typeof createTask>;
  assert.equal(cli.warnings?.length, 1);
  const quiet = await runKanban([...argv, "--no-split-hint"], {}) as ReturnType<typeof createTask>;
  assert.equal(quiet.warnings, undefined);
  const token = issueToken("supervisor", null, null);
  const mcp = await handleTool("kanban_create", { ...input, title }, token) as ReturnType<typeof createTask>;
  assert.equal(mcp.warnings?.length, 1);
  const mcpQuiet = await handleTool("kanban_create", { ...input, title, noSplitHint: true }, token) as ReturnType<typeof createTask>;
  assert.equal(mcpQuiet.warnings, undefined);
  assert.equal((getTask(mcp.id) as typeof mcp).warnings, undefined);
});

it("ignores quoted code and inline acceptance sections", () => {
  for (const brief of [
    "Acceptance criteria:\n1. Fix verified\n2. Update verified\n3. Migrate verified",
    "Acceptance: Fix verified; update verified; migrate verified",
    "```text\nEstimated duration: 2 hours\n```",
  ]) assert.equal(create("Demo feature", brief).warnings, undefined, brief);
});

it("preserves existing warnings when split hints are enabled or disabled", () => {
  setProfileHintSource(() => ({ profile: "demo", pool: null, suggested: "other", suggestedPool: null, role: "executor", tier: "L2", message: "Demo profile hint" }));
  try {
    const task = { ...input, title: "Fix login; update docs", profileOverride: "demo" };
    const hints = createTask(task);
    assert.equal(hints.warnings?.length, 2);
    assert.equal(hints.warnings?.[0], "Demo profile hint");
    assert.deepEqual(createTask({ ...task, noSplitHint: true }).warnings, ["Demo profile hint"]);
  } finally { setProfileHintSource(null); }
});
