import assert from "node:assert/strict";
import { it } from "node:test";
import { BOARD_AGENT_ENV } from "../server/agent-env";
import { boundedCreateHook } from "../server/inject";
import { protocolFor } from "../server/protocol";

it("environment markers select the protocol, and both languages name kanban_supervise", async () => {
  assert.match(protocolFor("supervisor", { language: "en" }), /kanban_supervise/);
  assert.match(protocolFor("supervisor", { language: "zh-CN" }), /kanban_supervise/);
  assert.doesNotMatch(protocolFor("executor", { language: "en" }), /kanban_supervise/);
  const options = { baseUrl: "http://127.0.0.1:9", supervisorToken: null };
  for (const provider of ["claude", "codex", "grok"]) {
    const config = { provider, cwd: "/tmp/demo", systemPrompt: "Original policy" };
    assert.equal(await boundedCreateHook({ config, labels: { kanban: "1", role: "supervisor" } }, options), undefined);
    const worker = await boundedCreateHook({ config, env: { [BOARD_AGENT_ENV]: "1", KANBAN_LANGUAGE: "en" } }, options);
    assert.match(worker?.config.systemPrompt ?? "", /Board work rules \(executor\)/);
    assert.doesNotMatch(worker?.config.systemPrompt ?? "", /kanban_supervise/);
    assert.equal(worker?.env?.KANBAN_PROTOCOL_VERSION, "kanban/v1");
    const leader = await boundedCreateHook({
      config,
      env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "supervisor", KANBAN_LANGUAGE: "en", KANBAN_LEADER_START: `req-${provider}` },
    }, options);
    assert.match(leader?.config.systemPrompt ?? "", /^Original policy/);
    assert.match(leader?.config.systemPrompt ?? "", /Board work rules \(<leader>\)/);
    assert.match(leader?.config.systemPrompt ?? "", /kanban_supervise/);
    assert.match(leader?.config.systemPrompt ?? "", /Protocol kanban\/v1/);
    assert.equal(leader?.env?.KANBAN_ROLE, "supervisor");
    assert.equal(leader?.config.mcpServers?.kanban?.type, "http");
  }
});
