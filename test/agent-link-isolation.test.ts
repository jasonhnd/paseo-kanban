import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("agent lookup and link validation both use the selected isolated home", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-link-isolation-"));
  const savedHome = process.env.PASEO_HOME;
  const savedAgents = process.env.KANBAN_AGENTS_DIR;
  try {
    process.env.PASEO_HOME = root;
    delete process.env.KANBAN_AGENTS_DIR;
    const bucket = join(root, "agents", "demo");
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(root, "server-id"), "demo-isolated-host");
    writeFileSync(join(bucket, "demo-agent.json"), JSON.stringify({ id: "demo-agent", cwd: root, workspaceId: "demo-workspace" }));
    const { agentsDir, agentLink, openAgent } = await import("../server/open");
    assert.equal(agentsDir(), join(root, "agents"));
    assert.deepEqual(agentLink("demo-agent"), { url: "paseo://h/demo-isolated-host/workspace/demo-workspace?open=agent%3Ademo-agent", message: "" });
    rmSync(join(root, "server-id"));
    assert.equal(agentLink("demo-agent").url, null, "missing isolated identity must never fall back to the personal home");
    const legacy = await openAgent("demo-agent");
    assert.equal(legacy.ok, false, "cached clients cannot launch a separate desktop app");
    assert.ok(legacy.message);
  } finally {
    if (savedHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = savedHome;
    if (savedAgents === undefined) delete process.env.KANBAN_AGENTS_DIR; else process.env.KANBAN_AGENTS_DIR = savedAgents;
    rmSync(root, { recursive: true, force: true });
  }
});
