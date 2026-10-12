/// <reference types="node" />
import { BOARD_AGENT_ENV } from "../server/agent-env";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { closeDb } from "../server/db";
import { cliFallback, displayCliPath } from "../server/fallback";
import { guardCreateHook, injectMcp, primeCliEnv, resetCliEnv, shouldInjectMcp, type CreateHookRequest } from "../server/inject";
import { kanbanCliPath } from "../server/paths";
import { protocolFor } from "../server/protocol";
import { ensureSupervisorToken } from "../server/tokens";

function req(extra: Partial<CreateHookRequest> = {}): CreateHookRequest {
  const config: AgentSessionConfig = { provider: "claude", cwd: "/tmp/sandbox", model: "claude-haiku-4-5" };
  return { config, ...extra };
}

describe("MCP inject gate", () => {
  it("requires executor and batch temporary files outside the checkout and a clean handoff", () => {
    for (const role of ["executor", "batch"]) {
      const rules = protocolFor(role);
      assert.match(rules, /\u6240\u6709\u4e34\u65f6\u6587\u4ef6.*\u90fd\u653e\u8fdb \/tmp\/<\u672c\u5361\u5361\u53f7>\//);
      assert.match(rules, /\u4e0d\u8981\u7559\u5728\u5de5\u4f5c\u76ee\u5f55/);
      assert.match(rules, /git status --short \u5fc5\u987b\u4e3a\u7a7a\uff08\u672a\u8ddf\u8e2a\u6587\u4ef6\u4e5f\u4e0d\u884c\uff09\uff0c\u5426\u5219\u5148\u6e05\u6389\u6216\u79fb\u51fa/);
    }
    const batch = protocolFor("batch");
    assert.match(batch, /\u6d3b\u4e0d\u5728\u672c\u4ed3\u5e93\u65f6\uff0c\u4e0d\u8981\u5728\u81ea\u5df1\u7684\u5361\u7247\u5206\u652f\u4e0a\u505a\u7a7a\u63d0\u4ea4\u8bb0\u5f55\u7ed3\u679c\uff0c\u7ed3\u679c\u5199\u8fdb\u4ea4\u63a5/);
    assert.doesNotMatch(protocolFor("executor"), /\u7a7a\u63d0\u4ea4/);
  });

  it("tells every role to keep scratch files under its own card and to read the production database in place", () => {
    for (const role of ["executor", "batch", "reviewer", "reader", "decision"]) {
      const rules = protocolFor(role);
      assert.match(rules, /\u6d4f\u89c8\u5668 --user-data-dir、mktemp.*\u90fd\u653e\u8fdb \/tmp\/<\u672c\u5361\u5361\u53f7>\//, role);
      assert.match(rules, /TMPDIR \u548c KANBAN_TMP/, role);
      assert.match(rules, /\u4e0d\u8981\u53e6\u8d77\u540d\u5b57/, role);
      assert.match(rules, /mode=ro&immutable=1/, role);
      assert.match(rules, /\u4e0d\u8981\u590d\u5236\u6574\u5e93/, role);
      assert.match(rules, /\u53ea\u590d\u5236 kanban\.db \u8fd9\u4e00\u4e2a\u6587\u4ef6\u5230 \/tmp\/<\u672c\u5361\u5361\u53f7>\/ \u4e0b/, role);
    }
    assert.match(protocolFor("batch"), /^10\. \u6d3b\u4e0d\u5728\u672c\u4ed3\u5e93\u65f6/m);
  });

  it("passes through agents without a kanban label or env flag", () => {
    assert.equal(shouldInjectMcp(req()), false);
    assert.equal(injectMcp(req(), "http://127.0.0.1:9"), undefined);
  });

  it("does not inject when only a kanban label is present", () => {
    assert.equal(shouldInjectMcp(req({ labels: { kanban: "spike", role: "supervisor" } })), false);
    assert.equal(injectMcp(req({ labels: { kanban: "spike" } }), "http://127.0.0.1:9"), undefined);
    assert.equal(guardCreateHook(req({ labels: { kanban: "1", role: "supervisor" } }), "http://127.0.0.1:9"), undefined);
  });

  it("injects when the legacy board-agent environment flag is 1, which the 0.9.2 hook can see", () => {
    assert.equal(BOARD_AGENT_ENV, ["PASEO", "KANBAN"].join("_"));
    const next = injectMcp(req({ env: { [BOARD_AGENT_ENV]: "1", KANBAN_TOKEN: "abc" } }), "http://127.0.0.1:9");
    const server = next?.config.mcpServers?.kanban;
    assert.ok(server && server.type === "http");
    assert.equal(server.url, "http://127.0.0.1:9/mcp");
    assert.equal(server.headers?.Authorization, "Bearer abc");
    assert.equal(next?.env?.KANBAN_TOKEN, "abc");
  });

  it("hands board agents the command lines primed at startup, and nothing before that", () => {
    const before = injectMcp(req({ env: { [BOARD_AGENT_ENV]: "1", KEEP: "1" } }), "http://127.0.0.1:9");
    assert.deepEqual(before?.env, { [BOARD_AGENT_ENV]: "1", KEEP: "1" });
    try {
      const primed = primeCliEnv();
      assert.equal(primed.KANBAN_CLI, kanbanCliPath());
      const next = injectMcp(req({ env: { [BOARD_AGENT_ENV]: "1", KEEP: "1" } }), "http://127.0.0.1:9");
      assert.equal(next?.env?.KANBAN_CLI, kanbanCliPath());
      assert.equal(next?.env?.KEEP, "1");
      assert.equal(injectMcp(req(), "http://127.0.0.1:9"), undefined, "agents outside the board get nothing");
    } finally {
      resetCliEnv();
    }
  });

  it("keeps existing mcp servers", () => {
    const request = req({
      env: { [BOARD_AGENT_ENV]: "1" },
      config: {
        provider: "cursor",
        cwd: "/work",
        mcpServers: { other: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      },
    });
    const next = injectMcp(request, "http://127.0.0.1:9");
    assert.equal(next?.config.mcpServers?.other?.type, "http");
    assert.ok(next?.config.mcpServers?.kanban);
  });

  it("appends a role-specific protocol only for kanban agents", () => {
    assert.equal(guardCreateHook(req(), "http://127.0.0.1:9"), undefined);
    const executor = guardCreateHook(req({ env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "executor" } }), "http://127.0.0.1:9");
    assert.match(executor?.config.systemPrompt ?? "", /\u770b\u677f\u5de5\u4f5c\u5b88\u5219\uff08\u6267\u884c\uff09/);
    assert.match(executor?.config.systemPrompt ?? "", /files、verification、risks/);
    assert.match(executor?.config.systemPrompt ?? "", /\u540e\u53f0\u547d\u4ee4、\u5168\u91cf\u6d4b\u8bd5、\u5b50 agent \u6ca1\u51fa\u7ed3\u679c\u524d\u4e0d\u8981\u7ed3\u675f\u56de\u5408/);
    assert.match(executor?.config.systemPrompt ?? "", /verification/);
    assert.match(executor?.config.systemPrompt ?? "", /CI.*handoff\.waitingOn/);
    assert.doesNotMatch(executor?.config.systemPrompt ?? "", /GitHub Actions/);
    assert.match(executor?.config.systemPrompt ?? "", /\u786e\u5b9e\u8981\u7b49\u8d85\u8fc7 30 \u5206\u949f\uff0c\u5c31\u4ea4\u6d3b\u5e76\u5199 handoff\.waitingOn/);
    assert.doesNotMatch(executor?.config.systemPrompt ?? "", /\u518d\u7ed3\u675f\u8fd9\u4e00\u8f6e/);
    assert.match(executor?.config.systemPrompt ?? "", /\u5de5\u5177\u652f\u6301\u65f6\uff0c\u80fd\u62c6\u5f00\u7684\u67e5\u627e、\u9605\u8bfb、\u6d4b\u8bd5、\u6838\u5bf9\u5148\u6d3e sub-agent \u540c\u65f6\u505a\uff0c\u518d\u6c47\u603b/);
    assert.match(executor?.config.systemPrompt ?? "", /\u6539\u4ee3\u7801\u4ecd\u7531\u4f60\u81ea\u5df1\u505a\uff0c\u4ee5\u514d\u4e92\u76f8\u8986\u76d6/);
    assert.match(executor?.config.systemPrompt ?? "", /\u7b49 sub-agent \u65f6\u7559\u5728\u672c\u56de\u5408\u91cc\u7b49\u5b83\u4eec\u8fd4\u56de/);
    assert.match(executor?.config.systemPrompt ?? "", /\u9700\u8981\u5f00 PR \u65f6\u53ef\u4ee5\u5728\u672c\u5361\u76ee\u5f55\u91cc\u65b0\u5efa\u5206\u652f\uff0c\u4f46\u4e0d\u8981\u53e6\u5f00 worktree/);
    assert.doesNotMatch(executor?.config.systemPrompt ?? "", /\u53ea\u8bfb/);
    assert.doesNotMatch(executor?.config.systemPrompt ?? "", /\u7a7a\u63d0\u4ea4/);
    const batch = guardCreateHook(req({ env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "batch" } }), "http://127.0.0.1:9");
    assert.match(batch?.config.systemPrompt ?? "", /\u770b\u677f\u5de5\u4f5c\u5b88\u5219\uff08\u6267\u884c\uff09/);
    assert.match(batch?.config.systemPrompt ?? "", /\u6d3b\u4e0d\u5728\u672c\u4ed3\u5e93\u65f6\uff0c\u4e0d\u8981\u5728\u81ea\u5df1\u7684\u5361\u7247\u5206\u652f\u4e0a\u505a\u7a7a\u63d0\u4ea4\u8bb0\u5f55\u7ed3\u679c\uff0c\u7ed3\u679c\u5199\u8fdb\u4ea4\u63a5/);
    const worktree = guardCreateHook(req({ env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "executor", KANBAN_WORKTREE: "1" } }), "http://127.0.0.1:9");
    assert.match(worktree?.config.systemPrompt ?? "", /\u5148\u6309\u4ed3\u5e93\u8bf4\u660e\u88c5\u4f9d\u8d56/);
    assert.match(worktree?.config.systemPrompt ?? "", /\u7981\u63a8 main、pre、preview/);
    assert.match(worktree?.config.systemPrompt ?? "", /\u94fe\u63a5\u5199\u5165 handoff/);
    assert.match(worktree?.config.systemPrompt ?? "", /\u9700\u8981\u5f00 PR \u65f6\u53ef\u4ee5\u5728\u672c\u5361\u76ee\u5f55\u91cc\u65b0\u5efa\u5206\u652f\uff0c\u4f46\u4e0d\u8981\u53e6\u5f00 worktree/);
    assert.match(worktree?.config.systemPrompt ?? "", /\u53ea\u63a8\u5f53\u524d\u5206\u652f/);
    assert.match(worktree?.config.systemPrompt ?? "", /\u6539\u4ee3\u7801\u4ecd\u7531\u4f60\u81ea\u5df1\u505a\uff0c\u4ee5\u514d\u4e92\u76f8\u8986\u76d6/);
    // TEST_0070 adds the new-branch sentence to the executor rules (39).
    // TEST_0085 adds the temporary-file and clean-checkout rule (110-character budget).
    // TEST_0107 adds external-wait handoff and dependency-block guidance (180-character budget).
    assert.match(worktree?.config.systemPrompt ?? "", /handoff.waitingOn/);
    assert.match(worktree?.config.systemPrompt ?? "", /\u8fd9\u4e0d\u7b97\u5361\u4f4f\uff0c\u8bf7\u4ea4\u6d3b\u5e76\u5728\u4ea4\u63a5\u5199\u660e\u7b49\u4ec0\u4e48/);
    // TEST_0121 adds merge-card dependency guidance (100-character budget).
    assert.match(worktree?.config.systemPrompt ?? "", /\u5408\u5e76\u5361\u53ef\u4ee5\u6302\u5728 PR \u5361\u540e\u9762/);
    // TEST_0299: leave the PR branch before merging, or Paseo's merge auto-archive takes the directory (fits the budget).
    assert.match(worktree?.config.systemPrompt ?? "", /\u5148\u5207\u56de\u672c\u5361\u5206\u652f\u518d gh pr merge/);
    // No-CI wording: local tests and build go in verification.
    assert.match(worktree?.config.systemPrompt ?? "", /\u6ca1\u6709 CI \u7684\u4ed3\u5e93\uff0c\u4ea4\u6d3b\u524d\u5728\u672c\u673a\u8dd1\u5b8c\u6d4b\u8bd5\u548c\u6784\u5efa\u5e76\u628a\u547d\u4ee4\u548c\u7ed3\u679c\u5199\u8fdb verification/);
    // TEST_0211 adds the per-card TMPDIR and production-database rules (260-character budget).
    // Executor rules grew by 167 and the no-wait rule shrank by 3 (CI dropped from the poll list).
    // Keep the original budget for the rules; a card checkout's CLI path may be longer than the installation's.
    const budgetedPrompt = (worktree?.config.systemPrompt ?? "").replace(displayCliPath(), "$PLUGIN_ROOT/bin/paseo-kanban.mjs");
    assert.ok(budgetedPrompt.length <= 226 * 2 + 49 + 107 + 39 + 110 + 220 + 100 + 260 + 260 + 164);
    // TEST_0256 adds the no-wait rule and the sub-agent wait sentence (260-character budget).
    const reader = guardCreateHook(req({ env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "reader" } }), "http://127.0.0.1:9");
    assert.match(reader?.config.systemPrompt ?? "", /\u4e0d\u6539\u6587\u4ef6\uff0c\u4e0d commit/);
    assert.match(reader?.config.systemPrompt ?? "", /\u53ea\u8bfb\u526f\u672c\u91cc\u4e0d\u8981\u63d0\u4ea4\u6216\u6539\u6587\u4ef6\uff1b\u8981\u7559\u7ed3\u8bba\u5199\u8fdb\u4ea4\u63a5\u6216\u5361\u7247\u8bc4\u8bba/);
    assert.match(reader?.config.systemPrompt ?? "", /\u7ed3\u8bba\u5199\u8fdb kanban_complete \u7684 handoff/);
    assert.match(reader?.config.systemPrompt ?? "", /\u5de5\u5177\u652f\u6301\u65f6\uff0c\u80fd\u62c6\u5f00\u7684\u67e5\u627e、\u9605\u8bfb、\u6d4b\u8bd5、\u6838\u5bf9\u5148\u6d3e sub-agent \u540c\u65f6\u505a\uff0c\u518d\u6c47\u603b/);
    assert.match(reader?.config.systemPrompt ?? "", /sub-agent \u540c\u6837\u4e0d\u6539\u6587\u4ef6/);
    assert.doesNotMatch(reader?.config.systemPrompt ?? "", /\u6539\u4ee3\u7801\u4ecd\u7531\u4f60\u81ea\u5df1\u505a/);
    assert.doesNotMatch(reader?.config.systemPrompt ?? "", /\u6bcf\u5b8c\u6210\u4e00\u6b65\u5c31 commit/);
    const decision = guardCreateHook(req({ env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "decision" } }), "http://127.0.0.1:9");
    assert.match(decision?.config.systemPrompt ?? "", /\u4e0d\u6539\u6587\u4ef6\uff0c\u4e0d commit/);
    assert.match(decision?.config.systemPrompt ?? "", /\u53ea\u8bfb\u526f\u672c\u91cc\u4e0d\u8981\u63d0\u4ea4\u6216\u6539\u6587\u4ef6\uff1b\u8981\u7559\u7ed3\u8bba\u5199\u8fdb\u4ea4\u63a5\u6216\u5361\u7247\u8bc4\u8bba/);
    assert.match(decision?.config.systemPrompt ?? "", /sub-agent \u540c\u6837\u4e0d\u6539\u6587\u4ef6/);
    assert.doesNotMatch(decision?.config.systemPrompt ?? "", /\u6bcf\u5b8c\u6210\u4e00\u6b65\u5c31 commit/);
    const reviewer = guardCreateHook(req({ env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "reviewer" } }), "http://127.0.0.1:9");
    assert.match(reviewer?.config.systemPrompt ?? "", /\u53ea\u8bfb/);
    assert.match(reviewer?.config.systemPrompt ?? "", /\u4e0d\u8981\u6539\u6587\u4ef6/);
    assert.match(reviewer?.config.systemPrompt ?? "", /\u53ea\u8bfb\u526f\u672c\u91cc\u4e0d\u8981\u63d0\u4ea4\u6216\u6539\u6587\u4ef6\uff1b\u8981\u7559\u7ed3\u8bba\u5199\u8fdb\u4ea4\u63a5\u6216\u5361\u7247\u8bc4\u8bba/);
    assert.match(reviewer?.config.systemPrompt ?? "", /\u6309\u672c\u5361\u7684\u63d0\u4ea4\u5ba1/);
    assert.match(reviewer?.config.systemPrompt ?? "", /\u672a\u63d0\u4ea4\u7684\u6539\u52a8\u53ef\u80fd\u662f\u522b\u4eba\u7684/);
    assert.match(reviewer?.config.systemPrompt ?? "", /\u5de5\u5177\u652f\u6301\u65f6\uff0c\u80fd\u62c6\u5f00\u7684\u67e5\u627e、\u9605\u8bfb、\u6d4b\u8bd5、\u6838\u5bf9\u5148\u6d3e sub-agent \u540c\u65f6\u505a\uff0c\u518d\u6c47\u603b/);
    assert.match(reviewer?.config.systemPrompt ?? "", /sub-agent \u540c\u6837\u53ea\u8bfb\uff0c\u4e0d\u6539\u6587\u4ef6/);
    assert.doesNotMatch(reviewer?.config.systemPrompt ?? "", /\u6539\u4ee3\u7801\u4ecd\u7531\u4f60\u81ea\u5df1\u505a/);
    const reviewerRules = (reviewer?.config.systemPrompt ?? "").split("\n");
    const reviewerRule2 = reviewerRules.find((line) => line.startsWith("2. "));
    const reviewerRule6 = reviewerRules.find((line) => line.startsWith("6. "));
    assert.ok(reviewerRule2 && reviewerRule6);
    assert.match(reviewerRule2, /\u4e0d\u8981\u6539\u6587\u4ef6/);
    assert.match(reviewerRule2, /commit/);
    assert.match(reviewerRule2, /\u4e0d\u8981\u65b0\u5f00\u72ec\u7acb Paseo agent/);
    assert.match(reviewerRule2, /\u5de5\u5177\u539f\u751f\u7684\u53ea\u8bfb sub-agent \u9664\u5916/);
    assert.match(reviewerRule6, /\u5148\u6d3e sub-agent \u540c\u65f6\u505a/);
    assert.match(reviewerRule6, /\u4e0d\u6539\u6587\u4ef6/);
    const reviewerRule7 = reviewerRules.find((line) => line.startsWith("7. "));
    const reviewerRule8 = reviewerRules.find((line) => line.startsWith("8. "));
    const reviewerRule9 = reviewerRules.find((line) => line.startsWith("9. "));
    const reviewerRule10 = reviewerRules.find((line) => line.startsWith("10. "));
    assert.ok(reviewerRule7 && reviewerRule8 && reviewerRule9 && reviewerRule10);
    assert.match(reviewerRule7, /kanban_request_changes/);
    assert.match(reviewerRule7, /\u4e0d\u6ee1\u8db3\u7b80\u62a5\u7684\u76ee\u6807\u6216\u9a8c\u6536\u6807\u51c6/);
    assert.match(reviewerRule7, /P0\uff0fP1/);
    assert.match(reviewerRule7, /\u6d4b\u8bd5\u6216\u9a8c\u6536\u547d\u4ee4\u6ca1\u8fc7/);
    assert.match(reviewerRule8, /P2 \u53ca\u4ee5\u4e0b/);
    assert.match(reviewerRule8, /\u975e\u963b\u585e/);
    assert.match(reviewerRule8, /\u4e0d\u8981\u56e0\u6b64\u6253\u56de/);
    assert.match(reviewerRule9, /\u53ea\u6838\u5bf9\u4e0a\u4e00\u8f6e\u6253\u56de\u7684\u95ee\u9898/);
    assert.match(reviewerRule9, /\u4e0d\u6269\u5927\u8303\u56f4/);
    assert.match(reviewerRule9, /P0\uff0fP1 \u9664\u5916/);
    assert.match(reviewerRule10, /\u4e25\u91cd\u5ea6\uff08P0\uff0fP1\uff0fP2\uff09/);
    assert.match(reviewerRule10, /\u662f\u5426\u963b\u585e/);
    const allowsToolSubagent = /\u5de5\u5177\u539f\u751f\u7684\u53ea\u8bfb sub-agent \u9664\u5916/.test(reviewerRule2);
    const bansAnyAgent = /\u521b\u5efa agent/.test(reviewerRule2) && !allowsToolSubagent;
    assert.equal(allowsToolSubagent, true);
    assert.equal(bansAnyAgent, false);
    const supervisor = guardCreateHook(req({ env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "supervisor" } }), "http://127.0.0.1:9");
    assert.match(supervisor?.config.systemPrompt ?? "", /\u4e0d\u8981\u81ea\u5df1\u5b9e\u73b0/);
    assert.match(supervisor?.config.systemPrompt ?? "", /\u5168\u90e8\u4f9d\u8d56/);
    assert.match(supervisor?.config.systemPrompt ?? "", /\u5148\u5b9a\u5171\u7528\u7684\u7ea6\u5b9a/);
    for (const policy of [/\u5148\u6e05\u5b8c\u8fd9\u4e00\u6279\u5f85\u9a8c\u6536/, /\u5df2\u66ff\u4f60\u51b3\u5b9a\uff08\u53ef\u63a8\u7ffb\uff09/, /roles decide add/, /roles decide done/, /\u53ef\u4ee5\u5408/, /--role batch/, /\u53ea\u5269 P2.*\u53e6\u5f00\u5361\u8bb0\u9057\u7559/, /\u672c\u673a\u6d4b\u8bd5\u548c\u6784\u5efa\u901a\u8fc7\u7684 PR/, /\u8dd1\u5408\u5e76\u524d\u68c0\u67e5\u6216 gh pr merge/]) {
      assert.match(supervisor?.config.systemPrompt ?? "", policy);
    }
    assert.doesNotMatch(supervisor?.config.systemPrompt ?? "", /\u7b49 CI|CI \u7eff/);
    assert.match(reviewer?.config.systemPrompt ?? "", /\u7b2c 2 \u8f6e\u4ecd\u6253\u56de\uff0c\u7531 <leader> \u88c1\u5b9a/);
    assert.doesNotMatch(supervisor?.config.systemPrompt ?? "", /\u5148\u6d3e sub-agent/);
    // Reviewer grew by one line in M3.6. M3.24 adds one progress-comment sentence (49) to every role.
    // TEST_0057 adds a sub-agent paragraph: executor 107, reviewer 110, reader/decision 107.
    // Review round 1 replaces the blanket "create agent" ban with a Paseo-agent ban plus a read-only sub-agent exception (32).
    // TEST_0072 adds request-changes severity rules (7–10), 468 characters.
    // TEST_0110 shares the full leader policy with wakes; allow 650 characters for that policy,
    // 100 for reviewer round-2 guidance, and 40 more for explicit CI handoff wording.
    // TEST_0256 replaces the 49-character progress sentence with a ~190-character no-wait rule (F2).
    const previous = { executor: 226 + 49 + 107, reviewer: 161 + 30 + 49 + 110 + 32 + 468, supervisor: 181 + 49, reader: 200 + 49 + 107, decision: 200 + 49 + 107 };
    for (const role of ["executor", "reviewer", "supervisor", "reader", "decision"] as const) {
      const text = protocolFor(role);
      const policyBudget = role === "supervisor" ? 650 : role === "reviewer" ? 100 : role === "executor" ? 220 : 0;
      const mergeCardBudget = role === "executor" || role === "supervisor" ? 100 : 0;
      // TEST_0211 adds the per-card TMPDIR and production-database rules to every role but the leader.
      const tmpRuleBudget = role === "supervisor" ? 0 : 300;
      // TEST_0256 adds the no-wait rule (F2) to every worker role.
      const noWaitBudget = role === "supervisor" ? 0 : 260;
      // Executor rules +167 and no-wait -3; the leader note +6. Other worker roles only lost "CI、".
      const noCiBudget = role === "executor" ? 164 : role === "supervisor" ? 6 : 0;
      assert.ok(text.length <= previous[role] * 2 + policyBudget + mergeCardBudget + tmpRuleBudget + noWaitBudget + noCiBudget, `${role} \u5de5\u4f5c\u5b88\u5219\u8d85\u8fc7\u6587\u6848\u9884\u7b97`);
      if (role === "supervisor") assert.match(text, /\u5148\u7528 kanban_comment \u5199\u4e00\u53e5\u8fdb\u5ea6\uff0c\u518d\u7ed3\u675f\u8fd9\u4e00\u8f6e/);
      else {
        assert.match(text, /\u56de\u5408\u7ed3\u675f = \u4f60\u505c\u4e0b\u6765\u4e86\uff0c\u4e0d\u4f1a\u6709\u4eba\u518d\u53eb\u4f60/);
        assert.match(text, /\u524d\u53f0\u8f6e\u8be2/);
        assert.match(text, /Codex \u7684\u540e\u53f0\u4f1a\u8bdd\u548c Claude \u7684 ScheduleWakeup \u5728\u8fd9\u91cc\u90fd\u4e0d\u4f1a\u5524\u9192\u4f60/);
        assert.doesNotMatch(text, /\u518d\u7ed3\u675f\u8fd9\u4e00\u8f6e/);
      }
      assert.doesNotMatch(text, /Paseo \u5b98\u65b9|\u56de A \u6211\u5c31\u5f00\u59cb/);
      assert.match(text, /bin\/paseo-kanban\.mjs complete/);
      assert.match(text, /PASEO_AGENT_ID/);
      assert.doesNotMatch(text, /\u7528\u4f60\u73af\u5883\u91cc\u7684 KANBAN_TOKEN/);
      assert.equal(text.includes(cliFallback()), true);
    }
  });

  it("strips the supervisor token from env and mcp config", () => {
    const tmp = tmpdir();
    mkdirSync(tmp, { recursive: true });
    const dir = mkdtempSync(join(tmp, "inject-token-"));
    process.env.KANBAN_DATA_DIR = dir;
    const secret = ensureSupervisorToken();
    const next = injectMcp(
      req({
        env: { [BOARD_AGENT_ENV]: "1", KANBAN_TOKEN: secret, OTHER: secret },
        config: {
          provider: "claude",
          cwd: "/tmp/sandbox",
          mcpServers: {
            other: { type: "http", url: `http://127.0.0.1:1/mcp?${"token"}=${secret}`, headers: { Authorization: `Bearer ${secret}` } },
          },
        },
      }),
      "http://127.0.0.1:9",
    );
    const packed = JSON.stringify(next);
    assert.equal(packed.includes(secret), false);
    assert.equal(next?.env?.KANBAN_TOKEN, undefined);
    const kanban = next?.config.mcpServers?.kanban;
    assert.ok(kanban && kanban.type === "http");
    assert.equal(kanban.url.includes("token="), false);
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("swallows an inject failure and lets the original create through", () => {
    const request = req({ env: { [BOARD_AGENT_ENV]: "1" } });
    const broken = new Proxy(request, {
      get(target, prop, receiver) {
        if (prop === "config") throw new Error("config blew up");
        return Reflect.get(target, prop, receiver);
      },
    });
    assert.equal(guardCreateHook(broken, "http://127.0.0.1:9"), undefined);
    assert.equal(guardCreateHook(req(), "http://127.0.0.1:9"), undefined);
  });
});
