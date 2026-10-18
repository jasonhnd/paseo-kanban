import assert from "node:assert/strict";
import { test } from "node:test";
import { openAgentInHost } from "../client/agent-navigation";

test("navigation stays on the owning host after workspace validation", async () => {
  const events: unknown[] = [];
  await openAgentInHost("new-leader", "test-host", {
    openAgent: (input) => { events.push(input); }, openWorkspace() {},
  }, async (input) => { events.push(["validate", input]); return { url: "paseo://h/test-host/workspace/demo", message: "" }; });
  assert.deepEqual(events, [["validate", { agentId: "new-leader" }], { agentId: "new-leader", serverId: "test-host" }]);
});

test("missing client navigation or host fails before any RPC", async () => {
  let calls = 0;
  const validate = async () => { calls++; return { url: "paseo://h/demo", message: "" }; };
  await assert.rejects(openAgentInHost("leader", "test-host", undefined, validate));
  await assert.rejects(openAgentInHost("leader", "", { openAgent() {}, openWorkspace() {} }, validate));
  assert.equal(calls, 0);
});

test("missing cwd, unreadable workspace and RPC errors never navigate", async () => {
  let calls = 0;
  const navigation = { openAgent() { calls++; }, openWorkspace() {} };
  for (const message of ["cwd missing", "workspace missing"]) {
    await assert.rejects(openAgentInHost("leader", "test-host", navigation, async () => ({ url: null, message })), { message });
  }
  await assert.rejects(openAgentInHost("leader", "test-host", navigation, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(calls, 0);
});

test("a failed client navigation is reported without trying another destination", async () => {
  let attempts = 0;
  await assert.rejects(openAgentInHost("leader", "test-host", {
    openAgent() { attempts++; throw new Error("client offline"); }, openWorkspace() {},
  }, async () => ({ url: "paseo://h/test-host/workspace/demo", message: "" })), /client offline/);
  assert.equal(attempts, 1);
});
