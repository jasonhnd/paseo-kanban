import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "leader-supervise-"));
process.env.KANBAN_DATA_DIR = join(dir, "data");
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(join(dir, "agents", "bucket"), { recursive: true });

const { setProjectCode, setProjectSupervisor } = await import("../server/config");
const { runKanban } = await import("../server/cli");
const { getDb, closeDb } = await import("../server/db");
const { handleTool, toolDefs } = await import("../server/tools");
const { issueToken } = await import("../server/tokens");
const { resolveCliIdentity } = await import("../server/identity");
const { startMcpServer } = await import("../server/mcp");
const { createTask } = await import("../server/store");
const { decidePermission } = await import("../server/permissions");

setProjectCode("demo", "DEMO");
setProjectCode("other", "EX");
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

it("leaves supervisor permission approval with the host", () => {
  assert.deepEqual(
    decidePermission({ kanban: true, autoAccept: true, role: "supervisor", request: { actions: [] } as never }),
    { action: "ignore" },
  );
});

it("a session token is read-only before self-registration, then gains only its registered project", async () => {
  const token = issueToken("guest", null, "demo-leader");
  const mcp = await startMcpServer(toolDefs(), async (name, args, value) => {
    try { return { text: JSON.stringify(await handleTool(name, args, value)) }; }
    catch (error) { return { text: String(error), isError: true }; }
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${mcp.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await response.json() as { result: { isError?: boolean } }).result;
  };
  try {
    assert.equal((await call("kanban_create", { project: "demo", title: "Hello", role: "executor" })).isError, true);
    assert.equal((await call("kanban_doctor", { last: true })).isError, true);
    assert.equal((await call("kanban_supervise", { project: "demo", agent: "someone-else" })).isError, true);
    assert.equal((await call("kanban_supervise", { project: "missing" })).isError, true);
    assert.notEqual((await call("kanban_supervise", { project: "DEMO" })).isError, true);
    assert.notEqual((await call("kanban_supervise", { project: "demo" })).isError, true);
    assert.notEqual((await call("kanban_create", { project: "demo", title: "Hello", role: "executor" })).isError, true);
    assert.equal((await call("kanban_create", { project: "other", title: "Wrong project", role: "executor" })).isError, true);
    assert.equal(resolveCliIdentity({ KANBAN_TOKEN: token, PASEO_AGENT_ID: "demo-leader" }).role, "supervisor");
  } finally {
    await mcp.close();
  }
});

it("workers, schedules, unbound tokens and a live prior leader cannot use self-registration to take over", async () => {
  const card = createTask({ project: "demo", title: "Worker", role: "executor" });
  getDb().prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run("demo-worker", card.id);
  const worker = issueToken("guest", null, "demo-worker");
  await assert.rejects(handleTool("kanban_supervise", { project: "other" }, worker), { code: "forbidden" });
  await assert.rejects(handleTool("kanban_supervise", { project: "other" }, issueToken("guest", null, null)), { code: "forbidden" });
  await assert.rejects(handleTool("kanban_supervise", { project: "other" }, null, { role: "schedule", taskId: null, agentId: "demo-schedule" }), { code: "forbidden" });
  writeFileSync(join(dir, "agents", "bucket", "old-leader.json"), JSON.stringify({ id: "old-leader", cwd: dir, labels: {}, lastStatus: "idle" }));
  setProjectSupervisor("other", "old-leader");
  await assert.rejects(handleTool("kanban_supervise", { project: "other" }, issueToken("guest", null, "new-leader")), { code: "forbidden" });
});

it("the command line can register the same restricted token without borrowing another token", async () => {
  setProjectCode("cli-demo", "ABC");
  const token = issueToken("guest", null, "cli-leader");
  const env = { ...process.env, PASEO_AGENT_ID: "cli-leader", KANBAN_TOKEN: token };
  await assert.rejects(runKanban(["create", "--project", "cli-demo", "--title", "Before", "--role", "executor"], env), { code: "forbidden" });
  await runKanban(["supervise", "--project", "cli-demo"], env);
  const created = await runKanban(["create", "--project", "cli-demo", "--title", "After", "--role", "executor"], env) as { created_by_agent: string };
  assert.equal(created.created_by_agent, "cli-leader");
});
