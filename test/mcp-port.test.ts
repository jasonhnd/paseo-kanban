/// <reference types="node" />
import { zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { markRunningMcpStale, readSavedMcpPort, writeSavedMcpPort } from "../server/mcp-port";
import { startMcpServer } from "../server/mcp";
import { createTask, listBoard } from "../server/store";

const tmp = tmpdir();
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(join(tmp, "mcp-port-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("stable mcp port", () => {
  it("binds the same port after a restart and switches when that port is taken", async () => {
    const first = await startMcpServer([], async () => ({ text: "ok" }));
    try {
    writeSavedMcpPort(first.port);
    assert.equal(readSavedMcpPort(), first.port);
    } finally { await first.close(); }

    const second = await startMcpServer([], async () => ({ text: "ok" }), { preferredPort: readSavedMcpPort() });
    try {
    assert.equal(second.port, first.port);
    assert.equal(second.replaced, false);
    } finally { await second.close(); }

    const hold = createServer();
    await new Promise<void>((resolve) => hold.listen(first.port, "127.0.0.1", () => resolve()));
    try {
    const moved = await startMcpServer([], async () => ({ text: "ok" }), { preferredPort: first.port });
    try {
    assert.notEqual(moved.port, first.port);
    assert.equal(moved.replaced, true);
    } finally { await moved.close(); }
    } finally { await new Promise<void>((resolve, reject) => hold.close((err) => (err ? reject(err) : resolve()))); }
  });

  it("marks running agents when the port had to change", () => {
    const task = createTask({ project: "mcp", title: "still running", role: "executor", workspacePath: dir });
    getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run("agent-live", task.id);
    assert.equal(markRunningMcpStale(), 1);
    assert.equal(markRunningMcpStale(), 0);
    const card = listBoard("mcp").tasks.find((item) => item.id === task.id);
    assert.match(card?.mcpNote ?? "", new RegExp("MCP " + localePattern(zhCNPart("reclaimActions.tool.http", 14, 16)) + localePattern(zhCNPart("cleanup.wake.stepStopped", 14, 16)) + localePattern(zhCNPart("identity.tokenInvalid", 10, 11))));
    assert.match(card?.mcpNote ?? "", /bin\/paseo-kanban complete/);
    assert.doesNotMatch(card?.mcpNote ?? "", /paseo-kanban\.mjs/);
    assert.match(card?.mcpNote ?? "", /PASEO_AGENT_ID/);
    assert.doesNotMatch(card?.mcpNote ?? "", new RegExp(localePattern(zhCNPart("stall.nudge.quiet", 44, 46)) + localePattern(zhCNPart("compat.skip.kanbanEnv", 14, 16)) + localePattern(zhCNPart("tempWorkspace.drop.placeholderAgentsDeleted", 2, 5)) + "KANBAN_TOKEN"));
  });
});
